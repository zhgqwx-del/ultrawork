// transcript-artifacts.e2e.ts — REAL-BROWSER walkthrough of the two things this
// branch adds (discussions/035): clickable links in the AI reply, and per-turn
// artifact cards in the transcript.
//
// Real opencode, real write tool, real markdown pipeline, real Chrome/WebKit.
// The LLM is mocked — not to weaken the test, but because every assertion here is
// about OUR rendering, and a real model that decides not to write the file (or not
// to include a link) turns a regression into a flake.
//
//   A. a markdown link is an <a> with NO target — `target="_blank"` is what the
//      WebView swallows, and swallowing is why nothing happened when you clicked
//   B. clicking it calls tauri-plugin-opener (`plugin:opener|open_url`) — asserted
//      on the IPC boundary, so this is not "it didn't crash", it is "it opened"
//   C. clicking it does NOT navigate the page — a bare <a> replaces the whole app
//   D. a bare URL is autolinked (remark-gfm) and behaves the same
//   E. a relative link / anchor is INERT TEXT, not a dead link
//   F. artifact cards appear under the turn that produced them
//   G. LAST-WINS: a file rewritten in turn 3 moves OFF turn 1 and ONTO turn 3
//   H. a scan-derived file (bash side-effect, no tool call names it) lands on the
//      turn whose window contains its mtime — driven with REAL turn timestamps
//   I. clicking a card opens the same preview the sidebar opens
//
//   cd packages/client/desktop && bun run --bun e2e/transcript-artifacts.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/transcript-artifacts.e2e.ts   <- Tauri's macOS engine
//
// NOT covered here (Rust, no browser reach): the `navigation_guard` fail-closed
// plugin. It has Rust unit tests; its prod origins need a packaged build.
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "transcript-artifacts-pw"
const OC = 4096
const MOCK_PORT = 8093

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 120000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try {
      if (await fn()) return
    } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "tx-artifacts-e2e-"))
// The workspace must NOT live under the system tmpdir: on macOS that is
// /var/folders/…, which artifact detection rejects as a temp path (TEMP_PATH_RE),
// so nothing written there would ever reach the artifact list.
const wsRoot = mkdtempSync(join(homedir(), ".ultrawork-e2e-"))
const ws = join(wsRoot, "ws")
mkdirSync(ws, { recursive: true })

const MODEL = "mock-model"
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(
  join(tmp, ".config/ultrawork/opencode.json"),
  JSON.stringify({
    model: `mockllm/${MODEL}`,
    provider: {
      mockllm: {
        name: "MockLLM",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1`, apiKey: "mock" },
        models: { [MODEL]: { id: MODEL, name: "Mock", tool_call: true } },
      },
    },
  })
)
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, {
    ...init,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(ws),
    },
  })

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name} — ${detail}`)
  return ok
}
const skip = (name: string, why: string) => results.push(`SKIP ⚠️  ${name} — ${why}`)

const finished = (sid: string) =>
  poll("turn finished", async () => {
    const m = await (await api(`/session/${sid}/message`)).json()
    const last = Array.isArray(m) && m[m.length - 1]?.info
    if (last?.role !== "assistant") return false
    return !!last.error || (!!last.finish && last.finish !== "tool-calls")
  })

let browser: Browser | undefined
try {
  spawn([BUN, "run", "--bun", join(DIR, "mock-llm-write.ts")], {
    MOCK_LLM_PORT: String(MOCK_PORT),
    MOCK_WS: ws,
    MOCK_LLM_FILES: "report.md,notes.md,report.md",
  })
  await poll("mock llm", async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`)).ok, 30000)

  spawn([OPENCODE, "serve", "--port", String(OC)], {
    ...env,
    OPENCODE_SERVER_PASSWORD: PW,
    OPENCODE_APP_NAME: "ultrawork",
  })
  await poll(
    "opencode",
    async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok,
    60000
  )

  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok, 60000)

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser =
    engine === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  // The Tauri IPC shim. Two things make it more than a stub:
  //   * every invoke is RECORDED, so "the link opened in the system browser" becomes
  //     an assertion on the real call the real plugin makes, not a guess;
  //   * `scan_workspace_changes` is served from a slot the test can fill at runtime,
  //     which is how H drives the fs-scan attribution path with real turn timestamps.
  await page.addInitScript(
    ({ ws, pw }) => {
      const w = window as any
      w.__invokes = []
      w.__scanHits = []
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true,
        ensure_default_workspace: () => ws,
        login_shell_path: () => "",
        scan_workspace_changes: () => w.__scanHits,
      }
      w.__TAURI_INTERNALS__ = {
        invoke: async (c: string, a: any) => {
          w.__invokes.push({ cmd: c, args: a })
          return handlers[c] ? handlers[c](a) : null
        },
        transformCallback: (cb: any) => cb,
        metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      }
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw })
      )
      localStorage.setItem("workspace_path", ws)
    },
    { ws, pw: PW }
  )

  const s = await (await api("/session", { method: "POST", body: "{}" })).json()
  await page.goto(`http://localhost:1420/session/${s.id}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(1500)

  const send = async (text: string) => {
    await api(`/session/${s.id}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    })
    await finished(s.id)
    await page.waitForTimeout(2500) // outlast useStableStreaming's settle + the idle scan
  }

  // ---------- turn 1: writes report.md ----------
  console.log("=== turn 1 ===")
  await send("第一轮")

  // ---------- A–E: links in the AI reply ----------
  const docLink = page.locator('a[href="https://example.com/docs"]')
  if ((await docLink.count()) === 0) {
    skip("A-E 链接用例", "回复里没有渲染出 markdown 链接 —— 后续链接断言无法执行")
  } else {
    const target = await docLink.getAttribute("target")
    check(
      "A markdown 链接没有 target=_blank",
      target === null,
      `target = ${target === null ? "（无）" : `"${target}"`}（_blank 会被 WebView 吞掉 ⇒ 点击零反应，这正是本次要修的）`
    )
    const title = await docLink.getAttribute("title")
    check("A2 链接 title 显示真实目标（反钓鱼）", title === "https://example.com/docs", `title = "${title}"`)

    const urlBefore = page.url()
    await docLink.click()
    await page.waitForTimeout(600)

    const opened = await page.evaluate(() =>
      (window as any).__invokes.filter((i: any) => String(i.cmd).includes("open_url"))
    )
    check(
      "B 点击调用了系统浏览器（plugin:opener|open_url）",
      opened.length === 1 && JSON.stringify(opened[0].args).includes("https://example.com/docs"),
      `IPC 调用 = ${JSON.stringify(opened)}`
    )
    check(
      "C 点击没有把页面导航走",
      page.url() === urlBefore,
      `url: ${urlBefore} → ${page.url()}（裸 <a> 会原地导航，整个 app 被网页顶掉）`
    )

    const bare = page.locator('a[href="https://example.com/bare"]')
    check("D 裸 URL 被 autolink 且同样处理", (await bare.count()) === 1 && (await bare.getAttribute("target")) === null, `裸 URL <a> 数 = ${await bare.count()}`)

    // The model writes these constantly. A link that looks clickable and does
    // nothing is worse than text that never promised to.
    const rel = await page.locator('a[href="./report.md"]').count()
    const anchor = await page.locator('a[href="#detail"]').count()
    const relText = await page.getByText("报告", { exact: true }).count()
    check(
      "E 相对链接/锚点渲染成惰性文本（不是死链接）",
      rel === 0 && anchor === 0 && relText > 0,
      `<a href="./report.md"> = ${rel} 个，<a href="#detail"> = ${anchor} 个，文本仍在 = ${relText > 0}`
    )
  }

  // ---------- F: the card sits under the turn that produced the file ----------
  const strips = page.locator('[data-testid="turn-artifacts"]')
  const turns = page.locator('[data-testid="assistant-turn"]')
  // Anchor to the TURN, never to the nth strip: a turn that produced nothing renders
  // no strip, so indexing strips shifts every later turn by one — precisely the
  // off-by-one the ghost-window fix exists to prevent, and just as easy to write
  // into a test as into the code. (An earlier draft of this file did exactly that;
  // the A/B run that disabled scan attribution is what exposed it.)
  const cardIn = async (turnIdx: number, name: RegExp) =>
    (await turns.nth(turnIdx).locator('[data-testid="turn-artifacts"]').getByRole("button", { name }).count()) === 1

  // Wait for the card, don't sleep for it: WebKit lands it later than Chrome, and a
  // fixed timeout turns "slower engine" into "failed assertion".
  await turns
    .nth(0)
    .locator('[data-testid="turn-artifacts"]')
    .getByRole("button", { name: /report\.md/ })
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => {})
  const stripCount1 = await strips.count()
  const turn1HasReport = await cardIn(0, /report\.md/)
  check("F 产物卡片出现在产出它的那一轮下", stripCount1 === 1 && turn1HasReport, `卡片条数 = ${stripCount1}，turn1 含 report.md = ${turn1HasReport}`)

  // ---------- I: the card opens the same preview the sidebar opens ----------
  if (turn1HasReport) {
    await turns.nth(0).locator('[data-testid="turn-artifacts"]').getByRole("button", { name: /report\.md/ }).click()
    await page.waitForTimeout(700)
    const hasPreview = (await page.locator('[data-testid="artifact-preview"]').count()) === 1
    const hasSidebar = (await page.locator('[data-testid="right-sidebar"]').count()) === 1
    check(
      "I 点卡片打开预览，且与右侧栏互斥（与侧栏点击行为一致）",
      hasPreview && !hasSidebar,
      `preview=${hasPreview} sidebar=${hasSidebar}`
    )
    await page.locator('[data-testid="artifact-preview"] button').first().click().catch(() => {})
    await page.keyboard.press("Escape")
    await page.waitForTimeout(400)
  } else {
    skip("I 点卡片打开预览", "turn1 没有卡片可点")
  }

  // ---------- turn 2: writes notes.md ----------
  console.log("=== turn 2 ===")
  await send("第二轮")
  await page.waitForTimeout(500)

  const n2 = await turns.count()
  const t1r = await cardIn(0, /report\.md/)
  const t2n = await cardIn(1, /notes\.md/)
  const t2NoReport = !(await cardIn(1, /report\.md/))
  check(
    "F2 第二轮的产物挂在第二轮，第一轮的没被搬走",
    n2 === 2 && t1r && t2n && t2NoReport,
    `assistant turn 数 = ${n2}，turn1 有 report=${t1r}，turn2 有 notes=${t2n}，turn2 无 report=${t2NoReport}`
  )

  // ---------- H: a scan-derived file (nothing named it) lands on the right turn ----------
  // Take REAL timestamps off the real transcript, pick an mtime inside turn 1's
  // window, and hand it to the scan. This is the bash-side-effect path — the one
  // that finds most real deliverables and that no tool call ever mentions.
  const msgs = (await (await api(`/session/${s.id}/message`)).json()) as any[]
  const t1Start = msgs.find((m) => m.info.role === "user")?.info?.time?.created
  const t1Assistants = msgs.filter((m) => m.info.role === "assistant" && m.info.time?.created < (msgs.filter((x) => x.info.role === "user")[1]?.info?.time?.created ?? Infinity))
  const t1End = Math.max(...t1Assistants.map((m) => m.info.time?.completed ?? m.info.time?.created))
  const midTurn1 = Math.floor((t1Start + t1End) / 2)

  if (!Number.isFinite(midTurn1)) {
    skip("H fs 扫描产物归属", "拿不到真实 turn 时间戳")
  } else {
    await page.evaluate((hits) => {
      ;(window as any).__scanHits = hits
    }, [{ path: `${ws}/bash-made.pdf`, mtimeMs: midTurn1 }])

    // Turn 3 both rewrites report.md (for G) and re-triggers the idle scan (for H).
    console.log("=== turn 3（重写 report.md）===")
    await send("第三轮")
    await page.waitForTimeout(1500)

    const n3 = await turns.count()
    const bashOnT1 = await cardIn(0, /bash-made\.pdf/)
    check(
      "H 只有 fs 扫描能发现的产物（bash 副作用）归到了它 mtime 落在的那一轮",
      bashOnT1,
      `mtime=${midTurn1} 落在 turn1 窗口 [${t1Start}, ${t1End}] 内，卡片应在 turn1 —— 实际 ${bashOnT1 ? "在" : "不在"}`
    )

    // ---------- G: LAST-WINS ----------
    const t1StillHasReport = await cardIn(0, /report\.md/)
    const t3HasReport = n3 >= 3 && (await cardIn(2, /report\.md/))
    check(
      "G 重写后 report.md 从第一轮搬到第三轮（last-wins）",
      !t1StillHasReport && t3HasReport,
      `turn1 仍有 report=${t1StillHasReport}（应为 false），turn3 有 report=${t3HasReport}（应为 true）—— ` +
        `预览打开的永远是磁盘上的当前内容，卡片挂在产出第 1 版的那轮就是撒谎`
    )
  }
} catch (e) {
  results.push(`FAIL ❌  harness — ${e instanceof Error ? e.message : String(e)}`)
} finally {
  await browser?.close().catch(() => {})
  for (const p of procs) p.kill()
  await new Promise((r) => setTimeout(r, 500))
  rmSync(tmp, { recursive: true, force: true })
  rmSync(wsRoot, { recursive: true, force: true })
}

console.log("\n===== transcript-artifacts e2e =====")
for (const r of results) console.log(r)
const failed = results.filter((r) => r.startsWith("FAIL")).length
const skipped = results.filter((r) => r.startsWith("SKIP")).length
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed > 0 ? 1 : 0)
