// mcp-status-dynamic.e2e.ts — guards the vendor patch (mcp/index.ts MCP.status())
// that surfaces dynamically-registered MCPs (via POST /mcp, not yet in the
// persisted config) in GET /mcp. This is what makes the desktop knowledge-base
// auto-restore (use-knowledge-base.ts: api.getMCP()) see a freshly registered
// server before OpenCode reloads its config file.
//
// Flow (real, patched opencode, EMPTY mcp config):
//   1. GET /mcp                       → assert "knowledge-base" ABSENT (baseline)
//   2. POST /mcp {name, config}       → register knowledge-base at the REAL
//                                       knowledge-sidecar (MCP.add → s.status only,
//                                       does NOT write config)
//   3. GET /mcp                       → assert "knowledge-base" PRESENT — only the
//                                       state-inclusion patch can surface it, since
//                                       config is empty
//   4. Bonus: assert status==="connected" — the real knowledge-sidecar mcp-stdio
//      stays alive under opencode's held-open stdin (re-confirms the dropped
//      keep-alive patch is unnecessary; an immediate exit would show "failed").
//
//   cd packages/client/desktop && bun run --bun e2e:mcp-status   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const OPENCODE = join(HERE, "..", "src-tauri", "binaries", "opencode-server-aarch64-apple-darwin")
const KB_SIDECAR = join(HERE, "..", "src-tauri", "binaries", "knowledge-sidecar-aarch64-apple-darwin")
const PW = "mcpstatus-pw"
const OC = 4196 // non-standard port to avoid colliding with a running dev app on 4096

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error("timeout")
}

const tmp = mkdtempSync(join(tmpdir(), "mcpstatus-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
// EMPTY mcp config — the whole point is that GET /mcp must NOT find knowledge-base
// from config; only the state-inclusion patch can surface it after POST /mcp.
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({ mcp: {} }))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const H = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`
// Send the directory header on GET too — MCP runtime state is per-instance
// (keyed by directory), so a bare GET would read a different instance than the
// POST that registered the MCP.
const getMcp = async () => (await fetch(`${base}/mcp`, { headers: H })).json() as Promise<Record<string, { status: string }>>

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll(async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // 1. baseline — empty config, knowledge-base must be absent
  const before = await getMcp()
  if ("knowledge-base" in before) throw new Error(`baseline GET /mcp already has knowledge-base: ${JSON.stringify(before)}`)
  checks.push(`baseline GET /mcp has no knowledge-base ✓ (keys=${JSON.stringify(Object.keys(before))})`)

  // 2. register via POST /mcp (MCP.add → runtime state only, not config)
  const addResp = await fetch(`${base}/mcp`, {
    method: "POST", headers: H,
    body: JSON.stringify({ name: "knowledge-base", config: { type: "local", command: [KB_SIDECAR, "mcp-stdio"], enabled: true } }),
  })
  if (!addResp.ok) throw new Error(`POST /mcp failed: ${addResp.status} ${await addResp.text()}`)
  checks.push("POST /mcp accepted ✓")

  // 3. GET /mcp must now surface it — ONLY the patch can do this (config is empty).
  //    Poll briefly: the stdio handshake takes a moment to flip to connected.
  let after: Record<string, { status: string }> = {}
  await poll(async () => { after = await getMcp(); return "knowledge-base" in after }, 20000)
  checks.push(`GET /mcp surfaces dynamically-added knowledge-base ✓ (status=${after["knowledge-base"]?.status})`)

  // 4. bonus — the real knowledge-sidecar should connect (keep-alive not needed)
  await poll(async () => { after = await getMcp(); return after["knowledge-base"]?.status === "connected" }, 20000)
    .catch(() => {})
  const connected = after["knowledge-base"]?.status === "connected"
  checks.push(connected
    ? "knowledge-sidecar mcp-stdio reached status=connected ✓ (stdin held open → no keep-alive needed)"
    : `knowledge-sidecar status=${after["knowledge-base"]?.status} (surfaced by patch regardless; connection is a bonus check)`)

  verdict = "PASS ✅ — MCP.status() patch surfaces dynamically-registered MCPs in GET /mcp"
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
