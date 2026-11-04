#!/usr/bin/env bun
/**
 * Real macOS .app supervisor for manual/CUA GUI acceptance. Native Tauri IPC,
 * WebView, host and all packaged sidecars remain real; only the LLM is local.
 *
 * bun run --bun scripts/verify-free-zen-native-macos.ts --app <FreeZenCheck.app>
 * GUI prompts: NATIVE_FREE_QUOTA / NATIVE_FREE_FALLBACK / NATIVE_FREE_TEAM.
 * stdin: status, check quota, check fallback, check team, restart, finish, quit.
 * Local control endpoints and the live status path are printed at startup.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { createInterface } from "node:readline"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

assert.equal(process.platform, "darwin", "This supervisor requires a real macOS GUI session")
const options: Record<string, string> = {}
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  assert(["--app", "--namespace", "--output"].includes(args[i]), "Unknown option: " + args[i])
  assert(!options[args[i]] && args[i + 1] && !args[i + 1].startsWith("--"), "Missing or repeated " + args[i])
  options[args[i]] = args[++i]
}
assert(options["--app"], "Pass --app with a freshly built isolated test .app")
const app = realpathSync(path.resolve(options["--app"]))
const plistResult = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" })
assert.equal(plistResult.status, 0, plistResult.stderr)
const plist = JSON.parse(plistResult.stdout)
const namespace = options["--namespace"] ?? String(plist.CFBundleIdentifier).replace(/\.dev$/, "").split(".").at(-1)
assert(/^[a-z][a-z0-9-]{1,31}$/.test(namespace), "Cannot derive the runtime namespace; pass --namespace")
// This guard prevents using the customer's real installed app identity/storage.
assert(!["ultrawork", "mywork", "desktop"].includes(namespace), "Build a dedicated test brand (for example freezen-check)")
const executable = realpathSync(path.join(app, "Contents", "MacOS", plist.CFBundleExecutable))
const output = path.resolve(options["--output"] ?? path.join(import.meta.dir, "..", ".brand-build", "verification", "free-model-native-macos"))
mkdirSync(output, { recursive: true })
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-free-native-")))
const home = path.join(root, "客户 Home"), temporary = path.join(root, "临时 目录")
const appRoot = path.join(home, "." + namespace), configRoot = path.join(home, ".config", namespace)
const workspace = path.join(appRoot, "workspace")
// Namespace roots must be born through the real Rust first-start path: even a
// fixture config in an unmarked namespace correctly triggers the identity guard.
for (const directory of [home, temporary]) mkdirSync(directory, { recursive: true })
const registryFile = path.join(appRoot, "run", "ports.json")
const consentFile = path.join(configRoot, "free-trial-consent.json")
const statusFile = path.join(output, "status.json")
const controlToken = randomBytes(24).toString("hex")
const models = ["big-pickle", "mimo-v2.6-flash-free", "deepseek-v4.1-flash-free"]
type Case = "quota" | "fallback" | "team" | "member" | "auxiliary"
type Wire = { case: Case; model: string; agent: boolean; at: number; body: any }
const wire: Wire[] = [], fixtureErrors: string[] = [], checks: string[] = []
const events: any[] = []
let delegationEvidence: { capturedAt: string; record: any; ownerSessionId: string; memberSessionId: string; teamSession: any } | undefined
let restarts = 0
let child: ChildProcess | undefined, exited = false, hostLog = "", ready = false
let done = Promise.resolve(), stream = Promise.resolve(), failure: string | undefined, restarting = false
let action: "finish" | "quit" | undefined
let wake!: () => void
const completion = new Promise<void>((resolve) => { wake = resolve })
let eventController = new AbortController()
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"))
const registry = () => readJson(registryFile)
const authorization = () => {
  const value = readJson(path.join(configRoot, "sidecar-auth.json"))
  assert(typeof value.password === "string" && value.password.length >= 32, "Real Rust credentials were not persisted")
  return "Basic " + Buffer.from((value.username ?? "opencode") + ":" + value.password).toString("base64")
}
function selectCase(body: any): Case {
  const text = JSON.stringify((body.messages ?? []).filter((message: any) => message.role === "user").at(-1)?.content ?? "")
  if (text.includes("NATIVE_FREE_TEAM_MEMBER")) return "member"
  if (text.includes("NATIVE_FREE_TEAM")) return "team"
  if (text.includes("NATIVE_FREE_FALLBACK")) return "fallback"
  if (text.includes("NATIVE_FREE_QUOTA")) return "quota"
  return "auxiliary"
}
const frame = (model: string, content: string | null, finish: string | null) => ({
  id: "native-fixture", object: "chat.completion.chunk", created: 1_700_000_000, model,
  choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }],
})
function sse(frames: unknown[]) {
  return new Response(frames.map((value) => "data: " + JSON.stringify(value) + "\n\n").join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}
const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  try {
    const route = new URL(request.url).pathname
    if (route.endsWith("/models")) return Response.json({ data: models.map((id) => ({ id, object: "model" })) })
    assert(route.endsWith("/chat/completions"), "Unexpected local LLM route: " + route)
    const body = await request.json() as any, name = selectCase(body)
    const agent = Array.isArray(body.tools) && body.tools.length > 0
    wire.push({ case: name, model: body.model, agent, at: Date.now(), body })
    writeStatus()
    if (agent) await Bun.sleep(500)
    if (agent && name === "quota") return Response.json({ error: { type: "FreeUsageLimitError", message: "Native fixture free access restricted" } },
      { status: 429, headers: { "retry-after": "86400" } })
    if (agent && ["fallback", "team", "member"].includes(name) && body.model === models[0])
      return Response.json({ error: { type: "model_not_found", message: "Model is not available" } }, { status: 400 })
    if (agent && name === "team") {
      const results = (body.messages ?? []).filter((message: any) => message.role === "tool")
      if (!results.length) {
        assert(body.tools.some((tool: any) => tool.function.name === "orchestrator_delegate"), "Real native delegate MCP is not exposed")
        return sse([
          { choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{
            index: 0, id: "call_native_real_delegate", type: "function", function: { name: "orchestrator_delegate",
              arguments: JSON.stringify({ agentId: "opencode:default", task: "NATIVE_FREE_TEAM_MEMBER Return the deterministic member answer.",
                cwd: workspace, timeoutMs: 20000 }) },
          }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ])
      }
      const result = JSON.stringify(results.at(-1).content)
      assert(result.includes("completed") && result.includes("NATIVE_FREE_MEMBER_OK"), "Native member did not complete: " + result)
    }
    const text = !agent ? "Native fixture title" : name === "member" ? "NATIVE_FREE_MEMBER_OK" :
      name === "team" ? "NATIVE_FREE_TEAM_OK" : name === "fallback" ? "NATIVE_FREE_FALLBACK_OK" : "NATIVE_FREE_OTHER_OK"
    return sse([frame(body.model, text, null), frame(body.model, null, "stop")])
  } catch (error) {
    fixtureErrors.push(String(error)); writeStatus()
    return Response.json({ error: { type: "server_error", message: String(error) } }, { status: 400 })
  }
} })
const catalog = Object.fromEntries(models.map((id) => [id, {
  id, name: id === "big-pickle" ? "Big Pickle" : id, release_date: "2026-01-01", attachment: true,
  reasoning: false, temperature: true, tool_call: true, cost: { input: 0, output: 0 },
  limit: { context: 128000, output: 8192 }, modalities: { input: ["text", "image"], output: ["text"] }, options: {},
}]))
const modelsFile = path.join(root, "models.json")
writeFileSync(modelsFile, JSON.stringify({ opencode: { id: "opencode", name: "OpenCode", env: [],
  npm: "@ai-sdk/openai-compatible", api: "http://127.0.0.1:" + fixture.port + "/v1", models: catalog } }))
const initialConfig = { plugin: [], share: "disabled", autoupdate: false, permission: { "*": "allow" },
  provider: { opencode: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:" + fixture.port + "/v1" }, whitelist: models } } }
const env: NodeJS.ProcessEnv = {}
for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "LOGNAME", "USER", "SHELL"]) if (process.env[key]) env[key] = process.env[key]
Object.assign(env, {
  LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
  TMPDIR: temporary, TMP: temporary, TEMP: temporary, OPENCODE_TEST_HOME: home,
  OPENCODE_MODELS_PATH: modelsFile, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(initialConfig),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
})
async function api(role: "opencode" | "acp" | "gateway" | "knowledge", route: string): Promise<any> {
  const port = registry()[role]?.port
  assert(Number.isInteger(port), role + " native port not ready")
  const response = await fetch("http://127.0.0.1:" + port + route, {
    headers: { authorization: authorization(), "x-opencode-directory": encodeURIComponent(workspace) }, signal: AbortSignal.timeout(15000),
  })
  const text = await response.text()
  assert(response.ok, role + " " + route + ": " + response.status + " " + text.slice(0, 600))
  return text ? JSON.parse(text) : null
}
function writeStatus(): Record<string, unknown> {
  const value = {
    namespace, app, executable, pid: child?.pid, root, home, workspace, ready, exited, action, failure,
    ports: existsSync(registryFile) ? registry() : undefined,
    fixtureOrigin: "http://127.0.0.1:" + fixture.port,
    controlOrigin: typeof control === "undefined" ? undefined : "http://127.0.0.1:" + control.port,
    controlToken, checks, fixtureErrors, restarts,
    delegatedSessions: delegationEvidence ? { ownerSessionId: delegationEvidence.ownerSessionId, memberSessionId: delegationEvidence.memberSessionId } : undefined,
    wire: wire.map(({ body: _body, ...request }) => request),
    consented: existsSync(consentFile) ? readJson(consentFile).consented : false,
  }
  writeFileSync(statusFile, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  return value
}
function publicStatus(): Record<string, unknown> {
  const { controlToken: _token, ...value } = writeStatus()
  return value
}
async function history() {
  const all = await api("opencode", "/session")
  const ids = new Set<string>((Array.isArray(all) ? all : []).map((value: any) => value.id))
  for (const event of events) {
    const p = event.properties ?? {}
    const id = p.sessionID ?? p.info?.sessionID ?? p.part?.sessionID
    if (id) ids.add(id)
  }
  const records: Record<string, any[]> = {}
  for (const id of ids) records[id] = await api("opencode", "/session/" + id + "/message")
  return records
}
const agentRequests = (name: Case) => wire.filter((request) => request.agent && request.case === name)
async function verify(name: string) {
  assert(ready && !exited, "Native host is not ready")
  assert.equal(fixtureErrors.length, 0, fixtureErrors.join("\n"))
  assert(existsSync(consentFile), "Real native consent IPC did not persist consent")
  const consent = readJson(consentFile)
  assert.equal(consent.consented, true)
  assert.equal(consent.seededModel, "opencode/" + models[0])
  const config = await api("opencode", "/global/config")
  assert.equal(config.model, "opencode/" + models[0], "Per-turn fallback changed the native global default")
  const records = await history()
  const textOf = (messages: any[]) => messages.map((message) => JSON.stringify(message.parts ?? [])).join("\n")
  if (name === "quota") {
    assert.equal(agentRequests("quota").length, 1, "Free limit must not retry or rotate")
    assert.equal(agentRequests("quota")[0]?.model, models[0])
    assert(Object.values(records).some((messages) => textOf(messages).includes("NATIVE_FREE_QUOTA") &&
      messages.some((message) => JSON.stringify(message.info.error ?? null).includes("FreeUsageLimitError"))), "Quota terminal error is not persisted")
  } else if (name === "fallback") {
    const actual = agentRequests("fallback").map((request) => request.model)
    assert(actual.length >= 2 && actual.length % 2 === 0, "Each native fallback turn needs two calls")
    assert.deepEqual(actual, Array.from({ length: actual.length / 2 }, () => models.slice(0, 2)).flat())
    assert(Object.values(records).some((messages) => textOf(messages).includes("NATIVE_FREE_FALLBACK_OK")), "Fallback assistant response not persisted")
  } else if (name === "team") {
    assert.deepEqual(agentRequests("team").map((request) => request.model), [models[0], models[1], models[1]])
    assert.deepEqual(agentRequests("member").map((request) => request.model), [models[1]], "Member must inherit the native Leader fallback")
    const { delegates } = await api("acp", "/orchestration/delegates")
    const live = delegates.find((value: any) => value.task.includes("NATIVE_FREE_TEAM_MEMBER"))
    // Delegate records are intentionally process-local. Retain the evidence
    // captured before restart, then verify its real persistent sessions and
    // Team registry rather than inventing a delegate-recovery requirement.
    const record = live ?? delegationEvidence?.record
    assert.equal(record?.status, "completed", "Real native member delegation did not complete")
    assert(record.ownerSessionId && record.sessionId !== record.ownerSessionId)
    const member = records[record.sessionId] ?? await api("opencode", "/session/" + record.sessionId + "/message")
    assert(textOf(member).includes("NATIVE_FREE_MEMBER_OK"), "Native member result not persisted")
    const leader = records[record.ownerSessionId] ?? await api("opencode", "/session/" + record.ownerSessionId + "/message")
    assert(textOf(leader).includes("NATIVE_FREE_TEAM_OK"), "Native Leader summary not persisted")
    assert(leader.some((message) => message.parts.some((part: any) => part.type === "tool" &&
      part.tool === "orchestrator_delegate" && part.state.status === "completed" &&
      JSON.stringify(part.state.output).includes(record.sessionId) && JSON.stringify(part.state.output).includes("NATIVE_FREE_MEMBER_OK"))),
    "Native Leader did not persist the real member tool result")
    const { sessions } = await api("acp", "/orchestration/team/sessions?workspace=" + encodeURIComponent(workspace))
    const teamSession = sessions.find((session: any) => session.id === record.ownerSessionId)
    assert(teamSession && teamSession.workspace === workspace, "Persistent native Team registry entry is missing")
    assert(teamSession.members.includes("opencode:default"), "Persistent native Team lost its member roster")
    if (live) delegationEvidence = {
      capturedAt: new Date().toISOString(), record: structuredClone(live),
      ownerSessionId: record.ownerSessionId, memberSessionId: record.sessionId, teamSession,
    }
    if (restarts > 0) {
      const recovered = "After native restart, persisted Team registry and real Leader/member history remain intact"
      if (!checks.includes(recovered)) checks.push(recovered)
    }
  } else throw new Error("Unknown case: " + name)
  const message = name + ": native IPC consent, real model wire and persistent history passed"
  if (!checks.includes(message)) checks.push(message)
  writeFileSync(path.join(output, "history.json"), JSON.stringify(records, null, 2) + "\n")
  writeStatus()
  return message
}
async function command(input: string): Promise<unknown> {
  const [name, selected] = input.trim().split(/\s+/)
  if (name === "status") return publicStatus()
  if (name === "check") return { passed: await verify(selected) }
  if (name === "restart") {
    assert(child && ready && !exited, "Native host is not running")
    if (agentRequests("team").length) await verify("team")
    restarting = true; ready = false
    eventController.abort(); await stream.catch(() => {})
    child.kill("SIGTERM")
    await Promise.race([done, Bun.sleep(8000)])
    assert(exited, "Native host did not exit cleanly for restart")
    await boot(false)
    restarts += 1
    restarting = false
    checks.push("Native app restarted using the same isolated HOME, consent and persistent history")
    return publicStatus()
  }
  if (name === "finish") {
    for (const selected of ["quota", "fallback", "team"]) await verify(selected)
    action = "finish"; wake(); return { finishing: true }
  }
  if (name === "quit") { action = "quit"; wake(); return { quitting: true } }
  throw new Error("Commands: status, check quota|fallback|team, restart, finish, quit")
}
const control = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request): Promise<Response> {
  if (request.headers.get("authorization") !== "Bearer " + controlToken) return new Response("Unauthorized", { status: 401 })
  try {
    const route = new URL(request.url).pathname
    if (request.method === "GET" && route === "/status") return Response.json(writeStatus())
    if (request.method === "POST" && route === "/command") {
      const value = await request.json() as { command?: string }
      return Response.json(await command(value.command ?? ""))
    }
    return new Response("Use GET /status or POST /command", { status: 404 })
  } catch (error) { return Response.json({ error: String(error) }, { status: 409 }) }
} })
function queryPid(pid: number, field: string): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", field], { encoding: "utf8", env: { ...env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" } })
  return result.status === 0 ? result.stdout.trim() : undefined
}
async function cleanup() {
  eventController.abort()
  const ownedRegistry = existsSync(registryFile) ? registry() : undefined
  if (child && !exited) {
    child.kill("SIGTERM")
    await Promise.race([done, Bun.sleep(7000)])
    if (!exited) { child.kill("SIGKILL"); await Promise.race([done, Bun.sleep(2500)]) }
  }
  // Only the exact test-owned OS process identities may be reclaimed.
  if (child && ownedRegistry?.owner?.pid === child.pid) for (const role of ["opencode", "gateway", "knowledge", "acp"]) {
    const item = ownedRegistry[role], identity = item?.identity
    if (item?.pid && identity?.pid === item.pid && identity.parentPid === child.pid &&
      queryPid(item.pid, "comm=") === identity.executable && queryPid(item.pid, "lstart=") === identity.startedAt) {
      try { process.kill(item.pid, "SIGTERM") } catch { /* Already reaped by its host. */ }
    }
  }
  await stream.catch(() => {})
  writeFileSync(path.join(output, "host.log"), hostLog)
  const logs = path.join(home, ".local", "share", namespace, "log", "sidecar")
  if (existsSync(logs)) cpSync(logs, path.join(output, "sidecar-logs"), { recursive: true })
  fixture.stop(true); control.stop(true)
}
const lines = createInterface({ input: process.stdin })
lines.on("line", (line) => { void command(line).then((value) => console.log(JSON.stringify(value))).catch((error) => console.error(String(error))) })
const abort = () => { action = "quit"; wake() }
process.on("SIGINT", abort); process.on("SIGTERM", abort)
const maxTime = setTimeout(() => { failure = "Native GUI supervisor exceeded 30 minutes"; action = "quit"; wake() }, 30 * 60_000)
async function boot(first: boolean) {
  if (first) assert(!existsSync(consentFile))
  ready = false; exited = false
  eventController = new AbortController()
  child = spawn(executable, [], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  done = new Promise<void>((resolve) => {
    child!.once("error", (error) => { failure = String(error); exited = true; resolve(); wake() })
    child!.once("exit", () => { exited = true; resolve(); if (!action && !restarting) { failure = "Native app exited before acceptance finished"; wake() } })
  })
  for (const pipe of [child.stdout, child.stderr]) pipe?.on("data", (chunk: Buffer) => { hostLog = (hostLog + chunk.toString()).slice(-500_000) })
  writeStatus()
  const end = Date.now() + 150000
  let last = ""
  while (!ready && Date.now() < end) {
    assert(!exited && !action, failure ?? "Native startup interrupted")
    try {
      const value = registry()
      assert.equal(value.owner.pid, child.pid)
      assert.equal(value.brandId, namespace)
      assert.equal(value.owner.executable, executable)
      for (const [role, route] of [["opencode", "/global/health"], ["gateway", "/channel/health"], ["knowledge", "/kb/health"], ["acp", "/acp/health"]] as const)
        await api(role, route)
      ready = true
    } catch (error) { last = String(error); await Bun.sleep(200) }
  }
  assert(ready, "Native startup timed out: " + last + "\n" + hostLog.slice(-5000))
  if (first) {
    assert.equal(wire.length, 0, "A model was called before native GUI consent")
    assert.equal((await api("opencode", "/global/config")).model, undefined, "Native fresh install already has a selected model")
  }
  const response = await fetch("http://127.0.0.1:" + registry().opencode.port + "/event", {
    headers: { authorization: authorization(), "x-opencode-directory": encodeURIComponent(workspace) }, signal: eventController.signal,
  })
  assert(response.ok && response.body)
  stream = (async () => {
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true })
        let end: number
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          for (const line of frame.split("\n")) if (line.startsWith("data:")) {
            try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* Only complete JSON events. */ }
          }
        }
      }
    } catch (error) { if (!eventController.signal.aborted) { failure = "Native event stream failed: " + String(error); wake() } }
    finally { reader.releaseLock() }
  })()
  console.log("NATIVE READY " + JSON.stringify(publicStatus()))
}
try {
  await boot(true)
  await completion
} catch (error) { failure = String(error); console.error(error) }
finally {
  clearTimeout(maxTime); lines.close()
  process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort)
  const snapshots = {
    consent: existsSync(consentFile) ? readJson(consentFile) : undefined,
    ports: existsSync(registryFile) ? registry() : undefined,
    config: ready && !exited ? await api("opencode", "/global/config").catch(() => undefined) : undefined,
  }
  await cleanup()
  const binaries = ["opencode-server", "acp-client"].map((name) => {
    const file = path.join(app, "Contents", "MacOS", name)
    return { name, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }
  })
  const report = { generatedAt: new Date().toISOString(), result: !failure && action === "finish" ? "passed" : action === "quit" && !failure ? "aborted" : "failed",
    failure, namespace, app, executable, root, home, workspace, pid: child?.pid, hostExited: exited, checks,
    binaries, wire, fixtureErrors, events, snapshots, restarts, delegationEvidence, limits: [
      "Real packaged macOS Tauri app, native IPC, WKWebView and sidecars; root operator/CUA must separately record GUI evidence.",
      "Deterministic loopback LLM fixture; external Zen eligibility and other operating systems are not tested.",
      "Dedicated test brand and disposable HOME/XDG; formal signing, notarization and OS permissions are not acceptance targets.",
    ] }
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n")
  writeStatus()
  rmSync(root, { recursive: true, force: true })
  console.log("NATIVE REPORT " + path.join(output, "report.json") + " " + report.result)
  if (report.result === "failed") process.exitCode = 1
}
