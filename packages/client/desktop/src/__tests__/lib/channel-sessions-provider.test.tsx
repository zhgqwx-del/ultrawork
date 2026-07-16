import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act } from "@testing-library/react"

// The gateway is spawned in a non-blocking background thread AFTER the renderer gate
// opens, so this provider's first /channel/sessions fetch reliably loses the race and
// fails once at cold boot. This drives the REAL provider through its tick loop under a
// virtual clock to prove the retry actually fires ~1s after the first failure (not a
// full 30s poll later), doubles on a second failure, then settles to the 30s steady
// poll after success — the end-to-end behavior behind the "badge appears in 1–3s" fix.
// (Deterministic vitest fake timers, not rAF: no headless hang.)

vi.mock("@/lib/sidecar-ports", () => ({ gatewayBaseUrl: () => "/channel" }))
vi.mock("@/lib/sidecar-auth", () => ({ sidecarAuthHeaders: () => ({}) }))

import { ChannelSessionsProvider } from "@/lib/channel-sessions-context"

const okEmpty = { ok: true, json: async () => ({ sessions: [] }) } as unknown as Response

describe("ChannelSessionsProvider retry cadence (integration)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // advance virtual time inside act() so React state updates from the tick don't warn
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  it("retries ~1s after first failure, ~2s after second, then steady 30s on success", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // boot: gateway not listening yet
      .mockRejectedValueOnce(new Error("ECONNREFUSED")) // still coming up
      .mockResolvedValue(okEmpty) // gateway ready
    vi.stubGlobal("fetch", fetchMock)

    render(
      <ChannelSessionsProvider>
        <div />
      </ChannelSessionsProvider>,
    )

    // Mount fires the first fetch immediately; flush its rejection so the retry schedules.
    await advance(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Discriminator vs. the OLD behavior (first failure → 30s): the 2nd fetch must NOT
    // have happened yet just before 1s, and MUST happen right at 1s.
    await advance(999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await advance(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Second failure doubles the delay to ~2s.
    await advance(1999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await advance(1)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // Third fetch succeeds → next poll is the steady 30s, not a fast retry.
    await advance(29_999)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await advance(1)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it("stops polling after unmount (no leaked timer / no setState after cancel)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))
    vi.stubGlobal("fetch", fetchMock)

    const { unmount } = render(
      <ChannelSessionsProvider>
        <div />
      </ChannelSessionsProvider>,
    )
    await advance(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    unmount()
    // A retry was scheduled (~1s); after unmount it must never fire again.
    await advance(60_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
