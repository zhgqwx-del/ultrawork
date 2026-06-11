// HTTP client for the ACP Client Sidecar (:4099).
//
// Always absolute (no Vite proxy entry for :4099): the sidecar allows the
// dev/Tauri origins via CORS, so this works in both dev and production.

import type { SendMessageResponse } from "@agent/api-client"

export const ACP_BASE_URL = "http://localhost:4099"

export interface ACPAgentInfo {
  id: string
  label: string
  description?: string
  status: "disconnected" | "connecting" | "connected" | "error"
  error?: string
  protocolVersion?: number
  capabilities?: {
    loadSession?: boolean
    image?: boolean
    audio?: boolean
    embeddedContext?: boolean
  }
}

export interface ACPAgentConfig {
  id: string
  label: string
  description?: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Expose the host knowledge base MCP (:4098) to this agent (opt-in). */
  knowledgeMcp?: boolean
  /** Thinking-effort level, applied per session when the agent supports it. */
  thoughtLevel?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${ACP_BASE_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error((body as { error?: string } | null)?.error ?? `ACP request failed: ${res.status}`)
  }
  return body as T
}

export async function checkACPHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${ACP_BASE_URL}/acp/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export function fetchACPAgents(): Promise<ACPAgentInfo[]> {
  return request<ACPAgentInfo[]>("/acp/agents")
}

export function getACPAgentConfig(agentId: string): Promise<ACPAgentConfig> {
  return request<ACPAgentConfig>(`/acp/agents/${encodeURIComponent(agentId)}/config`)
}

export function saveACPAgent(config: ACPAgentConfig): Promise<void> {
  const { id, ...body } = config
  return request(`/acp/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export function deleteACPAgent(agentId: string): Promise<void> {
  return request(`/acp/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })
}

export function connectACPAgent(agentId: string): Promise<void> {
  return request(`/acp/agents/${encodeURIComponent(agentId)}/connect`, { method: "POST" })
}

export function disconnectACPAgent(agentId: string): Promise<void> {
  return request(`/acp/agents/${encodeURIComponent(agentId)}/disconnect`, { method: "POST" })
}

/**
 * Get-or-create the ACP session bound to a desktop session. All shaped SSE
 * events carry `clientSessionId`, so the frontend needs no id translation.
 */
export async function ensureACPSession(
  agentId: string,
  cwd: string,
  clientSessionId: string,
): Promise<void> {
  const existing = await fetch(
    `${ACP_BASE_URL}/acp/session/${encodeURIComponent(clientSessionId)}`,
  ).catch(() => null)
  if (existing?.ok) return
  await request("/acp/session", {
    method: "POST",
    body: JSON.stringify({ agentId, cwd, clientSessionId }),
  })
}

/**
 * Persisted shaped history for an ACP-bound session (W4b). Unknown sessions
 * (never prompted, or persistence lost) resolve to an empty list.
 */
export async function fetchACPSessionMessages(sessionId: string): Promise<SendMessageResponse[]> {
  const res = await fetch(`${ACP_BASE_URL}/acp/session/${encodeURIComponent(sessionId)}/messages`)
  if (res.status === 404) return []
  if (!res.ok) throw new Error(`ACP request failed: ${res.status}`)
  const body = (await res.json()) as { messages: SendMessageResponse[] }
  return body.messages ?? []
}

/** Drop the sidecar's persisted state for a deleted session (fire-and-forget). */
export function deleteACPSession(sessionId: string): Promise<void> {
  return request(`/acp/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
}

/** Resolves when the turn completes (the sidecar blocks until StopReason). */
export function promptACPSession(sessionId: string, text: string): Promise<{ stopReason: string }> {
  return request(`/acp/session/${encodeURIComponent(sessionId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  })
}

/** Reply to a suspended ACP permission request (permission-dock). */
export function replyACPPermission(
  sessionId: string,
  permissionId: string,
  reply: "once" | "always" | "reject",
): Promise<void> {
  return request(`/acp/session/${encodeURIComponent(sessionId)}/permission`, {
    method: "POST",
    body: JSON.stringify({ permissionId, reply }),
  })
}

export function cancelACPSession(sessionId: string): Promise<void> {
  return request(`/acp/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" })
}

export function acpEventsURL(sessionId: string): string {
  return `${ACP_BASE_URL}/acp/session/${encodeURIComponent(sessionId)}/events`
}
