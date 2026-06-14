// Integration guard for the debounced "settled" appearance: mounts AssistantTurn
// and asserts that flipping isStreaming true→false does NOT immediately render the
// completed state (stats footer) — it waits SETTLE_MS — so a sub-second SSE
// flicker can't flash a premature "done". Locks the useStableStreaming wiring
// (footer / flow collapse) against accidental reverts to raw isStreaming.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, act } from "@testing-library/react"
import { AssistantTurn } from "@/components/chat/assistant-turn"
import { SETTLE_MS } from "@/components/chat/assistant-turn"
import type { SendMessageResponse } from "@agent/api-client"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

let seq = 0
function msg(opts: { finish?: string; parts?: any[] } = {}): SendMessageResponse {
  const id = `m${seq++}`
  return {
    info: { id, sessionID: "s", role: "assistant", time: { created: 1, completed: 2 }, finish: opts.finish } as any,
    parts: (opts.parts ?? []).map((p, i) => ({ id: `${id}_p${i}`, sessionID: "s", messageID: id, ...p })),
  }
}

// A finished multi-step turn: a tool step + a final text answer.
const turn: SendMessageResponse[] = [
  msg({ finish: "tool-calls", parts: [{ type: "reasoning", text: "thinking" }, { type: "tool", callID: "c1", tool: "read", state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } } }] }),
  msg({ finish: "stop", parts: [{ type: "text", text: "the answer" }] }),
]
const hasFooter = (el: HTMLElement) => el.textContent?.includes("message.tokensInput") ?? false

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("AssistantTurn — debounced completed appearance", () => {
  it("does not show the stats footer until streaming has settled for SETTLE_MS", () => {
    const { container, rerender } = render(<AssistantTurn messages={turn} isStreaming={true} />)
    expect(hasFooter(container)).toBe(false) // streaming → no footer

    // Turn ends (isStreaming → false). Footer must NOT appear yet — this window
    // is where an SSE flicker would otherwise flash a premature "done".
    act(() => { rerender(<AssistantTurn messages={turn} isStreaming={false} />) })
    act(() => { vi.advanceTimersByTime(SETTLE_MS - 100) })
    expect(hasFooter(container)).toBe(false)

    // After the settle beat, the completed footer appears.
    act(() => { vi.advanceTimersByTime(200) })
    expect(hasFooter(container)).toBe(true)
  })

  it("a brief dip back to streaming within the window keeps it non-settled (no flash)", () => {
    const { container, rerender } = render(<AssistantTurn messages={turn} isStreaming={true} />)
    act(() => { rerender(<AssistantTurn messages={turn} isStreaming={false} />) })
    act(() => { vi.advanceTimersByTime(SETTLE_MS - 200) })
    // SSE trailing event flips it back to streaming before the beat elapses
    act(() => { rerender(<AssistantTurn messages={turn} isStreaming={true} />) })
    act(() => { vi.advanceTimersByTime(SETTLE_MS) })
    expect(hasFooter(container)).toBe(false) // never flashed done
  })

  it("a historical (already settled) turn shows the footer immediately — no settle delay", () => {
    const { container } = render(<AssistantTurn messages={turn} isStreaming={false} />)
    expect(hasFooter(container)).toBe(true)
  })
})
