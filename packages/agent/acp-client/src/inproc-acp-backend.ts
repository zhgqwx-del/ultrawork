// In-process AgentBackend over ACPManager — the orchestrator's ACP leg.
//
// The desktop's ACPBackend reaches this sidecar over HTTP+SSE (:4099); the
// orchestrator LIVES here, so it talks to the manager directly. A loopback
// self-connection would add per-child SSE streams + serialization for nothing
// and couple backend readiness to Bun.serve being up. Implementing the same
// `AgentBackend` interface keeps the contract pinned by the compiler.

import type {
  AgentBackend,
  BackendCapabilities,
  ConnectionStatus,
  ConnectorEvent,
  CreateSessionOptions,
  FetchHistoryOptions,
  FetchHistoryResult,
  PermissionReply,
  PromptOptions,
  SessionRef,
  TransportFamily,
  UnifiedAgent,
  Unsubscribe,
} from "@agent/connector"
import { ACP_BACKEND_KIND, makeAgentId, parseAgentId } from "@agent/connector"
import type { SendMessageResponse } from "@agent/api-client"
import type { ACPManager } from "./acp-manager.js"

// Mirrors connector's ACPBackend CAPABILITIES (same family, same agents).
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
  globalEvents: false,
  paginatedHistory: false,
  model: false,
  sessionStatus: false,
}

export class InProcACPBackend implements AgentBackend {
  readonly kind = ACP_BACKEND_KIND
  readonly transport: TransportFamily = "acp-stdio"
  readonly capabilities = CAPABILITIES

  constructor(private readonly manager: ACPManager) {}

  async createSession(opts: CreateSessionOptions): Promise<SessionRef> {
    if (!opts.agentId) throw new Error("agentId is required for ACP sessions")
    if (!opts.directory) throw new Error("directory is required for ACP sessions")
    const { rawId } = parseAgentId(opts.agentId)
    // Orchestrator children pass no clientSessionId → no opencode twin → the
    // sidebar never sees them. orchestrate: false is the HARD recursion guard
    // (ADR-031 D-5): children never get the delegate MCP, whatever the
    // agent-level default says.
    const sessionId = await this.manager.createSession(rawId, opts.directory, opts.clientSessionId, {
      orchestrate: false,
    })
    return { id: sessionId, backend: this.kind, directory: opts.directory }
  }

  /** Blocking semantics: resolves at StopReason — the turn's terminal state. */
  async prompt(sessionId: string, text: string, _opts?: PromptOptions): Promise<void> {
    await this.manager.prompt(sessionId, text)
  }

  async cancel(sessionId: string): Promise<void> {
    await this.manager.cancel(sessionId)
  }

  async fetchHistory(sessionId: string, _opts?: FetchHistoryOptions): Promise<FetchHistoryResult> {
    const messages = this.manager.getMessages(sessionId) ?? []
    // UwStoredMessage is the sidecar's name for the same shaped {info, parts}
    // the desktop renders; the wire types are structurally identical.
    return { messages: messages as unknown as SendMessageResponse[], hasMore: false }
  }

  async deleteSessionState(sessionId: string): Promise<void> {
    this.manager.deleteSession(sessionId)
  }

  async replyPermission(sessionId: string, permissionId: string, reply: PermissionReply): Promise<void> {
    if (!this.manager.replyPermission(sessionId, permissionId, reply)) {
      throw new Error(`unknown or already-resolved permission "${permissionId}"`)
    }
  }

  subscribeSession(sessionId: string, handler: (event: ConnectorEvent) => void): Unsubscribe {
    return this.manager.subscribe(sessionId, (event) => handler(event as ConnectorEvent))
  }

  async listAgents(): Promise<UnifiedAgent[]> {
    return this.manager.listAgents().map((agent) => ({
      id: makeAgentId("acp", agent.id),
      name: agent.label,
      description: agent.description,
      source: "acp" as const,
      status: agent.status,
      error: agent.error,
    }))
  }

  status(): ConnectionStatus {
    return "connected" // same process — reachable by construction
  }

  async ready(): Promise<void> {}

  dispose(): void {}
}
