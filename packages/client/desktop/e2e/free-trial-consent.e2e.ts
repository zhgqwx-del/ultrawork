// free-trial-consent.e2e.ts — real-browser walkthrough of the ADR-057 free-trial flow.
//
// Runs the real Vite app in Chromium against a REAL, FRESHLY-CONFIGURED opencode (no providers
// configured → only the OpenCode Zen free models auto-connect with the anonymous "public" key)
// and hits the LIVE Zen gateway. So this exercises the whole chain end-to-end, not mocks:
//
//   A. Fresh install + send with no model  → the consent card appears (privacy-off gate fired).
//   B. Click "Enable free trial"           → a free Zen model is seeded AND the message is
//                                             auto-resent; a real reply streams back from Zen.
//   C. The model selector badges free Zen models as "Free".
//   D. Settings → Models shows the "Free trial enabled" revoke toggle; disabling clears consent.
//
// Consumes a small amount of the shared anonymous free quota (real network to opencode.ai/zen).
//
//   cd packages/client/desktop && bun run --bun e2e/free-trial-consent.e2e.ts
// Needs: system Chrome; built opencode binary; network to opencode.ai.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "freetrial-pw"
const OC = 4296 // NOT 4096: the user's real app may be holding that port
const MARKER = "PINEAPPLE7391" // ask the free model to echo this — proves a real reply came back

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "freetrial-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
// FRESH install: an empty config. No `model`, no `provider` → opencode only auto-connects the
// OpenCode Zen free models (anonymous apiKey "public"), which is exactly the shape ADR-057 targets.
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({}))

const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
const results: Record<string, boolean> = {}

try {
  console.log("=== start opencode (fresh config) + vite ===")
  const oc = spawn([OPENCODE, "serve", "--port", String(OC)], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  void (async () => {
    for await (const line of (oc.stderr as ReadableStream).pipeThrough(new TextDecoderStream())) {
      for (const l of String(line).split("\n")) if (l.trim()) console.log(`  [opencode] ${l.slice(0, 220)}`)
    }
  })()
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  // Sanity: the fresh sidecar really does auto-connect opencode free models.
  const prov = await (await fetch(`http://127.0.0.1:${OC}/provider`, { headers: { authorization: auth } })).json()
  const connected: string[] = prov.connected ?? []
  console.log(`  [provider] connected=${JSON.stringify(connected)}`)
  results.fresh_opencode_zen_connected = connected.includes("opencode")

  spawn([BUN, "run", "dev"], { E2E_OPENCODE_PORT: String(OC) }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  page.on("console", (m) => {
    const t = m.text()
    if (/SSE error|Failed to load resource/.test(t)) return
    console.log(`  [browser:${m.type()}] ${t.slice(0, 200)}`)
  })
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message.slice(0, 200)}`))

  // Tauri shim: workspace stubs + sidecar wiring + an in-memory free-trial consent store
  // (the real app persists consent via Rust commands; in the browser we back them with a var).
  await page.addInitScript(
    ({ ws, pw, oc }) => {
      // Consent backed by localStorage so it survives the page reload the settings step does
      // (an in-memory var would reset when addInitScript re-runs on navigation).
      const readConsent = () => JSON.parse(localStorage.getItem("__e2e_consent") || '{"consented":false}')
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => [],
        get_sidecar_ports: () => ({ opencode: oc, gateway: 4297, knowledge: 4298, acp: 4299 }),
        get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
        // ADR-057 consent commands — backed by localStorage for the e2e.
        get_free_trial_consent: () => readConsent(),
        set_free_trial_consent: (a: any) => { localStorage.setItem("__e2e_consent", JSON.stringify({ consented: true, seededModel: a?.seededModel ?? undefined, seededSmallModel: a?.seededSmallModel ?? undefined })); return null },
        clear_free_trial_consent: () => { localStorage.setItem("__e2e_consent", JSON.stringify({ consented: false })); return null },
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = {
        invoke: async (c: string, a: any) => (handlers[c] ? handlers[c](a) : null),
        transformCallback: (cb: any) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
      localStorage.setItem("workspace_path", ws)
    },
    { ws, pw: PW, oc: OC },
  )

  for (let i = 0; ; i++) {
    try { await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3000)
  const body = async () => await page.locator("body").innerText()

  const cardTitle = () => page.getByText(/Try a free model|试用一个免费模型/)
  const enableBtn = () => page.getByRole("button", { name: /Enable free trial|启用免费试用/ })
  const send = async () => {
    const cta = page.getByRole("button", { name: /马上开始|Start Now/i }).first()
    if (await cta.count().then((n) => n > 0).catch(() => false) && await cta.isEnabled().catch(() => false)) {
      await cta.click(); return
    }
    await page.getByLabel(/Send message|发送消息/i).first().click()
  }

  // ---------- A. fresh install + send → consent card appears ----------
  console.log("\n=== A: fresh install, send with no model → consent card ===")
  await page.locator("textarea").first().fill(`Say the word ${MARKER} and nothing else.`)
  await send()
  await cardTitle().first().waitFor({ state: "visible", timeout: 15000 })
  results.A_consent_card_appears = await cardTitle().first().isVisible()
  console.log(`[A] consent card visible: ${results.A_consent_card_appears}`)

  // ---------- B. enable → seed + auto-resend → REAL reply from Zen ----------
  console.log("\n=== B: enable free trial → real Zen reply ===")
  await enableBtn().first().click()
  // Card closes and we land in a session; the auto-resend fires with the seeded free model.
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  results.B_card_closed_after_enable = (await cardTitle().count()) === 0
  // Real network to Zen — give it room. The model was asked to echo MARKER.
  await poll("real Zen reply contains marker", async () => (await body()).includes(MARKER), 90000)
  results.B_real_zen_reply = (await body()).includes(MARKER)
  console.log(`[B] card closed: ${results.B_card_closed_after_enable}, real reply w/ marker: ${results.B_real_zen_reply}`)

  // ---------- C. model selector badges free Zen models ----------
  console.log("\n=== C: free badge in model selector ===")
  // The composer's model button is the one carrying the Cpu icon; open its popover.
  await page.locator("button:has(svg.lucide-cpu)").first().click().catch(() => {})
  await page.waitForTimeout(1500)
  results.C_free_badge = /(\bFree\b|免费)/.test(await body())
  console.log(`[C] free badge present in selector: ${results.C_free_badge}`)
  await page.keyboard.press("Escape").catch(() => {})

  // ---------- D. settings revoke toggle ----------
  console.log("\n=== D: settings → models revoke toggle ===")
  // In-app navigation (NOT a reload): open the model selector and click "Manage Models", which
  // routes client-side straight to Settings › Models (section state), keeping consent state alive.
  await page.locator("button:has(svg.lucide-cpu)").first().click().catch(() => {})
  await page.waitForTimeout(800)
  await page.getByRole("button", { name: /Manage Models|管理模型/ }).first().click().catch(() => {})
  await page.waitForURL(/\/settings/, { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(2000)
  const hasToggle = /Free trial enabled|免费试用已启用/.test(await body())
  results.D_revoke_toggle_shown = hasToggle
  console.log(`[D1] revoke toggle shown: ${hasToggle}`)
  if (hasToggle) {
    await page.getByRole("button", { name: /^Disable$|^关闭$/ }).first().click().catch(() => {})
    await page.waitForTimeout(1500)
    results.D_revoke_clears = !/Free trial enabled|免费试用已启用/.test(await body())
    console.log(`[D2] toggle gone after disable: ${results.D_revoke_clears}`)
  }

  const allPass = Object.values(results).every(Boolean)
  verdict = allPass
    ? "PASS ✅ — fresh install shows the consent card, enabling seeds a free Zen model + gets a real reply, badge + revoke work"
    : `FAIL ❌ — ${JSON.stringify(results)}`
} catch (e) {
  verdict = `ERROR: ${(e as Error).message}`
} finally {
  console.log("\n=== results:", JSON.stringify(results, null, 2))
  console.log("=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
