import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock api-client
const mockCreateSession = vi.fn()
const mockPromptAsync = vi.fn()
const mockReplyPermission = vi.fn()
const mockRejectQuestion = vi.fn()
const mockListPermissions = vi.fn()
const mockListQuestions = vi.fn()
const mockGetConfig = vi.fn()
const mockGetSession = vi.fn()
const mockUpdateSession = vi.fn()

vi.mock("@agent/api-client", () => ({
  createApiClient: vi.fn(() => ({
    createSession: mockCreateSession,
    promptAsync: mockPromptAsync,
    replyPermission: mockReplyPermission,
    rejectQuestion: mockRejectQuestion,
    listPermissions: mockListPermissions,
    listQuestions: mockListQuestions,
    getConfig: mockGetConfig,
    getSession: mockGetSession,
    updateSession: mockUpdateSession,
  })),
}))

// Mock session-store to avoid disk I/O in tests
vi.mock("../session-store.js", () => ({
  loadSessionMap: vi.fn(async () => new Map()),
  saveSessionMap: vi.fn(async () => {}),
}))

// Mock global fetch for SSE
const mockFetch = vi.fn()

import { Bridge, getOpencodeBaseUrl } from "../bridge.js"
import type { IncomingMessage } from "../types.js"
import { loadSessionMap } from "../session-store.js"

function createMessage(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    chatId: "user-1",
    senderId: "sender-1",
    senderName: "Sender",
    channelType: "dingtalk",
    text: "hello",
    workspaceDir: "/workspace",
    raw: {},
    reply: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubGlobal("fetch", mockFetch)

  mockCreateSession.mockResolvedValue({ id: "sess-1" })
  mockPromptAsync.mockResolvedValue(undefined)
  mockReplyPermission.mockResolvedValue(undefined)
  mockRejectQuestion.mockResolvedValue(undefined)
  mockListPermissions.mockResolvedValue([])
  mockListQuestions.mockResolvedValue([])
  mockGetConfig.mockResolvedValue({ model: "anthropic/claude-sonnet-4-20250514", tools: { "orchestrator_*": false } })
  mockGetSession.mockResolvedValue({ id: "sess-1", title: "Auto generated title" })
  mockUpdateSession.mockResolvedValue({})

  // Default SSE mock — never-resolving read to keep connection alive
  mockFetch.mockResolvedValue({
    ok: true,
    body: {
      getReader: () => ({
        read: () => new Promise(() => {}), // hangs forever
      }),
    },
  })
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("Bridge", () => {
  describe("handleMessage — session management", () => {
    it("creates a new session for unknown chatId", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      expect(mockCreateSession).toHaveBeenCalledWith({})
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-1", "hello", { model: "anthropic/claude-sonnet-4-20250514", tools: { "orchestrator_*": false } })
      await bridge.shutdown()
    })

    it("reuses existing session for same chatId", async () => {
      const bridge = new Bridge()
      const msg1 = createMessage({ text: "first" })
      const msg2 = createMessage({ text: "second" })

      await bridge.handleMessage(msg1)
      await bridge.handleMessage(msg2)

      expect(mockCreateSession).toHaveBeenCalledTimes(1)
      expect(mockPromptAsync).toHaveBeenCalledTimes(2)
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-1", "second", { model: "anthropic/claude-sonnet-4-20250514", tools: { "orchestrator_*": false } })
      await bridge.shutdown()
    })

    it("creates separate sessions for different chatIds", async () => {
      mockCreateSession
        .mockResolvedValueOnce({ id: "sess-1" })
        .mockResolvedValueOnce({ id: "sess-2" })

      const bridge = new Bridge()
      await bridge.handleMessage(createMessage({ chatId: "user-1" }))
      await bridge.handleMessage(createMessage({ chatId: "user-2" }))

      expect(mockCreateSession).toHaveBeenCalledTimes(2)
      await bridge.shutdown()
    })
  })

  describe("handleMessage — error handling", () => {
    it("replies with error when promptAsync fails", async () => {
      mockPromptAsync.mockRejectedValue(new Error("API down"))
      const bridge = new Bridge()
      const msg = createMessage()

      await bridge.handleMessage(msg)

      expect(msg.reply).toHaveBeenCalledWith(
        expect.stringContaining("Error"),
      )
      await bridge.shutdown()
    })

    it("tolerates reply failure after error", async () => {
      mockPromptAsync.mockRejectedValue(new Error("API down"))
      const msg = createMessage()
      ;(msg.reply as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("reply fail"))

      const bridge = new Bridge()
      // Should not throw
      await bridge.handleMessage(msg)
      await bridge.shutdown()
    })
  })

  describe("handleMessage — queue serialization", () => {
    it("processes messages for same chatId sequentially", async () => {
      const order: number[] = []
      mockPromptAsync
        .mockImplementationOnce(async () => {
          order.push(1)
          await new Promise((r) => setTimeout(r, 10))
        })
        .mockImplementationOnce(async () => {
          order.push(2)
        })

      const bridge = new Bridge()
      const p1 = bridge.handleMessage(createMessage({ text: "first" }))
      const p2 = bridge.handleMessage(createMessage({ text: "second" }))

      // Advance timers to let the first message's timeout resolve
      await vi.advanceTimersByTimeAsync(50)
      await Promise.all([p1, p2])

      expect(order).toEqual([1, 2])
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — text accumulation", () => {
    it("accumulates text from part.updated events", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      // Access private method for testing
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            id: "p1",
            content: "Hello world",
          },
        },
      })

      // Trigger idle → reply
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("Hello world")
      await bridge.shutdown()
    })

    it("accumulates text from part.delta events", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          partID: "p1",
          field: "content",
          delta: "Hello ",
        },
      })

      handleSSE({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          partID: "p1",
          field: "content",
          delta: "world",
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("Hello world")
      await bridge.shutdown()
    })

    it("joins multiple text parts with double newline", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: "Part 1" },
        },
      })

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p2", content: "Part 2" },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("Part 1\n\nPart 2")
      await bridge.shutdown()
    })

    it("ignores non-text parts", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "tool-call", sessionID: "sess-1", id: "t1" },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Only the instant ack, no AI reply for empty text
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith("⏳ 收到，正在处理")
      await bridge.shutdown()
    })

    it("ignores events for unknown sessions", async () => {
      const bridge = new Bridge()
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      // Should not throw
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "unknown", id: "p1", content: "test" },
        },
      })
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — session.status idle", () => {
    it("does not reply when text is empty", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Only instant ack, no AI content reply
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith("⏳ 收到，正在处理")
      await bridge.shutdown()
    })

    it("ignores non-idle status", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: "text" },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "running" } },
      })

      // Only instant ack, no AI content reply (not idle yet)
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith("⏳ 收到，正在处理")
      await bridge.shutdown()
    })

    it("cleans up active context after idle", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: "reply" },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // activeContexts should be cleared
      expect((bridge as any).activeContexts.has("sess-1")).toBe(false)
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — truncation", () => {
    it("truncates reply exceeding MAX_REPLY_LENGTH", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      const longText = "x".repeat(25_000)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: longText },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // calls[0] = instant ack, calls[1] = AI reply (truncated)
      const replyArg = (msg.reply as ReturnType<typeof vi.fn>).mock.calls[1][0]
      expect(replyArg.length).toBeLessThan(25_000)
      expect(replyArg).toContain("...(truncated)")
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — permission auto-reply", () => {
    it("auto-approves permission with 'once'", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "permission.asked",
        properties: { id: "perm-1", sessionID: "sess-1" },
      })

      expect(mockReplyPermission).toHaveBeenCalledWith("perm-1", "once")
      await bridge.shutdown()
    })

    it("ignores permission for unknown session", async () => {
      const bridge = new Bridge()
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "permission.asked",
        properties: { id: "perm-1", sessionID: "unknown" },
      })

      expect(mockReplyPermission).not.toHaveBeenCalled()
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — question auto-reject", () => {
    it("auto-rejects question", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "question.asked",
        properties: { id: "q-1", sessionID: "sess-1" },
      })

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      await bridge.shutdown()
    })

    it("ignores question for unknown session", async () => {
      const bridge = new Bridge()
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "question.asked",
        properties: { id: "q-1", sessionID: "unknown" },
      })

      expect(mockRejectQuestion).not.toHaveBeenCalled()
      await bridge.shutdown()
    })
  })

  describe("SSE connection", () => {
    it("creates one SSE connection per workspace", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws1" }))
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws1", chatId: "user-2" }))

      // Only one SSE connection should be initiated for /ws1
      const sseControllers = (bridge as any).sseSubscriptions
      expect(sseControllers.size).toBe(1)
      expect(sseControllers.has("/ws1")).toBe(true)
      await bridge.shutdown()
    })

    it("creates separate SSE connections per workspace", async () => {
      mockCreateSession
        .mockResolvedValueOnce({ id: "sess-1" })
        .mockResolvedValueOnce({ id: "sess-2" })

      const bridge = new Bridge()
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws1" }))
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws2", chatId: "user-2" }))

      const sseControllers = (bridge as any).sseSubscriptions
      expect(sseControllers.size).toBe(2)
      await bridge.shutdown()
    })
  })

  describe("polling", () => {
    it("starts polling for active session", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      const pollTimers = (bridge as any).pollTimers
      expect(pollTimers.size).toBe(1)
      await bridge.shutdown()
    })

    it("polls permission and question APIs", async () => {
      mockListPermissions.mockResolvedValue([
        { id: "perm-1", sessionID: "sess-1" },
      ])
      mockListQuestions.mockResolvedValue([
        { id: "q-1", sessionID: "sess-1" },
      ])

      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      // Advance timer to trigger poll
      await vi.advanceTimersByTimeAsync(3500)

      expect(mockListPermissions).toHaveBeenCalled()
      expect(mockReplyPermission).toHaveBeenCalledWith("perm-1", "once")
      expect(mockListQuestions).toHaveBeenCalled()
      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      await bridge.shutdown()
    })

    it("stops polling when context is cleared", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      // Clear the active context (simulating idle)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: "done" },
        },
      })
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Advance timer — poll should self-cleanup
      await vi.advanceTimersByTimeAsync(3500)
      const pollTimers = (bridge as any).pollTimers
      expect(pollTimers.size).toBe(0)
      await bridge.shutdown()
    })
  })

  describe("workspace client caching", () => {
    it("reuses client for same workspace", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws1" }))
      await bridge.handleMessage(createMessage({ workspaceDir: "/ws1", chatId: "u2" }))

      const clients = (bridge as any).backends
      expect(clients.size).toBe(1)
      await bridge.shutdown()
    })
  })

  describe("shutdown", () => {
    it("clears all state", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      await bridge.shutdown()

      expect((bridge as any).sseSubscriptions.size).toBe(0)
      expect((bridge as any).pollTimers.size).toBe(0)
      expect((bridge as any).activeContexts.size).toBe(0)
      expect((bridge as any).sessionMap.size).toBe(0)
      expect((bridge as any).backends.size).toBe(0)
      expect((bridge as any).queues.size).toBe(0)
    })
  })

  describe("stale session recovery", () => {
    it("recreates session when cached session is stale (getSession 404)", async () => {
      // Pre-populate session map with a stale mapping
      vi.mocked(loadSessionMap).mockResolvedValueOnce(
        new Map([["user-1", "stale-sess"]])
      )
      // getSession rejects for stale session, then succeeds for new
      mockGetSession
        .mockRejectedValueOnce(new Error("API request failed: 404 Not Found"))
        .mockResolvedValue({ id: "sess-1", title: "New session" })
      mockCreateSession.mockResolvedValueOnce({ id: "sess-1" })

      const bridge = new Bridge()
      await bridge.init()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      // Should have tried getSession with stale ID, then created new session
      expect(mockGetSession).toHaveBeenCalledWith("stale-sess")
      expect(mockCreateSession).toHaveBeenCalledWith({})
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-1", "hello", { model: "anthropic/claude-sonnet-4-20250514", tools: { "orchestrator_*": false } })
      await bridge.shutdown()
    })

    it("does not call getSession for newly created sessions", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      // getSession should NOT be called — session was just created
      expect(mockGetSession).not.toHaveBeenCalled()
      expect(mockCreateSession).toHaveBeenCalledWith({})
      await bridge.shutdown()
    })

    it("does not retry on non-404 getSession errors (e.g. 500)", async () => {
      vi.mocked(loadSessionMap).mockResolvedValueOnce(
        new Map([["user-1", "existing-sess"]])
      )
      mockGetSession.mockRejectedValueOnce(
        new Error("API request failed: 500 Internal Server Error")
      )
      mockCreateSession.mockResolvedValueOnce({ id: "sess-new" })

      const bridge = new Bridge()
      await bridge.init()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      // Should treat any getSession failure as stale and recreate
      expect(mockCreateSession).toHaveBeenCalledWith({})
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-new", "hello", { model: "anthropic/claude-sonnet-4-20250514", tools: { "orchestrator_*": false } })
      await bridge.shutdown()
    })

    it("cleans up old active context when session is stale", async () => {
      // First message creates a session
      const bridge = new Bridge()
      const msg1 = createMessage({ text: "first" })
      await bridge.handleMessage(msg1)

      // Manually make the session stale by making getSession fail for next call
      mockGetSession.mockRejectedValueOnce(
        new Error("API request failed: 404 Not Found")
      )
      mockCreateSession.mockResolvedValueOnce({ id: "sess-2" })
      mockGetSession.mockResolvedValue({ id: "sess-2", title: "New" })

      const msg2 = createMessage({ text: "second" })
      await bridge.handleMessage(msg2)

      // Old context should be cleaned up, new context registered
      const activeContexts = (bridge as any).activeContexts
      expect(activeContexts.has("sess-1")).toBe(false)
      expect(activeContexts.has("sess-2")).toBe(true)
      await bridge.shutdown()
    })
  })

  describe("session.error SSE event", () => {
    it("replies with error message when session.error received", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "session.error",
        properties: {
          sessionID: "sess-1",
          error: { data: { message: "Session not found" } },
        },
      })

      // Should reply with error (in addition to the instant ack)
      expect(msg.reply).toHaveBeenCalledWith(
        expect.stringContaining("error")
      )
      // Active context should be cleaned up
      expect((bridge as any).activeContexts.has("sess-1")).toBe(false)
      await bridge.shutdown()
    })

    it("flushes accumulated text on session.error instead of error message", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      // Accumulate some text first
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", id: "p1", content: "Partial response" },
        },
      })

      // Then session.error fires
      handleSSE({
        type: "session.error",
        properties: {
          sessionID: "sess-1",
          error: { data: { message: "Something broke" } },
        },
      })

      // Should flush the partial response, not send error message
      expect(msg.reply).toHaveBeenCalledWith("Partial response")
      await bridge.shutdown()
    })

    it("ignores session.error for unknown sessions", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      // Fire error for a different session
      handleSSE({
        type: "session.error",
        properties: {
          sessionID: "unknown-sess",
          error: { data: { message: "error" } },
        },
      })

      // Should not affect the active session
      expect((bridge as any).activeContexts.has("sess-1")).toBe(true)
      // Only the instant ack reply
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await bridge.shutdown()
    })
  })

  describe("delta field handling", () => {
    it("accumulates 'text' field deltas", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          partID: "p1",
          field: "text",
          delta: "hi",
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("hi")
      await bridge.shutdown()
    })

    it("ignores non-text field deltas", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          partID: "p1",
          field: "toolName",
          delta: "read",
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Only instant ack, no AI content reply (toolName delta ignored)
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith("⏳ 收到，正在处理")
      await bridge.shutdown()
    })
  })
})

// The Tauri host picks opencode's port at launch and injects it here. Reading it
// lazily (not at import time) is what lets a test — and a retrying host — change it.
describe("getOpencodeBaseUrl", () => {
  const original = process.env.OPENCODE_BASE_URL
  afterEach(() => {
    if (original === undefined) delete process.env.OPENCODE_BASE_URL
    else process.env.OPENCODE_BASE_URL = original
  })

  it("uses the base URL the host injected", () => {
    process.env.OPENCODE_BASE_URL = "http://127.0.0.1:51234"
    expect(getOpencodeBaseUrl()).toBe("http://127.0.0.1:51234")
  })

  // The negative direction: a hardcoded return would satisfy the fallback test alone.
  it("falls back to the preferred port for a standalone run", () => {
    delete process.env.OPENCODE_BASE_URL
    expect(getOpencodeBaseUrl()).toBe("http://127.0.0.1:4096")
  })

  it("is read lazily, so a port change after import is picked up", () => {
    process.env.OPENCODE_BASE_URL = "http://127.0.0.1:1111"
    expect(getOpencodeBaseUrl()).toBe("http://127.0.0.1:1111")
    process.env.OPENCODE_BASE_URL = "http://127.0.0.1:2222"
    expect(getOpencodeBaseUrl()).toBe("http://127.0.0.1:2222")
  })
})
