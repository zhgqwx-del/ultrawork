import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock api-client
const mockCreateSession = vi.fn()
const mockPromptAsync = vi.fn()
const mockReplyPermission = vi.fn()
const mockRejectQuestion = vi.fn()
const mockReplyQuestion = vi.fn()
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
    replyQuestion: mockReplyQuestion,
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

/**
 * opencode announces a message before any of its parts (prompt.ts creates the
 * assistant message via updateMessage, then the processor emits parts). The
 * bridge relies on that ordering to tell assistant output from the user's own
 * echoed parts, so tests must reproduce it.
 */
function emitAssistantMessage(
  handleSSE: (e: unknown) => void,
  { sessionID = "sess-1", id = "m1" }: { sessionID?: string; id?: string } = {},
): void {
  handleSSE({
    type: "message.updated",
    properties: { info: { id, sessionID, role: "assistant" } },
  })
}

const ACK = "⏳ 收到，正在处理"
const EMPTY_NOTICE = "✅ 处理完成，但本轮没有产生文本回复。"

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
  mockReplyQuestion.mockResolvedValue(undefined)
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
      emitAssistantMessage(handleSSE)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            messageID: "m1",
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
      emitAssistantMessage(handleSSE)

      // text-start: the full part announces the type; deltas carry none
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "" },
        },
      })

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
      emitAssistantMessage(handleSSE)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "Part 1" },
        },
      })

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p2", content: "Part 2" },
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
      emitAssistantMessage(handleSSE)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "tool-call", sessionID: "sess-1", messageID: "m1", id: "t1" },
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // The notice is the only thing sent: it cancels the not-yet-due ack
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith(EMPTY_NOTICE)
      await bridge.shutdown()
    })

    it("never forwards reasoning to the channel", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      // reasoning-start, then reasoning-delta — which opencode emits with the
      // SAME `field: "text"` as real text deltas (processor.ts). Attribution can
      // only come from the part type learned here.
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "reasoning", sessionID: "sess-1", messageID: "m1", id: "r1", text: "" },
        },
      })
      handleSSE({
        type: "message.part.delta",
        properties: { sessionID: "sess-1", partID: "r1", field: "text", delta: "The user greeted me. I should…" },
      })

      // Real answer
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "" } },
      })
      handleSSE({
        type: "message.part.delta",
        properties: { sessionID: "sess-1", partID: "p1", field: "text", delta: "你好！" },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("你好！")
      expect(msg.reply).not.toHaveBeenCalledWith(expect.stringContaining("The user greeted me"))
      await bridge.shutdown()
    })

    it("never echoes the user's own parts back (including synthetic ones)", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      // opencode broadcasts the user's parts too — same type "text", different
      // message. It also injects synthetic user parts mid-turn.
      handleSSE({
        type: "message.updated",
        properties: { info: { id: "m0", sessionID: "sess-1", role: "user" } },
      })
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m0", id: "u1", content: "你好" } },
      })
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: {
            type: "text",
            sessionID: "sess-1",
            messageID: "m0",
            id: "u2",
            synthetic: true,
            content: "Summarize the task tool output above and continue with your task.",
          },
        },
      })

      emitAssistantMessage(handleSSE)
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "你好！有什么可以帮你的？" } },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("你好！有什么可以帮你的？")
      await bridge.shutdown()
    })

    it("keeps the turn alive while only reasoning streams (no premature force-send)", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "reasoning", sessionID: "sess-1", messageID: "m1", id: "r1", text: "" } },
      })

      // A long think: reasoning deltas keep arriving, no text parts at all.
      // These are dropped from the reply, but they must still count as activity —
      // otherwise the 180s idle fallback force-sends an empty turn mid-thought.
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(120_000)
        handleSSE({
          type: "message.part.delta",
          properties: { sessionID: "sess-1", partID: "r1", field: "text", delta: "thinking…" },
        })
      }

      // 10 minutes of pure reasoning: the user got the ack (the turn stayed
      // silent long enough to deserve one) and nothing else.
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith(ACK)

      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "Done." } },
      })
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledWith("Done.")
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

  describe("progressive delivery + ack", () => {
    const LONG = "段落一".repeat(100) // > 200 chars

    function streamText(bridge: Bridge, text: string, partId = "p1") {
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: partId, content: text },
        },
      })
    }

    it("sends a finished block before the turn ends", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      emitAssistantMessage((bridge as any).handleSSEEvent.bind(bridge))

      streamText(bridge, `${LONG}\n\n还在写后面的部分`)

      // The block goes out immediately — the user is not left staring at nothing
      expect(msg.reply).toHaveBeenCalledWith(LONG)
      expect(msg.reply).not.toHaveBeenCalledWith(expect.stringContaining("还在写"))
      await bridge.shutdown()
    })

    it("sends only the un-streamed remainder at the end", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      streamText(bridge, `${LONG}\n\n收尾`)
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      const sent = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.map(([t]) => t)
      expect(sent).toEqual([LONG, "收尾"]) // the streamed block is not repeated
      await bridge.shutdown()
    })

    it("skips the ack when the answer arrives quickly", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      streamText(bridge, "秒回")
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Even past the point the ack was due it must not arrive: the answer beat
      // it, and a trailing "still working" would be nonsense.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith("秒回")
      await bridge.shutdown()
    })

    it("still acks when the agent stays silent", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      await vi.advanceTimersByTimeAsync(2_500)

      expect(msg.reply).toHaveBeenCalledWith(ACK)
      await bridge.shutdown()
    })

    it("cancels the ack once a block goes out", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      emitAssistantMessage((bridge as any).handleSSEEvent.bind(bridge))

      await vi.advanceTimersByTimeAsync(2_000) // ack still pending
      streamText(bridge, `${LONG}\n\n继续`)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(msg.reply).not.toHaveBeenCalledWith(ACK)
      await bridge.shutdown()
    })

    it("caps a streamed block at the platform limit, not just the final reply", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      emitAssistantMessage((bridge as any).handleSSEEvent.bind(bridge))

      // One huge paragraph is a legitimate block. Before the cap moved into
      // send(), streamed blocks bypassed truncation entirely and went out at
      // full length — over every channel's message limit.
      streamText(bridge, `${"长".repeat(25_000)}\n\n尾巴`)

      const sent = (msg.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
      expect(sent.length).toBeLessThanOrEqual(20_000 + "\n\n...(truncated)".length)
      expect(sent).toContain("...(truncated)")
      await bridge.shutdown()
    })

    it("does not interleave blocks with a question on screen", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      handleSSE({
        type: "question.asked",
        properties: {
          id: "q-1",
          sessionID: "sess-1",
          questions: [
            { question: "A 还是 B？", header: "选择", options: [{ label: "A", description: "" }] },
          ],
        },
      })

      streamText(bridge, `${LONG}\n\n后续`)

      // Pushing text under a pending question would bury it — hold the block
      expect(msg.reply).not.toHaveBeenCalledWith(LONG)
      await bridge.shutdown()
    })
  })

  describe("handleSSEEvent — session.status idle", () => {
    it("sends an empty-turn notice when the turn produced no text", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      // Silence would read as the bot ignoring the user — say something instead
      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith(EMPTY_NOTICE)
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

      // Nothing sent: the turn is still running and the ack is not due yet
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
      emitAssistantMessage(handleSSE)
      const longText = "x".repeat(25_000)

      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: longText },
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

  describe("handleSSEEvent — question", () => {
    const QUESTIONS = [
      {
        question: "用 A 方案还是 B 方案？",
        header: "方案选择",
        options: [
          { label: "A 方案", description: "第一种" },
          { label: "B 方案", description: "第二种" },
        ],
      },
    ]

    function askQuestion(bridge: Bridge, id = "q-1") {
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "question.asked",
        properties: { id, sessionID: "sess-1", questions: QUESTIONS },
      })
    }

    it("asks the user instead of rejecting", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      askQuestion(bridge)

      expect(mockRejectQuestion).not.toHaveBeenCalled()
      expect(msg.reply).toHaveBeenLastCalledWith(expect.stringContaining("1. A 方案"))
      await bridge.shutdown()
    })

    it("routes the next message into the question rather than a new prompt", async () => {
      const bridge = new Bridge()
      const first = createMessage({ text: "帮我改造这个模块" })
      await bridge.handleMessage(first)
      expect(mockPromptAsync).toHaveBeenCalledTimes(1)

      askQuestion(bridge)

      const answer = createMessage({ text: "2" })
      await bridge.handleMessage(answer)

      expect(mockReplyQuestion).toHaveBeenCalledWith("q-1", [["B 方案"]])
      // The session is busy inside the blocked tool — a prompt here would 409
      expect(mockPromptAsync).toHaveBeenCalledTimes(1)
      await bridge.shutdown()
    })

    it("re-asks on an unparsable answer and stays pending", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())
      askQuestion(bridge)

      const bad = createMessage({ text: "9" })
      await bridge.handleMessage(bad)

      expect(mockReplyQuestion).not.toHaveBeenCalled()
      expect(mockPromptAsync).toHaveBeenCalledTimes(1) // no fall-through
      expect(bad.reply).toHaveBeenCalledWith(expect.stringContaining("超出范围"))

      // Still waiting: a valid answer now goes through
      const good = createMessage({ text: "1" })
      await bridge.handleMessage(good)
      expect(mockReplyQuestion).toHaveBeenCalledWith("q-1", [["A 方案"]])
      await bridge.shutdown()
    })

    it("lets the user skip", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())
      askQuestion(bridge)

      await bridge.handleMessage(createMessage({ text: "/skip" }))

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      expect(mockReplyQuestion).not.toHaveBeenCalled()
      await bridge.shutdown()
    })

    it("suspends the idle fallback while waiting for the user", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "先说一句" } },
      })

      askQuestion(bridge)

      // A blocked question emits nothing for as long as the user takes to read
      // it. The 3-min idle fallback must not fire a partial reply underneath.
      await vi.advanceTimersByTimeAsync(600_000)
      expect(msg.reply).not.toHaveBeenCalledWith("先说一句")
      expect((bridge as any).activeContexts.has("sess-1")).toBe(true)
      await bridge.shutdown()
    })

    it("rejects and tells the user when a question goes unanswered too long", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      askQuestion(bridge)

      await vi.advanceTimersByTimeAsync(1_800_001)

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("超时"))
      await bridge.shutdown()
    })

    it("asks once when SSE and the poll deliver the same question", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      askQuestion(bridge)
      askQuestion(bridge) // duplicate delivery

      const questionMessages = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([text]) => typeof text === "string" && text.includes("1. A 方案"),
      )
      expect(questionMessages).toHaveLength(1)
      await bridge.shutdown()
    })

    it("declines a question with nothing renderable", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "question.asked",
        properties: { id: "q-1", sessionID: "sess-1", questions: [] },
      })

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      await bridge.shutdown()
    })

    it("ignores question for unknown session", async () => {
      const bridge = new Bridge()
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)

      handleSSE({
        type: "question.asked",
        properties: { id: "q-1", sessionID: "unknown", questions: QUESTIONS },
      })

      expect(mockRejectQuestion).not.toHaveBeenCalled()
      await bridge.shutdown()
    })

    it("does not leave the agent blocked when the turn ends or is reset", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())
      askQuestion(bridge)

      await bridge.handleMessage(createMessage({ text: "/new" }))

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
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
      emitAssistantMessage(handleSSE)

      // Accumulate some text first
      handleSSE({
        type: "message.part.updated",
        properties: {
          part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "Partial response" },
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
      expect(msg.reply).not.toHaveBeenCalled()
      await bridge.shutdown()
    })
  })

  describe("delta field handling", () => {
    it("accumulates 'text' field deltas", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "" } },
      })

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

    it("ignores deltas for parts never seen as assistant text", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      // Non-text field, and an unknown partID: neither may reach the chat
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
        type: "message.part.delta",
        properties: {
          sessionID: "sess-1",
          partID: "unknown-part",
          field: "text",
          delta: "orphan delta",
        },
      })

      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      expect(msg.reply).toHaveBeenCalledTimes(1)
      expect(msg.reply).toHaveBeenCalledWith(EMPTY_NOTICE)
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
