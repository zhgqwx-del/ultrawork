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

// Real SessionStore logic (keying, v1 fallback), disk I/O stubbed out. Tests seed
// a pre-existing mapping by pushing onto `storeSeed.entries` before bridge.init().
const storeSeed = vi.hoisted(() => ({ entries: [] as any[] }))
vi.mock("../session-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-store.js")>()
  class MemSessionStore extends actual.SessionStore {
    async load(): Promise<void> {
      for (const entry of storeSeed.entries) this.set(entry)
    }
    async save(): Promise<void> {}
  }
  return { ...actual, SessionStore: MemSessionStore }
})

// Mock global fetch for SSE
const mockFetch = vi.fn()

import { Bridge, getOpencodeBaseUrl } from "../bridge.js"
import type { IncomingMessage } from "../types.js"
import type { ChannelSessionEntry } from "../session-store.js"

/** Seed a persisted mapping as if it had been restored from disk on init(). */
function seedSession(overrides: Partial<ChannelSessionEntry> & { sessionId: string }): void {
  storeSeed.entries.push({
    chatId: "user-1",
    channelType: "dingtalk",
    senderId: "sender-1",
    senderName: "Sender",
    workspaceDir: "/workspace",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    ...overrides,
  })
}

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
  storeSeed.entries = []
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
  vi.unstubAllEnvs() // restoreAllMocks does NOT undo stubEnv — a leaked
  // ULTRAWORK_CHANNEL_IDLE_ROTATE_MS silently disables rotation in later tests
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledWith("你好！")
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledWith(ACK)

      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "Done." } },
      })
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledWith(LONG)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledWith("秒回")
      await bridge.shutdown()
    })

    it("still acks when the agent stays silent", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      await vi.advanceTimersByTimeAsync(2_500)

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      // Two picks for a single-choice question. (A bare number is NOT unparsable:
      // it is a valid typed answer when it names no option.)
      const bad = createMessage({ text: "1,2" })
      await bridge.handleMessage(bad)

      expect(mockReplyQuestion).not.toHaveBeenCalled()
      expect(mockPromptAsync).toHaveBeenCalledTimes(1) // no fall-through
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(bad.reply).toHaveBeenCalledWith(expect.stringContaining("只能选一个"))

      // Still waiting: a valid answer now goes through
      const good = createMessage({ text: "1" })
      await bridge.handleMessage(good)
      expect(mockReplyQuestion).toHaveBeenCalledWith("q-1", [["A 方案"]])
      await bridge.shutdown()
    })

    it("only accepts the answer from the person the agent asked", async () => {
      const bridge = new Bridge()
      // A group chat: one chatId, many senders
      const asker = createMessage({ chatId: "group:g1", senderId: "alice", senderName: "Alice" })
      await bridge.handleMessage(asker)

      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      handleSSE({
        type: "question.asked",
        properties: { id: "q-1", sessionID: "sess-1", questions: QUESTIONS },
      })

      // Someone else in the group says something unrelated — it is NOT an answer
      const bystander = createMessage({
        chatId: "group:g1",
        senderId: "bob",
        senderName: "Bob",
        text: "1",
      })
      await bridge.handleMessage(bystander)

      expect(mockReplyQuestion).not.toHaveBeenCalled()
      expect(mockPromptAsync).toHaveBeenCalledTimes(1) // and no BusyError-bound prompt
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(bystander.reply).toHaveBeenCalledWith(expect.stringContaining("Alice"))

      // Alice's answer still works
      await bridge.handleMessage(
        createMessage({ chatId: "group:g1", senderId: "alice", senderName: "Alice", text: "2" }),
      )
      expect(mockReplyQuestion).toHaveBeenCalledWith("q-1", [["B 方案"]])
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
      await vi.advanceTimersByTimeAsync(0)

      // The lead-in ships WITH the question, not after the thing it introduces
      expect(msg.reply).toHaveBeenCalledWith("先说一句")
      const settled = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.length

      // A blocked question emits nothing for as long as the user takes to read
      // it. The 3-min idle fallback must not fire and tear the turn down.
      await vi.advanceTimersByTimeAsync(600_000)
      await vi.advanceTimersByTimeAsync(0)
      expect((msg.reply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(settled)
      expect((bridge as any).activeContexts.has("sess-1")).toBe(true)
      expect((bridge as any).activeContexts.get("sess-1").pendingQuestion).toBeDefined()
      await bridge.shutdown()
    })

    it("rejects and tells the user when a question goes unanswered too long", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      askQuestion(bridge)

      await vi.advanceTimersByTimeAsync(1_800_001)

      expect(mockRejectQuestion).toHaveBeenCalledWith("q-1")
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("超时"))
      await bridge.shutdown()
    })

    it("asks once when SSE and the poll deliver the same question", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      askQuestion(bridge)
      askQuestion(bridge) // duplicate delivery
      await vi.advanceTimersByTimeAsync(0)

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

    it("keeps the running turn alive when the user adds a remark after answering", async () => {
      const bridge = new Bridge()
      const msg = createMessage({ text: "干活" })
      await bridge.handleMessage(msg)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      askQuestion(bridge)
      await bridge.handleMessage(createMessage({ text: "1" })) // answer

      // "回答 + 补一句" is the most natural thing to do here. opencode queues the
      // second prompt (prompt_async returns 204 mid-turn), so the context must
      // survive: a replacement would have empty assistantMessageIds and the
      // running turn's remaining output would be discarded as "not ours".
      const remark = createMessage({ text: "顺便改下标题" })
      await bridge.handleMessage(remark)

      const ctx = (bridge as any).activeContexts.get("sess-1")
      expect(ctx).toBeDefined()
      expect(ctx.assistantMessageIds.has("m1")).toBe(true) // turn 1 still recognised

      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p1", content: "选了 A 方案" } },
      })
      handleSSE({
        type: "session.status",
        properties: { sessionID: "sess-1", status: { type: "idle" } },
      })
      await vi.advanceTimersByTimeAsync(0)
      // Delivered through the newest message's reply closure — same chat either way
      expect(remark.reply).toHaveBeenCalledWith("选了 A 方案")
      await bridge.shutdown()
    })

    it("counts answering a question as activity (P1 idle clock)", async () => {
      // Answering returns early — it never reaches startTurn, where the activity
      // stamp used to live. A user can sit inside one question for many minutes
      // (QUESTION_TIMEOUT_MS is 30min); if that does not count as activity, idle
      // rotation would swap the session out from under the exchange it is waiting on.
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())

      const store = (bridge as any).store
      const before = store.get("dingtalk", "user-1").lastActiveAt
      expect(before).toBeGreaterThan(0)

      askQuestion(bridge)
      await vi.advanceTimersByTimeAsync(60_000) // user thinks it over
      await bridge.handleMessage(createMessage({ text: "1" })) // the answer

      expect(store.get("dingtalk", "user-1").lastActiveAt).toBeGreaterThan(before)
      await bridge.shutdown()
    })

    it("does not let a bystander's chatter refresh the activity clock", async () => {
      // The bystander is turned away without answering; treating that as activity
      // would let anyone in a group keep a stale session alive indefinitely.
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())
      askQuestion(bridge)

      const store = (bridge as any).store
      const before = store.get("dingtalk", "user-1").lastActiveAt
      await vi.advanceTimersByTimeAsync(60_000)
      await bridge.handleMessage(
        createMessage({ senderId: "someone-else", senderName: "Bystander", text: "在干嘛" }),
      )

      const after = store.get("dingtalk", "user-1")
      expect(after.lastActiveAt).toBe(before) // turned away → clock must not move
      expect(after.senderName).toBe("Sender") // nor may they take over the identity
      await bridge.shutdown()
    })

    it("does not re-ask a question the poll still lists after it was answered", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)

      askQuestion(bridge)
      await bridge.handleMessage(createMessage({ text: "1" }))
      await vi.advanceTimersByTimeAsync(0)

      // listQuestions() can be computed server-side before our reply lands, so it
      // still lists q-1. Re-asking would strand the user's next message on a
      // request opencode has already resolved.
      mockListQuestions.mockResolvedValueOnce([
        { id: "q-1", sessionID: "sess-1", questions: QUESTIONS },
      ])
      await vi.advanceTimersByTimeAsync(3_100)
      await vi.advanceTimersByTimeAsync(0)

      const asked = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([t]) => typeof t === "string" && t.includes("1. A 方案"),
      )
      expect(asked).toHaveLength(1)
      expect((bridge as any).activeContexts.get("sess-1")?.pendingQuestion).toBeUndefined()
      await bridge.shutdown()
    })

    it("a stray part during a pending question must not re-arm the idle fallback", async () => {
      const bridge = new Bridge()
      const msg = createMessage()
      await bridge.handleMessage(msg)
      const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
      emitAssistantMessage(handleSSE)

      askQuestion(bridge)
      await vi.advanceTimersByTimeAsync(0)
      const settled = (msg.reply as ReturnType<typeof vi.fn>).mock.calls.length

      // opencode happens to emit nothing while a question blocks — today. A
      // parallel tool in the same step, an SSE replay after a reconnect, or a
      // vendor bump could each land one part here. If that re-armed the idle
      // fallback, 3 minutes later it would reject the question the user is
      // reading, force-send a half reply and delete the context.
      handleSSE({
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "sess-1", messageID: "m1", id: "p9", content: "" } },
      })
      handleSSE({
        type: "message.part.delta",
        properties: { sessionID: "sess-1", partID: "p9", field: "text", delta: "偷跑的内容" },
      })

      await vi.advanceTimersByTimeAsync(600_000)
      await vi.advanceTimersByTimeAsync(0)

      expect((msg.reply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(settled)
      expect(mockRejectQuestion).not.toHaveBeenCalled()
      const ctx = (bridge as any).activeContexts.get("sess-1")
      expect(ctx?.pendingQuestion).toBeDefined()
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
      expect((bridge as any).store.size).toBe(0)
      expect((bridge as any).backends.size).toBe(0)
      expect((bridge as any).queues.size).toBe(0)
    })
  })

  describe("stale session recovery", () => {
    it("recreates session when cached session is stale (getSession 404)", async () => {
      // Pre-populate session map with a stale mapping
      seedSession({ sessionId: "stale-sess" })
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
      seedSession({ sessionId: "existing-sess" })
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
      expect(msg.reply).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(0) // let the send chain settle
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

describe("idle rotation (ADR-051)", () => {
  const HOUR = 3600_000

  /** Drive the session to a settled, idle state so activeContexts is empty. */
  async function settleTurn(bridge: Bridge, sessionID = "sess-1") {
    const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
    handleSSE({
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    })
    await vi.advanceTimersByTimeAsync(0)
  }

  it("reuses the session when the chat has been idle less than the threshold", async () => {
    const bridge = new Bridge()
    await bridge.handleMessage(createMessage({ text: "first" }))
    await settleTurn(bridge)

    await vi.advanceTimersByTimeAsync(59 * 60_000) // 59min — under the 60min default
    await bridge.handleMessage(createMessage({ text: "second" }))

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    await bridge.shutdown()
  })

  it("starts a fresh session once the chat has been idle past the threshold", async () => {
    mockCreateSession
      .mockResolvedValueOnce({ id: "sess-1" })
      .mockResolvedValueOnce({ id: "sess-2" })

    const bridge = new Bridge()
    await bridge.handleMessage(createMessage({ text: "first" }))
    await settleTurn(bridge)

    await vi.advanceTimersByTimeAsync(HOUR + 60_000) // 61min
    const later = createMessage({ text: "改一下刚才那个方案" })
    await bridge.handleMessage(later)

    expect(mockCreateSession).toHaveBeenCalledTimes(2)
    expect(mockPromptAsync).toHaveBeenLastCalledWith(
      "sess-2",
      "改一下刚才那个方案",
      expect.anything(),
    )
    await bridge.shutdown()
  })

  it("TELLS the user the context was cut, and keeps a way back", async () => {
    // A silent cut is the whole risk of rotation: the user says "改一下刚才那个" and
    // gets an agent with no idea what 刚才 was. Rotation must announce itself.
    mockCreateSession
      .mockResolvedValueOnce({ id: "sess-1" })
      .mockResolvedValueOnce({ id: "sess-2" })

    const bridge = new Bridge()
    await bridge.handleMessage(createMessage())
    await settleTurn(bridge)

    await vi.advanceTimersByTimeAsync(HOUR + 60_000)
    const later = createMessage({ text: "继续" })
    await bridge.handleMessage(later)

    const notice = (later.reply as ReturnType<typeof vi.fn>).mock.calls
      .map(([t]) => t)
      .find((t) => typeof t === "string" && t.includes("新会话"))
    expect(notice).toBeDefined()
    expect(notice).toContain("/resume")

    // The retired session is remembered, not deleted.
    expect((bridge as any).store.get("dingtalk", "user-1").prevSessionId).toBe("sess-1")
    await bridge.shutdown()
  })

  it("NEVER rotates while a turn is still in flight", async () => {
    // THE guardrail (Hermes ships the same rule: never auto-reset a session with
    // work in flight). With a short threshold, a user who follows up while the agent
    // is still working would otherwise rotate the session out from under the running
    // turn — its remaining output would be dropped on the floor as "not ours", and
    // ADR-050's ctx-reuse path would be defeated.
    //
    // A/B-verified: deleting the activeContexts check in shouldRotate turns this red.
    vi.stubEnv("ULTRAWORK_CHANNEL_IDLE_ROTATE_MS", "60000") // 1min
    const bridge = new Bridge()
    await bridge.handleMessage(createMessage({ text: "跑个长任务" }))
    // Deliberately do NOT settle the turn — the context stays in flight.

    await vi.advanceTimersByTimeAsync(90_000) // 90s: past the 1min threshold,
    // but still under IDLE_TIMEOUT_MS (180s), so the turn's context is alive.
    await bridge.handleMessage(createMessage({ text: "顺便改下标题" }))

    expect(mockCreateSession).toHaveBeenCalledTimes(1) // no rotation
    expect(mockPromptAsync).toHaveBeenLastCalledWith(
      "sess-1",
      "顺便改下标题",
      expect.anything(),
    )
    await bridge.shutdown()
  })

  it("a message answering a question is never treated as a rotation trigger", async () => {
    // Not the shouldRotate guardrail — this one is protected a step earlier: the
    // pendingQuestion branch consumes the message as the ANSWER and returns before
    // rotation is ever considered. Worth pinning anyway: if that early return were
    // ever reordered below the rotation check, a slow answer (QUESTION_TIMEOUT_MS
    // allows 30min of thinking) would land on a question that no longer exists.
    vi.stubEnv("ULTRAWORK_CHANNEL_IDLE_ROTATE_MS", "60000") // 1min
    const bridge = new Bridge()
    await bridge.handleMessage(createMessage())

    const handleSSE = (bridge as any).handleSSEEvent.bind(bridge)
    handleSSE({
      type: "question.asked",
      properties: {
        id: "q-1",
        sessionID: "sess-1",
        questions: [
          { id: "q1", question: "选哪个方案？", options: ["A 方案", "B 方案"] },
        ],
      },
    })

    await vi.advanceTimersByTimeAsync(5 * 60_000) // 5min of thinking — way past 1min
    await bridge.handleMessage(createMessage({ text: "1" })) // the answer

    expect(mockCreateSession).toHaveBeenCalledTimes(1) // no rotation
    expect(mockReplyQuestion).toHaveBeenCalled() // answer reached the question
    await bridge.shutdown()
  })

  it("is disabled by setting the threshold to 0", async () => {
    vi.stubEnv("ULTRAWORK_CHANNEL_IDLE_ROTATE_MS", "0")
    const bridge = new Bridge()
    await bridge.handleMessage(createMessage({ text: "first" }))
    await settleTurn(bridge)

    await vi.advanceTimersByTimeAsync(30 * 24 * HOUR) // a month
    await bridge.handleMessage(createMessage({ text: "second" }))

    expect(mockCreateSession).toHaveBeenCalledTimes(1)
    await bridge.shutdown()
  })

  describe("/resume", () => {
    async function rotate(bridge: Bridge) {
      await bridge.handleMessage(createMessage({ text: "first" }))
      await settleTurn(bridge)
      await vi.advanceTimersByTimeAsync(HOUR + 60_000)
      await bridge.handleMessage(createMessage({ text: "second" }))
      await settleTurn(bridge, "sess-2")
    }

    it("swaps back to the rotated-away session", async () => {
      mockCreateSession
        .mockResolvedValueOnce({ id: "sess-1" })
        .mockResolvedValueOnce({ id: "sess-2" })

      const bridge = new Bridge()
      await rotate(bridge)

      const resume = createMessage({ text: "/resume" })
      await bridge.handleMessage(resume)

      const store = (bridge as any).store.get("dingtalk", "user-1")
      expect(store.sessionId).toBe("sess-1") // back on the old one
      expect(store.prevSessionId).toBe("sess-2") // symmetric — can toggle back

      // And the next prompt goes to the resumed session, not a new one.
      await bridge.handleMessage(createMessage({ text: "接着上面的" }))
      expect(mockPromptAsync).toHaveBeenLastCalledWith(
        "sess-1",
        "接着上面的",
        expect.anything(),
      )
      await bridge.shutdown()
    })

    it("says so when there is nothing to resume", async () => {
      const bridge = new Bridge()
      await bridge.handleMessage(createMessage())
      await settleTurn(bridge)

      const resume = createMessage({ text: "/resume" })
      await bridge.handleMessage(resume)

      expect(resume.reply).toHaveBeenCalledWith(expect.stringContaining("没有可恢复"))
      expect(mockPromptAsync).toHaveBeenCalledTimes(1) // /resume is not a prompt
      await bridge.shutdown()
    })

    it("refuses to resume a session that no longer exists on the server", async () => {
      // Deleted from the desktop in the meantime. Without the check the next prompt
      // would 404 and silently mint yet another session, leaving the user certain
      // /resume had worked.
      mockCreateSession
        .mockResolvedValueOnce({ id: "sess-1" })
        .mockResolvedValueOnce({ id: "sess-2" })

      const bridge = new Bridge()
      await rotate(bridge)

      mockGetSession.mockRejectedValueOnce(new Error("API request failed: 404 Not Found"))
      const resume = createMessage({ text: "/resume" })
      await bridge.handleMessage(resume)

      expect(resume.reply).toHaveBeenCalledWith(expect.stringContaining("已不存在"))
      const store = (bridge as any).store.get("dingtalk", "user-1")
      expect(store.sessionId).toBe("sess-2") // stayed put
      expect(store.prevSessionId).toBeUndefined() // dead pointer cleared
      await bridge.shutdown()
    })
  })
})
