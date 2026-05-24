/**
 * Agent Router — routes requests to OpenCode API or ACP Sidecar based on agent source.
 */

const ACP_BASE_URL = import.meta.env.DEV ? "http://localhost:4099" : "http://localhost:4099"

/** Fetch ACP agent list from the ACP Sidecar */
export async function fetchACPAgents(): Promise<ACPAgentInfo[]> {
  try {
    const res = await fetch(`${ACP_BASE_URL}/acp/agents`)
    if (!res.ok) return []
    return await res.json()
  } catch {
    // ACP Sidecar may not be running
    return []
  }
}

/** Connect to an ACP agent (spawn subprocess + initialize) */
export async function connectACPAgent(agentId: string): Promise<void> {
  const res = await fetch(`${ACP_BASE_URL}/acp/agents/${agentId}/connect`, { method: "POST" })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Connect failed" }))
    throw new Error(body.error || "Connect failed")
  }
}

/** Create an ACP session */
export async function createACPSession(agentId: string, cwd: string): Promise<string> {
  const res = await fetch(`${ACP_BASE_URL}/acp/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, cwd }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Create session failed" }))
    throw new Error(body.error || "Create session failed")
  }
  const data = await res.json()
  return data.sessionId
}

/** Send a prompt to an ACP session */
export async function promptACPSession(sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${ACP_BASE_URL}/acp/session/${sessionId}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Prompt failed" }))
    throw new Error(body.error || "Prompt failed")
  }
}

/** Cancel an ACP session prompt */
export async function cancelACPSession(sessionId: string): Promise<void> {
  await fetch(`${ACP_BASE_URL}/acp/session/${sessionId}/cancel`, { method: "POST" })
}

/** Get SSE event stream URL for an ACP session */
export function getACPSessionEventsURL(sessionId: string): string {
  return `${ACP_BASE_URL}/acp/session/${sessionId}/events`
}

/** Save (add/update) an ACP agent config */
export async function saveACPAgent(agent: ACPAgentConfig): Promise<void> {
  const { id, ...body } = agent
  const res = await fetch(`${ACP_BASE_URL}/acp/agents/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Save failed" }))
    throw new Error(data.error || "Save failed")
  }
}

/** Delete an ACP agent config */
export async function deleteACPAgent(agentId: string): Promise<void> {
  const res = await fetch(`${ACP_BASE_URL}/acp/agents/${agentId}`, { method: "DELETE" })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: "Delete failed" }))
    throw new Error(data.error || "Delete failed")
  }
}

/** Get an ACP agent's editable config */
export async function getACPAgentConfig(agentId: string): Promise<ACPAgentConfig> {
  const res = await fetch(`${ACP_BASE_URL}/acp/agents/${agentId}/config`)
  if (!res.ok) throw new Error("Agent not found")
  return res.json()
}

/** ACP agent editable config */
export interface ACPAgentConfig {
  id: string
  label: string
  description?: string
  command: string
  args: string[]
  env?: Record<string, string>
}

/** ACP agent info returned by the sidecar */
export interface ACPAgentInfo {
  id: string
  label: string
  description?: string
  status: "disconnected" | "connecting" | "connected" | "error"
  error?: string
  protocolVersion?: number
}
