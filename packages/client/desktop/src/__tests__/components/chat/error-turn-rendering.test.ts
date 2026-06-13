// Regression guard for the "completed turn spins forever" bug (root-caused on
// a real Team delegate child whose turn ended with a provider content-moderation
// APIError: finish=undefined + info.error + empty parts → misread as streaming,
// persisted so it survived restart).
//
// The fix has two parts, both asserted here:
//   1. A turn is terminal if its last message has a terminal `finish` OR a
//      message-level `error` (isTurnTerminal).
//   2. The "non-terminal last message ⇒ streaming" inference only applies while
//      the session is actually live (isTurnStreaming gates on sessionActive).
// Plus the inverse guards the user worried about: a TOOL error mid-turn must NOT
// end the turn (agent keeps going), and a genuinely-live mid-turn still streams.

import { describe, it, expect } from "vitest"
import { isTurnTerminal, isTurnStreaming } from "@/components/chat/message-list"
import { buildTurnModel } from "@/components/chat/assistant-turn"
import type { SendMessageResponse } from "@agent/api-client"

let seq = 0
function msg(
  role: "user" | "assistant",
  opts: { finish?: string; error?: any; parts?: any[] } = {},
): SendMessageResponse {
  const id = `m${seq++}`
  return {
    info: {
      id,
      sessionID: "s",
      role,
      time: { created: 1, completed: 2 },
      finish: opts.finish,
      ...(opts.error ? { error: opts.error } : {}),
    } as any,
    parts: (opts.parts ?? []).map((p, i) => ({ id: `${id}_p${i}`, sessionID: "s", messageID: id, ...p })),
  }
}
const text = (t: string) => ({ type: "text", text: t })
const reasoning = (t: string) => ({ type: "reasoning", text: t })
const tool = (status: "completed" | "error", name = "webfetch") => ({
  type: "tool",
  callID: `c${seq++}`,
  tool: name,
  state: { status, input: {}, ...(status === "completed" ? { output: "ok" } : { error: "boom" }) },
})

const stream = (turnMessages: SendMessageResponse[], over: Partial<Parameters<typeof isTurnStreaming>[0]> = {}) =>
  isTurnStreaming({ turnMessages, isLastGroup: true, isStopped: false, sessionActive: false, streamingMessageId: null, ...over })

describe("error/interrupted turn terminal detection (spinner fix)", () => {
  // A — turn ended in a provider error (content moderation). The real shape:
  // a tool-step message, then an empty errored message with finish=undefined.
  it("A: an errored turn is terminal, not streaming, and surfaces the error", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("completed"), tool("error")] })
    const a2 = msg("assistant", {
      finish: undefined,
      error: { name: "APIError", data: { message: "Input data may contain inappropriate content" } },
      parts: [],
    })
    expect(isTurnTerminal(a2.info)).toBe(true)
    // Historical (sessionActive=false): must not spin.
    expect(stream([a1, a2], { sessionActive: false })).toBe(false)
    // Even if it were considered live, an errored last message is terminal.
    expect(stream([a1, a2], { sessionActive: true })).toBe(false)

    const model = buildTurnModel([a1, a2], false)
    expect(model.hasError).toBe(true)
    expect(model.errorText).toContain("inappropriate content")
  })

  // B — a TOOL fails but the agent recovers and the turn finishes normally.
  // This is the user's concern: a tool error must NOT end the turn.
  it("B: a tool error mid-turn does NOT end the turn; turn completes with an answer", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("error")] })
    const a2 = msg("assistant", { finish: "tool-calls", parts: [tool("completed")] })
    const a3 = msg("assistant", { finish: "stop", parts: [text("here is the answer")] })
    expect(isTurnTerminal(a3.info)).toBe(true)
    expect(stream([a1, a2, a3], { sessionActive: false })).toBe(false)
    expect(stream([a1, a2, a3], { sessionActive: true })).toBe(false) // terminal regardless

    const model = buildTurnModel([a1, a2, a3], false)
    expect(model.hasError).toBe(true) // tool error surfaced…
    expect(model.errorText).toBeUndefined() // …but it's NOT a turn-ending error
    expect(model.answer.some((p) => p.type === "text")).toBe(true)
  })

  // C — a genuinely live, in-progress turn must still stream (don't over-correct).
  it("C: a live mid-turn (finish=tool-calls) still streams when sessionActive", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("completed")] })
    expect(isTurnTerminal(a1.info)).toBe(false)
    expect(stream([a1], { sessionActive: true })).toBe(true) // working → spins
    expect(stream([a1], { sessionActive: false })).toBe(false) // historical → settled
    // streamingMessageId match keeps it live even between steps.
    expect(stream([a1], { sessionActive: false, streamingMessageId: a1.info.id })).toBe(true)
  })

  // D — interrupted turn (app closed mid-step): empty trailing message, no error.
  it("D: an interrupted non-terminal turn renders settled when not live", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("completed")] })
    const a2 = msg("assistant", { finish: undefined, parts: [] }) // dangling, no error
    expect(isTurnTerminal(a2.info)).toBe(false)
    expect(stream([a1, a2], { sessionActive: false })).toBe(false) // settled, no perpetual spin
    expect(stream([a1, a2], { sessionActive: true })).toBe(true) // if truly live, still streams
  })

  // Stopped turns never stream regardless.
  it("stopped turns never stream", () => {
    const a1 = msg("assistant", { finish: undefined, parts: [text("partial")] })
    expect(stream([a1], { sessionActive: true, isStopped: true })).toBe(false)
  })
})
