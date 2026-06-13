// DOM-level guard for the spinner fix: mounts AssistantTurn and asserts the
// rendered output, closing the gap between "isStreaming logic returns false"
// and "the UI actually shows no spinner + surfaces the error". Pairs with the
// pure-logic assertions in error-turn-rendering.test.ts.

import { describe, it, expect, vi } from "vitest"
import { render } from "@testing-library/react"
import { AssistantTurn } from "@/components/chat/assistant-turn"
import type { SendMessageResponse } from "@agent/api-client"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => (key === "message.turnError" ? "Turn failed:" : key),
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

let seq = 0
function msg(role: "user" | "assistant", opts: { finish?: string; error?: any; parts?: any[] } = {}): SendMessageResponse {
  const id = `m${seq++}`
  return {
    info: { id, sessionID: "s", role, time: { created: 1, completed: 2 }, finish: opts.finish, ...(opts.error ? { error: opts.error } : {}) } as any,
    parts: (opts.parts ?? []).map((p, i) => ({ id: `${id}_p${i}`, sessionID: "s", messageID: id, ...p })),
  }
}
const reasoning = (t: string) => ({ type: "reasoning", text: t })
const tool = (status: "completed" | "error") => ({
  type: "tool", callID: `c${seq++}`, tool: "webfetch",
  state: { status, input: {}, ...(status === "completed" ? { output: "ok" } : { error: "boom" }) },
})

const SPIN = ".animate-spin"

describe("AssistantTurn DOM — errored turn shows error, not a spinner", () => {
  it("renders the error notice and NO spinner for an errored turn (sessionActive=false ⇒ isStreaming=false)", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("completed"), tool("error")] })
    const a2 = msg("assistant", {
      finish: undefined,
      error: { name: "APIError", data: { message: "Input data may contain inappropriate content" } },
      parts: [],
    })
    const { container } = render(<AssistantTurn messages={[a1, a2]} isStreaming={false} />)
    expect(container.textContent).toContain("Input data may contain inappropriate content")
    expect(container.textContent).toContain("Turn failed:")
    expect(container.querySelectorAll(SPIN).length).toBe(0) // no spinner anywhere
  })

  it("positive control: a streaming turn DOES render a spinner (so the no-spinner assertion is meaningful)", () => {
    const a1 = msg("assistant", { finish: "tool-calls", parts: [reasoning("…"), tool("completed")] })
    const { container } = render(<AssistantTurn messages={[a1]} isStreaming={true} />)
    expect(container.querySelectorAll(SPIN).length).toBeGreaterThan(0)
  })
})
