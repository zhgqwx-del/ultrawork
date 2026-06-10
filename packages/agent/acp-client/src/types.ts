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

export interface UwMessageInfo {
  id: string
  sessionID: string
  role: "assistant"
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
  | { type: "session.error"; properties: { sessionID: string; error: string } }
  | { type: "acp.connected"; properties: { sessionId: string } }
  | { type: "heartbeat"; properties: Record<string, never> }
