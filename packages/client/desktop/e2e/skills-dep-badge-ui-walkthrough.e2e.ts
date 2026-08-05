// skills-dep-badge-ui-walkthrough.e2e.ts — real-browser proof for the OPTIONAL
// dependency badge added 2026-08-05 (059 §六·补十·续 ③).
//
// Why this file exists: the optional deps were declared, probed, and rendered
// NOWHERE for a whole phase — `isOptionalDep`'s only reader was `missingDeps`,
// which filters them out. The unit tests cover `unavailableFeatures()` (a pure
// function); NOTHING covered the rendering, and `settings-skills.test.tsx` never
// mentioned a badge at all. So the fix for "declared but invisible" shipped with
// the same class of hole it was fixing.
//
// What only a real browser can prove (jsdom cannot):
//   1. the chip actually appears in the built page, next to "Ready",
//   2. it names CAPABILITIES (PDF / DOCX / URL …), not package names — the whole
//      point of the grouping; `curl_cffi` means nothing to the person reading it,
//   3. it DISAPPEARS when every optional dep is present (a chip that is always
//      there is noise, and a test of the pure function cannot see that),
//   4. it costs no horizontal overflow — the real risk, measured not eyeballed:
//      the chip is `shrink-0`, its worst case is a fresh machine with none of the
//      seven optional groups installed (50 CJK chars / 54 Latin), and this app
//      already has a recorded overflow defect at narrow widths (gotchas §13.1).
//      Checked at 1200 / 900 / 700px, in BOTH locales — CJK is not automatically
//      narrower, full-width glyphs can make zh the wider of the two.
//
// Backends: opencode is REAL (serves /config); /skill is route-stubbed so the
// list is deterministic. React, Tailwind and browser layout are real.
// `check_skill_dependencies` is stubbed PER SCENARIO — that command is the only
// input the badge has, so stubbing it is how the three states are reached at all.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/skills-dep-badge-ui-walkthrough.e2e.ts
//       E2E_ENGINE=webkit ...   (the engine family Tauri renders with on macOS)
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
const PW = "dep-badge-pw"
const SHOTS = process.env.E2E_SHOTS ?? tmpdir()

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const SKILLS = [
  { name: "deckcraft", description: "Build slide decks from a topic or a source document", location: "/res/skills/builtin/deckcraft/SKILL.md" },
  { name: "docx", description: "Read and edit Word documents", location: "/res/skills/builtin/docx/SKILL.md" },
]

// deckcraft's dependency list, split the way use-skill-deps.ts declares it.
const CORE = ["python3.10+", "python-pptx", "pillow", "chrome-or-edge"]
const OPTIONAL = ["node", "pdfplumber", "pypdf", "pypdfium2", "mammoth", "ebooklib",
                  "nbconvert", "markdownify", "beautifulsoup4", "requests", "openpyxl", "curl_cffi"]
const DOCX_DEPS = ["python3", "lxml", "soffice"]
const dep = (names: string[], available: boolean) => names.map((name) => ({ name, available }))
/** The list shows a skill as its slash command, so the visible text is `/name`. */
const NAME_RE = (name: string) => new RegExp(`^/?${name}$`)

// The three states the badge has to distinguish. The first is the DEFAULT on a
// machine nobody has prepared — which is why it is also the worst case for width.
const SCENARIOS = [
  {
    id: "fresh", title: "core present, every optional missing (a fresh machine)",
    deps: [...dep([...CORE, ...DOCX_DEPS], true), ...dep(OPTIONAL, false)],
    expectChip: true, expectLabels: ["PDF", "DOCX", "EPUB", "IPYNB", "XLSX", "URL", "PPTX-edit"],
  },
  {
    id: "equipped", title: "everything present",
    deps: [...dep([...CORE, ...OPTIONAL, ...DOCX_DEPS], true)],
    expectChip: false, expectLabels: [],
  },
  {
    id: "one-package", title: "only beautifulsoup4 missing (shared by four readers)",
    deps: [...dep([...CORE, ...DOCX_DEPS], true),
           ...dep(OPTIONAL.filter((d) => d !== "beautifulsoup4"), true),
           ...dep(["beautifulsoup4"], false)],
    expectChip: true, expectLabels: ["DOCX", "EPUB", "IPYNB", "URL"],
  },
]

const tmp = mkdtempSync(join(tmpdir(), "dep-badge-"))
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
  browser = ENGINE === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true })

  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  }

  /** A page whose dependency probe answers with `deps`, in `lang`, at `width`. */
  const open = async (deps: unknown[], lang: string, width: number) => {
    const page = await browser!.newPage({ viewport: { width, height: 900 } })
    const json = (body: string) => (r: import("playwright-core").Route) =>
      r.request().method() === "OPTIONS"
        ? r.fulfill({ status: 204, headers: CORS })
        : r.fulfill({ status: 200, contentType: "application/json", headers: CORS, body })
    await page.route("**/skill", json(JSON.stringify(SKILLS)))
    await page.route("**/command", json("[]"))
    await page.addInitScript(({ ws, pw, deps, lang }) => {
      const handlers: Record<string, any> = {
        check_directory_exists: () => true, ensure_default_workspace: () => ws,
        login_shell_path: () => "", scan_workspace_changes: () => [],
        get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
        check_cli_connectors: () => [],
        refresh_builtin_skills: () => ({ bundled: ["deckcraft", "docx"], shadowed: [], changed: false }),
        check_skill_dependencies: () => deps,
        "plugin:opener|open_url": () => null,
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "http://127.0.0.1:4096", apiUsername: "opencode", apiPassword: pw, language: lang }))
      localStorage.setItem("workspace_path", ws)
    }, { ws, pw: PW, deps, lang })
    await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
    const skills = page.locator("nav").getByText(/^(Skills|技能)$/).first()
    await skills.waitFor({ state: "visible", timeout: 20000 })
    await skills.click()
    // ⚠️ The list renders the skill as a COMMAND — the visible text is `/deckcraft`,
    // not `deckcraft`. An exact match found nothing and the first run read as "the
    // badge never rendered"; the page dump showed it had been there all along.
    try {
      await page.getByText(NAME_RE("deckcraft")).first().waitFor({ state: "visible", timeout: 20000 })
    } catch (e) {
      const dump = (await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1200)
      await page.screenshot({ path: join(SHOTS, "debug-no-deckcraft.png"), fullPage: true })
      throw new Error(`deckcraft never rendered. page text: ${dump}`)
    }
    await page.waitForTimeout(700)   // dep probe resolves, badge swaps out of "Checking"
    return page
  }

  /** The badge row for a skill: the element that holds the name and the chips. */
  const rowOf = (page: import("playwright-core").Page, skill: string) =>
    page.getByText(NAME_RE(skill)).first().locator("xpath=ancestor::*[self::li or self::div][3]")

  console.log("\n=== 1. the three states, at 1200px, en ===")
  for (const sc of SCENARIOS) {
    const page = await open(sc.deps, "en", 1200)
    const row = rowOf(page, "deckcraft")
    const text = (await row.innerText()).replace(/\s+/g, " ")
    const hasChip = /Optional:/.test(text)
    console.log(`  [${sc.id}] chip=${hasChip}  row="${text.slice(0, 150)}"`)
    if (hasChip !== sc.expectChip)
      throw new Error(`[${sc.id}] expected chip=${sc.expectChip}, got ${hasChip} — row text: ${text}`)
    for (const label of sc.expectLabels)
      if (!text.includes(label)) throw new Error(`[${sc.id}] chip does not name ${label}: ${text}`)
    // It must NOT leak package names — the grouping exists so a reader sees the
    // capability. A chip reading "curl_cffi, ebooklib" is the thing being avoided.
    for (const pkg of ["curl_cffi", "ebooklib", "markdownify", "beautifulsoup4"])
      if (text.includes(pkg)) throw new Error(`[${sc.id}] chip leaks the package name ${pkg}: ${text}`)
    // Ready must still be shown: the optional chip is additional information, not
    // a replacement for the readiness verdict.
    if (!/Ready/.test(text)) throw new Error(`[${sc.id}] the readiness verdict disappeared: ${text}`)
    await page.screenshot({ path: join(SHOTS, `${ENGINE}-dep-badge-${sc.id}.png`), fullPage: false })
    await page.close()
    checks.push(`[${sc.id}] chip=${hasChip} naming ${sc.expectLabels.join("/") || "(none)"}, no package names, Ready intact ✓`)
  }

  console.log("\n=== 2. the chip must not COST layout, measured against its own control ===")
  // ⚠️ The criterion is a DIFFERENCE, not an absolute. This settings row already
  // spills at narrow widths without any chip at all (a recorded defect, gotchas
  // §13.1), so "it spills at 700px" says nothing about whose fault that is —
  // correlation is not cause. Each width is therefore measured twice: with the
  // worst-case chip (a fresh machine, seven groups) and with none (everything
  // installed). The chip is only allowed to cost nothing.
  const worst = SCENARIOS[0]      // seven groups on one chip
  const control = SCENARIOS[1]    // same row, no chip at all
  const measure = async (deps: unknown[], lang: string, width: number) => {
    const page = await open(deps, lang, width)
    const m = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
    }))
    const row = rowOf(page, "deckcraft")
    const spill = await row.evaluate((el) => {
      const r = el.getBoundingClientRect()
      let worstSpill = 0
      for (const child of el.querySelectorAll("*")) {
        const c = child.getBoundingClientRect()
        if (c.width > 0) worstSpill = Math.max(worstSpill, c.right - r.right)
      }
      return Math.round(worstSpill)
    })
    const chip = await row.getByText(/Optional:|可选未装/).first().boundingBox().catch(() => null)
    return { page, m, spill, chipWidth: chip ? Math.round(chip.width) : 0 }
  }
  for (const lang of ["en", "zh"]) {
    for (const width of [1200, 900, 700]) {
      const a = await measure(worst.deps, lang, width)
      const b = await measure(control.deps, lang, width)
      const cost = a.spill - b.spill
      console.log(`  ${lang} @${width}px: spill with chip=${a.spill}px, without=${b.spill}px, ` +
                  `cost=${cost >= 0 ? "+" : ""}${cost}px, chip=${a.chipWidth}px, ` +
                  `page overflow doc=${a.m.doc}/${b.m.doc}`)
      if (a.m.doc > b.m.doc || a.m.body > b.m.body)
        throw new Error(`${lang} @${width}px: the chip made the PAGE scroll horizontally ` +
                        `(doc ${b.m.doc} -> ${a.m.doc})`)
      if (cost > 1)
        throw new Error(`${lang} @${width}px: the chip costs ${cost}px of overflow ` +
                        `(row spills ${b.spill}px without it, ${a.spill}px with it) — ` +
                        `it is shrink-0 and cannot give way`)
      await a.page.screenshot({ path: join(SHOTS, `${ENGINE}-dep-badge-${lang}-${width}.png`) })
      await a.page.close(); await b.page.close()
      checks.push(`${lang} @${width}px: chip costs ${cost >= 0 ? "+" : ""}${cost}px ` +
                  `(row spill ${b.spill} -> ${a.spill}, chip ${a.chipWidth}px) ✓`)
    }
  }

  verdict = `PASS ✅ [${ENGINE}] — the optional-dependency chip renders, names capabilities not packages, disappears when nothing is missing, and costs no overflow at 1200/900/700px in en and zh.`
} catch (e) {
  verdict = `FAIL ❌ — ${(e as Error).message}`
} finally {
  console.log("\n--- checks ---"); for (const c of checks) console.log("  •", c)
  console.log(`\n(screenshots in ${SHOTS})`)
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
