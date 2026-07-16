import { describe, it, expect } from "vitest"
import { nextChannelPollDelay } from "@/lib/channel-sessions-context"

// Locks the poll cadence that keeps the boot-time gateway race from delaying IM
// badges by a full poll interval. The gateway is spawned in a non-blocking thread
// after the renderer gate opens, so this provider's first fetch reliably loses the
// race and fails once; the retry must be fast (not 30s) or badges lag ~a minute.
describe("nextChannelPollDelay", () => {
  it("polls at the steady 30s interval while healthy (no failures)", () => {
    expect(nextChannelPollDelay(0)).toBe(30_000)
    // negative is not expected, but must never produce a fast hammer loop
    expect(nextChannelPollDelay(-1)).toBe(30_000)
  })

  it("retries fast from 1s and doubles while the gateway is still coming up", () => {
    // A still-booting gateway is usually up within a second or two → caught by the
    // 1s/2s retries, so badges appear promptly instead of after a full poll.
    expect(nextChannelPollDelay(1)).toBe(1_000)
    expect(nextChannelPollDelay(2)).toBe(2_000)
    expect(nextChannelPollDelay(3)).toBe(4_000)
    expect(nextChannelPollDelay(4)).toBe(8_000)
    expect(nextChannelPollDelay(5)).toBe(16_000)
  })

  it("caps a genuinely-absent gateway at the 5-min backoff (no perpetual hammer)", () => {
    // Grows geometrically, then clamps — so an app with no IM channel configured
    // does not poll a dead port faster than every 5 minutes for its whole life.
    expect(nextChannelPollDelay(9)).toBe(256_000)
    expect(nextChannelPollDelay(10)).toBe(300_000) // 512s clamped to cap
    expect(nextChannelPollDelay(20)).toBe(300_000)
    expect(nextChannelPollDelay(1000)).toBe(300_000)
  })

  it("is monotonic non-decreasing across the failure ramp", () => {
    let prev = 0
    for (let f = 1; f <= 15; f++) {
      const d = nextChannelPollDelay(f)
      expect(d).toBeGreaterThanOrEqual(prev)
      expect(d).toBeLessThanOrEqual(300_000)
      prev = d
    }
  })
})
