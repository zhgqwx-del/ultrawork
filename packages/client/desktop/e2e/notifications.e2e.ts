// notifications.e2e.ts — REAL-MODEL walkthrough of turn-completion notifications (ADR-053).
//
// Why a real browser and not jsdom: the defect that actually shipped was NOT in the
// decision layer (which the unit tests cover, and which was right). It was that the
// most common path of all — ask something from Home, walk away — starts its turn in
// `Home.tsx` via `connector.prompt`, bypassing the composer's `sendMessage` where the
// allowlist was registered. Nothing below the UI could see that. Only driving the real
// app through a real turn does.
//
//   cd packages/client/desktop && bun run --bun e2e/notifications.e2e.ts
//   E2E_ENGINE=webkit bun run --bun e2e/notifications.e2e.ts   <- the macOS engine
//
// The three effects are invisible even here (a chime, an OS banner, a bouncing dock),
// so we install a fake Tauri bridge: `__TAURI_INTERNALS__.invoke` answers the window +
// notification plugin commands and records them, `window.Notification` is spied (that
// is literally what the plugin calls for a desktop banner), and `AudioContext` counts
// oscillators. Unknown commands REJECT, exactly like a non-Tauri host, so the app's own
// fallbacks (sidecar ports/credentials) behave as they always do.
//
// Needs: system Chrome (or playwright webkit); built opencode binary; a `myqwen` key.
import { chromium, webkit, type Browser, type Page } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "notify-e2e-pw"
const OC = 4096

const KEY = (() => {
  const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/ultrawork/auth.json"), "utf-8"))
  if (!auth.myqwen?.key) throw new Error("no myqwen key in auth.json")
  return auth.myqwen.key as string
})()
const MODEL = "qwen3.7-max"
const PROMPT = "Reply with exactly: pong. Do not use any tools."

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 180000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) return } catch {}
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout ${label}`)
}

const tmp = mkdtempSync(join(tmpdir(), "notify-e2e-"))
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
const authHeader = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, {
    ...init,
    headers: { authorization: authHeader, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) },
  })

/**
 * The fake Tauri bridge. Installed before ANY app code runs.
 *
 * `inTauri` in notify-effects.ts is `"__TAURI_INTERNALS__" in window`, so this flips the
 * effects from their browser no-op path onto the real one — which is the code we need to
 * exercise. Unknown commands reject on purpose: that is what a non-Tauri host does, and
 * the app's port/credential loaders are built to fall back on exactly that.
 */
const BRIDGE = ({ ws, pw }: { ws: string; pw: string }) => `
window.__notify = { chimes: 0, banners: [], flashes: 0, invokes: [] };
window.__focused = true;   // the test flips this to stage "the user walked away"

// The app itself needs a workspace and credentials, exactly as the other e2es seed them —
// without this it parks on the workspace picker and there is no composer to type into.
localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: ${JSON.stringify(pw)} }));
localStorage.setItem("workspace_path", ${JSON.stringify(ws)});

const appHandlers = {
  check_directory_exists: () => true,
  ensure_default_workspace: () => ${JSON.stringify(ws)},
  login_shell_path: () => "",
  scan_workspace_changes: () => [],
};

let cbId = 0;
window.__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  transformCallback: (cb) => { const id = ++cbId; window["_" + id] = cb; return id },
  invoke: (cmd, args) => {
    window.__notify.invokes.push(cmd);
    switch (cmd) {
      case "plugin:window|is_focused":
        // Driven by the test, NOT by document.hasFocus(): headless Chrome keeps a page
        // "focused" even after another tab is brought to front, so a real blur cannot be
        // staged here (the first version of this file staged one, got focused=true, and
        // read the resulting — correct — silence as a product bug).
        // The focus READ itself is not what this file guards; the real-window probe
        // already established that Tauri's isFocused() is false in all four
        // "user cannot see us" states (discussions/036 §4 V3). What it guards is what
        // the app DOES with that bit.
        return Promise.resolve(window.__focused !== false);
      case "plugin:window|request_user_attention":
        window.__notify.flashes++;
        return Promise.resolve();
      case "plugin:notification|is_permission_granted":
        return Promise.resolve(true);
      case "plugin:event|listen":
        return Promise.resolve(++cbId);
      case "plugin:event|unlisten":
        return Promise.resolve();
      case "probe_log":
        window.__notify.traces = window.__notify.traces || [];
        window.__notify.traces.push(args && args.msg);
        return Promise.resolve();
      default:
        if (appHandlers[cmd]) return Promise.resolve(appHandlers[cmd](args));
        // Resolve null (NOT reject) for everything else, mirroring the other e2es'
        // stub. A rejection here sends loadSidecarCredentials down its "unauthenticated"
        // fallback, the SSE stream 401s in a retry loop, and every notification case
        // below goes quietly vacuous — the silent cases pass while the whole feature
        // is dead. Cost me a run to find.
        return Promise.resolve(null);
    }
  },
};

// Diagnostic: which fetches fail (SSE included).
window.__fetchFails = [];
const realFetch = window.fetch;
window.fetch = async (...a) => {
  try { return await realFetch(...a) }
  catch (e) { window.__fetchFails.push(String(a[0]).slice(0, 120) + " :: " + e); throw e }
};

// Diagnostic: what SSE event types actually reach the renderer.
window.__sseSeen = {};
const RealES = window.EventSource;
window.EventSource = class extends RealES {
  constructor(...a) {
    super(...a);
    this.addEventListener("message", (e) => {
      try { const t = JSON.parse(e.data).type; window.__sseSeen[t] = (window.__sseSeen[t] || 0) + 1 } catch {}
    });
  }
};

// What the notification plugin actually calls for a desktop banner.
class SpyNotification {
  constructor(title, opts) { window.__notify.banners.push({ title, body: opts && opts.body }) }
  static permission = "granted";
  static requestPermission() { return Promise.resolve("granted") }
}
window.Notification = SpyNotification;

// The chime: count oscillators, don't make noise in CI.
const RealAC = window.AudioContext || window.webkitAudioContext;
class SpyAC extends RealAC {
  createOscillator() { window.__notify.chimes++; return super.createOscillator() }
}
window.AudioContext = SpyAC;
`

const results: string[] = []
const check = (name: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS ✅" : "FAIL ❌"}  ${name} — ${detail}`)
  return ok
}

type Counts = { chimes: number; banners: number; flashes: number }
const counts = (page: Page): Promise<Counts> =>
  page.evaluate(() => {
    const n = (window as any).__notify
    return { chimes: n.chimes, banners: n.banners.length, flashes: n.flashes }
  })
const delta = (a: Counts, b: Counts): Counts => ({
  chimes: b.chimes - a.chimes,
  banners: b.banners - a.banners,
  flashes: b.flashes - a.flashes,
})
const silent = (d: Counts) => d.chimes === 0 && d.banners === 0 && d.flashes === 0
const allThree = (d: Counts) => d.chimes >= 1 && d.banners >= 1 && d.flashes >= 1

/** A turn is over only on a terminal finish — an intermediate tool step also carries time.completed. */
const finished = (sid: string, minAssistant = 1) =>
  poll("turn finished", async () => {
    const m = await (await api(`/session/${sid}/message`)).json()
    if (!Array.isArray(m)) return false
    const assistants = m.filter((x: any) => x.info?.role === "assistant")
    if (assistants.length < minAssistant) return false
    const last = assistants[assistants.length - 1].info
    return !!last.error || (!!last.finish && last.finish !== "tool-calls")
  })

const sessionsOf = async (): Promise<any[]> => (await (await api("/session")).json()) as any[]

let browser: Browser | undefined
try {
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: authHeader } })).ok, 60000)
  // A stale vite on 1420 (e.g. left over from a `tauri dev`) would serve DIFFERENT code
  // than this run believes it is testing — and every case would still "pass" or "fail"
  // for reasons that have nothing to do with the diff. Refuse to run.
  if (await fetch("http://localhost:1420/").then((r) => r.ok).catch(() => false)) {
    throw new Error("port 1420 is already served by something else — kill it first")
  }
  spawn([BUN, "run", "dev"], { VITE_NOTIFY_TRACE: "1" }, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok, 60000)

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser = engine === "webkit" ? await webkit.launch({ headless: true }) : await chromium.launch({ channel: "chrome", headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  page.on("console", (m) => { const t = m.text(); if (/NOTIFYDBG/.test(t)) console.log("[browser]", t.slice(0, 200)) })
  await page.addInitScript(BRIDGE({ ws, pw: PW }))
  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(2500)

  const composer = () => page.locator("textarea").first()

  // ---------------------------------------------------------------- 1. the flagship
  // Home → new session → walk away. This is the exact path that shipped silent.
  const before1 = await counts(page)
  await composer().fill(PROMPT)
  await composer().press("Enter")
  await page.waitForTimeout(1200)
  await page.evaluate(() => { (window as any).__focused = false })   // the user walks away

  const sids = await poll("session created", async () => (await sessionsOf()).length > 0).then(sessionsOf)
  const sid1 = sids[0].id as string
  await finished(sid1)
  await page.waitForTimeout(2500)
  const d1 = delta(before1, await counts(page))

  check("A. Home 首轮 + 用户离开 → 三个通道都响", allThree(d1), JSON.stringify(d1))

  // -------------------------------------------------------- 2. the negative control
  // Back on the very session that is running: it must stay completely silent. Without
  // this, "it always notifies" would pass case A and nobody would notice.
  await page.evaluate(() => { (window as any).__focused = true })   // the user is back, on this session
  const before2 = await counts(page)
  await composer().fill("Reply with exactly: pong2. Do not use any tools.")
  await composer().press("Enter")
  await finished(sid1, 2)
  await page.waitForTimeout(3000)
  const d2 = delta(before2, await counts(page))

  check("B. 聚焦 + 正在看该会话 → 完全静默（负向对照）", silent(d2), JSON.stringify(d2))

  // --------------------------------------------- 3. focused, but looking elsewhere
  // The differentiator: a window that is focused on ANOTHER session still has to tell
  // you that this one finished. A focus-only gate (the reference implementation) cannot.
  await composer().fill("Reply with exactly: pong3. Do not use any tools.")
  await composer().press("Enter")
  await page.waitForTimeout(800)
  // Client-side navigation, NOT page.goto: a real reload drops the in-flight allowlist
  // (a module singleton, deliberately not persisted — see notify-registry). Only an app
  // RESTART does that in production, and this case is about a user who merely walked to
  // another screen. Driving it with goto tested the wrong thing and failed for it.
  // history + popstate = what react-router does for an in-app link, without the reload.
  await page.evaluate(() => {
    window.history.pushState({}, "", "/")
    window.dispatchEvent(new PopStateEvent("popstate"))
  })
  await page.waitForTimeout(500)
  const onHome = await page.evaluate(() => location.pathname)
  const before3 = await counts(page)
  await finished(sid1, 3)
  await page.waitForTimeout(3000)
  const d3 = delta(before3, await counts(page))

  check("C. 聚焦但已离开该会话 → 仍然提醒", onHome === "/" && allThree(d3), `path=${onHome} ${JSON.stringify(d3)}`)

  // ------------------------------------------------- 4. foreign (IM channel) session
  // A turn the desktop user never started — an IM message routed by the gateway looks
  // exactly like this to the renderer. It must not make a sound, ever.
  await page.evaluate(() => { (window as any).__focused = false })   // away, so only the allowlist can keep it quiet
  const before4 = await counts(page)
  const foreign = await (await api("/session", { method: "POST", body: "{}" })).json()
  await api(`/session/${foreign.id}/message`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: PROMPT }], model: { providerID: "myqwen", modelID: MODEL } }),
  })
  await finished(foreign.id)
  await page.waitForTimeout(3000)
  const d4 = delta(before4, await counts(page))

  check("D. 渠道/外部发起的会话完成 → 静默（白名单）", silent(d4), JSON.stringify(d4))

  // The bridge has to have actually been used, or every case above is vacuously green.
  const fails = await page.evaluate(() => [...new Set((window as any).__fetchFails ?? [])].slice(0, 5))
  console.log("=== failing fetches:", JSON.stringify(fails, null, 1))
  const traces = await page.evaluate(() => (window as any).__notify.traces ?? [])
  console.log("=== decision traces:", JSON.stringify(traces))
  const invokeList = await page.evaluate(() => (window as any).__notify.invokes)
  console.log("=== invokes:", JSON.stringify(invokeList))
  const evs = await page.evaluate(() => (window as any).__sseSeen ?? "no sse probe")
  console.log("=== sse seen:", JSON.stringify(evs))
  const invoked = await page.evaluate(() => (window as any).__notify.invokes.filter((c: string) => c.startsWith("plugin:")).length)
  check("E. 假 Tauri 桥确实被调用（防止用例空转）", invoked > 0, `${invoked} plugin invokes`)
} catch (err) {
  // Without this, `process.exit` in the finally block swallows the throw and the run
  // prints an empty result list with exit 0 — a crash that looks like a clean pass.
  results.push(`FAIL ❌  harness threw — ${err instanceof Error ? err.stack : String(err)}`)
} finally {
  console.log("\n" + results.join("\n"))
  await browser?.close().catch(() => {})
  for (const p of procs) p.kill()
  const failed = results.filter((r) => r.startsWith("FAIL")).length
  process.exit(failed > 0 ? 1 : 0)
}
