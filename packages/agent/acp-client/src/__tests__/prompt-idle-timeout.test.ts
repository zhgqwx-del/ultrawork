// Idle-guard for ACP prompt() (gotchas §8): a stalled agent (no session/update
// for the idle window) must abort the turn instead of blocking prompt() forever
// — mirrors the opencode-side llm.ts idle guard. Tool execution is excused: an
// agent's tool_call can legitimately run for minutes with no chunks, so the
// watchdog is disarmed while any tool_call for the session is `in_progress`.
//
// These tests inject a fake ACP connection via private fields and drive
// session/update notifications by hand, so timing is deterministic. The idle
// constants are shrunk via env (read lazily in the implementation).

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { ACPConnection } from "../acp-connection"
import { TurnShaper } from "../turn-shaper"

const CONFIG = { id: "test-agent", label: "Test Agent", command: "x", args: [] as string[] }
const SID = "ses_idle"

beforeEach(() => {
  process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "120"
  process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "120"
  process.env.ACP_PROMPT_IDLE_CHECK_MS = "20"
  process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "5000" // high so tool-running tests don't trip it
})
afterEach(() => {
  delete process.env.ACP_PROMPT_TTFB_TIMEOUT_MS
  delete process.env.ACP_PROMPT_IDLE_TIMEOUT_MS
  delete process.env.ACP_PROMPT_IDLE_CHECK_MS
  delete process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS
})

/** Build a connection wired to a fake agent whose prompt() resolution we drive. */
function makeConn(promptImpl: () => Promise<{ stopReason: string; usage?: unknown }>) {
  let cancelled = false
  const conn = new ACPConnection(CONFIG, () => {})
  const c = conn as unknown as {
    status: string
    connection: unknown
    shapers: Map<string, TurnShaper>
    createClient(): { sessionUpdate(p: unknown): Promise<void> }
  }
  c.status = "connected"
  c.connection = {
    prompt: promptImpl,
    cancel: async () => {
      cancelled = true
    },
  }
  c.shapers.set(SID, new TurnShaper(SID, CONFIG.id, () => {}))
  // session/update arrives via the JSON-RPC client object the real transport
  // would call; we invoke its handler directly to simulate agent activity.
  const client = c.createClient()
  const update = (u: Record<string, unknown>) => client.sessionUpdate({ sessionId: SID, update: u })
  return { conn, update, wasCancelled: () => cancelled }
}

const never = () => new Promise<{ stopReason: string }>(() => {})
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("ACP prompt idle guard", () => {
  it("aborts a turn that goes fully silent past the idle window", async () => {
    const { conn, wasCancelled } = makeConn(never)
    await expect(conn.prompt(SID, "hi")).rejects.toThrow(/idle for 120ms/)
    // best-effort cancel told the agent to stop
    expect(wasCancelled()).toBe(true)
  })

  it("uses the longer TTFB budget before the agent's first update", async () => {
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "300"
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    const { conn } = makeConn(never)
    const t0 = Date.now()
    // No update ever arrives → still in the pre-first-token (TTFB) window.
    await expect(conn.prompt(SID, "hi")).rejects.toThrow(/idle for 300ms/)
    expect(Date.now() - t0).toBeGreaterThan(250) // did NOT fire at the 80ms idle bar
  })

  it("switches to the shorter idle bar after the first update", async () => {
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "5000"
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    const { conn, update } = makeConn(never)
    const p = conn.prompt(SID, "hi")
    const t0 = Date.now()
    await tick(5)
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })
    // agent spoke once then went silent → short idle bar applies, not TTFB.
    await expect(p).rejects.toThrow(/idle for 80ms/)
    expect(Date.now() - t0).toBeLessThan(1000) // nowhere near the 5000ms TTFB bar
  })

  it("a leading non-content frame (usage/plan) does NOT downgrade to the short idle bar", async () => {
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "300"
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    const { conn, update } = makeConn(never)
    const p = conn.prompt(SID, "hi")
    const t0 = Date.now()
    await tick(5)
    // plan frame before any content — must NOT count as "spoken"
    await update({ sessionUpdate: "plan", entries: [{ content: "x", priority: "high", status: "pending" }] })
    await expect(p).rejects.toThrow(/idle for 300ms/) // still TTFB, not 80ms idle
    expect(Date.now() - t0).toBeGreaterThan(250)
  })

  it("restores the TTFB budget for the first content after a tool completes", async () => {
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "300"
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    const { conn, update } = makeConn(never)
    const p = conn.prompt(SID, "hi")
    await tick(5)
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking" } }) // sawFirst=true
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" })
    await tick(20)
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }) // empties → sawFirst reset
    const tAfterTool = Date.now()
    // post-tool silence must get the 300ms TTFB bar again, not the 80ms idle bar
    await expect(p).rejects.toThrow(/idle for 300ms/)
    expect(Date.now() - tAfterTool).toBeGreaterThan(250)
  })

  it("does NOT abort while a tool_call is in_progress (excused window)", async () => {
    // Agent emits a tool_call that runs well past the idle window, then the
    // turn completes. The watchdog must stay disarmed the whole time.
    let resolveTurn!: (v: { stopReason: string }) => void
    const { conn, update } = makeConn(() => new Promise((r) => (resolveTurn = r)))
    const p = conn.prompt(SID, "do work")
    await tick(5) // let prompt() register promptActivity
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" })
    await tick(200) // 200ms > 120ms idle window — but tool is running
    resolveTurn({ stopReason: "end_turn" })
    await expect(p).resolves.toBe("end_turn")
  })

  it("aborts a wedged tool: in_progress but fully silent past the tool cap", async () => {
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "150"
    const { conn, update, wasCancelled } = makeConn(never)
    const p = conn.prompt(SID, "run shell")
    await tick(5)
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" })
    // no further updates — the tool is hung (gemini-shell style)
    await expect(p).rejects.toThrow(/tool silent for 150ms/)
    expect(wasCancelled()).toBe(true)
  })

  it("re-arms after a tool completes and aborts on later silence", async () => {
    const { conn, update } = makeConn(never)
    const p = conn.prompt(SID, "do work")
    await tick(5)
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "in_progress" })
    await tick(60)
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })
    // tool done → watchdog re-arms; no further updates → idle trips
    await expect(p).rejects.toThrow(/idle for 120ms/)
  })

  it("rejects a concurrent prompt on the same session (no idle-state cross-talk)", async () => {
    let resolveTurn!: (v: { stopReason: string }) => void
    const { conn } = makeConn(() => new Promise((r) => (resolveTurn = r)))
    const first = conn.prompt(SID, "first")
    await tick(5)
    await expect(conn.prompt(SID, "second")).rejects.toThrow(/in-flight prompt/)
    resolveTurn({ stopReason: "end_turn" })
    await expect(first).resolves.toBe("end_turn")
  })

  it("resets the idle window on ordinary activity (message chunks)", async () => {
    let resolveTurn!: (v: { stopReason: string }) => void
    const { conn, update } = makeConn(() => new Promise((r) => (resolveTurn = r)))
    const p = conn.prompt(SID, "stream")
    // Keep nudging activity faster than the idle window for ~250ms total.
    for (let i = 0; i < 5; i++) {
      await tick(50)
      await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })
    }
    resolveTurn({ stopReason: "end_turn" })
    await expect(p).resolves.toBe("end_turn")
  })
})

// ADR-049: the window between `tool_call{status:"pending"}` (the agent has
// announced a tool) and `in_progress` (it starts executing) is when the agent is
// STREAMING THE TOOL'S ARGUMENTS — and the claude adapter emits no session/update
// at all while it does. A large Write therefore goes minutes without a frame, and
// the 30s idle bar killed the turn (reproduced against the real claude agent: the
// turn died on a `pending` tool part whose input was still `{}`). Pending tools
// must be excused just like running ones.
describe("ACP idle guard — tool argument streaming (ADR-049)", () => {
  it("does not kill a turn silent past the idle bar while a tool_call is pending", async () => {
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "5000"
    let resolveTurn!: (v: { stopReason: string }) => void
    const { conn, update } = makeConn(() => new Promise((r) => (resolveTurn = r)))
    const p = (conn as unknown as { prompt(s: string, t: string): Promise<string> }).prompt(SID, "hi")
    // Agent speaks (sawFirst = true → the short idle bar would now apply)…
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "writing" } })
    // …announces the tool, then goes silent while streaming its arguments.
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "pending" })
    await tick(300) // >> idle bar (80ms), << tool-silence cap (5000ms)
    resolveTurn({ stopReason: "end_turn" })
    await expect(p).resolves.toBe("end_turn")
  })

  it("still breaks a turn wedged past the tool-silence cap while pending", async () => {
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "200"
    const { conn, update, wasCancelled } = makeConn(never)
    const p = (conn as unknown as { prompt(s: string, t: string): Promise<string> }).prompt(SID, "hi")
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "writing" } })
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "pending" })
    await expect(p).rejects.toThrow(/tool silent for 200ms/)
    expect(wasCancelled()).toBe(true)
  })

  it("a first tool_call frame with no status at all is treated as pending", async () => {
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "80"
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "5000"
    let resolveTurn!: (v: { stopReason: string }) => void
    const { conn, update } = makeConn(() => new Promise((r) => (resolveTurn = r)))
    const p = (conn as unknown as { prompt(s: string, t: string): Promise<string> }).prompt(SID, "hi")
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })
    await update({ sessionUpdate: "tool_call", toolCallId: "t1" }) // status omitted (SDK allows it)
    await tick(300)
    resolveTurn({ stopReason: "end_turn" })
    await expect(p).resolves.toBe("end_turn")
  })

  // The claude adapter also emits STATUSLESS tool_call_update frames AFTER a tool
  // finishes (PostToolUse Edit/Write diff; terminal-output meta for Bash). Such a
  // frame must not resurrect the finished tool into pendingTools — nothing would
  // ever remove it, and the watchdog would spend the rest of the turn stuck on the
  // 10-minute tool-silence bar instead of the 30s idle bar.
  it("a statusless tool_call_update after completion does not resurrect the tool", async () => {
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "100"
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "100"
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "5000"
    const { conn, update } = makeConn(never)
    const p = (conn as unknown as { prompt(s: string, t: string): Promise<string> }).prompt(SID, "hi")
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "pending" })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })
    // PostToolUse diff / terminal-output frame — no status field at all.
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1" })
    // The agent then goes silent: this MUST still be caught by the short bar.
    await expect(p).rejects.toThrow(/idle for 100ms|idle for 100ms/)
  })

  it("re-arms the short idle bar once the tool completes", async () => {
    process.env.ACP_PROMPT_IDLE_TIMEOUT_MS = "100"
    process.env.ACP_PROMPT_TTFB_TIMEOUT_MS = "100"
    process.env.ACP_PROMPT_TOOL_SILENCE_MAX_MS = "5000"
    const { conn, update } = makeConn(never)
    const p = (conn as unknown as { prompt(s: string, t: string): Promise<string> }).prompt(SID, "hi")
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } })
    await update({ sessionUpdate: "tool_call", toolCallId: "t1", status: "pending" })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" })
    await update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" })
    // Both sets are empty again → a silent agent must be caught, not excused.
    await expect(p).rejects.toThrow(/idle for 100ms/)
  })
})

describe("TurnShaper seal (no zombie content after a turn ends)", () => {
  it("drops session/update frames after failTurn until the next startTurn", () => {
    const events: unknown[] = []
    const shaper = new TurnShaper("s", "claude", (e) => events.push(e))
    shaper.startTurn("hi")
    shaper.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A" } } as never)
    shaper.failTurn("boom")
    const sealedAt = events.length
    // An aborted agent keeps emitting until cancel lands — must be dropped.
    shaper.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ZOMBIE" } } as never)
    expect(events.length).toBe(sealedAt)
    // The next turn re-opens normally.
    shaper.startTurn("again")
    shaper.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "B" } } as never)
    expect(events.length).toBeGreaterThan(sealedAt)
  })
})
