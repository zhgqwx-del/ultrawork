#!/usr/bin/env bun
/**
 * Run the four already-built sidecars for Ultrawork and MyWork in one disposable
 * HOME. No app/WebView, rebuild, model prompt, real credentials, or port-based
 * process cleanup. Usage: bun run --bun scripts/verify-brand-sidecars.ts [--keep] [--agents]
 * Optional --target <native-tauri-triple> selects existing binaries.
 * --binaries-dir <dir> probes an unpacked application's actual sidecars instead
 * (without the source tree's -target suffix), including relocated/Unicode paths.
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createServer, type Server } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "../packages/core/brand/src/index"
import type { RuntimeBrandContext } from "../packages/core/brand/src/node"
import { brandModelFixture } from "./brand-model-fixture"

type Role = "opencode" | "gateway" | "knowledge" | "acp"
const ROLES: Role[] = ["opencode", "gateway", "knowledge", "acp"]
const NAMES: Record<Role, string> = {
  opencode: "opencode-server", gateway: "channel-gateway", knowledge: "knowledge-sidecar", acp: "acp-client",
}
const HEALTH: Record<Role, string> = {
  opencode: "/global/health", gateway: "/channel/health", knowledge: "/kb/health", acp: "/acp/health",
}
const repo = resolve(import.meta.dir, "..")
const argv = process.argv.slice(2)
const targetIndex = argv.indexOf("--target")
const target = targetIndex < 0 ? nativeTarget() : argv[targetIndex + 1]
const binaryDirectoryIndex = argv.indexOf("--binaries-dir")
const binaryDirectoryArg = binaryDirectoryIndex < 0 ? undefined : argv[binaryDirectoryIndex + 1]
if (binaryDirectoryIndex >= 0 && (!binaryDirectoryArg || binaryDirectoryArg.startsWith("--"))) throw new Error("--binaries-dir requires a directory")
const binaryDirectory = binaryDirectoryArg ? resolve(binaryDirectoryArg) : undefined
const keep = argv.includes("--keep")
const models = argv.includes("--models")
const agents = argv.includes("--agents") || models
if (!target || target !== nativeTarget()) throw new Error("--target must name this machine's native Tauri target")
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--target" || argv[i] === "--binaries-dir") { i++; continue }
  if (!["--keep", "--agents", "--models"].includes(argv[i])) throw new Error(`Unknown argument: ${argv[i]}`)
}
const binaries = Object.fromEntries(ROLES.map((role) => [role, binaryDirectory
  ? join(binaryDirectory, `${NAMES[role]}${process.platform === "win32" ? ".exe" : ""}`)
  : join(repo, "packages", "client", "desktop", "src-tauri", "binaries", `${NAMES[role]}-${target}${process.platform === "win32" ? ".exe" : ""}`),
])) as Record<Role, string>
for (const binary of Object.values(binaries)) assert(existsSync(binary), `Build the native sidecar first: ${binary}`)

function nativeTarget(): string {
  if (process.platform === "darwin") return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc"
  if (process.platform === "linux") return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`
  throw new Error(`Unsupported native platform: ${process.platform}/${process.arch}`)
}

interface OwnedChild {
  role: Role
  brand: string
  child: ChildProcess
  log: string
  done: Promise<void>
  exited: boolean
}
interface Reservation { server: Server; port: number }
interface Instance {
  context: RuntimeBrandContext
  contextFile: string
  ports: Record<Role, number>
  children: OwnedChild[]
  workspace: string
  marker: string
}
const root = realpathSync(mkdtempSync(join(tmpdir(), "uw-brand-sidecars-")))
const home = join(root, "home")
const temporary = join(root, "tmp")
mkdirSync(home)
mkdirSync(temporary)
const samePassword = randomBytes(32).toString("hex")
const auth = `Basic ${Buffer.from(`opencode:${samePassword}`).toString("base64")}`
const reservations: Reservation[] = []
const instances: Instance[] = []
const agentState = new Map<Instance, { single: string; meta: string; team: string; run: string }>()
const checks: string[] = []
let modelFixture: ReturnType<typeof brandModelFixture> | undefined
let succeeded = false
let interrupted = false

function pass(message: string) { checks.push(message); console.log(`✓ ${message}`) }
function checkNotInterrupted() { if (interrupted) throw new Error("Verification interrupted") }
function onSignal() { interrupted = true }
process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)
const deadline = setTimeout(() => { interrupted = true }, 150_000)

async function reserve(): Promise<Reservation> {
  const server = createServer()
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes) })
  const address = server.address()
  assert(address && typeof address !== "string")
  const reservation = { server, port: address.port }
  reservations.push(reservation)
  return reservation
}
async function release(reservation: Reservation) {
  if (reservation.server.listening) await new Promise<void>((yes) => reservation.server.close(() => yes()))
}

function isolatedEnv(instance: Instance): NodeJS.ProcessEnv {
  // A small OS environment avoids inheriting provider secrets, managed context,
  // build-lock delegation, custom directories, or the caller's OpenCode config.
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return {
    ...env, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"), XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed-empty"),
    OPENCODE_APP_NAME: instance.context.identity.namespace,
    OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: samePassword,
    OPENCODE_BASE_URL: `http://127.0.0.1:${instance.ports.opencode}`,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CHANNEL_DB: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], share: "disabled", autoupdate: false, ...(modelFixture ? {
      model: "brand-probe/offline", small_model: "brand-probe/offline", permission: { "*": "allow" },
      provider: { "brand-probe": { name: "Offline", npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${modelFixture.server.port}/${instance.context.identity.namespace}/v1`, apiKey: "offline-fixture" },
        models: { offline: { id: "offline", name: "Offline", tool_call: true } }, whitelist: ["offline"],
      } },
      mcp: { orchestrator: { type: "local", enabled: true, command: [binaries.acp, "delegate-mcp", "--brand-context", instance.contextFile] } },
    } : {}) }),
    ULTRAWORK_SIDECAR_USERNAME: "opencode", ULTRAWORK_SIDECAR_PASSWORD: samePassword,
    ULTRAWORK_BRAND_CONTEXT: JSON.stringify(instance.context),
    ULTRAWORK_BRAND_CONTEXT_FILE: instance.contextFile, ULTRAWORK_BRAND_MANAGED: "1",
    ULTRAWORK_APP_ROOT: instance.context.appRoot, ULTRAWORK_SKILLS_DIR: instance.context.skillsRoot,
    ACP_CLIENT_PORT: String(instance.ports.acp), KB_PORT: String(instance.ports.knowledge), GATEWAY_PORT: String(instance.ports.gateway),
  }
}

function launch(instance: Instance, role: Role): OwnedChild {
  const args = role === "opencode"
    ? ["serve", "--port", String(instance.ports.opencode), "--hostname", "127.0.0.1"]
    : ["--brand-context", instance.contextFile]
  const env = isolatedEnv(instance)
  // The actual host starts OpenCode before the ACP port is known. Its MCP shim
  // must therefore discover ACP through its own brand/instance registry.
  if (role === "opencode" && models) delete env.ACP_CLIENT_PORT
  const child = spawn(binaries[role], args, {
    cwd: instance.workspace, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  })
  const owned: OwnedChild = { role, brand: instance.context.identity.brandId, child, log: "", done: Promise.resolve(), exited: false }
  owned.done = new Promise<void>((yes) => {
    child.once("error", (error) => { owned.log += String(error); owned.exited = true; yes() })
    child.once("exit", () => { owned.exited = true; yes() })
  })
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
    owned.log = (owned.log + chunk.toString()).slice(-32_768)
  })
  instance.children.push(owned)
  return owned
}

async function request(instance: Instance, role: Role, route: string, method = "GET", body?: unknown): Promise<any> {
  checkNotInterrupted()
  const response = await fetch(`http://127.0.0.1:${instance.ports[role]}${route}`, {
    method, headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000),
  })
  const text = await response.text()
  assert(response.ok, `${instance.context.identity.brandId}/${role} ${route}: HTTP ${response.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}

async function healthy(instance: Instance, role: Role): Promise<void> {
  const owned = instance.children.filter((entry) => entry.role === role).at(-1)!
  const until = Date.now() + 35_000
  let last = "not listening"
  while (Date.now() < until) {
    checkNotInterrupted()
    assert(!owned.exited, `${owned.brand}/${role} exited before health: ${owned.log.slice(-2000)}`)
    try {
      const data = await request(instance, role, HEALTH[role])
      if (role === "opencode") assert.equal(data.healthy, true)
      else {
        assert.equal(data.brandId, instance.context.identity.brandId)
        assert.equal(data.identifier, instance.context.identity.identifier)
        assert.equal(data.instanceId, instance.context.instanceId)
      }
      return
    } catch (error) { last = String(error) }
    await Bun.sleep(150)
  }
  throw new Error(`${owned.brand}/${role} health timeout: ${last}\n${owned.log.slice(-2000)}`)
}

async function stop(instance: Instance): Promise<void> {
  // Handles are the only cleanup authority: never enumerate or kill a port,
  // process name, PID from disk, or somebody else's process group.
  await Promise.all(instance.children.map(async (owned) => {
    if (owned.exited) return
    owned.child.kill("SIGTERM")
    await Promise.race([owned.done, Bun.sleep(2500)])
    if (!owned.exited) { owned.child.kill("SIGKILL"); await Promise.race([owned.done, Bun.sleep(2500)]) }
    assert(owned.exited, `Could not stop owned child ${owned.brand}/${owned.role} (pid ${owned.child.pid})`)
  }))
}

async function makeInstance(identity: BrandIdentity): Promise<Instance> {
  const ns = identity.namespace
  const appRoot = join(home, `.${ns}`)
  const configRoot = join(home, ".config", ns)
  const context: RuntimeBrandContext = {
    schemaVersion: 1, identity, instanceId: randomBytes(16).toString("hex"), ownerPid: process.pid,
    actualIdentifier: identity.identifier, appRoot, configRoot, dataRoot: join(home, ".local", "share", ns),
    cacheRoot: join(home, ".cache", ns), stateRoot: join(home, ".local", "state", ns),
    skillsRoot: join(configRoot, "skills"), portsRegistryPath: join(appRoot, "run", "ports.json"),
  }
  mkdirSync(join(appRoot, "run"), { recursive: true })
  const contextFile = join(appRoot, "run", "brand-context.json")
  writeFileSync(contextFile, JSON.stringify(context), { mode: 0o600 })
  // Both backends see the same directory, so a session-list query cannot hide
  // a shared database behind different workspace filters.
  const workspace = join(root, "workspace")
  mkdirSync(workspace, { recursive: true })
  const instance: Instance = { context, contextFile, ports: {} as Record<Role, number>, children: [], workspace, marker: `brand_probe_${ns}` }
  instances.push(instance)
  const reserved = new Map<Role, Reservation>()
  for (const role of ROLES) {
    const reservation = await reserve()
    reserved.set(role, reservation)
    instance.ports[role] = reservation.port
  }
  writeFileSync(context.portsRegistryPath, JSON.stringify({
    brandId: identity.brandId, instanceId: context.instanceId, acp: { port: instance.ports.acp },
  }))
  // Release only the intended reservation immediately before its child binds.
  // A competing listener is a test failure; it is never stopped or reused.
  for (const role of ROLES) { await release(reserved.get(role)!); launch(instance, role) }
  return instance
}

async function verifyData(instance: Instance, foreign: Instance) {
  const marker = instance.marker
  const alien = foreign.marker
  await request(instance, "opencode", "/global/config", "PATCH", { username: marker })
  assert.equal((await request(instance, "opencode", "/global/config")).username, marker)
  const session = await request(instance, "opencode", `/session?directory=${encodeURIComponent(instance.workspace)}`, "POST", { title: marker })
  assert.equal(session.title, marker)
  const sessions = await request(instance, "opencode", `/session?directory=${encodeURIComponent(instance.workspace)}`)
  assert(sessions.some((entry: { id: string }) => entry.id === session.id))
  assert(!JSON.stringify(sessions).includes(alien), "OpenCode exposed the other brand's session")

  await request(instance, "gateway", "/channel", "POST", {
    type: "dingtalk", name: marker, workspaceDir: instance.workspace, clientId: "local-probe", clientSecret: "local-probe", autoConnect: false,
  })
  const channels = JSON.stringify(await request(instance, "gateway", "/channel"))
  assert(channels.includes(marker) && !channels.includes(alien), "Gateway records crossed brands")
  await request(instance, "acp", `/acp/agents/${marker}`, "PUT", { label: marker, command: "brand-probe-never-connect", args: [] })
  const agents = JSON.stringify(await request(instance, "acp", "/acp/agents"))
  assert(agents.includes(marker) && !agents.includes(alien), "ACP agents crossed brands")
  await request(instance, "knowledge", "/kb/sources", "POST", { type: "custom_api", name: marker, config: {} })
  const sources = JSON.stringify(await request(instance, "knowledge", "/kb/sources"))
  assert(sources.includes(marker) && !sources.includes(alien), "Knowledge records crossed brands")

  const { appRoot, configRoot, dataRoot, cacheRoot, stateRoot } = instance.context
  assert(readFileSync(join(appRoot, "channels.json"), "utf8").includes(marker))
  assert(readFileSync(join(configRoot, "agents.json"), "utf8").includes(marker))
  const configFile = ["opencode.jsonc", "opencode.json", "config.json"]
    .map((name) => join(configRoot, name)).find(existsSync)
  assert(configFile && readFileSync(configFile, "utf8").includes(marker))
  assert(existsSync(join(appRoot, "knowledge", "kb.db")))
  assert(existsSync(join(dataRoot, "opencode.db")))
  assert(existsSync(cacheRoot) && existsSync(stateRoot))
  pass(`${instance.context.identity.productName}: real HTTP writes stayed in app/config/data/cache/state roots`)
}

/** Real ACP requests, Team twin/registry, delegate MCP and worktree Pipeline,
 * with deterministic local ACP agents so no model or provider account is used. */
async function verifyAgents(instance: Instance, foreign: Instance) {
  const ns = instance.context.identity.namespace
  const probeLog = join(root, `${ns}-agents.jsonl`)
  const sidecarCopies = join(instance.context.appRoot, "sidecars")
  mkdirSync(sidecarCopies, { recursive: true })
  copyFileSync(binaries.knowledge, join(sidecarCopies, `knowledge-sidecar${process.platform === "win32" ? ".exe" : ""}`))
  const fixture = join(repo, "packages", "agent", "acp-client", "scripts", "brand-probe-acp-agent.ts")
  for (const role of ["single", "single-meta", "leader", "member"] as const) {
    await request(instance, "acp", `/acp/agents/brand-${role}`, "PUT", {
      label: `${ns}-${role}`, command: process.execPath, args: ["run", "--bun", fixture],
      // Deliberately stale user fields must not override the host context.
      env: { OPENCODE_APP_NAME: "wrongbrand", ACP_CLIENT_PORT: "1", ULTRAWORK_BRAND_CONTEXT: "invalid",
        BRAND_PROBE_LOG: probeLog, BRAND_PROBE_ROLE: role },
      knowledgeMcp: true, orchestratorMcp: true,
      ...(role === "single-meta" ? { metaSystemPrompt: true } : {}),
    })
  }
  const single = await request(instance, "acp", "/acp/session", "POST", {
    agentId: "brand-single", cwd: instance.workspace, orchestrate: false,
  })
  await request(instance, "acp", `/acp/session/${single.sessionId}/prompt`, "POST", { text: "probe:single-answer" })
  const singleHistory = JSON.stringify(await request(instance, "acp", `/acp/session/${single.sessionId}/messages`))
  assert(singleHistory.includes(instance.marker) && !singleHistory.includes(foreign.marker), "Single Agent Knowledge MCP crossed brands")
  const meta = await request(instance, "acp", "/acp/session", "POST", {
    agentId: "brand-single-meta", cwd: instance.workspace, orchestrate: false,
  })
  await request(instance, "acp", `/acp/session/${meta.sessionId}/prompt`, "POST", { text: "probe:single-meta" })
  const team = await request(instance, "acp", "/orchestration/team/sessions", "POST", {
    workspace: instance.workspace, leaderAgentId: "acp:brand-leader", members: ["acp:brand-member"],
  })
  await request(instance, "acp", `/acp/session/${team.session.id}/prompt`, "POST", { text: "probe:leader-delegate" })
  const leaderHistory = JSON.stringify(await request(instance, "acp", `/acp/session/${team.session.id}/messages`))
  assert(leaderHistory.includes("completed") && leaderHistory.includes(instance.marker) && !leaderHistory.includes(foreign.marker), "Team leader/member transcript crossed brands")
  const delegates = (await request(instance, "acp", "/orchestration/delegates")).delegates
  assert(delegates.some((entry: { status: string; ownerSessionId: string }) => entry.status === "completed" && entry.ownerSessionId === team.session.id), "Team MCP lost its owner session")
  assert(readFileSync(join(instance.context.dataRoot, "team-sessions.json"), "utf8").includes(team.session.id))
  assert(!JSON.stringify(await request(foreign, "acp", "/orchestration/team/sessions")).includes(team.session.id))
  const forbidden = await fetch(`http://127.0.0.1:${instance.ports.acp}/orchestration/delegate`, {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: instance.workspace, agentId: "acp:brand-single", task: "must be rejected" }),
  })
  assert.equal(forbidden.status, 403, "Team member allowlist stopped enforcing")
  await forbidden.body?.cancel()

  const run = (await request(instance, "acp", "/orchestration/runs", "POST", { recipe: {
    name: `${ns}-pipeline`, workspace: instance.workspace,
    steps: [{ id: "isolated", agentId: "acp:brand-member", taskPrompt: "probe:write-artifact", isolation: "worktree", timeoutMs: 15_000 }],
  } })).run
  let completed: any
  for (let i = 0; i < 100; i++) {
    completed = (await request(instance, "acp", `/orchestration/runs/${run.id}`)).run
    if (!["pending", "running"].includes(completed.status)) break
    await Bun.sleep(100)
  }
  assert.equal(completed.status, "completed", JSON.stringify(completed))
  const artifact = completed.steps[0].artifactPath
  assert(artifact.startsWith(join(instance.workspace, `.${ns}`, "runs", run.id)), "Pipeline artifact escaped its brand")
  assert(readFileSync(artifact, "utf8").includes(instance.marker))
  assert(existsSync(join(instance.context.dataRoot, "orchestrator-runs", `${run.id}.json`)))
  assert(!JSON.stringify(await request(foreign, "acp", "/orchestration/runs")).includes(run.id))
  const evidence = readFileSync(probeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert(evidence.every((entry) => entry.brandId === ns))
  assert(evidence.some((entry) => entry.event === "turn" && entry.role === "leader" && entry.delegated))
  for (const role of ["single", "single-meta", "leader", "member"]) {
    assert(evidence.some((entry) => entry.event === "turn" && entry.role === role && entry.productName === instance.context.identity.productName), `ACP ${role} did not receive its host identity`)
  }
  assert(evidence.some((entry) => entry.event === "session" && entry.role === "single-meta" && entry.metaProductName === instance.context.identity.productName), "ACP metadata identity was not delivered through the explicit adapter configuration")
  assert(evidence.some((entry) => entry.event === "session" && entry.role === "member" && !entry.mcp.some((server: { name: string }) => server.name === "orchestrator")), "Delegate child received recursive orchestration tools")
  assert(evidence.some((entry) => entry.event === "artifact" && entry.cwd.startsWith(join(instance.context.dataRoot, "worktrees"))), "Worktree did not use this brand's data root")
  agentState.set(instance, { single: single.sessionId, meta: meta.sessionId, team: team.session.id, run: run.id })
  pass(`${instance.context.identity.productName}: single ACP + Knowledge MCP, Team leader/member delegate MCP, member guard, Pipeline/worktree/artifact persistence`)
}

async function verifyAgentRestart(instance: Instance, foreign: Instance) {
  const previous = agentState.get(instance)!
  await stop({ ...instance, children: instance.children.filter((entry) => entry.role === "acp") })
  launch(instance, "acp")
  await healthy(instance, "acp")
  const teams = JSON.stringify(await request(instance, "acp", "/orchestration/team/sessions"))
  assert(teams.includes(previous.team), "Team registry did not survive ACP restart")
  const run = (await request(instance, "acp", `/orchestration/runs/${previous.run}`)).run
  assert.equal(run.status, "completed", "Completed Pipeline state did not survive ACP restart")
  const sessions = JSON.stringify(await request(instance, "acp", "/acp/sessions"))
  assert(sessions.includes(previous.single) && sessions.includes(previous.team), "Single/Team ACP bindings did not survive restart")
  await request(instance, "acp", `/acp/session/${previous.single}/prompt`, "POST", { text: "probe:restored-single" })
  await request(instance, "acp", `/acp/session/${previous.meta}/prompt`, "POST", { text: "probe:restored-meta" })
  await request(instance, "acp", `/acp/session/${previous.team}/prompt`, "POST", { text: "probe:leader-delegate" })
  const history = JSON.stringify(await request(instance, "acp", `/acp/session/${previous.team}/messages`))
  assert(history.includes(instance.marker) && !history.includes(foreign.marker))
  const delegates = (await request(instance, "acp", "/orchestration/delegates")).delegates
  assert(delegates.some((entry: { status: string; ownerSessionId: string }) => entry.status === "completed" && entry.ownerSessionId === previous.team), "Restored leader lost delegate ownership")
  const evidence = readFileSync(join(root, `${instance.context.identity.namespace}-agents.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert(evidence.some((entry) => entry.event === "restored" && entry.role === "single-meta" && entry.metaProductName === instance.context.identity.productName), "ACP session/load lost its appended host identity")
  pass(`${instance.context.identity.productName}: ACP restart restores single/Team bindings, completed Pipeline and functional leader/member MCP delegation`)
}

async function verifyOpenCodeModels(instance: Instance, foreign: Instance) {
  const ns = instance.context.identity.namespace
  const single = await request(instance, "opencode", `/session?directory=${encodeURIComponent(instance.workspace)}`, "POST", {})
  const team = (await request(instance, "acp", "/orchestration/team/sessions", "POST", {
    workspace: instance.workspace, leaderAgentId: "opencode:default", members: ["acp:brand-member"],
  })).session
  for (const [id, mode] of [[single.id, "single"], [team.id, "team"]] as const) {
    await request(instance, "opencode", `/session/${id}/prompt_async?directory=${encodeURIComponent(instance.workspace)}`, "POST", {
      parts: [{ type: "text", text: `probe:opencode-${mode}` }], model: { providerID: "brand-probe", modelID: "offline" },
    })
    let history = ""
    for (let i = 0; i < 150; i++) {
      const messages = await request(instance, "opencode", `/session/${id}/message?directory=${encodeURIComponent(instance.workspace)}`)
      history = JSON.stringify(messages)
      if (messages.some((message: { info?: { error?: unknown } }) => message.info?.error)) throw new Error(`OpenCode ${ns}/${mode}: ${history}`)
      if (history.includes(`${ns}-opencode-${mode}-ok`)) break
      await Bun.sleep(150)
    }
    assert(history.includes(`${ns}-opencode-${mode}-ok`), `OpenCode ${ns}/${mode} timed out: ${history}`)
    assert(!history.includes(foreign.marker), "OpenCode transcript crossed brand namespaces")
  }
  const delegates = (await request(instance, "acp", "/orchestration/delegates")).delegates
  assert(delegates.some((entry: { status: string; ownerSessionId?: string }) => entry.status === "completed" && entry.ownerSessionId === team.id), "OpenCode MCP did not forward owner session metadata")
  assert(modelFixture!.requests.some((entry) => entry.namespace === ns && entry.called?.endsWith("_delegate")))
  pass(`${instance.context.identity.productName}: real OpenCode single turn and Team tool loop → registry-bound delegate MCP → ACP member; owner metadata preserved`)
}

try {
  console.log(`Using ${target}; isolated HOME: ${home}`)
  if (models) modelFixture = brandModelFixture((namespace) => {
    const instance = instances.find((candidate) => candidate.context.identity.namespace === namespace)
    assert(instance, "Unknown offline model namespace")
    return instance.workspace
  })
  const first = await makeInstance(DEFAULT_BRAND)
  const second = await makeInstance(resolveIdentity({ brandId: "mywork", productName: "MyWork" }))
  assert.equal(new Set(instances.flatMap((instance) => Object.values(instance.ports))).size, 8)
  await Promise.all(instances.flatMap((instance) => ROLES.map(async (role) => { await healthy(instance, role) })))
  pass("8 native sidecars healthy simultaneously on different dynamic ports; TS health identities match their contexts")

  // The password intentionally matches for both brands: an HTTP 200 alone
  // cannot establish process/brand ownership (OpenCode has no brand health field).
  for (const instance of instances) for (const role of ROLES) {
    const response = await fetch(`http://127.0.0.1:${instance.ports[role]}${HEALTH[role]}`, {
      headers: { Authorization: `Basic ${Buffer.from("opencode:wrong-password").toString("base64")}` }, signal: AbortSignal.timeout(2000),
    })
    assert.equal(response.status, 401, `${instance.context.identity.brandId}/${role} accepted the wrong password`)
    await response.body?.cancel()
  }
  pass("Same-password control: both brands answer independently; all 8 services reject a wrong password")
  await verifyData(first, second)
  await verifyData(second, first)
  // Re-read A after B writes, so brand B cannot silently overwrite A's roots.
  assert.equal((await request(first, "opencode", "/global/config")).username, first.marker)
  assert(!JSON.stringify(await request(first, "opencode", `/session?directory=${encodeURIComponent(first.workspace)}`)).includes(second.marker))
  for (const [role, route] of [["gateway", "/channel"], ["acp", "/acp/agents"], ["knowledge", "/kb/sources"]] as const) {
    assert(!JSON.stringify(await request(first, role, route)).includes(second.marker))
  }
  pass("Writing MyWork did not overwrite or expose records in Ultrawork")
  if (agents) {
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: first.workspace, encoding: "utf8" })
      assert.equal(result.status, 0, result.stderr)
    }
    git(["init"])
    writeFileSync(join(first.workspace, "fixture.txt"), "offline brand acceptance\n")
    git(["add", "fixture.txt"])
    git(["-c", "user.name=Offline Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"])
    await verifyAgents(first, second)
    await verifyAgents(second, first)
    await verifyAgentRestart(first, second)
    await verifyAgentRestart(second, first)
    if (models) {
      await verifyOpenCodeModels(first, second)
      await verifyOpenCodeModels(second, first)
      assert.deepEqual(modelFixture!.failures, [], "The offline model rejected one or more actual wire prompts")
      for (const instance of instances) {
        const seen = modelFixture!.requests.filter((entry) => entry.namespace === instance.context.identity.namespace)
        assert(seen.length > 0 && seen.every((entry) => entry.productName === instance.context.identity.productName))
      }
      pass("Both brands: every real OpenCode model request carries exactly its own canonical product identity")
    }
  }

  await stop(first)
  for (const role of ROLES) await healthy(second, role)
  assert.equal(second.children.filter((owned) => !owned.exited).length, ROLES.length)
  pass("Stopping all 4 Ultrawork children leaves all 4 MyWork children healthy")
  const report = {
    target, binaries, checks, ...(modelFixture ? { offlineModelRequests: modelFixture.requests } : {}), instances: instances.map((instance) => ({ brand: instance.context.identity,
      ports: instance.ports, paths: instance.context, pids: instance.children.map((owned) => ({ role: owned.role, pid: owned.child.pid })),
    })),
  }
  writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2))
  succeeded = true
} catch (error) {
  console.error(`Brand sidecar verification failed: ${error instanceof Error ? error.stack : String(error)}`)
  for (const instance of instances) for (const owned of instance.children) {
    console.error(`--- ${owned.brand}/${owned.role} pid=${owned.child.pid} ---\n${owned.log.slice(-5000)}`)
  }
  process.exitCode = 1
} finally {
  clearTimeout(deadline)
  const cleanup = await Promise.allSettled(instances.map(stop))
  for (const result of cleanup) if (result.status === "rejected") { console.error(result.reason); process.exitCode = 1 }
  await Promise.all(reservations.map(release))
  modelFixture?.server.stop(true)
  for (const instance of instances) for (const owned of instance.children) {
    writeFileSync(join(root, `${owned.brand}-${owned.role}.log`), owned.log)
  }
  process.removeListener("SIGINT", onSignal)
  process.removeListener("SIGTERM", onSignal)
  const allStopped = instances.every((instance) => instance.children.every((owned) => owned.exited))
  if (succeeded && !keep && allStopped && !process.exitCode) rmSync(root, { recursive: true, force: true })
  else console.log(`Disposable evidence retained: ${root} (${readdirSync(root).length} entries)`)
  console.log(succeeded && !process.exitCode ? "Brand sidecar verification passed; all owned children reaped." : "Brand sidecar verification did not pass.")
}
