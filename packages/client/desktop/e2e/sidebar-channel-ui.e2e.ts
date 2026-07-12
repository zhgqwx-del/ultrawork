// sidebar-channel-ui.e2e.ts — the sidebar half of ADR-051, in a REAL browser
// against a REAL opencode and a REAL gateway.
//
// vitest can't see any of this: it has no layout, no fetch, no SSE, and no gateway.
// The very first run of this harness caught a bug the whole unit suite missed —
// `${gatewayBaseUrl()}/channel/sessions` double-prefixes to /channel/channel/sessions
// and 404s, so the channel badge could never have appeared in the real app.
//
//   A. an old session touched by new activity FLOATS TO THE TOP of the list
//      (the original bug: useSessions patched it in place and never re-sorted)
//   B. the channel badge renders, fed by the real gateway over real HTTP+CORS
//   C. an unread dot appears on a session that moved while you were elsewhere,
//      and clears when you open it
//   D. hover FREEZES the order (mis-click guard) and it thaws on mouse-leave
//
//   cd packages/client/desktop && bun run --bun e2e:sidebar-channel
//   E2E_ENGINE=webkit bun run --bun e2e/sidebar-channel-ui.e2e.ts   <- Tauri's engine
import { chromium, webkit, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const BUN = process.execPath
const PW = "sidebar-e2e-pw"
const OC = 4096 // the dev proxy's target — must be the standard port
const GW = 4097 // ditto for the gateway
const LLM = 4399

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  procs.push(p)
  return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 120000) {
  const s = Date.now()
  while (Date.now() - s < ms) {
    try { if (await fn()) return } catch {}
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout ${label}`)
}

const results: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail = "") => {
  results.push([name, ok, detail])
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const tmp = mkdtempSync(join(tmpdir(), "sidebar-e2e-"))
mkdirSync(join(tmp, "ws"), { recursive: true })
// opencode realpaths the directory it is given (/var/... -> /private/var/... on
// macOS), and the app filters its session list by exact string match against
// workspace_path. Hand both sides the resolved path or the list comes back empty.
const ws = realpathSync(join(tmp, "ws"))
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })

const llmBase = `http://127.0.0.1:${LLM}/v1`
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({
  model: "mockprov/mock-model",
  provider: {
    mockprov: {
      name: "Mock", npm: "@ai-sdk/openai-compatible", api: llmBase,
      options: { baseURL: llmBase, apiKey: "x" },
      models: { "mock-model": { id: "mock-model", name: "Mock", tool_call: true } },
      whitelist: ["mock-model"],
    },
  },
}))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")
const api = (p: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${OC}${p}`, {
    ...init,
    headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(ws) },
  })

/** Titles in sidebar order, top to bottom. */
const ORDER = `[...document.querySelectorAll('aside p > span.truncate')].map(e => e.textContent.trim())`

let browser: Browser | undefined
try {
  spawn([BUN, "run", join(DIR, "mock-llm.ts")], { MOCK_LLM_PORT: String(LLM) })
  await poll("llm", async () => (await fetch(`${llmBase}/models`)).ok)

  spawn([OPENCODE, "serve", "--hostname", "127.0.0.1", "--port", String(OC)],
    { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await api("/global/health")).ok)

  // Two sessions. A is created FIRST, so with a correct (recency) sort it starts
  // BELOW B — and must climb over B the moment it sees activity.
  const mk = async (title: string) => {
    const s = await (await api("/session", { method: "POST", body: "{}" })).json() as any
    await api(`/session/${s.id}`, { method: "PATCH", body: JSON.stringify({ title }) })
    return s.id as string
  }
  const A = await mk("AAA-channel-session")
  await new Promise((r) => setTimeout(r, 1200)) // distinct time.updated
  const B = await mk("BBB-local-session")

  // A REAL gateway, serving a REAL registry entry for A over real HTTP + CORS.
  // (The store/rotation logic itself is covered end-to-end by channel-session-rotation.)
  const { Bridge } = await import("../../../channel/gateway/src/bridge.js")
  const { createApp } = await import("../../../channel/gateway/src/gateway-server.js")
  const bridge = new Bridge()
  ;(bridge as any).store.set({
    sessionId: A, chatId: "u-1", channelType: "wecom",
    senderId: "s-1", senderName: "张三", workspaceDir: ws,
    createdAt: Date.now(), lastActiveAt: Date.now(),
  })
  const app = createApp({ listStatus: () => [], listConfigs: () => [] } as any, undefined, null, bridge)
  const gw = Bun.serve({ hostname: "127.0.0.1", port: GW, fetch: (r) => app.fetch(r) })

  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)

  const engine = process.env.E2E_ENGINE === "webkit" ? "webkit" : "chrome"
  console.log(`=== engine: ${engine} ===`)
  browser = engine === "webkit"
    ? await webkit.launch({ headless: true })
    : await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.addInitScript(({ ws, pw }) => {
    const handlers: Record<string, (a: any) => any> = {
      check_directory_exists: () => true, ensure_default_workspace: () => ws,
      login_shell_path: () => "", scan_workspace_changes: () => [],
    }
    // @ts-ignore
    window.__TAURI_INTERNALS__ = { invoke: async (c: string, a: any) => handlers[c] ? handlers[c](a) : null, transformCallback: (cb: any) => cb, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "", apiUsername: "opencode", apiPassword: pw }))
    localStorage.setItem("workspace_path", ws)
  }, { ws, pw: PW })

  // Open B, so A is the "somewhere else" session that moves behind our back.
  await page.goto(`http://localhost:1420/session/${B}`, { waitUntil: "domcontentloaded" })
  await page.waitForTimeout(3000)


  const before = await page.evaluate(ORDER) as string[]
  check("baseline: newest-first (B above A)",
    before.indexOf("BBB-local-session") < before.indexOf("AAA-channel-session"),
    before.join(" | "))

  // --- B. channel badge, fed by the real gateway ---------------------------
  const badge = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("aside p")]
    const row = rows.find((r) => r.textContent?.includes("AAA-channel-session"))
    const b = row?.querySelector('span[title*="wecom"], span[aria-label*="wecom"]')
    return { found: !!b, label: b?.getAttribute("title") ?? null, svg: !!b?.querySelector("svg") }
  })
  check("B. channel badge rendered from the real gateway registry",
    badge.found && badge.svg, JSON.stringify(badge))
  check("B2. badge names the channel + sender", badge.label?.includes("张三") ?? false, badge.label ?? "")

  // --- A. activity floats the old session to the top -----------------------
  // This is THE bug: the SSE handler patched the session in place, index untouched.
  await api(`/session/${A}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], model: { providerID: "mockprov", modelID: "mock-model" } }),
  })
  await poll("A floats", async () => {
    const o = await page.evaluate(ORDER) as string[]
    return o.indexOf("AAA-channel-session") < o.indexOf("BBB-local-session")
  }, 30000).catch(() => {})

  const after = await page.evaluate(ORDER) as string[]
  check("A. IM activity floats the old session to the TOP",
    after.indexOf("AAA-channel-session") < after.indexOf("BBB-local-session"),
    after.join(" | "))

  const group = await page.evaluate(() => {
    const heads = [...document.querySelectorAll("aside h3")].map((h) => h.textContent?.trim())
    return heads
  })
  check("A2. it lands under a live date group", (group as string[]).length > 0, JSON.stringify(group))

  // --- C. unread dot -------------------------------------------------------
  const unread = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("aside p")]
    const a = rows.find((r) => r.textContent?.includes("AAA-channel-session"))
    const b = rows.find((r) => r.textContent?.includes("BBB-local-session"))
    const dot = (row: Element | undefined) => !!row?.querySelector("span.rounded-full.size-2, span.size-2.rounded-full")
    return { a: dot(a), b: dot(b) }
  })
  check("C. unread dot on the session that moved while you were away", unread.a, JSON.stringify(unread))
  check("C2. no dot on the session you are looking at", !unread.b, JSON.stringify(unread))

  await page.click("text=AAA-channel-session")
  await page.waitForTimeout(1500)
  const cleared = await page.evaluate(() => {
    const row = [...document.querySelectorAll("aside p")].find((r) => r.textContent?.includes("AAA-channel-session"))
    return !!row?.querySelector("span.rounded-full.size-2, span.size-2.rounded-full")
  })
  check("C3. dot clears once you open it", !cleared)

  // --- D. hover freezes the order (mis-click guard) -------------------------
  // Already on A (we clicked into it for C3) — no reload needed. A reload would
  // refetch the list, and taking the baseline before it lands would compare against
  // an empty array and "prove" the freeze held.
  await poll("list loaded", async () => ((await page.evaluate(ORDER)) as string[]).length === 2, 30000)
  const preHover = await page.evaluate(ORDER) as string[]

  // Park the pointer over the list, then make B the most recent.
  const row = await page.$("aside p")
  await row!.hover()
  await page.waitForTimeout(200)
  await api(`/session/${B}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: "hi" }], model: { providerID: "mockprov", modelID: "mock-model" } }),
  })
  await page.waitForTimeout(6000) // plenty of time for the SSE update to land

  const frozen = await page.evaluate(ORDER) as string[]
  check("D. order held still while the pointer is over the list",
    JSON.stringify(frozen) === JSON.stringify(preHover),
    `${preHover.join("|")} → ${frozen.join("|")}`)

  await page.mouse.move(1200, 850) // off the sidebar
  await poll("thaw", async () => {
    const o = await page.evaluate(ORDER) as string[]
    return o.indexOf("BBB-local-session") < o.indexOf("AAA-channel-session")
  }, 15000).catch(() => {})
  const thawed = await page.evaluate(ORDER) as string[]
  check("D2. and re-sorts the moment the pointer leaves",
    thawed.indexOf("BBB-local-session") < thawed.indexOf("AAA-channel-session"),
    thawed.join(" | "))

  gw.stop(true)
} finally {
  for (const p of procs) p.kill()
  await browser?.close().catch(() => {})
  rmSync(tmp, { recursive: true, force: true })
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) {
  console.error("FAILED:\n" + failed.map(([n, , d]) => `  ✗ ${n} ${d}`).join("\n"))
  process.exit(1)
}
console.log("PASS")
