#!/usr/bin/env bun
/** Data-forward check against an installed default edition. Only named sidecars
 * run, in a disposable home; never execute the desktop host or a deps artifact.
 * On macOS sandbox-exec also denies writes outside that disposable root.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_BRAND, resolveIdentity, type BrandIdentity } from "../packages/core/brand/src/index"
import type { RuntimeBrandContext } from "../packages/core/brand/src/node"

const repo = path.resolve(import.meta.dir, "..")
const argv = process.argv.slice(2)
const options: Record<string, string> = {}
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i]
  assert(["--legacy-app", "--output"].includes(flag) && !options[flag], `Unknown or repeated argument: ${flag}`)
  const value = argv[++i]
  assert(value && !value.startsWith("--"), `Missing value: ${flag}`)
  options[flag] = path.resolve(value)
}
assert(process.platform === "darwin", "Installed-app data-forward verification currently requires macOS")
assert(options["--legacy-app"], "Provide --legacy-app /path/to/Ultrawork.app")
assert(existsSync("/usr/bin/sandbox-exec"), "This verification requires a sandbox write guard")
const plistRead = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(options["--legacy-app"], "Contents", "Info.plist")], { encoding: "utf8" })
assert.equal(plistRead.status, 0, plistRead.stderr)
const legacyInfo = JSON.parse(plistRead.stdout)
assert.equal(legacyInfo.CFBundleIdentifier, DEFAULT_BRAND.identifier, "Use an installed default-edition app")

type Role = "opencode" | "gateway" | "knowledge" | "acp"
const roles: Role[] = ["opencode", "gateway", "knowledge", "acp"]
const names: Record<Role, string> = { opencode: "opencode-server", gateway: "channel-gateway", knowledge: "knowledge-sidecar", acp: "acp-client" }
const routes: Record<Role, string> = { opencode: "/global/health", gateway: "/channel/health", knowledge: "/kb/health", acp: "/acp/health" }
const target = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
const legacy = Object.fromEntries(roles.map((role) => [role, path.join(options["--legacy-app"], "Contents", "MacOS", names[role])])) as Record<Role, string>
const current = Object.fromEntries(roles.map((role) => [role, path.join(repo, "packages/client/desktop/src-tauri/binaries", `${names[role]}-${target}`)])) as Record<Role, string>
for (const binary of [...Object.values(legacy), ...Object.values(current)]) {
  assert(existsSync(binary), `Missing explicit sidecar: ${binary}`)
  assert(path.basename(binary).startsWith("opencode-server") || path.basename(binary).startsWith("channel-gateway") || path.basename(binary).startsWith("knowledge-sidecar") || path.basename(binary).startsWith("acp-client"))
}
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-brand-forward-")))
const home = path.join(root, "home")
const workspace = path.join(root, "workspace")
const temp = path.join(root, "tmp")
for (const dir of [home, workspace, temp]) mkdirSync(dir)
const password = randomBytes(32).toString("hex")
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const marker = "legacy_default_forward_fixture"
const sandbox = `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(root)}))`
const forbiddenCanary = path.join(tmpdir(), `uw-brand-forward-outside-${randomBytes(12).toString("hex")}.txt`)
const guardProbe = spawnSync("/usr/bin/sandbox-exec", ["-p", sandbox, "/usr/bin/touch", forbiddenCanary], {
  cwd: root, env: { HOME: home, USERPROFILE: home, TMPDIR: temp, TMP: temp, TEMP: temp }, encoding: "utf8",
})
assert.notEqual(guardProbe.status, 0, "The independent filesystem write guard must reject outside-root writes")
assert(!existsSync(forbiddenCanary), "The outside-root canary must not be created")
const allowedCanary = path.join(root, "guard-can-write-inside")
const guardControl = spawnSync("/usr/bin/sandbox-exec", ["-p", sandbox, "/usr/bin/touch", allowedCanary], { cwd: root, encoding: "utf8" })
assert.equal(guardControl.status, 0, "The guard must still permit writes inside its disposable root")
assert(existsSync(allowedCanary))
interface Owned { role: Role; phase: string; child: ChildProcess; exited: boolean; done: Promise<void>; log: string }
interface Phase { name: string; identity: BrandIdentity; context: RuntimeBrandContext; file: string; ports: Record<Role, number>; children: Owned[] }
const phases: Phase[] = []
const checks: string[] = []
const deadline = Date.now() + 150_000
let succeeded = false
const pass = (text: string) => { checks.push(text); console.log(`PASS ${text}`) }

async function reservePort() {
  const server = createServer()
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes) })
  const address = server.address()
  assert(address && typeof address !== "string")
  return { port: address.port, close: () => new Promise<void>((yes) => server.close(() => yes())) }
}
function environment(phase: Phase, managed: boolean): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) if (process.env[key]) result[key] = process.env[key]
  Object.assign(result, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
    TMPDIR: temp, TMP: temp, TEMP: temp, OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "no-managed-config"),
    OPENCODE_APP_NAME: phase.identity.namespace, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    ULTRAWORK_SIDECAR_USERNAME: "opencode", ULTRAWORK_SIDECAR_PASSWORD: password,
    OPENCODE_BASE_URL: `http://127.0.0.1:${phase.ports.opencode}`, GATEWAY_PORT: String(phase.ports.gateway), KB_PORT: String(phase.ports.knowledge), ACP_CLIENT_PORT: String(phase.ports.acp),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CHANNEL_DB: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], share: "disabled", autoupdate: false }),
  })
  if (managed) Object.assign(result, {
    ULTRAWORK_BRAND_CONTEXT: JSON.stringify(phase.context), ULTRAWORK_BRAND_CONTEXT_FILE: phase.file, ULTRAWORK_BRAND_MANAGED: "1",
    ULTRAWORK_APP_ROOT: phase.context.appRoot, ULTRAWORK_SKILLS_DIR: phase.context.skillsRoot,
  })
  return result
}
async function start(name: string, identity: BrandIdentity, binaries: Record<Role, string>, managed: boolean): Promise<Phase> {
  const ns = identity.namespace
  const configRoot = path.join(home, ".config", ns)
  const appRoot = path.join(home, `.${ns}`)
  const context: RuntimeBrandContext = { schemaVersion: 1, identity, instanceId: randomBytes(16).toString("hex"), ownerPid: process.pid,
    actualIdentifier: identity.identifier, appRoot, configRoot, dataRoot: path.join(home, ".local", "share", ns),
    cacheRoot: path.join(home, ".cache", ns), stateRoot: path.join(home, ".local", "state", ns),
    skillsRoot: path.join(configRoot, "skills"), portsRegistryPath: path.join(appRoot, "run", "ports.json") }
  const file = path.join(root, `${name}-context.json`)
  writeFileSync(file, JSON.stringify(context), { mode: 0o600 })
  const phase: Phase = { name, identity, context, file, ports: {} as Record<Role, number>, children: [] }
  phases.push(phase)
  const reservations = new Map<Role, Awaited<ReturnType<typeof reservePort>>>()
  for (const role of roles) {
    const reservation = await reservePort()
    reservations.set(role, reservation)
    phase.ports[role] = reservation.port
  }
  for (const role of roles) {
    await reservations.get(role)!.close()
    const args = role === "opencode" ? ["serve", "--port", String(phase.ports[role]), "--hostname", "127.0.0.1"] : managed ? ["--brand-context", file] : []
    const child = spawn("/usr/bin/sandbox-exec", ["-p", sandbox, binaries[role], ...args], { cwd: workspace, env: environment(phase, managed), stdio: ["ignore", "pipe", "pipe"] })
    const owned: Owned = { role, phase: name, child, exited: false, done: Promise.resolve(), log: "" }
    owned.done = new Promise((yes) => {
      child.once("error", (error) => { owned.log += String(error); owned.exited = true; yes() })
      child.once("exit", () => { owned.exited = true; yes() })
    })
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { owned.log = (owned.log + chunk.toString()).slice(-65_536) })
    phase.children.push(owned)
  }
  for (const role of roles) {
    const owned = phase.children.find((child) => child.role === role)!
    let last = "waiting"
    let ready = false
    for (let i = 0; i < 200; i++) {
      assert(Date.now() < deadline, "Data-forward verification exceeded its total deadline")
      assert(!owned.exited, `${name}/${role} exited: ${owned.log.slice(-5000)}`)
      try { assert.equal((await request(phase, role, routes[role])).healthy ?? true, true); ready = true; break } catch (error) { last = String(error) }
      await Bun.sleep(150)
    }
    assert(ready, `${name}/${role} health timeout: ${last}\n${owned.log.slice(-5000)}`)
  }
  return phase
}
async function request(phase: Phase, role: Role, route: string, method = "GET", body?: unknown): Promise<any> {
  assert(Date.now() < deadline, "Data-forward verification exceeded its total deadline")
  const response = await fetch(`http://127.0.0.1:${phase.ports[role]}${route}`, {
    method, headers: { Authorization: auth, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000),
  })
  const text = await response.text()
  assert(response.ok, `${phase.name}/${role} ${route}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}
async function stop(phase: Phase) {
  await Promise.all(phase.children.map(async (owned) => {
    if (owned.exited) return
    owned.child.kill("SIGTERM")
    await Promise.race([owned.done, Bun.sleep(3000)])
    if (!owned.exited) { owned.child.kill("SIGKILL"); await Promise.race([owned.done, Bun.sleep(3000)]) }
    assert(owned.exited, `Owned ${phase.name}/${owned.role} did not exit`)
  }))
}
let sessionId = ""
const readLegacy = async (phase: Phase, present: boolean) => {
  const config = await request(phase, "opencode", "/global/config")
  const sessions = await request(phase, "opencode", `/session?directory=${encodeURIComponent(workspace)}`)
  const channels = await request(phase, "gateway", "/channel")
  const agents = await request(phase, "acp", "/acp/agents")
  const sources = await request(phase, "knowledge", "/kb/sources")
  assert.equal(config.username === marker, present, `${phase.name}: default global config compatibility`)
  assert.equal(sessions.some((session: { id: string }) => session.id === sessionId), present, `${phase.name}: legacy session compatibility`)
  for (const [label, value] of Object.entries({ channels, agents, sources })) assert.equal(JSON.stringify(value).includes(marker), present, `${phase.name}: legacy ${label} compatibility`)
}
try {
  pass("independent macOS filesystem guard rejected a real outside-root write attempt")
  const old = await start("installed-default", DEFAULT_BRAND, legacy, false)
  await request(old, "opencode", "/global/config", "PATCH", { username: marker })
  const session = await request(old, "opencode", `/session?directory=${encodeURIComponent(workspace)}`, "POST", { title: marker })
  sessionId = session.id
  assert.equal(typeof sessionId, "string")
  await request(old, "gateway", "/channel", "POST", { type: "dingtalk", name: marker, workspaceDir: workspace, clientId: "offline-fixture", clientSecret: "offline-fixture", autoConnect: false })
  await request(old, "acp", `/acp/agents/${marker}`, "PUT", { label: marker, command: "offline-fixture-never-connect", args: [] })
  await request(old, "knowledge", "/kb/sources", "POST", { type: "custom_api", name: marker, config: {} })
  await readLegacy(old, true)
  pass(`installed Ultrawork ${legacyInfo.CFBundleShortVersionString} sidecars wrote and read configuration, session, channel, agent and knowledge-source fixtures in the disposable home`)
  await stop(old)
  const upgraded = await start("current-default", DEFAULT_BRAND, current, true)
  await readLegacy(upgraded, true)
  pass("current default sidecars read every installed fixture record through all five HTTP APIs")
  await stop(upgraded)
  const brand = await start("current-mywork", resolveIdentity({ brandId: "mywork", productName: "MyWork" }), current, true)
  await readLegacy(brand, false)
  pass("MyWork did not expose any installed-default fixture records from the same home/workspace")
  await stop(brand)
  succeeded = true
} finally {
  const cleanup = await Promise.allSettled(phases.map(stop))
  for (const phase of phases) for (const child of phase.children) writeFileSync(path.join(root, `${phase.name}-${child.role}.log`), child.log)
  const files = (directory: string): string[] => !existsSync(directory) ? [] : readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.relative(home, path.join(directory, entry.name))])
  const report = { schemaVersion: 1, succeeded, installedVersion: legacyInfo.CFBundleShortVersionString, currentVersion: JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).version,
    scope: "data-forward compatibility in a disposable home; not installer upgrade/downgrade or external account acceptance", root, home, target,
    guard: "sandbox-exec denies every file write outside the disposable root", checks, sessionId,
    fixtureFiles: files(home), cleanupErrors: cleanup.filter((result) => result.status === "rejected").map((result) => String(result.reason)),
    processes: phases.flatMap((phase) => phase.children.map((child) => ({ phase: phase.name, role: child.role, pid: child.child.pid, exited: child.exited }))) }
  if (options["--output"]) { mkdirSync(path.dirname(options["--output"]), { recursive: true }); writeFileSync(options["--output"], JSON.stringify(report, null, 2) + "\n") }
  console.log(JSON.stringify(report, null, 2))
  assert(cleanup.every((result) => result.status === "fulfilled"), "Some owned children could not be reaped")
}
