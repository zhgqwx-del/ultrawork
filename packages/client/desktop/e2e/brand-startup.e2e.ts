/** Real Vite/React startup against deliberately blocked native bridges.
 * No real account, workspace, home data, clipboard, or sidecar is used.
 * Run from any cwd: bun run --bun packages/client/desktop/e2e/brand-startup.e2e.ts
 */
import assert from "node:assert/strict"
import { chromium, webkit, type Browser, type Page } from "playwright-core"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "@agent/brand"

const desktop = resolve(import.meta.dir, "..")
const repo = resolve(desktop, "../../..")
const output = resolve(process.env.E2E_OUTPUT ?? join(repo, ".brand-build", "verification", "browser-brand-startup"))
mkdirSync(output, { recursive: true })
const engine = process.env.E2E_ENGINE ?? "chrome"
assert(engine === "chrome" || engine === "webkit", "E2E_ENGINE must be chrome or webkit")
const myworkDirectory = join(repo, "branding", "mywork")
const myworkConfig = JSON.parse(readFileSync(join(myworkDirectory, "brand.json"), "utf8"))
const MYWORK = resolveIdentity({ brandId: myworkConfig.brandId, productName: myworkConfig.productName })
const myworkLogo = resolve(myworkDirectory, myworkConfig.uiLogo ?? myworkConfig.icon)
assert(existsSync(myworkLogo), "MyWork preset UI logo must exist")
const foreign = resolveIdentity({ brandId: "otherwork", productName: "OtherWork" })
const candidates = [
  process.env.CHROME_PATH,
  chromium.executablePath(),
  ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
  ...(process.platform === "win32" ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe")] : []),
  ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : []),
].filter((file): file is string => !!file && existsSync(file))
const LOCALES = [
  { locale: "en-US", title: "Unable to start", copy: "Copy diagnostics", copied: "Copied", retry: "Check again", exit: "Quit" },
  { locale: "zh-CN", title: "无法启动", copy: "复制诊断", copied: "已复制", retry: "重新检查", exit: "退出" },
  { locale: "zh-TW", title: "無法啟動", copy: "複製診斷", copied: "已複製", retry: "重新檢查", exit: "退出" },
]
const ready = (brand: BrandIdentity) => ({ state: "ready", brand })
const PORTS = { opencode: 4096, gateway: 4097, knowledge: 4098, acp: 4099 }
interface BridgeCase { name: string; status: unknown; ports?: unknown; credentials?: unknown; mayLoadConnection?: boolean }
const casesFor = (brand: BrandIdentity): BridgeCase[] => [
  { name: "owned-namespace", status: { state: "blocked", brand, reason: "Namespace already owned by another process", paths: { appRoot: `fixture-${brand.namespace}` } } },
  { name: "other-brand", status: ready(foreign) },
  { name: "malformed-status", status: null },
  { name: "malformed-ports", status: ready(brand), ports: null, credentials: { username: "fixture", password: "fixture-only" }, mayLoadConnection: true },
  { name: "malformed-credentials", status: ready(brand), ports: PORTS, credentials: null, mayLoadConnection: true },
]
const reports: unknown[] = []
let browser: Browser | undefined
let activeVite: ReturnType<typeof Bun.spawn> | undefined
const API_PATH = /^\/(?:event|session|permission|question|health|global|config|provider|auth|agent|mcp|skill|command|file|project|experimental|channel|kb|acp|orchestration)(?:\/|$)/

async function runBrand(brand: BrandIdentity) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") })
  const port = probe.port!
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  activeVite = Bun.spawn([process.execPath, "run", "--bun", join(desktop, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(port)], {
    cwd: desktop,
    env: { ...process.env, ULTRAWORK_BRAND_JSON: JSON.stringify(brand), ULTRAWORK_BRAND_UI_LOGO: brand.isDefault ? "" : myworkLogo },
    stdout: "ignore", stderr: "inherit",
  })
  let serving = false
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { serving = true; break } } catch {}
    if (activeVite.exitCode !== null) throw new Error(`Vite exited: ${activeVite.exitCode}`)
    await Bun.sleep(100)
  }
  assert(serving, "Vite did not start")
  for (const words of LOCALES) for (const scenario of casesFor(brand)) {
    const page = await browser!.newPage({ locale: words.locale, viewport: { width: 1200, height: 900 } })
    const backendRequests: string[] = []
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("request", (request) => {
      // Vite also loads /src/components/session/*.tsx. Only actual API requests
      // match: a component module containing /session/ is not a backend effect.
      if (API_PATH.test(new URL(request.url()).pathname)) backendRequests.push(request.url())
    })
    await page.addInitScript(({ scenario }) => {
      const w = window as any
      w.__brandCommands = []
      w.__brandClipboard = ""
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { w.__brandClipboard = text } } })
      // Deliberately no __ULTRAWORK_BROWSER_TEST__: exercise the strict native gate.
      w.__TAURI_INTERNALS__ = {
        invoke: async (command: string) => {
          w.__brandCommands.push(command)
          if (command === "get_startup_status") return scenario.status
          if (command === "get_boot_status") return "failed"
          if (command === "get_sidecar_ports") return scenario.ports
          if (command === "get_sidecar_credentials") return scenario.credentials
          if (command === "retry_startup") throw new Error("fixture-retry-still-blocked")
          return null
        },
        transformCallback: (callback: unknown) => callback,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      }
    }, { scenario })
    try {
      await page.goto(origin, { waitUntil: "domcontentloaded" })
      await page.getByRole("heading", { name: `${brand.productName} · ${words.title}`, exact: true }).waitFor({ timeout: 20_000 })
      assert.equal(await page.title(), brand.productName)
      await page.waitForTimeout(150)
      await assertReadOnly(page, scenario.mayLoadConnection === true, backendRequests)
      assert.deepEqual(errors, [], "Uncaught page errors")
      if (scenario.name === "owned-namespace") {
        const customLogo = page.locator('svg image[href^="data:image/png;base64,"]')
        assert.equal(await customLogo.count(), brand.isDefault ? 0 : 1)
        if (!brand.isDefault) assert.equal(await customLogo.getAttribute("href"), `data:image/png;base64,${readFileSync(myworkLogo).toString("base64")}`, "Rendered logo must match the current MyWork preset")
        await page.getByRole("button", { name: words.copy, exact: true }).click()
        await page.getByText(words.copied, { exact: true }).waitFor()
        const diagnostic = JSON.parse(await page.evaluate(() => (window as any).__brandClipboard))
        assert.equal(diagnostic.brandId, brand.brandId)
        assert.equal(diagnostic.identifier, brand.identifier)
        assert.equal(diagnostic.reason, "Namespace already owned by another process")
        assert(!JSON.stringify(diagnostic).includes("fixture-only"), "Credentials leaked into diagnostics")
        await page.getByRole("button", { name: words.retry, exact: true }).click()
        await page.getByText("Error: fixture-retry-still-blocked", { exact: true }).waitFor()
        assert(await page.getByRole("button", { name: words.retry, exact: true }).isEnabled())
        await page.getByRole("button", { name: words.exit, exact: true }).click()
        const calls = await page.evaluate(() => (window as any).__brandCommands as string[])
        assert(calls.includes("retry_startup") && calls.includes("exit_startup_blocked"))
        await assertReadOnly(page, false, backendRequests)
        await page.screenshot({ path: join(output, `${brand.brandId}-${words.locale}.png`) })
      }
      reports.push({ brand: brand.brandId, locale: words.locale, scenario: scenario.name, result: "passed", backendRequests: backendRequests.length })
      console.log(`PASS ${brand.productName}/${words.locale}/${scenario.name}: no business provider, IPC write or backend request`)
    } catch (error) {
      await page.screenshot({ path: join(output, `FAIL-${brand.brandId}-${words.locale}-${scenario.name}.png`) }).catch(() => {})
      throw error
    } finally { await page.close() }
  }
  activeVite.kill()
  await activeVite.exited
  activeVite = undefined
}

async function assertReadOnly(page: Page, mayLoadConnection: boolean, requests: string[]) {
  const commands = await page.evaluate(() => (window as any).__brandCommands as string[])
  const allowed = new Set(["plugin:event|listen", "plugin:event|unlisten", "get_startup_status", "get_boot_status", "retry_startup", "exit_startup_blocked"])
  if (mayLoadConnection) for (const name of ["get_sidecar_ports", "get_sidecar_credentials"]) allowed.add(name)
  assert.deepEqual(commands.filter((command) => !allowed.has(command)), [], "Blocked startup invoked business commands")
  assert.equal(requests.length, 0, "Blocked startup made a backend API request")
  assert.equal(await page.locator("textarea").count(), 0, "Business composer mounted during blocked startup")
}

try {
  // Playwright owns its temporary profile and closes only this child browser.
  if (engine === "webkit") {
    browser = await webkit.launch({ headless: true, timeout: 30_000 })
  } else {
    assert(candidates.length, "Install Chromium or set CHROME_PATH for the browser integration test")
    browser = await chromium.launch({ executablePath: candidates[0], headless: true, timeout: 30_000 })
  }
  console.log(`Browser: ${engine} ${browser.version()}`)
  for (const brand of [DEFAULT_BRAND, MYWORK]) await runBrand(brand)
  writeFileSync(join(output, "report.json"), JSON.stringify({ engine, browser: browser.version(), platform: process.platform, generatedAt: new Date().toISOString(), passed: reports.length, cases: reports }, null, 2) + "\n")
  console.log(`PASS ${reports.length} browser startup cases; report/screenshots: ${output}`)
} finally {
  await browser?.close()
  if (activeVite) { activeVite.kill(); await activeVite.exited }
}
