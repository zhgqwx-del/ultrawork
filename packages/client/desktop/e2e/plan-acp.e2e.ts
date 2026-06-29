// plan-acp.e2e.ts — browser walkthrough of the Task Plan panel on the ACP path
// (ADR-038 Phase 2+3). Uses the REAL acp-client sidecar + the deterministic
// mock ACP agent (emits `session/update:plan` frames) so the ACP plan path is
// exercised end-to-end through the real connector + real UI:
//   mock ACP agent → turn-shaper plan.updated → manager snapshot/persist →
//   GET /acp/session/:id/plan → connector ACP getPlan → useSessionPlan → PlanPanel.
//
// The session is created + driven via the sidecar HTTP first (answering the
// mock's permission over its SSE), so the plan is folded + persisted. The
// desktop then hydrates the ACP binding from GET /acp/sessions at launch and
// renders the plan via the REST hydrate path (the switch-back / open scenario).
//
//   cd packages/client/desktop && bun run --bun e2e/plan-acp.e2e.ts
// Needs: system Chrome; built acp-client + opencode binaries.
import { chromium, type Browser } from "playwright-core"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DIR = import.meta.dir
const DESKTOP = join(DIR, "..")
const ARCH = process.arch === "arm64" ? "aarch64" : "x86_64"
const OPENCODE = join(DESKTOP, "src-tauri/binaries", `opencode-server-${ARCH}-apple-darwin`)
const ACP = join(DESKTOP, "src-tauri/binaries", `acp-client-${ARCH}-apple-darwin`)
const MOCK_AGENT = join(DIR, "..", "..", "..", "agent", "acp-client", "scripts", "mock-acp-agent.ts")
const BUN = process.execPath
const PW = "plan-acp-pw"; const OC = 4096; const ACP_PORT = 4099
const SID = "ses_acp_ui"
const EXPECTED = ["List directory", "Summarize"] // mock agent's plan contents

const procs: ReturnType<typeof Bun.spawn>[] = []
const spawn = (cmd: string[], env: Record<string, string>, cwd?: string) => {
  const p = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); procs.push(p); return p
}
async function poll(label: string, fn: () => Promise<boolean>, ms = 60000) {
  const s = Date.now(); while (Date.now() - s < ms) { try { if (await fn()) { console.log(`[ready] ${label}`); return } } catch {} await new Promise((r) => setTimeout(r, 300)) }
  throw new Error(`timeout ${label}`)
}

// Read the session SSE and auto-answer the mock's permission so the turn (and
// thus the plan frames) proceeds.
async function answerPermissions(signal: AbortSignal) {
  const res = await fetch(`http://127.0.0.1:${ACP_PORT}/acp/session/${SID}/events`, { signal })
  const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ""
  while (!signal.aborted) {
    const { done, value } = await reader.read(); if (done) break
    buf += dec.decode(value, { stream: true })
    for (const chunk of buf.split("\n\n")) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"))
      if (!line) continue
      try {
        const ev = JSON.parse(line.slice(5).trim())
        if (ev.type === "permission.asked") {
          await fetch(`http://127.0.0.1:${ACP_PORT}/acp/session/${SID}/permission`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ permissionId: ev.properties.id, reply: "once" }),
          })
        }
      } catch {}
    }
    buf = buf.slice(buf.lastIndexOf("\n\n") + 2)
  }
}

const tmp = mkdtempSync(join(tmpdir(), "plan-acp-")); const ws = join(tmp, "ws"); mkdirSync(ws, { recursive: true })
mkdirSync(join(tmp, ".config/ultrawork"), { recursive: true })
writeFileSync(join(tmp, ".config/ultrawork/agents.json"), JSON.stringify({
  default: "mock",
  agents: { mock: { label: "Mock ACP", command: BUN, args: ["run", MOCK_AGENT] } },
}))
// opencode default backend with an empty config (no model needed — we never prompt it).
writeFileSync(join(tmp, ".config/ultrawork/opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json" }))
const env = { HOME: tmp, XDG_CONFIG_HOME: join(tmp, ".config"), XDG_DATA_HOME: join(tmp, ".local/share"), ACP_DATA_DIR: join(tmp, "acp-data") }
const auth = "Basic " + Buffer.from(`opencode:${PW}`).toString("base64")

let browser: Browser | undefined
let verdict = "INCOMPLETE"
const ac = new AbortController()
try {
  console.log("=== start acp sidecar + opencode + vite ===")
  spawn([ACP], { ...env, ACP_CLIENT_PORT: String(ACP_PORT) })
  await poll("acp sidecar", async () => (await fetch(`http://127.0.0.1:${ACP_PORT}/acp/health`)).ok)
  spawn([OPENCODE, "serve", "--port", String(OC)], { ...env, OPENCODE_SERVER_PASSWORD: PW, OPENCODE_APP_NAME: "ultrawork" })
  await poll("opencode", async () => (await fetch(`http://127.0.0.1:${OC}/global/health`, { headers: { authorization: auth } })).ok)

  console.log("=== create ACP session + run a turn via sidecar HTTP ===")
  const mk = await fetch(`http://127.0.0.1:${ACP_PORT}/acp/session`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: "mock", cwd: ws, clientSessionId: SID }),
  })
  if (!mk.ok) throw new Error(`create session failed: ${mk.status}`)
  void answerPermissions(ac.signal).catch(() => {})
  // Fire the prompt (blocks until turn end); we don't need to await it.
  void fetch(`http://127.0.0.1:${ACP_PORT}/acp/session/${SID}/prompt`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "list the files" }),
  }).catch(() => {})
  await poll("acp plan folded", async () => {
    const r = await (await fetch(`http://127.0.0.1:${ACP_PORT}/acp/session/${SID}/plan`)).json()
    return Array.isArray(r.entries) && r.entries.length === EXPECTED.length
  }, 40000)

  console.log("=== boot vite + chrome, hydrate ACP binding, open session ===")
  spawn([BUN, "run", "dev"], {}, DESKTOP)
  await poll("vite", async () => (await fetch("http://localhost:1420/")).ok)
  browser = await chromium.launch({ channel: "chrome", headless: true })
  const page = await browser.newPage()
  page.on("pageerror", (e) => console.log("[pageerror]", e.message))
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
  await page.waitForTimeout(3500) // let AgentProvider hydrate ACP bindings (GET /acp/sessions)

  // Full reload INTO the session: the binding cache now holds ses_acp_ui→acp:mock,
  // so BindingStore loads it at construction and routing is ACP from the first
  // render (mirrors the real app, where the binding is known before you open the
  // session — here we created it out-of-band so a deep link needs the settled cache).
  for (let i = 0; ; i++) {
    try { await page.goto(`http://localhost:1420/session/${SID}`, { waitUntil: "domcontentloaded" }); break }
    catch (e) { if (i >= 4) throw e; await page.waitForTimeout(2000) }
  }
  await page.waitForTimeout(3500)

  console.log("=== open right sidebar → assert Task Plan panel (ACP) ===")
  await page.getByLabel(/Toggle right sidebar|切换右侧边栏/).click()
  await page.waitForTimeout(1500)
  const text = await page.locator("body").innerText()
  const stepsShown = EXPECTED.filter((s) => text.includes(s))
  const headerShown = /任务规划|Task Plan/.test(text)
  console.log(`[ui] steps shown ${stepsShown.length}/${EXPECTED.length} ${JSON.stringify(stepsShown)}, header=${headerShown}`)

  const ok = stepsShown.length === EXPECTED.length && headerShown
  verdict = ok
    ? "PASS ✅ — ACP plan rendered in the Task Plan panel via the real sidecar + connector + UI"
    : `FAIL ❌ — steps=${stepsShown.length}/${EXPECTED.length} header=${headerShown}`
} catch (e) { verdict = `ERROR: ${(e as Error).message}` }
finally {
  console.log("\n=== VERDICT:", verdict, "===")
  ac.abort()
  if (browser) await browser.close().catch(() => {})
  for (const p of procs) { try { p.kill() } catch {} }
  rmSync(tmp, { recursive: true, force: true })
  process.exit(verdict.startsWith("PASS") ? 0 : 1)
}
