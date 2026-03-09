import { describe, it, expect, vi, beforeEach } from "vitest"
import { createApp } from "../gateway-server.js"
import type { ChannelManager } from "../channel-manager.js"
import type { ChannelStatus, ChannelConfig } from "../types.js"

function createMockManager(): ChannelManager {
  return {
    listStatus: vi.fn(() => []),
    listConfigs: vi.fn(() => []),
    addChannel: vi.fn(async () => {}),
    removeChannel: vi.fn(async () => {}),
    connectChannel: vi.fn(async () => {}),
    disconnectChannel: vi.fn(async () => {}),
    getChannelStatus: vi.fn(() => undefined),
    getConfig: vi.fn(() => undefined),
    registerFactory: vi.fn(),
    setMessageHandler: vi.fn(),
    init: vi.fn(async () => {}),
    shutdown: vi.fn(async () => {}),
  } as unknown as ChannelManager
}

let manager: ReturnType<typeof createMockManager>
let app: ReturnType<typeof createApp>

beforeEach(() => {
  vi.clearAllMocks()
  manager = createMockManager()
  app = createApp(manager)
})

async function fetchApp(path: string, init?: RequestInit) {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function jsonBody(resp: Response): Promise<any> {
  return resp.json()
}

describe("GET /channel/health", () => {
  it("returns ok status", async () => {
    const resp = await fetchApp("/channel/health")
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body).toEqual({ status: "ok" })
  })
})

describe("GET /channel", () => {
  it("returns empty lists", async () => {
    const resp = await fetchApp("/channel")
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body).toEqual({ channels: [], configs: [] })
  })

  it("returns channels and configs from manager", async () => {
    const status: ChannelStatus = {
      id: "ch_1", type: "dingtalk", name: "Test", state: "connected",
    }
    const config: ChannelConfig = {
      id: "ch_1", type: "dingtalk", name: "Test",
      clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: true,
    }
    ;(manager.listStatus as ReturnType<typeof vi.fn>).mockReturnValue([status])
    ;(manager.listConfigs as ReturnType<typeof vi.fn>).mockReturnValue([config])

    const resp = await fetchApp("/channel")
    const body = await jsonBody(resp)
    expect(body.channels).toHaveLength(1)
    expect(body.configs).toHaveLength(1)
    expect(body.channels[0].state).toBe("connected")
  })
})

describe("POST /channel", () => {
  const validBody = {
    name: "My Channel",
    type: "dingtalk",
    clientId: "cid",
    clientSecret: "csecret",
    workspaceDir: "/workspace",
  }

  it("creates a channel with 201 status", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    })
    expect(resp.status).toBe(201)
    const body = await jsonBody(resp)
    expect(body.id).toMatch(/^ch_/)
    expect(body.name).toBe("My Channel")
    expect(body.autoConnect).toBe(true) // default
    expect(manager.addChannel).toHaveBeenCalled()
  })

  it("respects autoConnect=false", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, autoConnect: false }),
    })
    const body = await jsonBody(resp)
    expect(body.autoConnect).toBe(false)
  })

  it("trims whitespace from fields", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, name: "  padded  " }),
    })
    const body = await jsonBody(resp)
    expect(body.name).toBe("padded")
  })

  it("rejects missing name", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, name: "" }),
    })
    expect(resp.status).toBe(400)
    const body = await jsonBody(resp)
    expect(body.error).toContain("name")
  })

  it("rejects missing type", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, type: "" }),
    })
    expect(resp.status).toBe(400)
  })

  it("rejects missing clientId", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, clientId: "" }),
    })
    expect(resp.status).toBe(400)
    const body = await jsonBody(resp)
    expect(body.error).toContain("clientId")
  })

  it("rejects missing clientSecret", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, clientSecret: "  " }),
    })
    expect(resp.status).toBe(400)
  })

  it("rejects missing workspaceDir", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, workspaceDir: "" }),
    })
    expect(resp.status).toBe(400)
  })

  it("rejects invalid JSON body", async () => {
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })
    expect(resp.status).toBe(400)
    const body = await jsonBody(resp)
    expect(body.error).toContain("Invalid JSON")
  })

  it("returns 400 when manager.addChannel throws", async () => {
    ;(manager.addChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("duplicate"),
    )
    const resp = await fetchApp("/channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    })
    expect(resp.status).toBe(400)
    const body = await jsonBody(resp)
    expect(body.error).toBe("duplicate")
  })
})

describe("DELETE /channel/:id", () => {
  it("removes channel and returns ok", async () => {
    const resp = await fetchApp("/channel/ch_1", { method: "DELETE" })
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body.ok).toBe(true)
    expect(manager.removeChannel).toHaveBeenCalledWith("ch_1")
  })

  it("returns 404 on error", async () => {
    ;(manager.removeChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("not found"),
    )
    const resp = await fetchApp("/channel/ch_bad", { method: "DELETE" })
    expect(resp.status).toBe(404)
  })
})

describe("POST /channel/:id/connect", () => {
  it("connects and returns status", async () => {
    const status: ChannelStatus = {
      id: "ch_1", type: "dingtalk", name: "T", state: "connected",
    }
    ;(manager.getChannelStatus as ReturnType<typeof vi.fn>).mockReturnValue(status)

    const resp = await fetchApp("/channel/ch_1/connect", { method: "POST" })
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body.state).toBe("connected")
    expect(manager.connectChannel).toHaveBeenCalledWith("ch_1")
  })

  it("returns fallback status when getChannelStatus is undefined", async () => {
    const resp = await fetchApp("/channel/ch_1/connect", { method: "POST" })
    const body = await jsonBody(resp)
    expect(body.id).toBe("ch_1")
    expect(body.state).toBe("connected")
  })

  it("returns 500 on connect error", async () => {
    ;(manager.connectChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connect failed"),
    )
    const resp = await fetchApp("/channel/ch_1/connect", { method: "POST" })
    expect(resp.status).toBe(500)
  })
})

describe("POST /channel/:id/disconnect", () => {
  it("disconnects and returns status", async () => {
    const status: ChannelStatus = {
      id: "ch_1", type: "dingtalk", name: "T", state: "disconnected",
    }
    ;(manager.getChannelStatus as ReturnType<typeof vi.fn>).mockReturnValue(status)

    const resp = await fetchApp("/channel/ch_1/disconnect", { method: "POST" })
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body.state).toBe("disconnected")
  })

  it("returns 500 on disconnect error", async () => {
    ;(manager.disconnectChannel as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("disconnect failed"),
    )
    const resp = await fetchApp("/channel/ch_1/disconnect", { method: "POST" })
    expect(resp.status).toBe(500)
  })
})
