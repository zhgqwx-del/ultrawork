import type { Agent } from "@agent/api-client"

// --- Agent source types ---

/** Where the agent comes from */
export type AgentSource = "opencode" | "acp"

/** Connection status for agents */
export type AgentStatus =
  | "available"      // OpenCode built-in, always available
  | "connecting"     // ACP agent spawning / initializing
  | "connected"      // ACP agent ready
  | "error"          // ACP agent failed to connect
  | "not-installed"  // ACP agent command not found

// --- Unified Agent model ---

/** Unified agent representation across OpenCode built-in and external ACP agents */
export interface UnifiedAgent {
  /** Unique ID: "opencode:build" | "opencode:plan" | "acp:qoder" */
  id: string
  /** Display name: "Build" | "Plan" | "Qoder" */
  name: string
  /** Agent description */
  description?: string
  /** Where this agent comes from */
  source: AgentSource
  /** Current connection status */
  status: AgentStatus
}

// --- Helpers ---

/** Create a UnifiedAgent ID from source and raw agent ID */
export function makeAgentId(source: AgentSource, rawId: string): string {
  return `${source}:${rawId}`
}

/** Parse a UnifiedAgent ID into source and raw ID */
export function parseAgentId(agentId: string): { source: AgentSource; rawId: string } {
  const colonIdx = agentId.indexOf(":")
  if (colonIdx === -1) return { source: "opencode", rawId: agentId }
  return {
    source: agentId.substring(0, colonIdx) as AgentSource,
    rawId: agentId.substring(colonIdx + 1),
  }
}

/** Convert an OpenCode Agent (from GET /agent) to UnifiedAgent */
export function fromOpenCodeAgent(agent: Agent): UnifiedAgent {
  return {
    id: makeAgentId("opencode", agent.id),
    name: agent.name,
    description: agent.description,
    source: "opencode",
    status: "available",
  }
}
