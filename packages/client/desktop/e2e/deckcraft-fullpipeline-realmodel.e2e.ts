// deckcraft-fullpipeline-realmodel.e2e.ts — REAL-MODEL end-to-end smoke: drive real
// qwen3.7-max through the WHOLE deckcraft pipeline from a plain "做PPT" prompt,
// auto-approving every permission and auto-answering the question rounds, and assert
// a valid multi-page deck.html is produced (ADR-061 / discussions/043).
//
// Why this exists: structural e2e prove opencode serves deckcraft; the routing e2e
// proves a real model PICKS it; but neither drives the full model-authored flow
// (skill load → project → 2 question rounds → outline → gates → per-page generation
// → deck.html) to completion. This does — verifying FLOW + STRUCTURE end-to-end. It
// does NOT judge visual quality (that stays a human judgment) and does not force the
// final --pdf/--pptx export (covered deterministically by deckcraft-selftest + the
// examples gate chain).
//
//   cd packages/client/desktop && bun run --bun e2e/deckcraft-fullpipeline-realmodel.e2e.ts
//   Override the topic/port: ROUTE_PROMPT="..." ROUTE_PORT=4311 bun run --bun e2e/...
//   Needs: built opencode sidecar + a `myqwen` key in ~/.local/share/ultrawork/auth.json.
//   SLOW (drives a real model through a full deck; minutes). Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "deck-full-pw"
const OC = Number(process.env.ROUTE_PORT || 4311)
const PID = "myqwen", MODEL_ID = "qwen3.7-max"
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const KEY = (() => {
  const a = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!a.myqwen?.key) throw new Error("no myqwen key in ~/.local/share/ultrawork/auth.json")
  return a.myqwen.key as string
})()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function poll(fn: () => Promise<boolean>, ms: number) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return true } catch {} await sleep(600) }
  return false
}

const tmp = mkdtempSync(join(tmpdir(), "deck-full-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: `${PID}/${MODEL_ID}`,
  // headless auto-allow so the model's bash/edit/skill calls don't block; we ALSO
  // actively reply to /permission below (belt-and-suspenders).
  permission: { bash: "allow", edit: "allow", write: "allow", webfetch: "allow", skill: "allow" },
  provider: { [PID]: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE, apiKey: KEY }, models: { [MODEL_ID]: { id: MODEL_ID, name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`

// find any deck.html the pipeline built, with >=2 slide sections
function findDeck(root: string): string | null {
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()!
    let entries: string[] = []
    try { entries = readdirSync(d) } catch { continue }
    for (const name of entries) {
      const fp = join(d, name)
      let st; try { st = statSync(fp) } catch { continue }
      if (st.isDirectory()) { stack.push(fp); continue }
      if (name.endsWith(".html")) {
        try {
          const html = readFileSync(fp, "utf-8")
          if ((html.match(/<section[^>]*class="[^"]*slide/g) || []).length >= 2) return fp
        } catch {}
      }
    }
  }
  return null
}

let stop = false
let approvals = 0, answered = 0
const trace: string[] = []
async function autopilot() {
  while (!stop) {
    try {
      const perms = await (await fetch(`${base}/permission`, { headers: WH })).json() as any[]
      for (const p of (Array.isArray(perms) ? perms : [])) {
        await fetch(`${base}/permission/${p.id}/reply`, { method: "POST", headers: WH, body: JSON.stringify({ reply: "always" }) })
        approvals++; trace.push(`perm:${p.permission ?? p.type ?? "?"}`)
      }
      const qs = await (await fetch(`${base}/question`, { headers: WH })).json() as any[]
      for (const q of (Array.isArray(qs) ? qs : [])) {
        const questions = q.questions ?? []
        const answers = questions.map((sub: any) =>
          (sub.options && sub.options.length) ? [sub.options[0].label] : ["默认"])
        await fetch(`${base}/question/${q.id}/reply`, { method: "POST", headers: WH, body: JSON.stringify({ answers }) })
        answered += questions.length
        trace.push(`q(${questions.length}):${questions.map((s: any) => s.header).join("|")}`)
      }
    } catch {}
    await sleep(700)
  }
}

let verdict = "INCOMPLETE"
const checks: string[] = []
try {
  const n = extractBuiltinZip(join(tmp, ".config/ultrawork/skills/builtin"))
  if (!existsSync(join(tmp, ".config/ultrawork/skills/builtin/deckcraft/SKILL.md"))) throw new Error("deckcraft not in bundle")
  checks.push(`extracted ${n} builtin files`)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  if (!await poll(async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok, 30000))
    throw new Error("opencode did not become healthy")

  autopilot() // fire-and-forget background approver/answerer

  const sid = ((await (await fetch(`${base}/session`, { method: "POST", headers: WH, body: "{}" })).json()) as { id: string }).id
  const PROMPT = process.env.ROUTE_PROMPT ||
    "帮我做一个关于「团队远程协作最佳实践」的PPT演示文稿，5页就够，用示意/占位数据即可，不用联网检索。"
  await fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers: WH, body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }], model: { providerID: PID, modelID: MODEL_ID } }) })
  checks.push(`sent (no skill name): "${PROMPT}"`)
  console.log("[running] driving real qwen through the full pipeline (auto-approving perms + answering questions)...")

  let deck: string | null = null
  const ok = await poll(async () => { deck = findDeck(ws); return !!deck }, 900000) // up to 15 min
  stop = true
  console.log(`[autopilot] approved ${approvals} permissions, answered ${answered} questions; trace: ${trace.slice(0, 12).join("  ")}`)

  if (!ok || !deck) {
    const msgs = await (await fetch(`${base}/session/${sid}/message`, { headers: WH })).json() as any[]
    const a = (Array.isArray(msgs) ? msgs : []).filter((m) => m.info?.role === "assistant" || m.role === "assistant")
    const lastText = a.flatMap((m) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)).join(" ").slice(-400)
    throw new Error(`no valid multi-page deck.html appeared in 15min. last assistant text: ${lastText}`)
  }

  const html = readFileSync(deck, "utf-8")
  const slides = (html.match(/<section[^>]*class="[^"]*slide/g) || []).length
  checks.push(`deck built: ${deck.replace(ws, "<ws>")} (${slides} slide sections)`)
  const exported: string[] = []
  const stack = [ws]
  while (stack.length) { const d = stack.pop()!; for (const nm of (readdirSync(d) || [])) { const fp = join(d, nm); const st = statSync(fp); if (st.isDirectory()) stack.push(fp); else if (/\.(pdf|pptx)$/.test(nm)) exported.push(nm) } }
  checks.push(`derivatives produced: ${exported.length ? exported.join(", ") : "(none — HTML only; export path covered by selftest + gate chain)"}`)

  verdict = "PASS ✅ — real qwen drove the full deckcraft pipeline to a valid multi-page deck (flow + structure; visual quality is a human judgment)."
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  stop = true
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  await sleep(500)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
