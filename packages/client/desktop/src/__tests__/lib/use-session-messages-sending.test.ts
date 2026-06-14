import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { SSEEvent } from "@agent/connector"

// --- Mocks ---------------------------------------------------------------

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const markSessionIdle = vi.fn()
const markSessionActive = vi.fn()
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({
    sessions: [],
    updateSession: vi.fn(),
    markSessionActive,
    markSessionIdle,
  }),
}))

// capabilitiesOf is swapped per test (opencode vs ACP).
let sessionStatusCap = true
const connector = {
  capabilitiesOf: () => ({ sessionStatus: sessionStatusCap, revert: true }),
  fetchHistory: vi.fn().mockResolvedValue({ messages: [], cursor: undefined, hasMore: false }),
  cancel: vi.fn().mockResolvedValue(undefined),
}

// Capture the SSE handler the hook subscribes with so the test can drive it.
let capturedHandler: ((e: SSEEvent) => void) | null = null
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSessionSubscribe: (_sid: string | undefined, handler: (e: SSEEvent) => void) => {
    capturedHandler = handler
  },
}))

import { useSessionMessages } from "@/lib/use-session-messages"

function assistantFinish(finish: string): SSEEvent {
  return {
    type: "message.updated",
    properties: {
      info: { id: "m1", sessionID: "s1", role: "assistant", finish },
    },
  } as unknown as SSEEvent
}

beforeEach(() => {
  sessionStatusCap = true
  capturedHandler = null
  markSessionIdle.mockReset()
  markSessionActive.mockReset()
  connector.fetchHistory.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useSessionMessages — sending lifecycle across tool-call steps", () => {
  it("keeps `sending` true on an intermediate 'tool-calls' finish (step boundary, not turn end)", async () => {
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    // Starts active (navigated from Home with an in-flight prompt).
    await waitFor(() => expect(result.current.sending).toBe(true))

    // A step finishes with finish:"tool-calls" — the loop continues. This must
    // NOT flip the turn to "done" (regression: false-complete flicker between
    // steps where green check + footer briefly appear).
    act(() => capturedHandler!(assistantFinish("tool-calls")))
    expect(result.current.sending).toBe(true)
  })

  it("clears `sending` on a terminal finish (turn end)", async () => {
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    act(() => capturedHandler!(assistantFinish("stop")))
    expect(result.current.sending).toBe(false)
  })

  it("ACP (no session.status): terminal finish marks idle, 'tool-calls' does not", async () => {
    sessionStatusCap = false // ACP signals idle via terminal finish, not session.status
    const { result } = renderHook(() =>
      useSessionMessages("s1", { initialSending: true }),
    )
    await waitFor(() => expect(result.current.sending).toBe(true))

    act(() => capturedHandler!(assistantFinish("tool-calls")))
    expect(markSessionIdle).not.toHaveBeenCalled()
    expect(result.current.sending).toBe(true)

    act(() => capturedHandler!(assistantFinish("stop")))
    expect(markSessionIdle).toHaveBeenCalledWith("s1")
    expect(result.current.sending).toBe(false)
  })
})

function activity(): SSEEvent {
  return {
    type: "message.part.updated",
    properties: { part: { messageID: "m1", sessionID: "s1", type: "text", text: "hi" } },
  } as unknown as SSEEvent
}

describe("useSessionMessages — Home→Session 8s safety timer", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("force-clears `sending` after 8s ONLY when the send never produced a turn (no activity)", () => {
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    expect(result.current.sending).toBe(true)
    act(() => { vi.advanceTimersByTime(8000) })
    expect(result.current.sending).toBe(false) // safety fired — turn never started
  })

  it("does NOT clear `sending` at 8s once real SSE activity proves the turn is live", () => {
    const { result } = renderHook(() => useSessionMessages("s1", { initialSending: true }))
    expect(result.current.sending).toBe(true)

    // A real turn started (part streamed) → safety timer must be cancelled, so a
    // long turn (>8s) is NOT flipped to a false "completed" state mid-flight.
    act(() => capturedHandler!(activity()))
    act(() => { vi.advanceTimersByTime(20000) })
    expect(result.current.sending).toBe(true)
  })
})
