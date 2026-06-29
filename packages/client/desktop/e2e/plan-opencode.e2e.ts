// plan-opencode.e2e.ts — proves the OpenCode task-plan path end-to-end on the
// REAL opencode binary through the REAL production connector code (ADR-038):
//   mock-llm-todowrite (calls built-in `todowrite`) → real opencode (executes it,
//   persists todos, emits `todo.updated` on /event) → OpenCodeBackend
//   (normalizeOpenCodeEvent → `plan.updated`; getPlan → REST /session/{id}/todo).
//
// Asserts:
//   1. a normalized `plan.updated` event arrives on the global stream with the
//      exact todos the model wrote (proves the live SSE path + normalize);
//   2. backend.getPlan(sid) returns the same todos (proves the REST hydrate path).
// No real model / credentials needed.
//
//   cd packages/client/desktop && bun run --bun e2e:plan-opencode   # exit 0 = PASS
import { OpenCodeBackend } from "@agent/connector"
import type { ConnectorEvent } from "@agent/connector"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "plan-pw"; const LLM = 8090; const OC = 4096

const EXPECTED = [
  { content: "Write the failing test", status: "in_progress", priority: "high" },
  { content: "Implement the fix", status: "pending", priority: "medium" },
  { content: "Run the suite", status: "pending", priority: "low" },
]

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error("timeout")
}
const norm = (p: Array<{ content: string; status: string; priority?: string }>) =>
  p.map((x) => ({ content: x.content, status: x.status, priority: x.priority }))

const tmp = mkdtempSync(join(tmpdir(), "plan-oc-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }

let verdict = "INCOMPLETE"
let backend: OpenCodeBackend | undefined
try {
  spawn([BUN, "run", join(HERE, "mock-llm-todowrite.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll(async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll(async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: "Basic " + Buffer.from(`opencode:${PW}`).toString("base64") } })).ok)

  // Real production connector code against the real server.
  backend = new OpenCodeBackend({ baseUrl: `http://127.0.0.1:${OC}`, username: "opencode", password: PW, workingDirectory: ws })
  const planEvents: Array<{ sessionID: string; entries: unknown[] }> = []
  backend.subscribeGlobal((e: ConnectorEvent) => {
    if (e.type === "plan.updated") planEvents.push(e.properties as { sessionID: string; entries: unknown[] })
  })
  await backend.ready()

  const session = await backend.createSession({ directory: ws })
  await backend.prompt(session.id, "make a plan", { model: "mockprov/mock-model" })

  // 1) live normalized plan.updated arrives with the exact todos
  await poll(async () => planEvents.some((p) => p.sessionID === session.id && p.entries.length === EXPECTED.length), 30000)
  const live = planEvents.filter((p) => p.sessionID === session.id).pop()!
  const liveOk = JSON.stringify(norm(live.entries as any)) === JSON.stringify(EXPECTED)

  // 2) REST hydrate (getPlan) returns the same snapshot
  const snapshot = await backend.getPlan(session.id)
  const restOk = JSON.stringify(norm(snapshot)) === JSON.stringify(EXPECTED)

  console.log("[live] plan.updated entries:", JSON.stringify(norm(live.entries as any)))
  console.log("[rest] getPlan entries:    ", JSON.stringify(norm(snapshot)))
  verdict = liveOk && restOk
    ? "PASS ✅ — todo.updated normalized to plan.updated AND getPlan REST snapshot both match"
    : `FAIL ❌ — liveOk=${liveOk} restOk=${restOk}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  backend?.dispose()
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
