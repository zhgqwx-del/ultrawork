import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// gatewayBaseUrl() already ends in /channel. Appending "/channel/sessions" builds
// /channel/channel/sessions, which 404s — and the provider swallows the failure
// (catch → back off, "stay badge-less"), so the badge simply never appears and
// nothing is logged. A real-browser e2e caught this; the whole unit suite did not.
// This pins the URL so it cannot silently rot again.
vi.mock("@/lib/sidecar-ports", () => ({ gatewayBaseUrl: () => "/channel" }))
vi.mock("@/lib/sidecar-auth", () => ({ sidecarAuthHeaders: () => ({ Authorization: "Basic x" }) }))

describe("channel sessions endpoint URL", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ sessions: [] }) })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it("hits /channel/sessions, not /channel/channel/sessions", async () => {
    const { ChannelSessionsProvider } = await import("@/lib/channel-sessions-context")
    const { render } = await import("@testing-library/react")
    const React = await import("react")

    render(React.createElement(ChannelSessionsProvider, null, null))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())

    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe("/channel/sessions")
    expect(url).not.toContain("/channel/channel")
  })
})
