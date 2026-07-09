// connectors-tabs-ui-walkthrough.e2e.ts — real-browser proof for the
// Settings → Connectors MCP/Office-CLI TABS refactor (feat/connectors-tabs).
// Complements office-cli-ui-walkthrough (which drives the Office-CLI tab): this
// drives the MCP tab + the tab machinery itself in a REAL browser —
//   1. header (title + global Refresh) + two tabs (MCP default active),
//   2. the MCP add-server dropdown moved into the MCP tab still opens,
//   3. **forceMount keep-alive**: a half-typed add-server name SURVIVES a
//      round-trip to the Office-CLI tab and back (the one thing jsdom cannot
//      prove — Radix unmounts inactive TabsContent, so without forceMount the
//      field would reset to empty),
//   4. the MCP panel is visually HIDDEN (display:none) while the CLI tab is
//      active, not just unmounted,
//   5. the global Refresh button works from the header.
// The office-CLI Tauri probes are shimmed (as in the sibling walkthrough); the
// MCP list is served by the real opencode instance (empty → empty state).
//
// Run:  cd packages/client/desktop && bun run --bun e2e/connectors-tabs-ui-walkthrough.e2e.ts
// Needs: system Chrome + built opencode sidecar + ports 1420/4096 free.
// Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "tabs-ui-pw"
const SHOTS = "/private/tmp/claude-501/-Users-zhangguoqiang-ai-workspace-claude-workspace-ultrawork01-ultrawork/47eeef6b-74b9-44f1-b72e-8df5166e6ced/scratchpad"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "tabs-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + minimal tauri shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [], // all three cards render as not_installed
      detect_browser_env: () => ({
        node_path: "/usr/bin/node", node_version: "v20.0.0", node_embedded: false, chrome_path: null,
        playwright_installed: false, devtools_installed: false, mode: "playwright", mcp_dir: `${ws}/.ultrawork/mcp`,
      }),
      "plugin:opener|open_url": () => null,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: "en" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  console.log("=== 1. Connectors page: header (title + global Refresh) + MCP/Office CLI tabs, MCP active ===")
  await page.locator("nav").getByText(/^Connectors$/).first().click()
  await page.getByRole("button", { name: /^Refresh$/ }).waitFor({ timeout: 10000 })
  const mcpTab = page.getByRole("tab", { name: /^MCP/ })
  const cliTab = page.getByRole("tab", { name: /Office CLI/ })
  await mcpTab.waitFor({ timeout: 10000 })
  await cliTab.waitFor({ timeout: 5000 })
  // MCP is the default tab: its Browser Control card + Add Connector button are visible
  await page.getByText(/^Browser Control$/).waitFor({ timeout: 10000 })
  if (!(await page.getByRole("button", { name: "Add Connector" }).first().isVisible()))
    throw new Error("Add Connector button should be in the MCP tab toolbar")
  await page.screenshot({ path: join(SHOTS, "connectors-mcp-real.png") })
  checks.push("header Refresh + MCP/Office CLI tabs; MCP default active with Browser Control + Add Connector ✓")

  console.log("=== 2. open MCP add-server form (moved into MCP tab) and type a name ===")
  await page.getByRole("button", { name: "Add Connector" }).first().click()
  await page.getByRole("menuitem", { name: "Manual" }).click()
  const nameInput = page.getByPlaceholder("Connector name")
  await nameInput.waitFor({ timeout: 5000 })
  await nameInput.fill("roundtrip-check")
  if ((await nameInput.inputValue()) !== "roundtrip-check") throw new Error("name field did not accept input")
  checks.push("MCP add-server dropdown opens in the MCP tab; manual form accepts input ✓")

  console.log("=== 3. switch to Office CLI tab: three cards render; MCP panel is HIDDEN (not just unmounted) ===")
  await cliTab.click()
  await page.getByText(/Feishu \/ Lark|飞书 \/ Lark/).first().waitFor({ timeout: 10000 })
  // Active-tab state must track the content (Radix data-state on the triggers)
  if ((await cliTab.getAttribute("data-state")) !== "active") throw new Error("Office CLI tab trigger should be active after click")
  if ((await mcpTab.getAttribute("data-state")) !== "inactive") throw new Error("MCP tab trigger should be inactive on the CLI tab")
  await page.getByText(/DingTalk|钉钉/).first().waitFor({ timeout: 5000 })
  await page.getByText(/WeCom|企业微信/).first().waitFor({ timeout: 5000 })
  // forceMount keeps the MCP panel mounted, but it must be display:none while inactive
  if (await nameInput.isVisible()) throw new Error("MCP add form must be visually hidden on the Office CLI tab")
  if (await page.getByText(/^Browser Control$/).isVisible()) throw new Error("MCP Browser Control must be hidden on the Office CLI tab")
  await page.screenshot({ path: join(SHOTS, "connectors-cli-real.png") })
  checks.push("Office CLI tab renders 3 connector cards; MCP panel hidden (display:none) while inactive ✓")

  console.log("=== 4. switch back to MCP tab: the half-typed name SURVIVES (forceMount keep-alive) ===")
  await mcpTab.click()
  if ((await mcpTab.getAttribute("data-state")) !== "active") throw new Error("MCP tab trigger should be active after switching back")
  await nameInput.waitFor({ state: "visible", timeout: 5000 })
  const preserved = await nameInput.inputValue()
  if (preserved !== "roundtrip-check")
    throw new Error(`forceMount regression: add-form input reset across tab round-trip (got "${preserved}")`)
  checks.push("tab round-trip (MCP→Office CLI→MCP) preserves the half-typed add-form value ✓")

  console.log("=== 5. global Refresh works from the header ===")
  const refreshBtn = page.getByRole("button", { name: /^Refresh$/ })
  await refreshBtn.click()
  await page.waitForTimeout(1500)
  await refreshBtn.waitFor({ timeout: 5000 }) // still present, re-enabled — no crash
  checks.push("global header Refresh executes without crashing ✓")

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 160)})`)
  verdict = "PASS ✅ — real React UI: Connectors tabs header + MCP tab add-form + forceMount round-trip keep-alive + MCP-hidden-on-CLI-tab + global refresh."
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
