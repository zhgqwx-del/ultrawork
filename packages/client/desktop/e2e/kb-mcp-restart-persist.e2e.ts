// kb-mcp-restart-persist.e2e.ts — proves the persistence half of the knowledge
// MCP fix: once registerKnowledgeMCP has written the entry to the global
// opencode.json (what the Rust write_mcp_config command does), a FRESH OpenCode
// process auto-connects the knowledge-base MCP on boot from that persisted
// config — no POST /mcp, no UI. This is what makes the fix survive an app
// restart (the auto-restore effect only needs to run once, ever).
//
// Flow (pure HTTP, real opencode, isolated env):
//   1. boot opencode, EMPTY mcp config            → GET /mcp has no knowledge-base
//   2. mirror write_mcp_config: insert knowledge-base under root.mcp in the
//      global opencode.json (real knowledge-sidecar command)
//   3. kill opencode, wait for exit
//   4. restart opencode on the SAME config        → GET /mcp must show
//      knowledge-base === connected, purely from persisted config
//
//   cd packages/client/desktop && bun run --bun e2e/kb-mcp-restart-persist.e2e.ts
//   Needs: built sidecar binaries. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const DESKTOP = join(HERE, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const KB_SIDECAR = join(DESKTOP, "src-tauri/binaries", `knowledge-sidecar-${ARCH}-apple-darwin`)
const PW = "kb-restart-pw"
const OC = 4296 // non-standard port to avoid colliding with a running dev app

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "kb-restart-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const cfgPath = join(tmp, ".config/ultrawork/opencode.json")
writeFileSync(cfgPath, JSON.stringify({ mcp: {} }))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const H = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`
const getMcp = async () => (await fetch(`${base}/mcp`, { headers: H })).json() as Promise<Record<string, { status: string }>>
const bootOpencode = () => {
  const p = spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  return p
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  // 1. boot #1 — empty config
  let oc = bootOpencode()
  await poll("opencode#1 health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)
  const before = await getMcp()
  if ("knowledge-base" in before) throw new Error(`baseline already has knowledge-base: ${JSON.stringify(before)}`)
  checks.push(`boot #1 (empty config): GET /mcp has no knowledge-base ✓`)

  // 2. mirror write_mcp_config — insert under root.mcp[knowledge-base]
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcp?: Record<string, unknown> }
  cfg.mcp = cfg.mcp ?? {}
  cfg.mcp["knowledge-base"] = { type: "local", command: [KB_SIDECAR, "mcp-stdio"], enabled: true }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  checks.push("persisted knowledge-base to global opencode.json (mirrors write_mcp_config) ✓")

  // 3. kill opencode #1 and wait for it to exit
  oc.kill()
  await oc.exited
  await poll("port free", async () => { try { await fetch(`${base}/global/health`, { headers: { authorization: auth } }); return false } catch { return true } }, 20000)
  checks.push("opencode #1 stopped ✓")

  // 4. restart — must auto-connect from persisted config (no POST /mcp)
  oc = bootOpencode()
  await poll("opencode#2 health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)
  let after: Record<string, { status: string }> = {}
  await poll("knowledge-base reconnected", async () => { after = await getMcp(); return after["knowledge-base"]?.status === "connected" }, 25000)
  checks.push(`boot #2 auto-connected knowledge-base from persisted config ✓ (status=${after["knowledge-base"]?.status})`)

  verdict = "PASS ✅ — persisted knowledge-base MCP auto-connects on a fresh OpenCode boot (restart survives)"
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
