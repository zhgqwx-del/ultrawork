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
  AuthStatus,
  Agent,
  FilePartInput,
  PromptAsyncRequest,
  PromptPartInput,
  MCPConfig,
  MCPStatusMap,
  Command,
  Skill,
  FileEntry,
  FileStatusEntry,
  FileContentResponse,
  PaginatedMessagesResponse,
  PlanStep,
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

/**
 * The server accepted the connection but did not finish answering in time.
 * Distinct from ApiError because there is no status to report and the UX differs:
 * a timeout is "the backend is wedged", not "the backend said no".
 */
export class ApiTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`API request timed out after ${timeoutMs}ms: ${url}`)
    this.name = "ApiTimeoutError"
  }
}

/** Default per-request ceiling. Generous — every endpoint here is local. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Connecting an MCP server spawns a process (often `npx`, which may download on
 * first run), so it is legitimately slow in a way no other endpoint is.
 */
const MCP_TIMEOUT_MS = 180_000

/**
 * fetch + full body read under one hard ceiling.
 *
 * The deadline MUST span the body read, not just the headers: fetch resolves as
 * soon as headers arrive, so a server that answers `200` and then stalls mid-body
 * would still hang forever if the timer were cleared at that point. That is the
 * exact shape of a wedged single-threaded opencode, so it is the case worth
 * covering, not an edge case.
 *
 * Implemented with AbortController rather than `AbortSignal.timeout` because the
 * app supports macOS 10.15, whose WKWebView predates that API
 * (tauri.conf.json minimumSystemVersion).
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController()
  let timedOut = false
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true
          controller.abort()
        }, timeoutMs)
      : undefined

  // Respect a caller-supplied signal too, so an explicit cancel still wins.
  const caller = init.signal
  const onCallerAbort = () => controller.abort()
  caller?.addEventListener("abort", onCallerAbort)

  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    // Read inside the try so a stalled body trips the same deadline. Failures
    // carry no body we use (ApiError reports status/statusText), and 204 or
    // explicitly-empty responses have nothing to read.
    const skipBody =
      !response.ok ||
      response.status === 204 ||
      response.headers.get("content-length") === "0"
    return { response, text: skipBody ? "" : await response.text() }
  } catch (err) {
    if (timedOut) throw new ApiTimeoutError(url, timeoutMs)
    throw err
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    caller?.removeEventListener("abort", onCallerAbort)
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
function deepMergePlain(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k]
    out[k] = isPlainObject(prev) && isPlainObject(v) ? deepMergePlain(prev, v) : v
  }
  return out
}

export class ApiClient {
  private baseUrl: string
  private username?: string
  private password?: string
  private workingDirectory?: string
  private timeoutMs: number

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl
    this.username = config.username
    this.password = config.password
    this.workingDirectory = config.workingDirectory
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
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

  private async request<T>(path: string, options?: RequestInit, timeoutMs?: number): Promise<T> {
    const { data } = await this.requestWithResponse<T>(path, options, timeoutMs)
    return data
  }

  /**
   * Like request(), but also returns the raw Response object so callers
   * can read response headers (e.g. X-Next-Cursor for pagination).
   */
  private async requestWithResponse<T>(
    path: string,
    options?: RequestInit,
    timeoutMs?: number,
  ): Promise<{ data: T; response: Response }> {
    const headers = this.buildHeaders(options?.headers as Record<string, string>)

    const { response, text } = await fetchWithTimeout(
      `${this.baseUrl}${path}`,
      { ...options, headers },
      timeoutMs ?? this.timeoutMs,
    )

    if (!response.ok) {
      throw new ApiError(response.status, response.statusText)
    }

    // Empty responses (204 No Content, or empty body)
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

  /**
   * Busy/retrying sessions, keyed by id. The server DELETES a session's entry
   * when it goes idle, so the key set IS the busy set and absence means idle.
   *
   * This is the authority used to re-derive local busy markers after an SSE
   * reconnect: the event stream has no replay, so a `session.status:idle`
   * emitted while the stream was down is gone for good, and a marker that
   * missed its idle would otherwise keep the session spinning forever.
   */
  async getSessionStatuses(): Promise<Record<string, { type: string }>> {
    return this.request<Record<string, { type: string }>>("/session/status")
  }

  async getSession(sessionId: string): Promise<Session> {
    return this.request<Session>(`/session/${sessionId}`)
  }

  async getMessages(sessionId: string): Promise<SendMessageResponse[]> {
    return this.request<SendMessageResponse[]>(`/session/${sessionId}/message`)
  }

  /**
   * Current task-plan snapshot for a session (ADR-038). OpenCode persists
   * todos per session (SQLite), so this is the authoritative current list —
   * used to hydrate the plan panel on session open / switch-back.
   */
  async getTodos(sessionId: string): Promise<PlanStep[]> {
    return this.request<PlanStep[]>(`/session/${sessionId}/todo`)
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

  /** Read the GLOBAL config file (`~/.config/ultrawork/opencode.json`), not the
   *  merged per-workspace view. Use for editing global-scoped keys (providers). */
  async getGlobalConfig(): Promise<OpenCodeConfig> {
    return this.request<OpenCodeConfig>("/global/config")
  }

  /**
   * Update the GLOBAL config file via opencode's `Config.updateGlobal`. Unlike
   * `patchConfig` (which writes the per-workspace `<dir>/opencode.json` and needs
   * an `x-opencode-directory`), this writes `~/.config/ultrawork/opencode.json`
   * and makes the change live immediately for every workspace — no restart, no
   * workspace required (ADR-039).
   *
   * Uses `?refresh=soft` so only the config-derived caches (providers/skills/
   * agents/commands) are re-read; in-flight streaming turns in any workspace are
   * NOT aborted (a plain global config write would `disposeAll`, killing them).
   */
  async patchGlobalConfig(updates: Partial<OpenCodeConfig>): Promise<OpenCodeConfig> {
    return this.request<OpenCodeConfig>("/global/config?refresh=soft", {
      method: "PATCH",
      body: JSON.stringify(updates),
    })
  }

  /**
   * Soft-refresh the global config-derived caches (providers/skills/agents/
   * commands) WITHOUT writing config and without aborting in-flight turns. Call
   * after an external change to the global config dir that opencode can't observe
   * — e.g. a newly installed skill copied into `~/.config/ultrawork/skills/`
   * (opencode has no skill-dir watcher; the skill list is cached until refreshed).
   */
  async refreshGlobalConfig(): Promise<void> {
    await this.request<boolean>("/global/refresh", { method: "POST" })
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
   * Whether a credential exists in auth.json for this id (never returns the
   * secret). Backs the "configured" state for BYOK keys in the settings UI —
   * e.g. `search-tavily` (ADR-042); upstream has no read endpoint for auth.
   */
  async getAuthStatus(authId: string): Promise<AuthStatus> {
    return this.request<AuthStatus>(`/global/auth/${encodeURIComponent(authId)}/status`)
  }

  /**
   * Create or update a user-defined custom provider (OpenAI-compatible or
   * Anthropic protocol). Writes the provider definition to the GLOBAL
   * opencode.json via PATCH /global/config and the API key (if any) to the
   * (already-global) auth.json via PUT /auth.
   *
   * Global scope (ADR-039): the provider is visible in every workspace and the
   * change is live immediately (updateGlobal invalidates the config cache). No
   * active workspace is required.
   */
  async upsertCustomProvider(def: CustomProviderDef): Promise<void> {
    const npm = def.protocol === "anthropic" ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible"
    // PATCH merge can't delete keys: a delete→re-add of the same provider+model
    // id with builtinSearch UNchecked would silently inherit a stale
    // `options.enable_search: true` from the config residue. Read the residue so
    // we can overwrite it with an explicit false — but ONLY then (an
    // unconditional false would inject the key into every non-DashScope host's
    // request body, which strict gateways reject).
    const residueModels = await this.getGlobalConfig()
      .then((c) => c.provider?.[def.id]?.models ?? {})
      .catch(() => ({}) as Record<string, ProviderConfigModel>)
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
        // DashScope model-native web search: the flag rides the model-level
        // `options`, which opencode spreads into the request body (ADR-042).
        ...(m.builtinSearch
          ? { options: { enable_search: true } }
          : residueModels[m.id]?.options?.["enable_search"] === true
            ? { options: { enable_search: false } }
            : {}),
        // opencode's model schema requires BOTH context and output inside `limit`
        // — a partial `{ context }` is rejected (400). Only emit when both present.
        ...(m.context != null && m.output != null
          ? { limit: { context: m.context, output: m.output } }
          : {}),
      }
      // The "advanced JSON" escape hatch wins: deep-merge it LAST so a user can
      // set `options`/`headers`/`cost` or override any structured field above.
      // BUT force `id` back to the map key afterwards — opencode resolves a model
      // by its map key, so letting advanced JSON change the inner `id` would
      // desync `models[id].id` from the key (and the whitelist), producing a
      // model that can't be selected. (`name` may still be overridden; harmless.)
      const merged = m.advanced
        ? (deepMergePlain(base as Record<string, unknown>, m.advanced) as ProviderConfigModel)
        : base
      models[m.id] = { ...merged, id: m.id }
    }
    // API key goes to auth.json (PUT /auth), never into opencode.json plaintext.
    if (def.apiKey?.trim()) {
      await this.putProviderAuth(def.id, def.apiKey.trim())
    }
    await this.patchGlobalConfig({
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
   * "delete" a custom provider (PATCH can't remove a config key). Reads and
   * writes the GLOBAL config (ADR-039) so the hide is workspace-wide and matches
   * where `upsertCustomProvider` writes the provider definition. Reads/writes the
   * full array (mergeDeep replaces arrays).
   */
  async setProviderDisabled(providerId: string, disabled: boolean): Promise<void> {
    const config = await this.getGlobalConfig()
    const current = Array.isArray(config.disabled_providers) ? config.disabled_providers : []
    const has = current.includes(providerId)
    if (disabled === has) return
    const next = disabled ? [...current, providerId] : current.filter((id) => id !== providerId)
    await this.patchGlobalConfig({ disabled_providers: next })
  }

  // --- Agent ---

  async getAgents(): Promise<Agent[]> {
    return this.request<Agent[]>("/agent")
  }

  // --- Async message send ---

  async promptAsync(
    sessionId: string,
    message: string,
    options?: {
      agent?: string
      model?: string
      tools?: Record<string, boolean>
      system?: string
      /** Inlined attachments (`data:` or `file://` URLs). See FilePartInput. */
      attachments?: FilePartInput[]
    },
  ): Promise<void> {
    const parts: PromptPartInput[] = []
    // An attachment-only prompt (user pastes an image and hits enter) is legal, but
    // an empty text part is not — omit it rather than sending `{type:"text",text:""}`.
    if (message) parts.push({ type: "text", text: message })
    if (options?.attachments?.length) parts.push(...options.attachments)
    if (parts.length === 0) {
      throw new Error("promptAsync: refusing to send a prompt with no text and no attachments")
    }

    const requestBody: PromptAsyncRequest = { parts }
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

    // Safe to bound: this endpoint hands the turn off and answers 204 immediately —
    // the model's actual work streams back over SSE, not this response. Without a
    // ceiling a wedged server leaves `sending` true forever with no error path.
    const { response } = await fetchWithTimeout(
      `${this.baseUrl}/session/${sessionId}/prompt_async`,
      {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(requestBody),
      },
      this.timeoutMs,
    )

    if (!response.ok) {
      throw new Error(`promptAsync failed: ${response.status} ${response.statusText}`)
    }
    // Returns 204 No Content — no body to parse
  }

  // --- MCP ---

  async getMCP(): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>("/mcp")
  }

  // Creating/connecting an MCP server spawns a process (often `npx`, which can
  // download on first run) — the one family of endpoints here that is legitimately
  // slow, so it gets its own ceiling rather than the 30s default.
  async createMCP(name: string, config: MCPConfig): Promise<MCPStatusMap> {
    return this.request<MCPStatusMap>(
      "/mcp",
      { method: "POST", body: JSON.stringify({ name, config }) },
      MCP_TIMEOUT_MS,
    )
  }

  async connectMCP(name: string): Promise<boolean> {
    return this.request<boolean>(
      `/mcp/${encodeURIComponent(name)}/connect`,
      { method: "POST" },
      MCP_TIMEOUT_MS,
    )
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
