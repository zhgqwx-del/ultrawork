import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { PlanStep } from "@agent/api-client"

// Controllable connector + subscription mocks.
let capturedHandler: (e: unknown) => void = () => {}
let resolveGetPlan: (v: PlanStep[]) => void = () => {}
let rejectGetPlan: (e: unknown) => void = () => {}
const getPlan = vi.fn(
  () =>
    new Promise<PlanStep[]>((res, rej) => {
      resolveGetPlan = res
      rejectGetPlan = rej
    }),
)

// Stable connector identity — the real context value is memoized; a fresh
// object per render would retrigger the [connector] effect endlessly.
const mockConnector = {
  getPlan,
  // Binding store stub: stable subscription, fixed binding (no flips in these tests).
  bindings: { onChange: (_cb: () => void) => () => {}, get: (_id: string) => "opencode" },
}
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => mockConnector,
  useSessionSubscribe: (_sid: string | undefined, handler: (e: unknown) => void) => {
    capturedHandler = handler
  },
}))

import { useSessionPlan } from "@/lib/use-session-plan"

const planEvent = (sessionID: string, entries: PlanStep[]) => ({
  type: "plan.updated",
  properties: { sessionID, entries },
})

const A: PlanStep[] = [{ content: "snapshot step", status: "pending" }]
const B: PlanStep[] = [{ content: "live step", status: "in_progress" }]

describe("useSessionPlan (ADR-038)", () => {
  beforeEach(() => {
    getPlan.mockClear()
  })

  it("hydrates from getPlan when no live event arrives", async () => {
    const { result } = renderHook(() => useSessionPlan("s1"))
    expect(result.current.loading).toBe(true)
    await act(async () => {
      resolveGetPlan(A)
    })
    expect(result.current.steps).toEqual(A)
    expect(result.current.loading).toBe(false)
  })

  it("applies a live plan.updated (whole-list replace)", async () => {
    const { result } = renderHook(() => useSessionPlan("s1"))
    await act(async () => {
      resolveGetPlan(A)
    })
    act(() => {
      capturedHandler(planEvent("s1", B))
    })
    expect(result.current.steps).toEqual(B)
  })

  it("ignores plan.updated for a different session", async () => {
    const { result } = renderHook(() => useSessionPlan("s1"))
    await act(async () => {
      resolveGetPlan(A)
    })
    act(() => {
      capturedHandler(planEvent("other", B))
    })
    expect(result.current.steps).toEqual(A)
  })

  it("RACE: a live event that arrives before getPlan resolves is NOT clobbered by the stale snapshot", async () => {
    const { result } = renderHook(() => useSessionPlan("s1"))
    // Live event races ahead of the in-flight getPlan.
    act(() => {
      capturedHandler(planEvent("s1", B))
    })
    expect(result.current.steps).toEqual(B)
    // getPlan now resolves with an OLDER snapshot — must be ignored.
    await act(async () => {
      resolveGetPlan(A)
    })
    expect(result.current.steps).toEqual(B)
  })

  it("falls back to empty when getPlan rejects (no plan / backend without support)", async () => {
    const { result } = renderHook(() => useSessionPlan("s1"))
    await act(async () => {
      rejectGetPlan(new Error("boom"))
    })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.steps).toEqual([])
  })
})
