import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Mock dingtalk-stream SDK
const mockConnect = vi.fn()
const mockDisconnect = vi.fn()
const mockSocketCallBackResponse = vi.fn()
const mockGetConfig = vi.fn(() => ({ clientId: "test-client-id" }))
const mockRegisterCallbackListener = vi.fn()

vi.mock("dingtalk-stream", () => {
  class MockDWClient {
    connect = mockConnect
    disconnect = mockDisconnect
    socketCallBackResponse = mockSocketCallBackResponse
    getConfig = mockGetConfig
    registerCallbackListener = mockRegisterCallbackListener
    constructor(_opts: any) {}
  }
  return {
    DWClient: MockDWClient,
    TOPIC_ROBOT: "/v1.0/im/bot/messages/get",
    EventAck: { SUCCESS: "SUCCESS" },
  }
})

// Mock TokenManager
vi.mock("../../../adapters/dingtalk/token-manager.js", () => ({
  TokenManager: class MockTokenManager {
    getToken = vi.fn(async () => "mock-token")
    constructor(_clientId: string, _clientSecret: string) {}
  },
}))

const mockGlobalFetch = vi.fn()

import { DingTalkAdapter, createDingTalkAdapter } from "../../../adapters/dingtalk/dingtalk-adapter.js"
import type { ChannelConfig, IncomingMessage } from "../../../types.js"

const sampleConfig: ChannelConfig = {
  id: "ch_ding",
  type: "dingtalk",
  name: "Test DingTalk",
  clientId: "cid",
  clientSecret: "cs",
  workspaceDir: "/workspace",
  autoConnect: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(undefined)
  mockGlobalFetch.mockReset()
  vi.stubGlobal("fetch", mockGlobalFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("DingTalkAdapter", () => {
  describe("constructor", () => {
    it("initializes with config properties", () => {
      const onMessage = vi.fn()
      const adapter = new DingTalkAdapter(sampleConfig, onMessage)

      expect(adapter.id).toBe("ch_ding")
      expect(adapter.name).toBe("Test DingTalk")
      expect(adapter.type).toBe("dingtalk")
    })

    it("registers robot callback listener", () => {
      new DingTalkAdapter(sampleConfig, vi.fn())
      expect(mockRegisterCallbackListener).toHaveBeenCalledWith(
        "/v1.0/im/bot/messages/get",
        expect.any(Function),
      )
    })
  })

  describe("connect", () => {
    it("transitions to connected state", async () => {
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())
      await adapter.connect()

      expect(mockConnect).toHaveBeenCalled()
      const status = adapter.getStatus()
      expect(status.state).toBe("connected")
      expect(status.connectedAt).toBeTruthy()
    })

    it("sets error state on failure", async () => {
      mockConnect.mockRejectedValue(new Error("Auth failed"))
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      await expect(adapter.connect()).rejects.toThrow("Auth failed")
      expect(adapter.getStatus().state).toBe("error")
      expect(adapter.getStatus().error).toBe("Auth failed")
    })

    it("skips when already connected", async () => {
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())
      await adapter.connect()
      await adapter.connect() // Second call should be no-op

      expect(mockConnect).toHaveBeenCalledTimes(1)
    })

    it("skips when connecting", async () => {
      mockConnect.mockImplementation(() => new Promise(() => {})) // Never resolves
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      adapter.connect().catch(() => {})
      adapter.connect().catch(() => {}) // Should skip

      expect(mockConnect).toHaveBeenCalledTimes(1)
    })
  })

  describe("disconnect", () => {
    it("transitions to disconnected state", async () => {
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())
      await adapter.connect()
      await adapter.disconnect()

      expect(mockDisconnect).toHaveBeenCalled()
      expect(adapter.getStatus().state).toBe("disconnected")
      expect(adapter.getStatus().connectedAt).toBeUndefined()
    })

    it("handles disconnect errors gracefully", async () => {
      mockDisconnect.mockImplementation(() => { throw new Error("fail") })
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())
      await adapter.connect()

      // Should not throw
      await adapter.disconnect()
      expect(adapter.getStatus().state).toBe("disconnected")
    })
  })

  describe("getStatus", () => {
    it("returns complete status object", async () => {
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())
      await adapter.connect()

      const status = adapter.getStatus()
      expect(status).toEqual({
        id: "ch_ding",
        type: "dingtalk",
        name: "Test DingTalk",
        state: "connected",
        error: undefined,
        connectedAt: expect.any(String),
      })
    })

    it("includes error when in error state", async () => {
      mockConnect.mockRejectedValue(new Error("bad creds"))
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      try { await adapter.connect() } catch {}

      const status = adapter.getStatus()
      expect(status.state).toBe("error")
      expect(status.error).toBe("bad creds")
    })
  })

  describe("handleRobotMessage", () => {
    function simulateMessage(robotMsg: Record<string, unknown>) {
      const callback = mockRegisterCallbackListener.mock.calls[0][1]
      callback({
        headers: { messageId: "msg-123" },
        data: JSON.stringify(robotMsg),
      })
    }

    it("ACKs message immediately", () => {
      new DingTalkAdapter(sampleConfig, vi.fn())

      simulateMessage({
        text: { content: "hello" },
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "1",
        sessionWebhook: "https://example.com/webhook",
      })

      expect(mockSocketCallBackResponse).toHaveBeenCalledWith("msg-123", {
        status: "SUCCESS",
      })
    })

    it("routes single chat messages using senderId", () => {
      const onMessage = vi.fn()
      new DingTalkAdapter(sampleConfig, onMessage)

      simulateMessage({
        text: { content: "hello" },
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "1",
        sessionWebhook: "https://example.com/webhook",
      })

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "user-1",
          senderId: "user-1",
          senderName: "User 1",
          text: "hello",
          workspaceDir: "/workspace",
        }),
      )
    })

    it("routes group chat messages using group:conversationId", () => {
      const onMessage = vi.fn()
      new DingTalkAdapter(sampleConfig, onMessage)

      simulateMessage({
        text: { content: "hello group" },
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "2",
        conversationId: "conv-abc",
        sessionWebhook: "https://example.com/webhook",
      })

      expect(onMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: "group:conv-abc",
        }),
      )
    })

    it("skips empty messages", () => {
      const onMessage = vi.fn()
      const spy = vi.spyOn(console, "log").mockImplementation(() => {})
      new DingTalkAdapter(sampleConfig, onMessage)

      simulateMessage({
        text: { content: "  " },
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "1",
        sessionWebhook: "https://example.com/webhook",
      })

      expect(onMessage).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it("skips messages with no text content", () => {
      const onMessage = vi.fn()
      const spy = vi.spyOn(console, "log").mockImplementation(() => {})
      new DingTalkAdapter(sampleConfig, onMessage)

      simulateMessage({
        text: {},
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "1",
        sessionWebhook: "https://example.com/webhook",
      })

      expect(onMessage).not.toHaveBeenCalled()
      spy.mockRestore()
    })

    it("handles malformed data gracefully", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {})
      new DingTalkAdapter(sampleConfig, vi.fn())

      const callback = mockRegisterCallbackListener.mock.calls[0][1]
      callback({
        headers: { messageId: "msg-bad" },
        data: "not-json",
      })

      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to handle"),
        expect.any(Error),
      )
      spy.mockRestore()
    })

    it("reply callback uses webhook", async () => {
      const onMessage = vi.fn()
      new DingTalkAdapter(sampleConfig, onMessage)

      const webhookUrl = "https://oapi.dingtalk.com/robot/sendBySession"
      simulateMessage({
        text: { content: "hello" },
        senderId: "user-1",
        senderNick: "User 1",
        conversationType: "1",
        sessionWebhook: webhookUrl,
      })

      mockGlobalFetch.mockResolvedValueOnce({ ok: true })
      const msg: IncomingMessage = onMessage.mock.calls[0][0]
      await msg.reply("AI response")

      expect(mockGlobalFetch).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("AI response"),
        }),
      )

      // Verify markdown format
      const body = JSON.parse(mockGlobalFetch.mock.calls[0][1].body)
      expect(body.msgtype).toBe("markdown")
      expect(body.markdown.title).toBe("Agent Reply")
      expect(body.markdown.text).toBe("AI response")
    })
  })

  describe("sendMessage (REST API proactive push)", () => {
    it("sends to single chat via oToMessages/batchSend", async () => {
      mockGlobalFetch.mockResolvedValueOnce({ ok: true })
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      await adapter.sendMessage("user-1", "Hi!")

      expect(mockGlobalFetch).toHaveBeenCalledWith(
        "https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "x-acs-dingtalk-access-token": "mock-token",
          }),
        }),
      )

      const body = JSON.parse(mockGlobalFetch.mock.calls[0][1].body)
      expect(body.userIds).toEqual(["user-1"])
      expect(body.robotCode).toBe("test-client-id")
    })

    it("sends to group chat via groupMessages/send", async () => {
      mockGlobalFetch.mockResolvedValueOnce({ ok: true })
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      await adapter.sendMessage("group:conv-123", "Hi group!")

      expect(mockGlobalFetch).toHaveBeenCalledWith(
        "https://api.dingtalk.com/v1.0/robot/groupMessages/send",
        expect.any(Object),
      )

      const body = JSON.parse(mockGlobalFetch.mock.calls[0][1].body)
      expect(body.openConversationId).toBe("conv-123")
    })

    it("throws on API failure", async () => {
      mockGlobalFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("forbidden"),
      })
      const adapter = new DingTalkAdapter(sampleConfig, vi.fn())

      await expect(adapter.sendMessage("user-1", "Hi")).rejects.toThrow(
        "DingTalk sendMessage failed: 403",
      )
    })
  })

  describe("createDingTalkAdapter factory", () => {
    it("returns a DingTalkAdapter instance", () => {
      const adapter = createDingTalkAdapter(sampleConfig, vi.fn())
      expect(adapter).toBeInstanceOf(DingTalkAdapter)
      expect(adapter.id).toBe(sampleConfig.id)
    })
  })
})
