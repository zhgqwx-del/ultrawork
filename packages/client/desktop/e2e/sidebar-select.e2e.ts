// sidebar-select.e2e.ts — REAL-APP guard for the left-sidebar text-selection fix.
//
// The bug: session rows are clickable nav chrome, but the sidebar had no
// `user-select: none`, so pressing a row and dragging DOWN painted a native
// cross-row text selection (mainstream agent sidebars don't). Fix = `select-none`
// on <aside>, with the search + rename <input>s opting back in via `select-text`.
//
// jsdom has NO selection engine, so this is the ONLY layer that can prove it. This
// drives the REAL rendered LeftSidebar (not a copied-class harness), so it also
// catches drift: delete `select-none` from the component and this goes red.
//
// A self-contained NEGATIVE CONTROL (an injected selectable node) is dragged the
// same way and MUST select — otherwise the drag simulation is a no-op and every
// green below would be vacuous.
//
//   cd packages/client/desktop && bun run --bun e2e/sidebar-select.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/sidebar-select.e2e.ts   <- macOS/Linux WKWebView engine
//
// Run BOTH: Chromium is the Windows WebView2 family, WebKit is the macOS/Linux
// WKWebView engine — the fix ships to all three, so both must pass.
// Needs: built opencode binary (no model key — sessions are created via CRUD, never prompted).
import { chromium, webkit, type Browser, type Page } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "sidebar-select-e2e-pw"
const OC = 4096

const TITLES = [
  "用deckcraft重建codex.html",
  "鲁迅介绍HTML页面",
  "团队远程协作最佳实践PPT制作",
  "AI编程助手落地实践PPT",
  "OpenClaw创始人查询",
  "用deckcraft制作opencode介绍PPT",
]

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 400)) }
  throw new Error(`timeout ${label}`)
}

// Model config is present only so `serve` starts happy; a dummy key is fine
// because this test never sends a prompt — it only creates + lists sessions.
//
// realpathSync is load-bearing on macOS: mkdtemp lives under /var/folders, a
// symlink to /private/var. opencode canonicalises the `?directory=` LIST query
// (→ /private/var) but stores the session under the raw create-header path
// (/var), so an un-canonicalised temp dir makes the sidebar list come back EMPTY
// even though the sessions exist. Real user workspaces (/Users/...) aren't
// symlinked, so this only ever bites the temp dir here.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sidebar-select-e2e-")))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "myqwen/qwen3.7-max",
  provider: { myqwen: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1", apiKey: "unused-no-prompt-sent" }, models: { "qwen3.7-max": { id: "qwen3.7-max", name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, { ...init, headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) } })

/** Drag from inside the first target down into the last target, then return the
 *  window selection text. Coords are offset a little so the press lands ON the
 *  text, not the row padding. */
async function dragSelect(page: Page, first: string, last: string): Promise<string> {
  const a = await page.locator(first).boundingBox()
  const b = await page.locator(last).boundingBox()
  if (!a || !b) throw new Error(`missing bbox: ${first} / ${last}`)
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.mouse.move(a.x + 20, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + 60, b.y + b.height / 2, { steps: 15 })
  await page.mouse.up()
  return (await page.evaluate(() => (window.getSelection()?.toString() ?? "").trim()))
}

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "✓" : "✗ FAIL"}  ${name}  [${detail}]`)
  return ok
}

let browser: Browser | undefined
let allPass = true
try {
  // A stale opencode from a crashed run would answer on 4096 with someone else's
  // sessions — a confusing false state. Fail fast instead.
  if (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } }).then((r) => r.ok).catch(() => false)) {
    throw new Error(`port ${OC} already serving — kill the stale process first (lsof -ti tcp:${OC} | xargs kill -9)`)
  }
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  // Create the rows via CRUD (no model needed) and title them so the drag crosses
  // real multi-character text, exactly like the reported screenshot.
  for (const title of TITLES) {
    const s = await (await api("/session", { method: "POST", body: "{}" })).json()
    await api(`/session/${s.id}`, { method: "PATCH", body: JSON.stringify({ title }) })
  }

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [], "plugin:opener|open_url": () => null,
      "plugin:event|listen": () => 0, "plugin:event|unlisten": () => null,
    }
    // @ts-ignore — minimal Tauri IPC + event shim. get_sidecar_credentials feeds
    // the ConfigProvider its auth (without it the app can't reach opencode →
    // empty list); unregisterListener must exist or event-cleanup throws.
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // @ts-ignore
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: "en" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })
  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })

  // Session rows are the only cursor-pointer <div>s inside the sidebar (the +/search
  // are <button>s). Wait until at least a few have rendered.
  const rows = page.locator("aside div.cursor-pointer")
  await poll("rows render", async () => (await rows.count()) >= TITLES.length)
  const rowCount = await rows.count()

  // --- NEGATIVE CONTROL: prove the drag simulation actually selects something ---
  await page.evaluate(() => {
    const d = document.createElement("div")
    d.id = "__neg"; d.textContent = "拖选控制组文本 negative control selectable text"
    d.style.cssText = "position:fixed;top:600px;left:500px;width:300px;z-index:99999;background:#fff;user-select:text"
    document.body.appendChild(d)
  })
  const controlSel = await dragSelect(page, "#__neg", "#__neg")
  allPass = check("negative-control: injected node DOES select on drag", controlSel.length > 0, `"${controlSel.slice(0, 30)}"`) && allPass
  await page.evaluate(() => document.getElementById("__neg")?.remove())

  // --- THE FIX: dragging real session rows must NOT paint a selection ---
  const rowSel = await dragSelect(page, "aside div.cursor-pointer >> nth=0", `aside div.cursor-pointer >> nth=${Math.min(4, rowCount - 1)}`)
  allPass = check("FIX: real sidebar rows do NOT select on drag", rowSel.length === 0, `"${rowSel.slice(0, 40)}"`) && allPass

  // --- Computed style on the REAL render: rows/aside == none ---
  const rowStyle = await page.evaluate(() => {
    const cs = (el: Element | null) => el ? (getComputedStyle(el).userSelect || (getComputedStyle(el) as any).webkitUserSelect) : "MISSING"
    return { row: cs(document.querySelector("aside div.cursor-pointer")), aside: cs(document.querySelector("aside")) }
  })
  allPass = check("computed userSelect on real row == none", rowStyle.row === "none", rowStyle.row) && allPass
  allPass = check("computed userSelect on <aside> == none", rowStyle.aside === "none", rowStyle.aside) && allPass

  // --- Search input opts back in (select-text) and is still drag-selectable ---
  await page.locator('aside nav button').nth(1).click() // the search toggle
  const search = page.locator('aside input[type="text"]')
  await search.waitFor({ state: "visible" })
  const searchStyle = await page.evaluate(() => {
    const el = document.querySelector('aside input[type="text"]') as HTMLElement
    return getComputedStyle(el).userSelect || (getComputedStyle(el) as any).webkitUserSelect
  })
  allPass = check("computed userSelect on search input == text", searchStyle === "text", searchStyle) && allPass
  await search.fill("拖选可用文字")
  const box = await search.boundingBox()
  if (box) {
    await page.mouse.move(box.x + 8, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()
  }
  const inputSelLen = await page.evaluate(() => {
    const el = document.querySelector('aside input[type="text"]') as HTMLInputElement
    return (el.selectionEnd ?? 0) - (el.selectionStart ?? 0)
  })
  allPass = check("search input still drag-selectable (selectionLen>0)", inputSelLen > 0, `len=${inputSelLen}`) && allPass

  // --- Rename input opts back in too (enter edit mode via the row's ⋯ menu) ---
  try {
    await page.locator('aside input[type="text"]').fill("") // clear the search so rows show
    await page.locator('aside nav button').nth(1).click()   // close search
    const firstRow = page.locator("aside div.cursor-pointer").first()
    await firstRow.hover()
    await firstRow.locator('button[aria-label="Session options"]').click()
    await page.getByRole("menuitem").filter({ hasText: /重命名|Rename/ }).click()
    const renameStyle = await page.evaluate(() => {
      const el = document.querySelector('aside input[type="text"]') as HTMLElement
      return getComputedStyle(el).userSelect || (getComputedStyle(el) as any).webkitUserSelect
    })
    allPass = check("computed userSelect on rename input == text", renameStyle === "text", renameStyle) && allPass
    await page.keyboard.press("Escape")
  } catch (e) {
    results.push(`SKIP ⚠️  rename-input userSelect — could not open edit mode: ${(e as Error).message}`)
  }

  await page.close()
} catch (e) {
  results.push(`✗ FAIL  harness — ${(e as Error).message}`)
  allPass = false
} finally {
  if (browser) await browser.close()
  for (const p of procs) { try { p.kill() } catch {} }
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n=== sidebar-select (${process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"}) ===`)
for (const r of results) console.log("  " + r)
console.log(`\n${allPass ? "✅ ALL CHECKS PASS" : "❌ SOME CHECKS FAILED"}`)
process.exit(allPass ? 0 : 1)
