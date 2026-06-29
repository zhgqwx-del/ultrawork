// plan-switchback.e2e.ts — proves the Task Plan panel survives switching away
// from a running turn and back (ADR-038, the discussions/022 scenario for plans).
// A multi-step todowrite turn (mock-llm-todowrite-steps) runs on real opencode;
// mid-turn we SPA-navigate to Home and back, then assert the panel is NOT empty
// right after switch-back (REST getPlan hydration) and ends fully completed.
//
//   cd packages/client/desktop && bun run --bun e2e/plan-switchback.e2e.ts
// Needs: system Chrome; built opencode binary. Only the PLAN section is opened,
// so the rendered "x / y" count is unambiguously the plan's.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "plan-swb-pw"; const LLM = 8090; const OC = 4096
const STEPS = ["Set up project", "Write core module", "Verify it runs"]

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}
const planCount = (text: string) => { const m = text.match(/(\d+)\s*\/\s*(\d+)/); return m ? { done: +m[1], total: +m[2] } : null }
const stepsShown = (text: string) => STEPS.filter((s) => text.includes(s)).length

const tmp = mkdtempSync(join(tmpdir(), "plan-swb-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
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
  console.log("=== start mock-llm-steps + opencode + vite ===")
  spawn([BUN, "run", join(DIR, "mock-llm-todowrite-steps.ts")], { MOCK_LLM_PORT: String(LLM), MOCK_LLM_STEP_DELAY_MS: "2500" })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })
  for (let i = 0; ; i++) {
    try { await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3000)
  const body = async () => await page.locator("body").innerText()

  console.log("=== start a multi-step plan turn ===")
  await page.locator("textarea").first().fill("plan and do a 3-step task with todowrite")
  await page.getByRole("button", { name: /马上开始|开始|send/i }).first().click()
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  const sid = page.url().split("/session/")[1]
  // Open the right sidebar (global state — survives SPA nav). Only the Plan
  // section is defaultOpen, so its x/y count is the only one in the DOM.
  await page.getByLabel(/Toggle right sidebar|切换右侧边栏/).click()
  await poll("plan visible mid-turn", async () => stepsShown(await body()) === STEPS.length, 30000)
  const before = planCount(await body())
  console.log(`[01] before switch: steps=${stepsShown(await body())}/3, count=${before?.done}/${before?.total}`)

  console.log("=== SPA nav → Home (4s, turn keeps running) → back ===")
  const nav = (p: string) => page.evaluate((x) => { history.pushState({}, "", x); dispatchEvent(new PopStateEvent("popstate")) }, p)
  await nav("/"); await page.waitForTimeout(4000)
  await nav(`/session/${sid}`); await page.waitForURL(/\/session\//, { timeout: 10000 })
  await page.waitForTimeout(1200) // short — must reflect hydration, not a later live tick
  const back = planCount(await body()); const backSteps = stepsShown(await body())
  console.log(`[02] right after switch-back: steps=${backSteps}/3, count=${back?.done}/${back?.total}`)

  console.log("=== wait for completion ===")
  await poll("turn complete (3/3)", async () => { const c = planCount(await body()); return c?.done === 3 && c?.total === 3 }, 40000).catch(() => {})
  const fin = planCount(await body())
  const serverTodos = await (await fetch(`http://127.0.0.1:${OC}/session/${sid}/todo`, { headers: { authorization: auth, "x-opencode-directory": ws } })).json().catch(() => [])
  const serverDone = Array.isArray(serverTodos) ? serverTodos.filter((t: any) => t.status === "completed").length : -1
  console.log(`[03] final: count=${fin?.done}/${fin?.total}; server completed=${serverDone}/3`)

  // Not lost: panel was non-empty with all 3 steps immediately after switch-back,
  // it did not regress, and it ends fully completed in sync with the server.
  const notLost = backSteps === STEPS.length && back !== null && back.total === 3
  const noRegress = before !== null && back !== null && back.done >= before.done
  const completed = fin?.done === 3 && fin?.total === 3 && serverDone === 3
  verdict = notLost && noRegress && completed
    ? "PASS ✅ — plan survived mid-turn switch-back (no empty/reset), progressed, and completed in sync"
    : `FAIL ❌ — notLost=${notLost} noRegress=${noRegress} completed=${completed} (before=${before?.done} back=${back?.done} fin=${fin?.done})`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
