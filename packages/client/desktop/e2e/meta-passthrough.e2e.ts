// meta-passthrough.e2e.ts — guards the ADR-035 opencode vendor patch: prove the
// running sessionID reaches an MCP server via `_meta`. Real (patched) opencode +
// mock-llm-toolcall (emits a tool_call to the stub MCP) + stub-mcp (echoes _meta).
// Asserts the tool result's _meta.ultrawork_session === the session id. If an
// opencode bump silently drops the patch (llm.ts experimental_context / mcp/index.ts
// _meta), this flips to FAIL — that's the whole point of keeping it.
//
//   cd packages/client/desktop && bun run --bun e2e:meta   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", "opencode-server-aarch64-apple-darwin")
const BUN = process.execPath
const PW = "meta-pw"; const LLM = 8089; const OC = 4096

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) =>
  { const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p }
async function poll(fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error("timeout")
}

const tmp = mkdtempSync(join(tmpdir(), "meta-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
  mcp: { metachk: { type: "local", command: [BUN, "run", join(HERE, "stub-mcp.ts")], enabled: true } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const H = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }

let verdict = "INCOMPLETE"
try {
  spawn([BUN, "run", join(HERE, "mock-llm-toolcall.ts")], { MOCK_LLM_PORT: String(LLM), MOCK_LLM_TOOL: "metachk_ping" })
  await poll(async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll(async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  const session = await (await fetch(`http://127.0.0.1:${OC}/session`, { method: "POST", headers: H, body: "{}" })).json() as { id: string }
  await fetch(`http://127.0.0.1:${OC}/session/${session.id}/prompt_async`, { method: "POST", headers: H, body: JSON.stringify({ parts: [{ type: "text", text: "call the tool" }], model: { providerID: "mockprov", modelID: "mock-model" } }) })
  await new Promise((r) => setTimeout(r, 9000))

  const sm = await (await fetch(`http://127.0.0.1:${OC}/session/${session.id}/message`, { headers: H })).json() as Array<{ info?: { role?: string }; parts?: Array<{ type: string; text?: string }> }>
  const allText = sm.filter((m) => m.info?.role === "assistant").flatMap((m) => (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "")).join("")
  const got = allText.match(/"ultrawork_session"\s*:\s*"([^"]+)"/)?.[1]
  console.log("answer snippet:", JSON.stringify(allText.slice(0, 200)))
  verdict = got === session.id
    ? `PASS ✅ — opencode forwarded sessionID via _meta (ultrawork_session=${got})`
    : `FAIL ❌ — ultrawork_session=${got ?? "MISSING"} expected ${session.id} (vendor patch dropped?)`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
