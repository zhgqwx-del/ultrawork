// inline-image-render.e2e.ts — REAL-APP proof of the inline-image fix (ADR-065).
//
// The bug: qwen "draws" by writing an SVG/PNG into the workspace and referencing
// it from the reply with `![alt](local-path)`. react-markdown's default <img>
// rendered a raw `<img src="/Users/…">` the WebView 404s → broken glyph. Fix =
// MarkdownImage resolves local paths through getFileContent → data: URI, passes
// remote/base64 through, and a custom urlTransform stops react-markdown blanking
// data:/Windows srcs. jsdom cannot prove the FULL chain (real opencode serving
// the real file + real browser url handling), so this drives:
//
//   mock-llm-image → REAL opencode (serves the real octopus.svg via /file/content)
//   → Vite → REAL Chromium/WebKit → REAL MarkdownContent → MarkdownImage
//
// and asserts the rendered <img>/fallback for every scheme. A NEGATIVE CONTROL
// (the outside-workspace path) MUST NOT resolve — otherwise the positive checks
// could be vacuous.
//
//   cd packages/client/desktop && bun run --bun e2e/inline-image-render.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/inline-image-render.e2e.ts
// Needs: built opencode binary. No model key (the mock LLM answers).
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "inline-image-pw"; const LLM = 8097; const OC = 4196
const ENGINE = process.env.E2E_ENGINE === "webkit" ? webkit : chromium
const ENGINE_NAME = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chromium"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

// realpathSync: macOS tmpdir (/var/folders/…) is a symlink to /private/var/….
// opencode canonicalises the session directory, so the app's workspaceDir comes
// back as /private/var/…; an un-canonicalised WS would make the ABSOLUTE-path
// image (whose src embeds WS) fail the workspace-prefix match. Real user
// workspaces (/Users/…) aren't symlinked, so this only bites the temp dir.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "inline-image-"))); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
// The real deliverable: an SVG the "model" drew. A distinctive fill lets us also
// eyeball the screenshot. opencode /file/content will serve this as base64.
writeFileSync(join(ws, "octopus.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120"><rect width="120" height="120" fill="#1A1A2E"/><circle cx="60" cy="55" r="34" fill="#FF6B9D"/></svg>`)

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
  console.log(`=== [${ENGINE_NAME}] start mock-llm-image + opencode + vite ===`)
  spawn([BUN, "run", join(DIR, "mock-llm-image.ts")], { MOCK_LLM_PORT: String(LLM), MOCK_WS: ws })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  // Sanity: the server really serves the SVG as base64 for the relative path.
  await poll("svg-serves", async () => {
    const r = await fetch(`http://127.0.0.1:${OC}/file/content?path=octopus.svg`, { headers: { authorization: auth, "x-opencode-directory": encodeURIComponent(ws) } })
    if (!r.ok) return false
    const j = await r.json() as { content?: string; mimeType?: string }
    return !!j.content && j.mimeType === "image/svg+xml"
  })
  // Vite must proxy /file/content etc. to THIS run's opencode (not a stray one).
  spawn([BUN, "run", "dev"], { E2E_OPENCODE_PORT: String(OC) }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  console.log(`=== [${ENGINE_NAME}] launch + tauri shim ===`)
  browser = await ENGINE.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
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

  console.log(`=== [${ENGINE_NAME}] send prompt → opencode streams image answer ===`)
  await page.locator("textarea").first().fill("画个章鱼")
  await page.waitForTimeout(300)
  await page.locator("textarea").first().press("Enter")
  await page.waitForURL(/\/session\//, { timeout: 8000 }).catch(async () => {
    await page.getByRole("button", { name: /发送|send/i }).last().click().catch(() => {})
    await page.waitForURL(/\/session\//, { timeout: 12000 })
  })

  // Wait for the answer markdown, then for the local image to RESOLVE to a data URI.
  await page.waitForSelector(".chat-md", { timeout: 30000 })
  await page.waitForFunction(
    () => [...document.querySelectorAll(".chat-md img")].some((i) => (i as HTMLImageElement).src.startsWith("data:image/svg+xml")),
    { timeout: 20000 },
  ).catch(() => {})
  await page.waitForTimeout(800)

  const shot = join(tmpdir(), `inline-image-${ENGINE_NAME}.png`)
  await page.screenshot({ path: shot })
  console.log(`[shot] ${shot}`)

  const r = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll(".chat-md img")].map((i) => (i as HTMLImageElement).src)
    const bodyText = document.body.innerText
    return {
      imgSrcs: imgs,
      svgDataImgs: imgs.filter((s) => s.startsWith("data:image/svg+xml")).length,
      pngDataImgs: imgs.filter((s) => s.startsWith("data:image/png;base64,iVBOR")).length,
      remoteImgs: imgs.filter((s) => s === "https://example.com/remote.png").length,
      // A broken case would be a raw filesystem path left in an <img src>.
      rawPathImgs: imgs.filter((s) => /octopus\.svg$/.test(s) && !s.startsWith("data:")).length,
      // The outside-workspace path must NOT become an <img>; it degrades to a
      // fallback chip whose visible label is the ALT text ("外部图"), and the
      // raw path must never appear in any <img src>.
      totalImgs: imgs.length,
      outsideAsFallback: /外部图/.test(bodyText) && !imgs.some((s) => /hosts-not-here/.test(s)),
    }
  })
  console.log("[rendered]", JSON.stringify(r, null, 2))

  const checks: Array<[string, boolean]> = [
    // relative + absolute-in-workspace both resolve to a data: SVG URI (2 imgs).
    ["local relative + absolute resolve to data:image/svg+xml (≥2)", r.svgDataImgs >= 2],
    ["base64 data: URI passes through urlTransform", r.pngDataImgs >= 1],
    ["remote https image passes through", r.remoteImgs >= 1],
    ["no raw filesystem-path <img> (nothing broken)", r.rawPathImgs === 0],
    // 4 refs become <img> (2 svg + remote + base64); the 5th (outside) does not.
    ["exactly 4 images rendered (outside path excluded)", r.totalImgs === 4],
    ["NEGATIVE CONTROL: outside-workspace path → fallback text, not an <img>", r.outsideAsFallback],
  ]
  const failed = checks.filter(([, ok]) => !ok)
  for (const [label, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label}`)
  verdict = failed.length === 0
    ? `PASS ✅ [${ENGINE_NAME}] — inline images resolve end-to-end against real opencode`
    : `FAIL ❌ [${ENGINE_NAME}] — ${failed.map(([l]) => l).join("; ")}`
} catch (e) { verdict = `ERROR [${ENGINE_NAME}]: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
