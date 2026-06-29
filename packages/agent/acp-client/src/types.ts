// ACP Client Sidecar types.
//
// The Uw* types below mirror the OpenCode SSE wire shapes consumed by the
// desktop client (packages/core/api-client/src/types.ts). They are duplicated
// here on purpose: the sidecar is compiled to a standalone binary and its
// contract is "emit SSE that looks exactly like opencode's" (ADR-027 D-3).

// --- Agent configuration (~/.config/ultrawork/agents.json) ---

export interface ACPAgentConfig {
  id: string
  label: string
  description?: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Expose the host knowledge base MCP (:4098) to this agent (B4: opt-in, default off). */
  knowledgeMcp?: boolean
  /**
   * Expose the orchestrator delegate MCP (delegate/list_agents → :4099) to
   * this agent's MAIN sessions (ADR-031 D-3: opt-in, default off). Children
   * spawned by the orchestrator never get it regardless of this flag
   * (recursion guard — see InProcACPBackend).
   */
  orchestratorMcp?: boolean
  /**
   * Desired thinking-effort level, applied per session via ACP
   * `session/set_config_option` when the agent advertises a `thought_level`
   * config option (claude-agent-acp ≥0.44). Unset or "default" = leave the
   * agent's default; agents without the option silently skip it.
   */
  thoughtLevel?: string
  /**
   * Whether the adapter honors `_meta.systemPrompt` on session/new+load
   * (claude-agent-acp ≥0.44; object form = preset append). Unset = detected
   * from the spawn command. Sessions with a systemPrompt on agents without
   * this fall back to prefixing it onto the first prompt.
   */
  metaSystemPrompt?: boolean
}

// Mirrors the desktop PermissionRequest shape (api-client types.ts) — the
// `permission.asked` SSE carries this object directly (not nested).
export interface UwPermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

export interface AgentsFile {
  agents?: Record<string, Omit<ACPAgentConfig, "id">>
  default?: string
}

export type ACPAgentStatus = "disconnected" | "connecting" | "connected" | "error"

export interface ACPAgentInfo {
  id: string
  label: string
  description?: string
  status: ACPAgentStatus
  error?: string
  protocolVersion?: number
  capabilities?: {
    loadSession?: boolean
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
}

export interface ACPSessionInfo {
  sessionId: string
  agentId: string
  cwd: string
  createdAt: number
  /** Whether the orchestrator delegate MCP is injected into this session (sticky across session/load). */
  orchestrate?: boolean
  /**
   * Extra system prompt for this session (Team-page Leader instructions).
   * Delivered via `_meta.systemPrompt` append (claude-agent-acp ≥0.44) or, on
   * agents without that, prefixed onto the first prompt.
   */
  systemPrompt?: string
}

/** One shaped message as the desktop renders it (info + accumulated parts). */
export interface UwStoredMessage {
  info: UwMessageInfo
  parts: UwPart[]
}

/** On-disk session record: id mapping + shaped history (W4b). */
export interface PersistedACPSession {
  version: 1
  sessionId: string
  acpSessionId: string
  agentId: string
  cwd: string
  createdAt: number
  updatedAt: number
  /** Delegate MCP injection flag — restored so session/load re-injects (older files: undefined → off). */
  orchestrate?: boolean
  /** Session system prompt — restored so session/load re-injects it via _meta. */
  systemPrompt?: string
  messages: UwStoredMessage[]
  /** Latest task plan (ADR-038) — restored so switch-back after restart still shows it. */
  plan?: UwPlanStep[]
}

// --- OpenCode-shaped wire types (subset the sidecar emits) ---

export interface UwPartBase {
  id: string
  sessionID: string
  messageID: string
}

export interface UwTextPart extends UwPartBase {
  type: "text"
  text: string
}

export interface UwReasoningPart extends UwPartBase {
  type: "reasoning"
  text: string
}

export interface UwToolStatePending {
  status: "pending"
  input: Record<string, unknown>
}

export interface UwToolStateRunning {
  status: "running"
  input: Record<string, unknown>
  title?: string
  time: { start: number }
}

export interface UwToolStateCompleted {
  status: "completed"
  input: Record<string, unknown>
  output: string
  title: string
  metadata: Record<string, unknown>
  time: { start: number; end: number }
}

export interface UwToolStateError {
  status: "error"
  input: Record<string, unknown>
  error: string
  time: { start: number; end: number }
}

export type UwToolState = UwToolStatePending | UwToolStateRunning | UwToolStateCompleted | UwToolStateError

export interface UwToolPart extends UwPartBase {
  type: "tool"
  callID: string
  tool: string
  state: UwToolState
}

export type UwPart = UwTextPart | UwReasoningPart | UwToolPart

/**
 * One task-plan step (ADR-038). Mirrors api-client's PlanStep and opencode's
 * Todo so the desktop plan panel consumes one shape across backends. ACP's
 * native PlanEntry only ever produces the first three statuses (no `cancelled`).
 */
export interface UwPlanStep {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled"
  priority?: "high" | "medium" | "low"
}

export interface UwMessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time: { created: number; completed?: number }
  modelID?: string
  providerID?: string
  agent?: string
  cost?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  finish?: string
}

// --- SSE events the sidecar emits (opencode shapes + sidecar-specific) ---

export type UwSSEEvent =
  | { type: "message.part.updated"; properties: { part: UwPart } }
  | {
      type: "message.part.delta"
      properties: { sessionID: string; messageID: string; partID: string; field: "text"; delta: string }
    }
  | { type: "message.updated"; properties: { info: UwMessageInfo } }
  // Task plan (ADR-038): session-level, whole list each time (整表替换).
  | { type: "plan.updated"; properties: { sessionID: string; entries: UwPlanStep[] } }
  | { type: "permission.asked"; properties: UwPermissionRequest }
  | { type: "permission.replied"; properties: { id: string; sessionID: string } }
  | { type: "session.error"; properties: { sessionID: string; error: string } }
  | { type: "session.status"; properties: { sessionID: string; status: { type: "busy" | "idle" } } }
  | { type: "acp.connected"; properties: { sessionId: string } }
  | { type: "heartbeat"; properties: Record<string, never> }
