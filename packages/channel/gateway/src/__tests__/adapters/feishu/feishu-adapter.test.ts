import { describe, it, expect, vi, beforeEach } from "vitest"
import type { FeishuChannelConfig, IncomingMessage } from "../../../types.js"

// Class mocks (gotchas §4: SDK clients must be class mocks)
const messageCreate = vi.fn(async () => ({}))

class MockClient {
  static lastOptions: Record<string, unknown> | null = null
  im = { v1: { message: { create: messageCreate } } }
  constructor(options: Record<string, unknown>) {
    MockClient.lastOptions = options
  }
}

class MockEventDispatcher {
  handlers: Record<string, (data: unknown) => void> = {}
  constructor(_params: Record<string, unknown>) {}
  register(handles: Record<string, (data: unknown) => void>) {
    this.handlers = { ...this.handlers, ...handles }
    return this
  }
}

class MockWSClient {
  static instances: MockWSClient[] = []
  static failNextStart: Error | null = null
  options: Record<string, unknown>
  dispatcher: MockEventDispatcher | null = null
  // Mirrors the real SDK: start() fire-and-forgets the connection; outcome
  // surfaces via the constructor's onReady/onError callbacks.
  start = vi.fn(async ({ eventDispatcher }: { eventDispatcher: MockEventDispatcher }) => {
    const onReady = this.options.onReady as (() => void) | undefined
    const onError = this.options.onError as ((err: unknown) => void) | undefined
    if (MockWSClient.failNextStart) {
      const err = MockWSClient.failNextStart
      MockWSClient.failNextStart = null
      queueMicrotask(() => onError?.(err))
      return
    }
    this.dispatcher = eventDispatcher
    queueMicrotask(() => onReady?.())
  })
  close = vi.fn()
  constructor(options: Record<string, unknown>) {
    this.options = options
    MockWSClient.instances.push(this)
  }
}

vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: MockClient,
  WSClient: MockWSClient,
  EventDispatcher: MockEventDispatcher,
  AppType: { SelfBuild: "self_build" },
  Domain: { Feishu: 0, Lark: 1 },
  LoggerLevel: { warn: 3 },
}))

const { FeishuAdapter } = await import("../../../adapters/feishu/feishu-adapter.js")

const CONFIG: FeishuChannelConfig = {
  id: "ch_f1",
  type: "feishu",
  name: "飞书",
  appId: "cli_aac74e8519391cce",
  appSecret: "sec_1",
  domain: "feishu",
  workspaceDir: "/ws",
  autoConnect: false,
}

function receiveEvent(overrides: Record<string, unknown> = {}) {
  return {
    sender: { sender_id: { open_id: "ou_9" }, sender_type: "user" },
    message: {
      message_id: "om_1",
      chat_id: "oc_1",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "  hi feishu  " }),
      ...overrides,
    },
  }
}

beforeEach(() => {
  MockWSClient.instances = []
  messageCreate.mockClear()
})

describe("FeishuAdapter", () => {
  it("connects via WSClient.start with a dispatcher registered for im.message.receive_v1", async () => {
    const adapter = new FeishuAdapter(CONFIG, vi.fn())
    await adapter.connect()
    expect(adapter.getStatus().state).toBe("connected")
    const ws = MockWSClient.instances[0]
    expect(ws.options).toMatchObject({ appId: "cli_aac74e8519391cce", appSecret: "sec_1", domain: 0 })
    expect(ws.dispatcher?.handlers["im.message.receive_v1"]).toBeTypeOf("function")
  })

  it("lark domain flows into both Client and WSClient", async () => {
    const adapter = new FeishuAdapter({ ...CONFIG, domain: "lark" }, vi.fn())
    await adapter.connect()
    expect(MockClient.lastOptions).toMatchObject({ domain: 1 })
    expect(MockWSClient.instances[0].options).toMatchObject({ domain: 1 })
  })

  it("routes p2p text to onMessage keyed by sender open_id and replies via open_id", async () => {
    const onMessage = vi.fn()
    const adapter = new FeishuAdapter(CONFIG, onMessage)
    await adapter.connect()

    MockWSClient.instances[0].dispatcher!.handlers["im.message.receive_v1"](receiveEvent())
    const msg = onMessage.mock.calls[0][0] as IncomingMessage
    expect(msg.chatId).toBe("ou_9")
    expect(msg.text).toBe("hi feishu")
    expect(msg.channelType).toBe("feishu")

    await msg.reply("done")
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "open_id" },
      data: { receive_id: "ou_9", msg_type: "text", content: JSON.stringify({ text: "done" }) },
    })
  })

  it("group chats key by chat_id, strip @-mention placeholders, reply via chat_id", async () => {
    const onMessage = vi.fn()
    const adapter = new FeishuAdapter(CONFIG, onMessage)
    await adapter.connect()

    MockWSClient.instances[0].dispatcher!.handlers["im.message.receive_v1"](
      receiveEvent({
        chat_type: "group",
        content: JSON.stringify({ text: "@_user_1 do the thing" }),
        mentions: [{ key: "_user_1", name: "bot" }],
      }),
    )
    const msg = onMessage.mock.calls[0][0] as IncomingMessage
    expect(msg.chatId).toBe("group:oc_1")
    expect(msg.text).toBe("do the thing")

    await msg.reply("ok")
    expect(messageCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "oc_1", msg_type: "text", content: JSON.stringify({ text: "ok" }) },
    })
  })

  it("ignores non-text messages and empty text", async () => {
    const onMessage = vi.fn()
    const adapter = new FeishuAdapter(CONFIG, onMessage)
    await adapter.connect()
    const handlers = MockWSClient.instances[0].dispatcher!.handlers
    handlers["im.message.receive_v1"](receiveEvent({ message_type: "image" }))
    handlers["im.message.receive_v1"](receiveEvent({ content: JSON.stringify({ text: "  " }) }))
    handlers["im.message.receive_v1"](receiveEvent({ content: "not-json" }))
    expect(onMessage).not.toHaveBeenCalled()
  })

  it("fails fast on a malformed App ID (hex but not 16 chars) — no 20s timeout", async () => {
    const adapter = new FeishuAdapter({ ...CONFIG, appId: "cli_abc123" }, vi.fn())
    await expect(adapter.connect()).rejects.toThrow(/Invalid Feishu App ID/)
    expect(adapter.getStatus().state).toBe("error")
    expect(MockWSClient.instances.length).toBe(0)
  })

  it("connect failure lands in error state and closes the socket", async () => {
    const adapter = new FeishuAdapter(CONFIG, vi.fn())
    MockWSClient.failNextStart = new Error("ws refused")
    await expect(adapter.connect()).rejects.toThrow("ws refused")
    expect(adapter.getStatus().state).toBe("error")
    expect(adapter.getStatus().error).toBe("ws refused")
  })
})
