#!/usr/bin/env bun
/** Real packaged hosts in a disposable HOME/XDG. No model call or OS permission
 * grant; cleanup uses only spawned host handles and identities they recorded.
 */
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

if (process.platform !== "darwin") throw new Error("This native host verifier requires macOS")
const args = process.argv.slice(2)
const options: Record<string, string> = {}
for (let i = 0; i < args.length; i++) {
  assert(["--default-app", "--brand-app", "--brand-alternate-app", "--output"].includes(args[i]), `Unknown argument: ${args[i]}`)
  assert(!options[args[i]] && args[i + 1] && !args[i + 1].startsWith("--"), `Missing or repeated argument: ${args[i]}`)
  options[args[i]] = path.resolve(args[++i])
}
assert(options["--default-app"] && options["--brand-app"], "Provide --default-app and --brand-app")
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "uw-brand-native-")))
const home = path.join(root, "客户 Home")
const temp = path.join(root, "tmp")
mkdirSync(home)
mkdirSync(temp)
const env: NodeJS.ProcessEnv = {}
for (const key of ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "LOGNAME", "USER"]) if (process.env[key]) env[key] = process.env[key]
Object.assign(env, {
  // Model a LaunchServices environment rather than borrowing the terminal's
  // UTF-8 locale. Internal process probes must preserve Unicode paths anyway.
  LANG: "C", LC_ALL: "C",
  HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_STATE_HOME: path.join(home, ".local", "state"),
  TMPDIR: temp, TMP: temp, TEMP: temp, OPENCODE_TEST_HOME: home,
  OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [], share: "disabled", autoupdate: false }),
})
type Role = "opencode" | "gateway" | "knowledge" | "acp"
const health: Record<Role, string> = { opencode: "/global/health", gateway: "/channel/health", knowledge: "/kb/health", acp: "/acp/health" }
interface Host { ns: string; app: string; executable: string; child: ChildProcess; log: string; exited: boolean; done: Promise<void> }
const hosts: Host[] = []
const checks: string[] = []
const pass = (message: string) => { checks.push(message); console.log(`PASS ${message}`) }
function launch(app: string, ns: string): Host {
  const result = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(app, "Contents", "Info.plist")], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  const plist = JSON.parse(result.stdout)
  const executable = realpathSync(path.join(app, "Contents", "MacOS", plist.CFBundleExecutable))
  const child = spawn(executable, [], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
  const host: Host = { ns, app, executable, child, log: "", exited: false, done: Promise.resolve() }
  host.done = new Promise((yes) => {
    child.once("error", (error) => { host.log += String(error); host.exited = true; yes() })
    child.once("exit", () => { host.exited = true; yes() })
  })
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { host.log = (host.log + chunk.toString()).slice(-300_000) })
  hosts.push(host)
  return host
}
const registryFile = (ns: string) => path.join(home, `.${ns}`, "run", "ports.json")
const readRegistry = (ns: string) => JSON.parse(readFileSync(registryFile(ns), "utf8"))
function authorization(ns: string): string {
  const credentials = JSON.parse(readFileSync(path.join(home, ".config", ns, "sidecar-auth.json"), "utf8"))
  assert(typeof credentials.password === "string")
  return `Basic ${Buffer.from(`${credentials.username ?? "opencode"}:${credentials.password}`).toString("base64")}`
}
async function api(ns: string, route: string, method = "GET", body?: unknown): Promise<any> {
  const registry = readRegistry(ns)
  const workspace = path.join(home, `.${ns}`, "workspace")
  const response = await fetch(`http://127.0.0.1:${registry.opencode.port}${route}`, {
    method, headers: { Authorization: authorization(ns), "x-opencode-directory": encodeURIComponent(workspace),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  })
  assert(response.ok, `${ns} ${route}: HTTP ${response.status}`)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}
async function seedRestartMcp(ns: string) {
  const contextFile = path.join(home, `.${ns}`, "run", "brand-context.json")
  const context = JSON.parse(readFileSync(contextFile, "utf8"))
  const registry = readRegistry(ns)
  const environment = { KEEP_USER_MARKER: "preserve-native-fixture", ULTRAWORK_BRAND_CONTEXT: JSON.stringify(context),
    ULTRAWORK_BRAND_CONTEXT_FILE: contextFile, ULTRAWORK_BRAND_MANAGED: "1", ACP_CLIENT_PORT: String(registry.acp.port) }
  const mcp = {
    "brand-native-knowledge": { type: "local", enabled: true,
      command: [path.join(home, `.${ns}`, "sidecars", "knowledge-sidecar"), "mcp-stdio", "--brand-context", contextFile], environment },
    "brand-native-delegate": { type: "local", enabled: true,
      command: [path.join(home, `.${ns}`, "sidecars", "acp-client"), "delegate-mcp", "--brand-context", contextFile], environment },
    "brand-user-control": { type: "local", enabled: false, command: ["never-run-brand-user-control"], environment: { KEEP_USER: "unchanged" } },
  }
  await api(ns, "/global/config", "PATCH", { username: "native-restart-fixture", mcp })
  const config = await api(ns, "/global/config")
  assert.equal(config.username, "native-restart-fixture")
  return config
}
async function verifyRestartMcp(ns: string) {
  const config = await api(ns, "/global/config")
  assert.equal(config.username, "native-restart-fixture")
  assert.deepEqual(config.mcp["brand-user-control"], { type: "local", enabled: false,
    command: ["never-run-brand-user-control"], environment: { KEEP_USER: "unchanged" } })
  for (const name of ["brand-native-knowledge", "brand-native-delegate"]) {
    const entry = config.mcp[name]
    assert.equal(entry.environment.KEEP_USER_MARKER, "preserve-native-fixture")
    for (const key of ["ACP_CLIENT_PORT", "ULTRAWORK_BRAND_CONTEXT", "ULTRAWORK_BRAND_CONTEXT_FILE", "ULTRAWORK_BRAND_MANAGED"]) {
      assert.equal(entry.environment[key], undefined, `Stale managed MCP environment survived restart: ${name}/${key}`)
    }
    assert(entry.command.includes(path.join(home, `.${ns}`, "run", "brand-context.json")))
  }
  const status = await api(ns, "/mcp")
  for (const name of ["brand-native-knowledge", "brand-native-delegate"]) {
    assert.equal(status[name]?.status, "connected", `${name} did not reconnect after native restart: ${JSON.stringify(status[name])}`)
  }
}
async function assertHealthy(ns: string, registry = readRegistry(ns)) {
  for (const role of Object.keys(health) as Role[]) {
    const response = await fetch(`http://127.0.0.1:${registry[role].port}${health[role]}`, {
      headers: { Authorization: authorization(ns) }, signal: AbortSignal.timeout(2500),
    })
    assert(response.ok, `${ns}/${role}: HTTP ${response.status}`)
    const data = await response.json() as Record<string, unknown>
    if (role === "opencode") assert.equal(data.healthy, true)
    else { assert.equal(data.brandId, ns); assert.equal(data.instanceId, registry.instanceId) }
  }
}
async function ready(host: Host) {
  let last = "waiting for the runtime registry"
  for (let i = 0; i < 450; i++) {
    assert(!host.exited, `${host.ns} host exited: ${host.log.slice(-8000)}`)
    if (host.log.includes("[startup] blocked")) throw new Error(host.log.slice(-8000))
    try {
      const registry = readRegistry(host.ns)
      assert.equal(registry.owner.pid, host.child.pid)
      assert.equal(registry.owner.executable, host.executable, "GUI/C locale must preserve the real Unicode executable path")
      assert.equal(registry.brandId, host.ns)
      for (const role of Object.keys(health) as Role[]) {
        assert(Number.isInteger(registry[role].pid) && registry[role].pid > 0, `${role} has not published its pid yet`)
        assert.equal(registry[role].identity?.pid, registry[role].pid)
      }
      await assertHealthy(host.ns, registry)
      const settled = readRegistry(host.ns)
      assert.deepEqual(settled, registry, "Wait for the concurrent boot registry writers to settle")
      return settled
    } catch (error) { last = String(error) }
    await Bun.sleep(200)
  }
  throw new Error(`${host.ns} native startup timed out: ${last}\n${host.log.slice(-12000)}`)
}
async function stop(host: Host) {
  if (host.exited) return
  host.child.kill("SIGTERM")
  await Promise.race([host.done, Bun.sleep(7000)])
  if (!host.exited) { host.child.kill("SIGKILL"); await Promise.race([host.done, Bun.sleep(3000)]) }
  assert(host.exited, `Owned host ${host.child.pid} did not exit`)
}
function alive(pid: number) { try { process.kill(pid, 0); return true } catch { return false } }
function unchanged(ns: string, expected: unknown) { assert.deepEqual(readRegistry(ns), expected) }
let succeeded = false
try {
  const brand = launch(options["--brand-app"], "mywork")
  const brandRegistry = await ready(brand)
  assert(!existsSync(path.join(home, ".ultrawork")), "Custom first launch wrote the default app root")
  assert(!existsSync(path.join(home, ".config", "ultrawork")), "Custom first launch wrote the default config")
  pass("relocated MyWork native host starts all four services without creating default-brand roots")
  const defaults = launch(options["--default-app"], "ultrawork")
  const defaultRegistry = await ready(defaults)
  await assertHealthy("mywork")
  const ports = [brandRegistry, defaultRegistry].flatMap((registry) => (Object.keys(health) as Role[]).map((role) => registry[role].port))
  assert.equal(new Set(ports).size, 8)
  pass("real Ultrawork and MyWork hosts coexist with eight distinct healthy service ports")

  const duplicate = launch(options["--brand-app"], "mywork")
  await Promise.race([duplicate.done, Bun.sleep(12_000)])
  assert(duplicate.exited, "Same-identifier duplicate did not exit after focusing the existing host")
  unchanged("mywork", brandRegistry)
  await assertHealthy("mywork")
  pass("same-identifier duplicate exits without replacing the original registry or services")

  if (options["--brand-alternate-app"]) {
    const alternate = launch(options["--brand-alternate-app"], "mywork")
    for (let i = 0; i < 100 && !alternate.log.includes("[startup] blocked") && !alternate.exited; i++) await Bun.sleep(150)
    assert(alternate.log.includes("[startup] blocked"), `Alternate-mode host did not report the namespace lease rejection: ${alternate.log.slice(-3000)}`)
    unchanged("mywork", brandRegistry)
    await stop(alternate)
    unchanged("mywork", brandRegistry)
    await assertHealthy("mywork")
    pass("same-namespace alternate identifier is blocked before services; its exit preserves the active registry")
  }

  const restartConfig = await seedRestartMcp("ultrawork")
  defaults.child.kill("SIGKILL")
  await defaults.done
  // The upstream writer accepts JSONC. Exercise both comments and a real root
  // trailing comma while preserving the complete API-returned test config.
  writeFileSync(path.join(home, ".config", "ultrawork", "opencode.json"),
    "// Native restart fixture: preserve user values and replace stale managed context\n" +
    JSON.stringify(restartConfig, null, 2).replace(/\n}$/, ",\n}\n"))
  await assertHealthy("mywork")
  pass("crashing the default native host leaves all MyWork services healthy")
  const restarted = launch(options["--default-app"], "ultrawork")
  const nextDefault = await ready(restarted)
  assert.notEqual(nextDefault.instanceId, defaultRegistry.instanceId)
  await assertHealthy("mywork")
  pass("default host restarts after a crash, reclaims owned residual services, and preserves the other brand")
  await verifyRestartMcp("ultrawork")
  assert(!restarted.log.includes("failed to normalize managed context") && !restarted.log.includes("failed to strip persisted ports"),
    "Native restart must not hide a managed config migration failure")
  pass("JSONC global config survives native restart; user fields stay intact and Knowledge/delegate MCP reconnect with fresh context")
  await stop(restarted)
  await assertHealthy("mywork")
  pass("clean default-host shutdown preserves all MyWork services")
  await stop(brand)
  for (const registry of [brandRegistry, nextDefault]) for (const role of Object.keys(health) as Role[]) {
    assert(!alive(registry[role].pid), `Owned ${role} process survived its native host shutdown`)
  }
  pass("clean native shutdown removes both brands' own sidecars")
  succeeded = true
} finally {
  await Promise.allSettled(hosts.map(stop))
  // Host cleanup owns normal services. On test failure, only this run's recorded
  // child pid is considered, and its OS parent must still be one of our hosts.
  for (const ns of ["mywork", "ultrawork"]) {
    if (!existsSync(registryFile(ns))) continue
    const registry = readRegistry(ns)
    if (!hosts.some((host) => host.child.pid === registry.owner?.pid)) continue
    for (const role of Object.keys(health) as Role[]) {
      const item = registry[role]
      if (!item?.pid || !alive(item.pid)) continue
      const query = (field: string) => {
        const result = spawnSync("ps", ["-p", String(item.pid), "-o", field], { encoding: "utf8", env: { ...process.env, LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" } })
        return result.status === 0 ? result.stdout.trim() : null
      }
      const identity = item.identity
      // Recheck the complete OS identity; a reused pid or matching basename is
      // insufficient. The original parent must be one of this test's hosts.
      if (identity?.pid === item.pid && identity.parentPid === registry.owner.pid &&
          query("comm=") === identity.executable && query("lstart=") === identity.startedAt) {
        process.kill(item.pid, "SIGTERM")
      }
    }
  }
  for (const [i, host] of hosts.entries()) writeFileSync(path.join(root, `host-${i}-${host.ns}.log`), host.log)
  const report = { schemaVersion: 1, succeeded, root, home, locale: "C", checks, hosts: hosts.map((host) => ({ ns: host.ns, app: host.app, pid: host.child.pid, exited: host.exited })) }
  if (options["--output"]) { mkdirSync(path.dirname(options["--output"]), { recursive: true }); writeFileSync(options["--output"], JSON.stringify(report, null, 2) + "\n") }
  console.log(JSON.stringify(report, null, 2))
}
