// plan-realmodel-ui.e2e.ts — REAL-MODEL browser walkthrough of the Task Plan
// panel (ADR-038). Uses the user's real Myqwen (qwen3.7-max via DashScope) so a
// real LLM decides to call the built-in `todowrite` tool. Proves the whole stack
// end-to-end with a real model + real opencode + real Chrome/Vite:
//   real qwen → todowrite → todo.updated → normalize → plan.updated →
//   useSessionPlan → PlanPanel.
//
// The model's exact wording is non-deterministic, so we assert STRUCTURE (a plan
// with >=2 steps renders under the Task Plan header), not content.
//
//   cd packages/client/desktop && bun run --bun e2e/plan-realmodel-ui.e2e.ts
// Needs: system Chrome; built opencode binary; ~/.local/share/ultrawork/auth.json
// with a `myqwen` api key (the user's real DashScope key).
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "plan-rm-pw"; const OC = 4096

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in auth.json")
  return auth.myqwen.key as string
})()
const BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
const MODEL = "qwen3.7-max"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 90000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 400)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "plan-rm-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: `myqwen/${MODEL}`,
  provider: { myqwen: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: BASE, apiKey: KEY }, models: { [MODEL]: { id: MODEL, name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
try {
  console.log("=== start opencode + vite (real qwen3.7-max) ===")
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

  console.log("=== send a planning prompt to the real model ===")
  await page.locator("textarea").first().fill(
    "Use the todowrite tool to create a task plan (at least 3 steps) for adding a dark-mode toggle to a React app. Just write the plan with todowrite; do not implement anything.",
  )
  await page.getByRole("button", { name: /马上开始|开始|send/i }).first().click()
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  const sid = page.url().split("/session/")[1]

  // Wait until the real model actually wrote todos server-side.
  let serverTodos: any[] = []
  await poll("real model wrote todos", async () => {
    serverTodos = await (await fetch(`http://127.0.0.1:${OC}/session/${sid}/todo`, { headers: { authorization: auth, "x-opencode-directory": ws } })).json().catch(() => [])
    return Array.isArray(serverTodos) && serverTodos.length >= 2
  }, 120000)
  console.log(`[server] real model wrote ${serverTodos.length} todos:`, serverTodos.map((t) => `${t.status}:${t.content}`.slice(0, 60)))

  console.log("=== open right sidebar → assert Task Plan panel ===")
  await page.getByLabel(/Toggle right sidebar|切换右侧边栏/).click()
  await page.waitForTimeout(1500)
  const text = await page.locator("body").innerText()
  const headerShown = /任务规划|Task Plan/.test(text)
  // Each server todo's content should appear in the rendered panel.
  const shown = serverTodos.filter((t) => typeof t.content === "string" && text.includes(t.content))
  console.log(`[ui] header=${headerShown}, steps shown ${shown.length}/${serverTodos.length}`)

  const ok = headerShown && shown.length === serverTodos.length && serverTodos.length >= 2
  verdict = ok
    ? `PASS ✅ — real qwen wrote a ${serverTodos.length}-step plan; panel rendered all of them`
    : `FAIL ❌ — header=${headerShown} shown=${shown.length}/${serverTodos.length}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
