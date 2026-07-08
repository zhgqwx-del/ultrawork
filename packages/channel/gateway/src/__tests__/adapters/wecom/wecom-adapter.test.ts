import { describe, it, expect, vi, beforeEach } from "vitest"
import { EventEmitter } from "node:events"
import type { WeComChannelConfig, IncomingMessage } from "../../../types.js"

// Class mock (gotchas §4: SDK clients must be class mocks, not object spreads)
class MockWSClient extends EventEmitter {
  static instances: MockWSClient[] = []
  options: Record<string, unknown>
  connect = vi.fn(() => {
    // auto-authenticate on next tick like the real SDK's happy path
    queueMicrotask(() => this.emit("authenticated"))
    return this
  })
  disconnect = vi.fn()
  sendMessage = vi.fn(async () => ({}))
  constructor(options: Record<string, unknown>) {
    super()
    this.options = options
    MockWSClient.instances.push(this)
  }
}

vi.mock("@wecom/aibot-node-sdk", () => ({
  WSClient: MockWSClient,
}))

const { WeComAdapter } = await import("../../../adapters/wecom/wecom-adapter.js")

const CONFIG: WeComChannelConfig = {
  id: "ch_w1",
  type: "wecom",
  name: "企业微信",
  botId: "bot_1",
  secret: "sec_1",
  workspaceDir: "/ws",
  autoConnect: false,
}

function textFrame(overrides: Record<string, unknown> = {}) {
  return {
    headers: { req_id: "r1" },
    body: {
      msgid: "m1",
      aibotid: "bot_1",
      chattype: "single",
      from: { userid: "user_9" },
      text: { content: "  hello agent  " },
      ...overrides,
    },
  }
}

beforeEach(() => {
  MockWSClient.instances = []
})

describe("WeComAdapter", () => {
  it("connects once authenticated and reports status", async () => {
    const adapter = new WeComAdapter(CONFIG, vi.fn())
    await adapter.connect()
    const status = adapter.getStatus()
    expect(status.state).toBe("connected")
    expect(status.type).toBe("wecom")
    expect(MockWSClient.instances[0].options).toMatchObject({ botId: "bot_1", secret: "sec_1" })
  })

  it("routes single-chat text to onMessage with userid chatId and trims text", async () => {
    const onMessage = vi.fn()
    const adapter = new WeComAdapter(CONFIG, onMessage)
    await adapter.connect()

    MockWSClient.instances[0].emit("message.text", textFrame())
    expect(onMessage).toHaveBeenCalledTimes(1)
    const msg = onMessage.mock.calls[0][0] as IncomingMessage
    expect(msg.chatId).toBe("user_9")
    expect(msg.senderId).toBe("user_9")
    expect(msg.text).toBe("hello agent")
    expect(msg.channelType).toBe("wecom")
    expect(msg.workspaceDir).toBe("/ws")
  })

  it("prefixes group chats and replies to the group chatid", async () => {
    const onMessage = vi.fn()
    const adapter = new WeComAdapter(CONFIG, onMessage)
    await adapter.connect()

    MockWSClient.instances[0].emit(
      "message.text",
      textFrame({ chattype: "group", chatid: "grp_1" }),
    )
    const msg = onMessage.mock.calls[0][0] as IncomingMessage
    expect(msg.chatId).toBe("group:grp_1")

    await msg.reply("done")
    expect(MockWSClient.instances[0].sendMessage).toHaveBeenCalledWith("grp_1", {
      msgtype: "markdown",
      markdown: { content: "done" },
    })
  })

  it("ignores empty text frames", async () => {
    const onMessage = vi.fn()
    const adapter = new WeComAdapter(CONFIG, onMessage)
    await adapter.connect()
    MockWSClient.instances[0].emit("message.text", textFrame({ text: { content: "   " } }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  it("marks a terminal error when displaced by another connection", async () => {
    const adapter = new WeComAdapter(CONFIG, vi.fn())
    await adapter.connect()
    MockWSClient.instances[0].emit("event.disconnected_event", { headers: { req_id: "r" } })
    const status = adapter.getStatus()
    expect(status.state).toBe("error")
    expect(status.error).toMatch(/taken over/)
    expect(MockWSClient.instances[0].disconnect).toHaveBeenCalled()
  })

  it("connect() rejects on authentication failure", async () => {
    const adapter = new WeComAdapter(CONFIG, vi.fn())
    const client = MockWSClient.instances[0]
    client.connect = vi.fn(() => {
      queueMicrotask(() => client.emit("error", new Error("Authentication failed: bad secret")))
      return client
    })
    await expect(adapter.connect()).rejects.toThrow(/Authentication failed/)
    expect(adapter.getStatus().state).toBe("error")
  })
})
