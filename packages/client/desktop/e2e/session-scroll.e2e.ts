// session-scroll.e2e.ts — REAL-MODEL walkthrough of transcript stick-to-bottom.
//
// Guards the three independent defects found in ADR-047, none of which any jsdom
// test can see (jsdom has no layout engine — that is why they survived so long):
//
//   A. the turn ends pinned to the bottom            (content-visibility regression)
//   B. contentRef's ResizeObserver actually fires    (flex-stretch regression)
//   C. no content-visibility anywhere in the list    (belt & braces for A)
//   D. a scrollbar drag (NO wheel event) escapes the lock, shows the jump button,
//      and is not yanked back — the homegrown wheel-only detector failed this
//   E. the ExecutionFlow auto-collapse does not shift a scrolled-up reader's viewport
//   F. switching sessions lands at the bottom INSTANTLY, not via a visible spring
//      (the library's `initial` animation only covers the very first resize its content
//      observer sees, and SessionPage is reused across /session/:id changes)
//
//   cd packages/client/desktop && bun run --bun e2e/session-scroll.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/session-scroll.e2e.ts   <- the macOS engine
//
// Run BOTH. Case E is vacuous on Chromium: its native scroll anchoring absorbs the
// collapse on its own, so the compensation in execution-flow.tsx is a no-op there and
// a green E proves nothing. WebKit is where that code actually has to work.
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
const PW = "scroll-e2e-pw"; const OC = 4096

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in auth.json")
  return auth.myqwen.key as string
})()
const MODEL = "qwen3.7-max"
// Long enough that the finished turn is far taller than the 500px
// contain-intrinsic-size fallback that used to swallow it.
const PROMPT =
  "列举至少 20 个可以通过 api key + base url 接入的大模型服务平台，" +
  "每个给出名称、base url、代表模型、计费方式和一句话点评，用 markdown 表格；表格后再写一段分析。"
// Run 2 needs a TALL ExecutionFlow to collapse, so force a pile of tool calls.
// Without them the flow renders ~50px of header and case E tests nothing.
const PROMPT_TOOLS =
  "先用 todowrite 写一个至少 6 步的计划。然后用 bash 工具依次单独运行这 8 条命令" +
  "（每条一次独立的工具调用，不要合并）：pwd、ls -a、date、uname -a、echo one、echo two、echo three、whoami。" +
  "最后写一段不少于 2500 字的详细总结，逐条说明每个命令的输出含义、常见坑、替代命令和使用场景。" +
  "总结必须足够长——它要在折叠执行流之后仍然撑满并超出一屏。"

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 240000) {
  const s = Date.now()
  while (Date.now() - s < ms) { try { if (await fn()) return } catch {} await new Promise((r) => setTimeout(r, 400)) }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "scroll-e2e-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
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
window.__p.watch = () => {
  const { content } = window.__p.el();
  window.__p.roFires = 0; window.__p.heights = new Set();
  new ResizeObserver(() => { window.__p.roFires++; window.__p.heights.add(Math.round(content.getBoundingClientRect().height)); }).observe(content);
};
window.__p.d = () => { const { sc } = window.__p.el(); return sc.scrollHeight - sc.clientHeight - sc.scrollTop; };
window.__p.cvCount = () => document.querySelectorAll('[data-transcript-scroll] [style*="content-visibility"]').length;
window.__p.dragUp = async (px, steps) => {           // no wheel event, ever
  const { sc } = window.__p.el();
  const step = px / steps;
  for (let i = 0; i < steps; i++) { sc.scrollTop -= step; await new Promise(r => setTimeout(r, 60)); }
};
window.__p.answerTop = () => { const a = document.querySelectorAll('[data-transcript-scroll] .space-y-0'); const el = a[a.length - 1]; return el ? Math.round(el.getBoundingClientRect().top) : null; };
window.__p.flowEl = () => {
  const b = [...document.querySelectorAll('[data-transcript-scroll] button')].filter(x => /执行流程|Execution/i.test(x.textContent || ''));
  return b.length ? b[b.length - 1].parentElement : null;
};
window.__p.flowHeight = () => { const f = window.__p.flowEl(); return f ? Math.round(f.getBoundingClientRect().height) : null; };
/** Park the viewport just below the ExecutionFlow, so the collapse happens entirely
 *  above the visible area — the only case where the anchor compensation should act. */
window.__p.parkBelowFlow = () => {
  const { sc } = window.__p.el(); const f = window.__p.flowEl();
  if (!f) return null;
  const flowBottomInScroll = f.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = flowBottomInScroll + 20;
  return { scrollTop: Math.round(sc.scrollTop), flowH: Math.round(f.getBoundingClientRect().height) };
};
window.__p.sample = () => {
  window.__p.samples = [];
  const tick = () => {
    const { sc } = window.__p.el();
    const f = window.__p.flowEl();
    const a = document.querySelectorAll('[data-transcript-scroll] .space-y-0');
    const ans = a[a.length - 1];
    window.__p.samples.push({
      t: Math.round(performance.now()),
      sh: sc.scrollHeight, ch: sc.clientHeight, st: Math.round(sc.scrollTop),
      flowH: f ? Math.round(f.getBoundingClientRect().height) : -1,
      ansTop: ans ? Math.round(ans.getBoundingClientRect().top) : -1,
      ansKids: ans ? ans.children.length : -1,
      ansH: ans ? Math.round(ans.getBoundingClientRect().height) : -1,
    });
    if (window.__p.samples.length < 20000) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};
window.__p.flowBottomRelViewport = () => {
  const { sc } = window.__p.el(); const f = window.__p.flowEl();
  return f ? Math.round(f.getBoundingClientRect().bottom - sc.getBoundingClientRect().top) : null;
};
`

async function newSession(page: Page) {
  const s = await (await api("/session", { method: "POST", body: "{}" })).json()
  await page.goto(`http://localhost:1420/session/${s.id}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2000)
  await page.evaluate(PROBE)
  await page.evaluate(() => (window as any).__p.watch())
  return s.id as string
}
// Mirrors isTurnTerminal (message-list.tsx): an intermediate tool step also carries
// `time.completed`, so waiting on that returns mid-turn. Only a `finish` other than
// "tool-calls" (or a message-level error) ends the turn.
const finished = (sid: string) => poll("turn finished", async () => {
  const m = await (await api(`/session/${sid}/message`)).json()
  const last = Array.isArray(m) && m[m.length - 1]?.info
  if (last?.role !== "assistant") return false
  return !!last.error || (!!last.finish && last.finish !== "tool-calls")
})
/** Wait for useStableStreaming's 600ms settle to actually collapse the flow. */
const collapsed = (page: Page) => poll("flow collapsed", async () =>
  ((await page.evaluate(() => (window as any).__p.flowHeight())) ?? 999) < 100, 20000)

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = { check_directory_exists: () => true, ensure_default_workspace: () => ws, login_shell_path: () => "", scan_workspace_changes: () => [] }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })
  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)

  // ---------- Run 1: the follower (A, B, C) ----------
  console.log("=== run 1: 用户不动，回复完成应贴底 ===")
  const sid1 = await newSession(page)
  await api(`/session/${sid1}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }] }) })
  await finished(sid1)
  await page.waitForTimeout(2000) // outlast useStableStreaming's 600ms settle

  const d1 = await page.evaluate(() => (window as any).__p.d())
  const ro = await page.evaluate(() => ({ fires: (window as any).__p.roFires, heights: (window as any).__p.heights.size }))
  const cv = await page.evaluate(() => (window as any).__p.cvCount())
  check("A 完成后贴底", d1 < 100, `Δbottom = ${d1}px (阈值 100)`)
  check("B contentRef 的 ResizeObserver 存活", ro.fires > 5 && ro.heights > 5, `触发 ${ro.fires} 次，观察到 ${ro.heights} 个不同高度`)
  check("C 列表内无 content-visibility", cv === 0, `找到 ${cv} 个带 content-visibility 的元素`)

  // ---------- Run 2: the reader (D, E) ----------
  console.log("=== run 2: 用户中途拖滚动条上滚，不应被拽回；折叠不应跳动 ===")
  const sid2 = await newSession(page)
  await api(`/session/${sid2}/prompt_async`, { method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: PROMPT_TOOLS }] }) })

  // Wait for a tall ExecutionFlow AND enough answer text BELOW it that the viewport
  // can sit under the flow without clamping (`headroom` = how far past the flow's
  // bottom we can still scroll). Without the headroom check, parkBelowFlow clamps
  // and the flow stays on screen, making case E vacuous.
  const start = Date.now()
  let obs = { flowH: 0, scrollable: 0, headroom: 0 }
  let met = false
  while (Date.now() - start < 240000) {
    obs = await page.evaluate(() => {
      const p = (window as any).__p
      const { sc } = p.el()
      const f = p.flowEl()
      const flowBottomInScroll = f ? f.getBoundingClientRect().bottom - sc.getBoundingClientRect().top + sc.scrollTop : 0
      const scrollable = sc.scrollHeight - sc.clientHeight
      return { flowH: p.flowHeight() ?? 0, scrollable, headroom: Math.round(scrollable - flowBottomInScroll) }
    })
    if (obs.flowH > 250 && obs.headroom > 300) { met = true; break }
    if ((Date.now() - start) % 6000 < 500) console.log(`   [wait] flowH=${obs.flowH} scrollable=${obs.scrollable} headroom=${obs.headroom}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log(`   [ready] flowH=${obs.flowH} scrollable=${obs.scrollable} headroom=${obs.headroom} met=${met}`)
  // Never proceed silently on a degenerate scene. `headroom` is the answer text that
  // survives the collapse; if it is under a viewport, scrollTop necessarily clamps to
  // 0 and case E measures the clamp instead of the scroll behaviour.
  if (!met) check("E-前置 等到足够高的执行流 + 足够长的答案", false,
    `超时未满足：flowH=${obs.flowH}(需>250) headroom=${obs.headroom}(需>300) —— 模型这轮答案太短，E 不作数`)

  await page.evaluate(() => (window as any).__p.dragUp(900, 6))
  await page.waitForTimeout(1200)
  const dEscaped = await page.evaluate(() => (window as any).__p.d())
  const btn = page.getByLabel(/回到底部|Scroll to bottom/)
  const btnVisible = await btn.isVisible().catch(() => false)
  check("D1 拖滚动条上滚后未被拽回", dEscaped > 400, `Δbottom = ${dEscaped}px (拖走了 900px，无 wheel 事件)`)
  check("D2 「回到底部」按钮出现", btnVisible, btnVisible ? "可见" : "未出现")

  // E: park just below the flow, then hold that position across completion +
  // auto-collapse. `flowBottomRelViewport < 0` proves the collapsing block really is
  // above the visible area — otherwise this case would pass vacuously.
  const park = await page.evaluate(() => (window as any).__p.parkBelowFlow())
  await page.waitForTimeout(600)
  const flowRel = await page.evaluate(() => (window as any).__p.flowBottomRelViewport())
  const flowH = await page.evaluate(() => (window as any).__p.flowHeight())
  await page.evaluate(() => (window as any).__p.sample())
  const beforeTop = await page.evaluate(() => (window as any).__p.answerTop())
  const setupOk = check("E0 前置：执行流够高且完全在视口上方", met && (flowH ?? 0) > 250 && (flowRel ?? 1) <= 0,
    `执行流高 ${flowH}px，其底边相对视口顶 ${flowRel}px（须 ≤0），park=${JSON.stringify(park)}`)

  await finished(sid2)
  await collapsed(page).catch(() => console.log("   [warn] 执行流未在 20s 内折叠"))
  await page.waitForTimeout(1800) // anchoring + any spring
  const afterTop = await page.evaluate(() => (window as any).__p.answerTop())
  const flowHAfter = await page.evaluate(() => (window as any).__p.flowHeight())
  const shift = beforeTop != null && afterTop != null ? Math.abs(afterTop - beforeTop) : -1
  // Bracket the collapse with the rAF samples: the frame before it and the frame it
  // lands on. Comparing endpoints instead would fold in unrelated drift from the rest
  // of the turn and report a jump that the collapse never caused.
  const s2 = await page.evaluate(() => (window as any).__p.samples) as any[]
  const drop = s2.findIndex((x, i) => i > 0 && s2[i - 1].flowH > 200 && x.flowH < 100)
  const fmt = (x: any) => `t=${x.t} sh=${x.sh} st=${x.st} flowH=${x.flowH} ansTop=${x.ansTop} ansKids=${x.ansKids} ansH=${x.ansH}`
  const shrinkIdx = s2.findIndex((x, i) => i > 0 && s2[i - 1].sh - x.sh > 300)
  if (shrinkIdx > 0) { console.log("   [shrink] 折叠前的转录区收缩:"); for (const x of s2.slice(Math.max(0, shrinkIdx - 2), shrinkIdx + 3)) console.log("     " + fmt(x)) }
  if (drop > 0) {
    console.log("   [collapse] 折叠帧前后:")
    for (const x of s2.slice(Math.max(0, drop - 2), drop + 3)) console.log("     " + fmt(x))
  }
  const frameShift = drop > 0 ? Math.abs(s2[drop].ansTop - s2[drop - 1].ansTop) : -1
  check("E1 执行流确实折叠了", setupOk && (flowHAfter ?? 999) < (flowH ?? 0) - 150, `折叠前 ${flowH}px → 折叠后 ${flowHAfter}px`)

  // E2 only means something when the transcript still overflows AFTER the collapse.
  // Otherwise scrollTop necessarily clamps to 0 and we would be measuring the clamp.
  // That precondition cannot be forced with a real model: a step that emits text and
  // THEN calls another tool has its text reclassified from answer to narration
  // (buildTurnModel / ADR-029), which can shed thousands of px mid-turn and drop the
  // parked reader back near the bottom. So: assert when we can, skip loudly when we
  // cannot — never quietly pass.
  const roomAfter = drop > 0 ? s2[drop].sh - s2[drop].ch : -1
  const reallyEscaped = drop > 0 && s2[drop - 1].sh - s2[drop - 1].ch - s2[drop - 1].st > 200
  if (drop <= 0) skip("E2 折叠那一帧未让阅读位置跳动", "未在 rAF 采样中捕获到折叠帧")
  else if (roomAfter < 300 || !reallyEscaped)
    skip("E2 折叠那一帧未让阅读位置跳动",
      `场景退化：折叠后可滚动高度仅 ${roomAfter}px，或折叠前阅读位置已贴近底部 —— 位移 ${frameShift}px 只是钳制，不作数`)
  else check("E2 折叠那一帧未让阅读位置跳动", frameShift < 20, `折叠帧内答案区位移 ${frameShift}px（累计 ${shift}px）`)

  // D3: the button brings us back (still escaped after the collapse, so it is there).
  const btnStillVisible = await btn.isVisible().catch(() => false)
  if (btnStillVisible) {
    await btn.click()
    await page.waitForTimeout(1500)
    const dBack = await page.evaluate(() => (window as any).__p.d())
    check("D3 点「回到底部」后回到底部", dBack < 100, `Δbottom = ${dBack}px`)
  } else {
    // Only a real failure if the reader was genuinely far from the bottom; a shrunk
    // transcript legitimately clamps them there (see E2's note).
    const clamped = await page.evaluate(() => { const { sc } = (window as any).__p.el(); return sc.scrollHeight - sc.clientHeight < 300 })
    if (clamped) skip("D3 点「回到底部」后回到底部", "折叠后转录区短于视口，按钮本就不该出现")
    else check("D3 点「回到底部」后回到底部", false, "折叠后按钮消失 —— 视图被拉回底部，逃逸态没保住")
  }
  // ---------- F: 会话切换（客户端路由，SessionPage 不重挂载）----------
  console.log("=== run 3: 从短会话切回长会话，应瞬间贴底而非弹簧滚动 ===")
  await page.goto(`http://localhost:1420/session/${sid2}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)
  await page.evaluate(PROBE)
  await page.evaluate((id) => {
    history.pushState({}, "", `/session/${id}`)
    window.dispatchEvent(new PopStateEvent("popstate"))
  }, sid1)
  const traj = await page.evaluate(() => new Promise<number[]>((res) => {
    const sc = document.querySelector("[data-transcript-scroll]") as HTMLElement
    const seen: number[] = []; const t0 = performance.now()
    const tick = () => { seen.push(Math.round(sc.scrollTop)); performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : res(seen) }
    requestAnimationFrame(tick)
  }))
  await page.waitForTimeout(500)
  const dSwitch = await page.evaluate(() => (window as any).__p.d())
  const steps = new Set(traj).size
  check("F1 切换会话后贴底", dSwitch < 100, `Δbottom = ${dSwitch}px`)
  check("F2 切换是瞬间到底而非弹簧动画", steps <= 5, `scrollTop 经过 ${steps} 个不同取值（弹簧会有几十个；修复前实测 75 个）`)
} catch (e) {
  results.push(`ERROR: ${(e as Error).message}`)
} finally {
  console.log("\n──────── session-scroll e2e ────────")
  for (const r of results) console.log("  " + r)
  const ok = results.length > 0 && !results.some((r) => r.startsWith("FAIL") || r.startsWith("ERROR"))
  console.log(`\n=== VERDICT: ${ok ? "PASS ✅ 全部通过" : "FAIL ❌"} ===`)
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(ok ? 0 : 1)
}
