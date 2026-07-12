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
  app = createApp(manager, undefined, null)
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
    // idleRotateMs is deliberately part of the health payload: Tauri does not
    // forward sidecar stdout, so this is the ONLY way to see which rotation
    // threshold a running gateway actually picked up from the environment.
    expect(body).toEqual({ status: "ok", idleRotateMs: expect.any(Number) })
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

// ---- QR endpoints (generic, backed by QRRegistry) ----

import { QRRegistry, type QRProvider } from "../qr-registry.js"

function makeQRApp() {
  const registry = new QRRegistry(manager)
  const provider: QRProvider = {
    type: "fake",
    pollIntervalMs: 60_000, // never actually polls during these tests
    start: vi.fn(async () => ({ upstreamToken: "up", qrContent: "https://qr.example/x" })),
    poll: vi.fn(async () => ({ state: "pending" as const })),
  }
  registry.registerProvider(provider)
  return { app: createApp(manager, registry, null), registry }
}

describe("QR login routes", () => {
  it("POST /channel/:type/qrcode starts a session for a registered provider", async () => {
    const { app: qrApp, registry } = makeQRApp()
    const resp = await qrApp.fetch(new Request("http://localhost/channel/fake/qrcode", {
      method: "POST",
      body: JSON.stringify({ name: "n", workspaceDir: "/ws" }),
    }))
    expect(resp.status).toBe(200)
    const body = await jsonBody(resp)
    expect(body.token).toMatch(/^qr_/)
    expect(body.qrContent).toBe("https://qr.example/x")

    const status = await qrApp.fetch(new Request(`http://localhost/channel/fake/qrcode-status?token=${body.token}`))
    expect(status.status).toBe(200)
    expect((await jsonBody(status)).status).toBe("pending")
    registry.stopAll()
  })

  it("rejects unregistered types and mismatched type/token pairs", async () => {
    const { app: qrApp, registry } = makeQRApp()
    const unknown = await qrApp.fetch(new Request("http://localhost/channel/nope/qrcode", {
      method: "POST",
      body: JSON.stringify({ name: "n", workspaceDir: "/ws" }),
    }))
    expect(unknown.status).toBe(404)

    const start = await qrApp.fetch(new Request("http://localhost/channel/fake/qrcode", {
      method: "POST",
      body: JSON.stringify({ name: "n", workspaceDir: "/ws" }),
    }))
    const { token } = await jsonBody(start)
    // token exists but under type "fake" — reading it as another type 404s
    const cross = await qrApp.fetch(new Request(`http://localhost/channel/other/qrcode-status?token=${token}`))
    expect(cross.status).toBe(404)
    registry.stopAll()
  })

  it("DELETE /channel/:type/qrcode/:token cancels the session", async () => {
    const { app: qrApp, registry } = makeQRApp()
    const start = await qrApp.fetch(new Request("http://localhost/channel/fake/qrcode", {
      method: "POST",
      body: JSON.stringify({ name: "n", workspaceDir: "/ws" }),
    }))
    const { token } = await jsonBody(start)
    const del = await qrApp.fetch(new Request(`http://localhost/channel/fake/qrcode/${token}`, { method: "DELETE" }))
    expect(del.status).toBe(200)
    const after = await qrApp.fetch(new Request(`http://localhost/channel/fake/qrcode-status?token=${token}`))
    expect(after.status).toBe(404)
    registry.stopAll()
  })

  it("returns 404 for QR routes when no registry is wired", async () => {
    const resp = await fetchApp("/channel/wechat/qrcode", {
      method: "POST",
      body: JSON.stringify({ name: "n", workspaceDir: "/ws" }),
    })
    expect(resp.status).toBe(404)
  })
})

describe("GET /channel secret masking", () => {
  it("blanks clientSecret and botToken in configs", async () => {
    const configs: ChannelConfig[] = [
      { id: "d1", type: "dingtalk", name: "d", clientId: "cid", clientSecret: "SECRET", workspaceDir: "/w", autoConnect: true },
      { id: "w1", type: "wechat", name: "w", botToken: "TOKEN", ilinkBotId: "b", ilinkUserId: "", baseUrl: "https://x", workspaceDir: "/w", autoConnect: true },
    ]
    ;(manager.listConfigs as ReturnType<typeof vi.fn>).mockReturnValue(configs)
    const resp = await fetchApp("/channel")
    const body = await jsonBody(resp)
    expect(body.configs[0].clientSecret).toBe("")
    expect(body.configs[0].clientId).toBe("cid")
    expect(body.configs[1].botToken).toBe("")
    // original objects untouched (masking must copy)
    expect((configs[0] as { clientSecret: string }).clientSecret).toBe("SECRET")
  })
})

// Inbound Basic auth (029 阶段 ④b). A loopback port is not a boundary — any local
// process can reach it — so every route, health included, must prove the credential.
describe("inbound Basic auth", () => {
  const AUTH = { username: "opencode", password: "s3cret" }
  const header = (u: string, p: string) => ({ authorization: "Basic " + btoa(`${u}:${p}`) })

  function authedApp() {
    return createApp(createMockManager(), undefined, AUTH)
  }

  it("rejects a request with no credentials", async () => {
    const res = await authedApp().request("/channel/health")
    expect(res.status).toBe(401)
  })

  it.each([
    ["a wrong password", "opencode", "wrong"],
    ["a wrong username", "mallory", "s3cret"],
  ])("rejects %s", async (_label, user, pass) => {
    const res = await authedApp().request("/channel/health", { headers: header(user, pass) })
    expect(res.status).toBe(401)
  })

  // The positive direction: without it, an `app.use(() => 401)` would pass the above.
  it("accepts the correct credentials", async () => {
    const res = await authedApp().request("/channel/health", { headers: header("opencode", "s3cret") })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok", idleRotateMs: expect.any(Number) })
  })

  it("protects data routes, not just health", async () => {
    expect((await authedApp().request("/channel")).status).toBe(401)
    const ok = await authedApp().request("/channel", { headers: header("opencode", "s3cret") })
    expect(ok.status).toBe(200)
  })

  // hono's cors() answers the preflight itself and never calls next(), so the
  // browser's unauthenticated OPTIONS must not be rejected — otherwise every
  // cross-origin request from the Tauri webview fails before it is even sent.
  it("lets an unauthenticated CORS preflight through", async () => {
    const res = await authedApp().request("/channel", {
      method: "OPTIONS",
      headers: {
        origin: "tauri://localhost",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization,content-type",
      },
    })
    expect(res.status).not.toBe(401)
    expect(res.headers.get("access-control-allow-origin")).toBe("tauri://localhost")
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization")
  })

  // hono's basicAuth answers 401 with `WWW-Authenticate: Basic`, which makes a browser
  // run its own credential flow: Chrome holds the fetch open waiting for a native
  // password dialog instead of resolving it (observed in a real browser), and the Tauri
  // WebView would pop a system prompt. Every client here attaches the header itself.
  it("answers 401 without a WWW-Authenticate challenge", async () => {
    const res = await authedApp().request("/channel/health")
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toBeNull()
  })

  it("serves everything unauthenticated when auth is null (unit-test mode)", async () => {
    const res = await createApp(createMockManager(), undefined, null).request("/channel/health")
    expect(res.status).toBe(200)
  })
})
