#!/usr/bin/env bun
/**
 * Anonymous free-model diagnostic through each binary's native CLI, with no real user data.
 *
 *   bun run --bun scripts/verify-free-zen.ts
 *   bun run --bun scripts/verify-free-zen.ts --sidecar <packaged-binary> --official <official-binary>
 *   bun run --bun scripts/verify-free-zen.ts --model big-pickle --model mimo-v2.6-flash-free
 *
 * A promptly reported free restriction is a handled failure, NOT proof of free availability.
 * Exit 0 means each run either answered or terminated with a structured free-limit error;
 * timeouts, launch failures and unrelated errors exit 1. Live network is required, not CI.
 * Official v2 uses --standalone so its managed background service is never started.
 */
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

function nativeBinary(): string {
  const { platform, arch } = process
  if (arch !== "arm64" && arch !== "x64") throw new Error(`Unsupported architecture: ${arch}`)
  const cpu = arch === "arm64" ? "aarch64" : "x86_64"
  const target = platform === "darwin" ? `${cpu}-apple-darwin`
    : platform === "linux" ? `${cpu}-unknown-linux-gnu`
      : platform === "win32" && arch === "x64" ? "x86_64-pc-windows-msvc" : undefined
  if (!target) throw new Error(`Unsupported platform: ${platform}/${arch}; provide --sidecar explicitly`)
  return join(import.meta.dir, "..", "packages", "client", "desktop", "src-tauri", "binaries",
    `opencode-server-${target}${platform === "win32" ? ".exe" : ""}`)
}

const args = process.argv.slice(2)
if (args.includes("--help")) {
  console.log("Usage: bun run --bun scripts/verify-free-zen.ts [--sidecar path] [--official path] [--model id ...]")
  process.exit(0)
}
let sidecar: string | undefined
let official: string | undefined
const models: string[] = []
for (let i = 0; i < args.length; i++) {
  const flag = args[i]
  const value = args[++i]
  if (!["--sidecar", "--official", "--model"].includes(flag) || !value || value.startsWith("--")) {
    throw new Error(`Expected --sidecar/--official path or --model id; received ${flag}`)
  }
  if (flag === "--sidecar") sidecar = resolve(value)
  if (flag === "--official") official = resolve(value)
  if (flag === "--model") {
    const id = value.replace(/^opencode\//, "")
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error(`Invalid model ID: ${value}`)
    models.push(id)
  }
}
if (!models.length) models.push("big-pickle")
const binaries = [{ label: "sidecar", binary: sidecar ?? nativeBinary() }]
if (official) binaries.push({ label: "official", binary: official })
const root = realpathSync(mkdtempSync(join(tmpdir(), "uw-free-zen-")))
console.log(`Isolated diagnostic files: ${root}`)
let interrupted = false
let stopCurrent: (() => void) | undefined
function interrupt() { interrupted = true; stopCurrent?.() }
process.on("SIGINT", interrupt)
process.on("SIGTERM", interrupt)

/** Preserve transport/runtime necessities, never model keys, app context, or user config. */
function environment(directory: string, model: string): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path", "pathext", "systemroot", "windir", "comspec", "systemdrive", "lang", "lc_all", "tz",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir", "node_extra_ca_certs",
  ])
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())))
  const home = join(directory, "home")
  const temporary = join(directory, "tmp")
  mkdirSync(home, { recursive: true })
  mkdirSync(temporary, { recursive: true })
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    OPENCODE_TEST_HOME: home,
    OPENCODE_TEST_MANAGED_CONFIG_DIR: join(directory, "managed-config"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "state"),
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: `opencode/${model}`, small_model: `opencode/${model}`, permission: "deny", share: "disabled",
    }),
  }
}

interface ProcessResult {
  code: number | null
  timedOut: boolean
  elapsedMs: number
  stdout: string
  stderr: string
  launchError?: string
}

function run(binary: string, argv: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((done) => {
    const started = Date.now()
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let launchError: string | undefined
    let force: ReturnType<typeof setTimeout> | undefined
    const child = spawn(binary, argv, {
      cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      // On Unix this group contains only our diagnostic process and its private workers.
      detached: process.platform !== "win32",
    })
    child.stdout.on("data", (data) => { stdout = (stdout + data.toString()).slice(-2_000_000) })
    child.stderr.on("data", (data) => { stderr = (stderr + data.toString()).slice(-2_000_000) })
    function stop(signal: "SIGTERM" | "SIGKILL") {
      if (!child.pid) return
      try {
        if (process.platform === "win32") {
          // Only the live PID returned by our spawn, including its private worker tree.
          if (child.exitCode !== null || child.signalCode !== null) return
          const cleanup = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            windowsHide: true, stdio: "ignore", timeout: 3000,
          })
          if (cleanup.status !== 0) child.kill(signal)
        } else process.kill(-child.pid, signal)
      } catch { /* Already exited; never discover or kill a process by its port. */ }
    }
    const cancel = () => {
      stop("SIGTERM")
      force = setTimeout(() => stop("SIGKILL"), 1500)
    }
    stopCurrent = cancel
    const timer = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
    child.once("error", (error) => { launchError = error.message })
    child.once("close", (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      if (stopCurrent === cancel) stopCurrent = undefined
      if (process.platform !== "win32") stop("SIGTERM")
      done({ code, timedOut, elapsedMs: Date.now() - started, stdout, stderr, ...(launchError ? { launchError } : {}) })
    })
  })
}

function jsonEvents(stdout: string): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = []
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line)
      if (event && typeof event === "object" && !Array.isArray(event)) events.push(event)
    } catch { /* Native CLI banners/migration progress are retained in stdout.log. */ }
  }
  return events
}

const results: Array<Record<string, unknown>> = []
for (const { label, binary } of binaries) {
  for (const model of [...new Set(models)]) {
    if (interrupted) break
    const directory = join(root, `${label}-${model}`)
    const cwd = join(directory, "workspace")
    mkdirSync(cwd, { recursive: true })
    const env = environment(directory, model)
    const versionResult = await run(binary, ["--version"], env, cwd, 10_000)
    const version = versionResult.stdout.trim()
    let result: Record<string, unknown>
    if (versionResult.code !== 0 || versionResult.timedOut || !version) {
      result = { label, binary, model, outcome: "launch-error", ...versionResult }
    } else {
      const v2 = /(?:^|\bv)2\./.test(version)
      const argv = ["--print-logs", "run", ...(v2 ? ["--standalone"] : []), "--format", "json", "--model", `opencode/${model}`, "Reply OK."]
      const execution = await run(binary, argv, env, cwd, 40_000)
      writeFileSync(join(directory, "stdout.log"), execution.stdout)
      writeFileSync(join(directory, "stderr.log"), execution.stderr)
      const events = jsonEvents(execution.stdout)
      const errors = events.filter((event) => event.type === "error").map((event) => event.error)
      const error = errors.at(-1)
      const reply = events.filter((event) => event.type === "text")
        .map((event) => event.part?.text ?? event.text ?? "").join("\n").trim()
      const freeLimit = error && /FreeUsageLimitError|FreeTierError|provider\.free-limit/i.test(JSON.stringify(error))
      const outcome = execution.launchError ? "launch-error" : execution.timedOut ? "timeout"
        : freeLimit ? "free-limit" : error ? "error" : execution.code === 0 && reply ? "reply" : "error"
      result = {
        label, binary, version, model, outcome, elapsedMs: execution.elapsedMs, exitCode: execution.code,
        ...(reply ? { reply } : {}), ...(error ? { error } : {}),
        ...(execution.launchError ? { launchError: execution.launchError } : {}), logs: directory,
      }
    }
    results.push(result)
    console.log(JSON.stringify(result))
    writeFileSync(join(root, "report.json"), JSON.stringify(results, null, 2))
  }
}
console.log("A free-limit result verifies prompt termination only; it does not mean free access is available.")
process.off("SIGINT", interrupt)
process.off("SIGTERM", interrupt)
process.exitCode = !interrupted && results.every((result) => result.outcome === "reply" || result.outcome === "free-limit") ? 0 : 1
