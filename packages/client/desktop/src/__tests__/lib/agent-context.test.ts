import { describe, it, expect } from "vitest"
import { nextAgentPollDelay, reduceAcpPoll } from "@/lib/agent-context"

// discussions/042. The ACP sidecar (:4099) is spawned in a non-blocking thread
// AFTER the renderer gate opens, so AgentContext's first probe reliably loses
// the race and fails once — Team mode is wrongly disabled until something
// re-probes. These lock the self-healing cadence + state machine that recover
// it automatically (previously the only recovery was a manual dropdown open).

describe("nextAgentPollDelay", () => {
  it("polls at the steady 4s interval while healthy (no failures)", () => {
    expect(nextAgentPollDelay(0)).toBe(4_000)
    // negative is not expected, but must never produce a fast hammer loop
    expect(nextAgentPollDelay(-1)).toBe(4_000)
  })

  it("retries fast from 1s and doubles while the sidecar is still coming up", () => {
    expect(nextAgentPollDelay(1)).toBe(1_000)
    expect(nextAgentPollDelay(2)).toBe(2_000)
    expect(nextAgentPollDelay(3)).toBe(4_000)
    expect(nextAgentPollDelay(4)).toBe(8_000)
    expect(nextAgentPollDelay(5)).toBe(16_000)
  })

  it("caps a genuinely-absent sidecar at 30s (tighter than the IM gateway's 5min)", () => {
    // The ACP sidecar is spawned on every launch and expected present, so recovery
    // stays fast — but a truly-dead one is still not hammered faster than 30s.
    expect(nextAgentPollDelay(6)).toBe(30_000) // 32s clamped to cap
    expect(nextAgentPollDelay(7)).toBe(30_000)
    expect(nextAgentPollDelay(20)).toBe(30_000)
    expect(nextAgentPollDelay(1000)).toBe(30_000)
  })

  it("is monotonic non-decreasing across the failure ramp", () => {
    let prev = 0
    for (let f = 1; f <= 15; f++) {
      const d = nextAgentPollDelay(f)
      expect(d).toBeGreaterThanOrEqual(prev)
      expect(d).toBeLessThanOrEqual(30_000)
      prev = d
    }
  })
})

describe("reduceAcpPoll", () => {
  it("connects immediately on the first success (cold-boot fast path, no threshold)", () => {
    // The reported bug: acpAvailable stuck false at boot. One healthy probe flips
    // it true right away, so Team mode enables without a manual dropdown open.
    expect(reduceAcpPoll({ available: false, failures: 3 }, true)).toEqual({
      available: true,
      failures: 0,
    })
  })

  it("keeps a success sticky and resets the streak while already connected", () => {
    expect(reduceAcpPoll({ available: true, failures: 0 }, true)).toEqual({
      available: true,
      failures: 0,
    })
  })

  it("does NOT flicker off on a single transient failure while connected (debounce)", () => {
    // First failure while connected: stay available, but count it so the next
    // tick retries fast (nextAgentPollDelay(1) === 1s) to confirm or downgrade.
    expect(reduceAcpPoll({ available: true, failures: 0 }, false)).toEqual({
      available: true,
      failures: 1,
    })
  })

  it("downgrades after DOWN_THRESHOLD (2) consecutive failures", () => {
    const first = reduceAcpPoll({ available: true, failures: 0 }, false)
    expect(first).toEqual({ available: true, failures: 1 })
    const second = reduceAcpPoll(first, false)
    expect(second).toEqual({ available: false, failures: 2 })
  })

  it("a mid-streak recovery clears both failures and the pending downgrade", () => {
    const first = reduceAcpPoll({ available: true, failures: 0 }, false)
    expect(reduceAcpPoll(first, true)).toEqual({ available: true, failures: 0 })
  })

  it("stays down and keeps counting failures while disconnected (drives the backoff)", () => {
    const s1 = reduceAcpPoll({ available: false, failures: 1 }, false)
    expect(s1).toEqual({ available: false, failures: 2 })
    const s2 = reduceAcpPoll(s1, false)
    expect(s2).toEqual({ available: false, failures: 3 })
    // …until a health success reconnects it (see the cold-boot case above).
  })
})
