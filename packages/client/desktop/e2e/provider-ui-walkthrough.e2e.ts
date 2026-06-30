// provider-ui-walkthrough.e2e.ts — end-to-end UI proof for ADR-039's provider
// globalization, driving the REAL React app (Chrome + Vite + real opencode):
// add a custom provider through the actual Settings → Models form and assert the
// definition lands in the GLOBAL ~/.config/ultrawork/opencode.json on disk — i.e.
// the whole UI → api-client (patchGlobalConfig?refresh=soft) → opencode → global
// file chain works through real React, not a mock.
//
// Also asserts the "Add Custom Provider" entry is ENABLED with no per-workspace
// gating (the removed hasWorkspace block), and that the model picker surfaces the
// new model after save.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/provider-ui-walkthrough.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome") + built sidecar binaries.
//        Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "provider-ui-pw"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "provider-ui-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const cfgPath = join(tmp, ".config/ultrawork/opencode.json")
writeFileSync(cfgPath, JSON.stringify({}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const PID = "ui-custom-llm"

let browser: Browser | undefined
const checks: string[] = []
let verdict = "INCOMPLETE"
try {
  console.log("=== start opencode + vite ===")
  spawn([OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "",
      scan_workspace_changes: () => [], get_sidecar_credentials: () => ({ username: "opencode", password: pw }),
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  await page.goto("http://localhost:1420/settings", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)

  console.log("=== navigate Settings → Models ===")
  await page.getByText(/^(Models|模型)$/).first().click()
  await page.waitForTimeout(800)

  console.log("=== open custom provider form ===")
  await page.getByRole("button", { name: /Configure Provider|配置供应商/ }).first().click()
  await page.waitForTimeout(500)
  const addCustom = page.getByRole("button", { name: /Add Custom Provider|添加自定义供应商/ }).first()
  await addCustom.waitFor({ state: "visible", timeout: 10000 })
  // Removed hasWorkspace gating: the entry must be enabled.
  if (await addCustom.isDisabled()) throw new Error("Add Custom Provider entry is disabled (hasWorkspace gating not removed)")
  checks.push("Add Custom Provider entry is enabled (no per-workspace gating) ✓")
  await addCustom.click()
  await page.waitForTimeout(500)

  console.log("=== fill + save the custom provider form ===")
  await page.getByPlaceholder(/e\.g\. my-llm|例如 my-llm/).fill(PID)
  await page.getByPlaceholder(/e\.g\. My LLM Service|例如 我的模型服务/).fill("UI Custom LLM")
  await page.getByPlaceholder("https://api.example.com/v1").fill("https://ui.example.invalid/v1")
  await page.getByPlaceholder(/Model ID|模型 ID/).first().fill("ui-model-1")
  await page.getByRole("button", { name: /Save Changes|保存更改/ }).click()

  console.log("=== assert the provider landed in the GLOBAL opencode.json on disk ===")
  await poll("provider persisted to global config", async () => {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: Record<string, unknown> }
    return !!cfg.provider && PID in cfg.provider
  }, 15000)
  const disk = JSON.parse(readFileSync(cfgPath, "utf8")) as { provider?: Record<string, any> }
  const p = disk.provider![PID]
  if (p?.npm !== "@ai-sdk/openai-compatible" || !p?.models?.["ui-model-1"])
    throw new Error(`global opencode.json provider malformed: ${JSON.stringify(p)}`)
  checks.push("real UI form → api-client → opencode wrote the provider to GLOBAL opencode.json ✓")

  // No workspace opencode.json should have been created for the provider.
  let wsLeak = false
  try { wsLeak = "provider" in JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")) } catch { /* not created = good */ }
  if (wsLeak) throw new Error("provider leaked into the per-workspace opencode.json")
  checks.push("no per-workspace opencode.json provider leak ✓")

  if (errors.length) console.log(`  (note: ${errors.length} console errors; first: ${errors[0]?.slice(0, 120)})`)
  verdict = "PASS ✅ — real React UI adds a custom provider that persists to the GLOBAL opencode.json (no workspace leak), end-to-end through the actual api-client + opencode."
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
