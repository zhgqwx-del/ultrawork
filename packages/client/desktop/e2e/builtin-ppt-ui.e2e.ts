// builtin-ppt-ui.e2e.ts — end-to-end UI proof for the bundled ppt-master skill,
// driving the REAL React app (Chrome + Vite + real opencode):
//   1. the Settings → Skills built-in tab lists /ppt-master (discovered from the
//      copied skills/builtin dir by a real opencode, through the real api-client)
//   2. the dep badge renders the python3.10+ / python-pptx gap (Tauri invoke shimmed
//      to a controlled DepStatus set) with the "Set up / 引导安装" button
//   3. clicking the button hands off to Home with the composer PREFILLED with the
//      guide prompt (skill name + missing deps + SKILL.md location)
//   4. a dep-complete skill (pdf) shows Ready and has NO guide button
//
// Run:  cd packages/client/desktop && bun run --bun e2e/builtin-ppt-ui.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome") + built opencode sidecar.
//        Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const REPO = join(DESKTOP, "../../..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const SRC = join(REPO, "skills/builtin")
const BUN = process.execPath
const PW = "ppt-ui-pw"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "ppt-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

// Controlled host picture: everything present EXCEPT the two ppt-master probes —
// exactly what a stock macOS (python 3.9, no pip libs) looks like.
const DEPS = [
  { name: "python3", available: true, path: "/usr/bin/python3" },
  { name: "node", available: true, path: "/usr/bin/node" },
  { name: "pandoc", available: true, path: "/usr/bin/pandoc" },
  { name: "soffice", available: true, path: "/usr/bin/soffice" },
  { name: "pdftoppm", available: true, path: "/usr/bin/pdftoppm" },
  { name: "git", available: true, path: "/usr/bin/git" },
  { name: "markdown-exporter", available: true, path: "/usr/bin/markdown-exporter" },
  { name: "python3.10+", available: false, path: null },
  { name: "python-pptx", available: false, path: null },
]

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  if (!existsSync(join(SRC, "ppt-master/SKILL.md"))) throw new Error("skills/builtin/ppt-master missing — run fetch-builtin-skills.ts")
  // simulate the Rust first-boot copy of ALL builtin skills (so pdf is present too)
  cpSync(SRC, join(tmp, ".config/ultrawork/skills/builtin"), { recursive: true })

  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim (controlled dep statuses) ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(({ ws, pw, deps }) => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_skill_dependencies: () => deps,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, deps: DEPS })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)

  console.log("=== navigate Settings → Skills (built-in tab is default) ===")
  await page.getByText(/^(Skills|技能)$/).first().click()
  await page.waitForTimeout(1500)

  // 1. ppt-master card discovered through real opencode + api-client
  const card = page.locator("div.rounded-lg", { hasText: "/ppt-master" }).first()
  await card.waitFor({ state: "visible", timeout: 15000 })
  checks.push("built-in tab lists /ppt-master (real GET /skill through the app) ✓")
  const cardText = (await card.innerText()).replace(/\s+/g, " ")
  if (!/PPTX/i.test(cardText)) throw new Error(`ppt-master card lost its description: ${cardText.slice(0, 160)}`)
  checks.push("card carries the upstream description (PPTX) ✓")

  // 2. dep badge shows exactly the two probed gaps + the guide button
  if (!/(Missing|缺少)/.test(cardText)) throw new Error(`no missing badge on ppt-master card: ${cardText.slice(0, 200)}`)
  if (!cardText.includes("python3.10+") || !cardText.includes("python-pptx"))
    throw new Error(`badge does not list python3.10+/python-pptx: ${cardText.slice(0, 200)}`)
  checks.push("dep badge lists python3.10+ + python-pptx as missing ✓")
  const guideBtn = card.getByRole("button", { name: /Set up|引导安装/ })
  await guideBtn.waitFor({ state: "visible", timeout: 5000 })
  checks.push("guide-install button rendered on the missing badge ✓")

  // 3. a dep-complete built-in skill (pdf) is Ready with NO guide button
  const pdfCard = page.locator("div.rounded-lg", { hasText: "/pdf" }).first()
  const pdfText = (await pdfCard.innerText()).replace(/\s+/g, " ")
  if (!/(Ready|就绪)/.test(pdfText)) throw new Error(`pdf card not Ready under controlled deps: ${pdfText.slice(0, 160)}`)
  if (await pdfCard.getByRole("button", { name: /Set up|引导安装/ }).count()) throw new Error("guide button leaked onto a ready skill")
  checks.push("dep-complete skill (pdf) shows Ready and has no guide button ✓")

  // 4. click guide → Home composer prefilled with the handoff prompt
  await guideBtn.click()
  await page.waitForTimeout(1500)
  const composer = page.getByPlaceholder(/Ask anything|有什么可以帮到你/).first()
  await composer.waitFor({ state: "visible", timeout: 15000 })
  const prefilled = await composer.inputValue()
  if (!prefilled.includes("ppt-master")) throw new Error(`composer not prefilled with skill name: "${prefilled.slice(0, 120)}"`)
  if (!prefilled.includes("python3.10+") || !prefilled.includes("python-pptx"))
    throw new Error(`prefill lost the missing dep names: "${prefilled.slice(0, 160)}"`)
  if (!prefilled.includes(join("skills", "builtin", "ppt-master"))) throw new Error(`prefill lost the SKILL.md location: "${prefilled.slice(0, 200)}"`)
  checks.push("guide button hands off to Home with composer prefilled (name + deps + location) ✓")

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 120)})`)
  verdict = "PASS ✅ — real React UI lists the bundled ppt-master, renders the probed dep gap with a guide button, and hands off a complete install prompt to the Home composer."
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
