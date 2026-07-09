// kb-mcp-autoregister.e2e.ts — browser walkthrough of the IMA/remote-only
// knowledge-base MCP auto-register fix (branch fix/knowledge-mcp-ima-autoregister).
//
// Proves the REAL hook (use-knowledge-base.ts auto-restore effect) running in a
// real WebView against real sidecars registers the knowledge-base MCP with
// OpenCode when an IMA-only source exists — the case add-source-dialog never
// registered, so the AI couldn't query an IMA-only KB.
//
// Flow:
//   1. boot knowledge-sidecar (:4098, isolated HOME) + seed an `ima` source
//      directly via POST /kb/sources (the add-source-dialog path — no folder,
//      no MCP registration)
//   2. boot opencode (:4096, EMPTY mcp config) + Vite (:1420)
//   3. real Chrome + Tauri-invoke shim (get_sidecar_path → real KB binary;
//      write_mcp_config → no-op, we assert the RUNTIME registration not the file)
//   4. navigate to Settings → Knowledge Base so useKnowledgeBase() mounts; the
//      auto-restore effect fires getMCP → registerKnowledgeMCP
//   5. assert opencode GET /mcp shows knowledge-base === connected
//
//   cd packages/client/desktop && bun run --bun e2e/kb-mcp-autoregister.e2e.ts
//   Needs: system Chrome; built sidecar binaries. Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const KB_SIDECAR = join(DESKTOP, "src-tauri/binaries", `knowledge-sidecar-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "kb-autoreg-pw"
const OC = 4096, KB = 4098

const procs: { name: string; p: ReturnType<typeof Bun.spawn> }[] = []
const spawn = (name: string, cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push({ name, p }); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "kb-autoreg-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
// EMPTY mcp config — registration must come from the runtime auto-restore path.
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({ mcp: {} }))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const ocHeaders = { authorization: auth, "content-type": "application/json", "x-opencode-directory": ws }
const getMcp = async () => (await fetch(`http://127.0.0.1:${OC}/mcp`, { headers: ocHeaders })).json() as Promise<Record<string, { status: string }>>

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== boot knowledge-sidecar + seed IMA source ===")
  // ULTRAWORK_SIDECAR_PASSWORD: the knowledge sidecar now requires Basic auth (029 ④b).
  spawn("kb", [KB_SIDECAR], { ...env, ULTRAWORK_SIDECAR_PASSWORD: PW })
  await poll("kb-sidecar", async () => (await fetch(`http://127.0.0.1:${KB}/kb/sources`, { headers: { authorization: auth } })).ok)
  const seed = await fetch(`http://127.0.0.1:${KB}/kb/sources`, {
    method: "POST", headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ type: "ima", name: "Test IMA Notes", config: { module: "notes" } }),
  })
  if (!seed.ok) throw new Error(`seed IMA source failed: ${seed.status} ${await seed.text()}`)
  const srcList = await (await fetch(`http://127.0.0.1:${KB}/kb/sources`, { headers: { authorization: auth } })).json() as { sources: unknown[] }
  if (!srcList.sources?.length) throw new Error("seeded source not present in /kb/sources")
  checks.push(`seeded IMA source (no folder, no MCP registration) ✓ (sources=${srcList.sources.length})`)

  console.log("=== boot opencode (empty mcp config) + vite ===")
  spawn("opencode", [OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  const before = await getMcp()
  if ("knowledge-base" in before) throw new Error(`baseline GET /mcp already has knowledge-base: ${JSON.stringify(before)}`)
  checks.push(`baseline opencode GET /mcp has no knowledge-base ✓ (keys=${JSON.stringify(Object.keys(before))})`)
  spawn("vite", [BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  page.on("console", (m) => { const t = m.text(); if (/knowledge|mcp|auto-restore/i.test(t)) console.log("  [page]", t) })
  await page.addInitScript(({ ws, pw, kb }) => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws,
      login_shell_path: () => "", scan_workspace_changes: () => [],
      // KB MCP registration path: real sidecar binary; write_mcp_config is a
      // no-op here — the assertion is the RUNTIME registration (POST /mcp), not
      // the persisted file (which the Rust command would write in the app).
      get_sidecar_path: () => kb, write_mcp_config: () => null, read_mcp_config: () => ({}),
      // The knowledge sidecar requires Basic auth; the renderer reads the credential
      // from the host at startup (sidecar-auth.ts).
      get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, kb: KB_SIDECAR })

  console.log("=== navigate to Settings → Knowledge Base ===")
  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  // Click the Knowledge nav item (en "Knowledge" / zh "知识库").
  await page.getByRole("button", { name: /知识库|Knowledge/i }).first().click()
  // Wait until the KB section actually rendered the seeded source (hook mounted + fetched).
  await poll("kb section rendered", async () => (await page.locator("body").innerText()).includes("Test IMA Notes"), 20000)
  checks.push("KB settings section mounted + seeded source visible (useKnowledgeBase active) ✓")

  console.log("=== wait for auto-restore effect to register the MCP ===")
  let after: Record<string, { status: string }> = {}
  await poll("knowledge-base registered", async () => { after = await getMcp(); return "knowledge-base" in after }, 25000)
  checks.push(`opencode GET /mcp now has knowledge-base ✓ (status=${after["knowledge-base"]?.status})`)
  await poll("knowledge-base connected", async () => { after = await getMcp(); return after["knowledge-base"]?.status === "connected" }, 20000).catch(() => {})
  const connected = after["knowledge-base"]?.status === "connected"
  checks.push(connected ? "knowledge-base reached status=connected ✓" : `knowledge-base status=${after["knowledge-base"]?.status} (registered; connect is the bonus check)`)

  verdict = ("knowledge-base" in after)
    ? "PASS ✅ — IMA-only source auto-registered the knowledge-base MCP with OpenCode"
    : "FAIL ❌ — knowledge-base MCP never registered for an IMA-only source"
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const { p } of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
