import { spawn, type Subprocess } from "bun"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ReadTextFileRequest,
  type ReadTextFileResponse,
  type WriteTextFileRequest,
  type WriteTextFileResponse,
} from "@agentclientprotocol/sdk"
import type { ACPAgentConfig, ACPAgentStatus, ACPSSEEvent } from "./types"

export type SSEEventCallback = (event: ACPSSEEvent) => void

/**
 * Manages a single ACP agent subprocess connection.
 * Handles spawn → initialize → session/prompt lifecycle.
 */
export class ACPConnection {
  readonly agentId: string
  private config: ACPAgentConfig
  private process: Subprocess | null = null
  private connection: ClientSideConnection | null = null
  private _status: ACPAgentStatus = "disconnected"
  private _error: string | undefined
  private _protocolVersion: number | undefined
  private sseCallbacks: Map<string, SSEEventCallback> = new Map()

  constructor(config: ACPAgentConfig) {
    this.agentId = config.id
    this.config = config
  }

  get status(): ACPAgentStatus { return this._status }
  get error(): string | undefined { return this._error }
  get protocolVersion(): number | undefined { return this._protocolVersion }

  /** Subscribe to SSE events for a specific session */
  onSessionEvent(sessionId: string, cb: SSEEventCallback): void {
    this.sseCallbacks.set(sessionId, cb)
  }

  /** Unsubscribe from SSE events for a session */
  offSessionEvent(sessionId: string): void {
    this.sseCallbacks.delete(sessionId)
  }

  private emitSSE(sessionId: string, event: ACPSSEEvent): void {
    const cb = this.sseCallbacks.get(sessionId)
    if (cb) cb(event)
  }

  /**
   * Spawn the agent subprocess and perform ACP initialize handshake.
   */
  async connect(): Promise<void> {
    if (this._status === "connected" || this._status === "connecting") return

    this._status = "connecting"
    this._error = undefined

    try {
      // Spawn agent subprocess
      const env: Record<string, string> = { ...process.env as Record<string, string> }
      if (this.config.env) {
        Object.assign(env, this.config.env)
      }

      this.process = spawn([this.config.command, ...this.config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env,
      })

      // Drain stderr to log file
      this.drainStderr()

      // Create JSON-RPC stream over stdio
      const input = this.process.stdin as unknown as WritableStream<Uint8Array>
      const output = this.process.stdout as unknown as ReadableStream<Uint8Array>
      const stream = ndJsonStream(input, output)

      // Create client-side connection
      const self = this
      this.connection = new ClientSideConnection(
        (_agent) => self.createClient(),
        stream,
      )

      // Perform initialize handshake
      const initResult = await this.connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true,
          },
        },
      })

      this._protocolVersion = initResult.protocolVersion
      this._status = "connected"
      console.log(`[ACP] Agent "${this.agentId}" connected (protocol v${initResult.protocolVersion})`)
    } catch (err) {
      this._status = "error"
      this._error = err instanceof Error ? err.message : String(err)
      console.error(`[ACP] Failed to connect agent "${this.agentId}":`, this._error)
      this.cleanup()
      throw err
    }
  }

  /** Disconnect and kill the agent subprocess */
  async disconnect(): Promise<void> {
    this.cleanup()
    this._status = "disconnected"
    this._error = undefined
    console.log(`[ACP] Agent "${this.agentId}" disconnected`)
  }

  /** Create a new ACP session */
  async newSession(cwd: string): Promise<string> {
    this.ensureConnected()
    const result = await this.connection!.newSession({
      cwd,
      mcpServers: [],
    })
    return result.sessionId
  }

  /** Send a prompt to an ACP session */
  async prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    this.ensureConnected()
    const result = await this.connection!.prompt({
      sessionId,
      prompt: [{ type: "text", text }],
    })
    return { stopReason: result.stopReason }
  }

  /** Cancel an in-progress prompt */
  async cancel(sessionId: string): Promise<void> {
    this.ensureConnected()
    await this.connection!.cancel({ sessionId })
  }

  // --- Internal ---

  private createClient(): Client {
    const self = this
    return {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        self.handleSessionUpdate(params)
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // Auto-approve for now — Phase 3 will add proper permission UI
        const firstAllowOption = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always")
          ?? params.options[0]
        return {
          outcome: {
            outcome: "selected",
            optionId: firstAllowOption?.optionId ?? params.options[0]?.optionId ?? "",
          },
        }
      },
      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        try {
          const content = await Bun.file(params.path).text()
          return { content }
        } catch {
          return { content: "" }
        }
      },
      async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
        try {
          await Bun.write(params.path, params.content)
          return {}
        } catch {
          return {}
        }
      },
    }
  }

  /**
   * Convert ACP session/update notifications to Ultrawork SSE events.
   */
  private handleSessionUpdate(params: SessionNotification): void {
    const sessionId = params.sessionId
    const update = params.update

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.emitSSE(sessionId, {
            type: "message.part.delta",
            properties: {
              sessionID: sessionId,
              messageID: `acp-${sessionId}-msg`,
              partID: `acp-${sessionId}-part-text`,
              field: "text",
              delta: update.content.text,
            },
          })
        }
        break
      }
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.emitSSE(sessionId, {
            type: "message.part.delta",
            properties: {
              sessionID: sessionId,
              messageID: `acp-${sessionId}-msg`,
              partID: `acp-${sessionId}-part-reasoning`,
              field: "text",
              delta: update.content.text,
            },
          })
        }
        break
      }
      case "tool_call": {
        this.emitSSE(sessionId, {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              id: `acp-tool-${update.toolCallId}`,
              sessionID: sessionId,
              messageID: `acp-${sessionId}-msg`,
              tool: update.title ?? "tool",
              state: {
                status: update.status === "completed" ? "completed" : "running",
                input: {},
                title: update.title,
                output: "",
                metadata: {},
                time: { start: Date.now() },
              },
            },
          },
        })
        break
      }
      case "tool_call_update": {
        this.emitSSE(sessionId, {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              id: `acp-tool-${update.toolCallId}`,
              sessionID: sessionId,
              messageID: `acp-${sessionId}-msg`,
              tool: "tool",
              state: {
                status: update.status === "completed" ? "completed" : "running",
                input: {},
                title: "",
                output: "",
                metadata: {},
                time: { start: Date.now() },
              },
            },
          },
        })
        break
      }
      case "usage_update": {
        this.emitSSE(sessionId, {
          type: "message.updated",
          properties: {
            info: {
              id: `acp-${sessionId}-msg`,
              sessionID: sessionId,
              role: "assistant",
              time: { created: Date.now() },
            },
          },
        })
        break
      }
      default:
        // Other update types (plan, config_option_update, etc.) — log and skip
        break
    }
  }

  private ensureConnected(): void {
    if (this._status !== "connected" || !this.connection) {
      throw new Error(`Agent "${this.agentId}" is not connected (status: ${this._status})`)
    }
  }

  private drainStderr(): void {
    if (!this.process?.stderr) return
    const agentId = this.agentId
    const reader = (this.process.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    const pump = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          const text = decoder.decode(value, { stream: true })
          for (const line of text.split("\n").filter(Boolean)) {
            console.error(`[ACP:${agentId}:stderr] ${line}`)
          }
        }
      } catch {
        // Process exited
      }
    }
    pump()
  }

  private cleanup(): void {
    this.sseCallbacks.clear()
    try {
      this.process?.kill()
    } catch {
      // Already dead
    }
    this.process = null
    this.connection = null
  }
}
