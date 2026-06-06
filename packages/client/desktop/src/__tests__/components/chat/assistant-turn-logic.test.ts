import { describe, it, expect } from "vitest"
import { buildTurnModel } from "@/components/chat/assistant-turn"
import { groupIntoTurns } from "@/components/chat/message-list"
import type { SendMessageResponse, MessagePart, MessageInfo } from "@agent/api-client"

// --- builders ---------------------------------------------------------------

let seq = 0
function p(part: Partial<MessagePart> & { type: string }): MessagePart {
  return { id: `prt_${seq++}`, sessionID: "ses", messageID: "msg", ...part } as MessagePart
}

function msg(
  id: string,
  role: "user" | "assistant",
  parts: MessagePart[],
  info: Partial<MessageInfo> = {},
): SendMessageResponse {
  return {
    info: { id, sessionID: "ses", role, time: { created: 0 }, ...info },
    parts,
  }
}

const text = (t: string) => p({ type: "text", text: t })
const reasoning = (t: string) => p({ type: "reasoning", text: t })
const tool = (status: "completed" | "error" = "completed") =>
  p({
    type: "tool",
    tool: "bash",
    callID: "c",
    state:
      status === "error"
        ? { status: "error", input: {}, error: "boom", time: { start: 0, end: 1 } }
        : { status: "completed", input: {}, output: "ok", title: "Run", metadata: {}, time: { start: 0, end: 5 } },
  } as Partial<MessagePart> & { type: string })
const stepFinish = (tokens: { input: number; output: number; reasoning: number }, cost = 0) =>
  p({ type: "step-finish", reason: "stop", cost, tokens: { ...tokens, cache: { read: 0, write: 0 } } } as Partial<MessagePart> & { type: string })

// --- groupIntoTurns ---------------------------------------------------------

describe("groupIntoTurns", () => {
  it("groups a user message and its following assistant messages into one turn", () => {
    const messages = [
      msg("u1", "user", [text("hi")]),
      msg("a1", "assistant", [tool()]),
      msg("a2", "assistant", [tool()]),
      msg("a3", "assistant", [text("done")]),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups.map((g) => g.kind)).toEqual(["user", "assistant"])
    expect(groups[1].kind === "assistant" && groups[1].messages).toHaveLength(3)
  })

  it("separates multiple turns", () => {
    const messages = [
      msg("u1", "user", [text("q1")]),
      msg("a1", "assistant", [text("r1")]),
      msg("u2", "user", [text("q2")]),
      msg("a2", "assistant", [text("r2")]),
    ]
    const groups = groupIntoTurns(messages)
    expect(groups.map((g) => g.kind)).toEqual(["user", "assistant", "user", "assistant"])
  })
})

// --- buildTurnModel ---------------------------------------------------------

describe("buildTurnModel", () => {
  it("routes the last answer-step output to answer, everything else to process", () => {
    const messages = [
      msg("a1", "assistant", [reasoning("think"), tool(), stepFinish({ input: 10, output: 2, reasoning: 1 })], {
        finish: "tool-calls",
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 0, write: 0 } },
      }),
      msg("a2", "assistant", [text("the final answer"), stepFinish({ input: 5, output: 8, reasoning: 0 })], {
        finish: "stop",
        tokens: { input: 5, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ]
    const model = buildTurnModel(messages, false)
    expect(model.answer).toHaveLength(1)
    expect(model.answer[0].type).toBe("text")
    expect((model.answer[0] as { text: string }).text).toBe("the final answer")
    // process has reasoning + tool + 2 step-finish (last step-finish is not output)
    expect(model.process.some((x) => x.type === "reasoning")).toBe(true)
    expect(model.process.some((x) => x.type === "tool")).toBe(true)
    expect(model.stepCount).toBe(2)
    expect(model.tokens).toEqual({ input: 15, output: 10, reasoning: 1 })
    expect(model.visibleProcessCount).toBeGreaterThan(0)
  })

  it("treats an in-flight last tool step as all-process (no premature answer)", () => {
    const messages = [
      msg("a1", "assistant", [text("let me check"), tool()], { finish: "tool-calls" }),
    ]
    const model = buildTurnModel(messages, true)
    expect(model.answer).toHaveLength(0)
    expect(model.process.some((x) => x.type === "text")).toBe(true)
    expect(model.process.some((x) => x.type === "tool")).toBe(true)
  })

  it("shows no flow container for a simple single-message answer", () => {
    const messages = [msg("a1", "assistant", [text("just an answer"), stepFinish({ input: 1, output: 1, reasoning: 0 })], { finish: "stop" })]
    const model = buildTurnModel(messages, false)
    expect(model.answer).toHaveLength(1)
    expect(model.visibleProcessCount).toBe(0) // only a step-finish in process → not visible
  })

  it("detects an errored tool", () => {
    const messages = [
      msg("a1", "assistant", [tool("error")], { finish: "tool-calls" }),
      msg("a2", "assistant", [text("recovered")], { finish: "stop" }),
    ]
    expect(buildTurnModel(messages, false).hasError).toBe(true)
  })

  it("aggregates cache / model / completion time for the turn footer", () => {
    const messages = [
      msg("a1", "assistant", [tool()], {
        finish: "tool-calls",
        modelID: "qwen3.6-plus",
        tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 100, write: 5 } },
      }),
      msg("a2", "assistant", [text("answer")], {
        finish: "stop",
        modelID: "qwen3.6-plus",
        time: { created: 1000, completed: 4000 },
        tokens: { input: 5, output: 8, reasoning: 0, cache: { read: 50, write: 0 } },
      }),
    ]
    const model = buildTurnModel(messages, false)
    expect(model.cache).toEqual({ read: 150, write: 5 })
    expect(model.modelID).toBe("qwen3.6-plus")
    expect(model.completedAt).toBe(4000)
  })

  it("falls back to summing all step-finish tokens when message info lacks them", () => {
    const messages = [
      msg("a1", "assistant", [tool(), stepFinish({ input: 3, output: 4, reasoning: 0 }, 0.01)], { finish: "tool-calls" }),
      msg("a2", "assistant", [text("answer"), stepFinish({ input: 7, output: 9, reasoning: 2 }, 0.02)], { finish: "stop" }),
    ]
    const model = buildTurnModel(messages, false)
    expect(model.tokens).toEqual({ input: 10, output: 13, reasoning: 2 }) // summed across BOTH step-finish
    expect(model.cost).toBeCloseTo(0.03)
  })
})
