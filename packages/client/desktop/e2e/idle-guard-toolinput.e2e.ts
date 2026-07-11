// idle-guard-toolinput.e2e.ts — REAL-MODEL walkthrough of ADR-049 in the real renderer.
//
// The defect: qwen/DashScope streams a tool call's arguments in a BUFFERED mode —
// it announces the function name, emits a few dozen bytes of prefix, then goes
// silent for 37-65s while it generates the whole argument body server-side. The
// idle guard had no phase for that window (the id only enters `inflightTools` at
// `tool-call`, the very event the stall precedes), so it measured a legitimate
// 40-60s window with the 30s bar and killed the turn — "LLM stream idle for 30000ms".
//
// Guards, at the level the user actually sees:
//   A. the turn never surfaces an `LLM stream idle` error
//   B. the turn reaches a normal terminal state (no message-level error)
//   C. the UI does not FALSE-COMPLETE during the silent window (composer stays in
//      the sending state, no error bubble) — the backend fix is worthless if the
//      renderer declares the turn dead on its own
//
//   cd packages/client/desktop && bun run --bun e2e/idle-guard-toolinput.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/idle-guard-toolinput.e2e.ts
//
// The stall is a provider behaviour, not something we can force: if the run does
// not actually produce a >=30s silent window, the scenario was NOT exercised and
// the test SKIPs loudly rather than reporting a hollow green.
//
// Needs: system Chrome (or playwright webkit); built opencode binary; a `myqwen` key.
import { chromium, webkit, type Browser, type Page } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "idle-e2e-pw"
const OC = 4096

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in auth.json")
  return auth.myqwen.key as string
})()
const MODEL = "qwen3.7-max"

// Sized into the band where the buffered mode reliably shows up (~9-14k chars of
// tool input; 12/12 in the direct SSE probe). Much larger arguments flip DashScope
// back into incremental streaming and would NOT exercise the stall (discussions/032 §4.3).
const PROMPT =
  "用一次 bash 调用（heredoc：cat > report.py <<'PY' ... PY）写出一个完整的 python 脚本并运行它：" +
  "生成一份 3 页的文本报告 report.txt，包含封面段落、一个至少 8 行 5 列的表格（用 str.format 手工对齐、带表头分隔线）、" +
  "一段柱状图的 ASCII 渲染、以及页脚页码。脚本要完整可运行、不要省略、不要用占位符、不要依赖第三方库。" +
  "只用一次 bash 调用写完并执行。"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 240000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "idle-e2e-"))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(
  join(tmp, ".config/ultrawork/opencode.json"),
  JSON.stringify({
    model: `myqwen/${MODEL}`,
    provider: {
      myqwen: {
        name: "MyQwen",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: KEY },
        models: { [MODEL]: { id: MODEL, name: "Qwen3.7 Max", tool_call: true } },
      },
    },
  }),
)
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) },
  })

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name} — ${detail}`)
  return ok
}
const skip = (name: string, why: string) => results.push(`SKIP ⚠️  ${name} — ${why}`)

/** Terminal per isTurnTerminal (message-list.tsx): an intermediate tool step also
 *  carries time.completed, so only a non-"tool-calls" finish (or an error) ends it. */
const turnState = async (sid: string) => {
  const m = await (await api(`/session/${sid}/message`)).json()
  const msgs = Array.isArray(m) ? m : []
  const assistants = msgs.filter((x: any) => x.info?.role === "assistant")
  const last = assistants[assistants.length - 1]?.info
  const err = assistants.map((x: any) => x.info?.error?.data?.message).find(Boolean) as string | undefined
  const done = Boolean(last && (last.error || (last.finish && last.finish !== "tool-calls")))
  return { err, done, assistants }
}

let browser: Browser | undefined
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok, 60000)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok, 60000)

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser =
    engine === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: "chrome", headless: true })
  const page: Page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(
    ({ ws, pw }) => {
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => [],
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
    { ws, pw: PW },
  )

  const s = await (await api("/session", { method: "POST", body: "{}" })).json()
  await page.goto(`http://localhost:1420/session/${s.id}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)

  // Drive the REAL composer, not the API — the renderer path is what's under test.
  const box = page.locator("textarea").first()
  await box.fill(PROMPT)
  await box.press("Enter")

  // Sample the transcript while the turn runs: measure the longest window with no
  // new/changed part (the stall), and watch for a false-complete or an error bubble.
  const t0 = Date.now()
  let lastChange = Date.now()
  let prevSig = ""
  let maxQuiet = 0
  let falseComplete = false
  let idleError: string | undefined
  let done = false

  while (Date.now() - t0 < 6 * 60_000) {
    const st = await turnState(s.id)
    if (st.err) {
      idleError = st.err
      break
    }
    const sig = JSON.stringify(
      st.assistants.map((m: any) => [
        (m.parts ?? []).length,
        (m.parts ?? []).map((p: any) => (p.type === "text" ? p.text?.length : p.state?.status)),
      ]),
    )
    if (sig !== prevSig) {
      prevSig = sig
      lastChange = Date.now()
    } else {
      maxQuiet = Math.max(maxQuiet, Date.now() - lastChange)
    }

    // C: during the silent window the UI must NOT declare the turn finished. The stop
    // button is only rendered while the turn is in flight (composer sending state).
    if (!st.done) {
      // chat-input.tsx renders the stop button ONLY while `loading` (the turn is in
      // flight); aria-label is i18n'd ("停止" / "Stop"), so accept either.
      const stopVisible = await page
        .locator('button[aria-label="停止"], button[aria-label="Stop"]')
        .first()
        .isVisible()
        .catch(() => false)
      if (!stopVisible && Date.now() - t0 > 15_000) falseComplete = true
    }
    if (st.done) {
      done = true
      break
    }
    await new Promise((r) => setTimeout(r, 1000))
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const quiet = (maxQuiet / 1000).toFixed(0)

  // A — the exact user-visible symptom from the screenshots must be gone.
  const errText = await page.locator("body").innerText()
  check(
    "A 转录区不出现 `LLM stream idle` 报错",
    !idleError?.includes("idle for") && !/LLM stream idle/i.test(errText),
    `后端 error=${idleError ?? "-"} · 页面含该文案=${/LLM stream idle/i.test(errText)}`,
  )
  // B — the turn actually finished.
  check("B 回合正常收尾", done && !idleError, `done=${done} err=${idleError ?? "-"} ${secs}s`)

  // The stall is the provider's to produce; a run without one proves nothing.
  if (maxQuiet >= 30_000) {
    check("C 静默窗口内 UI 未假完成（停止按钮/流式态仍在）", !falseComplete, `最长静默 ${quiet}s，未见提前收尾`)
    console.log(`\n>>> 本轮真的撞上了缓冲模式停流：最长静默 ${quiet}s（旧代码在 30s 必杀）`)
  } else {
    skip("C 静默窗口内 UI 未假完成", `本轮最长静默仅 ${quiet}s（<30s）——provider 走了流式模式，未触发缺陷场景`)
  }

  await page.screenshot({ path: join(DIR, `idle-guard-toolinput-${engine}.png`), fullPage: false })
  console.log(`\n截图: e2e/idle-guard-toolinput-${engine}.png`)
} finally {
  console.log("\n" + results.join("\n"))
  await browser?.close()
  for (const p of procs) p.kill()
  rmSync(tmp, { recursive: true, force: true })
  const failed = results.some((r) => r.startsWith("FAIL"))
  process.exit(failed ? 1 : 0)
}
