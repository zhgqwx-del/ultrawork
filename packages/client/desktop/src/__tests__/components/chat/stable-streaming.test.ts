import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useStableStreaming, SETTLE_MS } from "@/components/chat/assistant-turn"

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("useStableStreaming — debounces the 'settled' (done) appearance", () => {
  it("a brief streaming dip (< SETTLE_MS) does NOT settle — absorbs SSE flicker", () => {
    const { result, rerender } = renderHook(({ s }) => useStableStreaming(s), {
      initialProps: { s: true },
    })
    expect(result.current).toBe(true)

    // opencode trailing/duplicate events flip isStreaming false then back true
    // within a few hundred ms — must stay "streaming" (no premature done).
    rerender({ s: false })
    act(() => { vi.advanceTimersByTime(SETTLE_MS - 100) })
    expect(result.current).toBe(true) // still streaming — dip absorbed
    rerender({ s: true })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBe(true) // flip-back cleared the pending settle
  })

  it("streaming staying false past SETTLE_MS settles to done exactly once", () => {
    const { result, rerender } = renderHook(({ s }) => useStableStreaming(s), {
      initialProps: { s: true },
    })
    rerender({ s: false })
    act(() => { vi.advanceTimersByTime(SETTLE_MS - 1) })
    expect(result.current).toBe(true) // not yet
    act(() => { vi.advanceTimersByTime(2) })
    expect(result.current).toBe(false) // settled after the beat
  })

  it("becomes streaming immediately (no delay on the rising edge)", () => {
    const { result, rerender } = renderHook(({ s }) => useStableStreaming(s), {
      initialProps: { s: false },
    })
    expect(result.current).toBe(false) // historical turn: settled from the start, no flash
    rerender({ s: true })
    expect(result.current).toBe(true) // spinner appears at once
  })
})
