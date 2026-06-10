// One ACP agent connection: child process + JSON-RPC stdio + session registry.
//
// Carried over from the feat/acp-support design (rewritten, ADR-027 B2):
// - Fix 1: process exit observer rejects all pending requests and surfaces
//   session.error to subscribers (no hung promises).
// - Fix 2: session/update notifications are serialized through a promise chain
//   so shaping sees them in arrival order.
// - Fix 3: every outbound request is tracked and batch-rejected on exit.

import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type {
  AgentCapabilities,
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
import { TurnShaper } from "./turn-shaper.js"

// Generous: a bunx-launched adapter may download its package on first run.
const INITIALIZE_TIMEOUT_MS = 30_000
// Claude is known to stall on session/new (acpx quirk constant, W5).
const SESSION_NEW_TIMEOUT_MS = 60_000

interface PendingRequest {
  reject: (err: Error) => void
}

export type SessionEventCallback = (sessionId: string, event: UwSSEEvent) => void

export class ACPConnection {
  status: ACPAgentStatus = "disconnected"
  error: string | undefined
  protocolVersion: number | undefined
  agentCapabilities: AgentCapabilities | undefined

  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined
  private connection: ClientSideConnection | undefined
  private shapers = new Map<string, TurnShaper>()
  private activePrompts = new Set<string>()
  private pendingRequests = new Set<PendingRequest>()
  private updateChain: Promise<void> = Promise.resolve()
  private closing = false

  constructor(
    readonly config: ACPAgentConfig,
    private readonly onEvent: SessionEventCallback,
  ) {}

  async connect(): Promise<void> {
    if (this.status === "connected" || this.status === "connecting") return
    this.status = "connecting"
    this.error = undefined
    this.closing = false

    try {
      const proc = Bun.spawn([this.config.command, ...this.config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...this.config.env },
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

  async newSession(cwd: string): Promise<string> {
    const conn = this.requireConnection()
    const res = await this.runRequest(
      () => conn.newSession({ cwd, mcpServers: [] }),
      SESSION_NEW_TIMEOUT_MS,
      "session/new",
    )
    const sessionId = res.sessionId
    this.shapers.set(
      sessionId,
      new TurnShaper(sessionId, this.config.id, (event) => this.onEvent(sessionId, event)),
    )
    return sessionId
  }

  hasSession(sessionId: string): boolean {
    return this.shapers.has(sessionId)
  }

  async prompt(sessionId: string, text: string): Promise<StopReason> {
    const conn = this.requireConnection()
    const shaper = this.shapers.get(sessionId)
    if (!shaper) throw new Error(`Unknown session: ${sessionId}`)

    shaper.startTurn()
    this.activePrompts.add(sessionId)
    try {
      const res = await this.runRequest(() =>
        conn.prompt({ sessionId, prompt: [{ type: "text", text }] }),
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
    await conn.cancel({ sessionId })
  }

  disconnect(): void {
    this.closing = true
    this.rejectPending(new Error("Agent disconnected"))
    this.killProcess()
    this.shapers.clear()
    this.status = "disconnected"
  }

  // --- internals ---

  private createClient() {
    return {
      sessionUpdate: (params: SessionNotification): Promise<void> => {
        // Fix 2: keep arrival order.
        this.updateChain = this.updateChain.then(() => {
          const shaper = this.shapers.get(params.sessionId)
          shaper?.handleUpdate(params.update)
        })
        return this.updateChain
      },
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        // TODO(W3): suspend + permission.asked SSE + reply endpoint (deny by
        // default on timeout). Spike: auto-approve so the turn can complete.
        const allow =
          params.options.find((o) => o.kind === "allow_once") ??
          params.options.find((o) => o.kind === "allow_always") ??
          params.options[0]
        console.error(
          `[acp:${this.config.id}] auto-approving permission (spike): ${params.toolCall.title ?? params.toolCall.toolCallId}`,
        )
        if (!allow) return { outcome: { outcome: "cancelled" } }
        return { outcome: { outcome: "selected", optionId: allow.optionId } }
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
        this.rejectPending(new Error(this.error))
        for (const sessionId of this.activePrompts) {
          this.onEvent(sessionId, {
            type: "session.error",
            properties: { sessionID: sessionId, error: this.error },
          })
        }
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

  private killProcess(): void {
    // TODO(W5): three-phase graceful shutdown (stdin.end grace → SIGTERM →
    // SIGKILL → detach) ported from acpx. Spike: plain SIGTERM.
    try {
      this.proc?.kill()
    } catch {
      // already dead
    }
    this.proc = undefined
    this.connection = undefined
  }
}
