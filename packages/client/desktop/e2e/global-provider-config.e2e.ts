// global-provider-config.e2e.ts — proves ADR-039's core runtime claim against a
// REAL opencode binary: writing a custom provider via the global config endpoint
// `PATCH /global/config` (what ApiClient.patchGlobalConfig / upsertCustomProvider
// now call) takes effect IMMEDIATELY (no restart) and lands in the GLOBAL
// opencode.json — never a per-workspace file.
//
// This is the linchpin the design hinges on: simply writing the global file from
// outside is NOT enough (opencode caches global config with infinite TTL + has no
// config-dir watcher); the `/global/config` route's Config.updateGlobal writes the
// file AND invalidates the cache, so the next request re-resolves.
//
// Flow (pure HTTP, real opencode, isolated env, single process — NO restart):
//   1. boot opencode (empty global config) → GET /config (ws) has no e2e provider
//   2. PATCH /global/config with a custom provider def (no x-opencode-directory)
//   3. GET /config (ws)  → provider visible IMMEDIATELY (cache invalidated)        [HARD]
//   4. global opencode.json on disk now has provider.<id>                          [HARD]
//   5. the workspace opencode.json was NOT created                                 [HARD]
//   6. PATCH /global/config disabled_providers:[id] → GET /config hides nothing in
//      config but the key is present (round-trips through updateGlobal)            [soft]
//
//   cd packages/client/desktop && bun run --bun e2e/global-provider-config.e2e.ts
//   Needs: built opencode sidecar binary. Exit 0 = PASS, 1 = FAIL.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const HERE = import.meta.dir
const DESKTOP = join(HERE, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "global-provider-pw"
const OC = 4297 // non-standard port to avoid colliding with a running dev app
const PID = "e2e-llm"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>) => {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "global-provider-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const cfgPath = join(tmp, ".config/ultrawork/opencode.json")
const wsCfgPath = join(ws, "opencode.json")
writeFileSync(cfgPath, JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
// Global-route calls carry NO x-opencode-directory (proving no workspace is needed).
const GH = { authorization: auth, "content-type": "application/json" }
// Per-workspace reads carry the directory header so GET /config returns the merged view.
const WH = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const base = `http://127.0.0.1:${OC}`
const getWsConfig = async () => (await fetch(`${base}/config`, { headers: WH })).json() as Promise<{ provider?: Record<string, unknown>; disabled_providers?: string[] }>
const providerDef = {
  provider: {
    [PID]: {
      name: "E2E LLM", npm: "@ai-sdk/openai-compatible",
      api: "https://example.invalid/v1", options: { baseURL: "https://example.invalid/v1" },
      models: { m1: { id: "m1", name: "M1" } }, whitelist: ["m1"],
    },
  },
}

const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  const oc = spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  void oc
  await poll("opencode health", async () => (await fetch(`${base}/global/health`, { headers: { authorization: auth } })).ok)

  // 1. baseline — no e2e provider in the merged workspace config
  const before = await getWsConfig()
  if (before.provider && PID in before.provider) throw new Error(`baseline already has provider ${PID}`)
  checks.push("boot (empty global config): GET /config (ws) has no e2e provider ✓")

  // 2. write the custom provider via the GLOBAL endpoint (no directory header)
  const patchRes = await fetch(`${base}/global/config`, { method: "PATCH", headers: GH, body: JSON.stringify(providerDef) })
  if (!patchRes.ok) throw new Error(`PATCH /global/config failed: ${patchRes.status} ${await patchRes.text()}`)
  checks.push("PATCH /global/config (no x-opencode-directory) accepted ✓")

  // 3. HARD — provider visible IMMEDIATELY in the same running process (cache invalidated, no restart)
  const after = await getWsConfig()
  if (!after.provider || !(PID in after.provider)) throw new Error(`provider ${PID} NOT visible after PATCH (cache not invalidated): ${JSON.stringify(after.provider)}`)
  checks.push("GET /config (ws) shows the provider IMMEDIATELY — no restart (updateGlobal invalidated the cache) ✓")

  // 4. HARD — the GLOBAL file on disk now carries the provider
  const diskGlobal = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: Record<string, unknown> }
  if (!diskGlobal.provider || !(PID in diskGlobal.provider)) throw new Error(`global opencode.json missing provider ${PID}: ${JSON.stringify(diskGlobal)}`)
  checks.push("global ~/.config/ultrawork/opencode.json contains provider.<id> ✓")

  // 5. HARD — no per-workspace opencode.json was written
  if (existsSync(wsCfgPath)) {
    const diskWs = JSON.parse(readFileSync(wsCfgPath, "utf8")) as { provider?: Record<string, unknown> }
    if (diskWs.provider && PID in diskWs.provider) throw new Error(`provider leaked into per-workspace opencode.json: ${wsCfgPath}`)
    checks.push("workspace opencode.json exists but has no e2e provider (not leaked) ✓")
  } else {
    checks.push("workspace opencode.json was never created (write stayed global) ✓")
  }

  // 6. soft — disabled_providers round-trips through the global endpoint too
  const disRes = await fetch(`${base}/global/config`, { method: "PATCH", headers: GH, body: JSON.stringify({ disabled_providers: [PID] }) })
  if (!disRes.ok) throw new Error(`PATCH disabled_providers failed: ${disRes.status}`)
  const disDisk = JSON.parse(readFileSync(cfgPath, "utf8")) as { disabled_providers?: string[] }
  if (!disDisk.disabled_providers?.includes(PID)) throw new Error("disabled_providers not persisted to global config")
  checks.push("setProviderDisabled path: disabled_providers persisted to global config ✓")

  verdict = "PASS ✅ — global provider config writes the global file, goes live immediately, never touches the workspace"
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
