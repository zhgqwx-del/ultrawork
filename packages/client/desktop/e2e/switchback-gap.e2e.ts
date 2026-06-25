// Switch-back streamed-text gap harness (docs/discussions/022 Issue 1).
//
// Verifies, on the REAL opencode path (which has the persistence lag that causes
// the bug — the ACP path is immune and can't reproduce it), that switching away
// from a streaming turn and back loses NO answer text. Drives:
//   mock-llm (streams M001..MNN markers) → real opencode → Vite → headless Chrome.
// Switches away (SPA nav) mid-stream for a few seconds, then back, and asserts the
// answer's marker sequence is CONTIGUOUS (no gap) both right after switch-back and
// at completion.
//
// Negative control (how this was proven to detect the bug, not run by default):
// temporarily no-op the global message-cache listener in use-sessions
// (`applyMessageEventToCache`) — the harness then FAILS with a gap at switch-back
// (firstGap != null), confirming the listener is exactly what prevents it.
//
// Run:  cd packages/client/desktop && bun run --bun e2e/switchback-gap.e2e.ts
// Needs: system Chrome (playwright-core channel:"chrome"); built sidecar binaries
//        (src-tauri/binaries). Exit 0 = PASS, 1 = FAIL.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const REPO = join(DESKTOP, "..", "..", "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const MOCKLLM = join(DIR, "mock-llm.ts")
const BUN = process.execPath
const PW = "switchback-e2e-pw"
const LLM_PORT = 8088
const CHUNKS = 70

const procs: { name: string; p: ReturnType<typeof Bun.spawn> }[] = []
const spawn = (name: string, cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push({ name, p }); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise(r => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}
// Extract M### markers; report whether 1..k is contiguous (firstGap = first
// missing number, or null if contiguous).
function analyze(text: string): { count: number; firstGap: number | null } {
  const uniq = [...new Set([...text.matchAll(/M(\d{3})/g)].map(m => Number(m[1])))].sort((a, b) => a - b)
  let firstGap: number | null = null
  for (let i = 0; i < uniq.length; i++) if (uniq[i] !== i + 1) { firstGap = i + 1; break }
  return { count: uniq.length, firstGap }
}

const tmp = mkdtempSync(join(tmpdir(), "swb-gap-"))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM_PORT}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "dummy" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: false } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
try {
  console.log("=== start mock-llm + opencode + vite ===")
  spawn("mockllm", [BUN, "run", MOCKLLM], { MOCK_LLM_PORT: String(LLM_PORT), MOCK_LLM_CHUNKS: String(CHUNKS), MOCK_LLM_DELAY_MS: "150" })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn("opencode", [OPENCODE, "serve", "--port", "4096"], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch("http://127.0.0.1:4096/global/health", { headers: { authorization: auth } })).ok)
  spawn("vite", [BUN, "run", "dev"], {}, DESKTOP)
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

  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)
  // Markers appear in the main message answer; the sidebar may show a truncated
  // title, so take the UNION of markers across the whole page innerText.
  const answer = async () => await page.locator("body").innerText()

  console.log("=== send prompt (opencode + mock model) ===")
  await page.locator("textarea").first().fill("stream the markers please")
  await page.getByRole("button", { name: /马上开始|开始|send/i }).first().click()
  await page.waitForURL(/\/session\//, { timeout: 20000 })
  const sid = page.url().split("/session/")[1]
  await poll("streaming started", async () => analyze(await answer()).count >= 6, 30000)
  console.log(`[01] before switch: ${analyze(await answer()).count} markers`)

  console.log("=== SPA nav → Home (3s) → back to session ===")
  const nav = (path: string) => page.evaluate((p) => { history.pushState({}, "", p); dispatchEvent(new PopStateEvent("popstate")) }, path)
  await nav("/"); await page.waitForTimeout(3000)
  await nav(`/session/${sid}`); await page.waitForURL(/\/session\//, { timeout: 10000 })
  await page.waitForTimeout(800)
  const t2 = analyze(await answer())
  console.log(`[02] after switch-back: ${t2.count} markers, firstGap=${t2.firstGap}`)

  await poll("turn complete", async () => analyze(await answer()).count >= CHUNKS, 40000).catch(() => {})
  await page.waitForTimeout(1000)
  const t3 = analyze(await answer())
  console.log(`[03] final: ${t3.count}/${CHUNKS} markers, firstGap=${t3.firstGap}`)

  const sm = await (await fetch(`http://127.0.0.1:4096/session/${sid}/message`, { headers: { authorization: auth, "x-opencode-directory": ws } })).json().catch(() => null)
  const serverText = (sm as any[])?.filter?.((m: any) => m.info?.role === "assistant").flatMap((m: any) => (m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text)).join("") ?? ""
  console.log(`[server] opencode persisted ${analyze(serverText).count}/${CHUNKS} markers`)

  const ok = t2.firstGap === null && t3.firstGap === null && t3.count === CHUNKS
  verdict = ok ? "PASS ✅ — no gap after switch-back, complete at end" : `FAIL ❌ — switchBackGap=${t2.firstGap} finalGap=${t3.firstGap} finalCount=${t3.count}/${CHUNKS}`
} catch (e) {
  verdict = `ERROR: ${(e as Error).message}`
} finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const { p } of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
