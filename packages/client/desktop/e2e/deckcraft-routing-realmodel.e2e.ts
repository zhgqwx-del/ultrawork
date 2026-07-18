// deckcraft-routing-realmodel.e2e.ts — REAL-MODEL proof that a plain "做PPT"
// intent routes to the deckcraft skill after P3 (ADR-061 / discussions/043 §18.5),
// where deckcraft's description was widened to take over all "make a PPT" intents
// and the builtin ppt-master was removed. Pure HTTP against a real opencode + real
// qwen3.7-max (DashScope), no Chrome/Vite.
//
// Why this exists: the structural e2e (builtin-deckcraft*.e2e.ts) prove opencode
// SERVES deckcraft with the right description, but not that a real model, reading
// that description, actually PICKS deckcraft for a generic "做PPT" prompt. opencode
// exposes every skill through a single `skill` tool whose description lists all
// skills; the model loads one by calling skill({name}). That call IS the routing
// decision — this test asserts the model calls it with name="deckcraft".
//
// Flow:
//   1. extract the REAL bundled skills-builtin.zip → config builtin dir
//   2. poll GET /skill until the scan populates; assert deckcraft in, ppt-master out
//   3. send a plain "做PPT" prompt (NO skill name) to real qwen3.7-max
//   4. assert the model invokes skill({name:"deckcraft"}) — poll until the tool-call
//      args finish streaming (input.name populated), then stop (no need to run the
//      full deckcraft pipeline).
//
//   cd packages/client/desktop && bun run --bun e2e/deckcraft-routing-realmodel.e2e.ts
//   Override the prompt/port: ROUTE_PROMPT="..." ROUTE_PORT=4307 bun run --bun e2e/...
//   Needs: built opencode sidecar + a `myqwen` key in ~/.local/share/ultrawork/auth.json.
//   Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "deck-route-pw"
const OC = Number(process.env.ROUTE_PORT || 4306)
const PID = "myqwen"
const MODEL_ID = "qwen3.7-max"
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in ~/.local/share/ultrawork/auth.json")
  return auth.myqwen.key as string
})()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 120000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 500)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "deck-route-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: `${PID}/${MODEL_ID}`,
  provider: { [PID]: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE, apiKey: KEY }, models: { [MODEL_ID]: { id: MODEL_ID, name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`

let verdict = "INCOMPLETE"
const checks: string[] = []
try {
  const builtinDir = join(tmp, ".config/ultrawork/skills/builtin")
  const n = extractBuiltinZip(builtinDir)
  if (!existsSync(join(builtinDir, "deckcraft/SKILL.md"))) throw new Error("deckcraft not in bundled zip")
  if (existsSync(join(builtinDir, "ppt-master/SKILL.md"))) throw new Error("ppt-master STILL in bundled zip")
  checks.push(`extracted ${n} builtin files (deckcraft present, ppt-master absent)`)

  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // 2. skill list: deckcraft in, ppt-master out (poll until the scan populates)
  let names: string[] = []
  await poll("skill scan populates", async () => {
    const skills = await (await fetch(`${base}/skill`, { headers: WH })).json() as any[]
    names = (Array.isArray(skills) ? skills : []).map((s) => s?.name)
    return names.length > 0
  }, 30000)
  if (!names.includes("deckcraft")) throw new Error(`deckcraft not in skill list: ${names.join(", ")}`)
  if (names.includes("ppt-master")) throw new Error(`ppt-master STILL in skill list: ${names.join(", ")}`)
  checks.push(`GET /skill lists deckcraft, NOT ppt-master (${names.length} skills)`)

  // 3. send a plain 做PPT prompt (no skill name mentioned)
  const sid = ((await (await fetch(`${base}/session`, { method: "POST", headers: WH, body: "{}" })).json()) as { id: string }).id
  const PROMPT = process.env.ROUTE_PROMPT || "帮我做一个关于「远程办公的利与弊」的PPT演示文稿，大概8页。"
  await fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers: WH, body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }], model: { providerID: PID, modelID: MODEL_ID } }) })
  checks.push(`sent prompt (no skill name): "${PROMPT}"`)

  // 4. poll messages until the model calls skill({name}) with args fully streamed.
  //    A `skill` tool part can appear with input:{} before the name arg streams in —
  //    only conclude once input.name is populated.
  let routed: string | null = null
  await poll("model invokes skill tool with a name", async () => {
    const msgs = await (await fetch(`${base}/session/${sid}/message`, { headers: WH })).json() as any[]
    for (const m of msgs) {
      for (const p of (m.parts ?? [])) {
        const toolName = p.tool ?? p.name
        const input = p.state?.input ?? p.input ?? {}
        if (toolName === "skill" && input?.name) { routed = input.name; return true }
      }
    }
    return false
  }, 120000)

  if (routed !== "deckcraft") throw new Error(`model invoked skill "${routed}", expected "deckcraft"`)
  checks.push(`✅ real qwen invoked skill({name:"deckcraft"}) — a plain 做PPT intent routes to deckcraft`)
  verdict = "PASS ✅ — a plain 做PPT prompt to real qwen3.7-max routes to the deckcraft skill; ppt-master is no longer a builtin."
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
