import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { SendMessageResponse } from "@agent/api-client"

const invokeMock = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: any[]) => invokeMock(...a) }))

import { useSessionArtifacts } from "@/lib/use-session-artifacts"

const WS = "/ws/project"

function msg(id: string, role: "user" | "assistant", created: number, sessionID = "s1", parts: any[] = []): SendMessageResponse {
  return {
    info: { id, sessionID, role, time: { created, completed: created + 100 } },
    parts,
  } as unknown as SendMessageResponse
}

const write = (path: string) => ({
  type: "tool",
  tool: "write",
  state: { status: "completed", input: { filePath: `${WS}/${path}` } },
})

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue([])
})

/**
 * `messages` gets a fresh array identity on every `message.part.delta`, so a plain
 * memo would re-derive the whole per-turn table for every streamed token. Measured,
 * that roughly doubles the per-delta cost of the artifact pipeline — and every bit
 * of it is thrown away, because the strip is hidden while a turn streams and a
 * settled turn's artifacts cannot change while a later one is still running.
 */
describe("useSessionArtifacts — byTurn is not recomputed per token", () => {
  it("hands back the same map while the agent is active, even as messages churn", async () => {
    const base = [msg("u1", "user", 1000), msg("a1", "assistant", 1100, "s1", [write("report.md")])]

    const { result, rerender } = renderHook(
      ({ messages, active }: { messages: SendMessageResponse[]; active: boolean }) =>
        useSessionArtifacts(messages, WS, active),
      { initialProps: { messages: base, active: false } }
    )

    await waitFor(() => expect(result.current.settled).toBe(true))
    const settledMap = result.current.byTurn
    expect(settledMap.get("a1")?.map((a) => a.path)).toEqual(["report.md"])

    // A turn starts. Each "delta" hands the hook a NEW array (same content) — what
    // use-session-messages really does via setMessages(prev => …).
    rerender({ messages: [...base], active: true })
    const first = result.current.byTurn
    rerender({ messages: [...base], active: true })
    rerender({ messages: [...base], active: true })

    expect(result.current.byTurn).toBe(first) // identical reference: no recompute
  })

  it("recomputes once the turn settles", async () => {
    const base = [msg("u1", "user", 1000), msg("a1", "assistant", 1100, "s1", [write("report.md")])]
    const { result, rerender } = renderHook(
      ({ messages, active }: { messages: SendMessageResponse[]; active: boolean }) =>
        useSessionArtifacts(messages, WS, active),
      { initialProps: { messages: base, active: true } }
    )

    const grown = [...base, msg("a2", "assistant", 1300, "s1", [write("chart.png")])]
    rerender({ messages: grown, active: true })
    rerender({ messages: grown, active: false })

    await waitFor(() =>
      expect(result.current.byTurn.get("a1")?.map((a) => a.path).sort()).toEqual(["chart.png", "report.md"])
    )
  })

  // The trap in caching across renders: if the cached map outlived a session switch,
  // one session's cards would hang under another session's turns.
  it("never hands one session's map to another, even mid-stream", async () => {
    const s1 = [msg("u1", "user", 1000), msg("a1", "assistant", 1100, "s1", [write("report.md")])]
    const { result, rerender } = renderHook(
      ({ messages, active }: { messages: SendMessageResponse[]; active: boolean }) =>
        useSessionArtifacts(messages, WS, active),
      { initialProps: { messages: s1, active: false } }
    )
    await waitFor(() => expect(result.current.byTurn.has("a1")).toBe(true))

    // Switch to another session while it is streaming.
    const s2 = [msg("u9", "user", 5000, "s2"), msg("a9", "assistant", 5100, "s2", [write("other.md")])]
    rerender({ messages: s2, active: true })

    expect(result.current.byTurn.has("a1")).toBe(false) // not the old session's turn
    expect(result.current.byTurn.get("a9")?.map((a) => a.path)).toEqual(["other.md"])
  })
})
