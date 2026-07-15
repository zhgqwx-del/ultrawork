import type { PlanStep } from "@agent/api-client"
import type { ConnectorEvent } from "../events"
import { createSseTransport, type SseTransport } from "../sse-transport"
import {
  makeAgentId,
  parseAgentId,
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
import { ACPHttpClient, type ACPSidecarSession } from "./acp-http"

export const ACP_BACKEND_KIND = "acp"

const CAPABILITIES: BackendCapabilities = {
  providers: false,
  mcp: false,
  file: false,
  agentCrud: true,
  loadSession: true,
  image: false,
  permissions: true,
  questions: false,
  fileDiffs: false,
  plan: true,
  reasoning: true,
  historyReplay: true,
  revert: false,
  // The sidecar exposes a global lifecycle stream (/acp/global/events) carrying
  // session.status busy/idle, consumed by the desktop's app-level activeSessionIds
  // (discussions/022). sessionStatus stays false on purpose: that flag governs
  // orchestrator idle-wait / mounted-session idle semantics (no ripple), whereas
  // these global events only feed the cross-session busy markers.
  globalEvents: true,
  paginatedHistory: false,
  model: false,
  sessionStatus: false,
}

/** Legacy use-acp-sse.ts policy: 1s exponential, give up after 5, silent. */
const ACP_SSE_RETRY = { baseDelayMs: 1000, maxAttempts: 5 }

interface SharedConnection {
  transport: SseTransport
  handlers: Set<(event: ConnectorEvent) => void>
}

/**
 * ACP backend (acp-stdio family — ONE adapter for every native ACP agent:
 * claude/gemini/qoder/..., ADR-030 D-8). Wraps the ACP Client Sidecar's REST
 * surface (:4099) plus its per-session SSE streams. The sidecar already
 * normalizes ACP `session/update` into the opencode event shape (ADR-027
 * D-3), so events pass through untranslated.
 *
 * Per-session connections are shared: multiple subscribers on the same
 * session (messages + permissions) multiplex one stream via a refcounted
 * pool — the former use-acp-sse.ts semantics, line for line.
 */
export class ACPBackend implements AgentBackend {
  readonly kind = ACP_BACKEND_KIND
  readonly transport: TransportFamily = "acp-stdio"
  readonly capabilities = CAPABILITIES
  /** Backend-specific surface (capabilities.agentCrud): agent CRUD + sidecar session list. */
  readonly http: ACPHttpClient

  private pool = new Map<string, SharedConnection>()
  /** Single shared connection to the sidecar's global lifecycle stream. */
  private global: SharedConnection | null = null
  private lastHealth = false

  constructor(opts?: { baseUrl?: string; headers?: () => Record<string, string> }) {
    this.http = new ACPHttpClient(opts?.baseUrl, opts?.headers)
  }

  // --- control surface ---

  async createSession(opts: CreateSessionOptions): Promise<SessionRef> {
    if (!opts.agentId) throw new Error("agentId is required for ACP sessions")
    if (!opts.directory) throw new Error("directory is required for ACP sessions")
    const { rawId } = parseAgentId(opts.agentId)
    const sessionId = await this.http.createSession(rawId, opts.directory, opts.clientSessionId)
    return { id: sessionId, backend: this.kind, directory: opts.directory }
  }

  /**
   * Lazily get-or-create the agent-side session bound to this desktop session
   * (cwd = session workspace), then prompt. Resolves when the turn completes;
   * streaming arrives via subscribeSession.
   */
  async prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void> {
    if (!opts?.boundAgentId) throw new Error("ACP prompt requires the bound agent id")
    if (!opts?.directory) throw new Error("Session has no workspace directory")
    // capabilities.image is false for this backend. Throw rather than drop: a silently
    // discarded attachment looks to the user like the agent ignored their screenshot.
    if (opts.attachments?.length) {
      throw new Error("This agent does not support attachments (ACP prompt is text-only)")
    }
    await this.http.ensureSession(opts.boundAgentId, opts.directory, sessionId)
    await this.http.prompt(sessionId, text)
  }

  async cancel(sessionId: string): Promise<void> {
    await this.http.cancel(sessionId)
  }

  async fetchHistory(sessionId: string, _opts?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    // The sidecar serves the whole shaped history (no cursor pagination);
    // the desktop's turn window limits what actually renders.
    const messages = await this.http.fetchMessages(sessionId)
    return { messages, cursor: undefined, hasMore: false }
  }

  async getPlan(sessionId: string): Promise<PlanStep[]> {
    return this.http.fetchPlan(sessionId)
  }

  /**
   * Drop the sidecar's persisted state. Tolerates every failure: unknown
   * sessions (404) and a dead sidecar must not block session deletion.
   */
  async deleteSessionState(sessionId: string): Promise<void> {
    await this.http.deleteSession(sessionId).catch(() => {})
  }

  async replyPermission(sessionId: string, permissionId: string, reply: PermissionReply): Promise<void> {
    await this.http.replyPermission(sessionId, permissionId, reply)
  }

  // --- events: refcounted per-session SSE pool ---

  subscribeSession(sessionId: string, handler: (event: ConnectorEvent) => void): Unsubscribe {
    let shared = this.pool.get(sessionId)
    if (!shared) {
      shared = this.open(sessionId)
      this.pool.set(sessionId, shared)
    }
    shared.handlers.add(handler)
    return () => {
      shared.handlers.delete(handler)
      if (shared.handlers.size === 0) {
        shared.transport.close()
        this.pool.delete(sessionId)
      }
    }
  }

  /**
   * Global lifecycle stream (session.status busy/idle). Refcounted single
   * connection, mirroring the per-session pool. Enables connector.subscribeGlobal
   * to fan ACP busy/idle into the desktop's app-level activeSessionIds
   * (discussions/022). Carries no message events — those stay per-session.
   */
  subscribeGlobal(handler: (event: ConnectorEvent) => void): Unsubscribe {
    if (!this.global) this.global = this.openGlobal()
    const shared = this.global
    shared.handlers.add(handler)
    return () => {
      shared.handlers.delete(handler)
      if (shared.handlers.size === 0) {
        shared.transport.close()
        this.global = null
      }
    }
  }

  private openGlobal(): SharedConnection {
    const handlers = new Set<(event: ConnectorEvent) => void>()
    const transport = createSseTransport({
      url: this.http.globalEventsURL(),
      headers: () => this.http.authHeaders(),
      retry: ACP_SSE_RETRY,
      onEvent: (event) => {
        if (event.type === "heartbeat") return
        for (const handler of handlers) handler(event)
      },
      onStatusChange: (status) => {
        // The lifecycle stream giving up means busy/idle stops flowing; a
        // transient drop self-heals because the sidecar re-emits a busy snapshot
        // on reconnect (acp-manager.subscribeGlobal). Surface a permanent give-up
        // so a stuck busy marker isn't completely silent (discussions/022 M2).
        if (status === "gave-up") {
          console.warn("[acp] global lifecycle stream gave up — busy markers may be stale until reconnect")
        }
      },
    })
    void transport.connect()
    return { transport, handlers }
  }

  private open(sessionId: string): SharedConnection {
    const handlers = new Set<(event: ConnectorEvent) => void>()
    const transport = createSseTransport({
      url: this.http.eventsURL(sessionId),
      headers: () => this.http.authHeaders(),
      retry: ACP_SSE_RETRY,
      onEvent: (event) => {
        // Transport-level frames are not for consumers (heartbeat keeps the
        // stream alive; acp.connected is the subscription ack).
        if (event.type === "heartbeat" || event.type === "acp.connected") return
        for (const handler of handlers) handler(event)
      },
      onStatusChange: (status) => {
        // The per-session ACP stream has no global toast (unlike opencode's
        // connectGlobal → gave-up → toast). When retries are exhausted, surface
        // a session.error so the view doesn't silently freeze on the last frame.
        if (status === "gave-up") {
          const dead: ConnectorEvent = {
            type: "session.error",
            properties: { sessionID: sessionId, error: "Lost connection to the agent stream. Reopen the session to retry." },
          }
          for (const handler of handlers) handler(dead)
        }
      },
    })
    void transport.connect()
    return { transport, handlers }
  }

  // --- registry surface ---

  async listAgents(): Promise<UnifiedAgent[]> {
    this.lastHealth = await this.http.health()
    if (!this.lastHealth) return []
    const agents = await this.http.listAgents()
    return agents.map((a) => ({
      id: makeAgentId("acp", a.id),
      name: a.label,
      description: a.description,
      source: "acp" as const,
      status: a.status,
      error: a.error,
    }))
  }

  status(): ConnectionStatus {
    return this.lastHealth ? "connected" : "disconnected"
  }

  async ready(): Promise<void> {
    // No global stream to wait for; per-session streams connect on subscribe.
  }

  dispose(): void {
    for (const shared of this.pool.values()) shared.transport.close()
    this.pool.clear()
    this.global?.transport.close()
    this.global = null
  }
}

/** Map sidecar sessions to binding-store hydration entries. */
export function toBindingEntries(sessions: ACPSidecarSession[]): Array<{ sessionId: string; agentId: string }> {
  return sessions.map((s) => ({ sessionId: s.sessionId, agentId: makeAgentId("acp", s.agentId) }))
}
