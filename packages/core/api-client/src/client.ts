import type {
  ApiClientConfig,
  SessionCreateRequest,
  Session,
  SendMessageResponse,
  PermissionRequest,
  QuestionRequest,
  Provider,
  ProviderResponse,
  ProviderAuthInfo,
  ProviderAuthResponse,
  OpenCodeConfig,
  Agent,
  PromptAsyncRequest,
  MCPConfig,
  MCPStatusMap,
  Command,
  Skill,
  FileEntry,
  FileStatusEntry,
  FileContentResponse,
  PaginatedMessagesResponse,
} from "./types"

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
  ) {
    super(`API request failed: ${status} ${statusText}`)
    this.name = "ApiError"
  }
}

export class ApiClient {
  private baseUrl: string
  private username?: string
  private password?: string
  private workingDirectory?: string

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl
    this.username = config.username
    this.password = config.password
    this.workingDirectory = config.workingDirectory
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getCredentials(): { username?: string; password?: string } {
    return { username: this.username, password: this.password }
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(extra || {}),
    }

    if (this.password) {
      const username = this.username || "opencode"
      const credentials = btoa(`${username}:${this.password}`)
      headers["Authorization"] = `Basic ${credentials}`
    }

    if (this.workingDirectory) {
      headers["x-opencode-directory"] = encodeURIComponent(this.workingDirectory)
    }

    return headers
  }

  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const headers = this.buildHeaders(options?.headers as Record<string, string>)

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText)
    }

    // Handle empty responses (204 No Content, or empty body)
    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return undefined as T
    }

    const text = await response.text()
    if (!text) return undefined as T

    try {
      return JSON.parse(text) as T
    } catch {
      throw new Error(`Failed to parse API response as JSON: ${text.slice(0, 200)}`)
    }
  }

  /**
   * Like request(), but also returns the raw Response object so callers
   * can read response headers (e.g. X-Next-Cursor for pagination).
   */
  private async requestWithResponse<T>(path: string, options?: RequestInit): Promise<{ data: T; response: Response }> {
    const headers = this.buildHeaders(options?.headers as Record<string, string>)

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
    })

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText)
    }

    if (response.status === 204 || response.headers.get("content-length") === "0") {
      return { data: undefined as T, response }
    }

    const text = await response.text()
    if (!text) return { data: undefined as T, response }

    try {
      return { data: JSON.parse(text) as T, response }
    } catch {
      throw new Error(`Failed to parse API response as JSON: ${text.slice(0, 200)}`)
    }
  }

  async listSessions(options?: {
    directory?: string
    roots?: boolean
    start?: number
    search?: string
    limit?: number
  }): Promise<Session[]> {
    const params = new URLSearchParams()
    if (options?.directory) params.set("directory", options.directory)
    if (options?.roots) params.set("roots", "true")
    if (options?.start) params.set("start", options.start.toString())
    if (options?.search) params.set("search", options.search)
    if (options?.limit) params.set("limit", options.limit.toString())
    const query = params.toString()
    return this.request<Session[]>(`/session${query ? `?${query}` : ""}`)
  }

  async createSession(request: SessionCreateRequest = {}): Promise<Session> {
    return this.request<Session>("/session", {
      method: "POST",
      body: JSON.stringify(request),
    })
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/session/${sessionId}`)
  }

  async getMessages(sessionId: string): Promise<SendMessageResponse[]> {
    return this.request<SendMessageResponse[]>(`/session/${sessionId}/message`)
  }

  async getMessagesPaginated(
    sessionId: string,
    options: { limit: number; before?: string }
  ): Promise<PaginatedMessagesResponse> {
    const params = new URLSearchParams({ limit: String(options.limit) })
    if (options.before) params.set("before", options.before)
    const { data, response } = await this.requestWithResponse<SendMessageResponse[]>(
      `/session/${sessionId}/message?${params}`
    )
    const cursor = response.headers.get("X-Next-Cursor") || undefined
    return { messages: data, cursor, hasMore: !!cursor }
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request<void>(`/session/${sessionId}`, {
      method: "DELETE",
    })
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<Session> {
    return this.request<Session>(`/session/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    })
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.request<void>(`/session/${sessionId}/abort`, {
      method: "POST",
    })
  }

  async revertSession(sessionId: string, messageID: string): Promise<void> {
    await this.request<void>(`/session/${sessionId}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageID }),
    })
  }

  // --- Permission ---

  async listPermissions(): Promise<PermissionRequest[]> {
    return this.request<PermissionRequest[]>("/permission")
  }

  async replyPermission(requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    await this.request<void>(`/permission/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    })
  }

  // --- Question ---

  async listQuestions(): Promise<QuestionRequest[]> {
    return this.request<QuestionRequest[]>("/question")
  }

  async replyQuestion(requestId: string, answers: string[][]): Promise<void> {
    await this.request<void>(`/question/${requestId}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    })
  }

  async rejectQuestion(requestId: string): Promise<void> {
    await this.request<void>(`/question/${requestId}/reject`, {
      method: "POST",
    })
  }

  // --- Config ---

  async getConfig(): Promise<OpenCodeConfig> {
    return this.request<OpenCodeConfig>("/config")
  }

  async patchConfig(updates: Partial<OpenCodeConfig>): Promise<OpenCodeConfig> {
    return this.request<OpenCodeConfig>("/config", {
      method: "PATCH",
      body: JSON.stringify(updates),
    })
  }

  // --- Provider ---

  async getProviders(): Promise<Provider[]> {
    const raw = await this.request<ProviderResponse>("/provider")
    const connectedSet = new Set(raw.connected || [])
    return (raw.all || []).map((p) => {
      const models = Object.values(p.models || {})
      return {
        id: p.id,
        name: p.name,
        source: p.source,
        env: p.env,
        options: p.options,
        models,
        // If this provider is connected, all its models are available
        connected: connectedSet.has(p.id) ? models.map((m) => m.id) : [],
      }
    })
  }

  async getProviderAuth(): Promise<ProviderAuthInfo[]> {
    const raw = await this.request<ProviderAuthResponse>("/provider/auth")
    if (!raw || typeof raw !== "object") return []
    // Transform { providerId: [{type, label}] } into ProviderAuthInfo[]
    return Object.entries(raw).map(([id, methods]) => ({
      id,
      name: id,
      type: methods?.[0]?.type || "unknown",
      set: methods?.some((m) => m.type === "api") || false,
    }))
  }

  async putProviderAuth(authId: string, apiKey: string): Promise<void> {
    await this.request<void>(`/auth/${authId}`, {
      method: "PUT",
      body: JSON.stringify({ type: "api", key: apiKey }),
    })
  }

  // --- Agent ---

  async getAgents(): Promise<Agent[]> {
    return this.request<Agent[]>("/agent")
  }

  // --- Async message send ---

  async promptAsync(
    sessionId: string,
    message: string,
    options?: { agent?: string; model?: string; tools?: Record<string, boolean>; system?: string },
  ): Promise<void> {
    const requestBody: PromptAsyncRequest = {
      parts: [{ type: "text", text: message }],
    }
    if (options?.agent) {
      requestBody.agent = options.agent
    }
    if (options?.tools && Object.keys(options.tools).length > 0) {
      requestBody.tools = options.tools
    }
    // Appended after the agent's base system prompt, per message (vendor llm.ts).
    if (options?.system) {
      requestBody.system = options.system
    }
    // Parse "providerID/modelID" format into model override object
    if (options?.model && options.model.includes("/")) {
      const slashIdx = options.model.indexOf("/")
      requestBody.model = {
        providerID: options.model.substring(0, slashIdx),
        modelID: options.model.substring(slashIdx + 1),
      }
    }

    const response = await fetch(`${this.baseUrl}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(requestBody),
    })

    if (!response.ok) {
      throw new Error(`promptAsync failed: ${response.status} ${response.statusText}`)
    }
    // Returns 204 No Content — no body to parse
  }

  // --- MCP ---

  async getMCP(): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>("/mcp")
  }

  async createMCP(name: string, config: MCPConfig): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>("/mcp", {
      method: "POST",
      body: JSON.stringify({ name, config }),
    })
  }

  async connectMCP(name: string): Promise<boolean> {
    return this.request<boolean>(`/mcp/${encodeURIComponent(name)}/connect`, {
      method: "POST",
    })
  }

  async disconnectMCP(name: string): Promise<boolean> {
    return this.request<boolean>(`/mcp/${encodeURIComponent(name)}/disconnect`, {
      method: "POST",
    })
  }

  // --- Tools ---

  async getToolIds(): Promise<string[]> {
    return this.request<string[]>("/experimental/tool/ids")
  }

  // --- Skills ---

  async getSkills(): Promise<Skill[]> {
    return this.request<Skill[]>("/skill")
  }

  // --- Commands ---

  async getCommands(): Promise<Command[]> {
    return this.request<Command[]>("/command")
  }

  // --- File browsing ---

  async getFileTree(path: string): Promise<FileEntry[]> {
    return this.request<FileEntry[]>(`/file?path=${encodeURIComponent(path)}`)
  }

  async getFileContent(path: string): Promise<FileContentResponse> {
    return this.request<FileContentResponse>(`/file/content?path=${encodeURIComponent(path)}`)
  }

  async getFileStatus(): Promise<FileStatusEntry[]> {
    return this.request<FileStatusEntry[]>("/file/status")
  }

  async getSessionDiff(sessionId: string): Promise<string[]> {
    return this.request<string[]>(`/session/${sessionId}/diff`)
  }
}

export function createApiClient(config: ApiClientConfig): ApiClient {
  return new ApiClient(config)
}
