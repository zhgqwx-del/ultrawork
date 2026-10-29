/** Positive brand UI proof using real Vite/React and Chrome or WebKit.
 * Native IPC and the loopback HTTP backend are deterministic fixtures. No
 * native app, external model, account, or existing user data is used.
 * Run: bun run --bun packages/client/desktop/e2e/brand-ready.e2e.ts
 * E2E_ENGINE=webkit selects the installed Playwright WebKit engine.
 */
import assert from "node:assert/strict"
import { chromium, webkit, type Browser, type Locator } from "playwright-core"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "@agent/brand"
import { en, zhHans } from "../src/lib/i18n-translations"
import { zhHant } from "../src/lib/i18n-zh-hant.generated"

const desktop = resolve(import.meta.dir, "..")
const repo = resolve(desktop, "../../..")
const output = resolve(process.env.E2E_OUTPUT ?? join(repo, ".brand-build", "verification", "browser-brand-ready"))
mkdirSync(output, { recursive: true })
const engine = process.env.E2E_ENGINE ?? "chrome"
assert(engine === "chrome" || engine === "webkit", "E2E_ENGINE must be chrome or webkit")
const myworkDirectory = join(repo, "branding", "mywork")
const myworkConfig = JSON.parse(readFileSync(join(myworkDirectory, "brand.json"), "utf8"))
const MYWORK = resolveIdentity({ brandId: myworkConfig.brandId, productName: myworkConfig.productName })
const myworkLogo = resolve(myworkDirectory, myworkConfig.uiLogo ?? myworkConfig.icon)
const expectedLogo = `data:image/png;base64,${readFileSync(myworkLogo).toString("base64")}`
const LOCALES = [
  { language: "en", locale: "en-US", words: en },
  { language: "zh-Hans", locale: "zh-CN", words: zhHans },
  { language: "zh-Hant", locale: "zh-TW", words: zhHant },
]
const sandbox = mkdtempSync(join(tmpdir(), "ultrawork-brand-ready-"))
const home = join(sandbox, "home")
const workspace = join(sandbox, "workspace 客户")
for (const directory of [home, workspace]) mkdirSync(directory, { recursive: true })
const childEnv = Object.fromEntries(Object.entries({
  ...process.env, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
}).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
const auth = `Basic ${Buffer.from("fixture:brand-ready-only").toString("base64")}`
const unexpectedHttp: string[] = []
const requests: { method: string; path: string }[] = []
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,OPTIONS" }
// A single deterministic fixture provides all backend route families. This is
// UI acceptance, not an assertion about native sidecar/port isolation.
const backend = Bun.serve({
  hostname: "127.0.0.1", port: 0, idleTimeout: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    requests.push({ method: request.method, path: pathname })
    const fail = (message: string) => { unexpectedHttp.push(message); return Response.json({ error: message }, { status: 500, headers: cors }) }
    if (request.method !== "GET") return fail(`${request.method} ${pathname}`)
    if (request.headers.get("authorization") !== auth) return fail(`Missing fixture auth: ${pathname}`)
    if (["/event", "/acp/global/events", "/orchestration/delegates/events"].includes(pathname)) {
      const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"type":"heartbeat","properties":{}}\n\n')) } })
      return new Response(stream, { headers: { ...cors, "content-type": "text/event-stream" } })
    }
    const responses: Record<string, unknown> = {
      "/global/health": { healthy: true }, "/acp/health": { status: "ok" },
      "/config": {}, "/global/config": {}, "/mcp": {}, "/session/status": {},
      "/provider": { all: [], connected: [], default: {} },
      "/session": [], "/permission": [], "/question": [], "/skill": [], "/command": [], "/agent": [],
      "/acp/agents": [], "/acp/sessions": [],
      "/orchestration/team/sessions": { sessions: [] }, "/channel/sessions": { sessions: [] },
      "/orchestration/runs": { runs: [] }, "/orchestration/delegates": { delegates: [] },
    }
    return Object.hasOwn(responses, pathname) ? Response.json(responses[pathname], { headers: cors }) : fail(`Unknown fixture route: ${pathname}`)
  },
})
const backendPort = backend.port!
const backendOrigin = `http://127.0.0.1:${backendPort}`
const reports: { brand: string; locale: string; checks: string[] }[] = []
let browser: Browser | undefined
let activeVite: ReturnType<typeof Bun.spawn> | undefined

async function stopVite() {
  const child = activeVite
  if (!child) return
  activeVite = undefined
  child.kill()
  if (!await Promise.race([child.exited.then(() => true), Bun.sleep(3_000).then(() => false)])) {
    // Only this directly spawned Bun process is eligible for escalation. Vite
    // can otherwise wait indefinitely for a WebKit SSE proxy to close.
    child.kill("SIGKILL")
    await child.exited
  }
}

async function assertLogo(container: Locator, brand: BrandIdentity) {
  const logo = container.locator(":scope > svg")
  assert.equal(await logo.count(), 1, "The specific brand entry must contain its own logo")
  assert(await logo.isVisible(), "Brand logo must be visible")
  const images = logo.locator("image")
  if (brand.isDefault) {
    assert.equal(await images.count(), 0, "Default prism must remain the default logo")
    assert((await logo.locator("polygon").count()) >= 3, "Default prism faces must exist")
  }
  else {
    assert.equal(await images.count(), 1, "MyWork entry must contain its own image")
    assert.equal(await images.getAttribute("href"), expectedLogo)
  }
}

async function runBrand(brand: BrandIdentity) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const port = probe.port!
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  activeVite = Bun.spawn([process.execPath, "run", "--bun", join(desktop, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: desktop, stdout: "ignore", stderr: "inherit",
    env: { ...childEnv, ULTRAWORK_BRAND_JSON: JSON.stringify(brand), ULTRAWORK_BRAND_UI_LOGO: brand.isDefault ? "" : myworkLogo,
      E2E_OPENCODE_PORT: String(backendPort), E2E_GATEWAY_PORT: String(backendPort), E2E_KNOWLEDGE_PORT: String(backendPort) },
  })
  let serving = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { serving = true; break } } catch {}
    if (activeVite.exitCode !== null) throw new Error(`Vite exited: ${activeVite.exitCode}`)
    await Bun.sleep(100)
  }
  assert(serving, "Vite did not start")
  for (const { language, locale, words } of LOCALES) {
    const page = await browser!.newPage({ locale, viewport: { width: 1200, height: 900 } })
    const errors: string[] = [], unknownCommands: string[] = [], externalRequests: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
    page.on("request", (request) => {
      const url = new URL(request.url())
      if (url.protocol.startsWith("http") && ![origin, backendOrigin, `http://localhost:${backendPort}`].includes(url.origin)) externalRequests.push(request.url())
    })
    // Chrome requests a browser-tab favicon, which the native WebView does not
    // use. Keep this browser-only request out of the application's API fixture.
    await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }))
    await page.addInitScript(({ brand, port, api, workspace, language }) => {
      const w = window as any
      w.__brandReadyCommands = []
      w.__brandReadyUnknownCommands = []
      const handlers: Record<string, () => unknown> = {
        get_startup_status: () => ({ state: "ready", brand }), get_boot_status: () => "ready",
        get_sidecar_ports: () => ({ opencode: port, gateway: port, knowledge: port, acp: port }),
        get_sidecar_credentials: () => ({ username: "fixture", password: "brand-ready-only" }),
        check_directory_exists: () => true, ensure_default_workspace: () => workspace, login_shell_path: () => "",
        refresh_builtin_skills: () => ({ bundled: [], shadowed: [], changed: false }), get_free_trial_consent: () => false,
        scan_workspace_changes: () => [], check_cli_connectors: () => [], check_skill_dependencies: () => [],
        screenshot_capability: () => ({ available: true }),
        set_tray_labels: () => null, "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null,
      }
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
      // Deliberately no __ULTRAWORK_BROWSER_TEST__: the real Ready gate validates
      // identity, credentials and port IPC before mounting business providers.
      w.__TAURI_INTERNALS__ = { invoke: async (command: string) => {
        w.__brandReadyCommands.push(command)
        if (handlers[command]) return handlers[command]()
        w.__brandReadyUnknownCommands.push(command)
        throw new Error(`Unknown Ready IPC fixture: ${command}`)
      }, transformCallback: (callback: unknown) => callback, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: api, apiUsername: "fixture", apiPassword: "brand-ready-only", language }))
      localStorage.setItem("workspace_path", workspace)
    }, { brand, port: backendPort, api: backendOrigin, workspace, language })
    const checks: string[] = []
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { name: words["home.headline"], exact: true }).waitFor({ timeout: 20_000 })
      assert.equal(await page.title(), brand.productName)
      const displayedName = brand.isDefault ? words["brand.name"] : brand.productName
      const homeBrandEntry = page.locator("aside button").filter({ hasText: displayedName })
      assert.equal(await homeBrandEntry.count(), 1)
      await assertLogo(homeBrandEntry, brand)
      checks.push("Ready gate mounts localized Home with the expected document title and logo")
      const composer = page.getByRole("textbox")
      const draft = `${brand.productName} ${locale} draft`
      await composer.fill(draft)
      await page.getByRole("button", { name: words["home.mode.team"], exact: true }).click()
      assert.equal(await composer.getAttribute("placeholder"), words["team.inputPlaceholder"])
      assert.equal(await composer.inputValue(), draft)
      await page.getByRole("button", { name: words["home.mode.single"], exact: true }).click()
      assert.equal(await composer.getAttribute("placeholder"), words["placeholder.askAnything"])
      assert.equal(await composer.inputValue(), draft)
      checks.push("Solo/Team controls switch without sending a prompt or losing composer text")
      await page.screenshot({ path: join(output, `${brand.brandId}-${locale}-home.png`) })
      await page.getByRole("button", { name: /^(User settings|Settings)$/ }).click()
      await page.getByRole("menuitem", { name: words["settingsPopover.about"], exact: true }).click()
      await page.getByRole("heading", { name: words["settingsPage.about"], exact: true }).waitFor()
      assert.equal(await page.title(), brand.productName)
      const aboutName = page.getByText(displayedName, { exact: true })
      assert.equal(await aboutName.count(), 1)
      // Name and subtitle share a wrapper; its parent is the specific About
      // brand group. The collapsed sidebar cannot satisfy this logo assertion.
      await assertLogo(aboutName.locator("..").locator(".."), brand)
      checks.push("Settings popover opens localized About with the expected name, logo and title")
      await page.screenshot({ path: join(output, `${brand.brandId}-${locale}-about.png`) })
      await page.getByRole("button", { name: "Back", exact: true }).click()
      await composer.waitFor()
      assert.equal(await composer.inputValue(), draft)
      checks.push("Returning from About preserves the Home draft")
      const commands = await page.evaluate(() => (window as any).__brandReadyCommands as string[])
      unknownCommands.push(...await page.evaluate(() => (window as any).__brandReadyUnknownCommands as string[]))
      assert(commands.includes("get_startup_status") && commands.includes("get_sidecar_ports"))
      assert(commands.indexOf("get_startup_status") < commands.indexOf("get_sidecar_ports"))
      assert(commands.indexOf("get_startup_status") < commands.indexOf("get_sidecar_credentials"))
      assert(commands.includes("get_sidecar_credentials") && (commands.includes("ensure_default_workspace") || commands.includes("check_directory_exists")))
      assert.deepEqual(unknownCommands, [])
      assert.deepEqual(externalRequests, [])
      assert.deepEqual(errors, [])
      assert.deepEqual(unexpectedHttp, [])
      checks.push("Startup ordering is valid; no unknown IPC, external requests, HTTP writes or browser errors")
      reports.push({ brand: brand.brandId, locale, checks })
      console.log(`PASS ${brand.productName}/${locale}: ${checks.length} Ready UI checks`)
    } catch (error) {
      await page.screenshot({ path: join(output, `FAIL-${brand.brandId}-${locale}.png`) }).catch(() => {})
      console.error({ errors, unknownCommands, externalRequests, unexpectedHttp, requests })
      throw error
    } finally { await page.close() }
  }
  await stopVite()
}

try {
  if (engine === "webkit") browser = await webkit.launch({ headless: true, timeout: 30_000, env: childEnv })
  else {
    const candidates = [process.env.CHROME_PATH, chromium.executablePath(),
      ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
      ...(process.platform === "win32" ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")] : []),
      ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : []),
    ].filter((file): file is string => !!file && existsSync(file))
    assert(candidates.length, "Install Chrome or set CHROME_PATH")
    browser = await chromium.launch({ executablePath: candidates[0], headless: true, timeout: 30_000, env: childEnv })
  }
  console.log(`Browser: ${engine} ${browser.version()}`)
  for (const brand of [DEFAULT_BRAND, MYWORK]) await runBrand(brand)
  const report = { engine, browser: browser.version(), platform: process.platform, generatedAt: new Date().toISOString(),
    passedFlows: reports.length, passedChecks: reports.reduce((total, item) => total + item.checks.length, 0), flows: reports,
    fixtureRequests: requests, unexpectedHttp,
    limits: ["Real browser/Vite/React; native IPC and HTTP backends are fixtures", "No native WebView, installer, real model or account exercised", "Solo/Team UI switches only; no chat prompt dispatched"] }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
  console.log(`PASS ${report.passedFlows} Ready UI flows / ${report.passedChecks} checks; report/screenshots: ${output}`)
} finally {
  try { await browser?.close() }
  finally {
    try { await stopVite() }
    finally {
      try { backend.stop(true) }
      finally { rmSync(sandbox, { recursive: true, force: true }) }
    }
  }
}
