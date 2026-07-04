import { describe, it, expect, vi, beforeEach } from "vitest"
import { ApiClient, ApiError, createApiClient } from "../client"

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(data)),
    json: () => Promise.resolve(data),
  }
}

function emptyResponse(status = 204) {
  return {
    ok: true,
    status,
    statusText: "No Content",
    headers: new Headers({ "content-length": "0" }),
    text: () => Promise.resolve(""),
    json: () => Promise.reject(new Error("No body")),
  }
}

function errorResponse(status: number, statusText = "Error") {
  return {
    ok: false,
    status,
    statusText,
    headers: new Headers(),
    text: () => Promise.resolve(""),
  }
}

describe("ApiClient", () => {
  let client: ApiClient

  beforeEach(() => {
    mockFetch.mockReset()
    client = new ApiClient({
      baseUrl: "http://localhost:4096",
      username: "testuser",
      password: "testpass",
    })
  })

  // --- Constructor & Accessors ---

  describe("constructor & accessors", () => {
    it("stores config correctly", () => {
      expect(client.getBaseUrl()).toBe("http://localhost:4096")
      expect(client.getCredentials()).toEqual({
        username: "testuser",
        password: "testpass",
      })
    })

    it("handles missing username/password", () => {
      const noAuth = new ApiClient({ baseUrl: "http://localhost:4096" })
      expect(noAuth.getCredentials()).toEqual({
        username: undefined,
        password: undefined,
      })
    })
  })

  // --- Auth Headers ---

  describe("auth headers", () => {
    it("includes Basic Auth when password is set", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSessions()

      const headers = mockFetch.mock.calls[0][1].headers
      const expected = btoa("testuser:testpass")
      expect(headers["Authorization"]).toBe(`Basic ${expected}`)
    })

    it("defaults username to 'opencode' when not set", async () => {
      const noUser = new ApiClient({
        baseUrl: "http://localhost:4096",
        password: "mypass",
      })
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await noUser.listSessions()

      const headers = mockFetch.mock.calls[0][1].headers
      const expected = btoa("opencode:mypass")
      expect(headers["Authorization"]).toBe(`Basic ${expected}`)
    })

    it("omits Authorization when no password", async () => {
      const noAuth = new ApiClient({ baseUrl: "http://localhost:4096" })
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await noAuth.listSessions()

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers["Authorization"]).toBeUndefined()
    })

    it("always includes Content-Type: application/json", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSessions()

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers["Content-Type"]).toBe("application/json")
    })
  })

  // --- request() error handling ---

  describe("request error handling", () => {
    it("throws ApiError on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(401, "Unauthorized"))
      await expect(client.listSessions()).rejects.toThrow(
        "API request failed: 401 Unauthorized"
      )
      mockFetch.mockResolvedValueOnce(errorResponse(404, "Not Found"))
      try {
        await client.listSessions()
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError)
        expect((err as ApiError).status).toBe(404)
      }
    })

    it("returns undefined for 204 No Content", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      const result = await client.abortSession("test-id")
      expect(result).toBeUndefined()
    })

    it("returns undefined for content-length: 0", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(200))
      const result = await client.deleteSession("test-id")
      expect(result).toBeUndefined()
    })

    it("returns undefined for empty text body", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers({}),
        text: () => Promise.resolve(""),
      })
      const result = await client.deleteSession("test-id")
      expect(result).toBeUndefined()
    })
  })

  // --- Session CRUD ---

  describe("session operations", () => {
    it("listSessions - no params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSessions()
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:4096/session",
        expect.objectContaining({})
      )
    })

    it("listSessions - with params", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listSessions({ roots: true, limit: 50, search: "hello" })
      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain("roots=true")
      expect(url).toContain("limit=50")
      expect(url).toContain("search=hello")
    })

    it("createSession", async () => {
      const session = { id: "s1", title: "Test" }
      mockFetch.mockResolvedValueOnce(jsonResponse(session))
      const result = await client.createSession()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session")
      expect(mockFetch.mock.calls[0][1].method).toBe("POST")
      expect(result).toEqual(session)
    })

    it("createSession - with options", async () => {
      const session = { id: "s1", title: "Test" }
      mockFetch.mockResolvedValueOnce(jsonResponse(session))
      await client.createSession({ agent: "general" })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.agent).toBe("general")
    })

    it("getSession", async () => {
      const session = { id: "s1", title: "Test" }
      mockFetch.mockResolvedValueOnce(jsonResponse(session))
      const result = await client.getSession("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session/s1")
      expect(result).toEqual(session)
    })

    it("getMessages", async () => {
      const messages = [{ info: { role: "user" }, parts: [] }]
      mockFetch.mockResolvedValueOnce(jsonResponse(messages))
      const result = await client.getMessages("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session/s1/message")
      expect(result).toEqual(messages)
    })

    it("getTodos", async () => {
      const todos = [{ content: "step 1", status: "in_progress", priority: "high" }]
      mockFetch.mockResolvedValueOnce(jsonResponse(todos))
      const result = await client.getTodos("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session/s1/todo")
      expect(result).toEqual(todos)
    })

    it("deleteSession", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(true))
      await client.deleteSession("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session/s1")
      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE")
    })

    it("updateSession", async () => {
      const updated = { id: "s1", title: "New Title" }
      mockFetch.mockResolvedValueOnce(jsonResponse(updated))
      const result = await client.updateSession("s1", { title: "New Title" })
      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.title).toBe("New Title")
      expect(result).toEqual(updated)
    })
  })

  // --- Message sending ---

  describe("message operations", () => {
    it("abortSession", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.abortSession("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/session/s1/abort")
      expect(mockFetch.mock.calls[0][1].method).toBe("POST")
    })

    it("promptAsync - basic", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.parts).toEqual([{ type: "text", text: "Hello" }])
      expect(body.agent).toBeUndefined()
    })

    it("promptAsync - with agent", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello", { agent: "plan" })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.agent).toBe("plan")
    })

    it("promptAsync - with tools deny map", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello", { tools: { "orchestrator_*": false } })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools).toEqual({ "orchestrator_*": false })
    })

    it("promptAsync - with system prompt", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello", { system: "你是一个任务编排者" })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.system).toBe("你是一个任务编排者")
    })

    it("promptAsync - omits system when unset", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.system).toBeUndefined()
    })

    it("promptAsync - omits empty tools map", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        statusText: "No Content",
      })
      await client.promptAsync("s1", "Hello", { tools: {} })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.tools).toBeUndefined()
    })

    it("promptAsync - throws on error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      })
      await expect(client.promptAsync("s1", "Hello")).rejects.toThrow(
        "promptAsync failed: 500 Internal Server Error"
      )
    })
  })

  // --- Permission ---

  describe("permission operations", () => {
    it("listPermissions", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([{ id: "p1" }]))
      const result = await client.listPermissions()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/permission")
      expect(result).toEqual([{ id: "p1" }])
    })

    it("replyPermission - once", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.replyPermission("p1", "once")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toEqual({ reply: "once" })
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/permission/p1/reply"
      )
    })

    it("replyPermission - always", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.replyPermission("p1", "always")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.reply).toBe("always")
    })

    it("replyPermission - reject", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.replyPermission("p1", "reject")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.reply).toBe("reject")
    })
  })

  // --- Question ---

  describe("question operations", () => {
    it("listQuestions", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.listQuestions()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/question")
    })

    it("replyQuestion", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.replyQuestion("q1", [["option1"], ["opt2a", "opt2b"]])
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toEqual({ answers: [["option1"], ["opt2a", "opt2b"]] })
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/question/q1/reply"
      )
    })

    it("rejectQuestion", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.rejectQuestion("q1")
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/question/q1/reject"
      )
      expect(mockFetch.mock.calls[0][1].method).toBe("POST")
    })
  })

  // --- Config ---

  describe("config operations", () => {
    it("getConfig", async () => {
      const config = { model: "opencode/big-pickle" }
      mockFetch.mockResolvedValueOnce(jsonResponse(config))
      const result = await client.getConfig()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/config")
      expect(result).toEqual(config)
    })

    it("patchConfig", async () => {
      const updates = { model: "opencode/new-model" }
      mockFetch.mockResolvedValueOnce(jsonResponse(updates))
      await client.patchConfig(updates)
      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH")
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.model).toBe("opencode/new-model")
    })

    it("getGlobalConfig hits /global/config (not the per-workspace /config)", async () => {
      const config = { disabled_providers: ["x"] }
      mockFetch.mockResolvedValueOnce(jsonResponse(config))
      const result = await client.getGlobalConfig()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/global/config")
      expect(result).toEqual(config)
    })

    it("patchGlobalConfig PATCHes /global/config?refresh=soft", async () => {
      const updates = { provider: { foo: { name: "Foo" } } }
      mockFetch.mockResolvedValueOnce(jsonResponse(updates))
      await client.patchGlobalConfig(updates)
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/global/config?refresh=soft")
      expect(mockFetch.mock.calls[0][1].method).toBe("PATCH")
      expect(JSON.parse(mockFetch.mock.calls[0][1].body).provider.foo.name).toBe("Foo")
    })

    it("refreshGlobalConfig POSTs /global/refresh", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(true))
      await client.refreshGlobalConfig()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/global/refresh")
      expect(mockFetch.mock.calls[0][1].method).toBe("POST")
    })
  })

  // --- Provider ---

  describe("provider operations", () => {
    it("getProviders", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        all: [{ id: "opencode", name: "opencode", models: { "gpt-4": { id: "gpt-4", name: "GPT-4" } } }],
        default: { opencode: "gpt-4" },
        connected: ["opencode"],
      }))
      const result = await client.getProviders()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/provider")
      expect(result).toEqual([{
        id: "opencode",
        name: "opencode",
        source: undefined,
        env: undefined,
        options: undefined,
        models: [{ id: "gpt-4", name: "GPT-4" }],
        connected: ["gpt-4"],
      }])
    })

    it("getProviderAuth", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({
        openai: [{ type: "api", label: "API Key" }],
      }))
      const result = await client.getProviderAuth()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/provider/auth")
      expect(result).toEqual([{ id: "openai", name: "openai", type: "api", set: true }])
    })

    it("putProviderAuth", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.putProviderAuth("auth1", "sk-xxx")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/auth/auth1")
      expect(mockFetch.mock.calls[0][1].method).toBe("PUT")
      expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ type: "api", key: "sk-xxx" })
    })

    it("deleteProviderAuth", async () => {
      mockFetch.mockResolvedValueOnce(emptyResponse(204))
      await client.deleteProviderAuth("my-llm")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/auth/my-llm")
      expect(mockFetch.mock.calls[0][1].method).toBe("DELETE")
    })

    it("getAuthStatus hits the presence-only route (ADR-042) and URL-encodes the id", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ configured: true, type: "api" }))
      const res = await client.getAuthStatus("search-tavily")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/global/auth/search-tavily/status")
      expect(res).toEqual({ configured: true, type: "api" })
    })
  })

  // --- Custom provider ---

  describe("custom provider operations", () => {
    // Sequence (ADR-039, global scope): (optional) PUT /auth → PATCH /global/config
    // (provider def) → setProviderDisabled(false) which GETs /global/config (no-op
    // when not disabled).
    it("upsertCustomProvider (OpenAI) writes the key to auth then the global provider config", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (enable_search residue read)
      mockFetch.mockResolvedValueOnce(emptyResponse(204)) // PUT /auth
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /global/config (provider def)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (un-disable read → no-op)
      await client.upsertCustomProvider({
        id: "my-llm",
        name: "My LLM",
        protocol: "openai",
        baseURL: "https://api.example.com/v1",
        apiKey: "sk-123",
        models: [{ id: "m1", name: "Model 1", context: 8192, output: 2048 }],
      })
      // 1st: GET /global/config (residue read), 2nd: PUT /auth/my-llm
      expect(mockFetch.mock.calls[1][0]).toBe("http://localhost:4096/auth/my-llm")
      expect(mockFetch.mock.calls[1][1].method).toBe("PUT")
      // 3rd: PATCH /global/config?refresh=soft with provider def
      expect(mockFetch.mock.calls[2][0]).toBe("http://localhost:4096/global/config?refresh=soft")
      expect(mockFetch.mock.calls[2][1].method).toBe("PATCH")
      const p = JSON.parse(mockFetch.mock.calls[2][1].body).provider["my-llm"]
      expect(p.npm).toBe("@ai-sdk/openai-compatible")
      expect(p.api).toBe("https://api.example.com/v1")
      expect(p.options.baseURL).toBe("https://api.example.com/v1")
      expect(p.models.m1).toMatchObject({ id: "m1", name: "Model 1", tool_call: true, limit: { context: 8192, output: 2048 } })
      expect(p.whitelist).toEqual(["m1"]) // pins exposed models, hides delete→re-add orphans
    })

    it("upsertCustomProvider maps builtinSearch → options.enable_search (ADR-042)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /global/config (provider def)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (un-disable no-op)
      await client.upsertCustomProvider({
        id: "my-qwen",
        name: "My Qwen",
        protocol: "openai",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [
          { id: "qwen-max", name: "Qwen Max", builtinSearch: true },
          { id: "qwen-mini", name: "Qwen Mini" },
        ],
      })
      const p = JSON.parse(mockFetch.mock.calls[1][1].body).provider["my-qwen"]
      expect(p.models["qwen-max"].options).toEqual({ enable_search: true })
      expect(p.models["qwen-mini"].options).toBeUndefined()
    })

    it("re-add with builtinSearch UNchecked overwrites a stale enable_search residue with explicit false", async () => {
      // PATCH merge can't delete keys — the residue read must trigger an explicit false.
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ provider: { "my-qwen": { models: { "qwen-max": { id: "qwen-max", options: { enable_search: true } } } } } }),
      ) // GET /global/config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET un-disable
      await client.upsertCustomProvider({
        id: "my-qwen",
        name: "My Qwen",
        protocol: "openai",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [{ id: "qwen-max", name: "Qwen Max" }], // builtinSearch unchecked
      })
      const p = JSON.parse(mockFetch.mock.calls[1][1].body).provider["my-qwen"]
      expect(p.models["qwen-max"].options).toEqual({ enable_search: false })
    })

    it("no residue + unchecked builtinSearch emits NO options (don't inject the key into foreign hosts)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET residue (empty)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET un-disable
      await client.upsertCustomProvider({
        id: "my-llm2",
        name: "My LLM 2",
        protocol: "openai",
        baseURL: "https://api.example.com/v1",
        models: [{ id: "m1", name: "M1" }],
      })
      const p = JSON.parse(mockFetch.mock.calls[1][1].body).provider["my-llm2"]
      expect(p.models["m1"].options).toBeUndefined()
    })

    it("advanced JSON can override the builtinSearch-derived options (escape hatch wins)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET residue
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET un-disable
      await client.upsertCustomProvider({
        id: "my-qwen",
        name: "My Qwen",
        protocol: "openai",
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        models: [
          {
            id: "qwen-max",
            name: "Qwen Max",
            builtinSearch: true,
            advanced: { options: { enable_search: false, search_options: { forced_search: true } } },
          },
        ],
      })
      const p = JSON.parse(mockFetch.mock.calls[1][1].body).provider["my-qwen"]
      expect(p.models["qwen-max"].options).toEqual({ enable_search: false, search_options: { forced_search: true } })
    })

    it("upsertCustomProvider (Anthropic) maps npm + skips auth when no key", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /global/config (provider def)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (un-disable read → no-op)
      await client.upsertCustomProvider({
        id: "my-anth",
        name: "My Anthropic",
        protocol: "anthropic",
        baseURL: "https://gw.example.com/v1",
        models: [{ id: "c1", name: "Claude proxy" }],
      })
      // No PUT /auth (no apiKey): GET (residue) → PATCH → GET (un-disable no-op)
      expect(mockFetch).toHaveBeenCalledTimes(3)
      expect(mockFetch.mock.calls[1][0]).toBe("http://localhost:4096/global/config?refresh=soft")
      expect(mockFetch.mock.calls[1][1].method).toBe("PATCH")
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).provider["my-anth"].npm).toBe("@ai-sdk/anthropic")
    })

    it("upsertCustomProvider un-disables a re-added provider (clears disabled_providers)", async () => {
      // provider was previously deleted → still in disabled_providers
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /config (provider def)
      mockFetch.mockResolvedValueOnce(jsonResponse({ disabled_providers: ["my-llm", "other"] })) // GET /config
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /config (disabled_providers)
      await client.upsertCustomProvider({
        id: "my-llm", name: "My LLM", protocol: "openai", baseURL: "https://x/v1",
        models: [{ id: "m1", name: "M1" }],
      })
      // last PATCH writes disabled_providers without my-llm
      const last = mockFetch.mock.calls[3]
      expect(last[1].method).toBe("PATCH")
      expect(JSON.parse(last[1].body).disabled_providers).toEqual(["other"])
    })

    it("upsertCustomProvider omits a partial limit (only context) to stay schema-valid", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /config
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /config (un-disable no-op)
      await client.upsertCustomProvider({
        id: "p", name: "P", protocol: "openai", baseURL: "https://x/v1",
        models: [{ id: "m1", name: "M1", context: 8192 }], // output missing
      })
      const body = JSON.parse(mockFetch.mock.calls[1][1].body)
      // opencode requires context+output together; a lone context → no limit emitted
      expect(body.provider["p"].models.m1.limit).toBeUndefined()
    })

    it("setProviderDisabled appends to the existing disabled_providers array", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ disabled_providers: ["foo"] })) // GET /config
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /config
      await client.setProviderDisabled("my-llm", true)
      const body = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(body.disabled_providers).toEqual(["foo", "my-llm"])
    })

    it("setProviderDisabled(false) removes the id and is a no-op when absent", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ disabled_providers: ["foo", "my-llm"] }))
      mockFetch.mockResolvedValueOnce(jsonResponse({}))
      await client.setProviderDisabled("my-llm", false)
      const body = JSON.parse(mockFetch.mock.calls[1][1].body)
      expect(body.disabled_providers).toEqual(["foo"])

      // No-op when the desired state already holds (disable=false & not present):
      mockFetch.mockReset()
      mockFetch.mockResolvedValueOnce(jsonResponse({ disabled_providers: ["foo"] }))
      await client.setProviderDisabled("my-llm", false) // already absent → nothing to do
      expect(mockFetch).toHaveBeenCalledTimes(1) // only the GET ran, no PATCH
    })
  })

  // --- MCP ---

  describe("MCP operations", () => {
    it("getMCP", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}))
      await client.getMCP()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/mcp")
    })

    it("createMCP", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}))
      await client.createMCP("myserver", {
        type: "remote",
        url: "http://localhost:3001",
      })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.name).toBe("myserver")
      expect(body.config.type).toBe("remote")
    })

    it("connectMCP - URL encodes name", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(true))
      await client.connectMCP("my server")
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/mcp/my%20server/connect"
      )
    })

    it("disconnectMCP", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(true))
      await client.disconnectMCP("server1")
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/mcp/server1/disconnect"
      )
    })
  })

  // --- File operations ---

  describe("file operations", () => {
    it("getFileTree - URL encodes path", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.getFileTree("/home/user/my project")
      const url = mockFetch.mock.calls[0][0]
      expect(url).toContain(encodeURIComponent("/home/user/my project"))
    })

    it("getFileContent", async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({ type: "text/plain", content: "hello" })
      )
      const result = await client.getFileContent("/tmp/test.txt")
      expect(result).toEqual({ type: "text/plain", content: "hello" })
    })

    it("getFileStatus", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.getFileStatus()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/file/status")
    })

    it("getSessionDiff", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(["diff1"]))
      const result = await client.getSessionDiff("s1")
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/session/s1/diff"
      )
      expect(result).toEqual(["diff1"])
    })
  })

  // --- Other ---

  describe("other operations", () => {
    it("getAgents", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([{ id: "general" }]))
      const result = await client.getAgents()
      expect(result).toEqual([{ id: "general" }])
    })

    it("getSkills", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.getSkills()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/skill")
    })

    it("getCommands", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([]))
      await client.getCommands()
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4096/command")
    })

    it("getToolIds", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(["tool1"]))
      await client.getToolIds()
      expect(mockFetch.mock.calls[0][0]).toBe(
        "http://localhost:4096/experimental/tool/ids"
      )
    })
  })

  // --- Custom provider ---

  describe("upsertCustomProvider", () => {
    /** Extract the parsed body of the PATCH /global/config?refresh=soft call (ADR-039). */
    function patchedConfig() {
      const call = mockFetch.mock.calls.find(
        (c) => c[0] === "http://localhost:4096/global/config?refresh=soft" && c[1]?.method === "PATCH",
      )
      return JSON.parse(call![1].body)
    }

    it("maps capability flags, vision→modalities, and limit", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (residue read)
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH /global/config
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET /global/config (setProviderDisabled)

      await client.upsertCustomProvider({
        id: "my-llm",
        name: "My LLM",
        protocol: "openai",
        baseURL: "https://api.example.com/v1",
        models: [
          { id: "m1", name: "Model 1", context: 128000, output: 4096, toolCall: true, reasoning: true, vision: true },
          { id: "m2", name: "", toolCall: false },
        ],
      })

      const prov = patchedConfig().provider["my-llm"]
      expect(prov.npm).toBe("@ai-sdk/openai-compatible")
      expect(prov.whitelist).toEqual(["m1", "m2"])

      const m1 = prov.models["m1"]
      expect(m1.tool_call).toBe(true)
      expect(m1.reasoning).toBe(true)
      expect(m1.attachment).toBeUndefined()
      expect(m1.modalities).toEqual({ input: ["text", "image"], output: ["text"] })
      expect(m1.limit).toEqual({ context: 128000, output: 4096 })

      const m2 = prov.models["m2"]
      expect(m2.tool_call).toBe(false)
      expect(m2.name).toBe("m2") // falls back to id
      expect(m2.limit).toBeUndefined()
      expect(m2.modalities).toBeUndefined()
    })

    it("deep-merges advanced JSON, letting it override structured fields", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET residue
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET un-disable

      await client.upsertCustomProvider({
        id: "p",
        name: "P",
        protocol: "anthropic",
        baseURL: "https://gw.example.com/v1",
        models: [
          {
            id: "a",
            name: "A",
            context: 200000,
            output: 8192,
            vision: true,
            advanced: {
              options: { reasoningEffort: "high" },
              headers: { "x-foo": "bar" },
              limit: { input: 100 }, // merges into the {context,output} limit
              modalities: { input: ["text"], output: ["text"] }, // replaces vision's modalities
            },
          },
        ],
      })

      const m = patchedConfig().provider["p"].models["a"]
      expect(patchedConfig().provider["p"].npm).toBe("@ai-sdk/anthropic")
      expect(m.options).toEqual({ reasoningEffort: "high" })
      expect(m.headers).toEqual({ "x-foo": "bar" })
      // nested object deep-merges; arrays replace
      expect(m.limit).toEqual({ context: 200000, output: 8192, input: 100 })
      expect(m.modalities).toEqual({ input: ["text"], output: ["text"] })
    })

    it("never lets advanced JSON change the model id away from its map key", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET residue
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // PATCH
      mockFetch.mockResolvedValueOnce(jsonResponse({})) // GET un-disable

      await client.upsertCustomProvider({
        id: "p",
        name: "P",
        protocol: "openai",
        baseURL: "https://api.example.com/v1",
        models: [{ id: "m1", name: "M1", advanced: { id: "gpt-4o", name: "Renamed" } }],
      })

      const prov = patchedConfig().provider["p"]
      // map key stays "m1"; the model's own id is forced back to it (advanced's
      // "gpt-4o" is overridden) so resolution/whitelist can't desync. name may change.
      expect(Object.keys(prov.models)).toEqual(["m1"])
      expect(prov.models["m1"].id).toBe("m1")
      expect(prov.models["m1"].name).toBe("Renamed")
      expect(prov.whitelist).toEqual(["m1"])
    })
  })

  // --- Factory ---

  describe("createApiClient", () => {
    it("returns an ApiClient instance", () => {
      const c = createApiClient({ baseUrl: "http://localhost:4096" })
      expect(c).toBeInstanceOf(ApiClient)
      expect(c.getBaseUrl()).toBe("http://localhost:4096")
    })
  })
})
