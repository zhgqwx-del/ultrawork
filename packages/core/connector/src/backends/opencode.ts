import { createApiClient, ApiError, type ApiClient } from "@agent/api-client"
import { sessionIdOf, type ConnectorEvent } from "../events"
import {
  createSseTransport,
  type SseRetryPolicy,
  type SseTransport,
  type TransportStatus,
} from "../sse-transport"
import {
  OPENCODE_DEFAULT_AGENT_ID,
  type AgentBackend,
  type BackendCapabilities,
  type ConnectionStatus,
  type CreateSessionOptions,
  type FetchHistoryOptions,
  type FetchHistoryResult,
  type PermissionReply,
  type PromptOptions,
  type SessionRef,
  type TransportFamily,
  type UnifiedAgent,
  type Unsubscribe,
} from "../types"

export const OPENCODE_BACKEND_KIND = "opencode"

/** Legacy desktop SSEClient policy: 1s exponential, give up after 5 attempts. */
export const FINITE_SSE_RETRY: SseRetryPolicy = { baseDelayMs: 1000, maxAttempts: 5 }
/** Legacy gateway bridge policy: 1s exponential capped at 30s, retry forever. */
export const UNLIMITED_SSE_RETRY: SseRetryPolicy = { baseDelayMs: 1000, maxDelayMs: 30_000 }

export interface OpenCodeBackendOptions {
  baseUrl: string
  username?: string
  password?: string
  workingDirectory?: string
  sse?: {
    /** Default: FINITE_SSE_RETRY (legacy desktop SSEClient behavior). */
    retry?: SseRetryPolicy
    heartbeatTimeoutMs?: number
    heartbeatReconnectBudget?: number
  }
}

const CAPABILITIES: BackendCapabilities = {
  providers: true,
  mcp: true,
  file: true,
  agentCrud: false,
  loadSession: false,
  image: true,
  permissions: true,
  questions: true,
  fileDiffs: true,
  plan: true,
  reasoning: true,
  historyReplay: true,
  revert: true,
  globalEvents: true,
  paginatedHistory: true,
  model: true,
  sessionStatus: true,
}

const DEFAULT_HISTORY_LIMIT = 50

/**
 * OpenCode backend (product-native, HTTP+SSE; default + reference, ADR-030
 * D-4/D-8). Wraps — does not replace — the existing ApiClient (REST) and the
 * /event global stream (SSE). Backend-specific surface (providers/mcp/file/
 * config/skills...) stays on `.api`, gated by capabilities.
 *
 * Must use the createApiClient factory: gateway's bridge.test.ts mocks it.
 */
export class OpenCodeBackend implements AgentBackend {
  readonly kind = OPENCODE_BACKEND_KIND
  readonly transport: TransportFamily = "product-native"
  readonly capabilities = CAPABILITIES
  readonly api: ApiClient

  private sse: SseTransport | null = null
  private handlers = new Set<(event: ConnectorEvent) => void>()
  private transportStatus: TransportStatus = "idle"
  private transportStatusListeners = new Set<(status: TransportStatus) => void>()
  private statusListeners = new Set<(status: ConnectionStatus) => void>()
  private readyPromise: Promise<void>
  private resolveReady!: () => void

  constructor(private options: OpenCodeBackendOptions) {
    this.api = createApiClient({
      baseUrl: options.baseUrl,
      username: options.username,
      password: options.password,
      workingDirectory: options.workingDirectory,
    })
    this.readyPromise = new Promise((resolve) => {
      this.resolveReady = resolve
    })
  }

  // --- connection lifecycle ---

  /**
   * Explicitly start the global /event stream. Subscriptions are passive —
   * the owner (ConnectorProvider / gateway bridge) controls the connection
   * lifetime, preserving the legacy "provider mounted == connected" semantics.
   */
  connectGlobal(): void {
    if (this.sse) return
    this.sse = createSseTransport({
      url: this.buildEventUrl(),
      headers: () => this.buildEventHeaders(),
      retry: this.options.sse?.retry ?? FINITE_SSE_RETRY,
      heartbeatTimeoutMs: this.options.sse?.heartbeatTimeoutMs,
      heartbeatReconnectBudget: this.options.sse?.heartbeatReconnectBudget,
      onEvent: (event) => {
        this.handlers.forEach((h) => h(event))
      },
      onStatusChange: (status) => {
        this.transportStatus = status
        if (status === "open" || status === "error" || status === "gave-up") {
          this.resolveReady()
        }
        this.transportStatusListeners.forEach((l) => l(status))
        const coarse = this.status()
        this.statusListeners.forEach((l) => l(coarse))
      },
    })
    void this.sse.connect()
  }

  ready(): Promise<void> {
    this.connectGlobal()
    return this.readyPromise
  }

  status(): ConnectionStatus {
    switch (this.transportStatus) {
      case "open":
        return "connected"
      case "connecting":
      case "reconnecting":
        return "connecting"
      case "stalled":
      case "error":
      case "gave-up":
        return "error"
      default:
        return "disconnected"
    }
  }

  onStatusChange(cb: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusListeners.add(cb)
    return () => this.statusListeners.delete(cb)
  }

  /** Fine-grained transport state for UI (connected indicator, gave-up toast). */
  getTransportStatus(): TransportStatus {
    return this.transportStatus
  }

  onTransportStatusChange(cb: (status: TransportStatus) => void): Unsubscribe {
    this.transportStatusListeners.add(cb)
    return () => this.transportStatusListeners.delete(cb)
  }

  dispose(): void {
    this.sse?.close()
    this.sse = null
    this.handlers.clear()
    this.transportStatusListeners.clear()
    this.statusListeners.clear()
  }

  // --- events ---

  subscribeGlobal(handler: (event: ConnectorEvent) => void): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  subscribeSession(sessionId: string, handler: (event: ConnectorEvent) => void): Unsubscribe {
    return this.subscribeGlobal((event) => {
      const sid = sessionIdOf(event)
      if (sid === undefined || sid === sessionId) handler(event)
    })
  }

  // --- control surface ---

  async createSession(opts: CreateSessionOptions = {}): Promise<SessionRef> {
    const session = await this.api.createSession({
      parentID: opts.parentSessionId,
      title: opts.title,
    })
    return { id: session.id, backend: this.kind, directory: opts.directory ?? this.options.workingDirectory }
  }

  async prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void> {
    await this.api.promptAsync(sessionId, text, {
      agent: opts?.agent,
      model: opts?.model,
      // Isolation closure (017 拍板 #4): every opencode prompt that doesn't
      // explicitly manage tools is denied the delegate MCP tools. Callers
      // that pass a map (orchestrator children, Team-page Leader) own it.
      tools: opts?.tools ?? { "orchestrator_*": false },
      system: opts?.system,
    })
  }

  async cancel(sessionId: string): Promise<void> {
    await this.api.abortSession(sessionId)
  }

  async revert(sessionId: string, messageID: string): Promise<void> {
    await this.api.revertSession(sessionId, messageID)
  }

  async fetchHistory(sessionId: string, opts?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    return this.api.getMessagesPaginated(sessionId, {
      limit: opts?.limit ?? DEFAULT_HISTORY_LIMIT,
      before: opts?.before,
    })
  }

  async deleteSessionState(sessionId: string): Promise<void> {
    try {
      await this.api.deleteSession(sessionId)
    } catch (err) {
      // Already gone server-side counts as deleted (legacy use-sessions semantics)
      if (err instanceof ApiError && err.status === 404) return
      throw err
    }
  }

  async replyPermission(_sessionId: string, permissionId: string, reply: PermissionReply): Promise<void> {
    await this.api.replyPermission(permissionId, reply)
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    return [
      {
        id: OPENCODE_DEFAULT_AGENT_ID,
        name: "OpenCode",
        source: "opencode",
        status: "available",
      },
    ]
  }

  // --- url/header construction (single source; legacy had 3 copies) ---

  private buildEventUrl(): string {
    // Relative path branch keeps desktop dev mode (Vite proxy, baseUrl "") working.
    const base = this.options.baseUrl ? new URL("/event", this.options.baseUrl).toString() : "/event"
    const params = new URLSearchParams()
    if (this.options.workingDirectory) params.set("directory", this.options.workingDirectory)
    const query = params.toString()
    return query ? `${base}?${query}` : base
  }

  private buildEventHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (this.options.password) {
      const username = this.options.username || "opencode"
      headers["Authorization"] = `Basic ${btoa(`${username}:${this.options.password}`)}`
    }
    if (this.options.workingDirectory) {
      // Header is URI-encoded; the ?directory= query param is NOT — both match
      // the legacy sse-client.ts behavior the server expects.
      headers["x-opencode-directory"] = encodeURIComponent(this.options.workingDirectory)
    }
    return headers
  }
}
