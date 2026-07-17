// preview-layout.e2e.ts — REAL-MODEL walkthrough of the preview/sidebar layout (ADR-048).
//
// Guards what jsdom structurally cannot see (it has no layout engine, which is why
// the original overflow survived for months):
//
//   A. baseline — the finished turn is pinned to the bottom (ADR-047 still holds)
//   B. artifacts are visible without hunting: sidebar opens with the section expanded
//   C. opening a preview COLLAPSES the sidebar — they never coexist, which is the
//      whole point: three columns used to sum to `100% + 288px` and the chat column,
//      the only shrinkable one, silently ate the difference
//   D. the chat column keeps ~half the main area (it used to drop to 50% − 288px)
//   E. maximize hides the transcript and DROPS the composer (an input box under a
//      full-screen artifact is clutter) — but keeps Stop reachable, and keeps every
//      action-required dock (permission / question / delegated-child permission),
//      because those block the agent and hiding them strands a turn. It also hides
//      the column WITHOUT collapsing it to 0px (that would re-wrap every message at
//      min-content, twice) and WITHOUT leaving it in the tab order (`inert` alone
//      can't carry that: it needs Safari 15.5+ and we ship down to macOS 10.15)
//   F. the R1 risk: half → full → half must not break stick-to-bottom. The hidden
//      column keeps a live layout box rather than `display:none`, because a
//      display-none subtree stops firing ResizeObserver and stick-to-bottom would
//      stop self-correcting.
//   G. closing the preview restores the sidebar to its pre-preview state
//   H. the "agent replied" banner fires on the AGENT's reply and not on the user's
//      own message — asserted in both directions, so it can't pass by never firing
//
//   cd packages/client/desktop && bun run --bun e2e/preview-layout.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/preview-layout.e2e.ts   <- the macOS engine
//
// Run BOTH: WKWebView (Tauri's engine on macOS) is webkit, and F is exactly the kind
// of layout/observer interaction the two engines disagree about.
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
const PW = "preview-e2e-pw"; const OC = 4096

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in auth.json")
  return auth.myqwen.key as string
})()
const MODEL = "qwen3.7-max"
const ARTIFACT = "report.md"
// One turn that produces BOTH things we need: a real artifact to click, and a
// transcript far taller than the viewport so stick-to-bottom is actually testable.
const PROMPT =
  `请先用 write 工具创建文件 ${ARTIFACT}，内容是一个至少 15 行的 markdown 表格（列举大模型服务平台：名称、base url、代表模型、计费方式）。` +
  "写完文件后，在回复里再写一段不少于 2500 字的详细分析，逐个平台点评优劣、适用场景和坑。" +
  "这段分析必须足够长——它要远远超出一屏。"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 240000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 400)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "preview-e2e-"))
// The workspace must NOT live under the system tmpdir: on macOS that is
// /var/folders/…, which artifact detection deliberately rejects as a temp path
// (TEMP_PATH_RE in artifacts-panel.tsx), so nothing the agent writes there would
// ever reach the artifact list. Keep the sandboxed HOME in tmp, but put the
// workspace somewhere a real user's would be.
const wsRoot = mkdtempSync(join(homedir(), ".ultrawork-e2e-"))
const ws = join(wsRoot, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: `myqwen/${MODEL}`,
  provider: { myqwen: { name: "MyQwen", npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: KEY }, models: { [MODEL]: { id: MODEL, name: "Qwen3.7 Max", tool_call: true } } } },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, { ...init, headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) } })

const PROBE = `
window.__p = {};
window.__p.el = () => {
  const sc = document.querySelector('[data-transcript-scroll]');
  return { sc, content: sc && sc.firstElementChild };
};
/** Distance from the bottom. <100 = pinned. */
window.__p.d = () => { const { sc } = window.__p.el(); return sc.scrollHeight - sc.clientHeight - sc.scrollTop; };
window.__p.widths = () => {
  const chat = document.querySelector('[data-testid="chat-column"]');
  const preview = document.querySelector('[data-testid="artifact-preview"]');
  const aside = document.querySelector('[data-testid="right-sidebar"]');
  const row = chat && chat.parentElement;
  const w = (el) => el ? Math.round(el.getBoundingClientRect().width) : 0;
  return {
    chat: w(chat), preview: w(preview), sidebar: w(aside), row: w(row),
    hasSidebar: !!aside, hasPreview: !!preview,
    chatVisible: chat ? getComputedStyle(chat).visibility !== 'hidden' : false,
  };
};
/* A VISIBLE composer anywhere on screen. In full there must be none — the input
 * box under a full-screen artifact is clutter (the transcript it belongs to is
 * hidden). Note the chat column still HOLDS one; it's just visibility:hidden, so
 * check computed visibility rather than mere presence. */
window.__p.composerVisible = () => {
  for (const ta of document.querySelectorAll('textarea')) {
    const r = ta.getBoundingClientRect();
    if (r.width > 100 && r.height > 0 && getComputedStyle(ta).visibility !== 'hidden') return true;
  }
  return false;
};
/* Stop must survive into full: it normally lives inside ChatInput, which full
 * drops — without hoisting it, a running turn could not be stopped from there. */
window.__p.stopReachable = () => {
  const bar = document.querySelector('[data-testid="transcript-hidden-banner"]');
  const row = bar && bar.parentElement;
  if (!row) return false;
  return [...row.querySelectorAll('button')].some((b) => /停止|Stop/i.test(b.textContent || ''));
};
/* Focusable descendants of the (hidden) chat column that the keyboard can still
 * reach. visibility:hidden must remove ALL of them from the tab order; inert
 * cannot be relied on (needs Safari 15.5+, we ship down to macOS 10.15). */
window.__p.focusableInChat = () => {
  const chat = document.querySelector('[data-testid="chat-column"]');
  if (!chat) return -1;
  const nodes = chat.querySelectorAll('button, a[href], textarea, input, select, [tabindex]:not([tabindex="-1"])');
  let reachable = 0;
  for (const n of nodes) {
    // Inside a visibility:hidden subtree an element is not focusable; same for inert.
    const cs = getComputedStyle(n);
    if (cs.visibility !== 'hidden' && !n.closest('[inert]')) reachable++;
  }
  return reachable;
};
/** The banner above the full-mode composer: does it claim the agent replied? */
window.__p.bannerSaysReplied = () => {
  const b = document.querySelector('[data-testid="transcript-hidden-banner"]');
  return b ? b.getAttribute('data-replied') === 'true' : null;
};
`

const finished = (sid: string) => poll("turn finished", async () => {
  const m = await (await api(`/session/${sid}/message`)).json()
  const last = Array.isArray(m) && m[m.length - 1]?.info
  if (last?.role !== "assistant") return false
  return !!last.error || (!!last.finish && last.finish !== "tool-calls")
})

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name} — ${detail}`)
  return ok
}
/** Not a pass. Printed loudly so a scenario the model refused to produce can never
 *  masquerade as a green check. */
const skip = (name: string, why: string) => results.push(`SKIP ⚠️  ${name} — ${why}`)

let browser: Browser | undefined
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok, 60000)
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok, 60000)

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true })
  // Wide enough that the preview opens `half` (main area ≈ 1180 > the 1100 threshold).
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  const s = await (await api("/session", { method: "POST", body: "{}" })).json()
  await page.goto(`http://localhost:1420/session/${s.id}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await page.evaluate(PROBE)

  console.log("=== 一轮真模型：写产物 + 长回复 ===")
  await api(`/session/${s.id}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }] }) })
  await finished(s.id)
  await page.waitForTimeout(2000) // outlast useStableStreaming's 600ms settle

  // ---------- A: baseline (ADR-047 must still hold before we touch anything) ----------
  const dBase = await page.evaluate(() => (window as any).__p.d())
  check("A 回复完成后贴底（基线）", dBase < 100, `Δbottom = ${dBase}px`)

  // ---------- B: the artifact announces itself, and is one click away ----------
  // B1 — the badge must actually light. Read it BEFORE opening the sidebar: opening
  // is what marks artifacts seen, so afterwards it's legitimately gone.
  const badgeText = await page
    .locator('[data-testid="artifact-badge"]')
    .textContent()
    .catch(() => null)
  check("B1 产物到达时徽标亮起", badgeText === "1",
    `徽标文案 = ${badgeText === null ? "（不存在）" : `"${badgeText}"`}（期望 "1"：本轮产出了 1 个产物且用户没看过）`)

  await page.locator('[data-testid="toggle-right"]').click()
  await page.waitForTimeout(400)
  // Scope to the artifacts panel: the Workspace section sits above it, is also open
  // by default, and lists the same file (in its file tree) — an unscoped text match
  // lands on that inert row instead.
  const artifactRow = page.locator('[data-testid="artifacts-panel"]').getByText(ARTIFACT, { exact: false }).first()
  const artifactVisible = await artifactRow.isVisible().catch(() => false)
  if (!artifactVisible) {
    skip("B2 产物无需再点一次就可见", `模型没有产出 ${ARTIFACT}（本轮没写文件）—— 后续用例无法执行`)
    throw new Error(`no artifact produced; cannot continue`)
  }
  check("B2 产物区默认展开、产物可见", true, `侧栏内直接看到 ${ARTIFACT}，无需再点一次`)

  // B3 — and opening it clears the badge (seen means seen).
  const badgeAfterOpen = await page.locator('[data-testid="artifact-badge"]').count()
  check("B3 看过之后徽标清零", badgeAfterOpen === 0, `剩余徽标元素 ${badgeAfterOpen} 个`)

  // ---------- C + D: preview takes over the sidebar's space ----------
  await artifactRow.click()
  await page.waitForTimeout(500)
  const w = await page.evaluate(() => (window as any).__p.widths())
  check("C 预览打开时右侧栏消失（互斥）", w.hasPreview && !w.hasSidebar,
    `preview=${w.hasPreview} sidebar=${w.hasSidebar}（旧实现两者并存，chat 被挤到 50%−288px）`)
  const chatShare = w.row > 0 ? w.chat / w.row : 0
  check("D chat 列仍占主区约一半", chatShare > 0.45,
    `chat=${w.chat}px / row=${w.row}px = ${(chatShare * 100).toFixed(1)}%（旧实现此处约 30%）`)

  // ---------- E + H: maximize ----------
  // Send from `half`, THEN maximize, so the agent is mid-turn while we inspect
  // `full`. That covers the banner's baseline and Stop's reachability in one pass.
  const chatWidthHalf = w.chat
  await page.locator("textarea").fill("请用一句话说明你刚才写的文件是做什么的。")
  await page.keyboard.press("Enter")
  await page.waitForTimeout(400) // the user message is appended synchronously
  await page.locator('[data-testid="preview-maximize"]').click()
  await page.waitForTimeout(600)

  const wFull = await page.evaluate(() => (window as any).__p.widths())
  const composerUp = await page.evaluate(() => (window as any).__p.composerVisible())
  const focusable = await page.evaluate(() => (window as any).__p.focusableInChat())
  const stopUp = await page.evaluate(() => (window as any).__p.stopReachable())
  const bannerMidTurn = await page.evaluate(() => (window as any).__p.bannerSaysReplied())

  check("E1 全屏态下转录区不可见", !wFull.chatVisible, `visibility=${wFull.chatVisible ? "visible" : "hidden"}`)
  // Zero-reflow guard: the hidden column keeps the width it had in `half`, so the
  // transcript is not re-wrapped at min-content going in or coming out.
  check("E2 隐藏时宽度不变（零重排）", wFull.chat === chatWidthHalf && wFull.chat > 0,
    `half=${chatWidthHalf}px → full=${wFull.chat}px（若收成 0px，每条消息会按每词一行重排两次）`)
  check("E3 全屏态下没有输入框（整洁）", !composerUp,
    composerUp ? "仍有可见 textarea —— 全屏产物下方的输入框是杂音" : "无可见输入框")
  // a11y: `inert` needs Safari 15.5+ (macOS 12.4+) and we ship to 10.15 —
  // visibility:hidden is what actually has to carry this on every engine.
  check("E4 隐藏的转录区已移出 tab 序列", focusable === 0,
    `chat 列内仍可聚焦的元素：${focusable} 个（>0 ⇒ 键盘会 Tab 进一个看不见的区域）`)
  // Dropping the composer must not drop Stop with it.
  check("E5 全屏态下仍能停止 agent", stopUp,
    stopUp ? "横幅行内有停止按钮" : "无停止按钮 —— 全屏下跑起来就停不掉了")

  // H1 — a message the USER sent must not read as "the agent replied". The baseline
  // counts ASSISTANT messages; counting all messages would include the temp user
  // message that `sendMessage` appends synchronously, flipping the banner on send.
  check("H1 回合进行中横幅不谎报「已回复」", bannerMidTurn === false,
    `data-replied=${bannerMidTurn}（基线若按全部消息计数，用户那条消息会让它立刻翻 true）`)

  // H2 — and it must fire when the agent DOES answer, else H1 passes by never firing.
  await finished(s.id)
  await page.waitForTimeout(1500)
  const bannerAfterReply = await page.evaluate(() => (window as any).__p.bannerSaysReplied())
  check("H2 agent 真回复后横幅确实亮起", bannerAfterReply === true,
    `data-replied=${bannerAfterReply}（若恒为 false，H1 就是靠「永不提示」蒙混过关）`)

  // Diagnostic: was the (hidden) transcript still sticking to the bottom WHILE the
  // agent answered in `full`? If it drifted here, the restore has nothing to restore
  // to — and the two engines differ, because Chromium has native scroll anchoring
  // and WebKit does not (see ADR-047).
  const dInFull = await page.evaluate(() => (window as any).__p.d())
  console.log(`   [diag] full 态下 Δbottom = ${dInFull}px（agent 在隐藏期间回复完）`)

  // ---------- F: the R1 risk — full → half must not break stick-to-bottom ----------
  // The agent answered WHILE the transcript was hidden, so this covers the harder
  // case too: the hidden column must keep growing and keep sticking, and the restore
  // must land at the true bottom rather than where the view was left.
  await page.locator('[data-testid="preview-maximize"]').click()
  // Poll instead of sleep-and-hope: at a fixed timeout, "still settling" and "never
  // arriving" look identical — and telling those apart is the entire point here.
  let dBack = 9999
  const settleStart = Date.now()
  while (Date.now() - settleStart < 6000) {
    dBack = await page.evaluate(() => (window as any).__p.d())
    if (dBack < 20) break
    await page.waitForTimeout(250)
  }
  check("F 全屏往返后仍贴底（R1：保留布局盒而非 display:none）", dBack < 20,
    `Δbottom = ${dBack}px（收敛用时 ${Date.now() - settleStart}ms；若 RO 停摆，会停在几百~几千 px 且永不收敛）`)

  // ---------- G: closing restores the sidebar ----------
  await page.keyboard.press("Escape")
  await page.waitForTimeout(500)
  const wClosed = await page.evaluate(() => (window as any).__p.widths())
  check("G 关闭预览后右侧栏恢复原状", !wClosed.hasPreview && wClosed.hasSidebar,
    `preview=${wClosed.hasPreview} sidebar=${wClosed.hasSidebar}（打开预览前它是开着的）`)
} finally {
  console.log("\n──────── preview-layout e2e ────────")
  for (const r of results) console.log("  " + r)
  const ok = results.length > 0 && results.every((r) => r.startsWith("PASS"))
  console.log(`\n=== VERDICT: ${ok ? "PASS ✅ 全部通过" : "FAIL ❌"} ===`)
  await browser?.close()
  for (const p of procs) p.kill()
  try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { rmSync(wsRoot, { recursive: true, force: true }) } catch {}
  process.exitCode = ok ? 0 : 1
}
