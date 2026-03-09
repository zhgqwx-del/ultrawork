import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock api-client
const mockCreateSession = vi.fn()
const mockPromptAsync = vi.fn()
const mockReplyPermission = vi.fn()
const mockRejectQuestion = vi.fn()
const mockListPermissions = vi.fn()
const mockListQuestions = vi.fn()
const mockGetConfig = vi.fn()

vi.mock("@agent/api-client", () => ({
  createApiClient: vi.fn(() => ({
    createSession: mockCreateSession,
    promptAsync: mockPromptAsync,
    replyPermission: mockReplyPermission,
    rejectQuestion: mockRejectQuestion,
    listPermissions: mockListPermissions,
    listQuestions: mockListQuestions,
    getConfig: mockGetConfig,
  })),
}))

// Mock global fetch for SSE
const mockFetch = vi.fn()

import { Bridge } from "../bridge.js"
import type { IncomingMessage } from "../types.js"

function createMessage(overrides?: Partial<IncomingMessage>): IncomingMessage {
  return {
    chatId: "user-1",
    senderId: "sender-1",
    senderName: "Sender",
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
  mockGetConfig.mockResolvedValue({ model: "anthropic/claude-sonnet-4-20250514" })

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
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-1", "hello", { model: "anthropic/claude-sonnet-4-20250514" })
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
      expect(mockPromptAsync).toHaveBeenCalledWith("sess-1", "second", { model: "anthropic/claude-sonnet-4-20250514" })
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

      // No reply for empty text
      expect(msg.reply).not.toHaveBeenCalled()
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

      expect(msg.reply).not.toHaveBeenCalled()
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

      expect(msg.reply).not.toHaveBeenCalled()
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

      const replyArg = (msg.reply as ReturnType<typeof vi.fn>).mock.calls[0][0]
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
      const sseControllers = (bridge as any).sseControllers
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

      const sseControllers = (bridge as any).sseControllers
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

      const clients = (bridge as any).clients
      expect(clients.size).toBe(1)
      await bridge.shutdown()
    })
  })

  describe("shutdown", () => {
    it("clears all state", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      await bridge.shutdown()

      expect((bridge as any).sseControllers.size).toBe(0)
      expect((bridge as any).pollTimers.size).toBe(0)
      expect((bridge as any).activeContexts.size).toBe(0)
      expect((bridge as any).sessionMap.size).toBe(0)
      expect((bridge as any).clients.size).toBe(0)
      expect((bridge as any).queues.size).toBe(0)
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

      expect(msg.reply).not.toHaveBeenCalled()
      await bridge.shutdown()
    })
  })
})
