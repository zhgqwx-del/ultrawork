// provider-soft-refresh.e2e.ts — proves ADR-039's soft-refresh patch against a
// REAL opencode binary: adding a provider via `PATCH /global/config?refresh=soft`
// makes the new provider live IMMEDIATELY *without aborting an in-flight streaming
// turn*, whereas the default (hard) path disposes all instances and DOES abort it.
//
// Drives mock-llm (streams M001..MNN slowly) → real opencode (mock provider).
// Two runs share the same "start a turn, wait until it's streaming, then refresh
// global config mid-stream" timing:
//   SOFT (the gate): PATCH /global/config?refresh=soft  → turn must REACH N markers
//                    (not aborted) AND the new provider must be visible immediately.
//   HARD (control):  PATCH /global/config (disposeAll)  → turn must be ABORTED
//                    (< N markers). This proves the harness can detect an abort and
//                    that `?refresh=soft` is precisely what prevents it.
//
//   cd packages/client/desktop && bun run --bun e2e/provider-soft-refresh.e2e.ts
//   Needs: built opencode sidecar binary. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const MOCKLLM = join(DIR, "mock-llm.ts")
const BUN = process.execPath
const PW = "soft-refresh-pw"
const LLM_PORT = 8093
const OC = 4298
const CHUNKS = 40
const DELAY = 200 // 40 × 200ms ≈ 8s streaming window — plenty to refresh mid-stream

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 250)) }
  throw new Error(`timeout ${label}`)
}
function analyze(text: string): { count: number; firstGap: number | null } {
  const uniq = [...new Set([...text.matchAll(/M(\d{3})/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  let firstGap: number | null = null
  for (let i = 0; i < uniq.length; i++) if (uniq[i] !== i + 1) { firstGap = i + 1; break }
  return { count: uniq.length, firstGap }
}

const tmp = mkdtempSync(join(tmpdir(), "soft-refresh-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const cfgPath = join(tmp, ".config/ultrawork/opencode.json")
const baseURL = `http://127.0.0.1:${LLM_PORT}/v1`
writeFileSync(cfgPath, JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "dummy" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: false } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const GH = { authorization: auth, "content-type": "application/json" }
const base = `http://127.0.0.1:${OC}`
const assistantText = async (sid: string): Promise<string> => {
  const msgs = await (await fetch(`${base}/session/${sid}/message`, { headers: WH })).json() as any[]
  return (msgs ?? []).filter((m) => m.info?.role === "assistant")
    .flatMap((m) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)).join("")
}
const newSession = async (): Promise<string> => {
  const s = await (await fetch(`${base}/session`, { method: "POST", headers: WH, body: "{}" })).json() as { id: string }
  return s.id
}
const sendPrompt = (sid: string) =>
  fetch(`${base}/session/${sid}/prompt_async`, {
    method: "POST", headers: WH,
    body: JSON.stringify({ parts: [{ type: "text", text: "stream the markers please" }], model: { providerID: "mockprov", modelID: "mock-model" } }),
  })

// Run one streaming turn; fire `refresh` at a FIXED delay that lands mid-stream
// (opencode persists assistant text end-of-turn — discussions/022 lag — so a
// marker-count "started" signal would fire only AFTER the turn finished). The HARD
// control validates that this delay genuinely lands mid-stream (it must abort).
const FIRE_AT_MS = 2500 // well inside the CHUNKS×DELAY ≈ 8s streaming window
async function runTurn(label: string, refresh: () => Promise<void>) {
  const sid = await newSession()
  await sendPrompt(sid)
  await new Promise((r) => setTimeout(r, FIRE_AT_MS))
  console.log(`  [${label}] +${FIRE_AT_MS}ms (mid-stream) → firing refresh`)
  await refresh()
  // Give the turn ample time to either finish (survived) or stay stalled (aborted).
  await poll(`${label}: settle`, async () => analyze(await assistantText(sid)).count >= CHUNKS, 25000).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const fin = analyze(await assistantText(sid))
  console.log(`  [${label}] final: ${fin.count}/${CHUNKS} markers, firstGap=${fin.firstGap}`)
  return fin
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  spawn([BUN, "run", MOCKLLM], { MOCK_LLM_PORT: String(LLM_PORT), MOCK_LLM_CHUNKS: String(CHUNKS), MOCK_LLM_DELAY_MS: String(DELAY) })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // === SOFT run (the gate): add provider via ?refresh=soft mid-stream ===
  const soft = await runTurn("soft", async () => {
    const r = await fetch(`${base}/global/config?refresh=soft`, {
      method: "PATCH", headers: GH,
      body: JSON.stringify({ provider: { softprov: { name: "SoftAdded", npm: "@ai-sdk/openai-compatible", api: "https://x.invalid/v1", options: { baseURL: "https://x.invalid/v1" }, models: { z: { id: "z", name: "Z" } }, whitelist: ["z"] } } }),
    })
    if (!r.ok) throw new Error(`soft PATCH failed ${r.status}`)
  })
  // Provider must be visible IMMEDIATELY (config-derived cache rebuilt without dispose)
  const cfgAfter = await (await fetch(`${base}/config`, { headers: WH })).json() as { provider?: Record<string, unknown> }
  const provVisible = !!cfgAfter.provider && "softprov" in cfgAfter.provider
  if (soft.count < CHUNKS || soft.firstGap !== null)
    throw new Error(`SOFT refresh ABORTED the stream (${soft.count}/${CHUNKS}, gap=${soft.firstGap}) — patch failed its core promise`)
  checks.push(`SOFT: stream survived to ${soft.count}/${CHUNKS} markers, contiguous ✓`)
  if (!provVisible) throw new Error("SOFT refresh did not make the new provider visible immediately")
  checks.push("SOFT: new provider visible immediately via GET /config (cache rebuilt, no restart) ✓")

  // === HARD run (control): default disposeAll mid-stream MUST abort ===
  const hard = await runTurn("hard", async () => {
    const r = await fetch(`${base}/global/config`, {
      method: "PATCH", headers: GH,
      body: JSON.stringify({ provider: { hardprov: { name: "HardAdded", npm: "@ai-sdk/openai-compatible", api: "https://y.invalid/v1", options: { baseURL: "https://y.invalid/v1" }, models: { z: { id: "z", name: "Z" } }, whitelist: ["z"] } } }),
    })
    if (!r.ok) throw new Error(`hard PATCH failed ${r.status}`)
  })
  if (hard.count >= CHUNKS)
    throw new Error(`HARD control did NOT abort the stream (${hard.count}/${CHUNKS}) — harness cannot distinguish abort from survival, so the SOFT pass is not meaningful`)
  checks.push(`HARD control: disposeAll aborted the stream at ${hard.count}/${CHUNKS} markers (proves the harness detects aborts) ✓`)

  // === SOFT-AFTER-HARD run: registration-lifecycle regression ===
  // A disposeAll must NOT unregister the soft invalidators (make's finalizer is
  // tied to the long-lived runtime scope, not per-instance). If it did, soft
  // refresh would silently stop working after any hard dispose. Prove a soft
  // refresh STILL works (provider visible + stream survives) after the hard run.
  const soft2 = await runTurn("soft2", async () => {
    const r = await fetch(`${base}/global/config?refresh=soft`, {
      method: "PATCH", headers: GH,
      body: JSON.stringify({ provider: { soft2prov: { name: "Soft2", npm: "@ai-sdk/openai-compatible", api: "https://w.invalid/v1", options: { baseURL: "https://w.invalid/v1" }, models: { z: { id: "z", name: "Z" } }, whitelist: ["z"] } } }),
    })
    if (!r.ok) throw new Error(`soft2 PATCH failed ${r.status}`)
  })
  const cfg2 = await (await fetch(`${base}/config`, { headers: WH })).json() as { provider?: Record<string, unknown> }
  if (soft2.count < CHUNKS || soft2.firstGap !== null)
    throw new Error(`SOFT refresh ABORTED the stream AFTER a prior hard dispose (${soft2.count}/${CHUNKS}) — registration lifecycle bug`)
  if (!cfg2.provider || !("soft2prov" in cfg2.provider))
    throw new Error("SOFT refresh stopped working after a hard disposeAll (invalidators unregistered) — registration lifecycle bug")
  checks.push("SOFT-after-HARD: soft refresh STILL works post-disposeAll (no premature unregister) — provider visible + stream survived ✓")

  verdict = "PASS ✅ — soft refresh: provider live immediately + stream NOT aborted (even after a hard dispose); hard refresh aborts (control). The patch delivers immediate-effect without interrupting in-flight turns."
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
