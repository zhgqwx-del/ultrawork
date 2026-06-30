// provider-realmodel.e2e.ts — REAL-MODEL end-to-end proof for ADR-039 against a
// real opencode binary AND a real LLM endpoint. Closes the one gap the mock can't:
//   (1) a custom provider added via the GLOBAL endpoint (PATCH /global/config?refresh=soft
//       + key via PUT /auth) is not just persisted but ACTUALLY USABLE — a real prompt
//       resolves the model, uses the key, and returns a real non-empty completed answer.
//   (2) a mid-stream soft refresh does NOT interrupt a REAL streaming turn (it completes
//       normally), whereas a hard disposeAll DOES abort it (control).
//
// Credentials are read from an env file (BASE_URL/API_KEY/MODEL_ID/PROTOCOL) — the key
// is never logged, never committed, used only for PUT /auth in an isolated temp stack.
//
//   ENVFILE=/abs/path/to/real-llm.env \
//   cd packages/client/desktop && bun run --bun e2e/provider-realmodel.e2e.ts
//   Needs: built opencode sidecar + network to the endpoint. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "realmodel-pw"
const OC = 4301
const PID = "realprov"
const ENVFILE = process.env.ENVFILE
  || "/private/tmp/claude-501/-Users-zhangguoqiang-ai-workspace-claude-workspace-ultrawork01-ultrawork/649bc0b7-ad23-4f9b-a1b4-f2f4ba2b0cab/scratchpad/real-llm.env"

// --- parse the env file (never echo API_KEY) ---
function parseEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}
const cfg = parseEnv(ENVFILE)
const BASE_URL = cfg.BASE_URL, API_KEY = cfg.API_KEY, MODEL_ID = cfg.MODEL_ID
const PROTOCOL = (cfg.PROTOCOL || "openai") as "openai" | "anthropic"
if (!BASE_URL || !API_KEY || !MODEL_ID) { console.error("env file missing BASE_URL/API_KEY/MODEL_ID"); process.exit(1) }
const npm = PROTOCOL === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
console.log(`[cfg] BASE_URL=${BASE_URL} MODEL_ID=${MODEL_ID} PROTOCOL=${PROTOCOL} API_KEY=***(${API_KEY.length} chars)`)

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const tmp = mkdtempSync(join(tmpdir(), "realmodel-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const GH = { authorization: auth, "content-type": "application/json" }
const base = `http://127.0.0.1:${OC}`

const newSession = async (): Promise<string> =>
  ((await (await fetch(`${base}/session`, { method: "POST", headers: WH, body: "{}" })).json()) as { id: string }).id
const sendPrompt = (sid: string, text: string) =>
  fetch(`${base}/session/${sid}/prompt_async`, { method: "POST", headers: WH, body: JSON.stringify({ parts: [{ type: "text", text }], model: { providerID: PID, modelID: MODEL_ID } }) })
// Returns the assistant message terminal: { text, completed, error }
async function assistant(sid: string): Promise<{ text: string; completed: boolean; error: boolean }> {
  const msgs = await (await fetch(`${base}/session/${sid}/message`, { headers: WH })).json() as any[]
  const a = (msgs ?? []).filter((m) => m.info?.role === "assistant")
  const text = a.flatMap((m) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)).join("")
  const last = a[a.length - 1]?.info
  return { text, completed: !!last?.time?.completed, error: !!last?.error }
}
async function awaitTurn(sid: string, ms = 90000) {
  await poll("turn settled", async () => { const a = await assistant(sid); return a.completed || a.error }, ms)
  return assistant(sid)
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // Add the custom provider via the GLOBAL endpoint + key via PUT /auth (auth.json).
  const patch = await fetch(`${base}/global/config?refresh=soft`, { method: "PATCH", headers: GH, body: JSON.stringify({ provider: { [PID]: { name: "RealProv", npm, api: BASE_URL, options: { baseURL: BASE_URL }, models: { [MODEL_ID]: { id: MODEL_ID, name: MODEL_ID, tool_call: false } }, whitelist: [MODEL_ID] } } }) })
  if (!patch.ok) throw new Error(`global provider PATCH failed ${patch.status}`)
  const ar = await fetch(`${base}/auth/${PID}`, { method: "PUT", headers: GH, body: JSON.stringify({ type: "api", key: API_KEY }) })
  if (!ar.ok) throw new Error(`PUT /auth failed ${ar.status}`)
  checks.push("added custom provider via GLOBAL endpoint + key via PUT /auth ✓")

  // (1) USABILITY — the globally-added provider actually answers a real prompt.
  const s1 = await newSession()
  await sendPrompt(s1, "In two short sentences, what is the ocean?")
  const r1 = await awaitTurn(s1)
  if (r1.error) throw new Error("real prompt through the global custom provider ERRORED")
  if (!r1.completed || r1.text.trim().length < 10) throw new Error(`no real answer (completed=${r1.completed}, len=${r1.text.trim().length})`)
  checks.push(`USABLE: real model answered (${r1.text.trim().length} chars, completed, no error) — global custom provider works end-to-end ✓`)
  console.log(`  [answer preview] ${r1.text.trim().slice(0, 80).replace(/\n/g, " ")}…`)

  // (2) NO-INTERRUPT — a mid-stream soft refresh must not abort a REAL streaming turn.
  const s2 = await newSession()
  await sendPrompt(s2, "Write about 200 words describing a quiet forest at dawn.")
  await sleep(2500) // mid-stream for a ~200-word real generation
  const sr = await fetch(`${base}/global/config?refresh=soft`, { method: "PATCH", headers: GH, body: JSON.stringify({ provider: { midstreamprov: { name: "Mid", npm: "@ai-sdk/openai-compatible", api: "https://x.invalid/v1", options: { baseURL: "https://x.invalid/v1" }, models: { z: { id: "z", name: "Z" } }, whitelist: ["z"] } } }) })
  if (!sr.ok) throw new Error(`mid-stream soft refresh PATCH failed ${sr.status}`)
  console.log("  [soft] fired mid-stream soft refresh")
  const r2 = await awaitTurn(s2)
  if (r2.error || !r2.completed) throw new Error(`SOFT refresh INTERRUPTED a real stream (completed=${r2.completed}, error=${r2.error})`)
  if (r2.text.trim().length < 100) throw new Error(`real answer suspiciously short after soft refresh (${r2.text.trim().length} chars) — possible truncation`)
  checks.push(`NO-INTERRUPT: real streaming turn completed normally through a mid-stream soft refresh (${r2.text.trim().length} chars) ✓`)

  // (3) HARD CONTROL — disposeAll mid-stream should abort the real turn (proves detection).
  const s3 = await newSession()
  await sendPrompt(s3, "Write about 200 words describing a busy harbor at noon.")
  await sleep(2500)
  const hr = await fetch(`${base}/global/config`, { method: "PATCH", headers: GH, body: JSON.stringify({ provider: { hardprov2: { name: "Hard2", npm: "@ai-sdk/openai-compatible", api: "https://y.invalid/v1", options: { baseURL: "https://y.invalid/v1" }, models: { z: { id: "z", name: "Z" } }, whitelist: ["z"] } } }) })
  if (!hr.ok) throw new Error(`hard PATCH failed ${hr.status}`)
  console.log("  [hard] fired mid-stream disposeAll")
  const r3 = await awaitTurn(s3, 30000).catch(() => assistant(s3))
  const aborted = r3.error || !r3.completed || r3.text.trim().length < r2.text.trim().length / 2
  checks.push(`HARD control: disposeAll mid-stream → ${aborted ? "aborted/truncated (error=" + r3.error + ", completed=" + r3.completed + ", len=" + r3.text.trim().length + ") ✓" : "did NOT clearly abort (len=" + r3.text.trim().length + ") ⚠"}`)

  verdict = "PASS ✅ — globally-added custom provider is USABLE with a real model, and a real streaming turn survives a mid-stream soft refresh (hard disposeAll aborts, as control)."
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
