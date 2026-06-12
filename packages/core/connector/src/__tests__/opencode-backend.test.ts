import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { OpenCodeBackend } from "../backends/opencode"

const mockApi = {
  createSession: vi.fn(),
  promptAsync: vi.fn(),
  abortSession: vi.fn(),
  revertSession: vi.fn(),
  getMessagesPaginated: vi.fn(),
  deleteSession: vi.fn(),
  replyPermission: vi.fn(),
}

const createApiClientMock = vi.fn((_config: unknown) => mockApi)

vi.mock("@agent/api-client", () => ({
  createApiClient: (config: unknown) => createApiClientMock(config),
}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

/** Stream that stays open; events are pushed manually. */
function createPushStream() {
  const encoder = new TextEncoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    stream,
    push(event: object) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
    },
  }
}

function makeBackend(overrides: Partial<ConstructorParameters<typeof OpenCodeBackend>[0]> = {}) {
  return new OpenCodeBackend({
    baseUrl: "http://localhost:4096",
    username: "opencode",
    password: "test123",
    workingDirectory: "/Users/张三/my project",
    ...overrides,
  })
}

describe("OpenCodeBackend", () => {
  let backends: OpenCodeBackend[] = []
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>

  function track(b: OpenCodeBackend): OpenCodeBackend {
    backends.push(b)
    return b
  }

  beforeEach(() => {
    mockFetch.mockReset()
    createApiClientMock.mockClear()
    Object.values(mockApi).forEach((fn) => fn.mockReset())
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
  })

  afterEach(() => {
    backends.forEach((b) => b.dispose())
    backends = []
    consoleSpies.forEach((s) => s.mockRestore())
  })

  it("builds the ApiClient through the createApiClient factory (bridge.test mock contract)", () => {
    track(makeBackend())
    expect(createApiClientMock).toHaveBeenCalledWith({
      baseUrl: "http://localhost:4096",
      username: "opencode",
      password: "test123",
      workingDirectory: "/Users/张三/my project",
    })
  })

  describe("REST delegation (strict equivalence)", () => {
    it("prompt -> promptAsync with agent/model passthrough", async () => {
      const backend = track(makeBackend())
      await backend.prompt("s1", "hello", { agent: "build", model: "anthropic/claude", boundAgentId: "default" })
      expect(mockApi.promptAsync).toHaveBeenCalledWith("s1", "hello", {
        agent: "build",
        model: "anthropic/claude",
        tools: { "orchestrator_*": false },
        system: undefined,
      })
    })

    it("prompt -> promptAsync forwards an explicit tools map verbatim", async () => {
      const backend = track(makeBackend())
      await backend.prompt("s1", "hello", { tools: { task: false } })
      expect(mockApi.promptAsync).toHaveBeenCalledWith(
        "s1",
        "hello",
        expect.objectContaining({ tools: { task: false } }),
      )
    })

    it("prompt -> denies orchestrator_* by default when no tools map given (017 #4)", async () => {
      const backend = track(makeBackend())
      await backend.prompt("s1", "hello")
      expect(mockApi.promptAsync).toHaveBeenCalledWith(
        "s1",
        "hello",
        expect.objectContaining({ tools: { "orchestrator_*": false } }),
      )
    })

    it("prompt -> forwards the per-turn system prompt", async () => {
      const backend = track(makeBackend())
      await backend.prompt("s1", "hello", { system: "leader prompt", tools: { task: false } })
      expect(mockApi.promptAsync).toHaveBeenCalledWith(
        "s1",
        "hello",
        expect.objectContaining({ system: "leader prompt", tools: { task: false } }),
      )
    })

    it("cancel -> abortSession", async () => {
      const backend = track(makeBackend())
      await backend.cancel("s1")
      expect(mockApi.abortSession).toHaveBeenCalledWith("s1")
    })

    it("revert -> revertSession", async () => {
      const backend = track(makeBackend())
      await backend.revert("s1", "m1")
      expect(mockApi.revertSession).toHaveBeenCalledWith("s1", "m1")
    })

    it("fetchHistory -> getMessagesPaginated with explicit options", async () => {
      mockApi.getMessagesPaginated.mockResolvedValueOnce({ messages: [], hasMore: false })
      const backend = track(makeBackend())
      await backend.fetchHistory("s1", { limit: 25, before: "m9" })
      expect(mockApi.getMessagesPaginated).toHaveBeenCalledWith("s1", { limit: 25, before: "m9" })
    })

    it("deleteSessionState -> deleteSession", async () => {
      const backend = track(makeBackend())
      await backend.deleteSessionState("s1")
      expect(mockApi.deleteSession).toHaveBeenCalledWith("s1")
    })

    it("replyPermission ignores sessionId and forwards id+reply", async () => {
      const backend = track(makeBackend())
      await backend.replyPermission("s1", "perm-1", "once")
      expect(mockApi.replyPermission).toHaveBeenCalledWith("perm-1", "once")
    })

    it("createSession returns a SessionRef on this backend", async () => {
      mockApi.createSession.mockResolvedValueOnce({ id: "new-session" })
      const backend = track(makeBackend())
      const ref = await backend.createSession({})
      expect(mockApi.createSession).toHaveBeenCalledWith({})
      expect(ref).toEqual({ id: "new-session", backend: "opencode", directory: "/Users/张三/my project" })
    })
  })

  describe("global SSE connection", () => {
    it("connects /event with directory query (raw) + encoded header + basic auth", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      const backend = track(makeBackend())
      backend.connectGlobal()
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())

      const [url, init] = mockFetch.mock.calls[0]
      // query param: URLSearchParams encoding of the raw path
      expect(url).toBe(
        `http://localhost:4096/event?${new URLSearchParams({ directory: "/Users/张三/my project" }).toString()}`,
      )
      // header: encodeURIComponent (legacy sse-client.ts double-track behavior)
      expect(init.headers["x-opencode-directory"]).toBe(encodeURIComponent("/Users/张三/my project"))
      expect(init.headers["Authorization"]).toBe(`Basic ${btoa("opencode:test123")}`)
    })

    it("uses relative /event URL when baseUrl is empty (dev proxy)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      const backend = track(makeBackend({ baseUrl: "", workingDirectory: undefined, password: undefined }))
      backend.connectGlobal()
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())
      expect(mockFetch.mock.calls[0][0]).toBe("/event")
      expect(mockFetch.mock.calls[0][1].headers["Authorization"]).toBeUndefined()
    })

    it("connectGlobal is idempotent", async () => {
      mockFetch.mockResolvedValue({ ok: true, body: createPushStream().stream })
      const backend = track(makeBackend())
      backend.connectGlobal()
      backend.connectGlobal()
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled())
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it("ready() resolves on first error too (gateway anti-hang semantics)", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: "boom" })
      const backend = track(makeBackend())
      await expect(backend.ready()).resolves.toBeUndefined()
      // retry is already scheduled by the time the awaiter resumes
      expect(["error", "connecting"]).toContain(backend.status())
    })

    it("status() maps transport states to coarse ConnectionStatus", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      const backend = track(makeBackend())
      expect(backend.status()).toBe("disconnected")
      await backend.ready()
      expect(backend.status()).toBe("connected")
    })
  })

  describe("subscriptions", () => {
    it("subscribeGlobal receives all events; subscribeSession filters by session id but passes global events", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })
      const backend = track(makeBackend())

      const globalEvents: string[] = []
      const sessionEvents: string[] = []
      backend.subscribeGlobal((e) => globalEvents.push(e.type))
      backend.subscribeSession("s1", (e) => sessionEvents.push(e.type))

      await backend.ready()
      push.push({ type: "server.heartbeat", properties: {} })
      push.push({ type: "message.part.delta", properties: { sessionID: "s1", messageID: "m", partID: "p", field: "text", delta: "x" } })
      push.push({ type: "message.part.delta", properties: { sessionID: "s2", messageID: "m", partID: "p", field: "text", delta: "y" } })
      push.push({ type: "message.updated", properties: { info: { sessionID: "s1", id: "m" } } })
      push.push({ type: "session.deleted", properties: { id: "s2" } })

      await vi.waitFor(() => expect(globalEvents).toHaveLength(5))
      expect(sessionEvents).toEqual(["server.heartbeat", "message.part.delta", "message.updated"])
    })

    it("unsubscribe stops delivery", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })
      const backend = track(makeBackend())

      const received: string[] = []
      const unsub = backend.subscribeGlobal((e) => received.push(e.type))
      await backend.ready()
      unsub()
      push.push({ type: "server.heartbeat", properties: {} })
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(0)
    })
  })
})
