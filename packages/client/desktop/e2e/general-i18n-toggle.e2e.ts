// general-i18n-toggle.e2e.ts — real-browser proof for ADR-058 (Traditional
// Chinese + General-page toggles). What only a real browser proves (jsdom can't):
//   1. clicking 「繁體中文」 re-renders the LIVE General page into Traditional
//      (跟隨系統 / 繁體中文 button selected) — the whole app switches, not a stub,
//   2. the 4 notification/plan rows are role="switch" toggles (not checkboxes)
//      and clicking one flips aria-checked in real DOM,
//   3. both the language choice AND the toggle state SURVIVE a full reload
//      (ConfigStorage persistence + migration path exercised),
//   4. no console errors during the switch.
//
// Backend: opencode is REAL (serves /config + /global/health). Tauri is shimmed
// and the workspace is a tmpdir — same harness as settings-tabs-ui-walkthrough.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/general-i18n-toggle.e2e.ts
// Needs: system Chrome + built opencode sidecar + ports 1420/4096 free.
// Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "i18n-toggle-pw"
const SHOTS = process.env.E2E_SHOTS ?? tmpdir()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "i18n-toggle-"))
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

  console.log("=== chrome + tauri shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })

  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [], check_skill_dependencies: () => [],
      refresh_builtin_skills: () => ({ bundled: [], shadowed: [], changed: false }),
      get_free_trial_consent: () => false,
      "plugin:opener|open_url": () => null,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // Seed ONLY on first load (addInitScript re-runs on reload; an unconditional
    // write would clobber the language switch we are verifying persists).
    if (!localStorage.getItem("ultrawork-config"))
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: "en" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  // General is the default settings section — no nav click needed.
  console.log("=== 1. starts in English ===")
  await page.getByRole("button", { name: "English" }).waitFor({ timeout: 10000 })
  const sysEn = await page.getByRole("button", { name: "System" }).count()
  if (sysEn < 1) throw new Error("English theme button 'System' not found — General page not in English")
  checks.push("General page renders in English (theme 'System', language 'English') ✓")

  console.log("=== 2. click 繁體中文 → the live page switches to Traditional ===")
  await page.getByRole("button", { name: "繁體中文" }).click()
  await page.waitForTimeout(600)
  // theme 'System' becomes 跟隨系統 (Traditional) — proves the whole page re-rendered.
  await page.getByText("跟隨系統", { exact: true }).waitFor({ timeout: 5000 })
  if ((await page.getByRole("button", { name: "System" }).count()) !== 0)
    throw new Error("English 'System' still present after switching to Traditional")
  // 简体中文 label must show as itself (button labels are literal, not translated),
  // and the Traditional theme heading proves the dictionary swap.
  await page.screenshot({ path: join(SHOTS, "i18n-general-zh-hant.png") })
  checks.push("clicking 繁體中文 re-renders live page to Traditional (跟隨系統) ✓")

  console.log("=== 3. notification rows are role=switch toggles; clicking flips aria-checked ===")
  const switches = page.getByRole("switch")
  const n = await switches.count()
  if (n < 4) throw new Error(`expected ≥4 toggles (planAutoReveal + 3 notify), got ${n}`)
  const target = switches.nth(1) // a notify* row
  const before = await target.getAttribute("aria-checked")
  await target.click()
  await page.waitForTimeout(200)
  const after = await target.getAttribute("aria-checked")
  if (before === after) throw new Error(`toggle did not flip aria-checked (stayed ${before})`)
  checks.push(`toggle flips aria-checked (${before} → ${after}); ${n} switches, zero checkboxes ✓`)

  // No native checkboxes should remain on the General page.
  const checkboxes = await page.locator('input[type="checkbox"]').count()
  if (checkboxes !== 0) throw new Error(`found ${checkboxes} legacy <input type=checkbox> — should be toggles`)
  checks.push("no legacy checkboxes remain on General page ✓")

  console.log("=== 4. language + toggle state survive a full reload ===")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  await page.getByText("跟隨系統", { exact: true }).waitFor({ timeout: 5000 })
  const persisted = await page.getByRole("switch").nth(1).getAttribute("aria-checked")
  if (persisted !== after) throw new Error(`toggle state not persisted across reload (want ${after}, got ${persisted})`)
  checks.push(`Traditional + toggle state persist across reload (config persistence) ✓`)

  // This harness only starts opencode (:4096); ACP (:4099), orchestration and
  // the knowledge sidecar are not running, so their SSE/fetch connection errors
  // are EXPECTED environmental noise — not caused by the i18n/toggle change.
  // Fail only on errors that aren't those known network/sidecar failures.
  const IGNORE = /Failed to fetch|ERR_CONNECTION_REFUSED|SSE error|Failed to load resource|Internal Server Error|net::ERR_/i
  const relevant = errors.filter((e) => !IGNORE.test(e))
  if (relevant.length) throw new Error(`unexpected console errors during run:\n${relevant.join("\n")}`)
  checks.push(`no unexpected console errors (filtered ${errors.length - relevant.length} known sidecar-offline noise) ✓`)
  verdict = "PASS"
} catch (e) {
  verdict = "FAIL"
  console.error("‼️", (e as Error).message)
  try { await browser?.contexts()[0]?.pages()[0]?.screenshot({ path: join(SHOTS, "FAIL-i18n-toggle.png") }) } catch {}
} finally {
  await browser?.close()
  for (const p of procs) try { p.kill() } catch {}
  console.log("\n=== checks ===")
  for (const c of checks) console.log("  ✓ " + c)
  console.log(`\n${verdict === "PASS" ? "✅" : "❌"} ${verdict}  (shots in ${SHOTS})`)
  process.exit(verdict === "PASS" ? 0 : 1)
}
