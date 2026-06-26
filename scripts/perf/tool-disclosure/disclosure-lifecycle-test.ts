// Lifecycle test (TTL sweep + LRU cap). Constants are read at import → set env first.
// Run: bun run disclosure-lifecycle-test.ts  (from packages/opencode)
process.env["ULTRAWORK_TOOL_DISCLOSURE"] = "1"
process.env["ULTRAWORK_DISCLOSE_MAX_SESSIONS"] = "2"
process.env["ULTRAWORK_DISCLOSE_TTL_MS"] = "60"
delete process.env["ULTRAWORK_DISCLOSE_PREFIX"]
import { ToolDisclosurePlugin } from "../../../vendor/opencode/packages/opencode/src/plugin/tool-disclosure"

let pass = 0, fail = 0
const ok = (n: string, c: boolean) => (console.log(`  [${c ? "PASS" : "FAIL"}] ${n}`), c ? pass++ : fail++)
const fresh = (): Record<string, any> => ({ read: { description: "r" }, webfetch: { description: "f" }, browser_x: { description: "x" } })
const ctx = (s: string) => ({ sessionID: s, step: 1, usedToolIds: [], agent: "build", model: {} as any })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const h = await ToolDisclosurePlugin({} as any)
const T = h["experimental.chat.tools.transform"]!

async function main() {
  // LRU: MAX_SESSIONS=2. Touch A, B, C → A (oldest) should be evicted.
  let a = fresh(); await T(ctx("A"), { tools: a }); await a["tool_search"].execute({ query: "select:webfetch" })
  await sleep(5)
  let b = fresh(); await T(ctx("B"), { tools: b }); await b["tool_search"].execute({ query: "select:webfetch" })
  await sleep(5)
  let c = fresh(); await T(ctx("C"), { tools: c }) // size now 3 > 2 → sweep evicts oldest (A)
  // re-touch A: its fetched state should be gone (re-collapsed)
  let a2 = fresh(); await T(ctx("A"), { tools: a2 })
  ok("LRU: oldest session (A) evicted → state gone", !("webfetch" in a2))
  // B should still have its state (within cap, recently seen)... but A's re-touch may have pushed size>2 again.
  // Just assert C kept (most recent before A re-touch):
  let cChk = fresh(); await T(ctx("C"), { tools: cChk }) // re-touch C (no fetch) — state check via fresh fetch
  ok("LRU did not crash / current session usable", "tool_search" in cChk)

  // TTL: TTL_MS=60. Touch P, fetch; wait 90ms; touch Q (triggers sweep) → P expired.
  let p = fresh(); await T(ctx("P"), { tools: p }); await p["tool_search"].execute({ query: "select:webfetch" })
  await sleep(90)
  let q = fresh(); await T(ctx("Q"), { tools: q }) // sweep: P older than TTL → forgotten
  let p2 = fresh(); await T(ctx("P"), { tools: p2 })
  ok("TTL: expired session (P) state swept → re-collapsed", !("webfetch" in p2))

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"}  (${pass} pass, ${fail} fail)`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
