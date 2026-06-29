import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { ACPBackend, toBindingEntries } from "../backends/acp"

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

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

describe("ACPBackend", () => {
  let backend: ACPBackend
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>

  beforeEach(() => {
    mockFetch.mockReset()
    backend = new ACPBackend()
    consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ]
  })

  afterEach(() => {
    backend.dispose()
    consoleSpies.forEach((s) => s.mockRestore())
  })

  describe("prompt (lazy ensure + turn-blocking prompt)", () => {
    it("reuses an existing sidecar session, then prompts", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s1", agentId: "claude" })) // GET session — exists
        .mockResolvedValueOnce(jsonResponse({ stopReason: "end_turn" })) // POST prompt

      await backend.prompt("s1", "hello", { boundAgentId: "claude", directory: "/ws" })

      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4099/acp/session/s1")
      const [promptUrl, promptInit] = mockFetch.mock.calls[1]
      expect(promptUrl).toBe("http://localhost:4099/acp/session/s1/prompt")
      expect(JSON.parse(promptInit.body)).toEqual({ text: "hello" })
    })

    it("creates the sidecar session when missing (404)", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "unknown session" }, 404)) // GET session
        .mockResolvedValueOnce(jsonResponse({ sessionId: "s1" }, 201)) // POST session
        .mockResolvedValueOnce(jsonResponse({ stopReason: "end_turn" })) // POST prompt

      await backend.prompt("s1", "hello", { boundAgentId: "claude", directory: "/ws" })

      const [createUrl, createInit] = mockFetch.mock.calls[1]
      expect(createUrl).toBe("http://localhost:4099/acp/session")
      expect(JSON.parse(createInit.body)).toEqual({ agentId: "claude", cwd: "/ws", clientSessionId: "s1" })
    })

    it("rejects without a workspace directory (legacy error message)", async () => {
      await expect(backend.prompt("s1", "hi", { boundAgentId: "claude" })).rejects.toThrow(
        /Session has no workspace directory/,
      )
      expect(mockFetch).not.toHaveBeenCalled()
    })
  })

  describe("createSession", () => {
    it("parses namespaced agent ids and binds clientSessionId", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ sessionId: "client-1" }, 201))
      const ref = await backend.createSession({
        agentId: "acp:qoder",
        directory: "/ws",
        clientSessionId: "client-1",
      })
      expect(ref).toEqual({ id: "client-1", backend: "acp", directory: "/ws" })
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body).toEqual({ agentId: "qoder", cwd: "/ws", clientSessionId: "client-1" })
    })
  })

  describe("deleteSessionState", () => {
    it("swallows 404s and a dead sidecar (deletion must not block)", async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ error: "unknown session" }, 404))
      await expect(backend.deleteSessionState("s1")).resolves.toBeUndefined()
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))
      await expect(backend.deleteSessionState("s1")).resolves.toBeUndefined()
    })
  })

  describe("fetchHistory", () => {
    it("returns the whole shaped history with no cursor", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ info: { id: "m1" }, parts: [] }] }),
      })
      const result = await backend.fetchHistory("s1")
      expect(result.messages).toHaveLength(1)
      expect(result.hasMore).toBe(false)
    })

    it("resolves empty for unknown sessions (404)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      const result = await backend.fetchHistory("s1")
      expect(result.messages).toEqual([])
    })
  })

  describe("getPlan (ADR-038)", () => {
    it("fetches the plan snapshot from /acp/session/:id/plan", async () => {
      const entries = [{ content: "a", status: "in_progress", priority: "high" }]
      mockFetch.mockResolvedValueOnce(jsonResponse({ entries }))
      const result = await backend.getPlan("s1")
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4099/acp/session/s1/plan")
      expect(result).toEqual(entries)
    })

    it("resolves empty for unknown sessions (404)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
      await expect(backend.getPlan("s1")).resolves.toEqual([])
    })

    it("declares plan capability", () => {
      expect(backend.capabilities.plan).toBe(true)
    })
  })

  describe("subscribeSession — refcounted shared pool (legacy use-acp-sse semantics)", () => {
    it("multiplexes one stream across subscribers and closes on last release", async () => {
      const push = createPushStream()
      mockFetch.mockResolvedValueOnce({ ok: true, body: push.stream })

      const a: string[] = []
      const b: string[] = []
      const unsubA = backend.subscribeSession("s1", (e) => a.push(e.type))
      const unsubB = backend.subscribeSession("s1", (e) => b.push(e.type))

      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
      expect(mockFetch.mock.calls[0][0]).toBe("http://localhost:4099/acp/session/s1/events")

      push.push({ type: "acp.connected", properties: { sessionId: "s1" } })
      push.push({ type: "heartbeat", properties: {} })
      push.push({ type: "message.updated", properties: { info: { sessionID: "s1", id: "m1" } } })
      await vi.waitFor(() => expect(a).toHaveLength(1))

      // transport frames filtered; both subscribers got the real event
      expect(a).toEqual(["message.updated"])
      expect(b).toEqual(["message.updated"])

      // releasing one keeps the stream; releasing the last closes it
      unsubA()
      push.push({ type: "message.updated", properties: { info: { sessionID: "s1", id: "m2" } } })
      await vi.waitFor(() => expect(b).toHaveLength(2))
      expect(a).toHaveLength(1)

      unsubB()
      // resubscribe opens a NEW connection (pool entry was dropped)
      mockFetch.mockResolvedValueOnce({ ok: true, body: createPushStream().stream })
      backend.subscribeSession("s1", () => {})
      await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    })
  })

  describe("listAgents", () => {
    it("maps sidecar agents to namespaced UnifiedAgents", async () => {
      mockFetch
        .mockResolvedValueOnce({ ok: true }) // health
        .mockResolvedValueOnce(jsonResponse([{ id: "claude", label: "Claude", status: "connected" }]))
      const agents = await backend.listAgents()
      expect(agents).toEqual([
        { id: "acp:claude", name: "Claude", description: undefined, source: "acp", status: "connected", error: undefined },
      ])
      expect(backend.status()).toBe("connected")
    })

    it("returns empty when the sidecar is down", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"))
      const agents = await backend.listAgents()
      expect(agents).toEqual([])
      expect(backend.status()).toBe("disconnected")
    })
  })

  it("toBindingEntries namespaces sidecar agent ids", () => {
    expect(toBindingEntries([{ sessionId: "s1", agentId: "claude", cwd: "/ws", createdAt: 1 }])).toEqual([
      { sessionId: "s1", agentId: "acp:claude" },
    ])
  })
})
