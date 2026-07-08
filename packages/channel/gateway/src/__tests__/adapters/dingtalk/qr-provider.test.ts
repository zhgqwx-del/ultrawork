import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createDingTalkQRProvider } from "../../../adapters/dingtalk/qr-provider.js"
import type { DingTalkChannelConfig } from "../../../types.js"

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

describe("DingTalk registration QR provider", () => {
  it("start(): init → begin, returns device_code as token + verification URL as QR content", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok", nonce: "nr_1", expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse({
        errcode: 0, errmsg: "ok",
        device_code: "dc_1",
        user_code: "AAAA-BBBB-CCCC",
        verification_uri_complete: "https://open-dev.dingtalk.com/openapp/registration/openClaw?user_code=AAAA-BBBB-CCCC&source=DING_DWS_CLAW",
        expires_in: 7200,
        interval: 2,
      }))

    const provider = createDingTalkQRProvider()
    const started = await provider.start()

    expect(started.upstreamToken).toBe("dc_1")
    expect(started.qrContent).toContain("user_code=AAAA-BBBB-CCCC")
    expect(started.expiresInMs).toBe(7_200_000)
    // begin's mandated interval (2s) becomes the per-session poll interval
    expect(started.pollIntervalMs).toBe(2000)

    // init carried the source; begin carried nonce + source
    const initBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const beginBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(initBody.source).toBe("DING_DWS_CLAW")
    expect(beginBody).toEqual({ nonce: "nr_1", source: "DING_DWS_CLAW" })
  })

  it("poll(): WAITING → pending; EXPIRED → expired", async () => {
    const provider = createDingTalkQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok", status: "WAITING" }))
    expect(await provider.poll("dc_1")).toEqual({ state: "pending" })
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok", status: "EXPIRED" }))
    expect(await provider.poll("dc_1")).toEqual({ state: "expired" })
  })

  it("poll(): FAIL arrives as errcode:0 + fail_reason (measured contract) → denied", async () => {
    const provider = createDingTalkQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({
      errcode: 0, errmsg: "ok", status: "FAIL", fail_reason: "invalid device_code: invalid device_code",
    }))
    const result = await provider.poll("bogus")
    expect(result).toEqual({ state: "denied", error: "invalid device_code: invalid device_code" })
  })

  it("poll(): SUCCESS builds a DingTalkChannelConfig from the one-shot credentials", async () => {
    const provider = createDingTalkQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({
      errcode: 0, errmsg: "ok", status: "SUCCESS", client_id: "cid_1", client_secret: "sec_1",
    }))
    const result = await provider.poll("dc_1")
    if (result.state !== "authorized") throw new Error(`expected authorized, got ${result.state}`)
    const config = result.buildConfig({
      id: "ch_x", name: "钉钉", workspaceDir: "/ws", autoConnect: true,
    }) as DingTalkChannelConfig
    expect(config).toEqual({
      id: "ch_x",
      type: "dingtalk",
      name: "钉钉",
      clientId: "cid_1",
      clientSecret: "sec_1",
      workspaceDir: "/ws",
      autoConnect: true,
    })
  })

  it("poll(): SUCCESS without credentials degrades to denied (contract drift guard)", async () => {
    const provider = createDingTalkQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 0, errmsg: "ok", status: "SUCCESS" }))
    const result = await provider.poll("dc_1")
    expect(result.state).toBe("denied")
  })

  it("throws on HTTP failure and non-zero errcode (registry treats as transient)", async () => {
    const provider = createDingTalkQRProvider()
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 502))
    await expect(provider.poll("dc_1")).rejects.toThrow(/HTTP 502/)
    fetchMock.mockResolvedValueOnce(jsonResponse({ errcode: 88, errmsg: "system busy" }))
    await expect(provider.poll("dc_1")).rejects.toThrow(/system busy/)
  })
})
