// session-reachability.e2e.ts — real-browser proof for the sidebar's session
// window (stability review F6).
//
// The unit tests mock `listSessions`, so they prove the hook SENDS `search` and
// grows `limit` — they cannot prove the SERVER honours either. That gap is the
// same shape as the one that nearly shipped a wrong assumption about
// /session/status, so it gets a real backend: 130 real sessions in a real
// opencode, driven through real Chrome.
//
// Measures:
//   1. the sidebar shows a bounded first window, not everything,
//   2. "load more" reaches sessions the first window did not contain,
//   3. searching finds a session that is OUTSIDE the loaded window — the actual
//      defect (the box used to filter the loaded array, so it reported
//      "no matching sessions" for sessions that existed),
//   4. clearing the box returns to the unfiltered window,
//   5. no uncaught exceptions across the flow.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/session-reachability.e2e.ts
// Needs: system Chrome + built opencode sidecar. Own ports (4197/1521).
// Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser, type Page } from "playwright-core"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "session-reach-pw"
const OC_PORT = process.env.E2E_OPENCODE_PORT ?? "4197"
const VITE_PORT = process.env.E2E_VITE_PORT ?? "1521"
const BASE = `http://localhost:${VITE_PORT}`
const OC_URL = `http://127.0.0.1:${OC_PORT}`
const DEAD_GATEWAY = "14197"
const DEAD_KNOWLEDGE = "14198"
const ACP_PORT = "4099"
const FIXTURE_GAP = new RegExp(`:(${DEAD_GATEWAY}|${DEAD_KNOWLEDGE}|${ACP_PORT})\\b`)

/** More than one page (50) so the window is provably a window. */
const TOTAL = 130
/** Title given to exactly ONE session, created FIRST so it is the oldest. */
const NEEDLE = "zqxj-oldest-needle"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "session-reach-"))
// REALPATH matters: the server stores a session's directory resolved (on macOS
// /var is a symlink to /private/var), and its ?directory= filter is an exact
// string match — so seeding under the unresolved path would silently return an
// empty list and this fixture would "prove" nothing.
mkdirSync(join(tmp, "ws"), { recursive: true })
const ws = realpathSync(join(tmp, "ws"))
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
mkdirSync(join(tmp, ".local/share/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

const ROW = "[data-session-row]"
const LOAD_MORE = "text=加载更早的会话"

async function rowTitles(page: Page): Promise<string[]> {
  return page.$$eval(ROW, (els) => els.map((e) => (e.textContent ?? "").trim()))
}
async function sidebarSettled(page: Page, min = 1) {
  await page.locator(ROW).first().waitFor({ timeout: 20000 })
  await poll("sidebar rows", async () => (await page.locator(ROW).count()) >= min, 20000)
}

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"

try {
  console.log("=== start opencode, seed real sessions ===")
  spawn([OPENCODE, "serve", "--port", OC_PORT], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  await poll("opencode", async () => (await fetch(`${OC_URL}/global/health`, { headers: { authorization: auth } })).ok)

  const headers = { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) }
  // The needle goes in FIRST so it is the oldest by time_updated — i.e. the far
  // side of the window, which is exactly what used to be unreachable.
  const created: string[] = []
  for (let i = 0; i < TOTAL; i++) {
    const title = i === 0 ? NEEDLE : `filler session ${String(i).padStart(3, "0")}`
    const r = await fetch(`${OC_URL}/session`, { method: "POST", headers, body: JSON.stringify({ title }) })
    if (!r.ok) throw new Error(`seed failed at ${i}: ${r.status}`)
    created.push(((await r.json()) as { id: string }).id)
  }
  console.log(`[fixture] seeded ${created.length} sessions; needle is the oldest`)

  // Prove the SERVER-side contract this fix depends on, before believing any UI.
  const firstPage = (await (await fetch(`${OC_URL}/session?roots=true&limit=50&directory=${encodeURIComponent(ws)}`, { headers })).json()) as { title: string }[]
  if (firstPage.length !== 50) throw new Error(`expected a 50-row page, got ${firstPage.length}`)
  if (firstPage.some((s) => s.title === NEEDLE)) throw new Error("needle leaked into the first page — fixture is not testing reachability")
  checks.push(`server: first window is 50 rows and does NOT contain the needle ✓`)

  const searched = (await (await fetch(`${OC_URL}/session?roots=true&limit=50&search=${encodeURIComponent(NEEDLE)}&directory=${encodeURIComponent(ws)}`, { headers })).json()) as { title: string }[]
  if (!searched.some((s) => s.title === NEEDLE)) {
    throw new Error(`server-side search did not return the needle — the whole F6 premise is wrong (got ${searched.length} rows)`)
  }
  checks.push("server: ?search= reaches a session outside the first window ✓")

  console.log("=== vite + chrome ===")
  spawn([BUN, "run", "dev", "--", "--port", VITE_PORT], { E2E_OPENCODE_PORT: OC_PORT, E2E_GATEWAY_PORT: DEAD_GATEWAY, E2E_KNOWLEDGE_PORT: DEAD_KNOWLEDGE }, DESKTOP)
  await poll("vite", async () => (await fetch(`${BASE}/`)).ok)

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  const pageErrors: string[] = []
  page.on("pageerror", (e) => pageErrors.push(String(e)))
  const failedUrls: { url: string; why: string }[] = []
  page.on("requestfailed", (r) => failedUrls.push({ url: r.url(), why: r.failure()?.errorText ?? "?" }))

  await page.addInitScript(({ ws, pw, oc }) => {
    const handlers: Record<string, any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
      check_cli_connectors: () => [], refresh_builtin_skills: () => ({}),
      "plugin:opener|open_url": () => null, "plugin:event|listen": () => 0, "plugin:event|unlisten": () => null,
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => (handlers[c] ? handlers[c](a) : null), transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // @ts-ignore
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: oc, apiUsername: "opencode", apiPassword: pw, language: "zh-Hans" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW, oc: OC_URL })

  await page.goto(BASE, { waitUntil: "domcontentloaded" })
  await sidebarSettled(page, 10)
  await page.waitForTimeout(1200)

  console.log("=== 1. the first window is bounded ===")
  const first = await rowTitles(page)
  if (first.length === 0) throw new Error("no session rows rendered")
  if (first.length >= TOTAL) throw new Error(`expected a bounded window, got all ${first.length} rows`)
  if (first.some((t) => t.includes(NEEDLE))) throw new Error("needle is in the first window — cannot test reachability")
  checks.push(`ui: first window renders ${first.length} rows, needle absent ✓`)

  console.log("=== 2. load more reaches past the first window ===")
  const more = page.locator(LOAD_MORE)
  if ((await more.count()) === 0) throw new Error("no 'load older sessions' control — older sessions stay unreachable")
  await more.first().click()
  await poll("grown window", async () => (await page.locator(ROW).count()) > first.length, 20000)
  const grown = await rowTitles(page)
  checks.push(`ui: "load older" grew the window ${first.length} → ${grown.length} ✓`)

  console.log("=== 3. search reaches OUTSIDE the loaded window ===")
  // Still the grown (100-row) window. The needle is the OLDEST of 130, so it is
  // outside even now — which is the point: the query has to reach the server.
  const beforeSearch = await rowTitles(page)
  if (beforeSearch.some((t) => t.includes(NEEDLE))) throw new Error("needle already loaded — search result would be meaningless")
  console.log(`[state] ${beforeSearch.length} rows loaded, needle not among them`)

  const searchToggle = page.getByRole("button", { name: /search|搜索/i }).first()
  await searchToggle.click()
  const box = page.getByPlaceholder(/搜索会话|Search sessions/i).first()
  await box.fill(NEEDLE)
  await poll(
    "needle found via search",
    async () => (await rowTitles(page)).some((t) => t.includes(NEEDLE)),
    20000,
  )
  checks.push("ui: search surfaced a session the window had never loaded ✓")

  console.log("=== 4. clearing the box restores the window ===")
  await box.fill("")
  // Back to a FIRST window (50), not the 100 that was loaded before searching:
  // a new query resets paging by design, and clearing is a new query. The
  // "load older" control is right there, so this is a fresh start, not a loss.
  await poll("window restored", async () => {
    const titles = await rowTitles(page)
    return titles.length >= 50 && !titles.some((t) => t.includes(NEEDLE))
  }, 20000)
  const restored = await rowTitles(page)
  checks.push(`ui: clearing the query restored the unfiltered window (${restored.length} rows, needle gone) ✓`)

  const inGap = (u: string) => FIXTURE_GAP.test(u) || /\/(channel|knowledge|orchestration|acp)\b/.test(new URL(u, BASE).pathname)
  const unexpected = failedUrls.filter((f) => !inGap(f.url) && !/ABORTED/i.test(f.why))
  if (unexpected.length) throw new Error(`network failures outside the fixture gap: ${[...new Set(unexpected.map((f) => `${f.url} (${f.why})`))].slice(0, 5).join(", ")}`)
  if (pageErrors.length) throw new Error(`uncaught exceptions: ${pageErrors.slice(0, 3).join(" | ")}`)
  checks.push("no uncaught exceptions across the whole flow ✓")

  verdict = "PASS"
} catch (err) {
  verdict = "FAIL"
  console.error("\n✗", err instanceof Error ? err.message : err)
} finally {
  console.log(`\n===== ${verdict} =====`)
  for (const c of checks) console.log(" ✓", c)
  await browser?.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  process.exit(verdict === "PASS" ? 0 : 1)
}
