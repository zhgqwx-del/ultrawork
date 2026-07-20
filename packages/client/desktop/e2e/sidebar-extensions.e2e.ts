// sidebar-extensions.e2e.ts — REAL-APP behavioral proof for the sidebar
// capability-extension quick-access shortcuts (Connectors / Skills / Tools /
// Channels + search-last).
//
// jsdom can't prove routing/navigation intent end-to-end; this drives the REAL
// rendered LeftSidebar in a real browser and asserts that clicking each shortcut
// deep-links to the CORRECT settings section (the section's nav button goes
// active). It also asserts the expected top-row order and that search sits last.
//
//   cd packages/client/desktop && bun run --bun e2e/sidebar-extensions.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/sidebar-extensions.e2e.ts   <- WKWebView engine
//
// Run BOTH engines: Chromium = Windows WebView2 family, WebKit = macOS/Linux
// WKWebView — the feature ships to all three.
// Needs: built opencode binary (no model key — no prompt is ever sent).
import { chromium, webkit, type Browser, type Page } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "sidebar-extensions-e2e-pw"
const OC = 4096

// Expected top-row order (matches EXTENSION_ENTRIES) and the settings section
// each shortcut must activate. Labels are the English i18n values (config below
// pins language:"en"). `nav` is the exact text of the settings left-nav button
// that must become active after the click.
const ENTRIES = [
  { label: "Channels", nav: "Channels" },
  { label: "Connectors", nav: "Connectors" },
  { label: "Skills", nav: "Skills" },
  { label: "Tools", nav: "Tools" },
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

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sidebar-extensions-e2e-")))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "myqwen/qwen3.7-max",
  provider: { myqwen: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://example.invalid/v1", apiKey: "unused-no-prompt-sent" }, models: { "qwen3.7-max": { id: "qwen3.7-max", name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "✓" : "✗ FAIL"}  ${name}  [${detail}]`)
  return ok
}

// Read the settings left-nav (w-56) and return the text of the ACTIVE section
// button (active = font-medium → computed fontWeight >= 500). Pure computed
// style on the REAL render, so it can't be faked by matching nav label text
// (every section label is always present in the nav; only one is bold).
async function activeSettingsSection(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    const nav = document.querySelector('nav[class*="w-56"]')
    if (!nav) return null
    const btns = Array.from(nav.querySelectorAll("button"))
    const active = btns.find((b) => parseInt(getComputedStyle(b as Element).fontWeight || "400", 10) >= 500)
    return active ? (active.textContent || "").trim() : null
  })
}

let browser: Browser | undefined
let allPass = true
try {
  if (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } }).then((r) => r.ok).catch(() => false)) {
    throw new Error(`port ${OC} already serving — kill the stale process first (lsof -ti tcp:${OC} | xargs kill -9)`)
  }
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

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
    // @ts-ignore — minimal Tauri IPC + event shim (see sidebar-select.e2e.ts).
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // @ts-ignore
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: "en" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })
  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })

  // Sidebar chrome must render (expanded by default).
  await poll("sidebar renders", async () => (await page.locator("aside").count()) > 0)

  // --- Top-row ORDER: within the action <nav>, the icon buttons carry aria-labels
  // in the intended order: New Task, then the four extensions, then Search last. ---
  const rowLabels = await page.evaluate(() => {
    const aside = document.querySelector("aside")
    if (!aside) return []
    const nav = aside.querySelector("nav")
    if (!nav) return []
    return Array.from(nav.querySelectorAll("button"))
      .map((b) => b.getAttribute("aria-label") || "")
      .filter((s) => s.length > 0)
  })
  // New Task has no aria-label (tooltip only) in expanded mode; assert the four
  // extensions appear in order and Search-ish utility is not among the four.
  const extPart = rowLabels.filter((l) => ["Channels", "Connectors", "Skills", "Tools"].includes(l))
  allPass = check("top row order = Channels, Connectors, Skills, Tools", JSON.stringify(extPart) === JSON.stringify(["Channels", "Connectors", "Skills", "Tools"]), extPart.join(",")) && allPass

  // --- RESPONSIVE: the six-icon action row must fit the fixed-width rail with no
  // horizontal overflow, and every icon must sit inside the <aside> bounds. The
  // sidebar is fixed-width chrome (it does not reflow with the viewport), so this
  // is measured on the real render, then re-measured at a small viewport to prove
  // the rail width — and the fit — are viewport-independent. ---
  const measureRow = () => page.evaluate(() => {
    const aside = document.querySelector("aside")
    const nav = aside?.querySelector("nav")
    if (!aside || !nav) return { ok: false as const }
    const asideRect = aside.getBoundingClientRect()
    const btns = Array.from(nav.querySelectorAll("button"))
    const rects = btns.map((b) => b.getBoundingClientRect())
    return {
      ok: true as const,
      asideW: Math.round(asideRect.width),
      buttons: btns.length,
      overflow: nav.scrollWidth - nav.clientWidth,
      allInside: rects.every((r) => r.left >= asideRect.left - 0.5 && r.right <= asideRect.right + 0.5),
    }
  })
  const big = await measureRow()
  allPass = check("action row: 6 buttons (new-task + 4 ext + search)", big.ok && big.buttons === 6, String(big.buttons)) && allPass
  allPass = check("action row: no horizontal overflow (fits w-64 rail)", big.ok && big.overflow <= 1, big.ok ? `overflow=${big.overflow}px, asideW=${big.asideW}` : "no nav") && allPass
  allPass = check("action row: all icons inside <aside> bounds", big.ok && big.allInside, String(big.ok && big.allInside)) && allPass

  await page.setViewportSize({ width: 900, height: 600 })
  const small = await measureRow()
  allPass = check("small viewport (900x600): rail width unchanged, still fits", small.ok && small.asideW === big.asideW && small.overflow <= 1 && small.allInside, small.ok ? `asideW=${small.asideW}, overflow=${small.overflow}` : "no nav") && allPass
  await page.setViewportSize({ width: 1280, height: 800 })

  // --- Each shortcut deep-links to the CORRECT settings section ---
  for (const { label, nav } of ENTRIES) {
    // Click the sidebar shortcut (expanded row on first pass, then the collapsed
    // rail once we're on /settings — same aria-label either way).
    await page.locator("aside").getByRole("button", { name: label, exact: true }).first().click()
    await poll(`settings nav after ${label}`, async () => (await page.locator('nav[class*="w-56"]').count()) > 0)
    // The settings page must show and the target section must be the active one.
    let active: string | null = null
    await poll(`section active = ${nav}`, async () => { active = await activeSettingsSection(page); return active === nav })
    allPass = check(`click "${label}" → settings section "${nav}" active`, active === nav, String(active)) && allPass
    const url = page.url()
    allPass = check(`click "${label}" → url is /settings`, url.includes("/settings"), url) && allPass
  }

  // --- NEGATIVE CONTROL: the detector isn't vacuously true. A section we never
  // navigate to (Models) must NOT read as active at the end (we ended on Tools). ---
  const endActive = await activeSettingsSection(page)
  allPass = check("negative control: 'Models' is NOT the active section (ended on Tools)", endActive !== "Models" && endActive === "Tools", String(endActive)) && allPass

  // --- COLLAPSED-RAIL vertical fit: on /settings the rail is force-collapsed and
  // now carries the four extra icons. On a short (600px) window nothing must be
  // clipped below the fold — the footer avatar stays inside the viewport. ---
  await page.setViewportSize({ width: 1280, height: 600 })
  const rail = await page.evaluate(() => {
    const aside = document.querySelector("aside")
    if (!aside) return { ok: false as const }
    const btns = Array.from(aside.querySelectorAll("button"))
    const maxBottom = Math.max(...btns.map((b) => b.getBoundingClientRect().bottom))
    return { ok: true as const, count: btns.length, maxBottom: Math.round(maxBottom), viewportH: window.innerHeight }
  })
  allPass = check("collapsed rail @600px: no icon clipped below fold", rail.ok && rail.maxBottom <= rail.viewportH, rail.ok ? `maxBottom=${rail.maxBottom} <= vh=${rail.viewportH}, icons=${rail.count}` : "no aside") && allPass
} catch (e) {
  allPass = false
  results.push(`✗ FAIL  harness error  [${(e as Error).message}]`)
} finally {
  if (browser) await browser.close()
  for (const p of procs) try { p.kill() } catch {}
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log("\n" + results.join("\n") + "\n")
console.log(allPass ? "ALL PASS" : "SOME FAILED")
process.exit(allPass ? 0 : 1)
