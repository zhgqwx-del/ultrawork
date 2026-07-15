/**
 * ADR-057 P4 regression: the free-trial fallback resend must ACTUALLY dispatch.
 *
 * The first implementation fired the resend inline in the SSE idle handler, where
 * setSending(false)/markSessionIdle are still-unflushed setState — so sendMessage's busy guard
 * swallowed it and the resend was silently lost (found in adversarial review). The fix fires it
 * from an effect keyed on `sending`, after that state flushes. This test drives the full path:
 *   user send → session.error(auth) → advance candidate → session idle → resend on the next model.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { SSEEvent } from "@agent/connector"

vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), info: vi.fn() } }))

const markSessionIdle = vi.fn()
const markSessionActive = vi.fn()
const mockActiveIds = new Set<string>()
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({
    sessions: [],
    activeSessionIds: mockActiveIds,
    updateSession: vi.fn(),
    markSessionActive,
    markSessionIdle,
  }),
}))

const connector = {
  capabilitiesOf: () => ({ sessionStatus: true, globalEvents: true, revert: true }),
  fetchHistory: vi.fn().mockResolvedValue({ messages: [], cursor: undefined, hasMore: false }),
  cancel: vi.fn().mockResolvedValue(undefined),
  prompt: vi.fn().mockResolvedValue(undefined),
}

let capturedHandler: ((e: SSEEvent) => void) | null = null
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSessionSubscribe: (_sid: string | undefined, handler: (e: SSEEvent) => void) => { capturedHandler = handler },
}))

// The free-trial context: consented, on a Zen model, with a next candidate available.
const advanceFreeTrialModel = vi.fn().mockResolvedValue("opencode/deepseek-v4-flash-free")
vi.mock("@/lib/model-context", () => ({
  useModelOptional: () => ({ freeTrialConsent: true, currentModel: "opencode/big-pickle", advanceFreeTrialModel }),
}))

import { useSessionMessages, __resetMessageCache } from "@/lib/use-session-messages"

const authError = (): SSEEvent => ({
  type: "session.error",
  properties: { sessionID: "s1", error: { name: "AuthError", data: { message: "Missing API key." } } },
}) as unknown as SSEEvent

const idle = (): SSEEvent => ({
  type: "session.status",
  properties: { sessionID: "s1", status: { type: "idle" } },
}) as unknown as SSEEvent

beforeEach(() => {
  mockActiveIds.clear()
  __resetMessageCache()
  capturedHandler = null
  connector.prompt.mockClear()
  advanceFreeTrialModel.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe("free-trial fallback resend", () => {
  it("resends the last message on the next candidate after an auth failure + idle", async () => {
    const { result } = renderHook(() => useSessionMessages("s1"))

    // 1. Genuine user send on the seeded free model.
    act(() => result.current.sendMessage("hello", "opencode/big-pickle"))
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect((connector.prompt.mock.calls[0][2] as { model?: string }).model).toBe("opencode/big-pickle")

    // 2. The model 401s → session.error(auth) → advance to the next candidate (async).
    await act(async () => { capturedHandler!(authError()); await Promise.resolve() })
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(1)
    // Not resent yet — the turn is still "sending".
    expect(connector.prompt).toHaveBeenCalledTimes(1)

    // 3. The failed turn goes idle → the effect fires the resend on the new model.
    await act(async () => { capturedHandler!(idle()); await Promise.resolve() })
    await waitFor(() => expect(connector.prompt).toHaveBeenCalledTimes(2))
    expect((connector.prompt.mock.calls[1][2] as { model?: string }).model).toBe("opencode/deepseek-v4-flash-free")
  })

  it("does not resend when the error is unrelated (not auth/quota)", async () => {
    const { result } = renderHook(() => useSessionMessages("s1"))
    act(() => result.current.sendMessage("hello", "opencode/big-pickle"))
    expect(connector.prompt).toHaveBeenCalledTimes(1)

    // A non-auth error must not trigger the fallback machinery.
    await act(async () => {
      capturedHandler!({ type: "session.error", properties: { sessionID: "s1", error: { data: { message: "context length exceeded" } } } } as unknown as SSEEvent)
      await Promise.resolve()
    })
    await act(async () => { capturedHandler!(idle()); await Promise.resolve() })
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })
})
