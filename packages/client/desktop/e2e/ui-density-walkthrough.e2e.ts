// ui-density-walkthrough.e2e.ts — real-browser proof of the UI density pass
// (2026-07-08): mock-llm-markdown → real opencode → Vite → headless Chrome, then
// assert the REAL computed styles of the shipped components (not a mock DOM):
//   · left sidebar  = 256px (w-64)      · right sidebar = 288px (w-72)
//   · chat body     = 14px (.chat-md)   · chat leading  ≈ 21.7px (14 × 1.55)
//   · markdown h2   = 16px (text-base)  · reading column max-width = 860px
//   · session row   = 13px    · sidebar search input = 13px  · footer user = 13px
// Also screenshots the live app to scratchpad for eyeball review.
//
//   cd packages/client/desktop && bun run --bun e2e/ui-density-walkthrough.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome"); built opencode binary.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "ui-density-pw"; const LLM = 8091; const OC = 4096
const SHOT = process.env.UI_SHOT ?? join(tmpdir(), "ui-density-live.png")

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "ui-density-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
try {
  console.log("=== start mock-llm-markdown + opencode + vite ===")
  spawn([BUN, "run", join(DIR, "mock-llm-markdown.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 })
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

  console.log("=== send prompt → opencode streams markdown answer ===")
  await page.locator("textarea").first().fill("今日AI新闻汇总")
  await page.waitForTimeout(300)
  // Enter-to-send (chat-input handles Enter without Shift); fall back to the
  // send icon button (aria.sendMessage) if the route hasn't changed.
  await page.locator("textarea").first().press("Enter")
  await page.waitForURL(/\/session\//, { timeout: 8000 }).catch(async () => {
    await page.getByRole("button", { name: /发送|send/i }).last().click().catch(() => {})
    await page.waitForURL(/\/session\//, { timeout: 12000 })
  })

  // Wait for the real markdown answer to render (.chat-md with our content).
  await page.waitForSelector(".chat-md h2", { timeout: 30000 })
  await page.locator(".chat-md h2").first().waitFor()
  await page.waitForTimeout(800)

  console.log("=== open right sidebar (assert w-72 + default-open sections) ===")
  await page.getByLabel(/Toggle right sidebar|切换右侧边栏/).click().catch(() => {})
  await page.waitForTimeout(1000)

  // Screenshot the live app for eyeball review.
  await page.screenshot({ path: SHOT })
  console.log(`[shot] ${SHOT}`)

  // Reveal the sidebar search input (2nd action button) so its font is
  // measurable — part of the 13px chrome consistency check.
  await page.locator("aside").first().locator("nav button").nth(1).click().catch(() => {})
  await page.waitForTimeout(400)

  const m = await page.evaluate(() => {
    const cs = (el: Element | null) => (el ? getComputedStyle(el) : null)
    const asides = [...document.querySelectorAll("aside")]
    const left = asides[0] ?? null
    const chat = document.querySelector(".chat-md")
    const h2 = document.querySelector(".chat-md h2")
    const sessRow = document.querySelector('aside [class*="cursor-pointer"]')
    const searchInput = left?.querySelector('input[type="text"]') ?? null
    const footerUser = left?.querySelector('button[aria-label="User settings"] p') ?? null
    let colMaxW: string | null = null
    for (const d of document.querySelectorAll("div")) {
      if (getComputedStyle(d).maxWidth === "860px") { colMaxW = "860px"; break }
    }
    const bodyText = document.body.innerText
    return {
      leftW: asides[0]?.offsetWidth ?? null,
      rightW: asides.length > 1 ? asides[asides.length - 1].offsetWidth : null,
      chatFont: cs(chat)?.fontSize ?? null,
      chatLH: cs(chat)?.lineHeight ?? null,
      h2Font: cs(h2)?.fontSize ?? null,
      sessFont: cs(sessRow)?.fontSize ?? null,
      searchFont: cs(searchInput)?.fontSize ?? null,
      footerFont: cs(footerUser)?.fontSize ?? null,
      colMaxW,
      activityOpen: /执行活动|Activity/.test(bodyText),
      workspaceOpen: /工作区|Workspace/.test(bodyText),
    }
  })
  console.log("[measured]", JSON.stringify(m, null, 2))

  const checks: Array<[string, boolean]> = [
    ["left sidebar = 256px", m.leftW === 256],
    ["right sidebar = 288px", m.rightW === 288],
    ["chat body = 14px", m.chatFont === "14px"],
    ["chat leading ≈ 21.7px (14×1.55)", !!m.chatLH && m.chatLH.startsWith("21")],
    ["markdown h2 = 16px", m.h2Font === "16px"],
    ["reading column max-width = 860px", m.colMaxW === "860px"],
    ["session row = 13px", m.sessFont === "13px"],
    ["sidebar search input = 13px", m.searchFont === "13px"],
    ["sidebar footer username = 13px", m.footerFont === "13px"],
    ["right panel Activity section present", m.activityOpen],
    ["right panel Workspace section present", m.workspaceOpen],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`)
  verdict = failed.length === 0
    ? "PASS ✅ — all real computed styles match the density spec"
    : `FAIL ❌ — ${failed.map(([l]) => l).join("; ")}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
