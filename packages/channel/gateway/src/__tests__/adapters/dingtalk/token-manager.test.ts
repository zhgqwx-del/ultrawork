import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { TokenManager } from "../../../adapters/dingtalk/token-manager.js"

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function mockTokenResponse(accessToken: string, expireIn = 7200) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ accessToken, expireIn }),
  })
}

describe("TokenManager", () => {
  it("fetches a new token on first call", async () => {
    mockTokenResponse("token-1")
    const tm = new TokenManager("cid", "csecret")
    const token = await tm.getToken()
    expect(token).toBe("token-1")
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ appKey: "cid", appSecret: "csecret" }),
      }),
    )
  })

  it("returns cached token when not expired", async () => {
    mockTokenResponse("token-1", 7200)
    const tm = new TokenManager("cid", "csecret")
    await tm.getToken()
    const token2 = await tm.getToken()
    expect(token2).toBe("token-1")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("refreshes token when near expiry (within 60s)", async () => {
    mockTokenResponse("token-1", 7200)
    const tm = new TokenManager("cid", "csecret")
    await tm.getToken()

    // Advance to within 60s of expiry
    vi.advanceTimersByTime(7200 * 1000 - 30_000) // 30s before expiry

    mockTokenResponse("token-2", 7200)
    const token = await tm.getToken()
    expect(token).toBe("token-2")
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it("deduplicates concurrent refresh calls", async () => {
    let resolveToken: (v: any) => void
    mockFetch.mockReturnValueOnce(
      new Promise((r) => {
        resolveToken = r
      }),
    )

    const tm = new TokenManager("cid", "csecret")
    const p1 = tm.getToken()
    const p2 = tm.getToken()

    resolveToken!({
      ok: true,
      json: () => Promise.resolve({ accessToken: "deduped", expireIn: 7200 }),
    })

    const [t1, t2] = await Promise.all([p1, p2])
    expect(t1).toBe("deduped")
    expect(t2).toBe("deduped")
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it("throws on fetch failure", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401 })
    const tm = new TokenManager("cid", "csecret")
    await expect(tm.getToken()).rejects.toThrow("token refresh failed: 401")
  })

  it("retries after a failed refresh", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const tm = new TokenManager("cid", "csecret")
    await expect(tm.getToken()).rejects.toThrow()

    // refreshPromise should be cleared, allowing retry
    mockTokenResponse("recovered")
    const token = await tm.getToken()
    expect(token).toBe("recovered")
  })

  it("refreshes after full expiry", async () => {
    mockTokenResponse("token-1", 100)
    const tm = new TokenManager("cid", "csecret")
    await tm.getToken()

    // Advance past expiry
    vi.advanceTimersByTime(200_000)

    mockTokenResponse("token-2")
    const token = await tm.getToken()
    expect(token).toBe("token-2")
  })

  it("sends correct Content-Type header", async () => {
    mockTokenResponse("t")
    const tm = new TokenManager("cid", "csecret")
    await tm.getToken()
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: { "Content-Type": "application/json" },
      }),
    )
  })
})
