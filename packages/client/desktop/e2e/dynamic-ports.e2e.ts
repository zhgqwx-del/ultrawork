// dynamic-ports.e2e.ts — the production port path, forced.
//
// D1 (discussions/029 §10) says production prefers 4096-4099 and only falls back to
// an ephemeral port when one is taken. On a developer machine the preferred ports
// are always free, so the dynamic branch never runs and could rot unnoticed. This
// pins the parts of it that live outside Rust — everything the Tauri host *hands*
// to a sidecar, plus the one place a sidecar has to find a port for itself.
//
// Real binaries, no Tauri, no GUI. Each sidecar is started exactly the way lib.rs
// starts it, but on ports far from 4096-4099:
//
//   1. opencode  --port DYN          → /global/health answers on DYN
//   2. gateway   GATEWAY_PORT=DYN    → /channel/health and GET /channel answer on DYN
//   3. knowledge KB_PORT=DYN         → /kb/health answers on DYN
//   4. acp       ACP_CLIENT_PORT=DYN → /acp/health answers on DYN
//   5. NOTHING is listening on 4096-4099 — no sidecar silently fell back to a literal
//   6. delegate-mcp with NO ACP_CLIENT_PORT in its env resolves the ACP port from
//      ~/.ultrawork/run/ports.json. This is the cycle-breaker: opencode cannot be
//      told the ACP port at its own launch (ACP starts later and may still move), so
//      the shim it spawns reads the registry instead.
//
//   cd packages/client/desktop && bun run --bun e2e:dynamic-ports   # exit 0 = PASS
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const BIN = join(HERE, "..", "src-tauri", "binaries")
const TRIPLE = "aarch64-apple-darwin"
const OPENCODE = join(BIN, `opencode-server-${TRIPLE}`)
const GATEWAY = join(BIN, `channel-gateway-${TRIPLE}`)
const KB = join(BIN, `knowledge-sidecar-${TRIPLE}`)
const ACP = join(BIN, `acp-client-${TRIPLE}`)

const PW = "dynports-pw"
// Deliberately nowhere near 4096-4099: if a sidecar ignored its env and used the
// compile-time literal, every assertion below would notice.
const DYN = { opencode: 47_101, gateway: 47_102, knowledge: 47_103, acp: 47_104 }
const PREFERRED = [4096, 4097, 4098, 4099]

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(fn: () => Promise<boolean>, ms = 60_000, what = "condition") {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout waiting for ${what}`)
}
async function listening(port: number): Promise<boolean> {
  try {
    const sock = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } })
    sock.end()
    return true
  } catch {
    return false
  }
}

const checks: string[] = []
const ok = (msg: string) => {
  checks.push(msg)
  console.log(`  ✓ ${msg}`)
}

const tmp = mkdtempSync(join(tmpdir(), "dynports-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({ mcp: {} }))

// The registry the Tauri host writes once each sidecar is healthy. delegate-mcp is
// the only consumer that reads it (step 6); HOME points here so it finds ours.
mkdirSync(join(tmp, ".ultrawork/run"), { recursive: true })
writeFileSync(
  join(tmp, ".ultrawork/run/ports.json"),
  JSON.stringify({
    opencode: { port: DYN.opencode, pid: null },
    gateway: { port: DYN.gateway, pid: null },
    knowledge: { port: DYN.knowledge, pid: null },
    acp: { port: DYN.acp, pid: null },
  }),
)

const env = {
  HOME: tmp,
  XDG_CONFIG_HOME: join(tmp, ".config"),
  XDG_DATA_HOME: join(tmp, ".local/share"),
  // Inbound Basic auth for gateway/knowledge/acp (029 阶段 ④b). The Tauri host
  // injects this; here we play the host.
  ULTRAWORK_SIDECAR_PASSWORD: PW,
}
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const H = { authorization: auth }
const opencodeUrl = `http://127.0.0.1:${DYN.opencode}`

async function main() {
  console.log("=== preflight: 4096-4099 must be free, or the last assertion is vacuous ===")
  for (const port of PREFERRED) {
    if (await listening(port)) {
      throw new Error(
        `port ${port} is already in use — stop the dev app first, otherwise the ` +
          `"no sidecar fell back to a literal port" assertion cannot mean anything`,
      )
    }
  }
  ok("4096-4099 all free before we start")

  console.log("\n=== 1. opencode --port (dynamic) ===")
  spawn([OPENCODE, "serve", "--port", String(DYN.opencode)], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  await poll(
    async () => (await fetch(`${opencodeUrl}/global/health`, { headers: { authorization: auth } })).ok,
    60_000,
    "opencode health",
  )
  ok(`opencode answers /global/health on ${DYN.opencode}`)

  console.log("\n=== 2. gateway GATEWAY_PORT + OPENCODE_BASE_URL ===")
  spawn([GATEWAY], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    GATEWAY_PORT: String(DYN.gateway),
    OPENCODE_BASE_URL: opencodeUrl,
  })
  await poll(
    async () => (await fetch(`http://127.0.0.1:${DYN.gateway}/channel/health`, { headers: H })).ok,
    60_000,
    "gateway health",
  )
  ok(`gateway answers /channel/health on ${DYN.gateway}`)

  // Beyond /health: a real route, to show the whole app is mounted on the dynamic
  // port and not just a health stub. (Whether the gateway *reaches* opencode is not
  // observable without a live IM account — that link is covered by the
  // getOpencodeBaseUrl unit test in the gateway package.)
  const channels = await fetch(`http://127.0.0.1:${DYN.gateway}/channel`, { headers: H })
  if (!channels.ok) throw new Error(`gateway GET /channel → ${channels.status}`)
  ok(`gateway serves GET /channel on ${DYN.gateway}`)

  console.log("\n=== 3. knowledge KB_PORT ===")
  spawn([KB], { ...env, KB_PORT: String(DYN.knowledge) })
  await poll(
    async () => (await fetch(`http://127.0.0.1:${DYN.knowledge}/kb/health`, { headers: H })).ok,
    60_000,
    "knowledge health",
  )
  ok(`knowledge answers /kb/health on ${DYN.knowledge}`)

  console.log("\n=== 4. acp ACP_CLIENT_PORT ===")
  spawn([ACP], {
    ...env,
    ACP_CLIENT_PORT: String(DYN.acp),
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_BASE_URL: opencodeUrl,
  })
  await poll(async () => (await fetch(`http://127.0.0.1:${DYN.acp}/acp/health`, { headers: H })).ok, 60_000, "acp health")
  ok(`acp answers /acp/health on ${DYN.acp}`)

  console.log("\n=== 4b. every sidecar rejects an unauthenticated request ===")
  // Both directions: the health checks above already prove the credential is accepted.
  // Without this, a server that dropped its auth middleware would still pass them all.
  for (const [name, url] of [
    ["gateway", `http://127.0.0.1:${DYN.gateway}/channel/health`],
    ["knowledge", `http://127.0.0.1:${DYN.knowledge}/kb/health`],
    ["acp", `http://127.0.0.1:${DYN.acp}/acp/health`],
  ] as const) {
    const anon = await fetch(url)
    if (anon.status !== 401) throw new Error(`${name} answered ${anon.status} without credentials, expected 401`)
    const wrong = await fetch(url, { headers: { authorization: "Basic " + Buffer.from("opencode:wrong").toString("base64") } })
    if (wrong.status !== 401) throw new Error(`${name} answered ${wrong.status} to a wrong password, expected 401`)
  }
  ok("gateway/knowledge/acp all 401 on missing and on wrong credentials")

  console.log("\n=== 5. no sidecar fell back to a compile-time port ===")
  for (const port of PREFERRED) {
    if (await listening(port)) {
      throw new Error(`something bound preferred port ${port} — a sidecar ignored its port env`)
    }
  }
  ok("nothing is listening on 4096-4099")

  console.log("\n=== 6. delegate-mcp finds the ACP port via ports.json (no env) ===")
  // Exactly how opencode spawns it: our binary, `delegate-mcp`, and NO ACP_CLIENT_PORT.
  // It DOES inherit ULTRAWORK_SIDECAR_PASSWORD (opencode gets it from the host), which
  // is how it authenticates to the now-protected /orchestration/*.
  const shimEnv: Record<string, string> = { ...env }
  delete (shimEnv as Record<string, string | undefined>).ACP_CLIENT_PORT
  const shim = Bun.spawn([ACP, "delegate-mcp"], {
    env: { ...process.env, ...shimEnv, ACP_CLIENT_PORT: undefined } as never,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  procs.push(shim)

  const rpc = (msg: unknown) => shim.stdin.write(JSON.stringify(msg) + "\n")
  rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
  })
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" })
  // list_agents forwards to the ACP sidecar. If the shim resolved the wrong port it
  // would fail to connect; on the right one it gets the sidecar's real agent list.
  rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agents", arguments: {} } })

  const reader = shim.stdout.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let result: string | undefined
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && result === undefined) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (const line of buf.split("\n").slice(0, -1)) {
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id === 2) result = JSON.stringify(msg.result ?? msg.error)
    }
    buf = buf.slice(buf.lastIndexOf("\n") + 1)
  }
  if (result === undefined) throw new Error("delegate-mcp never answered tools/call list_agents")
  // A wrong port surfaces as a connection error inside the tool result text.
  if (/ECONNREFUSED|failed to fetch|fetch failed|Unable to connect/i.test(result)) {
    throw new Error(`delegate-mcp could not reach the ACP sidecar — it resolved the wrong port: ${result}`)
  }
  ok("delegate-mcp reached the ACP sidecar on its dynamic port, with no ACP_CLIENT_PORT in env")

  console.log(`\n=== VERDICT: PASS ✅ — ${checks.length} assertions, dynamic ports end to end ===`)
}

main()
  .catch((err) => {
    console.error(`\n=== VERDICT: FAIL ❌ — ${err?.message ?? err} ===`)
    process.exitCode = 1
  })
  .finally(() => {
    for (const p of procs) p.kill()
    rmSync(tmp, { recursive: true, force: true })
  })
