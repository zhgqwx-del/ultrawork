// message-timestamp.e2e.ts — REAL-APP proof of the sent-at timestamp work.
//
// Drives: mock-llm → REAL opencode → Vite → REAL Chrome → the real transcript.
// The message is created over HTTP (POST /session, POST /prompt_async) rather
// than by typing, so the run does not depend on trusted keyboard input reaching
// the app page (a known-broken path on this machine). Hover IS exercised, with a
// CDP forcePseudoState fallback if the pointer can't reach the page either.
//
// Asserts, against the SERVER's own time.created (not just "some time shows"):
//   A1 the user bubble's <time datetime> === the epoch the API reports
//   A2 the visible text is the UI language's format, and differs from en-US's
//   A3 the assistant footer's timestamp uses that same format (three-place unity)
//   A4 switching the UI language re-formats BOTH (the per-locale cache isn't pinned)
//   A5 hover reveals copy, and the row's height does not change (no layout shift)
//   A6 at a 420px-wide window the row does not overflow the page horizontally
//   A7 in dark mode the timestamp still clears WCAG AA against its real背景
//
//   cd packages/client/desktop
//   bun run --bun e2e:message-timestamp                 # expect PASS (exit 0)
//   E2E_ENGINE=webkit bun run --bun e2e:message-timestamp     # WKWebView = the mac runtime
//   E2E_BREAK=wiring bun run --bun e2e:message-timestamp      # CONTROL: must FAIL
// Needs: built opencode binary (scripts/build-opencode.ts). No model key.
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync, copyFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const E2E = import.meta.dir
const DESKTOP = join(E2E, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "msg-ts-pw"; const LLM = 8098; const OC = 4296
const BREAK = process.env.E2E_BREAK ?? ""
// macOS ships the app on WKWebView, not Chrome — E2E_ENGINE=webkit runs the same
// checks on the engine that actually renders in production.
const WEBKIT = process.env.E2E_ENGINE === "webkit"
const ENGINE = WEBKIT ? webkit : chromium
const ENGINE_NAME = WEBKIT ? "webkit" : "chrome"

const MESSAGE_LIST = join(DESKTOP, "src/components/chat/message-list.tsx")
const BACKUP = join(tmpdir(), "message-list.orig.tsx")

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "msg-ts-")))
const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: { mockprov: { name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL, options: { baseURL, apiKey: "x" }, models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } }, whitelist: ["mock-model"] } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const ocHeaders = { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) }

const checks: Array<[string, boolean, string]> = []
const check = (label: string, ok: boolean, detail = "") => { checks.push([label, ok, detail]); console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`) }

let browser: Browser | undefined
let verdict = "INCOMPLETE"
try {
  if (BREAK === "wiring") {
    // CONTROL ARM: drop MessageList's hand-off of info.time.created. Everything
    // else stays. A harness that still passes here is not measuring anything.
    copyFileSync(MESSAGE_LIST, BACKUP)
    const src = readFileSync(MESSAGE_LIST, "utf8")
    writeFileSync(MESSAGE_LIST, src.replace(/\n\s*createdAt=\{message\.info\.time\.created\}/, ""))
    console.log("!! CONTROL ARM: createdAt hand-off removed from message-list.tsx")
  }

  console.log("=== start mock-llm + opencode + vite ===")
  spawn([BUN, "run", join(E2E, "mock-llm.ts")], { MOCK_LLM_PORT: String(LLM), MOCK_LLM_CHUNKS: "6", MOCK_LLM_DELAY_MS: "60" })
  await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)
  spawn([BUN, "run", "dev"], { E2E_OPENCODE_PORT: String(OC) }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  // --- create the turn over HTTP (no typing needed) ---
  const created = await (await fetch(`http://127.0.0.1:${OC}/session`, { method: "POST", headers: ocHeaders, body: JSON.stringify({}) })).json() as { id: string }
  const sid = created.id
  console.log(`[session] ${sid}`)
  await fetch(`http://127.0.0.1:${OC}/session/${sid}/prompt_async`, {
    method: "POST", headers: ocHeaders,
    body: JSON.stringify({ parts: [{ type: "text", text: "时间戳走查" }] }),
  })
  let userCreated = 0
  let assistantCompleted = 0
  await poll("turn finished", async () => {
    const r = await fetch(`http://127.0.0.1:${OC}/session/${sid}/message`, { headers: ocHeaders })
    if (!r.ok) return false
    const msgs = await r.json() as Array<{ info: { role: string; time: { created: number; completed?: number } } }>
    const u = msgs.find((m) => m.info.role === "user")
    const a = msgs.find((m) => m.info.role === "assistant" && m.info.time.completed)
    if (!u || !a) return false
    userCreated = u.info.time.created
    assistantCompleted = a.info.time.completed!
    return true
  })
  console.log(`[api] user.time.created=${userCreated} assistant.time.completed=${assistantCompleted}`)

  // --- browser ---
  browser = await ENGINE.launch({ headless: true, ...(WEBKIT ? {} : { channel: "chrome" }) } as any)
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    // Seed ONCE. addInitScript re-runs on every navigation, so an unconditional
    // write would silently undo the language switch A4b is verifying.
    if (!localStorage.getItem("ultrawork-config"))
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw, language: "zh-Hans" }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  const open = async () => {
    for (let i = 0; ; i++) {
      try { await page.goto(`http://localhost:1420/session/${sid}`, { waitUntil: "domcontentloaded" }); break }
      catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
    }
    await page.waitForTimeout(3500)
  }
  await open()

  const readDom = () => page.evaluate(() => {
    const t = document.querySelector('[data-testid="message-time"]')
    const footer = [...document.querySelectorAll("div")].filter((d) => /·/.test(d.textContent ?? "") && d.children.length === 0).map((d) => d.textContent ?? "")
    return { timeText: t?.textContent ?? null, timeIso: t?.getAttribute("datetime") ?? null, footers: footer, bodyHasTime: !!t }
  })

  console.log("\n=== A: 中文界面 ===")
  const zh = await readDom()
  console.log("[dom]", JSON.stringify(zh))
  const expectZh = new Date(userCreated).toLocaleString("zh-Hans")
  const expectEn = new Date(userCreated).toLocaleString("en-US")
  const expectZhAssistant = new Date(assistantCompleted).toLocaleString("zh-Hans")

  check("A1 <time datetime> 与服务端 info.time.created 同一时刻",
    !!zh.timeIso && new Date(zh.timeIso).getTime() === userCreated, `dom=${zh.timeIso} api=${new Date(userCreated).toISOString()}`)
  check("A2 可见文本 = 应用语言(zh-Hans)格式", zh.timeText === expectZh, `dom="${zh.timeText}" 期望="${expectZh}"`)
  check("A2' 且与 en-US 格式不同（否则 A2 恒真）", expectZh !== expectEn, `en-US="${expectEn}"`)
  check("A3 助手 footer 时间同格式（三处统一）",
    zh.footers.some((f) => f.includes(expectZhAssistant)), `footer=${JSON.stringify(zh.footers).slice(0, 160)}`)

  const zhShot = join(tmpdir(), `message-timestamp-zh-${ENGINE_NAME}.png`)
  await page.screenshot({ path: zhShot, clip: { x: 380, y: 60, width: 900, height: 360 } })
  console.log(`[shot-zh] ${zhShot}`)

  console.log("\n=== A4: 语言热切换（不 reload —— reload 会清空模块缓存，那样根本测不到缓存被钉死）===")
  // A4a: drive the cached formatters directly, in the real browser, with a WARM
  // cache — the transcript above already primed the zh-Hans slot. A single shared
  // Intl instance would answer zh-Hans for every locale from here on.
  const warm = await page.evaluate(async (ts) => {
    const m = await import("/src/lib/format-time.ts")
    return { zh: m.formatDateTime(ts, "zh-Hans"), en: m.formatDateTime(ts, "en-US"), zhAgain: m.formatDateTime(ts, "zh-Hans") }
  }, userCreated)
  console.log("[warm-cache]", JSON.stringify(warm))
  check("A4a 暖缓存下 en-US 不会串成 zh-Hans（缓存按 locale 分键）", warm.en === expectEn, `en="${warm.en}" 期望="${expectEn}"`)
  check("A4a' 再问一次 zh-Hans 仍然正确（缓存没被后写覆盖）", warm.zh === expectZh && warm.zhAgain === expectZh)

  // A4b: the app-level path — flip the UI language through the app's own settings
  // popover. The popover overlays the transcript, so the UserMessage instance stays
  // MOUNTED across the switch: this is the only arrangement that can catch a
  // `language` missing from the useMemo deps (a remount would hide it), and the
  // module cache stays warm because the document never navigates.
  let switched = "not attempted"
  try {
    await page.locator('[aria-label="User settings"]').click({ timeout: 8000 })
    await page.waitForTimeout(400)
    await page.getByText("语言", { exact: false }).first().click({ timeout: 5000 })
    await page.waitForTimeout(400)
    await page.getByText("English", { exact: true }).click({ timeout: 5000 })
    await page.waitForTimeout(500)
    await page.keyboard.press("Escape").catch(() => {})
    await page.waitForTimeout(1200)
    switched = "popover → 语言 → English (no reload, no remount)"
  } catch (e) { switched = `FAILED: ${String(e).split("\n")[0].slice(0, 90)}` }
  const en = await readDom()
  console.log(`[after switch: ${switched}]`, JSON.stringify(en))
  const expectEnUi = new Date(userCreated).toLocaleString("en")
  const langNow = await page.evaluate(() => JSON.parse(localStorage.getItem("ultrawork-config") ?? "{}").language)
  check("A4b 应用内热切到 English（组件未重挂载）后，用户消息时间重新格式化",
    en.timeText === expectEnUi && en.timeText !== zh.timeText, `dom="${en.timeText}" 期望="${expectEnUi}" config.language=${langNow} (${switched})`)
  check("A4b' 助手 footer 同步切换",
    en.footers.some((f) => f.includes(new Date(assistantCompleted).toLocaleString("en"))), `footer=${JSON.stringify(en.footers).slice(0, 120)}`)

  console.log("\n=== A5: hover 显复制 + 不位移 ===")
  const geom = async () => page.evaluate(() => {
    const t = document.querySelector('[data-testid="message-time"]')
    const row = t?.parentElement as HTMLElement | undefined
    const btn = row?.querySelector("button") as HTMLElement | undefined
    const group = row?.parentElement as HTMLElement | undefined
    return {
      rowH: row ? Math.round(row.getBoundingClientRect().height * 100) / 100 : null,
      rowTop: row ? Math.round(row.getBoundingClientRect().top * 100) / 100 : null,
      groupH: group ? Math.round(group.getBoundingClientRect().height * 100) / 100 : null,
      btnOpacity: btn ? getComputedStyle(btn).opacity : null,
      btnLabel: btn?.getAttribute("aria-label") ?? null,
    }
  })
  const before = await geom()
  let hoverMode = "real pointer"
  await page.locator('[data-testid="message-time"]').hover({ timeout: 4000 }).catch(async (e) => {
    hoverMode = `CDP forcePseudoState (pointer failed: ${String(e).split("\n")[0].slice(0, 50)})`
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("DOM.enable"); await cdp.send("CSS.enable")
    const { root } = await cdp.send("DOM.getDocument") as any
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '[data-testid="message-time"]' }) as any
    const { nodeId: groupId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".group" }) as any
    await cdp.send("CSS.forcePseudoState", { nodeId: groupId || nodeId, forcedPseudoClasses: ["hover"] })
  })
  await page.waitForTimeout(600)
  const after = await geom()
  console.log(`[hover via ${hoverMode}]`, JSON.stringify({ before, after }))
  check("A5 hover 前复制按钮不可见", before.btnOpacity === "0", `opacity=${before.btnOpacity}`)
  check("A5' hover 后复制按钮可见", after.btnOpacity !== null && Number(after.btnOpacity) > 0.5, `opacity=${after.btnOpacity}`)
  // 必须先要求量到了东西：控制臂里元素不存在时 null === null 同样成立，
  // 一条"没测到"的断言会长得和"通过"一模一样。
  check("A5'' hover 不改变行高/行位置（无位移）",
    before.rowH !== null && before.rowTop !== null && before.rowH === after.rowH && before.rowTop === after.rowTop,
    `h ${before.rowH}→${after.rowH}, top ${before.rowTop}→${after.rowTop}`)
  check("A5''' 复制按钮带无障碍标签", !!after.btnLabel, `aria-label="${after.btnLabel}"`)

  console.log("\n=== A6: 窄窗不横向溢出（tauri.conf.json 没有 minWidth，400px 是可达的）===")
  await page.setViewportSize({ width: 420, height: 800 })
  await page.waitForTimeout(800)
  const narrow = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="message-time"]') as HTMLElement | null
    const row = t?.parentElement as HTMLElement | undefined
    const de = document.documentElement
    return {
      rowW: row ? Math.round(row.getBoundingClientRect().width) : null,
      rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
      innerW: window.innerWidth,
      pageOverflow: de.scrollWidth - de.clientWidth,
    }
  })
  console.log("[narrow]", JSON.stringify(narrow))
  check("A6 420px 下时间行未把页面撑出横向滚动",
    narrow.rowW !== null && narrow.pageOverflow <= 0, `row=${narrow.rowW}px right=${narrow.rowRight} innerW=${narrow.innerW} overflow=${narrow.pageOverflow}px`)
  check("A6' 时间行右边缘落在视口内",
    narrow.rowRight !== null && narrow.rowRight <= narrow.innerW, `right=${narrow.rowRight} <= ${narrow.innerW}`)
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.waitForTimeout(500)

  console.log("\n=== A7: 深色模式下的实测对比度（不是照 token 算的，是取渲染后的颜色）===")
  await page.evaluate(() => {
    const c = JSON.parse(localStorage.getItem("ultrawork-config") ?? "{}")
    localStorage.setItem("ultrawork-config", JSON.stringify({ ...c, theme: "dark" }))
    document.documentElement.classList.add("dark")
  })
  await page.waitForTimeout(600)
  const contrast = await page.evaluate(() => {
    const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    const lum = (rgb: number[]) => {
      const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const el = document.querySelector('[data-testid="message-time"]') as HTMLElement | null
    if (!el) return null
    // Walk up for the first ancestor that actually paints a background.
    let bgEl: HTMLElement | null = el
    let bg = "rgba(0, 0, 0, 0)"
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) { bg = c; break }
      bgEl = bgEl.parentElement
    }
    const fg = getComputedStyle(el).color
    const opacity = getComputedStyle(el).opacity
    const L1 = lum(parse(fg)), L2 = lum(parse(bg))
    return { fg, bg, opacity, ratio: Math.round(((Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)) * 100) / 100, fontSize: getComputedStyle(el).fontSize }
  })
  console.log("[contrast-dark]", JSON.stringify(contrast))
  check("A7 深色模式对比度 ≥ 4.5:1（小号文本的 WCAG AA）",
    !!contrast && contrast.ratio >= 4.5, `${contrast?.ratio}:1  fg=${contrast?.fg} bg=${contrast?.bg} ${contrast?.fontSize}`)
  check("A7' 时间文本没有叠 opacity（命令菜单就是这样掉到 2.68:1 的）",
    !!contrast && contrast.opacity === "1", `opacity=${contrast?.opacity}`)

  const shot = join(tmpdir(), `message-timestamp-e2e-${ENGINE_NAME}.png`)
  await page.screenshot({ path: shot, fullPage: false })
  console.log(`\n[shot] ${shot}`)

  const failed = checks.filter(([, ok]) => !ok)
  verdict = failed.length === 0 ? `PASS ✅ [${ENGINE_NAME}] — 时间戳三处统一，在真实 app 中成立` : `FAIL ❌ — ${failed.map(([l]) => l).join("; ")}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  if (BREAK === "wiring") { try { copyFileSync(BACKUP, MESSAGE_LIST); console.log("[restored] message-list.tsx") } catch {} }
  console.log("\n=== VERDICT:", verdict, "===")
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
