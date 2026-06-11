// HTTP client for the ACP Client Sidecar (:4099) — the former desktop
// agent-router.ts, function-for-function. Always absolute (no Vite proxy
// entry for :4099): the sidecar allows the dev/Tauri origins via CORS.

import type { SendMessageResponse } from "@agent/api-client"

export const ACP_DEFAULT_BASE_URL = "http://localhost:4099"

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

/** A sidecar-persisted session and its agent binding (GET /acp/sessions). */
export interface ACPSidecarSession {
  sessionId: string
  agentId: string
  cwd: string
  createdAt: number
}

export class ACPHttpClient {
  constructor(private baseUrl: string = ACP_DEFAULT_BASE_URL) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      throw new Error((body as { error?: string } | null)?.error ?? `ACP request failed: ${res.status}`)
    }
    return body as T
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/acp/health`, { signal: AbortSignal.timeout(2000) })
      return res.ok
    } catch {
      return false
    }
  }

  listAgents(): Promise<ACPAgentInfo[]> {
    return this.request<ACPAgentInfo[]>("/acp/agents")
  }

  getAgentConfig(agentId: string): Promise<ACPAgentConfig> {
    return this.request<ACPAgentConfig>(`/acp/agents/${encodeURIComponent(agentId)}/config`)
  }

  saveAgent(config: ACPAgentConfig): Promise<void> {
    const { id, ...body } = config
    return this.request(`/acp/agents/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(body),
    })
  }

  deleteAgent(agentId: string): Promise<void> {
    return this.request(`/acp/agents/${encodeURIComponent(agentId)}`, { method: "DELETE" })
  }

  connectAgent(agentId: string): Promise<void> {
    return this.request(`/acp/agents/${encodeURIComponent(agentId)}/connect`, { method: "POST" })
  }

  disconnectAgent(agentId: string): Promise<void> {
    return this.request(`/acp/agents/${encodeURIComponent(agentId)}/disconnect`, { method: "POST" })
  }

  /** All sidecar-persisted sessions — binding hydration source (ADR-030). */
  listSessions(): Promise<ACPSidecarSession[]> {
    return this.request<ACPSidecarSession[]>("/acp/sessions")
  }

  /** Create a session bound to `clientSessionId` (or a fresh sidecar id). */
  async createSession(agentId: string, cwd: string, clientSessionId?: string): Promise<string> {
    const { sessionId } = await this.request<{ sessionId: string }>("/acp/session", {
      method: "POST",
      body: JSON.stringify({ agentId, cwd, clientSessionId }),
    })
    return sessionId
  }

  /**
   * Get-or-create the ACP session bound to a desktop session. All shaped SSE
   * events carry `clientSessionId`, so the frontend needs no id translation.
   */
  async ensureSession(agentId: string, cwd: string, clientSessionId: string): Promise<void> {
    const existing = await fetch(
      `${this.baseUrl}/acp/session/${encodeURIComponent(clientSessionId)}`,
    ).catch(() => null)
    if (existing?.ok) return
    await this.createSession(agentId, cwd, clientSessionId)
  }

  /**
   * Persisted shaped history (W4b). Unknown sessions (never prompted, or
   * persistence lost) resolve to an empty list.
   */
  async fetchMessages(sessionId: string): Promise<SendMessageResponse[]> {
    const res = await fetch(`${this.baseUrl}/acp/session/${encodeURIComponent(sessionId)}/messages`)
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`ACP request failed: ${res.status}`)
    const body = (await res.json()) as { messages: SendMessageResponse[] }
    return body.messages ?? []
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request(`/acp/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" })
  }

  /** Resolves when the turn completes (the sidecar blocks until StopReason). */
  prompt(sessionId: string, text: string): Promise<{ stopReason: string }> {
    return this.request(`/acp/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    })
  }

  /** Reply to a suspended ACP permission request (permission-dock). */
  replyPermission(
    sessionId: string,
    permissionId: string,
    reply: "once" | "always" | "reject",
  ): Promise<void> {
    return this.request(`/acp/session/${encodeURIComponent(sessionId)}/permission`, {
      method: "POST",
      body: JSON.stringify({ permissionId, reply }),
    })
  }

  cancel(sessionId: string): Promise<void> {
    return this.request(`/acp/session/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" })
  }

  eventsURL(sessionId: string): string {
    return `${this.baseUrl}/acp/session/${encodeURIComponent(sessionId)}/events`
  }
}
