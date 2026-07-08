import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createWeComQRProvider } from "../../../adapters/wecom/qr-provider.js"
import type { WeComChannelConfig } from "../../../types.js"

const fetchMock = vi.fn()

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("WeCom ai/qc QR provider", () => {
  it("start(): generate → scode token, auth_url QR, gen-page browser URL, local 5min TTL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { scode: "sc_1", auth_url: "https://work.weixin.qq.com/ai/qc/c?s=sc_1&hide_more_btn=true&for_native=true" },
    }))
    const provider = createWeComQRProvider()
    const started = await provider.start()

    expect(started.upstreamToken).toBe("sc_1")
    expect(started.qrContent).toContain("/ai/qc/c?s=sc_1")
    expect(started.browserUrl).toContain("/ai/qc/gen?source=wecom-cli&scode=sc_1")
    // upstream never signals expiry (bogus scode still answers pending) — TTL is local
    expect(started.expiresInMs).toBe(5 * 60 * 1000)
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/ai\/qc\/generate\?source=wecom-cli&plat=\d/)
  })

  it("start(): rejects malformed generate response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: {} }))
    await expect(createWeComQRProvider().start()).rejects.toThrow(/no scode/)
  })

  it("poll(): pending (and any unknown status) keeps waiting", async () => {
    const provider = createWeComQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "pending" } }))
    expect(await provider.poll("sc_1")).toEqual({ state: "pending" })
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "whatever" } }))
    expect(await provider.poll("sc_1")).toEqual({ state: "pending" })
  })

  it("poll(): success builds a WeComChannelConfig from bot_info", async () => {
    const provider = createWeComQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { status: "success", bot_info: { botid: "bot_1", secret: "sec_1" } },
    }))
    const result = await provider.poll("sc_1")
    if (result.state !== "authorized") throw new Error(`expected authorized, got ${result.state}`)
    const config = result.buildConfig({
      id: "ch_w", name: "企业微信", workspaceDir: "/ws", autoConnect: true,
    }) as WeComChannelConfig
    expect(config).toEqual({
      id: "ch_w",
      type: "wecom",
      name: "企业微信",
      botId: "bot_1",
      secret: "sec_1",
      workspaceDir: "/ws",
      autoConnect: true,
    })
  })

  it("poll(): success without bot_info degrades to denied (contract drift guard)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { status: "success" } }))
    const result = await createWeComQRProvider().poll("sc_1")
    expect(result.state).toBe("denied")
  })

  it("throws on HTTP failure (registry treats as transient)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 503))
    await expect(createWeComQRProvider().poll("sc_1")).rejects.toThrow(/HTTP 503/)
  })
})
