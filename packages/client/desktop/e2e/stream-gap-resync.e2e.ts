// F1b — SSE stream gap that spans the end of a turn (docs/discussions/058).
//
// The opencode event stream has no replay, so text that streams while the socket
// is down is lost. Two cases behave completely differently, and the whole point of
// this harness is that it runs BOTH — measuring only one of them yields a
// confident wrong answer either way:
//
//   A. outage lands INSIDE the turn  → self-heals. The events that follow carry
//      full part text, so the hole fills itself. Nothing to fix; this case exists
//      to prove the fix did not break it.
//   B. outage spans the END of the turn → permanent. Nothing is ever emitted
//      again, so the answer stays frozen at whatever word was in flight (measured
//      before the fix: 7 of 300 markers survived, 97.7% lost). A sidecar crash is
//      always this case, because the turn dies with the process.
//
// The fix (use-session-messages): on a reconnect, an IDLE session re-fetches the
// server snapshot and merges it into the list IN PLACE (never a re-seed — that
// would reset the paginated window). This asserts B recovers WITHOUT navigating
// away; switching sessions has always fixed it and would prove nothing.
//
// NON-VACUITY GATE (the reason the first measurement was wrong): Playwright's
// setOffline does NOT cut loopback. Under it, markers kept arriving right through
// a supposed outage, and the resulting "no gap" was a report about a network that
// never went down. So the outage is made at the TRANSPORT layer with a cuttable
// TCP proxy, and the run FAILS — not passes — unless the UI is measured to STOP
// growing while cut. A harness that cannot fail is not evidence.
//
// Negative control (how this was proven to detect the bug, run 2026-07-30): put
// an early `return` at the top of the resync effect in use-session-messages, and
// case B fails at 19/300 while case A still passes at 300/300 — the harness
// separates "the fix works" from "the stream would have healed anyway".
//
// Run:  cd packages/client/desktop && bun run --bun e2e/stream-gap-resync.e2e.ts
//       E2E_ENGINE=webkit bun run --bun e2e/stream-gap-resync.e2e.ts
// BOTH engines matter and neither substitutes for the other: Chromium is what
// Windows ships (WebView2), WebKit is what macOS and Linux ship (WKWebView /
// WebKitGTK). gotchas §20⑭ was written after a Chrome-only e2e waved through a
// scheme a real WKWebView rejects.
// Needs: system Chrome (playwright-core channel:"chrome") or the bundled WebKit;
//        built opencode sidecar (src-tauri/binaries). Exit 0 = PASS, 1 = FAIL.
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCuttableProxy } from "./cuttable-proxy"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "stream-gap-e2e-pw"
const LLM_PORT = 8088
// 300 markers x 120ms ≈ 36s of streaming. These are NOT arbitrary: they are the
// exact parameters discussions/058 measured, where a clean tree (no fix) yields
// case A = 300/300 and case B = 7/300. Anything shorter is not interchangeable —
// at 90 chunks with a 4s outage the negative control showed case A ALSO failing
// (19/90), i.e. self-heal did not complete before the turn ended, so that
// configuration silently stops being a self-heal guard and becomes a second copy
// of case B. Do not "speed the harness up" by shrinking these without re-running
// the negative control.
const CHUNKS = 300
const DELAY_MS = 120
const TURN_MS = CHUNKS * DELAY_MS
// The renderer talks to 4096 as always; the proxy is what actually lives there.
const OC_PORT = 4096
const OC_REAL_PORT = 4196
const OC_DIRECT = `http://127.0.0.1:${OC_REAL_PORT}`
const ENGINE = process.env.E2E_ENGINE === "webkit" ? webkit : chromium
const ENGINE_NAME = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chromium"

const CASES = [
  // Restores with ~27s of turn left. Measured on a clean tree: 300/300 — the
  // stream refills the hole by itself. This case exists ONLY to prove the fix did
  // not break that path, so it must stay a configuration that passes WITHOUT the
  // fix; see the note on CHUNKS.
  { name: "A · outage INSIDE the turn (must self-heal)", outageMs: 8_000, spansTurnEnd: false },
  // Restores ~9s after the turn already ended. Measured on a clean tree: 7/300 in
  // discussions/058, 19/300 in this harness's own negative control — the survivor
  // count is just wherever the cut landed, the point is that it never grows again.
  { name: "B · outage SPANS the turn end (must be repaired by the resync)", outageMs: 45_000, spansTurnEnd: true },
]

const procs: ReturnType<typeof Bun.spawn>[] = []
// stdout/stderr are "ignore", never "pipe": a piped stream nobody drains fills the
// pipe buffer and blocks the child forever.
const spawn = (cmd: string[], env: Record<string, string> = {}, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try { if (await fn()) return true } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  console.log(`  [timeout] ${label}`)
  return false
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Count distinct M0001..M0090 markers; firstGap = first missing number, or null. */
function analyze(text: string): { count: number; firstGap: number | null } {
  const uniq = [...new Set([...text.matchAll(/\bM(\d{3,4})\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b)
  let firstGap: number | null = null
  for (let i = 0; i < uniq.length; i++) if (uniq[i] !== i + 1) { firstGap = i + 1; break }
  return { count: uniq.length, firstGap }
}

// macOS hands out /var/folders/... which is a symlink to /private/var. opencode
// canonicalises the directory it is given, so an uncanonicalised path makes every
// write look like an escape from the sandbox and tool calls simply never return —
// a hang that impersonates a model timeout.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "f1b-resync-")))
const ws = join(tmp, "ws")
mkdirSync(ws, { recursive: true })
// Case C gets its own workspace: opencode is per-directory, so this keeps the A/B
// sessions — whose titles are full of M#### markers — out of C's sidebar, where a
// whole-page marker count would swallow them.
const wsC = join(tmp, "wsC")
mkdirSync(wsC, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
const baseURL = `http://127.0.0.1:${LLM_PORT}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: {
    mockprov: {
      name: "Mock", npm: "@ai-sdk/openai-compatible", api: baseURL,
      options: { baseURL, apiKey: "dummy" },
      models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: false } },
      whitelist: ["mock-model"],
    },
  },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const srvHeaders = { authorization: auth, "x-opencode-directory": encodeURIComponent(ws) }

const failures: string[] = []
const summary: string[] = []
let browser: Browser | undefined

try {
  console.log(`=== [${ENGINE_NAME}] boot mock-llm + opencode + cuttable proxy + vite ===`)
  spawn([BUN, "run", join(DIR, "mock-llm.ts")], {
    MOCK_LLM_PORT: String(LLM_PORT), MOCK_LLM_CHUNKS: String(CHUNKS), MOCK_LLM_DELAY_MS: String(DELAY_MS),
  })
  if (!await poll("mock-llm", async () => (await fetch(`${baseURL}/models`)).ok)) throw new Error("mock-llm never came up")
  spawn([OPENCODE, "serve", "--port", String(OC_REAL_PORT)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  if (!await poll("opencode", async () => (await fetch(`${OC_DIRECT}/global/health`, { headers: { authorization: auth } })).ok)) throw new Error("opencode never came up")
  const proxy = startCuttableProxy(OC_PORT, OC_REAL_PORT)
  if (!await poll("proxy", async () => (await fetch(`http://127.0.0.1:${OC_PORT}/global/health`, { headers: { authorization: auth } })).ok)) throw new Error("proxy never came up")
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  if (!await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)) throw new Error("vite never came up")

  browser = await ENGINE.launch(ENGINE_NAME === "chromium" ? { channel: "chrome", headless: true } : { headless: true })

  for (const c of CASES) {
    console.log(`\n=== ${c.name} ===`)
    const ctx = await browser.newContext()
    await ctx.addInitScript(({ w, p }) => {
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true, ensure_default_workspace: () => w,
        login_shell_path: () => "", scan_workspace_changes: () => [],
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = { invoke: async (cmd: string, a: any) => (handlers[cmd] ? handlers[cmd](a) : null), transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: p }))
      localStorage.setItem("workspace_path", w)
    }, { w: ws, p: PW })
    const page = await ctx.newPage()
    await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2500)
    const seen = async () => analyze(await page.locator("body").innerText())

    await page.locator("textarea").first().fill("stream the markers please")
    // Headless Chrome reports en-US, so the app renders English and the Home CTA
    // reads "Start Now" — and it is not a <button>, so getByRole finds nothing.
    // Match on text, and accept either locale.
    await page.getByText(/Start Now|马上开始/i).first().click()
    await page.waitForURL(/\/session\//, { timeout: 20_000 })
    const sid = page.url().split("/session/")[1]

    if (!await poll("streaming started", async () => (await seen()).count > 4, 30_000)) throw new Error("stream never started")
    const turnStartedAt = Date.now()

    // --- THE OUTAGE (transport layer; opencode keeps streaming into its store) ---
    proxy.cut()
    const offStart = await seen()
    await sleep(Math.max(1_000, c.outageMs - 800))
    const offEnd = await seen()
    const stalled = offEnd.count === offStart.count
    // The server must have kept producing, or there is nothing to have missed.
    const srvMid = (await (await fetch(`${OC_DIRECT}/session/${sid}/message`, { headers: srvHeaders })).json()) as any[]
    const srvDuring = analyze(srvMid.flatMap((m) => m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join(" ")).count
    console.log(`  [outage] ui ${offStart.count}->${offEnd.count} (stalled=${stalled}) · server has ${srvDuring}`)
    if (!stalled) {
      // Refusing to grade a run where the network never went down is the entire
      // reason this gate exists. Two different faults land here, so name both:
      // GREW means the transport never actually dropped (what Playwright's
      // setOffline does on loopback); SHRANK means something reset the page
      // underneath the measurement — in practice a Vite HMR reload, i.e. someone
      // edited a source file while the harness was running.
      const how = offEnd.count > offStart.count ? "kept growing — the transport never dropped" : "dropped — the page was reset mid-outage (Vite HMR? don't edit sources during a run)"
      failures.push(`${c.name}: VACUOUS — UI markers ${offStart.count}->${offEnd.count} ${how}`)
    }
    const spannedTurnEnd = Date.now() - turnStartedAt > TURN_MS
    proxy.restore()

    // --- Recovery, WITHOUT leaving the session ---
    // The transport retries fast 5 times and then knocks every 15s, so allow a
    // generous window; the assertion is the final count, not how fast it lands.
    const healed = await poll("markers complete", async () => (await seen()).count >= CHUNKS, 75_000)
    await sleep(1_000)
    const final = await seen()

    const srvMsgs = (await (await fetch(`${OC_DIRECT}/session/${sid}/message`, { headers: srvHeaders })).json()) as any[]
    const server = analyze(srvMsgs.flatMap((m) => m.parts ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text ?? "").join(" "))

    console.log(`  [result] ui ${final.count}/${CHUNKS} (firstGap=${final.firstGap}) · server ${server.count} · spannedTurnEnd=${spannedTurnEnd} · healed=${healed}`)
    summary.push(`${c.name} → ui ${final.count}/${server.count}`)
    if (server.count !== CHUNKS) failures.push(`${c.name}: server only produced ${server.count}/${CHUNKS} — the mock stream, not the app, is broken`)
    if (final.count !== server.count) failures.push(`${c.name}: UI shows ${final.count} of the server's ${server.count} markers (missing ${server.count - final.count})`)
    if (final.firstGap !== null) failures.push(`${c.name}: marker sequence has a hole at M${final.firstGap}`)
    // Each case is only itself if the outage landed where it was supposed to.
    // Without this, a slow machine turns case A into case B (or vice versa) and
    // the run reports on a scenario nobody chose.
    if (spannedTurnEnd !== c.spansTurnEnd) {
      failures.push(`${c.name}: outage ${spannedTurnEnd ? "DID" : "did NOT"} span the turn end, expected the opposite — this run graded the wrong scenario`)
    }

    await ctx.close()
  }

  // ======================================================================
  // C) the paginated history the user REVEALED must survive the resync
  // ======================================================================
  // The merge's whole reason to exist is that it is not a re-seed. A re-seed
  // (`setMessages([])` + recomputed `turnStart`) would repair the answer just as
  // well and look correct in cases A/B — and silently throw away the older turns
  // the user pulled in, snapping the viewport. Unit tests pin the merge function;
  // this pins the wiring in the real app.
  //
  // ⚠️ WHERE THIS CASE'S DISCRIMINATING POWER ACTUALLY COMES FROM: `turnStart`,
  // not the message list. Measured — a partial sabotage that only swaps the merge
  // for `setMessages(snapshot)` leaves this case GREEN, because 21 turns fit in
  // one 80-message page so nothing is lost and `turnStart` (0 after "load
  // earlier") is untouched. It only goes red against the sabotage that mirrors the
  // real alternative: also recomputing `turnStart` the way the initial load does.
  // If you ever want this case to catch list truncation too, seed past
  // INITIAL_PAGE_SIZE (>40 turns) — today it does not.
  //
  // Runs in its OWN workspace: opencode is per-directory, so a fresh dir keeps the
  // A/B sessions (whose titles contain M#### markers) out of the sidebar, where
  // they would contaminate a whole-page marker count.
  console.log(`\n=== C · revealed older history survives the resync ===`)
  {
    const SEEDS = 20 // > TURN_INIT (15), so the oldest turns start out windowed away
    const seedHeaders = { ...srvHeaders, "x-opencode-directory": encodeURIComponent(wsC), "content-type": "application/json" }
    const created = await (await fetch(`${OC_DIRECT}/session`, { method: "POST", headers: seedHeaders, body: "{}" })).json() as { id: string }
    const sid = created.id
    for (let i = 1; i <= SEEDS; i++) {
      // SEEDTURN makes mock-llm answer in one frame; 20 real persisted turns in ~a second.
      await fetch(`${OC_DIRECT}/session/${sid}/prompt_async`, {
        method: "POST", headers: seedHeaders,
        body: JSON.stringify({ parts: [{ type: "text", text: `SEEDTURN-${String(i).padStart(2, "0")}` }], model: { providerID: "mockprov", modelID: "mock-model" } }),
      })
      if (!await poll(`seed turn ${i} done`, async () => {
        const r = await fetch(`${OC_DIRECT}/session/status`, { headers: seedHeaders })
        return r.ok && !Object.keys((await r.json()) as object).includes(sid)
      }, 30_000)) throw new Error(`seed turn ${i} never finished`)
    }

    const ctx = await browser.newContext()
    await ctx.addInitScript(({ w, p }) => {
      const handlers: Record<string, (a: any) => any> = {
        check_directory_exists: () => true, ensure_default_workspace: () => w,
        login_shell_path: () => "", scan_workspace_changes: () => [],
      }
      // @ts-ignore
      window.__TAURI_INTERNALS__ = { invoke: async (cmd: string, a: any) => (handlers[cmd] ? handlers[cmd](a) : null), transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: p }))
      localStorage.setItem("workspace_path", w)
    }, { w: wsC, p: PW })
    const page = await ctx.newPage()
    await page.goto(`http://localhost:1420/session/${sid}`, { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3000)
    const bodyText = async () => await page.locator("body").innerText()
    const OLDEST = "SEEDTURN-01"

    // NON-VACUITY for this case: if the oldest turn were on screen from the start,
    // "it is still on screen at the end" would prove nothing at all.
    const hiddenAtFirst = !(await bodyText()).includes(OLDEST)
    console.log(`  [window] oldest turn windowed away on load = ${hiddenAtFirst}`)
    if (!hiddenAtFirst) failures.push(`C: VACUOUS — ${OLDEST} was visible before "load earlier" was ever clicked (turn window did not engage)`)

    // Revealing the older turns is the GOAL; clicking that button is only one way
    // to get there, and on WebKit it is an unreliable one: Playwright scrolls the
    // button into view, that lands at the top of the transcript, the app's own
    // onScrollNearTop fires backfillTurns, the re-render detaches the button and
    // the click never completes ("element was detached from the DOM, retrying")
    // — even though the backfill it triggered is exactly what we wanted. Chromium
    // happened not to hit it. So drive the OUTCOME and let either mechanism win.
    let revealed = false
    for (let i = 0; i < 12 && !revealed; i++) {
      revealed = (await bodyText()).includes(OLDEST)
      if (revealed) break
      await page.getByText(/Load earlier messages|加载更早消息/i).first()
        .click({ timeout: 2_000 }).catch(() => {})
      await page.waitForTimeout(500)
    }
    revealed = revealed || (await bodyText()).includes(OLDEST)
    console.log(`  [reveal] older history revealed = ${revealed}`)
    if (!revealed) failures.push(`C: never revealed ${OLDEST} — cannot test what a resync does to it`)

    // Now a real streaming turn, with an outage that spans its end (case B shape).
    await page.locator("textarea").first().fill("stream the markers please")
    await page.keyboard.press("Enter")
    if (!await poll("streaming started", async () => analyze(await bodyText()).count > 4, 30_000)) throw new Error("C: stream never started")
    const tStart = Date.now()
    proxy.cut()
    const offStart = analyze(await bodyText())
    await sleep(45_000 - 800)
    const offEnd = analyze(await bodyText())
    const stalled = offEnd.count === offStart.count
    console.log(`  [outage] ui ${offStart.count}->${offEnd.count} (stalled=${stalled})`)
    if (!stalled) failures.push(`C: VACUOUS — UI markers ${offStart.count}->${offEnd.count} during the outage`)
    if (Date.now() - tStart <= TURN_MS) failures.push(`C: outage did not span the turn end`)
    proxy.restore()

    const healed = await poll("markers complete", async () => analyze(await bodyText()).count >= CHUNKS, 75_000)
    await sleep(1_000)
    const final = analyze(await bodyText())
    const stillThere = (await bodyText()).includes(OLDEST)
    console.log(`  [result] ui ${final.count}/${CHUNKS} · healed=${healed} · ${OLDEST} still on screen = ${stillThere}`)
    summary.push(`C · revealed history survives → answer ${final.count}/${CHUNKS}, ${OLDEST} ${stillThere ? "kept" : "LOST"}`)
    if (final.count !== CHUNKS) failures.push(`C: answer not repaired — ${final.count}/${CHUNKS}`)
    if (!stillThere) failures.push(`C: the resync WIPED the older history the user had revealed (${OLDEST} gone) — that is a re-seed, not a merge`)
    await ctx.close()
  }
} catch (e) {
  failures.push(`ERROR: ${(e as Error).message}`)
} finally {
  console.log(`\n=== VERDICT ===`)
  for (const s of summary) console.log(`  ${s}`)
  if (failures.length === 0) {
    console.log(`PASS ✅ — in-turn and turn-end-spanning outages both end up showing every marker the server has, and the older history the user revealed is still there`)
  } else {
    console.log(`FAIL ❌`)
    for (const f of failures) console.log(`  · ${f}`)
  }
  try { await browser?.close() } catch {}
  for (const p of procs) { try { p.kill(9) } catch {} }
  await sleep(500)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
}
