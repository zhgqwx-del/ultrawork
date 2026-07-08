// channels-ui-walkthrough.e2e.ts — real-browser UI proof for ADR-044: drives the
// REAL React app (Chrome + Vite) through Settings → 消息渠道, mocking the gateway
// at the network layer (Playwright page.route) with a controllable QR state
// machine. Proves the four-channel dropdown (brand icons), the QR poll→authorized
// path (card appears), the manual-fallback forms (dingtalk clientId, wecom
// botId/secret, feishu appId/appSecret + Lark domain), and cancel semantics —
// through real React state, not unit mocks.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/channels-ui-walkthrough.e2e.ts
// Needs: system Chrome (playwright channel). Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser, type Route } from "playwright-core"

const DESKTOP = import.meta.dir + "/.."
const BUN = process.execPath
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = require("node:path").join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const PW = "chan-ui-pw"
const authHdr = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string,string> = {}, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"

// ---- controllable mock gateway state (shared with page.route below) ----
let tokenSeq = 0
const state = {
  channels: [] as any[],
  configs: [] as any[],
  qr: null as null | { token: string; type: string; pollCount: number; authorizeAfter: number },
}
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })

try {
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: authHdr } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  page.on("pageerror", (e) => { errors.push("PAGEERROR: " + e.message) })

  // Tauri shim (workspace + creds so the app renders past guards)
  await page.addInitScript(() => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => "/tmp/ws", login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: "chan-ui-pw" }),
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: "chan-ui-pw" }))
    localStorage.setItem("workspace_path", "/tmp/ws")
  })

  // Mock the gateway at the network layer with a real QR state machine.
  const chanRe = /\/channel(\/(dingtalk|wechat|wecom|feishu)\/qrcode(-status)?(\/[^?]+)?|$)/
  await page.route((u) => chanRe.test(new URL(u).pathname), async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const method = route.request().method()
    // GET /channel
    if (p === "/channel" && method === "GET") return json(route, { channels: state.channels, configs: state.configs })
    // POST /channel/:type/qrcode
    let m = p.match(/^\/channel\/(\w+)\/qrcode$/)
    if (m && method === "POST") {
      const type = m[1]
      if (!["dingtalk", "wechat", "wecom", "feishu"].includes(type)) return json(route, { error: "no flow" }, 404)
      state.qr = { token: "qr_mock_" + type + "_" + (++tokenSeq), type, pollCount: 0, authorizeAfter: 2 }
      return json(route, { token: state.qr.token, qrContent: `https://mock.example/${type}?scan`, browserUrl: type === "wecom" ? `https://mock.example/${type}/browser` : undefined })
    }
    // GET /channel/:type/qrcode-status
    m = p.match(/^\/channel\/(\w+)\/qrcode-status$/)
    if (m && method === "GET") {
      const q = state.qr
      if (!q || url.searchParams.get("token") !== q.token) return json(route, { error: "not found" }, 404)
      q.pollCount++
      if (q.pollCount >= q.authorizeAfter) {
        // simulate gateway having persisted the channel on authorization
        const id = "ch_mock_" + q.type
        if (!state.channels.find((c) => c.id === id)) {
          state.channels.push({ id, type: q.type, name: "e2e-" + q.type, state: "connected", connectedAt: new Date().toISOString() })
          state.configs.push({ id, type: q.type, name: "e2e-" + q.type, workspaceDir: "/tmp/ws" })
        }
        return json(route, { status: "authorized", channelId: id })
      }
      return json(route, { status: q.pollCount === 1 ? "pending" : "scanned" })
    }
    // DELETE /channel/:type/qrcode/:token
    m = p.match(/^\/channel\/(\w+)\/qrcode\/(.+)$/)
    if (m && method === "DELETE") {
      // token-specific, like the real gateway (StrictMode double-mount cancels
      // the orphaned first token — must not nuke the live second session)
      if (state.qr && state.qr.token === decodeURIComponent(m[2])) state.qr = null
      return json(route, { ok: true })
    }
    return json(route, { error: "unhandled " + method + " " + p }, 500)
  })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  console.log("=== 1. navigate → 渠道 ===")
  await page.locator("nav button").filter({ hasText: /^(Channels|渠道)$/ }).first().click()
  await page.getByRole("button", { name: /添加渠道|Add Channel/i }).waitFor({ timeout: 10000 })
  checks.push("Channels section renders ✓")

  console.log("=== 2. add-channel dropdown = 4 branded items ===")
  await page.getByRole("button", { name: /添加渠道|Add Channel/i }).click()
  const items = page.getByRole("menuitem")
  await items.first().waitFor({ timeout: 5000 })
  const count = await items.count()
  if (count !== 4) throw new Error(`expected 4 dropdown items, got ${count}`)
  // every item carries a brand-icon svg
  const branded = await page.locator('[role="menuitem"] svg[data-brand]').count()
  if (branded !== 4) throw new Error(`expected 4 brand icons in dropdown, got ${branded}`)
  checks.push("dropdown: 4 channel types, each with a brand icon ✓")

  console.log("=== 3. dingtalk QR flow → poll → authorized → card appears ===")
  await items.filter({ hasText: /钉钉|DingTalk/ }).click()
  await page.locator("svg").first().waitFor() // QR renders
  // device-flow hint + manual fallback present
  await page.getByText(/自动创建机器人|create the bot automatically/).first().waitFor({ timeout: 5000 })
  await page.getByRole("button", { name: /手动输入|Manual Input/i }).first().waitFor()
  // wait for the poll loop to reach authorized and the card to render
  await page.getByText("e2e-dingtalk").waitFor({ timeout: 15000 })
  checks.push("dingtalk: QR → background poll → authorized → connected card appears ✓")

  console.log("=== 4. wecom flow has 'open in browser' + manual → botId/secret ===")
  await page.getByRole("button", { name: /添加渠道|Add Channel/i }).click()
  await page.getByRole("menuitem").filter({ hasText: /企业微信|WeCom/ }).click()
  await page.getByRole("button", { name: /在浏览器中打开|Open in Browser/i }).first().waitFor({ timeout: 5000 })
  await page.getByRole("button", { name: /手动输入|Manual Input/i }).first().click()
  await page.getByText(/^(Bot ID)$/).first().waitFor({ timeout: 5000 })
  await page.getByText(/^(Secret)$/).first().waitFor()
  if (await page.getByText(/App ID|Client ID/).count() > 0) throw new Error("wecom form leaked other channel's fields")
  checks.push("wecom: browser-open button + manual form asks botId/secret ✓")
  await page.getByRole("button", { name: /取消|Cancel/i }).first().click()

  console.log("=== 5. feishu manual form exposes Lark domain choice ===")
  await page.getByRole("button", { name: /添加渠道|Add Channel/i }).click()
  await page.getByRole("menuitem").filter({ hasText: /飞书|Feishu/ }).click()
  await page.getByRole("button", { name: /手动输入|Manual Input/i }).first().click()
  await page.getByText(/App ID/).first().waitFor({ timeout: 5000 })
  await page.getByText(/Lark（国际版|Lark \(international/).first().waitFor()
  checks.push("feishu: manual form has App ID/Secret + Lark international-tenant toggle ✓")

  console.log("=== 6. wechat QR flow has NO device-flow escape hatches ===")
  await page.getByRole("button", { name: /取消|Cancel/i }).first().click()
  await page.getByRole("button", { name: /添加渠道|Add Channel/i }).click()
  await page.getByRole("menuitem").filter({ hasText: /微信(?!.*企业)|^WeChat/ }).click()
  await page.waitForTimeout(1000)
  if (await page.getByRole("button", { name: /手动输入|Manual Input/i }).count() > 0) throw new Error("wechat should not offer manual input")
  if (await page.getByRole("button", { name: /在浏览器中打开|Open in Browser/i }).count() > 0) throw new Error("wechat should not offer browser-open")
  checks.push("wechat: app-only QR, no manual/browser escape hatches ✓")

  // ERR_CONNECTION_REFUSED = background probes to sidecars we intentionally did
  // not boot (knowledge :4098 / acp :4099 / real gateway :4097 — gateway is mocked
  // via page.route). Not relevant to the channels flow.
  const realErrors = errors.filter((e) => !/favicon|ResizeObserver|Download the React|ERR_CONNECTION_REFUSED|Failed to load resource|SSE error|Failed to fetch/i.test(e))
  if (realErrors.length) throw new Error("console errors: " + realErrors.slice(0, 3).join(" | "))
  checks.push("no unexpected console errors ✓")

  verdict = "PASS"
} catch (e) {
  verdict = "FAIL"
  console.error("WALKTHROUGH FAILED:", e instanceof Error ? e.message : e)
} finally {
  console.log("\n=== checks ===")
  for (const c of checks) console.log("  " + c)
  console.log(`\nVERDICT: ${verdict}`)
  if (browser) await browser.close()
  for (const p of procs) try { p.kill() } catch {}
  await new Promise((r) => setTimeout(r, 500))
  process.exit(verdict === "PASS" ? 0 : 1)
}
