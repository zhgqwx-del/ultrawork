// plan-panel-ui.e2e.ts — browser walkthrough of the right-sidebar Task Plan
// panel (ADR-038, Phase 3) on the REAL app: mock-llm-todowrite → real opencode
// (runs built-in todowrite) → Vite → headless Chrome. Proves the structured plan
// renders in the UI (not just the data layer), driven by a live plan.updated.
//
// Flow: send a prompt → opencode executes todowrite → open the right sidebar →
// assert the "Task Plan" section shows the three structured steps the model wrote
// (content is language-independent).
//
//   cd packages/client/desktop && bun run --bun e2e:plan-ui   # exit 0 = PASS
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
const PW = "plan-ui-pw"; const LLM = 8090; const OC = 4096

const STEPS = ["Write the failing test", "Implement the fix", "Run the suite"]

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "plan-ui-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
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
  console.log("=== start mock-llm-todowrite + opencode + vite ===")
  spawn([BUN, "run", join(DIR, "mock-llm-todowrite.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log("=== chrome + tauri-invoke shim ===")
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  // Vite's first navigation can ERR_ABORT while it pre-bundles deps — retry.
  for (let i = 0; ; i++) {
    try { await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3000)

  console.log("=== send prompt → opencode runs todowrite ===")
  // Enter-to-send is the robust path (chat-input sends on Enter without Shift);
  // fall back to the home CTA button only if the route hasn't changed. A bare
  // getByRole("button", {name:/开始/}).click() is fragile — it auto-waits on the
  // CTA's `disabled={!canSend}` state and can race the controlled-input update.
  await page.locator("textarea").first().fill("make a plan")
  await page.waitForTimeout(300)
  await page.locator("textarea").first().press("Enter")
  await page.waitForURL(/\/session\//, { timeout: 10000 }).catch(async () => {
    await page.getByRole("button", { name: /马上开始|开始|发送|send/i }).first().click().catch(() => {})
    await page.waitForURL(/\/session\//, { timeout: 12000 })
  })
  const sid = page.url().split("/session/")[1]

  // Gate on the server actually having persisted the todos (plan produced).
  await poll("todos persisted", async () => {
    const todos = await (await fetch(`http://127.0.0.1:${OC}/session/${sid}/todo`, { headers: { authorization: auth, "x-opencode-directory": ws } })).json().catch(() => [])
    return Array.isArray(todos) && todos.length === STEPS.length
  }, 30000)

  // The mock LLM runs the whole turn faster than the freshly-mounted session page
  // can subscribe, so its live `plan.updated` fires before anyone is listening AND
  // the mount-time `getPlan()` snapshot resolved before todowrite persisted — the
  // UI lands on an empty plan while the server already has the todos. A real model
  // is slow enough that `plan.updated` arrives after subscription. Reload now that
  // the todos ARE persisted: `useSessionPlan` re-hydrates from the snapshot
  // (`/session/{id}/todo`) on mount, which is the lossless switch-back path.
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForURL(/\/session\//, { timeout: 10000 })
  await page.waitForTimeout(1500)

  console.log("=== ensure right sidebar open → assert Task Plan panel ===")
  // A non-empty plan auto-reveals the right sidebar (hasPlan auto-open, ADR-038 /
  // Session.tsx). So DON'T blindly toggle — that would close the auto-opened
  // sidebar. Open it only if it isn't already showing.
  if ((await page.locator('[data-testid="right-sidebar"]').count()) === 0) {
    await page.getByLabel(/Toggle right sidebar|切换右侧边栏/).click()
  }
  await page.locator('[data-testid="right-sidebar"]').first().waitFor({ timeout: 5000 })
  await page.waitForTimeout(1200)
  const body = async () => await page.locator("body").innerText()

  // The plan section is defaultOpen — its steps should be visible immediately.
  const text = await body()
  const stepsShown = STEPS.filter((s) => text.includes(s))
  const headerShown = /任务规划|Task Plan/.test(text)
  console.log(`[ui] steps shown: ${stepsShown.length}/${STEPS.length} ${JSON.stringify(stepsShown)}`)
  console.log(`[ui] plan header=${headerShown}`)

  const ok = stepsShown.length === STEPS.length && headerShown
  verdict = ok
    ? "PASS ✅ — Task Plan panel renders all structured steps"
    : `FAIL ❌ — steps=${stepsShown.length}/${STEPS.length} planHeader=${headerShown}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
