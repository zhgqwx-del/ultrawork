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
  ProviderConfigModel,
  CustomProviderDef,
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Recursively merge `patch` into `base`, returning a new object. Nested plain
 * objects merge; arrays and scalars from `patch` REPLACE `base` (matching
 * opencode's mergeDeep array-replace semantics). Used to let a custom model's
 * "advanced JSON" override the structured fields the form built.
 */
function deepMergePlain<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k]
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMergePlain(prev, v) : v
  }
  return out as T
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

  /**
   * The workspace directory this client is scoped to (sent as
   * `x-opencode-directory`). Custom-provider config persists per-workspace, so
   * the UI must guard against an empty value (see discussion 006 §11.9).
   */
  getWorkingDirectory(): string | undefined {
    return this.workingDirectory
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

  /** Remove a provider's stored API key (auth.json). */
  async deleteProviderAuth(authId: string): Promise<void> {
    await this.request<void>(`/auth/${authId}`, { method: "DELETE" })
  }

  /**
   * Create or update a user-defined custom provider (OpenAI-compatible or
   * Anthropic protocol). Writes the provider definition to opencode.json via
   * PATCH /config and the API key (if any) to auth.json via PUT /auth.
   *
   * Persists to the CURRENT workspace's opencode.json (per-workspace scope) —
   * `getWorkingDirectory()` must be non-empty or the request hits a drifting
   * default instance (discussion 006 §11.9).
   */
  async upsertCustomProvider(def: CustomProviderDef): Promise<void> {
    const npm = def.protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    const models: Record<string, ProviderConfigModel> = {}
    for (const m of def.models) {
      const base: ProviderConfigModel = {
        id: m.id,
        name: m.name || m.id,
        // Capability flags. tool_call defaults to true (most models support it);
        // the others only emit when explicitly enabled.
        tool_call: m.toolCall ?? true,
        ...(m.reasoning ? { reasoning: true } : {}),
        ...(m.attachment ? { attachment: true } : {}),
        // Image input → modalities. opencode maps modalities.input/output to the
        // text/image/… capability flags (vendor provider.ts fromModelsDevModel).
        ...(m.vision ? { modalities: { input: ["text", "image"], output: ["text"] } } : {}),
        // opencode's model schema requires BOTH context and output inside `limit`
        // — a partial `{ context }` is rejected (400). Only emit when both present.
        ...(m.context != null && m.output != null
          ? { limit: { context: m.context, output: m.output } }
          : {}),
      }
      // The "advanced JSON" escape hatch wins: deep-merge it LAST so a user can
      // set `options`/`headers`/`cost` or override any structured field above.
      models[m.id] = m.advanced ? deepMergePlain(base, m.advanced) : base
    }
    // API key goes to auth.json (PUT /auth), never into opencode.json plaintext.
    if (def.apiKey?.trim()) {
      await this.putProviderAuth(def.id, def.apiKey.trim())
    }
    await this.patchConfig({
      provider: {
        [def.id]: {
          name: def.name,
          npm,
          api: def.baseURL,
          options: { baseURL: def.baseURL },
          models,
          // Pin the exposed set to exactly these models. A prior delete→re-add can
          // leave stale models in the (un-removable) config `models` map; whitelist
          // (array → replaced on merge) hides them. See discussion 006 §11.10.
          whitelist: def.models.map((m) => m.id),
        },
      },
    })
    // A prior delete only hid the provider via `disabled_providers` (the config key
    // persists); re-adding the same id must clear that flag or it stays invisible.
    await this.setProviderDisabled(def.id, false)
  }

  /**
   * Hide/unhide a provider via opencode's `disabled_providers` list. Used to
   * "delete" a custom provider (PATCH can't remove a config key). Reads the
   * current list and writes back the full array (mergeDeep replaces arrays).
   */
  async setProviderDisabled(providerId: string, disabled: boolean): Promise<void> {
    const config = await this.getConfig()
    const current = Array.isArray(config.disabled_providers) ? config.disabled_providers : []
    const has = current.includes(providerId)
    if (disabled === has) return
    const next = disabled ? [...current, providerId] : current.filter((id) => id !== providerId)
    await this.patchConfig({ disabled_providers: next })
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
