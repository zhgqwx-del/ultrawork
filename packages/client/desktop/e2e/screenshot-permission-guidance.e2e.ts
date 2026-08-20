// screenshot-permission-guidance.e2e.ts — real-browser proof that the macOS Screen
// Recording guidance has a reachable EXIT, not just a restart hint.
//
// Why this exists: a TCC approval recorded under a different code signature (the
// pre-v0.3.3 unsigned releases, any local `--unsigned` bundle) leaves a row this
// binary can never satisfy — tccd refuses while the System Settings switch still
// reads ON, and re-toggling never rewrites the stored requirement. The ONLY way out
// is deleting the row, and this guidance toast is the ONLY place the product says so.
// Nothing can automate the TCC behaviour itself, so what CAN be automated is that the
// sentence and its shortcut actually reach the screen and actually fire.
//
// What only a real browser proves (the unit test asserts the options OBJECT, which
// stays green even if sonner never renders a `description`):
//   1. the needs_permission toast renders with a working 「去授权 / Grant」 action,
//   2. clicking it calls request_screen_capture_access AND renders a follow-up whose
//      DESCRIPTION line is the stale-approval escape hatch (rendered text, not props),
//   3. the follow-up's action really invokes `open_screen_recording_settings` — i.e.
//      the shortcut is wired end to end, through the Tauri bridge,
//   4. no console errors along the way.
//
// ⚠️ Clicks go through `locator.dispatchEvent("click")`, NOT Playwright's trusted
// input. On this machine (playwright-core 1.61.1 + system Chrome 151) trusted mouse
// AND keyboard events do not reach the app page at all — measured, not guessed: a
// data: URL page in the SAME browser and SAME context receives clicks fine, while the
// app page logs zero pointer/key events from document-level capture listeners
// installed both before and after load. The existing walkthroughs fail the same way
// (general-i18n-toggle times out on its first click), so this predates and outlives
// this file. Consequence to be honest about: this proves rendering, handler wiring and
// the bridge call — it does NOT prove hit-testing, z-order, or that nothing invisible
// covers the button. That part still needs a human on a real build.
//
// Backend: opencode is REAL (the app refuses to boot without one). Tauri is shimmed;
// capture_screenshot is pinned to needs_permission because the real one cannot be
// forced into that state from a test. Ports are deliberately NOT 4096/4197-4199: a
// developer's own app is usually holding those, and borrowing them would make this
// run against their live sidecar.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/screenshot-permission-guidance.e2e.ts
// Needs: system Chrome + built opencode sidecar + ports 1420/4296 free.
// Exit 0 = PASS, 1 = FAIL.  Screenshots land in $E2E_SHOTS (default: tmpdir).
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "shot-perm-pw"
const OC = 4296 // NOT 4096: the developer's real app is usually on that one
const SHOTS = process.env.E2E_SHOTS ?? tmpdir()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) {
        console.log(`[ready] ${label}`)
        return
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout ${label}`)
}

// Fail closed on a busy Vite port: a leftover `tauri dev` would let this whole run
// happen against somebody else's code and still print PASS (gotchas §6).
async function assertPortFree(port: number) {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) })
    if (r.ok) throw new Error(`port ${port} is already serving — quit the other instance first`)
  } catch (e) {
    if (e instanceof Error && e.message.includes("already serving")) throw e
  }
}

const tmp = mkdtempSync(join(tmpdir(), "shot-perm-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
const ok = (label: string, pass: boolean, detail = "") => {
  checks.push(`${pass ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!pass) verdict = "FAIL"
}

try {
  await assertPortFree(1420)
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", String(OC)], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  await poll("opencode", async () =>
    (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok,
  )
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text())
  })

  await page.addInitScript(
    ({ ws, pw, oc }) => {
      const calls: { cmd: string; arg: unknown }[] = []
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => [],
        get_sidecar_ports: () => ({ opencode: oc, gateway: oc + 1, knowledge: oc + 2, acp: oc + 3 }),
        get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
        // The button must be enabled, and the capture must land in the one state a
        // test can't produce for real.
        screenshot_capability: () => ({ available: true }),
        capture_screenshot: () => ({ outcome: "needs_permission" }),
        // Mirrors the real command: returns false because the grant is async and only
        // takes effect after a restart.
        request_screen_capture_access: () => false,
        // The settings shortcut goes through our own Rust command, not the opener
        // plugin — see the note in use-screenshot.ts about the plugin's webview scope.
        open_screen_recording_settings: () => null,
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = {
        invoke: async (c: string, a: any) => {
          calls.push({ cmd: c, arg: a })
          return handlers[c] ? handlers[c](a) : null
        },
        transformCallback: (cb: any) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      }
      // @ts-ignore — assertions read the call log out of the page
      window.__calls = calls
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }),
      )
      localStorage.setItem("workspace_path", ws)
    },
    { ws, pw: PW, oc: OC },
  )

  for (let i = 0; ; i++) {
    try {
      await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
      break
    } catch (e) {
      if (i >= 4) throw e
      await page.waitForTimeout(2000)
    }
  }
  await page.waitForTimeout(3000)

  // The button carries aria-label t("screenshot.button"); accept either language so a
  // locale default flip doesn't turn this into a silent skip.
  const shotBtn = page.locator('button[aria-label="截图"], button[aria-label="Screenshot"]').first()
  await shotBtn.waitFor({ state: "visible", timeout: 15000 })
  ok("screenshot button is present and enabled", await shotBtn.isEnabled())

  console.log("=== 1. needs_permission toast ===")
  await shotBtn.dispatchEvent("click")
  // Wait for a TOAST, not the toaster: the <ol> is always in the DOM and is only
  // non-empty (hence "visible") once something lands in it.
  const toaster = page.locator("[data-sonner-toaster]")
  await page.locator("[data-sonner-toast]").first().waitFor({ state: "visible", timeout: 10000 })
  await page.waitForTimeout(600)
  const firstToast = (await toaster.innerText()).replace(/\s+/g, " ")
  ok(
    "toast states the permission is missing",
    /屏幕录制|Screen Recording/.test(firstToast),
    firstToast.slice(0, 80),
  )

  const grantBtn = toaster.locator("button", { hasText: /去授权|^Grant$/ }).first()
  ok("toast offers the grant action", (await grantBtn.count()) > 0)

  console.log("=== 2. follow-up carries the escape hatch ===")
  await grantBtn.dispatchEvent("click")
  await page.waitForTimeout(1200)
  const followUp = (await toaster.innerText()).replace(/\s+/g, " ")

  const requested = await page.evaluate(() =>
    // @ts-ignore
    (window.__calls as { cmd: string }[]).some((c) => c.cmd === "request_screen_capture_access"),
  )
  ok("grant action invokes request_screen_capture_access", requested)
  ok(
    "follow-up tells the user to turn the switch ON (not just 'restart')",
    /系统设置|System Settings/.test(followUp),
    followUp.slice(0, 120),
  )
  // The load-bearing one: without this sentence a stale approval is a dead end.
  ok(
    "follow-up RENDERS the stale-approval escape hatch (− / remove)",
    /移除|Remove/.test(followUp) && /−|-/.test(followUp),
    followUp.slice(0, 200),
  )
  await page.screenshot({ path: join(SHOTS, "screenshot-permission-guidance.png") })

  console.log("=== 3. the settings shortcut is wired ===")
  const settingsBtn = toaster.locator("button", { hasText: /打开设置|Open Settings/ }).first()
  ok("follow-up offers the settings shortcut", (await settingsBtn.count()) > 0)
  if ((await settingsBtn.count()) > 0) {
    await settingsBtn.dispatchEvent("click")
    await page.waitForTimeout(800)
    const opened = await page.evaluate(() => {
      // @ts-ignore
      const calls = window.__calls as { cmd: string }[]
      return calls.some((c) => c.cmd === "open_screen_recording_settings")
    })
    ok("settings shortcut invokes the Rust settings command", opened)
  }

  // This harness starts opencode ONLY, and stubs the Tauri side: the app's probes of
  // gateway/knowledge/acp are refused and some early opencode calls race the credential
  // load and come back 401. That transport noise is the harness's own doing. Everything
  // else — React errors, uncaught exceptions, anything thrown inside the flow under
  // test — still fails this run, so the check is narrowed, not dropped.
  const harnessNoise = (e: string) =>
    e.startsWith("Failed to load resource") || e.startsWith("SSE error: TypeError: Failed to fetch")
  const realErrors = errors.filter((e) => !harnessNoise(e))
  ok("no console errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "))
  if (verdict !== "FAIL") verdict = "PASS"
} catch (e) {
  verdict = "FAIL"
  checks.push(`FAIL  harness — ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser?.close().catch(() => {})
  for (const p of procs) {
    try {
      p.kill()
    } catch {}
  }
  console.log("\n=== RESULT ===")
  for (const c of checks) console.log(c)
  console.log(`\nVERDICT: ${verdict}`)
  console.log(`shots: ${SHOTS}`)
  process.exit(verdict === "PASS" ? 0 : 1)
}
