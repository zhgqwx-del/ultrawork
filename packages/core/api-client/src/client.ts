import type { ApiClientConfig, SessionCreateRequest, SessionCreateResponse, Session } from "./types"

export class ApiClient {
  private baseUrl: string
  private password?: string

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl
    this.password = config.password
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    }

    if (this.password) {
      headers["Authorization"] = `Bearer ${this.password}`
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      throw new Error(`API request failed: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<T>
  }

  async createSession(request: SessionCreateRequest = {}): Promise<SessionCreateResponse> {
    return this.request<SessionCreateResponse>("/api/session", {
      method: "POST",
      body: JSON.stringify(request),
    })
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/api/session/${sessionId}`)
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    await this.request(`/api/session/${sessionId}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt }),
    })
  }

  subscribeToEvents(sessionId: string, onEvent: (data: string) => void): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/api/session/${sessionId}/events`)

    eventSource.onmessage = (ev) => {
      onEvent(ev.data)
    }
    eventSource.onerror = (error) => {
      console.error("SSE connection error:", error)
    }

    return () => eventSource.close()
  }
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config)
}
