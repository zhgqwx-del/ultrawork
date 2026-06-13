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

  // --- Factory ---

  describe("createApiClient", () => {
    it("returns an ApiClient instance", () => {
      const c = createApiClient({ baseUrl: "http://localhost:4096" })
      expect(c).toBeInstanceOf(ApiClient)
      expect(c.getBaseUrl()).toBe("http://localhost:4096")
    })
  })
})
