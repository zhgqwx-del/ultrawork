// settings-collapse-return.e2e.ts — browser walkthrough proving the Settings-page
// UX contract on the REAL app (Chrome + Vite + real opencode):
//   1. Entering /settings auto-collapses the left sidebar (route-derived).
//   2. The sidebar collapse toggle is hidden/locked while in Settings.
//   3. Closing Settings returns to the page you came FROM (Home, a session, …),
//      not a hardcoded "/".
//   4. The edge that a naive navigate(-1) would fail: a second in-settings
//      navigate (SettingsPopover → About) still returns to the origin.
//   5. A manual collapse preference survives a Settings round-trip (effectiveOpen
//      is pure-derived, never writes leftOpen).
//
// Run:  cd packages/client/desktop && bun run --bun e2e:settings-collapse   # exit 0 = PASS
// Needs: system Chrome (playwright-core channel:"chrome") + built opencode binary.
import { chromium, type Browser, type Page } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "settings-collapse-pw"; const LLM = 8091; const OC = 4096

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "settings-collapse-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

// --- selectors / helpers -------------------------------------------------
const asideWidth = async (page: Page) => (await page.locator("aside").first().boundingBox())?.width ?? 0
const EXPANDED = 200 // w-72 == 288px
const COLLAPSED = 120 // w-[68px] == 68px

async function openSettingsGeneral(page: Page) {
  // Avatar button: "User settings" when expanded, "Settings" when collapsed.
  const avatar = page.getByRole("button", { name: "User settings" }).or(page.getByRole("button", { name: "Settings" })).first()
  await avatar.click()
  await page.getByRole("menuitem", { name: /General Settings|通用设置/ }).click()
  await page.waitForURL(/\/settings(\?|$)/, { timeout: 8000 })
  await page.waitForTimeout(600) // let the 300ms width transition settle
}
async function closeSettings(page: Page) {
  await page.getByRole("button", { name: "Close" }).first().click()
  await page.waitForTimeout(600)
}

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== start mock-llm + opencode + vite ===")
  spawn([BUN, "run", join(DIR, "mock-llm-todowrite.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  for (let i = 0; ; i++) {
    try { await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3000)

  // --- A: Home starts expanded, entering Settings collapses + hides toggle, close returns Home ---
  console.log("=== A: Home → Settings → close ===")
  const wHome = await asideWidth(page)
  if (wHome < EXPANDED) throw new Error(`expected expanded sidebar on Home, got width=${wHome}`)
  checks.push(`sidebar expanded on Home (w=${Math.round(wHome)}) ✓`)

  await openSettingsGeneral(page)
  const wSettings = await asideWidth(page)
  if (wSettings > COLLAPSED) throw new Error(`expected collapsed sidebar in Settings, got width=${wSettings}`)
  checks.push(`sidebar auto-collapsed on entering Settings (w=${Math.round(wSettings)}) ✓`)

  const toggleCount = await page.getByRole("button", { name: "Toggle sidebar" }).count()
  if (toggleCount !== 0) throw new Error(`sidebar toggle should be hidden in Settings, found ${toggleCount}`)
  checks.push("sidebar collapse toggle hidden in Settings ✓")

  await closeSettings(page)
  if (new URL(page.url()).pathname !== "/") throw new Error(`expected return to Home '/', got ${page.url()}`)
  const wBack = await asideWidth(page)
  if (wBack < EXPANDED) throw new Error(`expected sidebar restored expanded after Home return, got width=${wBack}`)
  checks.push(`closed Settings → back on Home + sidebar restored expanded (w=${Math.round(wBack)}) ✓`)

  // --- B: create a REAL session, enter Settings from it, close returns to THAT session ---
  console.log("=== B: create session → Settings → close returns to the session ===")
  await page.locator("textarea").first().fill("hello")
  await page.getByRole("button", { name: /马上开始|Start Now|开始|send/i }).first().click()
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  const sid = new URL(page.url()).pathname.split("/session/")[1]
  await page.waitForTimeout(800)

  await openSettingsGeneral(page)
  const wSessSettings = await asideWidth(page)
  if (wSessSettings > COLLAPSED) throw new Error(`expected collapsed sidebar in Settings (from session), got width=${wSessSettings}`)

  await closeSettings(page)
  const backPath = new URL(page.url()).pathname
  if (backPath !== `/session/${sid}`) throw new Error(`expected return to /session/${sid}, got ${backPath}`)
  checks.push("closing Settings returns to the originating session (not hardcoded '/') ✓")

  // --- C: the navigate(-1) trap — a 2nd in-settings navigate (About) must still return to origin ---
  console.log("=== C: About re-push edge ===")
  await openSettingsGeneral(page) // now in /settings, from the session
  // Open the avatar popover (collapsed → aria-label "Settings") and pick About,
  // which fires navigate("/settings",{state:{section:'about'}}) — a 2nd push.
  await page.getByRole("button", { name: "Settings" }).first().click()
  await page.getByRole("menuitem", { name: /^About$|^关于$/ }).click()
  await page.waitForTimeout(400)
  if (new URL(page.url()).pathname !== "/settings") throw new Error(`About should keep us on /settings, got ${page.url()}`)
  await closeSettings(page)
  const afterAbout = new URL(page.url()).pathname
  if (afterAbout !== `/session/${sid}`) throw new Error(`after About re-push, expected /session/${sid}, got ${afterAbout} (a naive navigate(-1) would fail here)`)
  checks.push("second in-settings navigate (About) still returns to the session, not stuck on /settings ✓")

  // --- D: manual collapse preference survives a Settings round-trip ---
  console.log("=== D: manual collapse preference preserved ===")
  await page.getByRole("button", { name: /UltraWork/ }).first().click() // brand → Home
  await page.waitForURL("http://localhost:1420/", { timeout: 8000 })
  await page.waitForTimeout(600)
  await page.getByRole("button", { name: "Toggle sidebar" }).click() // manual collapse on Home
  await page.waitForTimeout(600)
  const wManual = await asideWidth(page)
  if (wManual > COLLAPSED) throw new Error(`manual collapse on Home failed, width=${wManual}`)

  await openSettingsGeneral(page)
  await closeSettings(page)
  if (new URL(page.url()).pathname !== "/") throw new Error(`expected Home after round-trip, got ${page.url()}`)
  const wPref = await asideWidth(page)
  if (wPref > COLLAPSED) throw new Error(`manual-collapsed preference NOT preserved — sidebar re-expanded (w=${wPref})`)
  checks.push(`manual-collapsed preference preserved through a Settings round-trip (w=${Math.round(wPref)}) ✓`)

  verdict = "PASS ✅ — Settings auto-collapses the sidebar, locks the toggle, and returns to the exact page it was opened from (Home / a real session), including the About re-push edge; manual collapse preference is never polluted."
} catch (e) { verdict = `FAIL ❌ — ${(e as Error).message}` }
finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
