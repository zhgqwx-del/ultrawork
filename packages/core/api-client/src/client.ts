import type {
  ApiClientConfig,
  SessionCreateRequest,
  SessionCreateResponse,
  Session,
  SendMessageRequest,
  SendMessageResponse
} from "./types"

export class ApiClient {
  private baseUrl: string
  private username?: string
  private password?: string

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl
    this.username = config.username
    this.password = config.password
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    }

    if (this.password) {
      const username = this.username || "opencode"
      const credentials = btoa(`${username}:${this.password}`)
      headers["Authorization"] = `Basic ${credentials}`
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
    return this.request<SessionCreateResponse>("/session", {
      method: "POST",
      body: JSON.stringify(request),
    })
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/session/${sessionId}`)
  }

  async sendMessage(sessionId: string, message: string): Promise<SendMessageResponse> {
    const requestBody: SendMessageRequest = {
      parts: [
        {
          type: "text",
          text: message
        }
      ]
    }

    return this.request<SendMessageResponse>(`/session/${sessionId}/message`, {
      method: "POST",
      body: JSON.stringify(requestBody),
    })
  }

  subscribeToEvents(onEvent: (data: string) => void): () => void {
    const eventSource = new EventSource(`${this.baseUrl}/event`)

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
