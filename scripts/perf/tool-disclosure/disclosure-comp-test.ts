// Comprehensive disclosure test (logic/policy/concurrency/demotion/return-shape/no-op).
// Run: bun run disclosure-comp-test.ts   (from packages/opencode)
process.env["ULTRAWORK_TOOL_DISCLOSURE"] = "1"
process.env["ULTRAWORK_DISCLOSE_GRACE"] = "3"
delete process.env["ULTRAWORK_DISCLOSE_PREFIX"]
import { ToolDisclosurePlugin } from "../../../vendor/opencode/packages/opencode/src/plugin/tool-disclosure"

let pass = 0, fail = 0
const ok = (n: string, c: boolean) => (console.log(`  [${c ? "PASS" : "FAIL"}] ${n}`), c ? pass++ : fail++)
const d = (s: string) => ({ description: s })
const fresh = (): Record<string, any> => ({
  read: d("read"), write: d("write"), edit: d("edit"), bash: d("bash"), grep: d("grep"), glob: d("glob"),
  task: d("delegate"), invalid: d("internal"), todowrite: d("todos"), skill: d("skill"), question: d("ask"),
  webfetch: d("fetch url"), browser_navigate_page: d("navigate"), browser_click: d("click"),
  "knowledge-base_search": d("search notes"), orchestrator_delegate: d("delegate agent"),
})
const ctx = (sessionID: string, step: number, used: string[] = []) =>
  ({ sessionID, step, usedToolIds: used, agent: "build", model: {} as any })
const catText = (sys: string[]) => sys.find((s) => s.includes("<discoverable_tools>")) || ""

const h = await ToolDisclosurePlugin({} as any)
const T = h["experimental.chat.tools.transform"]!
const S = h["experimental.chat.system.transform"]!
const E = (h as any)["event"] as (i: { event: any }) => Promise<void>

async function main() {
  // 1. collapse + eager + tool_search + catalog (full policy)
  let t = fresh(); await T(ctx("a", 1), { tools: t })
  ok("eager core kept", ["read","write","edit","bash","grep","glob","task","invalid"].every((k) => k in t))
  ok("orchestrator delegation kept", "orchestrator_delegate" in t)
  ok("todowrite kept eager (planning tool, 2026-06-26 decision)", "todowrite" in t)
  ok("situational builtins collapsed", !["skill","question","webfetch"].some((k) => k in t))
  ok("all MCP collapsed", !["browser_navigate_page","browser_click","knowledge-base_search"].some((k) => k in t))
  ok("tool_search injected", "tool_search" in t)
  let sys: string[] = []; await S({ sessionID: "a", model: {} as any }, { system: sys })
  const cat1 = catText(sys)
  ok("catalog lists collapsed (mcp+builtin)", ["webfetch","browser_navigate_page","knowledge-base_search"].every((n) => cat1.includes(n)))
  ok("catalog excludes eager core", !cat1.includes("- bash:") && !cat1.includes("- read:"))

  // 2. fetch (select) → native next step; static catalog unchanged
  let t2 = fresh(); await T(ctx("a", 2), { tools: t2 })
  const r = await t2["tool_search"].execute({ query: "select:webfetch" })
  ok("tool_search returns {output,title,metadata}", !!r && typeof r.output === "string" && r.title === "tool_search" && typeof r.metadata === "object")
  let t3 = fresh(); await T(ctx("a", 3), { tools: t3 })
  ok("fetched tool native again", "webfetch" in t3)
  ok("non-fetched still collapsed", !("browser_click" in t3))
  let sys3: string[] = []; await S({ sessionID: "a", model: {} as any }, { system: sys3 })
  ok("STATIC catalog identical after fetch", catText(sys3) === cat1)

  // 3. keyword search (not select)
  let tk = fresh(); await T(ctx("kw", 1), { tools: tk })
  await tk["tool_search"].execute({ query: "click browser" })
  let tk2 = fresh(); await T(ctx("kw", 2), { tools: tk2 })
  ok("keyword search loaded browser_click", "browser_click" in tk2)

  // 4. demotion after grace (GRACE=3); used-in-history kept
  let last: Record<string, any> = {}
  for (let s = 4; s <= 8; s++) { last = fresh(); await T(ctx("a", s), { tools: last }) } // webfetch unused → demote
  ok("unused fetched demoted after grace", !("webfetch" in last))
  let tu = fresh(); await T(ctx("u", 1), { tools: tu })
  await tu["tool_search"].execute({ query: "select:browser_click" })
  let keep: Record<string, any> = {}
  for (let s = 2; s <= 9; s++) { keep = fresh(); await T(ctx("u", s, ["browser_click"]), { tools: keep }) }
  ok("used-in-history kept native despite idle (dangling-safe)", "browser_click" in keep)

  // 5. CONCURRENCY: two sessions interleaved, isolated state + per-session catalog
  let x1 = fresh(); await T(ctx("X", 1), { tools: x1 })
  let y1 = fresh(); await T(ctx("Y", 1), { tools: y1 })
  await x1["tool_search"].execute({ query: "select:webfetch" })       // X fetches webfetch
  await y1["tool_search"].execute({ query: "select:browser_click" })  // Y fetches browser_click
  let x2 = fresh(); await T(ctx("X", 2), { tools: x2 })
  let y2 = fresh(); await T(ctx("Y", 2), { tools: y2 })
  ok("concurrency: X has webfetch not browser_click", "webfetch" in x2 && !("browser_click" in x2))
  ok("concurrency: Y has browser_click not webfetch", "browser_click" in y2 && !("webfetch" in y2))
  let sysX: string[] = [], sysY: string[] = []
  await S({ sessionID: "X", model: {} as any }, { system: sysX })
  await S({ sessionID: "Y", model: {} as any }, { system: sysY })
  ok("concurrency: per-session catalog (both static, equal universe)", catText(sysX) === catText(sysY) && catText(sysX).includes("browser_click"))

  // 6. session.deleted clears state
  await E({ event: { type: "session.deleted", properties: { sessionID: "X" } } })
  let xDel = fresh(); await T(ctx("X", 1), { tools: xDel })
  ok("session.deleted cleared fetched (webfetch re-collapsed)", !("webfetch" in xDel))

  // 7. uw_tool_search rename on collision
  let coll = fresh(); coll["tool_search"] = d("pre-existing search")
  await T(ctx("c", 1), { tools: coll })
  ok("collision → uw_tool_search used", "uw_tool_search" in coll && coll["tool_search"].description === "pre-existing search")

  // 8. empty/eager-only tools → no tool_search, no catalog (compaction-like tools:{})
  let empty: Record<string, any> = {}; await T(ctx("e", 1), { tools: empty })
  ok("empty tools → no tool_search injected", !("tool_search" in empty))
  let onlyCore: Record<string, any> = { read: d("r"), bash: d("b") }; await T(ctx("e2", 1), { tools: onlyCore })
  ok("eager-only tools → no tool_search", !("tool_search" in onlyCore) && "read" in onlyCore && "bash" in onlyCore)

  // 9. usedToolIds containing 'invalid' (repair fallout) doesn't crash & doesn't keep wrong tool
  let inv = fresh(); await T(ctx("i", 1, ["invalid", "nonexistent"]), { tools: inv })
  ok("usedToolIds with invalid/unknown handled gracefully", "tool_search" in inv && !("browser_click" in inv))

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  (${pass} pass, ${fail} fail)`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
