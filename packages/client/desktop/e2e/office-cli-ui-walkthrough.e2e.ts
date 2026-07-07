// office-cli-ui-walkthrough.e2e.ts — real-browser UI proof for discussions/027
// Phase 1: drives the REAL React app (Chrome + Vite + real opencode) through
// the Settings → 连接器 → 办公 CLI card's full state machine — install →
// configure (hosted URL + poll) → authorize (device flow) → connected, plus
// the error/retry path — with the five Tauri office-CLI commands shimmed to a
// stateful mock that reproduces the DEVICE-VERIFIED lark-cli contract shapes
// (status document without `ok`, verification_url, partial-grant semantics are
// exercised at the Rust layer by cargo tests; here we prove the React wiring:
// state → badge/button/banner/toast transitions and the opener/copy fallbacks).
//
// Run:  cd packages/client/desktop && bun run --bun e2e/office-cli-ui-walkthrough.e2e.ts
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
const PW = "cli-ui-pw"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`) ; return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "cli-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const HOSTED_URL = "https://open.feishu.cn/page/cli?user_code=E2E9-MOCK&lpv=1.0.65&from=cli"
const VERIFY_URL = "https://accounts.feishu.cn/oauth/v1/device/verify?flow_id=F-e2e&user_code=UEJ9-MOCK"
const DT_VERIFY_URL = "https://login.dingtalk.com/oauth2/device/verify.htm?user_code=BRPX-MOCK"
const DT_ADMIN_URL = "https://open-dev.dingtalk.com/fe/old#/developerSettings"
const DT_NOT_ENABLED_DETAIL =
  "device authorization failed: CLI data access is not enabled for this organization, please contact admin to enable it\n组织主管理员：张三"

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + stateful office-cli invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(({ ws, pw, hostedUrl, verifyUrl, dtVerifyUrl, dtAdminUrl, dtDetail }) => {
    // Stateful mock of the five office-CLI commands, now TWO connectors (the
    // Phase 2 card state machines differ: dingtalk has no config step but has
    // the guided not_enabled state). The test flips window.__lark/__dt state
    // and reads window.__lark.opened (shared opener log) to drive assertions.
    const lark: any = {
      state: "not_installed",
      detail: null as string | null,
      opened: [] as string[],
      completeMode: "connected", // what complete_office_cli_auth resolves to
    }
    const dt: any = {
      state: "not_installed",
      detail: null as string | null,
      actionUrl: null as string | null,
      completeMode: "not_enabled", // first authorize hits the org switch
    }
    ;(window as any).__lark = lark
    ;(window as any).__dt = dt
    const status = () => ({
      id: "lark",
      state: lark.state,
      path: lark.state === "not_installed" ? null : "/mock/office-cli/bin/lark-cli",
      version: lark.state === "not_installed" ? null : "1.0.65",
      detail: lark.detail,
    })
    const dtStatus = () => ({
      id: "dingtalk",
      state: dt.state,
      path: dt.state === "not_installed" ? null : "/mock/office-cli/bin/dws",
      version: dt.state === "not_installed" ? null : "1.0.47",
      detail: dt.detail,
      action_url: dt.actionUrl,
    })
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [status(), dtStatus()],
      install_office_cli: async ({ id }: { id: string }) => {
        await new Promise((r) => setTimeout(r, 400))
        if (id === "dingtalk") {
          dt.state = "not_authorized" // dws has no config step
          return dtStatus()
        }
        lark.state = "not_configured"
        return status()
      },
      start_office_cli_config: async () => {
        await new Promise((r) => setTimeout(r, 200))
        return hostedUrl // the UI polls check_cli_connectors afterwards
      },
      start_office_cli_auth: async ({ id }: { id: string }) =>
        id === "dingtalk"
          ? { device_code: null, user_code: "BRPX-MOCK", verification_uri: dtVerifyUrl, expires_in: 900, interval: 5 }
          : { device_code: "dc-e2e", user_code: null, verification_uri: verifyUrl, verification_uri_complete: null, expires_in: 600, interval: null },
      complete_office_cli_auth: async ({ id }: { id: string }) => {
        await new Promise((r) => setTimeout(r, 600))
        if (id === "dingtalk") {
          dt.state = dt.completeMode
          if (dt.state === "not_enabled") {
            dt.detail = dtDetail
            dt.actionUrl = dtAdminUrl
          } else if (dt.state === "connected") {
            dt.detail = "张三 · 某公司"
            dt.actionUrl = null
          }
          return dtStatus()
        }
        lark.state = lark.completeMode
        if (lark.state === "connected") lark.detail = "guoqiang"
        return status()
      },
      "plugin:opener|open_url": ({ url }: { url: string }) => { lark.opened.push(url); return null },
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, hostedUrl: HOSTED_URL, verifyUrl: VERIFY_URL, dtVerifyUrl: DT_VERIFY_URL, dtAdminUrl: DT_ADMIN_URL, dtDetail: DT_NOT_ENABLED_DETAIL })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  console.log("=== 1. nav label says 连接器 (not MCP 连接器); groups MCP + 办公 CLI render ===")
  const navLabel = page.locator("nav").getByText(/^(Connectors|连接器)$/)
  await navLabel.first().waitFor({ timeout: 10000 })
  if ((await page.locator("nav").getByText(/^MCP (Connectors|连接器)$/).count()) !== 0)
    throw new Error("nav still shows the old MCP-qualified label")
  await navLabel.first().click()
  await page.getByText(/^(Office CLI|办公 CLI)$/).waitFor({ timeout: 10000 })
  await page.locator("h3").getByText(/^MCP$/).waitFor({ timeout: 5000 })
  checks.push("nav 连接器 + MCP/办公 CLI two groups ✓")

  console.log("=== 2. not_installed: card shows 未安装 + 安装 button ===")
  const larkCard = page.locator("div.rounded-lg", { hasText: /飞书 \/ Lark|Feishu \/ Lark/ }).last()
  await larkCard.getByText(/^(Not installed|未安装)$/).waitFor({ timeout: 10000 })
  const installBtn = larkCard.getByRole("button", { name: /^(Install|安装)$/ })
  checks.push("not_installed state renders ✓")

  console.log("=== 3. install → not_configured (badge, version, 配置应用 + hint) ===")
  await installBtn.click()
  await larkCard.getByText(/^(Not configured|未配置)$/).waitFor({ timeout: 10000 })
  await larkCard.getByText("v1.0.65").waitFor({ timeout: 5000 })
  const configureBtn = larkCard.getByRole("button", { name: /Configure app|配置应用/ })
  await configureBtn.waitFor({ timeout: 5000 })
  checks.push("install → not_configured + version label ✓")

  console.log("=== 4. configure → opener gets hosted URL + waiting banner + copy link; poll picks up state flip ===")
  await configureBtn.click()
  await larkCard.getByText(/finish the flow there|在网页完成后/).waitFor({ timeout: 10000 })
  const opened1 = await page.evaluate(() => (window as any).__lark.opened)
  if (opened1[0] !== HOSTED_URL) throw new Error(`opener did not receive hosted URL: ${JSON.stringify(opened1)}`)
  // CopyButton sets aria-label="Copy" (overrides the visible label as the
  // accessible name) — assert on the visible label text instead.
  if ((await larkCard.getByText(/Copy link|复制链接/).count()) < 1)
    throw new Error("copy-link fallback missing in waiting banner")
  // Simulate the user finishing the hosted flow in the browser:
  await page.evaluate(() => { (window as any).__lark.state = "not_authorized" })
  await larkCard.getByText(/^(Not authorized|未授权)$/).waitFor({ timeout: 15000 }) // 3s poll cadence
  const authorizeBtn = larkCard.getByRole("button", { name: /^(Authorize|授权)$/ })
  await authorizeBtn.waitFor({ timeout: 5000 })
  checks.push("configure: opener URL + banner + copy fallback + poll-driven flip to not_authorized ✓")

  console.log("=== 5. authorize → opener gets verification_url → connected + username + toast ===")
  await authorizeBtn.click()
  await larkCard.getByText(/^(Connected|已连接)$/).waitFor({ timeout: 15000 })
  await larkCard.getByText("guoqiang").waitFor({ timeout: 5000 })
  const opened2 = await page.evaluate(() => (window as any).__lark.opened)
  if (opened2[1] !== VERIFY_URL) throw new Error(`opener did not receive verification_url: ${JSON.stringify(opened2)}`)
  await page.getByText(/Feishu \/ Lark connected|飞书 \/ Lark 已连接/).first().waitFor({ timeout: 5000 }) // toast
  checks.push("authorize: device-flow URL opened + connected badge + userName + toast ✓")

  console.log("=== 6. header count includes the CLI connector ===")
  await page.getByText(/^1 (connected|已连接)$/).first().waitFor({ timeout: 5000 })
  checks.push("section connected count includes office CLI ✓")

  console.log("=== 7. error state: red banner with detail + 重试 recovers ===")
  await page.evaluate(() => { const l = (window as any).__lark; l.state = "error"; l.detail = "lark-cli auth status timed out" })
  // Per-card ghost refresh is icon-only — locate it via its title attribute.
  await larkCard.locator('button[title]').first().click()
  await larkCard.getByText(/^(Error|异常)$/).waitFor({ timeout: 10000 })
  await larkCard.getByText("lark-cli auth status timed out").waitFor({ timeout: 5000 })
  const retryBtn = larkCard.getByRole("button", { name: /^(Retry|重试)$/ })
  await retryBtn.waitFor({ timeout: 5000 })
  await page.evaluate(() => { const l = (window as any).__lark; l.state = "connected"; l.detail = "guoqiang" })
  await retryBtn.click()
  await larkCard.getByText(/^(Connected|已连接)$/).waitFor({ timeout: 10000 })
  if ((await larkCard.getByText("lark-cli auth status timed out").count()) !== 0)
    throw new Error("stale error banner survives recovery (refresh should clear per-id error)")
  checks.push("error state banner + retry-recovers-and-clears-error ✓")

  console.log("=== 8. dingtalk: not_installed → install → not_authorized (NO config step) ===")
  const dtCard = page.locator("div.rounded-lg", { hasText: /钉钉|DingTalk/ }).last()
  await dtCard.getByText(/^(Not installed|未安装)$/).waitFor({ timeout: 10000 })
  await dtCard.getByRole("button", { name: /^(Install|安装)$/ }).click()
  await dtCard.getByText(/^(Not authorized|未授权)$/).waitFor({ timeout: 10000 })
  await dtCard.getByText("v1.0.47").waitFor({ timeout: 5000 })
  if ((await dtCard.getByRole("button", { name: /Configure app|配置应用/ }).count()) !== 0)
    throw new Error("dingtalk card must never offer a configure step (built-in OAuth client)")
  checks.push("dingtalk install → not_authorized directly (no config step) ✓")

  console.log("=== 9. dingtalk authorize → org switch off: guided not_enabled banner + admin console link ===")
  await dtCard.getByRole("button", { name: /^(Authorize|授权)$/ }).click()
  await dtCard.getByText(/^(Org not enabled|企业未开通)$/).waitFor({ timeout: 15000 })
  // The verification URL was still opened (user completed the OAuth part).
  const openedDt = await page.evaluate(() => (window as any).__lark.opened)
  if (!openedDt.includes(DT_VERIFY_URL)) throw new Error(`opener did not receive dws verify URL: ${JSON.stringify(openedDt)}`)
  // Amber guidance banner: CLI's own message incl. the super-admin name, NOT a red error.
  await dtCard.getByText(/组织主管理员：张三/).waitFor({ timeout: 5000 })
  const consoleBtn = dtCard.getByRole("button", { name: /Admin console|打开管理后台/ })
  await consoleBtn.waitFor({ timeout: 5000 })
  await consoleBtn.click()
  const openedAdmin = await page.evaluate(() => (window as any).__lark.opened)
  if (openedAdmin[openedAdmin.length - 1] !== DT_ADMIN_URL)
    throw new Error(`admin console button did not open the console URL: ${JSON.stringify(openedAdmin)}`)
  checks.push("dingtalk not_enabled: badge + admin-name banner + console deep link ✓")

  console.log("=== 10. admin flips the switch → authorize again → connected; count = 2 ===")
  await page.evaluate(() => { (window as any).__dt.completeMode = "connected" })
  await dtCard.getByRole("button", { name: /^(Authorize again|重新授权)$/ }).click()
  await dtCard.getByText(/^(Connected|已连接)$/).waitFor({ timeout: 15000 })
  await dtCard.getByText("张三 · 某公司").waitFor({ timeout: 5000 })
  await page.getByText(/DingTalk connected|钉钉已连接/).first().waitFor({ timeout: 5000 }) // toast
  await page.getByText(/^2 (connected|已连接)$/).first().waitFor({ timeout: 10000 })
  checks.push("dingtalk re-authorize → connected + toast; section count reaches 2 ✓")

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 160)})`)
  verdict = "PASS ✅ — real React UI walks BOTH office-CLI connector cards: lark install → configure → authorize → connected + error/retry, dingtalk install → authorize → not_enabled guidance → re-authorize → connected, with opener-URL and count assertions."
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
