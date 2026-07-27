// math-render-realapp.e2e.ts — REAL-APP proof of LaTeX rendering (discussions/055).
//
// The other two layers stop short of the real thing:
//   · unit tests (jsdom)      — right DOM, but no layout engine and no fonts
//   · math-css-layout.e2e.ts  — real browser, but hand-built HTML: it never runs
//                               MarkdownContent, React, or a streaming turn
// So neither can answer "does a real answer, streamed through a real turn, render
// correctly in the real chat column?". This drives:
//
//   mock-llm-math → REAL opencode → Vite → REAL Chromium/WebKit
//   → REAL MessageList/AssistantTurn/MarkdownContent
//
// and additionally SAMPLES THE PAGE DURING STREAMING to quantify W2 (reflow) —
// which earlier notes wrongly called "only judgeable by eye". Jitter amplitude is
// measurable; only whether it looks acceptable needs a human.
//
//   cd packages/client/desktop && bun run --bun e2e/math-render-realapp.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/math-render-realapp.e2e.ts
// Needs: built opencode binary. No model key (the mock answers).
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "math-render-pw"; const LLM = 8098; const OC = 4197
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

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "math-render-"))); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let failed = false
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`)
  if (!ok) failed = true
}

try {
  console.log(`=== [${ENGINE_NAME}] start mock-llm-math + opencode + vite ===`)
  spawn([BUN, "run", join(DIR, "mock-llm-math.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], { E2E_OPENCODE_PORT: String(OC) }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  browser = await ENGINE.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: unknown) => unknown> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: unknown) => (handlers[c] ? handlers[c](a) : null), transformCallback: (cb: unknown) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  for (let i = 0; ; i++) {
    try { await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3000)

  console.log(`=== [${ENGINE_NAME}] send prompt → real streamed turn ===`)
  await page.locator("textarea").first().fill("拒绝采样是指?")
  await page.waitForTimeout(300)
  await page.locator("textarea").first().press("Enter")
  await page.waitForURL(/\/session\//, { timeout: 8000 }).catch(async () => {
    await page.getByRole("button", { name: /发送|send/i }).last().click().catch(() => {})
    await page.waitForURL(/\/session\//, { timeout: 12000 })
  })
  await page.waitForSelector(".chat-md", { timeout: 30000 })

  // ---- W2: sample DURING streaming ----
  // Horizontal overflow at ANY instant is a real defect (a half-open `$$` can
  // render a formula that is briefly wider than the column). Vertical growth is
  // normal streaming and is not counted as jitter.
  console.log(`\n=== [${ENGINE_NAME}] sampling during stream (W2) ===`)
  // Track the DISPLAY formula, not the first inline one: a half-open `$$` is
  // what renders early and then reflows, and the first inline formula (`$q(x)$`)
  // is short and stable, so watching it would report zero jitter regardless.
  const samples: { katex: number; bodyOver: boolean; colOver: boolean; dispW: number; dispH: number }[] = []
  for (let i = 0; i < 120; i++) {
    const s = await page.evaluate(() => {
      const md = document.querySelector(".chat-md") as HTMLElement | null
      const disp = document.querySelector(".chat-md .katex-display .katex") as HTMLElement | null
      const r = disp?.getBoundingClientRect()
      return {
        katex: document.querySelectorAll(".chat-md .katex").length,
        bodyOver: document.body.scrollWidth > document.body.clientWidth,
        colOver: !!md && md.scrollWidth > md.clientWidth,
        dispW: r ? Math.round(r.width) : 0,
        dispH: r ? Math.round(r.height) : 0,
        done: !!document.querySelector(".chat-md table"),
      }
    })
    samples.push(s)
    if (s.done && i > 12) break
    await page.waitForTimeout(60)
  }
  await page.waitForTimeout(2500) // let the turn settle

  const withMath = samples.filter((s) => s.katex > 0)
  const dispSeen = samples.filter((s) => s.dispW > 0)
  const wChanges = dispSeen.filter((s, i) => i > 0 && s.dispW !== dispSeen[i - 1].dispW).length
  const hChanges = dispSeen.filter((s, i) => i > 0 && s.dispH !== dispSeen[i - 1].dispH).length
  check("no horizontal body overflow at any sampled instant", !samples.some((s) => s.bodyOver))
  check("no horizontal overflow of the chat column at any instant", !samples.some((s) => s.colOver))
  console.log(`  ℹ️  sampled ${samples.length} frames; formulas present in ${withMath.length}, display formula visible in ${dispSeen.length}`)
  console.log(`  ℹ️  W2 jitter (display formula): width changed ${wChanges}x, height changed ${hChanges}x across ${dispSeen.length} samples`)
  if (dispSeen.length) console.log(`  ℹ️  display formula width over time: ${[...new Set(dispSeen.map((s) => s.dispW))].join(" → ")}`)

  // ---- final rendered state ----
  console.log(`\n=== [${ENGINE_NAME}] final rendered answer ===`)
  const r = await page.evaluate(() => {
    const md = document.querySelector(".chat-md") as HTMLElement
    const disp = document.querySelector(".chat-md .katex-display") as HTMLElement | null
    const ann = [...document.querySelectorAll(".chat-md annotation")].map((a) => a.textContent ?? "")
    const sel = (() => {
      const p = document.querySelector(".chat-md p") as HTMLElement | null
      if (!p) return ""
      const range = document.createRange(); range.selectNodeContents(p)
      const s = window.getSelection()!; s.removeAllRanges(); s.addRange(range)
      const out = s.toString(); s.removeAllRanges(); return out
    })()
    return {
      katex: document.querySelectorAll(".chat-md .katex").length,
      display: document.querySelectorAll(".chat-md .katex-display").length,
      inTable: document.querySelectorAll(".chat-md td .katex").length,
      errors: document.querySelectorAll(".chat-md .katex-error").length,
      codeDollars: (document.querySelector(".chat-md pre")?.textContent ?? "") + "|" + [...document.querySelectorAll(".chat-md code")].map((c) => c.textContent).join(","),
      starSurvived: ann.some((a) => a.includes("x^*")),
      dispOverflowX: disp ? getComputedStyle(disp).overflowX : "n/a",
      dispScrollW: disp?.scrollWidth ?? 0,
      dispClientW: disp?.clientWidth ?? 0,
      colScrollW: md.scrollWidth, colClientW: md.clientWidth,
      selHasLatex: /\\cdot|\\frac/.test(sel),
      rawHasLatex: /\\cdot/.test(md.textContent ?? ""),
    }
  })
  console.log("  " + JSON.stringify(r, null, 2).split("\n").join("\n  "))

  check("formulas rendered in the real app", r.katex >= 8, `${r.katex} .katex nodes`)
  check("block formula rendered as display math", r.display >= 1, `${r.display}`)
  check("formula inside a table cell rendered", r.inTable >= 1, `${r.inTable}`)
  check("no KaTeX error nodes", r.errors === 0, `${r.errors}`)
  // The regression from the screenshot: `x^*` used to lose both asterisks to
  // emphasis parsing before it ever reached a math renderer.
  check("superscript * survived (screenshot regression)", r.starSurvived)
  check("$PATH / ${x} in code were NOT treated as math", /\$PATH/.test(r.codeDollars) && /\$\{x\}/.test(r.codeDollars))
  check("W1: display formula has overflow-x:auto", r.dispOverflowX === "auto", r.dispOverflowX)
  // Non-vacuity guard: if the formula fits the column, the two assertions below
  // prove nothing. The first version of this test silently passed that way.
  check("W1: the formula really overflows the column (test is not vacuous)",
    r.dispScrollW > r.dispClientW, `scrollWidth ${r.dispScrollW} > clientWidth ${r.dispClientW}`)
  check("W1: chat column itself does not scroll sideways", r.colScrollW <= r.colClientW, `${r.colScrollW} vs ${r.colClientW}`)
  check("W3: DOM still holds LaTeX source (control)", r.rawHasLatex)
  check("W3: selection excludes LaTeX source", !r.selHasLatex)

  const shot = join(tmpdir(), `math-render-${ENGINE_NAME}.png`)
  await page.screenshot({ path: shot, fullPage: true })
  console.log(`\n[shot] ${shot}`)
  console.log(`\n${failed ? "❌ FAILURES ABOVE" : "✅ all checks passed"}\n`)
} catch (e) {
  console.error("e2e crashed:", e)
  failed = true
} finally {
  await browser?.close()
  for (const p of procs) { try { p.kill() } catch {} }
}
process.exit(failed ? 1 : 0)
