import type { SendMessageResponse } from "@agent/api-client"
import type { ConnectorEvent } from "./events"

// --- Backend taxonomy (ADR-030 D-8) ---

/**
 * Protocol family axis. The wire (stdio / HTTP+SSE / WebSocket) is an adapter
 * detail; "product-native" covers both HTTP+SSE (opencode) and WebSocket.
 */
export type TransportFamily = "acp-stdio" | "product-native" | "acp-remote"

/** Open registration — NOT a closed union ("opencode" / "acp" / future kinds). */
export type BackendKind = string

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error"

export type Unsubscribe = () => void

/**
 * Capability declaration (ADR-030 D-5): backends are asymmetric; consumers
 * gate backend-specific calls/UI on these flags instead of a
 * lowest-common-denominator interface. Black-box backends declare false.
 */
export interface BackendCapabilities {
  providers: boolean
  mcp: boolean
  file: boolean
  agentCrud: boolean
  loadSession: boolean
  image: boolean
  permissions: boolean
  questions: boolean
  fileDiffs: boolean
  plan: boolean
  reasoning: boolean
  historyReplay: boolean
  revert: boolean
  /** Has a global (cross-session) event stream, e.g. opencode /event. */
  globalEvents: boolean
  /** History endpoint supports cursor pagination. */
  paginatedHistory: boolean
  /** prompt() accepts a model override. */
  model: boolean
}

// --- Unified agent model (ADR-027 档1, moved here from desktop agent-types.ts) ---

export type AgentSource = "opencode" | "acp"

export type UnifiedAgentStatus = "available" | "disconnected" | "connecting" | "connected" | "error"

export interface UnifiedAgent {
  /** Namespaced id, e.g. "opencode:default" / "acp:claude" */
  id: string
  name: string
  description?: string
  source: AgentSource
  status: UnifiedAgentStatus
  error?: string
}

/** The built-in default: prompts go to opencode exactly as before. */
export const OPENCODE_DEFAULT_AGENT_ID = "opencode:default"

export function makeAgentId(source: AgentSource, rawId: string): string {
  return `${source}:${rawId}`
}

export function parseAgentId(id: string): { source: AgentSource; rawId: string } {
  const sep = id.indexOf(":")
  if (sep < 0) return { source: "opencode", rawId: id }
  const source = id.slice(0, sep) === "acp" ? "acp" : "opencode"
  return { source, rawId: id.slice(sep + 1) }
}

export function isACPAgentId(id: string | undefined): boolean {
  return !!id && parseAgentId(id).source === "acp"
}

// --- Control surface ---

export interface SessionRef {
  id: string
  backend: BackendKind
  directory?: string
}

export interface CreateSessionOptions {
  directory?: string
  /** Namespaced agent id to bind the new session to, e.g. "acp:claude". */
  agentId?: string
  /** ACP: reuse the caller's session id so events need no id rewriting. */
  clientSessionId?: string
}

export interface PromptOptions {
  /** opencode persona agent (build/plan/...) — distinct from boundAgentId. */
  agent?: string
  /** Model override "providerID/modelID" (capabilities.model). */
  model?: string
  /** Raw agent id this session is bound to (filled in by Connector). */
  boundAgentId?: string
}

export interface FetchHistoryOptions {
  limit?: number
  before?: string
}

export interface FetchHistoryResult {
  messages: SendMessageResponse[]
  cursor?: string
  hasMore: boolean
}

export type PermissionReply = "once" | "always" | "reject"

/**
 * Pluggable backend boundary (ADR-030 D-1/D-6, acpx model). The core common
 * surface below doubles as the stage-3 orchestrator primitives
 * (spawn/steer/await/cancel). Backend-specific surfaces (opencode ApiClient,
 * ACP agent CRUD) live on the concrete classes, gated by capabilities.
 */
export interface AgentBackend {
  readonly kind: BackendKind
  readonly transport: TransportFamily
  readonly capabilities: BackendCapabilities

  createSession(opts: CreateSessionOptions): Promise<SessionRef>
  prompt(sessionId: string, text: string, opts?: PromptOptions): Promise<void>
  cancel(sessionId: string): Promise<void>
  revert?(sessionId: string, messageID: string): Promise<void>
  fetchHistory(sessionId: string, opts?: FetchHistoryOptions): Promise<FetchHistoryResult>
  /** Delete backend-side state for a session (opencode session / ACP persistence). */
  deleteSessionState(sessionId: string): Promise<void>
  replyPermission(sessionId: string, permissionId: string, reply: PermissionReply): Promise<void>

  /** Per-session events. Events without a session id also pass through. */
  subscribeSession(sessionId: string, handler: (event: ConnectorEvent) => void): Unsubscribe
  /** Global event stream (capabilities.globalEvents). */
  subscribeGlobal?(handler: (event: ConnectorEvent) => void): Unsubscribe

  listAgents(): Promise<UnifiedAgent[]>
  status(): ConnectionStatus
  onStatusChange?(cb: (status: ConnectionStatus) => void): Unsubscribe
  /** Resolves once the first connection attempt settles (open OR error) — never hangs. */
  ready(): Promise<void>
  dispose(): void
}
