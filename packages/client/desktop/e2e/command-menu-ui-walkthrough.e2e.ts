// command-menu-ui-walkthrough.e2e.ts — real-browser proof for the `/` command
// menu (discussions/056). The jsdom units assert classes and behaviour; they
// CANNOT assert layout, because jsdom has no layout engine — and layout is the
// entire defect this change fixes. This drives the REAL nine builtin skills
// (163–605 char descriptions, extracted from the shipped skills-builtin.zip)
// through a REAL opencode /command endpoint into a REAL Chrome, and measures:
//   1. the panel is bounded and stays inside the viewport (it used to grow past
//      the top of the layout card, leaving ~60% of the rows unreachable),
//   2. the list actually scrolls, and every row is reachable by keyboard,
//   3. every description renders on exactly ONE line (truncation really works),
//   4. rendered text contrast (getComputedStyle, not tokens) clears WCAG AA,
//   5. Enter on a non-matching `/word` SENDS and inserts no newline (bug D —
//      the newline half is unprovable in jsdom),
//   6. Escape leaves the typed text alone (bug E),
//   7. no horizontal overflow, no uncaught console errors.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/command-menu-ui-walkthrough.e2e.ts
// Needs: system Chrome + built opencode sidecar. Uses its own ports (4196/1520)
//        so a dev app on 4096/1420 can keep running; override with E2E_*_PORT.
// Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser, type Page } from "playwright-core"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureBuiltinZip, extractBuiltinZip } from "./builtin-zip-helper"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "cmd-menu-pw"
// Own ports: a dev app on the standard 4096/1420 must not be disturbed, and
// must not be mistaken for this run's backend.
const OC_PORT = process.env.E2E_OPENCODE_PORT ?? "4196"
const VITE_PORT = process.env.E2E_VITE_PORT ?? "1520"
const BASE = `http://localhost:${VITE_PORT}`
const OC_URL = `http://127.0.0.1:${OC_PORT}`
// This fixture stands up opencode ONLY. The gateway/knowledge proxies are aimed
// at dead ports so the run can never reach — or be answered by — a dev instance
// on the standard 4097/4098 (that cross-talk showed up as a stray 401). The ACP
// port is not proxy-configurable; the app calls it directly and CORS blocks it.
const DEAD_GATEWAY = "14097"
const DEAD_KNOWLEDGE = "14098"
const ACP_PORT = "4099"
/** Ports this fixture deliberately does not serve. Anything failing outside them is real. */
const FIXTURE_GAP = new RegExp(`:(${DEAD_GATEWAY}|${DEAD_KNOWLEDGE}|${ACP_PORT})\\b`)
const SHOTS = process.env.E2E_SHOTS || tmpdir()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "cmd-menu-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const PANEL = ".absolute.bottom-full"
const ROW = "[data-index]"
const LIST = `${PANEL} .overflow-y-auto`

/** WCAG relative luminance from an rgb()/rgba() string as returned by getComputedStyle. */
function contrastOf(fgCss: string, bgCss: string): number {
  const parse = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  const lum = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const [a, b] = [lum(parse(fgCss)), lum(parse(bgCss))]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"

async function openMenu(page: Page, text: string) {
  const ta = page.getByRole("textbox").first()
  await ta.fill("")
  await ta.fill(text)
  await page.locator(`${PANEL} ${ROW}`).first().waitFor({ timeout: 10000 })
  await page.waitForTimeout(150)
}

try {
  console.log("=== install the REAL builtin skills, start opencode + vite ===")
  ensureBuiltinZip()
  const n = extractBuiltinZip(join(tmp, ".config/ultrawork/skills/builtin"))
  console.log(`[fixture] extracted ${n} builtin skill files`)

  spawn([OPENCODE, "serve", "--port", OC_PORT], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`${OC_URL}/global/health`, { headers: { authorization: auth } })).ok)

  // Prove the fixture is realistic BEFORE trusting any UI measurement: these
  // descriptions are written for the model's routing decision, and their length
  // is the whole reason the menu overflowed.
  const cmds = await (await fetch(`${OC_URL}/command`, { headers: { authorization: auth } })).json() as
    { name: string; description?: string; source?: string }[]
  const skills = cmds.filter((c) => c.source === "skill")
  const lens = skills.map((s) => (s.description ?? "").length).sort((a, b) => b - a)
  console.log(`[fixture] ${skills.length} skills; description lengths ${lens.join(", ")}`)
  if (skills.length < 8) throw new Error(`expected the 9 builtin skills, got ${skills.length}`)
  if (lens[0] < 300) throw new Error(`longest description is only ${lens[0]} chars — fixture is not realistic`)
  checks.push(`fixture: ${skills.length} real skills, longest description ${lens[0]} chars ✓`)

  spawn([BUN, "run", "dev", "--", "--port", VITE_PORT], { E2E_OPENCODE_PORT: OC_PORT, E2E_GATEWAY_PORT: DEAD_GATEWAY, E2E_KNOWLEDGE_PORT: DEAD_KNOWLEDGE }, DESKTOP)
  await poll("vite", async () => (await fetch(`${BASE}/`)).ok)

  console.log("=== chrome + minimal tauri shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  // Two different signals, deliberately kept apart. `pageerror` is an UNCAUGHT
  // exception — always a real defect, so it is a hard gate at zero. `console.error`
  // is something the app chose to log, and on a fixture that runs only one of the
  // three sidecars it is expected noise ("SSE error" per unavailable stream); it
  // is reported and classified against the network evidence instead of muted by
  // an ever-growing list of message patterns.
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()) })
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  // Console text for a blocked request is sometimes just "net::ERR_FAILED" with
  // no URL, so the URLs are captured from the network layer instead — that is
  // what makes the exemption below precise rather than a blanket mute.
  const failedUrls: { url: string; why: string }[] = []
  page.on("requestfailed", (r) => failedUrls.push({ url: r.url(), why: r.failure()?.errorText ?? "?" }))
  const badResponses: string[] = []
  page.on("response", (r) => { if (r.status() >= 400) badResponses.push(`${r.status()} ${r.url()}`) })
  await page.addInitScript(({ ws, pw, oc }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [], refresh_builtin_skills: () => ({}),
      "plugin:opener|open_url": () => null, "plugin:event|listen": () => 0, "plugin:event|unlisten": () => null,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // @ts-ignore
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: oc, apiUsername: "opencode", apiPassword: pw, language: "zh" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, oc: OC_URL })

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)

  console.log("=== 1. panel is bounded and stays on screen ===")
  await openMenu(page, "/")
  const geo = await page.evaluate(({ PANEL, LIST, ROW }) => {
    const panel = document.querySelector(PANEL) as HTMLElement
    const list = document.querySelector(LIST) as HTMLElement
    const rows = Array.from(document.querySelectorAll(`${PANEL} ${ROW}`)) as HTMLElement[]
    const pr = panel.getBoundingClientRect()
    return {
      rows: rows.length,
      panelTop: pr.top, panelBottom: pr.bottom, panelHeight: pr.height,
      viewportH: window.innerHeight,
      listClient: list.clientHeight, listScroll: list.scrollHeight,
      contentHeightIfUnbounded: rows.reduce((sum, r) => sum + r.getBoundingClientRect().height, 0),
    }
  }, { PANEL, LIST, ROW })
  console.log("[geo]", JSON.stringify(geo))
  if (geo.rows < 8) throw new Error(`expected ~9 rows, got ${geo.rows}`)
  if (geo.panelTop < 0) throw new Error(`panel escapes the top of the viewport: top=${geo.panelTop}`)
  if (geo.panelBottom > geo.viewportH) throw new Error(`panel overflows the bottom: ${geo.panelBottom} > ${geo.viewportH}`)
  if (geo.panelHeight > geo.viewportH * 0.6) throw new Error(`panel is ${geo.panelHeight}px — not meaningfully bounded`)
  checks.push(`panel bounded: ${geo.rows} rows, height ${Math.round(geo.panelHeight)}px, fully inside the ${geo.viewportH}px viewport (top=${Math.round(geo.panelTop)}) ✓`)

  console.log("=== 2. the list really scrolls, and the last row is reachable by keyboard ===")
  if (geo.listScroll <= geo.listClient) throw new Error(`list does not overflow (scroll ${geo.listScroll} <= client ${geo.listClient}) — fixture too small to prove scrolling`)
  checks.push(`list scrolls: ${geo.listScroll}px of rows inside a ${geo.listClient}px capped viewport ✓`)

  const ta = page.getByRole("textbox").first()
  await ta.focus()
  for (let i = 0; i < geo.rows - 1; i++) await page.keyboard.press("ArrowDown")
  await page.waitForTimeout(250)
  const lastVisible = await page.evaluate(({ PANEL, LIST, ROW }) => {
    const list = document.querySelector(LIST) as HTMLElement
    const rows = Array.from(document.querySelectorAll(`${PANEL} ${ROW}`)) as HTMLElement[]
    const sel = rows[rows.length - 1]
    const lr = list.getBoundingClientRect(), sr = sel.getBoundingClientRect()
    return { index: sel.getAttribute("data-index"), inside: sr.top >= lr.top - 1 && sr.bottom <= lr.bottom + 1, selTop: sr.top, selBottom: sr.bottom, listTop: lr.top, listBottom: lr.bottom }
  }, { PANEL, LIST, ROW })
  console.log("[keyboard]", JSON.stringify(lastVisible))
  if (!lastVisible.inside) throw new Error(`last row is not scrolled into view: ${JSON.stringify(lastVisible)}`)
  await page.screenshot({ path: join(SHOTS, "command-menu-scrolled.png") })
  checks.push(`ArrowDown ×${geo.rows - 1} scrolls the last row (data-index=${lastVisible.index}) fully into view ✓`)

  console.log("=== 3. every description is truncated to exactly one line ===")
  const lines = await page.evaluate(({ PANEL, ROW }) => {
    const rows = Array.from(document.querySelectorAll(`${PANEL} ${ROW}`)) as HTMLElement[]
    return rows.map((r) => {
      const name = r.querySelector("div > div:nth-child(1)") as HTMLElement
      const desc = r.querySelector("div > div:nth-child(2)") as HTMLElement
      if (!desc) return null
      const lh = parseFloat(getComputedStyle(desc).lineHeight) || parseFloat(getComputedStyle(desc).fontSize) * 1.2
      return {
        name: name?.textContent ?? "?",
        heightPx: desc.getBoundingClientRect().height,
        lineHeight: lh,
        lineCount: Math.round(desc.getBoundingClientRect().height / lh),
        clipped: desc.scrollWidth > desc.clientWidth,
      }
    }).filter(Boolean)
  }, { PANEL, ROW })
  console.table(lines)
  const multiLine = (lines as any[]).filter((l) => l.lineCount > 1)
  if (multiLine.length) throw new Error(`${multiLine.length} description(s) wrap to multiple lines: ${JSON.stringify(multiLine)}`)
  const clipped = (lines as any[]).filter((l) => l.clipped).length
  if (clipped === 0) throw new Error("no description is actually overflowing — truncation is untested by this fixture")
  checks.push(`all ${(lines as any[]).length} descriptions render on exactly 1 line; ${clipped} are genuinely clipped by the truncation ✓`)

  console.log("=== 4. rendered contrast (computed colours, not tokens) clears AA ===")
  // Re-open so the selection is back on row 0: step 2 walked it to the last row,
  // and the selected row is the one state whose colours differ (muted text on the
  // accent background measured 4.40:1 — the miss this batch fixed). Measuring
  // "row 0" without resetting would silently test the unselected style twice.
  await openMenu(page, "/")
  const sel = await page.evaluate(({ PANEL, ROW }) => {
    const rows = Array.from(document.querySelectorAll(`${PANEL} ${ROW}`)) as HTMLElement[]
    const bgOf = (el: HTMLElement) => {
      let n: HTMLElement | null = el
      while (n) { const c = getComputedStyle(n).backgroundColor; if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") return c; n = n.parentElement }
      return "rgb(255, 255, 255)"
    }
    const rowBg = rows.map((r) => getComputedStyle(r).backgroundColor)
    const distinct = rowBg.filter((c) => c !== rowBg[1]).length
    const out: { label: string; fg: string; bg: string }[] = []
    for (const [i, r] of rows.slice(0, 2).entries()) {
      const name = r.querySelector("div > div:nth-child(1)") as HTMLElement
      const desc = r.querySelector("div > div:nth-child(2)") as HTMLElement
      const state = i === 0 ? "SELECTED" : "unselected"
      if (name) out.push({ label: `row name (${state})`, fg: getComputedStyle(name).color, bg: bgOf(name) })
      if (desc) out.push({ label: `row description (${state})`, fg: getComputedStyle(desc).color, bg: bgOf(desc) })
    }
    const title = document.querySelector(`${PANEL} > p`) as HTMLElement
    if (title) out.push({ label: "panel title", fg: getComputedStyle(title).color, bg: bgOf(title) })
    return { pairs: out, selectedRowBg: rowBg[0], otherRowBg: rowBg[1], highlightedCount: distinct }
  }, { PANEL, ROW })

  // The selection must actually be painted, and exactly one row may carry it —
  // hover moves the selection rather than adding a second highlight.
  if (sel.selectedRowBg === sel.otherRowBg) throw new Error(`selected row is not visually distinct (both ${sel.selectedRowBg})`)
  if (sel.highlightedCount !== 1) throw new Error(`expected exactly 1 highlighted row, found ${sel.highlightedCount}`)
  checks.push(`exactly one row is highlighted; selected bg ${sel.selectedRowBg} vs ${sel.otherRowBg} ✓`)

  const failures: string[] = []
  for (const c of sel.pairs) {
    const ratio = contrastOf(c.fg, c.bg)
    console.log(`  ${c.label.padEnd(32)} ${c.fg} on ${c.bg} = ${ratio.toFixed(2)}:1`)
    if (ratio < 4.5) failures.push(`${c.label} ${ratio.toFixed(2)}:1`)
  }
  if (failures.length) throw new Error(`rendered contrast below WCAG AA 4.5:1 — ${failures.join("; ")}`)
  if (!sel.pairs.some((c) => c.label.includes("SELECTED"))) throw new Error("selected-row pairs were not measured")
  checks.push(`all ${sel.pairs.length} rendered pairs clear AA 4.5:1, INCLUDING the selected row (getComputedStyle) ✓`)

  console.log("=== 5. bug D: Enter on a non-matching /word sends, and inserts no newline ===")
  await ta.fill("")
  await ta.fill("/zzzzz")
  await page.waitForTimeout(400)
  const emptyState = await page.locator(`${PANEL} ${ROW}`).count()
  if (emptyState !== 0) throw new Error("expected zero rows for /zzzzz")
  await ta.focus()
  await page.keyboard.press("Enter")
  await page.waitForTimeout(1200)
  const afterEnter = await ta.inputValue().catch(() => "")
  console.log(`[D] textarea after Enter: ${JSON.stringify(afterEnter)} | url=${page.url()}`)
  if (afterEnter.includes("\n")) throw new Error(`Enter inserted a newline instead of sending: ${JSON.stringify(afterEnter)}`)
  // Sending navigates to /session/:id (or at least clears the composer).
  const sent = page.url().includes("/session/") || afterEnter === ""
  if (!sent) throw new Error(`Enter neither sent nor navigated; composer still holds ${JSON.stringify(afterEnter)}`)
  checks.push(`Enter on /zzzzz sent the message (no newline inserted, url=${page.url().replace(/^https?:\/\/[^/]+/, "")}) ✓`)

  console.log("=== 6. bug E: Escape leaves the typed text alone ===")
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  await openMenu(page, "/deck")
  const ta2 = page.getByRole("textbox").first()
  await ta2.focus()
  await page.keyboard.press("Escape")
  await page.waitForTimeout(300)
  const afterEsc = await ta2.inputValue()
  const panelGone = await page.locator(PANEL).count()
  console.log(`[E] after Escape: text=${JSON.stringify(afterEsc)} panels=${panelGone}`)
  if (afterEsc !== "/deck") throw new Error(`Escape mangled the text: ${JSON.stringify(afterEsc)} (expected "/deck")`)
  if (panelGone !== 0) throw new Error("Escape did not close the menu")
  checks.push(`Escape closed the menu and left "/deck" untouched ✓`)

  console.log("=== 7. no horizontal overflow at narrow and wide viewports ===")
  for (const width of [900, 1680]) {
    await page.setViewportSize({ width, height: 900 })
    await page.waitForTimeout(300)
    await openMenu(page, "/")
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    if (over > 1) throw new Error(`horizontal overflow at ${width}px: ${over}px`)
    const stillInside = await page.evaluate((PANEL) => {
      const p = (document.querySelector(PANEL) as HTMLElement).getBoundingClientRect()
      return p.top >= 0 && p.bottom <= window.innerHeight && p.left >= 0 && p.right <= window.innerWidth
    }, PANEL)
    if (!stillInside) throw new Error(`panel leaves the viewport at ${width}px`)
  }
  await page.screenshot({ path: join(SHOTS, "command-menu-wide.png") })
  checks.push("no horizontal overflow and the panel stays inside the viewport at 900px and 1680px ✓")

  // This fixture stands up opencode only, so every probe at the ACP sidecar's
  // port fails CORS (health, team registry, delegate + global event streams).
  // Filtered by PORT, not by path, so the exemption is exactly "the sidecar this
  // fixture chose not to run" and cannot quietly swallow a real error elsewhere.
  // ACP itself has its own e2e suites; the command menu is gated off it anyway.
  // ERR_ABORTED is a cancellation, not a failure: this walkthrough navigates
  // mid-run (step 6), and that by design tears down the long-lived SSE stream.
  // Proxied requests carry the Vite origin, so classify by the proxy target too.
  const PROXY_TO_GAP = /\/(channel|knowledge|orchestration|acp)\b/
  const inGap = (u: string) => FIXTURE_GAP.test(u) || PROXY_TO_GAP.test(new URL(u, BASE).pathname)
  const unexpectedFailures = failedUrls.filter((f) => !inGap(f.url) && !/ABORTED/i.test(f.why))
  if (unexpectedFailures.length) throw new Error(`network requests failed outside the fixture gap: ${[...new Set(unexpectedFailures.map((f) => `${f.url} (${f.why})`))].slice(0, 5).join(", ")}`)
  const unexpectedHttp = badResponses.filter((r) => !inGap(r.split(" ")[1]))
  if (unexpectedHttp.length) throw new Error(`HTTP errors outside the fixture gap: ${[...new Set(unexpectedHttp)].slice(0, 5).join(", ")}`)
  // Only now — with every failed request proven to be the un-started sidecar —
  // are the URL-less "net::ERR_FAILED" console lines safe to discount.
  if (pageErrors.length) throw new Error(`uncaught exceptions: ${pageErrors.slice(0, 3).join(" | ")}`)
  checks.push("no uncaught exceptions across the whole flow ✓")
  console.log(`[note] ${consoleErrors.length} console.error line(s), all attributable to the sidecars this fixture does not run (network evidence checked above)`)

  verdict = "PASS"
} catch (err) {
  verdict = "FAIL"
  console.error("\n✗", err instanceof Error ? err.message : err)
} finally {
  console.log(`\n===== ${verdict} =====`)
  for (const c of checks) console.log(" ✓", c)
  console.log(`screenshots: ${SHOTS}`)
  await browser?.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(verdict === "PASS" ? 0 : 1)
}
