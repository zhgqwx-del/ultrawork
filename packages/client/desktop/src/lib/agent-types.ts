// Unified agent model across backends (ADR-027 档1):
// - "opencode": the default REST backend (unchanged behavior)
// - "acp": external agents driven by the ACP Client Sidecar (:4099)

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
