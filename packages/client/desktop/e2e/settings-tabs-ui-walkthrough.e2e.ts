// settings-tabs-ui-walkthrough.e2e.ts — real-browser proof for the
// Settings tab UNIFICATION (feat/unify-settings-tabs): Skills / Connectors /
// Knowledge all render the same Radix segmented control (`SectionTabs`).
//
// What only a real browser can prove (jsdom cannot):
//   1. all three sections expose a real `tablist` whose CONTAINER computed
//      styles are identical — the actual "same UI" claim, not just same JSX,
//   2. Knowledge (converted from hand-written pill chips) filters correctly and
//      renders each source card EXACTLY ONCE — the no-forceMount invariant, in
//      real DOM where an overlapping "All" tab would visibly duplicate a card,
//   3. Connectors' MCP panel still survives a tab round-trip (forceMount) and is
//      display:none — not merely unmounted — while inactive (regression guard),
//   4. Skills tabs switch and their count badges track the search box,
//   5. NO horizontal overflow of the tab strip at the 768px content column, in
//      BOTH locales — measured, not eyeballed. (Don't assume CJK is narrower:
//      full-width glyphs make the zh Knowledge strip the widest of the two.)
//
// Backends: opencode is REAL (serves /config). The skill/command lists and the
// knowledge-base sidecar (:4098) are route-stubbed so the three sections have
// deterministic data; React, Radix, Tailwind and the browser layout are real.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/settings-tabs-ui-walkthrough.e2e.ts
//       E2E_ENGINE=webkit bun run --bun e2e/settings-tabs-ui-walkthrough.e2e.ts
// Needs: system Chrome + built opencode sidecar + ports 1420/4096 free.
//   E2E_ENGINE=webkit runs the same checks on WebKit instead — the engine FAMILY
//   Tauri renders with on macOS (WKWebView). Chrome-measured layout numbers (tab
//   strip widths, overflow) do NOT transfer to WKWebView on their own: font
//   metrics differ. Requires `bunx playwright install webkit` once.
// Exit 0 = PASS, 1 = FAIL.
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "settings-tabs-pw"
const SHOTS = process.env.E2E_SHOTS ?? tmpdir()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

// Deterministic fixtures for the two route-stubbed sections. `builtin` is
// DERIVED from the location matching /skills/builtin/ (isBuiltinLocation).
const SKILLS = [
  { name: "ppt-master", description: "Build slide decks", location: "/res/skills/builtin/ppt-master/SKILL.md" },
  { name: "my-skill", description: "A user skill", location: "/home/u/.config/ultrawork/skills/my-skill/SKILL.md" },
]
const KB_SOURCES = [
  { id: 1, type: "local_folder", name: "docs-folder", config: {}, enabled: true, status: "complete" },
  { id: 2, type: "local_folder", name: "notes-folder", config: {}, enabled: true, status: "complete" },
  { id: 3, type: "ima", name: "ima-wiki", config: {}, enabled: true, status: "connected" },
  { id: 4, type: "custom_api", name: "my-api", config: {}, enabled: true, status: "connected" },
]

const tmp = mkdtempSync(join(tmpdir(), "settings-tabs-"))
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

  const ENGINE = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== ${ENGINE} + tauri shim + route stubs ===`)
  browser = ENGINE === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })

  // Knowledge sidecar (:4098 via the vite /kb proxy) — never started; stub it.
  await page.route("**/kb/sources/events", (r) => r.fulfill({ status: 200, contentType: "text/event-stream", body: "" }))
  await page.route("**/kb/sources", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: KB_SOURCES }) }))
  // Skills / commands come from opencode on :4096 — cross-origin from the Vite
  // page on :1420, and the api-client sends an Authorization header. WebKit
  // strictly enforces the CORS preflight that implies (Chrome let the bare
  // fulfill through), so answer OPTIONS and echo the CORS headers explicitly.
  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  }
  const json = (body: string) => (r: import("playwright-core").Route) =>
    r.request().method() === "OPTIONS"
      ? r.fulfill({ status: 204, headers: CORS })
      : r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body })
  await page.route("**/skill", json(JSON.stringify(SKILLS)))
  await page.route("**/command", json("[]"))

  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [],
      // ppt-master is bundled and NOT shadowed → it lands in the builtin tab.
      refresh_builtin_skills: () => ({ bundled: ["ppt-master"], shadowed: [], changed: false }),
      check_skill_dependencies: () => [],
      detect_browser_env: () => ({
        node_path: "/usr/bin/node", node_version: "v20.0.0", node_embedded: false, chrome_path: null,
        playwright_installed: false, devtools_installed: false, mode: "playwright", mcp_dir: `${ws}/.ultrawork/mcp`,
      }),
      "plugin:opener|open_url": () => null,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // Seed ONLY on first load. addInitScript re-runs on every reload, so an
    // unconditional write would clobber the zh language switch in step 9.
    if (!localStorage.getItem("ultrawork-config"))
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: "en" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  // Clicking the left nav must actually swap the section before we assert on
  // the new section's tabs — WebKit was observed to lose the click when a Radix
  // tab still held focus, silently leaving the old section mounted.
  const nav = async (label: RegExp) => {
    const item = page.locator("nav").getByText(label).first()
    await item.waitFor({ state: "visible", timeout: 10000 })
    await item.click()
    await page.waitForTimeout(400)
  }
  const dumpState = async (where: string) => {
    try {
      const tabs = await page.getByRole("tab").allTextContents()
      const heads = await page.locator("h2").allTextContents()
      console.log(`  [dump @ ${where}] url=${page.url()} h2=${JSON.stringify(heads)} tabs=${JSON.stringify(tabs)}`)
      await page.screenshot({ path: join(SHOTS, `FAIL-${ENGINE}-${where}.png`) })
    } catch (err) { console.log(`  [dump failed] ${(err as Error).message}`) }
  }
  // The computed identity of a tablist container — the "unified UI" assertion.
  const listStyle = async () => await page.getByRole("tablist").first().evaluate((el) => {
    const s = getComputedStyle(el)
    return [s.display, s.height, s.borderRadius, s.backgroundColor, s.padding].join("|")
  })
  // Real overflow check at the 768px column: does the strip fit?
  const overflow = async () => await page.getByRole("tablist").first().evaluate((el) => el.scrollWidth - el.clientWidth)

  console.log("=== 1. Knowledge: pill chips are GONE, four Radix tabs with entry counts ===")
  await nav(/^Knowledge$/)
  await page.getByRole("tab", { name: /^All/ }).waitFor({ timeout: 10000 })
  const kbTabs = await page.getByRole("tab").allTextContents()
  const expectKb = ["All4", "Local Folders2", "Platforms1", "Custom API1"]
  if (JSON.stringify(kbTabs) !== JSON.stringify(expectKb))
    throw new Error(`Knowledge tabs mismatch: got ${JSON.stringify(kbTabs)} want ${JSON.stringify(expectKb)}`)
  const kbStyle = await listStyle()
  const kbOverflow = await overflow()
  if (kbOverflow > 0) throw new Error(`Knowledge tab strip overflows by ${kbOverflow}px at the 768px column`)
  await page.screenshot({ path: join(SHOTS, `${ENGINE}-settings-tabs-knowledge.png`) })
  checks.push(`Knowledge: 4 Radix tabs w/ entry counts, no chips, no overflow (${kbOverflow}px) ✓`)

  console.log("=== 2. Knowledge: every source card renders EXACTLY ONCE (no-forceMount invariant, real DOM) ===")
  for (const name of ["docs-folder", "notes-folder", "ima-wiki", "my-api"]) {
    const n = await page.getByText(name, { exact: true }).count()
    if (n !== 1) throw new Error(`"${name}" rendered ${n}x on the All tab — overlapping panels are force-mounted`)
  }
  checks.push("Knowledge All tab: each of the 4 source cards present exactly once (no duplicate panels/timers) ✓")

  console.log("=== 3. Knowledge: Local Folders filters; Platforms maps onto the `ima` type ===")
  await page.getByRole("tab", { name: /^Local Folders/ }).click()
  await page.getByText("docs-folder", { exact: true }).waitFor({ timeout: 5000 })
  if (await page.getByText("ima-wiki", { exact: true }).count()) throw new Error("ima source leaked into the Local Folders tab")
  await page.getByRole("tab", { name: /^Platforms/ }).click()
  await page.getByText("ima-wiki", { exact: true }).waitFor({ timeout: 5000 })
  if (await page.getByText("my-api", { exact: true }).count()) throw new Error("custom_api source leaked into the Platforms tab")
  if (await page.getByText("docs-folder", { exact: true }).count()) throw new Error("local_folder source leaked into the Platforms tab")
  checks.push("Knowledge: Local Folders filters; Platforms tab maps onto the `ima` source type ✓")

  console.log("=== 4. Skills: three tabs, same computed segmented-control container ===")
  await nav(/^Skills$/)
  await page.getByRole("tab", { name: /^Built-in/ }).waitFor({ timeout: 10000 })
    .catch(async (e) => { await dumpState("step4-skills"); throw e })
  const skillTabs = await page.getByRole("tab").allTextContents()
  const expectSk = ["Built-in1", "Recommended5", "Custom1"]
  if (JSON.stringify(skillTabs) !== JSON.stringify(expectSk))
    throw new Error(`Skills tabs mismatch: got ${JSON.stringify(skillTabs)} want ${JSON.stringify(expectSk)}`)
  const skStyle = await listStyle()
  const skOverflow = await overflow()
  if (skOverflow > 0) throw new Error(`Skills tab strip overflows by ${skOverflow}px`)
  // Default tab shows the builtin skill; the custom one is unmounted.
  await page.getByText("/ppt-master", { exact: true }).waitFor({ timeout: 5000 })
  if (await page.getByText("/my-skill", { exact: true }).count()) throw new Error("custom skill leaked into the builtin tab")
  await page.getByRole("tab", { name: /^Custom/ }).click()
  await page.getByText("/my-skill", { exact: true }).waitFor({ timeout: 5000 })
  await page.screenshot({ path: join(SHOTS, `${ENGINE}-settings-tabs-skills.png`) })
  checks.push(`Skills: 3 tabs, switch works, no overflow (${skOverflow}px) ✓`)

  console.log("=== 5. Skills: the search box narrows every tab's count badge ===")
  await page.getByPlaceholder(/Search skills/i).fill("ppt-master")
  await page.waitForTimeout(300)
  const searched = await page.getByRole("tab").allTextContents()
  const expectSearch = ["Built-in1", "Recommended1", "Custom0"]
  if (JSON.stringify(searched) !== JSON.stringify(expectSearch))
    throw new Error(`Skills search counts mismatch: got ${JSON.stringify(searched)} want ${JSON.stringify(expectSearch)}`)
  checks.push('Skills: search "ppt-master" narrows badges to Built-in1 / Recommended1 / Custom0 ✓')

  console.log("=== 6. Connectors: same container; MCP forceMount round-trip still holds ===")
  await nav(/^Connectors$/)
  const mcpTab = page.getByRole("tab", { name: /^MCP/ })
  const cliTab = page.getByRole("tab", { name: /Office CLI/ })
  await mcpTab.waitFor({ timeout: 10000 })
  const coStyle = await listStyle()
  const coOverflow = await overflow()
  if (coOverflow > 0) throw new Error(`Connectors tab strip overflows by ${coOverflow}px`)
  // Entry-count badges (not connection counts): 0 MCP servers configured, 3 CLIs shipped
  const coTabs = await page.getByRole("tab").allTextContents()
  if (JSON.stringify(coTabs) !== JSON.stringify(["MCP0", "Office CLI3"]))
    throw new Error(`Connectors tabs mismatch: got ${JSON.stringify(coTabs)}`)
  await page.getByRole("button", { name: "Add Connector" }).first().click()
  await page.getByRole("menuitem", { name: "Manual" }).click()
  const nameInput = page.getByPlaceholder("Connector name")
  await nameInput.fill("roundtrip-check")
  await cliTab.click()
  await page.getByText(/Feishu \/ Lark/).first().waitFor({ timeout: 10000 })
  if (await nameInput.isVisible()) throw new Error("MCP add form must be display:none on the Office CLI tab")
  await mcpTab.click()
  await nameInput.waitFor({ state: "visible", timeout: 5000 })
  if ((await nameInput.inputValue()) !== "roundtrip-check")
    throw new Error("forceMount regression: MCP add-form value lost across a tab round-trip")
  await page.screenshot({ path: join(SHOTS, `${ENGINE}-settings-tabs-connectors.png`) })
  checks.push(`Connectors: entry-count badges MCP0/OfficeCLI3, forceMount round-trip preserved, no overflow (${coOverflow}px) ✓`)

  console.log("=== 7. the three tablists are the SAME control (identical computed container) ===")
  console.log(`  knowledge: ${kbStyle}\n  skills:    ${skStyle}\n  connectors:${coStyle}`)
  if (!(kbStyle === skStyle && skStyle === coStyle))
    throw new Error(`tablist containers differ:\n kb=${kbStyle}\n sk=${skStyle}\n co=${coStyle}`)
  checks.push(`all three tablists share one computed container style (${kbStyle}) ✓`)

  console.log("=== 8. keyboard: the tablist is one tab stop; arrows move between tabs ===")
  await mcpTab.click()
  await page.waitForTimeout(150)
  const before = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return { text: a?.textContent ?? "", role: a?.getAttribute("role") ?? "", tabindex: a?.getAttribute("tabindex") ?? "" }
  })
  console.log(`  activeElement before ArrowRight:`, JSON.stringify(before))
  await page.keyboard.press("ArrowRight")
  await page.waitForTimeout(250)
  const focused = await page.evaluate(() => document.activeElement?.textContent ?? "")
  console.log(`  activeElement after ArrowRight: "${focused}"; cli data-state=${await cliTab.getAttribute("data-state")}`)
  if (!focused.startsWith("Office CLI")) throw new Error(`ArrowRight did not move focus to the next tab (focused="${focused}", before=${JSON.stringify(before)})`)
  if ((await cliTab.getAttribute("data-state")) !== "active") throw new Error("ArrowRight should activate the next tab (Radix automatic activation)")
  checks.push("keyboard: ArrowRight moves + activates the next tab (roving tabindex) ✓")

  console.log("=== 9. zh locale: the widest strip (full-width CJK glyphs) still does not overflow ===")
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("ultrawork-config") ?? "{}")
    localStorage.setItem("ultrawork-config", JSON.stringify({ ...c, language: "zh" }))
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  await nav(/^知识库$/)
  await page.getByRole("tab", { name: /^全部/ }).waitFor({ timeout: 10000 })
  const zhTabs = await page.getByRole("tab").allTextContents()
  const zhOverflow = await overflow()
  const zhWidth = await page.getByRole("tablist").first().evaluate((el) => el.scrollWidth)
  console.log(`  zh knowledge tabs: ${JSON.stringify(zhTabs)}  scrollWidth=${zhWidth}px overflow=${zhOverflow}px`)
  if (zhOverflow > 0) throw new Error(`zh Knowledge tab strip overflows by ${zhOverflow}px`)
  await page.screenshot({ path: join(SHOTS, `${ENGINE}-settings-tabs-knowledge-zh.png`) })
  checks.push(`zh locale: Knowledge strip ${zhWidth}px wide, no overflow (${zhOverflow}px) ✓`)

  console.log("=== 10. dark theme: the ACTIVE tab must be distinguishable from the track ===")
  // Knowledge's active tab used to be --color-primary (blue). It is now the
  // shared segmented thumb (--color-bg on a --color-bg-subtle track). In dark
  // mode the thumb is DARKER than its track, so measure the separation instead
  // of trusting it. Report the numbers; only fail if they are truly identical.
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("ultrawork-config") ?? "{}")
    localStorage.setItem("ultrawork-config", JSON.stringify({ ...c, theme: "dark" }))
  })
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)
  await nav(/^知识库$/)
  const activeTab = page.getByRole("tab", { selected: true })
  await activeTab.waitFor({ timeout: 10000 })
  const dark = await activeTab.evaluate((el) => {
    const lum = (c: string) => {
      const [r, g, b] = (c.match(/\d+/g) ?? ["0", "0", "0"]).map(Number)
      const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
    const list = el.closest('[role="tablist"]') as HTMLElement
    const ts = getComputedStyle(el), ls = getComputedStyle(list)
    return {
      isDark: document.documentElement.classList.contains("dark"),
      thumb: ts.backgroundColor, track: ls.backgroundColor, text: ts.color,
      thumbVsTrack: +ratio(ts.backgroundColor, ls.backgroundColor).toFixed(3),
      textVsThumb: +ratio(ts.color, ts.backgroundColor).toFixed(2),
    }
  })
  console.log(`  dark=${dark.isDark} thumb=${dark.thumb} track=${dark.track}`)
  console.log(`  contrast thumb/track=${dark.thumbVsTrack}:1   label/thumb=${dark.textVsThumb}:1`)
  if (!dark.isDark) throw new Error("dark theme did not apply")
  if (dark.thumb === dark.track) throw new Error("dark mode: active tab is indistinguishable from the track (identical background)")
  if (dark.textVsThumb < 4.5) throw new Error(`dark mode: active tab label contrast ${dark.textVsThumb}:1 is below WCAG AA 4.5:1`)
  await page.screenshot({ path: join(SHOTS, `${ENGINE}-settings-tabs-knowledge-dark.png`) })
  checks.push(`dark theme: active tab label ${dark.textVsThumb}:1 (AA pass); thumb/track separation ${dark.thumbVsTrack}:1 ✓`)

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 160)})`)
  verdict = `PASS ✅ [${ENGINE}] — Skills/Connectors/Knowledge share one Radix segmented control; Knowledge filters w/o duplicate cards; MCP forceMount intact; no overflow in en OR zh; keyboard nav works; dark theme legible.`
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
