import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createFeishuQRProvider } from "../../../adapters/feishu/qr-provider.js"
import type { FeishuChannelConfig } from "../../../types.js"

const fetchMock = vi.fn()

/** Registration pending states arrive as HTTP 4xx WITH a JSON body. */
function jsonResponse(body: unknown, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) } as Response
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const INIT_OK = { nonce: "n1", supported_auth_methods: ["client_secret"] }
const BEGIN_OK = {
  device_code: "dc_f1",
  user_code: "ABCD-EFGH",
  verification_uri_complete: "https://accounts.feishu.cn/oauth/verify?user_code=ABCD-EFGH",
  interval: 5,
  expire_in: 600,
}

describe("Feishu registration QR provider", () => {
  it("start(): init(client_secret check) → begin(PersonalAgent), form-encoded", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(INIT_OK))
      .mockResolvedValueOnce(jsonResponse(BEGIN_OK))
    const provider = createFeishuQRProvider()
    const started = await provider.start()

    expect(started.upstreamToken).toBe("dc_f1")
    expect(started.qrContent).toContain("user_code=ABCD-EFGH")
    expect(started.expiresInMs).toBe(600_000)
    expect(started.pollIntervalMs).toBe(5000)

    const [initUrl, initInit] = fetchMock.mock.calls[0]
    expect(initUrl).toBe("https://accounts.feishu.cn/oauth/v1/app/registration")
    expect(initInit.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
    const beginBody = new URLSearchParams(fetchMock.mock.calls[1][1].body as string)
    expect(beginBody.get("action")).toBe("begin")
    expect(beginBody.get("archetype")).toBe("PersonalAgent")
    expect(beginBody.get("auth_method")).toBe("client_secret")
  })

  it("start(): refuses environments without client_secret support", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ nonce: "n", supported_auth_methods: ["other"] }))
    await expect(createFeishuQRProvider().start()).rejects.toThrow(/client_secret/)
  })

  it("poll(): authorization_pending arrives as 4xx + JSON body → pending (not an error)", async () => {
    const provider = createFeishuQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400))
    expect(await provider.poll("dc_f1")).toEqual({ state: "pending" })
  })

  it("poll(): terminal errors map to denied/expired", async () => {
    const provider = createFeishuQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "access_denied" }, 403))
    expect((await provider.poll("dc_a")).state).toBe("denied")
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "expired_token" }, 400))
    expect((await provider.poll("dc_b")).state).toBe("expired")
  })

  it("poll(): success builds a FeishuChannelConfig carrying the resolved domain", async () => {
    const provider = createFeishuQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({
      client_id: "cli_1", client_secret: "sec_1", user_info: { open_id: "ou_1", tenant_brand: "feishu" },
    }))
    const result = await provider.poll("dc_f1")
    if (result.state !== "authorized") throw new Error(`expected authorized, got ${result.state}`)
    const config = result.buildConfig({
      id: "ch_f", name: "飞书", workspaceDir: "/ws", autoConnect: true,
    }) as FeishuChannelConfig
    expect(config).toEqual({
      id: "ch_f",
      type: "feishu",
      name: "飞书",
      appId: "cli_1",
      appSecret: "sec_1",
      domain: "feishu",
      workspaceDir: "/ws",
      autoConnect: true,
    })
  })

  it("poll(): lark tenant_brand switches the accounts domain for the next poll", async () => {
    const provider = createFeishuQRProvider()
    // 1st poll: feishu domain reveals tenant_brand=lark without credentials
    fetchMock.mockResolvedValueOnce(jsonResponse({ user_info: { tenant_brand: "lark" } }, 400))
    expect((await provider.poll("dc_l1")).state).toBe("scanned")
    expect(fetchMock.mock.calls[0][0]).toContain("accounts.feishu.cn")

    // 2nd poll goes to larksuite and delivers credentials
    fetchMock.mockResolvedValueOnce(jsonResponse({
      client_id: "cli_l", client_secret: "sec_l", user_info: { tenant_brand: "lark" },
    }))
    const result = await provider.poll("dc_l1")
    expect(fetchMock.mock.calls[1][0]).toContain("accounts.larksuite.com")
    if (result.state !== "authorized") throw new Error("expected authorized")
    const config = result.buildConfig({ id: "c", name: "n", workspaceDir: "/w", autoConnect: true }) as FeishuChannelConfig
    expect(config.domain).toBe("lark")
  })

  it("poll(): slow_down accumulates extra delay before subsequent polls", async () => {
    const provider = createFeishuQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "slow_down" }, 429))
    expect((await provider.poll("dc_s1")).state).toBe("pending")

    // next poll waits the extra 5s before hitting upstream
    vi.useFakeTimers()
    try {
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }, 400))
      const pending = provider.poll("dc_s1")
      expect(fetchMock).toHaveBeenCalledTimes(1) // still sleeping
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toEqual({ state: "pending" })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("throws on non-JSON responses (registry treats as transient)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => "<html>bad gateway</html>" } as Response)
    await expect(createFeishuQRProvider().poll("dc_x")).rejects.toThrow(/HTTP 502/)
  })
})
