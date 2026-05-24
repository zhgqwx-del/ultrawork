/** Configuration for an external ACP agent */
export interface ACPAgentConfig {
  /** Unique identifier (e.g. "qoder", "claude-code") */
  id: string
  /** Display name */
  label: string
  /** Description */
  description?: string
  /** Command to spawn the agent (e.g. "qodercli") */
  command: string
  /** Command arguments (e.g. ["--acp"]) */
  args: string[]
  /** Environment variables to pass to the subprocess */
  env?: Record<string, string>
}

/** Runtime state of an ACP agent connection */
export type ACPAgentStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error"

/** Agent info exposed via HTTP API */
export interface ACPAgentInfo {
  id: string
  label: string
  description?: string
  status: ACPAgentStatus
  error?: string
  /** Protocol version negotiated during initialize */
  protocolVersion?: number
}

/** ACP session info exposed via HTTP API */
export interface ACPSessionInfo {
  sessionId: string
  agentId: string
  createdAt: number
}

/** Unified SSE event emitted by the ACP sidecar (mirrors OpenCode SSE format) */
export interface ACPSSEEvent {
  type: string
  properties: Record<string, unknown>
}
