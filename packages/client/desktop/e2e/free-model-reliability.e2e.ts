/**
 * Offline acceptance: real Vite/React, Chrome/WebKit, OpenCode binary, ACP registry
 * and managed delegate MCP. Only the LLM HTTP service and native Tauri IPC are
 * fixtures. No user HOME, provider key, external model or fixed port is used.
 *
 * bun run --bun packages/client/desktop/e2e/free-model-reliability.e2e.ts
 * E2E_ENGINE=webkit selects installed Playwright WebKit. CHROME_PATH and
 * E2E_OPENCODE_BINARY / E2E_ACP_BINARY may select native executable overrides.
 * E2E_CASES=acp-auth (comma-separated scenario names) narrows a diagnostic run.
 */
import assert from "node:assert/strict"
import { createHash, randomBytes } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { chromium, webkit, type Browser, type BrowserContext, type Page } from "playwright-core"
import { DEFAULT_BRAND } from "@agent/brand"
import type { RuntimeBrandContext } from "@agent/brand/node"
import { en } from "../src/lib/i18n-translations"

const desktop = resolve(import.meta.dir, "..")
const repo = resolve(desktop, "../../..")
const engine = process.env.E2E_ENGINE ?? "chrome"
assert(engine === "chrome" || engine === "webkit", "E2E_ENGINE must be chrome or webkit")
const scenarioNames = ["quota", "fallback", "attachments", "stop", "output-error", "team-first", "team-delegate", "acp-auth"]
const selectedCases = (process.env.E2E_CASES ?? "").split(",").map((name) => name.trim()).filter(Boolean)
for (const name of selectedCases) assert(scenarioNames.includes(name), `Unknown E2E_CASES scenario: ${name}`)
const output = resolve(process.env.E2E_OUTPUT ?? join(repo, ".brand-build", "verification", "free-model-browser", engine))
mkdirSync(output, { recursive: true })
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "uw-free-model-browser-")))
const home = join(sandbox, "home"), workspace = join(sandbox, "workspace 客户"), temporary = join(sandbox, "tmp")
for (const directory of [home, workspace, temporary]) mkdirSync(directory, { recursive: true })
const password = randomBytes(24).toString("hex")
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const nativeTarget = () => {
  assert(process.arch === "arm64" || process.arch === "x64", `Unsupported native architecture ${process.arch}`)
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
  if (process.platform === "darwin") return `${arch}-apple-darwin`
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc"
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`
  throw new Error(`Unsupported native platform ${process.platform}/${process.arch}`)
}
const binary = (name: string, override?: string) => resolve(override ?? join(desktop, "src-tauri", "binaries", `${name}-${nativeTarget()}${process.platform === "win32" ? ".exe" : ""}`))
const opencodeBinary = binary("opencode-server", process.env.E2E_OPENCODE_BINARY)
const acpBinary = binary("acp-client", process.env.E2E_ACP_BINARY)
for (const file of [opencodeBinary, acpBinary]) assert(existsSync(file), `Build native sidecar first: ${file}`)
const binaryEvidence = [opencodeBinary, acpBinary].map((path) => ({ path,
  modifiedAt: statSync(path).mtime.toISOString(), sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  metadata: existsSync(`${path}.metadata.json`) ? JSON.parse(readFileSync(`${path}.metadata.json`, "utf8")) : undefined,
}))
const brand: RuntimeBrandContext = {
  schemaVersion: 1, identity: DEFAULT_BRAND, instanceId: randomBytes(16).toString("hex"), ownerPid: process.pid,
  actualIdentifier: DEFAULT_BRAND.identifier, appRoot: join(home, ".ultrawork"),
  configRoot: join(home, "config", "ultrawork"), dataRoot: join(home, "data", "ultrawork"),
  cacheRoot: join(home, "cache", "ultrawork"), stateRoot: join(home, "state", "ultrawork"),
  skillsRoot: join(home, "config", "ultrawork", "skills"), portsRegistryPath: join(home, ".ultrawork", "run", "ports.json"),
}
mkdirSync(join(brand.appRoot, "run"), { recursive: true })
mkdirSync(brand.configRoot, { recursive: true })
const contextFile = join(brand.appRoot, "run", "brand-context.json")
writeFileSync(contextFile, JSON.stringify(brand))
const acpFixtureFile = join(sandbox, "auth-failure-agent.ts")
const acpFixtureLedger = join(sandbox, "auth-failure-agent.jsonl")
// A dependency-free, real stdio JSON-RPC agent. It never emits assistant
// content: an output event would itself inhibit replay and hide the capability
// boundary this scenario is intended to exercise.
writeFileSync(acpFixtureFile, `import { appendFileSync } from "node:fs"
const ledger = ${JSON.stringify(acpFixtureLedger)}
const decoder = new TextDecoder()
let pending = ""
for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true })
  let newline
  while ((newline = pending.indexOf("\\n")) >= 0) {
    const line = pending.slice(0, newline); pending = pending.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    appendFileSync(ledger, JSON.stringify(request) + "\\n")
    if (request.id === undefined) continue
    let result = {}
    if (request.method === "initialize") result = { protocolVersion: request.params.protocolVersion, agentCapabilities: { loadSession: false }, authMethods: [] }
    if (request.method === "session/new") result = { sessionId: "fixture-acp-" + crypto.randomUUID() }
    if (request.method === "session/prompt") {
      await Bun.sleep(500)
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: "Missing API key (offline ACP fixture)" } }) + "\\n")
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n")
  }
}
`)
writeFileSync(join(brand.configRoot, "agents.json"), JSON.stringify({ agents: { "auth-fixture": {
  label: "ACP auth fixture", description: "Disposable local authentication failure", command: process.execPath,
  args: [acpFixtureFile], metaSystemPrompt: true,
} } }))
const env: Record<string, string> = {}
// Allowlist OS essentials; never inherit provider secrets, brand routing, config,
// proxies or a caller's HOME/XDG roots. Playwright gets the same isolated HOME.
for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ"])
  if (process.env[key]) env[key] = process.env[key]!
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
  OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(sandbox, "managed-empty"),
  OPENCODE_APP_NAME: "ultrawork", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_CHANNEL_DB: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
  ULTRAWORK_SIDECAR_USERNAME: "opencode", ULTRAWORK_SIDECAR_PASSWORD: password,
  ULTRAWORK_BRAND_MANAGED: "1", ULTRAWORK_BRAND_CONTEXT: JSON.stringify(brand), ULTRAWORK_BRAND_CONTEXT_FILE: contextFile,
  ULTRAWORK_APP_ROOT: brand.appRoot, ULTRAWORK_SKILLS_DIR: brand.skillsRoot,
})
const children: Array<{ name: string; child: ReturnType<typeof Bun.spawn>; log: string }> = []
function spawn(name: string, command: string[], extra: Record<string, string> = {}, cwd = workspace) {
  const item = { name, child: Bun.spawn(command, { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe", windowsHide: true }), log: "" }
  children.push(item)
  for (const pipe of [item.child.stdout, item.child.stderr]) void (async () => {
    const reader = (pipe as ReadableStream<Uint8Array>).getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        item.log = (item.log + new TextDecoder().decode(value)).slice(-100_000)
      }
    } finally { reader.releaseLock() }
  })()
  return item
}
async function poll(label: string, predicate: () => Promise<boolean>, timeout = 20_000) {
  const start = Date.now()
  let last: unknown
  while (Date.now() - start < timeout) {
    try { if (await predicate()) return } catch (error) { last = error }
    await Bun.sleep(100)
  }
  throw new Error(`${label} timed out after ${timeout}ms${last ? `: ${String(last)}` : ""}`)
}
// Reserve free ports; release only for the child about to bind. If another
// owner wins the race the test fails; it never kills or borrows that listener.
function reserve() { return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }) }
const ocReservation = reserve(), acpReservation = reserve(), viteReservation = reserve()
const ocPort = ocReservation.port!, acpPort = acpReservation.port!, vitePort = viteReservation.port!
const ocOrigin = `http://127.0.0.1:${ocPort}`, acpOrigin = `http://127.0.0.1:${acpPort}`, origin = `http://127.0.0.1:${vitePort}`
const models = ["big-pickle", "mimo-v2.6-flash-free", "deepseek-v4.1-flash-free"]
interface WireRequest { case: string; model: string; agent: boolean; body: any; at: number }
const wire: WireRequest[] = [], fixtureErrors: string[] = [], browserErrors: string[] = [], externalRequests: string[] = []
const acpHttp: Array<{ path: string; body: unknown; status: number; response: unknown }> = []
const acpEvents: Array<{ path: string; event: any }> = []
const providerReads: Array<{ case: string; path: string }> = []
const chunks = (model: string, content: string | null, finish: string | null) => ({ id: "fixture-chat", object: "chat.completion.chunk", created: 1_700_000_000, model,
  choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }] })
const llm = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  const path = new URL(request.url).pathname
  if (path.endsWith("/models")) return Response.json({ data: models.map((id) => ({ id, object: "model" })) })
  if (!path.endsWith("/chat/completions")) { fixtureErrors.push(`${request.method} ${path}`); return new Response("Unexpected model route", { status: 400 }) }
  const body = await request.json() as any
  const users = (body.messages ?? []).filter((message: any) => message.role === "user")
  const text = JSON.stringify(users.at(-1)?.content ?? "")
  const name = /FR_CASE:([a-z-]+)/.exec(text)?.[1] ?? "auxiliary"
  const agent = Array.isArray(body.tools) && body.tools.length > 0
  wire.push({ case: name, model: body.model, agent, body, at: Date.now() })
  if (agent) await Bun.sleep(350) // allow the Home→Session handoff to subscribe
  if (agent && name === "quota") return Response.json({ error: { type: "FreeUsageLimitError", message: "Free usage limit exceeded" } }, { status: 429, headers: { "retry-after": "86400" } })
  if (agent && ["fallback", "single-next", "attachments", "team-first", "team-next", "team-delegate", "delegated-member"].includes(name) && body.model === models[0])
    return Response.json({ error: { type: "model_not_found", message: "Model is not available" } }, { status: 400 })
  if (agent && name === "stop") {
    await Bun.sleep(2200)
    return Response.json({ error: { type: "model_not_found", message: "Model unavailable after user stop" } }, { status: 400 })
  }
  if (agent && name === "team-delegate") {
    const results = (body.messages ?? []).filter((message: any) => message.role === "tool")
    if (results.length) {
      const result = JSON.stringify(results.at(-1).content)
      if (!result.includes("completed") || !result.includes("ASSISTANT_ONLY_DELEGATED_MEMBER")) {
        fixtureErrors.push(`Real delegated member did not complete: ${result}`)
        return Response.json({ error: { message: "Real member result missing" } }, { status: 400 })
      }
    } else {
      assert(body.tools.some((tool: any) => tool.function.name === "orchestrator_delegate"), "Real delegate MCP must be exposed")
      const frames = [
        { choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_real_delegate", type: "function",
          function: { name: "orchestrator_delegate", arguments: JSON.stringify({ agentId: "opencode:default", task: "FR_CASE:delegated-member Return the deterministic member answer.", cwd: workspace,
            timeoutMs: 12000 }) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]
      return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }
  }
  const encoder = new TextEncoder()
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (frame: unknown) => { if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)) }
      try {
        send(chunks(body.model, agent ? `ASSISTANT_ONLY_${name.replaceAll("-", "_").toUpperCase()} ` : "Offline fixture title", null))
        if (agent && name === "output-error") {
          await Bun.sleep(700)
          send({ error: { type: "model_not_found", message: "Model unavailable after visible output" } })
        } else send(chunks(body.model, null, "stop"))
        if (!cancelled) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close() }
      } catch (error) { if (!cancelled) fixtureErrors.push(String(error)) }
    }, cancel() { cancelled = true },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
} })

// Real ACP keeps its production CORS allowlist. This transport forwards every
// /acp and /orchestration response (including live SSE) to that real sidecar,
// adding CORS solely for this test's dynamic Vite origin. Gateway/KB metadata is
// empty fixture data: those services are outside free-model chat acceptance.
const cors = { "access-control-allow-origin": origin, "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS" }
const bridge = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  const url = new URL(request.url)
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
  if (url.pathname.startsWith("/acp/") || url.pathname.startsWith("/orchestration/")) {
    const body = request.method !== "GET" ? await request.arrayBuffer() : undefined
    const response = await fetch(acpOrigin + url.pathname + url.search, { method: request.method, headers: { authorization: auth, "content-type": "application/json" },
      ...(body ? { body } : {}), signal: request.signal })
    if (url.pathname.startsWith("/acp/session/") && url.pathname.endsWith("/prompt"))
      acpHttp.push({ path: url.pathname, body: JSON.parse(new TextDecoder().decode(body)), status: response.status, response: await response.clone().json() })
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(cors)) headers.set(name, value)
    if (url.pathname.startsWith("/acp/") && url.pathname.endsWith("/events") && response.body) {
      const decoder = new TextDecoder()
      let pending = ""
      const transport = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
        controller.enqueue(chunk)
        pending += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = pending.indexOf("\n\n")) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          for (const line of frame.split("\n")) if (line.startsWith("data:")) {
            try { acpEvents.push({ path: url.pathname, event: JSON.parse(line.slice(5).trim()) }) } catch { /* Ignore an incomplete non-JSON transport frame. */ }
          }
        }
      } }))
      return new Response(transport, { status: response.status, headers })
    }
    return new Response(response.body, { status: response.status, headers })
  }
  if (url.pathname === "/channel/sessions") return Response.json({ sessions: [] }, { headers: cors })
  return Response.json([], { headers: cors })
} })

const catalog = Object.fromEntries(models.map((id) => [id, { id, name: id === "big-pickle" ? "Big Pickle" : id, release_date: "2026-01-01", attachment: true,
  reasoning: false, temperature: true, tool_call: true, cost: { input: 0, output: 0 }, limit: { context: 128000, output: 8192 },
  modalities: { input: ["text", "image"], output: ["text"] }, options: {} }]))
const modelsFile = join(sandbox, "models.json")
writeFileSync(modelsFile, JSON.stringify({ opencode: { id: "opencode", name: "OpenCode", env: [], npm: "@ai-sdk/openai-compatible", api: `http://127.0.0.1:${llm.port}/v1`, models: catalog } }))
env.OPENCODE_MODELS_PATH = modelsFile
env.OPENCODE_BASE_URL = ocOrigin
env.ACP_CLIENT_PORT = String(acpPort)
const mcp = { orchestrator: { type: "local", enabled: true, command: [acpBinary, "delegate-mcp", "--brand-context", contextFile], timeout: 15000 } }
// Fresh means no model, consent, auth or user provider; only an anonymous free
// Zen catalog points at this local fixture. The real enable flow writes defaults.
writeFileSync(join(brand.configRoot, "opencode.json"), JSON.stringify({ plugin: [], share: "disabled", autoupdate: false, permission: { "*": "allow" }, mcp,
  provider: { opencode: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${llm.port}/v1` }, whitelist: models } } }))
writeFileSync(brand.portsRegistryPath, JSON.stringify({ brandId: DEFAULT_BRAND.brandId, instanceId: brand.instanceId, acp: { port: acpPort } }))

async function api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
  const response = await fetch(ocOrigin + path, { method, headers: { authorization: auth, "content-type": "application/json", "x-opencode-directory": encodeURIComponent(workspace) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}
const checks: Array<{ name: string; elapsedMs: number; details: string[]; terminalDom: { assistantTurns: number; spinners: number } }> = []
const prompts: Array<{ case: string; url: string; body: any }> = []
const snapshots: Record<string, any[]> = {}
const delegationEvidence: Array<{ leaderSessionId: string; memberSessionId: string; delegateId: string; status: string; leaderModels: string[]; memberModels: string[] }> = []
let browser: Browser | undefined, activeCase = "startup"
let selectedFiles: string[] = []
const doc = join(sandbox, "evidence.docx"), note = join(sandbox, "attachment.txt")
writeFileSync(doc, "Disposable document fixture; testing path materialisation only.")
writeFileSync(note, "ATTACHMENT_CONTENT_ONLY_WIRE_7391")
async function openPage(consented = true): Promise<{ context: BrowserContext; page: Page }> {
  if (consented) await api("/global/config", { model: "opencode/big-pickle", small_model: "opencode/big-pickle" }, "PATCH")
  const context = await browser!.newContext({ locale: "en-US", viewport: { width: 1360, height: 960 } })
  await context.exposeBinding("__fixtureIPC", (_source, command: string, args: any) => {
    if (command === "plugin:dialog|open") return selectedFiles
    if (command === "file_size") return statSync(args.path).size
    if (command === "copy_attachment_into_workspace") {
      assert.equal(realpathSync(args.workspace), workspace)
      assert.equal(args.src, doc)
      const destination = join(workspace, ".ultrawork", "attachments", args.sessionId, basename(args.src))
      mkdirSync(resolve(destination, ".."), { recursive: true }); copyFileSync(args.src, destination)
      return destination
    }
    throw new Error(`Unexpected file IPC ${command}`)
  })
  await context.addInitScript(({ workspace, password, ports, brand, consented, mcp }) => {
    const w = window as any
    w.__freeModelUnknownIPC = []
    const readConsent = () => JSON.parse(localStorage.getItem("__e2e_consent") || "null")
    if (localStorage.getItem("__e2e_consent") === null)
      localStorage.setItem("__e2e_consent", JSON.stringify({ consented, ...(consented ? { seededModel: "opencode/big-pickle" } : {}) }))
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    const handlers: Record<string, (args: any) => unknown> = {
      get_startup_status: () => ({ state: "ready", brand }), get_boot_status: () => "ready",
      get_sidecar_ports: () => ports, get_sidecar_credentials: () => ({ username: "opencode", password }),
      ensure_default_workspace: () => workspace, check_directory_exists: () => true, login_shell_path: () => "",
      scan_workspace_changes: () => [], refresh_builtin_skills: () => ({ bundled: [], shadowed: [], changed: false }),
      check_cli_connectors: () => [], check_skill_dependencies: () => [], screenshot_capability: () => ({ available: false }),
      set_tray_labels: () => null, "plugin:event|listen": () => 1, "plugin:event|unlisten": () => null,
      "plugin:window|is_focused": () => true,
      get_free_trial_consent: readConsent,
      set_free_trial_consent: (args) => { localStorage.setItem("__e2e_consent", JSON.stringify({ consented: true, seededModel: args.seededModel, seededSmallModel: args.seededSmallModel })); return null },
      clear_free_trial_consent: () => { localStorage.setItem("__e2e_consent", JSON.stringify({ consented: false })); return null },
      read_mcp_config: () => mcp,
      "plugin:dialog|open": (args) => w.__fixtureIPC("plugin:dialog|open", args),
      file_size: (args) => w.__fixtureIPC("file_size", args),
      copy_attachment_into_workspace: (args) => w.__fixtureIPC("copy_attachment_into_workspace", args),
    }
    w.__TAURI_INTERNALS__ = { invoke: async (command: string, args: any) => {
      if (handlers[command]) return handlers[command](args)
      w.__freeModelUnknownIPC.push(command)
      throw new Error(`Unknown free-model IPC fixture: ${command}`)
    }, transformCallback: (callback: unknown) => callback, metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } } }
    localStorage.setItem("workspace_path", workspace)
    localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl: "auto", apiUsername: "opencode", apiPassword: password, language: "en", notifySystem: false, notifySound: false }))
  }, { workspace, password, ports: { opencode: ocPort, acp: bridge.port!, gateway: bridge.port!, knowledge: bridge.port! }, brand: DEFAULT_BRAND, consented, mcp })
  const page = await context.newPage()
  page.on("pageerror", (error) => browserErrors.push(`${activeCase}: ${error.message}`))
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (url.protocol.startsWith("http") && ![origin, `http://localhost:${bridge.port}`, `http://127.0.0.1:${bridge.port}`].includes(url.origin)) externalRequests.push(request.url())
    if (request.method() === "POST" && url.pathname.endsWith("/prompt_async")) prompts.push({ case: activeCase, url: url.pathname, body: request.postDataJSON() })
    if (request.method() === "GET" && url.pathname === "/provider") providerReads.push({ case: activeCase, path: url.pathname })
  })
  await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204 }))
  await page.goto(origin, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: en["home.headline"], exact: true }).waitFor({ timeout: 25000 })
  // Wait for model/consent and real ACP roster hydration, rather than racing
  // their mount effects with the first click.
  await poll("Team service ready", () => page.getByRole("button", { name: en["home.mode.team"], exact: true }).isEnabled())
  if (consented) {
    try { await page.locator("button:has(svg.lucide-cpu)").filter({ hasText: /Big Pickle|big-pickle/i }).waitFor({ timeout: 8000 }) }
    catch (error) {
      await page.screenshot({ path: join(output, `FAIL-${activeCase}-startup.png`) })
      writeFileSync(join(output, `FAIL-${activeCase}-startup.txt`), `${String(error)}\n${await page.locator("body").innerText()}\n${JSON.stringify(await api("/config"))}`)
      throw error
    }
  }
  return { context, page }
}
async function send(page: Page, name: string, first = true) {
  await page.locator("textarea").fill(`FR_CASE:${name} Please answer the fixture scenario.`)
  await page.getByRole("button", { name: en[first ? "home.startNow" : "aria.sendMessage"], exact: true }).click()
  if (first) await page.waitForURL(/\/session\//, { timeout: 20000 })
  return new URL(page.url()).pathname.split("/").at(-1)!
}
const agentRequests = (name: string) => wire.filter((request) => request.case === name && request.agent)
const promptRequests = (name: string) => prompts.filter((request) => request.case === name)
async function idle(page: Page, id: string, timeout = 12000) {
  await poll("Real OpenCode idle", async () => !(await api("/session/status"))[id], timeout)
  await poll("Composer idle", async () => await page.getByRole("button", { name: en["message.stopExecution"], exact: true }).count() === 0, timeout)
  snapshots[activeCase] = await api(`/session/${id}/message`)
}
async function assistant(page: Page, id: string, name: string) {
  const marker = `ASSISTANT_ONLY_${name.replaceAll("-", "_").toUpperCase()}`
  await page.getByText(marker, { exact: false }).waitFor({ timeout: 20000 })
  await poll("Persisted assistant marker", async () => (await api(`/session/${id}/message`)).some((message: any) => message.info.role === "assistant" &&
    message.parts.some((part: any) => part.type === "text" && part.text.includes(marker))))
  assert(!promptRequests(name).some((request) => JSON.stringify(request.body).includes(marker)), "A user echo cannot satisfy assistant success")
}
async function settledAssistantTurns(page: Page) {
  const turns = page.getByTestId("assistant-turn")
  // Composer/server idle precedes useStableStreaming's visual settle. Wait on
  // the actual terminal DOM so screenshots cannot hide a permanently spinning
  // execution flow behind a successful network-level assertion.
  await poll("Assistant turns have no terminal spinner", async () => await turns.locator(".animate-spin").count() === 0, 8000)
  const terminalDom = { assistantTurns: await turns.count(), spinners: await turns.locator(".animate-spin").count() }
  // ACP errors before any content produce session.error + HTTP rejection, with
  // no assistant message in the sidecar store. The ACP scenario separately
  // asserts that real event/HTTP boundary and the idle composer.
  if (new URL(page.url()).pathname.startsWith("/session/") && activeCase !== "acp-auth") assert(terminalDom.assistantTurns > 0, "A session terminal DOM check must contain real assistant turns")
  assert.equal(terminalDom.spinners, 0)
  return terminalDom
}
async function run(name: string, execute: (page: Page) => Promise<string[]>, consented = true) {
  if (selectedCases.length && !selectedCases.includes(name)) return
  activeCase = name
  const start = Date.now()
  const { context, page } = await openPage(consented)
  try {
    const details = await execute(page)
    assert.deepEqual(await page.evaluate(() => (window as any).__freeModelUnknownIPC), [], "Unknown native IPC")
    const terminalDom = await settledAssistantTurns(page)
    await page.screenshot({ path: join(output, `${name}.png`) })
    checks.push({ name, elapsedMs: Date.now() - start, details, terminalDom })
    console.log(`PASS ${engine}/${name}: ${details.join("; ")}`)
  } catch (error) {
    await page.screenshot({ path: join(output, `FAIL-${name}.png`) }).catch(() => {})
    writeFileSync(join(output, `FAIL-${name}.txt`), `${String(error)}\n${await page.locator("body").innerText()}\n`)
    throw error
  } finally { await context.close() }
}

let failure: string | undefined
try {
  ocReservation.stop(true)
  const oc = spawn("opencode", [opencodeBinary, "serve", "--port", String(ocPort), "--hostname", "127.0.0.1"])
  await poll("OpenCode health", async () => { assert.equal(oc.child.exitCode, null, oc.log); return (await api("/global/health")).healthy }, 35000)
  acpReservation.stop(true)
  const acp = spawn("acp", [acpBinary, "--brand-context", contextFile])
  await poll("ACP health", async () => { assert.equal(acp.child.exitCode, null, acp.log); return (await fetch(acpOrigin + "/acp/health", { headers: { authorization: auth } })).ok }, 25000)
  const providers = await api("/provider")
  assert.deepEqual(providers.connected, ["opencode"], "Only isolated anonymous Zen provider may connect")
  assert.equal((await api("/config")).model, undefined, "Fresh config unexpectedly has a model")
  viteReservation.stop(true)
  const vite = spawn("vite", [process.execPath, "run", "--bun", join(desktop, "node_modules", "vite", "bin", "vite.js"), "--host", "127.0.0.1", "--port", String(vitePort)],
    { E2E_OPENCODE_PORT: String(ocPort), E2E_GATEWAY_PORT: String(bridge.port), E2E_KNOWLEDGE_PORT: String(bridge.port), ULTRAWORK_BRAND_JSON: JSON.stringify(DEFAULT_BRAND) }, desktop)
  await poll("Vite", async () => { assert.equal(vite.child.exitCode, null, vite.log); return (await fetch(origin)).ok }, 25000)
  if (engine === "webkit") browser = await webkit.launch({ headless: true, env })
  else {
    const candidates = [process.env.CHROME_PATH,
      ...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"] : []),
      ...(process.platform === "win32" ? [join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"), join(process.env.LOCALAPPDATA ?? home, "Google", "Chrome", "Application", "chrome.exe")] : []),
      ...(process.platform === "linux" ? ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"] : []), chromium.executablePath(),
    ].filter((file): file is string => !!file && existsSync(file))
    assert(candidates.length, "Install Chrome or set CHROME_PATH")
    browser = await chromium.launch({ executablePath: candidates[0], headless: true, env })
  }
  console.log(`Browser ${engine}: ${browser.version()}; native sidecars ${nativeTarget()}`)
  await run("quota", async (page) => {
    await page.locator("textarea").fill("FR_CASE:quota Please answer the fixture scenario.")
    await page.getByRole("button", { name: en["home.startNow"], exact: true }).click()
    await page.getByRole("button", { name: en["freeTrial.enable"], exact: true }).waitFor()
    assert.equal(agentRequests("quota").length, 0, "A model was called before consent")
    await page.getByRole("button", { name: en["freeTrial.enable"], exact: true }).click()
    await page.waitForURL(/\/session\//)
    const id = new URL(page.url()).pathname.split("/").at(-1)!
    await page.getByText(en["freeTrial.quotaExceeded"], { exact: false }).first().waitFor({ timeout: 12000 })
    await idle(page, id)
    await Bun.sleep(1300)
    assert.equal(agentRequests("quota").length, 1, "FreeUsageLimitError retried or changed model")
    assert.equal(agentRequests("quota")[0]!.model, models[0])
    assert.equal(promptRequests("quota").length, 1)
    const stored = await api(`/session/${id}/message`)
    assert(stored.some((message: any) => message.info.role === "assistant" && JSON.stringify(message.info.error).includes("FreeUsageLimitError")))
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByText(en["freeTrial.quotaExceeded"], { exact: false }).first().waitFor({ timeout: 12000 })
    await idle(page, id)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("__e2e_consent")!).consented), true)
    await settledAssistantTurns(page)
    await page.screenshot({ path: join(output, "quota-persisted-error.png") })
    await page.getByRole("button", { name: en["freeTrial.configureModels"], exact: true }).first().click()
    await page.waitForURL(/\/settings/)
    return ["fresh consent precedes real request", "one Big Pickle 429 becomes idle promptly", "durable error card and Settings → Models action"]
  }, false)
  await run("fallback", async (page) => {
    const id = await send(page, "fallback")
    await assistant(page, id, "fallback"); await idle(page, id)
    assert.deepEqual(agentRequests("fallback").map((request) => request.model), models.slice(0, 2))
    assert.equal(promptRequests("fallback").length, 2)
    for (const request of promptRequests("fallback")) assert.equal(request.body.tools["orchestrator_*"], false)
    activeCase = "single-next"
    await send(page, "single-next", false)
    await assistant(page, id, "single-next"); await idle(page, id)
    assert.deepEqual(agentRequests("single-next").map((request) => request.model), models.slice(0, 2))
    assert.equal(promptRequests("single-next").length, 2)
    for (const request of promptRequests("single-next")) assert.equal(request.body.tools["orchestrator_*"], false)
    for (const name of ["fallback", "single-next"]) for (const request of agentRequests(name)) {
      const tools = request.body.tools.map((tool: any) => tool.function.name)
      assert(!tools.some((tool: string) => tool.startsWith("orchestrator_")), "Single-agent wire leaked delegate tools")
      assert(JSON.stringify(request.body.messages.filter((message: any) => message.role === "system")).includes("<identity>"), "Single-agent wire lost product system prompt")
    }
    return ["first and continuation 400 switch once each", "successful candidate emits persisted assistant body", "single-agent governance preserved on initial and continued turns"]
  })
  await run("attachments", async (page) => {
    selectedFiles = [note, doc]
    await page.getByRole("button", { name: en["aria.attachment"], exact: true }).click()
    await page.getByText("evidence.docx", { exact: true }).waitFor()
    const id = await send(page, "attachments")
    await assistant(page, id, "attachments"); await idle(page, id)
    const sent = promptRequests("attachments")
    assert.equal(sent.length, 2)
    assert.deepEqual(sent[1]!.body.parts, sent[0]!.body.parts, "Retry changed materialised text/file parts")
    assert(sent[0]!.body.parts.some((part: any) => part.type === "file" && part.filename === "attachment.txt"))
    assert(JSON.stringify(sent[0]!.body.parts).includes("evidence.docx"))
    for (const request of agentRequests("attachments")) {
      const content = JSON.stringify(request.body.messages)
      assert(content.includes("ATTACHMENT_CONTENT_ONLY_WIRE_7391"), "Actual LLM request lost text attachment content")
      assert(content.includes("evidence.docx") && content.includes(en["attachment.documentNote"]), "Actual LLM request lost document note")
    }
    return ["native picker/file-copy shim uses disposable real files", "text file and copied-document note survive fallback verbatim", "both actual LLM requests retain attachment content"]
  })
  await run("stop", async (page) => {
    const id = await send(page, "stop")
    await poll("Stop request reached LLM", async () => agentRequests("stop").length === 1)
    await page.getByRole("button", { name: en["message.stopExecution"], exact: true }).first().click()
    await idle(page, id)
    await Bun.sleep(2800)
    assert.equal(promptRequests("stop").length, 1, "Stopping replayed the prompt")
    assert.equal(agentRequests("stop").length, 1, "Stopping switched/retried the model")
    return ["real in-flight turn stopped from composer", "delayed model-unavailable response cannot resend"]
  })
  await run("output-error", async (page) => {
    const id = await send(page, "output-error")
    await assistant(page, id, "output-error"); await idle(page, id)
    await Bun.sleep(1200)
    const stored = await api(`/session/${id}/message`)
    assert(stored.some((message: any) => message.info.role === "assistant" && JSON.stringify(message.info.error).includes("Model unavailable after visible output")), "Fixture failed to deliver a model-unavailable error after output")
    assert.equal(promptRequests("output-error").length, 1, "Visible output was replayed")
    assert.equal(agentRequests("output-error").length, 1)
    return ["actual model stream emits text then an error", "visible persisted assistant output prevents replay"]
  })
  await run("team-first", async (page) => {
    await page.getByRole("button", { name: en["home.mode.team"], exact: true }).click()
    const id = await send(page, "team-first")
    await assistant(page, id, "team-first"); await idle(page, id)
    activeCase = "team-next"
    await send(page, "team-next", false)
    await assistant(page, id, "team-next"); await idle(page, id)
    const registered = await (await fetch(`${acpOrigin}/orchestration/team/sessions?workspace=${encodeURIComponent(workspace)}`, { headers: { authorization: auth } })).json() as any
    assert(registered.sessions.some((entry: any) => entry.id === id && entry.leaderAgentId === "opencode:default"))
    for (const name of ["team-first", "team-next"]) {
      const requests = promptRequests(name)
      assert.equal(requests.length, 2, `${name} should dispatch once plus one fallback`)
      assert.equal(requests[0]!.body.system, requests[1]!.body.system, "Leader system changed on retry")
      assert.match(requests[0]!.body.system, /Team.*Leader/)
      assert.deepEqual(requests[0]!.body.tools, requests[1]!.body.tools)
      assert.equal(requests[0]!.body.tools.task, false)
      assert(!Object.hasOwn(requests[0]!.body.tools, "orchestrator_*"), "Leader lost orchestration tools")
      assert.deepEqual(agentRequests(name).map((request) => request.model), models.slice(0, 2))
      for (const request of agentRequests(name)) {
        assert(JSON.stringify(request.body.messages.filter((message: any) => message.role === "system")).includes("Team 的 Leader"))
        const tools = request.body.tools.map((tool: any) => tool.function.name)
        assert(tools.includes("orchestrator_delegate"), "Real MCP delegate absent from Leader LLM tools")
        assert(!tools.includes("task"), "Built-in task leaked into Leader tools")
      }
    }
    return ["real ACP registry creates Team root", "first and continuation turns each retry full Leader prompt", "real delegate MCP preserved and task denied in actual LLM requests"]
  })
  await run("team-delegate", async (page) => {
    await page.getByRole("button", { name: en["home.mode.team"], exact: true }).click()
    const id = await send(page, "team-delegate")
    let record: any
    await poll("Real delegated member terminates", async () => {
      const records = await (await fetch(`${acpOrigin}/orchestration/delegates`, { headers: { authorization: auth } })).json() as any
      record = records.delegates.find((entry: any) => entry.task.includes("FR_CASE:delegated-member"))
      return !!record && record.status !== "running"
    }, 25000)
    assert(record, "Real ACP delegate record missing")
    assert.equal(record.agentId, "opencode:default")
    assert(record.sessionId && record.sessionId !== id, "Member must execute in a separate real session")
    const member = await api(`/session/${record.sessionId}/message`)
    snapshots["delegated-member"] = member
    delegationEvidence.push({ leaderSessionId: id, memberSessionId: record.sessionId, delegateId: record.id, status: record.status,
      leaderModels: agentRequests("team-delegate").map((request) => request.model), memberModels: agentRequests("delegated-member").map((request) => request.model) })
    assert.equal(record.status, "completed", `Delegate failed after Leader fallback; member models: ${delegationEvidence.at(-1)!.memberModels.join(", ")}; error: ${record.error}`)
    await assistant(page, id, "team-delegate"); await idle(page, id)
    // Include the final answer step, which can start just after the member's
    // terminal record becomes observable to the polling loop above.
    delegationEvidence.at(-1)!.leaderModels = agentRequests("team-delegate").map((request) => request.model)
    assert(member.some((message: any) => message.info.role === "assistant" && message.parts.some((part: any) => part.type === "text" && part.text.includes("ASSISTANT_ONLY_DELEGATED_MEMBER"))))
    const leader = await api(`/session/${id}/message`)
    assert(leader.some((message: any) => message.parts.some((part: any) => part.type === "tool" && part.tool === "orchestrator_delegate" &&
      part.state.status === "completed" && JSON.stringify(part.state.output).includes(record.sessionId) && JSON.stringify(part.state.output).includes("ASSISTANT_ONLY_DELEGATED_MEMBER"))),
    "Leader did not persist the actual member's deliverable tool result")
    assert.equal(promptRequests("team-delegate").length, 2, "Leader should dispatch once plus one fallback")
    assert.equal(agentRequests("team-delegate").length, 3, "Leader should fail once, then execute a tool step and an answer step")
    assert.deepEqual(agentRequests("team-delegate").map((request) => request.model), [models[0], models[1], models[1]])
    assert.equal(agentRequests("delegated-member").length, 1)
    assert.equal(agentRequests("delegated-member")[0]!.model, models[1], "Member must inherit the Leader's successful fallback model")
    const returned = agentRequests("team-delegate")[2]!.body.messages.filter((message: any) => message.role === "tool")
    assert(JSON.stringify(returned).includes("ASSISTANT_ONLY_DELEGATED_MEMBER"), "Member deliverable never reached the actual Leader LLM")
    for (const request of agentRequests("delegated-member")) assert(!request.body.tools.some((tool: any) => tool.function.name.startsWith("orchestrator_")), "Member gained recursive delegate tools")
    return ["Leader falls back then calls real delegate MCP", "separate OpenCode member inherits the successful model", "member deliverable returns through persisted tool result to Leader final answer"]
  })
  await run("acp-auth", async (page) => {
    const zenBefore = wire.length, providerReadsBefore = providerReads.length
    await page.getByRole("button", { name: "OpenCode", exact: true }).first().click()
    await page.getByRole("button", { name: /^ACP auth fixture/ }).click()
    assert.equal(await page.locator("button:has(svg.lucide-cpu)").count(), 0, "ACP agent must not offer the global Zen model selector")
    const id = await send(page, "acp-auth")
    await poll("Real ACP authentication failure", async () => acpHttp.some((request) => request.path === `/acp/session/${id}/prompt` && request.status === 502))
    await poll("Real ACP session.error received", async () => acpEvents.some(({ event }) => event.type === "session.error" && event.properties.sessionID === id &&
      JSON.stringify(event.properties.error).includes("Missing API key")))
    await poll("Real ACP idle received", async () => acpEvents.some(({ event }) => event.type === "session.status" && event.properties.sessionID === id && event.properties.status.type === "idle"))
    await poll("ACP composer idle", async () => await page.getByRole("button", { name: en["message.stopExecution"], exact: true }).count() === 0)
    await page.getByText(en["error.sendMessage"], { exact: true }).first().waitFor()
    await settledAssistantTurns(page)
    // Observe past the error and idle processing; the old bug could select a
    // candidate asynchronously and dispatch it after the ACP RPC had rejected.
    await Bun.sleep(1000)
    const rpc = readFileSync(acpFixtureLedger, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    assert.equal(rpc.filter((request) => request.method === "initialize").length, 1)
    assert.equal(rpc.filter((request) => request.method === "session/new").length, 1)
    assert.equal(rpc.filter((request) => request.method === "session/prompt").length, 1, "ACP auth failure replayed the real CLI prompt")
    const transport = acpHttp.filter((request) => request.path === `/acp/session/${id}/prompt`)
    assert.equal(transport.length, 1)
    assert(JSON.stringify(transport[0]!.response).includes("Missing API key"))
    assert.equal(wire.length, zenBefore, "ACP authentication failure reached a Zen model")
    assert.equal(promptRequests("acp-auth").length, 0, "ACP authentication failure dispatched an OpenCode prompt")
    assert.equal(providerReads.length, providerReadsBefore, "ACP authentication failure looked up Zen fallback candidates")
    const response = await fetch(`${acpOrigin}/acp/session/${id}/messages`, { headers: { authorization: auth } })
    snapshots["acp-auth"] = (await response.json() as { messages: any[] }).messages
    assert(!snapshots["acp-auth"].some((message) => message.info.role === "assistant" && message.parts.some((part: any) =>
      part.type === "tool" || (typeof part.text === "string" && part.text.trim()))), "Fixture unexpectedly emitted output, weakening the no-output capability boundary")
    return ["UI selects a real local stdio ACP agent", "one initialize/new/prompt ends in Missing API key over real SSE and HTTP 502", "zero Zen requests or candidate lookups; idle composer without replay"]
  })
  assert.deepEqual(fixtureErrors, [])
  assert.deepEqual(browserErrors, [])
  assert.deepEqual(externalRequests, [])
} catch (error) { failure = String(error); console.error(error) }
finally {
  const report = { engine, browser: browser?.version(), platform: process.platform, target: nativeTarget(), generatedAt: new Date().toISOString(),
    result: failure ? "failed" : "passed", failure, selectedCases: selectedCases.length ? selectedCases : scenarioNames,
    checks, prompts, wire, snapshots, delegationEvidence, acpHttp, acpEvents, providerReads,
    acpFixtureRpc: existsSync(acpFixtureLedger) ? readFileSync(acpFixtureLedger, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [],
    fixtureErrors, browserErrors, externalRequests,
    binaries: binaryEvidence,
    limits: ["Real Vite/React, browser, OpenCode binary, ACP registry and delegate MCP; deterministic local LLM HTTP responses",
      "Native startup/consent/picker IPC shim; file size/copy use actual isolated filesystem; no native Tauri WebView or installer",
      "Team Leader and a real delegated OpenCode member run against the deterministic local model fixture; no external agent CLI/model account exercised",
      "ACP auth fixture speaks real stdio JSON-RPC and returns an error before output; actual session.error, HTTP 502 and stored messages are recorded",
      "Dynamic-origin CORS transport forwards real ACP HTTP/SSE; Gateway and KB metadata are empty fixtures"] }
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
  await browser?.close().catch(() => {})
  bridge.stop(true); llm.stop(true)
  for (const reservation of [ocReservation, acpReservation, viteReservation]) reservation.stop(true)
  for (const item of children.reverse()) {
    item.child.kill()
    if (!await Promise.race([item.child.exited.then(() => true), Bun.sleep(2500).then(() => false)])) { item.child.kill("SIGKILL"); await item.child.exited }
    writeFileSync(join(output, `${item.name}.log`), item.log)
  }
  rmSync(sandbox, { recursive: true, force: true })
  console.log(`${failure ? "FAIL" : "PASS"} ${checks.length} real-browser free-model flows; artifacts: ${output}`)
}
if (failure) process.exitCode = 1
