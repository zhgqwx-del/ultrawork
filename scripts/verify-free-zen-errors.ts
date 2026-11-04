#!/usr/bin/env bun
/**
 * Offline black-box verification of the compiled OpenCode sidecar's free-model
 * error path: real REST prompt -> real SDK/processor -> SSE error and idle.
 * No external model service, real credentials, application data, or fixed port.
 *
 *   bun run --bun scripts/verify-free-zen-errors.ts [--sidecar <binary>] [--keep]
 *
 * Defaults to this platform's already-built sidecar. --keep retains disposable
 * configuration and drained sidecar logs for inspection. This does not rebuild.
 */
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

type Event = { type: string; properties: Record<string, unknown> }
const cases = [
  { id: "quota", status: 429, type: "FreeUsageLimitError", message: "Free usage limit reached.", calls: 1, retries: [] },
  { id: "tier", status: 403, type: "FreeTierError", message: "Free models require OpenCode.", calls: 1, retries: [] },
  { id: "unavailable", status: 400, type: "server_error", message: "Upstream request failed: Model is unavailable.", calls: 1, retries: [] },
  { id: "busy", status: 503, type: "server_error", message: "Provider temporarily busy.", calls: 3, retries: [1, 2] },
]
const args = process.argv.slice(2)
let binary: string | undefined
let keep = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--keep") { keep = true; continue }
  if (args[index] === "--sidecar") {
    const value = args[++index]
    assert(value && !value.startsWith("--"), "--sidecar requires a binary path")
    binary = resolve(value)
    continue
  }
  throw new Error(`Unknown argument: ${args[index]}`)
}

function target() {
  if (process.platform === "darwin" && ["arm64", "x64"].includes(process.arch))
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
  if (process.platform === "win32" && process.arch === "x64") return "x86_64-pc-windows-msvc.exe"
  if (process.platform === "linux" && ["arm64", "x64"].includes(process.arch))
    return `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`
  throw new Error(`Pass --sidecar for unsupported native target ${process.platform}/${process.arch}`)
}

binary ??= join(import.meta.dir, "..", "packages", "client", "desktop", "src-tauri", "binaries", `opencode-server-${target()}`)
assert(existsSync(binary), `Build the native sidecar first, or pass --sidecar: ${binary}`)
const root = realpathSync(mkdtempSync(join(tmpdir(), "uw-free-errors-")))
const home = join(root, "home")
const workspace = join(root, "workspace 中文")
const temporary = join(root, "tmp")
for (const dir of [home, workspace, temporary]) mkdirSync(dir)
const password = randomBytes(32).toString("hex")
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
const events: Event[] = []
const calls = new Map<string, number>()
const violations: string[] = []
const controller = new AbortController()
let child: ChildProcess | undefined
let done = Promise.resolve()
let exited = false
let log = ""
let pump = Promise.resolve()
let streamError: unknown
let interrupted = false
let success = false
let base = ""
const onSignal = () => { interrupted = true; controller.abort() }
process.on("SIGINT", onSignal)
process.on("SIGTERM", onSignal)

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function check() {
  assert(!interrupted, "Verification interrupted")
  assert(!exited, `Owned sidecar exited unexpectedly:\n${log.slice(-4000)}`)
  assert(!streamError, `Sidecar SSE disconnected: ${String(streamError)}`)
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    check()
    if (await predicate()) return
    await Bun.sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}\n${log.slice(-4000)}`)
}

async function request(route: string, method = "GET", body?: unknown): Promise<unknown> {
  check()
  const response = await fetch(`${base}${route}`, {
    method,
    headers: { Authorization: authorization, "x-opencode-directory": encodeURIComponent(workspace), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${route}: HTTP ${response.status} ${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}

const fixture = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    try {
      assert.equal(new URL(request.url).pathname, "/v1/chat/completions", "Unexpected model API route")
      const body = object(await request.json())
      const item = cases.find((entry) => entry.id === body.model)
      assert(item, `Unexpected model ${String(body.model)}`)
      assert(Array.isArray(body.messages), "Missing real model message history")
      assert(JSON.stringify(body.messages).includes(`free-error-diagnostic:${item.id}`), "Unexpected auxiliary/model request")
      calls.set(item.id, (calls.get(item.id) ?? 0) + 1)
      return Response.json({ error: { type: item.type, message: item.message } }, {
        status: item.status,
        headers: item.id === "quota" ? { "retry-after": "69553" } : {},
      })
    } catch (error) {
      violations.push(String(error))
      return Response.json({ error: { message: String(error) } }, { status: 400 })
    }
  },
})
// Reserve an OS-selected port; release immediately before this owned process
// binds. A race is a failed probe, never permission to stop another listener.
const reservation = createServer()

try {
  await new Promise<void>((yes, no) => { reservation.once("error", no); reservation.listen(0, "127.0.0.1", yes) })
  const address = reservation.address()
  assert(address && typeof address !== "string")
  base = `http://127.0.0.1:${address.port}`
  const models = Object.fromEntries(cases.map((item) => [item.id, {
    id: item.id, name: item.id, release_date: "2026-01-01", attachment: false,
    reasoning: false, temperature: false, tool_call: true, options: {},
    cost: { input: 0, output: 0 }, limit: { context: 32768, output: 128 },
    modalities: { input: ["text"], output: ["text"] },
  }]))
  const snapshot = join(root, "models.json")
  const api = `http://127.0.0.1:${fixture.port}/v1`
  writeFileSync(snapshot, JSON.stringify({ opencode: {
    id: "opencode", name: "Offline Zen fixture", env: [], npm: "@ai-sdk/openai-compatible", api, models,
  } }))
  const config = {
    model: "opencode/quota", small_model: "opencode/quota", share: "disabled", autoupdate: false,
    plugin: [], enabled_providers: ["opencode"], permission: { "*": "deny" },
    agent: { title: { disable: true }, summary: { disable: true } },
    provider: { opencode: { options: { baseURL: api, apiKey: "offline-fixture" }, whitelist: cases.map((item) => item.id) } },
  }
  // Whitelist OS essentials rather than inheriting provider keys, app/brand
  // context, proxies, caller config paths, or a delegated build lock.
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "windir", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]) {
    if (process.env[key]) env[key] = process.env[key]
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
    OPENCODE_TEST_HOME: home, OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
    OPENCODE_APP_NAME: "ultrawork", OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_MODELS_PATH: snapshot, OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CHANNEL_DB: "1",
  })
  await new Promise<void>((yes) => reservation.close(() => yes()))
  child = spawn(binary, ["--print-logs", "serve", "--hostname", "127.0.0.1", "--port", String(address.port)], {
    cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  done = new Promise<void>((yes) => {
    child!.once("error", (error) => { log += String(error); exited = true })
    child!.once("close", () => { exited = true; yes() })
  })
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => { log = (log + chunk.toString()).slice(-65_536) })
  await until(async () => {
    try { return object(await request("/global/health")).healthy === true } catch { return false }
  }, "sidecar health", 30_000)
  const catalog = object(await request("/provider"))
  assert(Array.isArray(catalog.connected) && catalog.connected.includes("opencode"), "Offline opencode provider did not connect")
  const provider = Array.isArray(catalog.all) ? catalog.all.map(object).find((entry) => entry.id === "opencode") : undefined
  assert(provider, "Missing offline opencode model catalog")
  for (const item of cases) {
    const model = object(object(provider.models)[item.id])
    assert.equal(object(model.cost).input, 0)
    assert.equal(object(model.cost).output, 0)
    assert.equal(object(model.api).npm, "@ai-sdk/openai-compatible")
    assert.equal(object(model.api).url, api)
  }

  const response = await fetch(`${base}/event`, { headers: { Authorization: authorization }, signal: controller.signal })
  assert(response.ok && response.body, "Failed to open the real sidecar SSE stream")
  const reader = response.body.getReader()
  pump = (async () => {
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const result = await reader.read()
        if (result.done) { if (!controller.signal.aborted) throw new Error("Unexpected SSE end"); break }
        buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, "\n")
        let boundary: number
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n")
          if (!data) continue
          const event = object(JSON.parse(data))
          assert.equal(typeof event.type, "string", "Malformed SSE event")
          events.push({ type: event.type as string, properties: object(event.properties) })
        }
      }
    } catch (error) { if (!controller.signal.aborted) streamError = error }
    finally { reader.releaseLock() }
  })()

  for (const item of cases) {
    const session = object(await request("/session", "POST", { title: `Free error diagnostic ${item.id}` }))
    assert.equal(typeof session.id, "string")
    const id = session.id as string
    const start = events.length
    const began = Date.now()
    await request(`/session/${id}/prompt_async`, "POST", {
      model: { providerID: "opencode", modelID: item.id },
      parts: [{ type: "text", text: `free-error-diagnostic:${item.id}` }],
    })
    const observed = () => events.slice(start).filter((event) =>
      (event.properties.sessionID ?? object(event.properties.info).sessionID ?? object(event.properties.part).sessionID) === id)
    await until(() => {
      const entries = observed()
      const error = entries.findIndex((event) => event.type === "session.error")
      return error >= 0 && entries.slice(error + 1).some((event) => event.type === "session.status" && object(event.properties.status).type === "idle")
    }, `${item.id} error followed by idle`)
    await until(async () => {
      const messages = await request(`/session/${id}/message`)
      assert(Array.isArray(messages), "Missing persisted messages")
      return messages.map(object).some((message) => {
        const info = object(message.info)
        return info.role === "assistant" && info.error && typeof object(info.time).completed === "number"
      })
    }, `${item.id} persisted terminal assistant message`)
    const entries = observed()
    const idle = entries.findIndex((event) => event.type === "session.status" && object(event.properties.status).type === "idle")
    const terminal = entries.findIndex((event) => {
      const info = object(event.properties.info)
      return event.type === "message.updated" && info.role === "assistant" && info.error && typeof object(info.time).completed === "number"
    })
    assert(terminal >= 0 && terminal < idle, `${item.id}: idle advertised availability before the failed assistant was persisted`)
    assert.equal(entries.filter((event) => event.type === "session.status" && object(event.properties.status).type === "idle").length, 1,
      `${item.id}: only the owning Runner may publish final idle`)
    const errors = entries.filter((event) => event.type === "session.error")
    assert.equal(errors.length, 1, `${item.id}: expected one terminal error`)
    const error = object(errors[0].properties.error)
    const data = object(error.data)
    assert.equal(error.name, "APIError")
    assert.equal(data.statusCode, item.status)
    assert.equal(object(object(JSON.parse(String(data.responseBody))).error).type, item.type)
    if (item.id === "quota") assert.equal(object(data.responseHeaders)["retry-after"], "69553")
    assert.equal(calls.get(item.id), item.calls, `${item.id}: incorrect real model request count`)
    const retries = entries.filter((event) => event.type === "session.status")
      .map((event) => object(event.properties.status)).filter((status) => status.type === "retry").map((status) => status.attempt)
    assert.deepEqual(retries, item.retries, `${item.id}: incorrect retry status sequence`)
    assert(entries.some((event) => event.type === "session.status" && object(event.properties.status).type === "busy"), "The real prompt never entered busy state")
    assert.deepEqual(violations, [], "Unexpected fixture traffic")
    console.log(`PASS ${item.id}: HTTP ${item.status}, model requests=${item.calls}, retries=${JSON.stringify(retries)}, error+idle+persisted terminal (${Date.now() - began}ms)`)
  }
  assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), cases.reduce((sum, item) => sum + item.calls, 0))
  success = true
  console.log("PASS compiled sidecar free-model failure contracts (offline)")
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  console.error(log.slice(-5000))
} finally {
  controller.abort()
  await Promise.race([pump, Bun.sleep(1000)])
  if (child && !exited) {
    child.kill("SIGTERM")
    await Promise.race([done, Bun.sleep(3000)])
    if (!exited) { child.kill("SIGKILL"); await done }
  }
  if (reservation.listening) await new Promise<void>((yes) => reservation.close(() => yes()))
  fixture.stop(true)
  process.off("SIGINT", onSignal)
  process.off("SIGTERM", onSignal)
  if (keep) {
    writeFileSync(join(root, "sidecar.log"), log)
    writeFileSync(join(root, "events.json"), JSON.stringify(events, null, 2))
    console.log(`Evidence retained: ${root}`)
  } else rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
process.exitCode = success ? 0 : 1
