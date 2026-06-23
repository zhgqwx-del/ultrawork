// One ACP agent connection: child process + JSON-RPC stdio + session registry.
//
// Carried over from the feat/acp-support design (rewritten, ADR-027 B2):
// - Fix 1: process exit observer rejects all pending requests and surfaces
//   session.error to subscribers (no hung promises).
// - Fix 2: session/update notifications are serialized through a promise chain
//   so shaping sees them in arrival order.
// - Fix 3: every outbound request is tracked and batch-rejected on exit.

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type {
  AgentCapabilities,
  McpServer,
  PermissionOption,
  SessionConfigOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  StopReason,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk"
import type { ACPAgentConfig, ACPAgentStatus, UwSSEEvent } from "./types.js"
import { configFile } from "./config-paths.js"
import { permissionPattern, resolvePermission } from "./permission-label.js"
import { TurnShaper } from "./turn-shaper.js"

// Generous: a bunx-launched adapter may download its package on first run.
const INITIALIZE_TIMEOUT_MS = 30_000
// Claude is known to stall on session/new (acpx quirk constant, W5).
const SESSION_NEW_TIMEOUT_MS = 60_000
// session/load gets the same stall defense as session/new.
const SESSION_LOAD_TIMEOUT_MS = 60_000
// Replay suppression after session/load (acpx constants, ADR-027 W4): replayed
// session/update notifications are dropped until the stream stays quiet for
// REPLAY_IDLE_MS, bounded by REPLAY_MAX_MS after the RPC resolves.
const REPLAY_IDLE_MS = 80
const REPLAY_MAX_MS = 5_000
// Unanswered permission requests deny by default (safety default, W3).
// Read lazily so tests can shrink it via env after module load.
const permissionTimeoutMs = () => Number(process.env.ACP_PERMISSION_TIMEOUT_MS ?? 300_000)
// Three-phase shutdown grace periods (acpx constants, W5).
const STDIN_GRACE_MS = 100
const SIGTERM_GRACE_MS = 1500
const SIGKILL_GRACE_MS = 1000
// Blocking delegate MCP calls run a whole child turn — keep the agent's MCP
// tool timeout above the orchestrator's default per-turn timeout (10 min).
const DELEGATE_MCP_TOOL_TIMEOUT_MS = 1_800_000

// GUI-launched processes (the packaged Tauri app) inherit a minimal PATH that
// misses the user bin dirs where agent CLIs live (e.g. qodercli in
// ~/.local/bin). Appended only — explicit PATH entries keep priority.
const EXTRA_PATH_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  "/usr/local/bin",
  "/opt/homebrew/bin",
]

function augmentPath(path: string | undefined): string {
  const parts = path ? path.split(delimiter) : []
  for (const dir of EXTRA_PATH_DIRS) {
    if (!parts.includes(dir)) parts.push(dir)
  }
  return parts.join(delimiter)
}

/**
 * Whether the agent honors `_meta.systemPrompt` on session/new+load.
 * claude-agent-acp ≥0.44 does (object form = preset append, acp-agent.js
 * createSession); other adapters are assumed not to until the explicit
 * config flag says otherwise — their sessions fall back to prefixing the
 * system prompt onto the first prompt (ACPManager.prompt).
 */
export function supportsMetaSystemPrompt(
  config: Pick<ACPAgentConfig, "command" | "args" | "metaSystemPrompt">,
): boolean {
  if (config.metaSystemPrompt !== undefined) return config.metaSystemPrompt
  return [config.command, ...config.args].some((t) => t.includes("claude-agent-acp"))
}

/**
 * Command for the delegate MCP shim: this sidecar always runs as a compiled
 * binary in real deployments (Tauri spawns it even in dev), so
 * `process.execPath` IS the shim. When someone runs `bun src/index.ts`
 * manually, execPath is bun itself — fall back to the stable user-data copy.
 */
export function delegateShimCommand(execPath = process.execPath): string | undefined {
  const base = execPath.split("/").pop() ?? ""
  if (!base.startsWith("bun")) return execPath
  const copy = join(homedir(), ".ultrawork", "sidecars", "acp-client")
  return existsSync(copy) ? copy : undefined
}

// --- gemini quirks (live-tested 2026-06-11, @google/gemini-cli via bunx) ---
// 1. ACP mode + interactive shell (node-pty, default on) hangs every shell
//    tool call forever — no error, no timeout, regardless of runtime or
//    folder trust. Disable it via a managed settings file delivered through
//    GEMINI_CLI_SYSTEM_SETTINGS_PATH (no env/flag exists for the setting).
// 2. Untrusted folders abort headless tool execution; Ultrawork's own
//    permission loop is the actual gate, so trust the workspace.
// 3. The npm wrapper relaunches itself via process.execPath (lands on bun
//    under bunx, adds a process layer that the three-phase shutdown can't
//    see) — keep it single-process.
// Defaults only: an explicit value in the agent's env always wins.
const GEMINI_MANAGED_SETTINGS_PATH = configFile("gemini-acp-settings.json")
const GEMINI_MANAGED_SETTINGS = { tools: { shell: { enableInteractiveShell: false } } }

export function applyGeminiQuirks(
  config: Pick<ACPAgentConfig, "command" | "args" | "env">,
  env: Record<string, string | undefined>,
  settingsPath = GEMINI_MANAGED_SETTINGS_PATH,
): void {
  const tokens = [config.command, ...config.args]
  const isGemini = tokens.some((t) => t.includes("gemini-cli") || t === "gemini")
  if (!isGemini) return
  if (!config.env?.GEMINI_CLI_TRUST_WORKSPACE) env.GEMINI_CLI_TRUST_WORKSPACE = "true"
  if (!config.env?.GEMINI_CLI_NO_RELAUNCH) env.GEMINI_CLI_NO_RELAUNCH = "true"
  if (!config.env?.GEMINI_CLI_SYSTEM_SETTINGS_PATH) {
    try {
      if (!existsSync(settingsPath)) {
        mkdirSync(dirname(settingsPath), { recursive: true })
        writeFileSync(settingsPath, JSON.stringify(GEMINI_MANAGED_SETTINGS, null, 2) + "\n")
      }
      env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath
    } catch (err) {
      console.error(`[acp] failed to provision gemini settings at ${settingsPath}:`, err)
    }
  }
}

interface PendingRequest {
  reject: (err: Error) => void
}

interface PendingPermission {
  id: string
  emitSessionId: string
  options: PermissionOption[]
  resolve: (response: RequestPermissionResponse) => void
  timer: ReturnType<typeof setTimeout>
}

export type PermissionReply = "once" | "always" | "reject"

export type SessionEventCallback = (sessionId: string, event: UwSSEEvent) => void

export class ACPConnection {
  status: ACPAgentStatus = "disconnected"
  error: string | undefined
  protocolVersion: number | undefined
  agentCapabilities: AgentCapabilities | undefined

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private connection: ClientSideConnection | undefined
  private shapers = new Map<string, TurnShaper>()
  private emitIds = new Map<string, string>()
  /** Sessions whose session/load replay is being suppressed (W4b). */
  private replaying = new Map<string, { lastUpdateAt: number }>()
  private pendingPermissions = new Map<string, PendingPermission>()
  private permSeq = 0
  private activePrompts = new Set<string>()
  private pendingRequests = new Set<PendingRequest>()
  private updateChain: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    readonly config: ACPAgentConfig,
    private readonly onEvent: SessionEventCallback,
  ) {}

  /**
   * Spawn + initialize the agent. `cwd` becomes the child's working
   * directory (first caller wins for a shared connection): some agents
   * (qoder, live-tested) run their shell tool in the process cwd instead of
   * the session cwd, and the sidecar's own cwd is meaningless to users.
   */
  async connect(cwd?: string): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return
    this.status = "connecting"
    this.error = undefined
    this.closing = false

    try {
      const env: Record<string, string | undefined> = { ...process.env, ...this.config.env }
      env.PATH = augmentPath(env.PATH)
      applyGeminiQuirks(this.config, env)
      // Delegate MCP calls block for the whole child turn; Claude Code's MCP
      // tool timeout would kill them otherwise. The shim's progress
      // notifications are the primary keepalive — this is belt-and-suspenders
      // (explicit agent env always wins).
      if (!this.config.env?.MCP_TOOL_TIMEOUT) env.MCP_TOOL_TIMEOUT = String(DELEGATE_MCP_TOOL_TIMEOUT_MS)
      // Scrub Claude Code session markers inherited from a dev shell (e.g.
      // setup.sh run inside a Claude Code terminal): claude-code-acp refused
      // to start when CLAUDECODE is set (nested-session check; gone from
      // claude-agent-acp 0.44, kept as defense against the underlying SDK),
      // but agents we spawn are independent processes, not nested sessions.
      if (!this.config.env?.CLAUDECODE) delete env.CLAUDECODE
      if (!this.config.env?.CLAUDE_CODE_ENTRYPOINT) delete env.CLAUDE_CODE_ENTRYPOINT
      const proc = Bun.spawn([this.config.command, ...this.config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
        cwd: cwd && existsSync(cwd) ? cwd : undefined,
      })
      this.proc = proc
      this.watchProcessExit(proc)
      this.drainStderr(proc)

      const stdin = new WritableStream<Uint8Array>({
        write: (chunk) => {
          proc.stdin.write(chunk)
          proc.stdin.flush()
        },
        close: () => {
          proc.stdin.end()
        },
      })
      const stream = ndJsonStream(stdin, proc.stdout)
      this.connection = new ClientSideConnection(() => this.createClient(), stream)

      const init = await this.runRequest(
        () =>
          this.connection!.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientInfo: { name: "ultrawork", version: "0.1.0" },
            // Spike: no client fs / terminal surface exposed to the agent
            // (minimal exposure; sandboxed fs comes with W3/W5).
            clientCapabilities: {},
          }),
        INITIALIZE_TIMEOUT_MS,
        "initialize",
      )
      this.protocolVersion = init.protocolVersion
      this.agentCapabilities = init.agentCapabilities
      this.status = "connected"
    } catch (err) {
      this.status = "error"
      this.error = err instanceof Error ? err.message : String(err)
      this.killProcess()
      throw err
    }
  }

  /**
   * Create an ACP session. `emitSessionId` is the session id stamped on every
   * shaped event (the desktop passes its own session id here, so the frontend
   * consumes the stream with zero id rewriting); defaults to the ACP id.
   * `opts.orchestrate` injects the delegate MCP for THIS session only —
   * orchestrator children never set it (recursion guard, ADR-031 D-3).
   * `opts.systemPrompt` rides `_meta.systemPrompt` when the adapter supports
   * it (no-op otherwise — the manager prefixes the first prompt instead).
   */
  async newSession(
    cwd: string,
    emitSessionId?: string,
    opts?: { orchestrate?: boolean; systemPrompt?: string },
  ): Promise<string> {
    const conn = this.requireConnection()
    const res = await this.runRequest(
      () =>
        conn.newSession({
          cwd,
          mcpServers: this.hostMcpServers(cwd, opts?.orchestrate ?? false),
          ...this.sessionMeta(opts?.systemPrompt),
        }),
      SESSION_NEW_TIMEOUT_MS,
      "session/new",
    )
    const sessionId = res.sessionId
    const emitAs = emitSessionId ?? sessionId
    this.emitIds.set(sessionId, emitAs)
    this.shapers.set(
      sessionId,
      new TurnShaper(emitAs, this.config.id, (event) => this.onEvent(emitAs, event)),
    )
    await this.applyThoughtLevel(sessionId, res.configOptions)
    return sessionId
  }

  /**
   * Restore an existing agent-side session (W4b). The replayed history
   * (session/update notifications streamed during/around the RPC) is
   * suppressed — the sidecar already holds the shaped history on disk, so
   * re-emitting it would double-render on the client. Suppression ends when
   * the update stream stays quiet for REPLAY_IDLE_MS (bounded by
   * REPLAY_MAX_MS after the RPC resolves); only then is the shaper installed.
   */
  async loadSession(
    acpSessionId: string,
    cwd: string,
    emitSessionId?: string,
    opts?: { orchestrate?: boolean; systemPrompt?: string },
  ): Promise<void> {
    const conn = this.requireConnection()
    const emitAs = emitSessionId ?? acpSessionId
    this.emitIds.set(acpSessionId, emitAs)
    const replay = { lastUpdateAt: 0 }
    this.replaying.set(acpSessionId, replay)
    let configOptions: SessionConfigOption[] | null | undefined
    try {
      const res = await this.runRequest(
        () =>
          conn.loadSession({
            sessionId: acpSessionId,
            cwd,
            mcpServers: this.hostMcpServers(cwd, opts?.orchestrate ?? false),
            ...this.sessionMeta(opts?.systemPrompt),
          }),
        SESSION_LOAD_TIMEOUT_MS,
        "session/load",
      )
      configOptions = res.configOptions
      // The idle window starts at RPC completion: agents may keep streaming
      // replay notifications after responding, so always wait out at least
      // one quiet REPLAY_IDLE_MS before trusting the stream.
      replay.lastUpdateAt = Date.now()
      const deadline = Date.now() + REPLAY_MAX_MS
      while (Date.now() < deadline) {
        const sinceLast = Date.now() - replay.lastUpdateAt
        if (sinceLast >= REPLAY_IDLE_MS) break
        await Bun.sleep(REPLAY_IDLE_MS - sinceLast)
      }
    } catch (err) {
      // Load failed → the manager falls back to a fresh session with a NEW
      // acpSessionId, so drop the emitIds mapping set for this (now-dead) id;
      // otherwise it leaks until disconnect.
      this.emitIds.delete(acpSessionId)
      throw err
    } finally {
      this.replaying.delete(acpSessionId)
    }
    this.shapers.set(
      acpSessionId,
      new TurnShaper(emitAs, this.config.id, (event) => this.onEvent(emitAs, event)),
    )
    await this.applyThoughtLevel(acpSessionId, configOptions)
  }

  hasSession(sessionId: string): boolean {
    return this.shapers.has(sessionId)
  }

  /**
   * `opts.systemPrefix` (fallback system-prompt delivery for agents without
   * _meta.systemPrompt) goes only onto the wire — the shaped user echo keeps
   * the clean text so the UI never renders the instructions.
   */
  async prompt(sessionId: string, text: string, opts?: { systemPrefix?: string }): Promise<StopReason> {
    const conn = this.requireConnection()
    const shaper = this.shapers.get(sessionId)
    if (!shaper) throw new Error(`Unknown session: ${sessionId}`)

    const wireText = opts?.systemPrefix ? `${opts.systemPrefix}\n\n${text}` : text
    shaper.startTurn(text)
    this.activePrompts.add(sessionId)
    try {
      const res = await this.runRequest(() =>
        conn.prompt({ sessionId, prompt: [{ type: "text", text: wireText }] }),
      )
      // Flush queued session/update notifications before sealing the turn so
      // the finish event is the last thing subscribers see.
      await this.updateChain
      shaper.endTurn(res.stopReason, res.usage)
      return res.stopReason
    } catch (err) {
      await this.updateChain
      shaper.failTurn(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      this.activePrompts.delete(sessionId)
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const conn = this.requireConnection()
    // A cancelled turn must answer outstanding permission RPCs with
    // "cancelled" (ACP contract) before the agent reports its stop reason.
    this.cancelPermissionsFor(sessionId)
    await conn.cancel({ sessionId })
  }

  /** Resolve a suspended permission request. Returns false if unknown. */
  replyPermission(permissionId: string, reply: PermissionReply): boolean {
    return this.resolvePermission(permissionId, reply)
  }

  hasPendingPermission(permissionId: string): boolean {
    return this.pendingPermissions.has(permissionId)
  }

  async disconnect(): Promise<void> {
    this.closing = true
    this.cancelAllPermissions()
    this.rejectPending(new Error("Agent disconnected"))
    const proc = this.proc
    this.proc = undefined
    this.connection = undefined
    this.shapers.clear()
    this.emitIds.clear()
    this.replaying.clear()
    this.status = "disconnected"
    if (proc) await terminateProcess(proc)
  }

  // --- internals ---

  /**
   * `_meta.systemPrompt` for session/new+load. Object form keeps the agent's
   * own preset prompt and appends ours (claude-agent-acp ≥0.44 locks
   * type/preset, forwards `append`). Agents without support get nothing here —
   * the manager falls back to prefixing the first prompt.
   */
  private sessionMeta(systemPrompt: string | undefined): { _meta: Record<string, unknown> } | undefined {
    if (!systemPrompt || !supportsMetaSystemPrompt(this.config)) return undefined
    return { _meta: { systemPrompt: { append: systemPrompt } } }
  }

  /**
   * Host MCP servers forwarded into session/new and session/load.
   * - knowledge base (B4): per-agent opt-in, stable user-data binary (ADR-026).
   * - orchestrator delegate (ADR-031 ②): PER-SESSION opt-in — children spawned
   *   by the orchestrator never pass orchestrate, so they physically lack the
   *   tool (recursion guard). Command = this very sidecar binary with the
   *   delegate-mcp subcommand.
   */
  private hostMcpServers(cwd: string, orchestrate: boolean): McpServer[] {
    const servers: McpServer[] = []
    if (this.config.knowledgeMcp) {
      const sidecar = join(homedir(), ".ultrawork", "sidecars", "knowledge-sidecar")
      if (existsSync(sidecar)) {
        servers.push({ name: "knowledge-base", command: sidecar, args: ["mcp-stdio"], env: [] })
      } else {
        console.error(`[acp:${this.config.id}] knowledgeMcp enabled but ${sidecar} not found — skipping`)
      }
    }
    if (orchestrate) {
      const command = delegateShimCommand()
      if (command) {
        servers.push({
          name: "orchestrator",
          command,
          args: ["delegate-mcp"],
          env: [
            { name: "ACP_CLIENT_PORT", value: String(process.env.ACP_CLIENT_PORT ?? 4099) },
            // cwd fallback so the agent may omit `cwd` in delegate calls.
            { name: "ULTRAWORK_DELEGATE_CWD", value: cwd },
          ],
        })
      } else {
        console.error(`[acp:${this.config.id}] orchestrate requested but no shim binary found — skipping`)
      }
    }
    return servers
  }

  /**
   * Apply the configured thinking-effort level via session/set_config_option
   * when the agent advertises a thought_level select option (claude-agent-acp
   * ≥0.44, id "effort"; values depend on the current model). Best-effort:
   * missing option / unknown value / RPC failure logs and continues — effort
   * is a tuning knob, never a session blocker.
   */
  private async applyThoughtLevel(
    sessionId: string,
    configOptions: SessionConfigOption[] | null | undefined,
  ): Promise<void> {
    const desired = this.config.thoughtLevel
    if (!desired || desired === "default" || !this.connection) return
    const option = (configOptions ?? []).find(
      (o) => o.type === "select" && (o.category === "thought_level" || o.id === "effort"),
    )
    if (!option || option.type !== "select") return
    const values = option.options.flatMap((entry) =>
      "group" in entry ? entry.options.map((o) => o.value) : [entry.value],
    )
    if (!values.includes(desired)) {
      console.error(
        `[acp:${this.config.id}] thoughtLevel "${desired}" not offered by ${option.id} (${values.join(", ")}) — skipping`,
      )
      return
    }
    try {
      await this.connection.setSessionConfigOption({ sessionId, configId: option.id, value: desired })
      console.error(`[acp:${this.config.id}] session config applied: ${option.id}=${desired}`)
    } catch (err) {
      console.error(`[acp:${this.config.id}] failed to set ${option.id}=${desired}:`, err)
    }
  }

  private resolvePermission(permissionId: string, reply: PermissionReply): boolean {
    const pending = this.pendingPermissions.get(permissionId)
    if (!pending) return false
    this.pendingPermissions.delete(permissionId)
    clearTimeout(pending.timer)

    const pick = (...kinds: PermissionOption["kind"][]): PermissionOption | undefined => {
      for (const kind of kinds) {
        const opt = pending.options.find((o) => o.kind === kind)
        if (opt) return opt
      }
      return undefined
    }
    const option =
      reply === "once"
        ? pick("allow_once", "allow_always")
        : reply === "always"
          ? pick("allow_always", "allow_once")
          : pick("reject_once", "reject_always")

    pending.resolve(
      option
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : { outcome: { outcome: "cancelled" } },
    )
    this.onEvent(pending.emitSessionId, {
      type: "permission.replied",
      properties: { id: permissionId, sessionID: pending.emitSessionId },
    })
    return true
  }

  /** Answer outstanding permission RPCs of one session with "cancelled". */
  private cancelPermissionsFor(acpSessionId: string): void {
    const emitSessionId = this.emitIds.get(acpSessionId) ?? acpSessionId
    for (const pending of [...this.pendingPermissions.values()]) {
      if (pending.emitSessionId !== emitSessionId) continue
      this.pendingPermissions.delete(pending.id)
      clearTimeout(pending.timer)
      pending.resolve({ outcome: { outcome: "cancelled" } })
      this.onEvent(pending.emitSessionId, {
        type: "permission.replied",
        properties: { id: pending.id, sessionID: pending.emitSessionId },
      })
    }
  }

  private cancelAllPermissions(): void {
    for (const pending of [...this.pendingPermissions.values()]) {
      this.pendingPermissions.delete(pending.id)
      clearTimeout(pending.timer)
      pending.resolve({ outcome: { outcome: "cancelled" } })
      this.onEvent(pending.emitSessionId, {
        type: "permission.replied",
        properties: { id: pending.id, sessionID: pending.emitSessionId },
      })
    }
  }

  private createClient() {
    return {
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        // W4b: drop session/load replay (history is served from the store).
        const replay = this.replaying.get(params.sessionId)
        if (replay) {
          replay.lastUpdateAt = Date.now()
          return Promise.resolve()
        }
        // Fix 2: keep arrival order.
        this.updateChain = this.updateChain.then(() => {
          const shaper = this.shapers.get(params.sessionId)
          shaper?.handleUpdate(params.update)
        })
        return this.updateChain
      },
      // W3 permission loop: suspend the RPC, surface an opencode-shaped
      // permission.asked SSE, resolve via the reply endpoint. Unanswered
      // requests deny after PERMISSION_TIMEOUT_MS; cancel/exit deny too.
      requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
        const emitSessionId = this.emitIds.get(params.sessionId) ?? params.sessionId
        const id = `acp_perm_${emitSessionId}_${this.permSeq++}`
        // Drain queued tool_call frames first: the claude adapter omits kind
        // here, and the shaper lookup below needs the frame that carried it.
        await this.updateChain.catch(() => {})
        const shaperKind = this.shapers.get(params.sessionId)?.toolKind(params.toolCall.toolCallId)
        const permission = resolvePermission(params.toolCall, shaperKind)
        const pattern = permissionPattern(params.toolCall)

        return new Promise<RequestPermissionResponse>((resolve) => {
          const timer = setTimeout(() => this.resolvePermission(id, "reject"), permissionTimeoutMs())
          this.pendingPermissions.set(id, {
            id,
            emitSessionId,
            options: params.options,
            resolve,
            timer,
          })
          this.onEvent(emitSessionId, {
            type: "permission.asked",
            properties: {
              id,
              sessionID: emitSessionId,
              permission,
              patterns: pattern ? [pattern] : [],
              metadata: {},
              always: [],
            },
          })
        })
      },
      // fs capabilities are not advertised; reject defensively if called anyway.
      readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
        throw new Error("fs/read_text_file is not supported")
      },
      writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
        throw new Error("fs/write_text_file is not supported")
      },
    }
  }

  /** Fix 1 + Fix 3: reject in-flight work when the agent process dies. */
  private watchProcessExit(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
    proc.exited.then((code) => {
      if (this.proc !== proc) return
      const unexpected = !this.closing
      if (unexpected) {
        this.status = "error"
        this.error = `Agent process exited with code ${code}`
        this.cancelAllPermissions()
        // rejectPending rejects each in-flight prompt's RPC → prompt()'s catch
        // calls shaper.failTurn, which emits session.error AND seals the turn.
        // Don't also emit a raw session.error here or subscribers get it twice.
        this.rejectPending(new Error(this.error))
      }
    })
  }

  private drainStderr(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): void {
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr) {
        const text = decoder.decode(chunk).trimEnd()
        if (text) console.error(`[acp:${this.config.id}] ${text}`)
      }
    })().catch(() => {})
  }

  private async runRequest<T>(fn: () => Promise<T>, timeoutMs?: number, label?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const pending: PendingRequest = {
        reject: (err) => {
          if (!settled) {
            settled = true
            reject(err)
          }
        },
      }
      this.pendingRequests.add(pending)
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => pending.reject(new Error(`${label ?? "request"} timed out after ${timeoutMs}ms`)), timeoutMs)
          : undefined
      const finish = (cb: () => void) => {
        if (timer) clearTimeout(timer)
        this.pendingRequests.delete(pending)
        if (!settled) {
          settled = true
          cb()
        }
      }
      fn().then(
        (value) => finish(() => resolve(value)),
        (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err)))),
      )
    })
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests) pending.reject(error)
    this.pendingRequests.clear()
  }

  private requireConnection(): ClientSideConnection {
    if (!this.connection || this.status !== "connected") {
      throw new Error(`Agent ${this.config.id} is not connected (status: ${this.status})`)
    }
    return this.connection
  }

  /** Immediate kill for the connect-failure path (process likely broken). */
  private killProcess(): void {
    try {
      this.proc?.kill()
    } catch {
      // already dead
    }
    this.proc = undefined
    this.connection = undefined
  }
}

/**
 * Three-phase graceful shutdown (acpx constants, W5):
 * stdin.end() grace → SIGTERM → SIGKILL → detach (unref) so a wedged child
 * can never hang the sidecar.
 */
async function terminateProcess(proc: Bun.Subprocess<"pipe", "pipe", "pipe">): Promise<void> {
  const exited = (ms: number) =>
    Promise.race([proc.exited.then(() => true), Bun.sleep(ms).then(() => false)])

  try {
    proc.stdin.end()
  } catch {
    // stdin already closed
  }
  if (await exited(STDIN_GRACE_MS)) return

  try {
    proc.kill("SIGTERM")
  } catch {
    return
  }
  if (await exited(SIGTERM_GRACE_MS)) return

  try {
    proc.kill("SIGKILL")
  } catch {
    return
  }
  if (await exited(SIGKILL_GRACE_MS)) return
  proc.unref()
}
