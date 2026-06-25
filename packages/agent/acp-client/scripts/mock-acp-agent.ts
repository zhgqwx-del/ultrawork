// Deterministic mock ACP agent for offline turn-shaping tests.
//
// Speaks real ACP (JSON-RPC over stdio via the SDK) and replays a fixed turn:
// thought ×2 → narration → tool_call (pending → in_progress → completed) →
// final answer ×2 chunks → end_turn with usage. This is the canonical
// "reasoning + tool + answer" sequence W1 must shape correctly.

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk"

const stdout = new WritableStream<Uint8Array>({
  write: (chunk) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (err) => (err ? reject(err) : resolve())),
    ),
})

// Session config options mirroring claude-agent-acp ≥0.44's thought_level
// (id "effort"). Disable with MOCK_ACP_NO_CONFIG_OPTIONS=1 to play an agent
// without the option (the sidecar must skip silently). A set effort level is
// echoed into the next answer as " [effort=<level>]" so tests can observe it
// end-to-end without a side channel.
const ADVERTISE_CONFIG_OPTIONS = process.env.MOCK_ACP_NO_CONFIG_OPTIONS !== "1"
const sessionEffort = new Map<string, string>()

// MOCK_ACP_ECHO_PROMPT=1: echo the received wire prompt and any
// _meta.systemPrompt back as answer chunks, so tests can assert the
// system-prompt delivery path (meta vs first-prompt prefix) end-to-end
// without a side channel. Off by default — shaping tests assert exact chunks.
const ECHO_PROMPT = process.env.MOCK_ACP_ECHO_PROMPT === "1"
const sessionMetaSystem = new Map<string, string>()

function recordMetaSystemPrompt(sessionId: string, _meta: unknown): void {
  const meta = _meta as { systemPrompt?: { append?: unknown } | string } | undefined
  const sp = meta?.systemPrompt
  const append = typeof sp === "string" ? sp : typeof sp?.append === "string" ? sp.append : undefined
  if (append) sessionMetaSystem.set(sessionId, append)
}

function effortOptions(current: string): SessionConfigOption[] {
  return [
    {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: [
        { value: "default", name: "Default" },
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ]
}

function configOptionsFor(sessionId: string): SessionConfigOption[] | undefined {
  return ADVERTISE_CONFIG_OPTIONS ? effortOptions(sessionEffort.get(sessionId) ?? "default") : undefined
}

new AgentSideConnection(
  (conn) => ({
    async initialize() {
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true },
      }
    },
    async authenticate() {
      return {}
    },
    async newSession(params) {
      recordMetaSystemPrompt("mock-session-1", params._meta)
      return { sessionId: "mock-session-1", configOptions: configOptionsFor("mock-session-1") }
    },
    async setSessionConfigOption(params) {
      if (params.configId !== "effort" || typeof params.value !== "string") {
        throw new Error(`Unknown config option: ${params.configId}`)
      }
      sessionEffort.set(params.sessionId, params.value)
      return { configOptions: effortOptions(params.value) }
    },
    // W4b: replay a fixed prior turn as session/update notifications, the way
    // real agents stream history during session/load. The sidecar must
    // suppress all of it (history renders from its own store).
    async loadSession(params) {
      recordMetaSystemPrompt(params.sessionId, params._meta)
      const send = (update: SessionUpdate) =>
        conn.sessionUpdate({ sessionId: params.sessionId, update })
      await send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "list the files" } })
      await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Replayed thought." } })
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "replayed_call_1",
        title: "List directory",
        kind: "execute",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "a.txt\nb.txt" } }],
      })
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are two files." } })
      return { configOptions: configOptionsFor(params.sessionId) }
    },
    async prompt(params) {
      const send = (update: SessionUpdate) =>
        conn.sessionUpdate({ sessionId: params.sessionId, update })

      // MOCK_ACP_HOLD_MS: stream a thought, then go SILENT for the given
      // duration (no tool, no permission) before a short answer — a clean
      // "long thinking gap" with the turn genuinely in flight. Used by the
      // switch-away/back UI walkthrough (discussions/022): no PermissionDock to
      // muddy the rendered turn state. Additive + opt-in; default turn unchanged.
      const holdMs = Number(process.env.MOCK_ACP_HOLD_MS ?? 0)
      if (holdMs > 0) {
        await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking for a while…" } })
        await new Promise((resolve) => setTimeout(resolve, holdMs))
        await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } })
        return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      }

      if (ECHO_PROMPT) {
        const first = params.prompt.find((p) => p.type === "text")
        const wireText = first && "text" in first ? first.text : ""
        await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `[prompt=${wireText}]` } })
        const metaSystem = sessionMetaSystem.get(params.sessionId)
        if (metaSystem) {
          await send({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `[system-meta=${metaSystem}]` },
          })
        }
      }

      await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should list " } })
      await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the directory first." } })

      // Ask permission before running the tool (W3 loop). A denied/cancelled
      // outcome ends the turn without the tool, mirroring real agents.
      // Kind-less toolCall (only rawInput/title), like old claude-code-acp
      // ≤0.16.2 — keeps the permission-label fallback tiers covered.
      const perm = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call_1", title: "List directory", rawInput: { command: "ls" } },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      })
      if (perm.outcome.outcome !== "selected" || perm.outcome.optionId === "deny") {
        await send({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Permission denied — skipping the listing." },
        })
        return { stopReason: "end_turn" }
      }
      await send({
        sessionUpdate: "plan",
        entries: [
          { content: "List directory", priority: "high", status: "in_progress" },
          { content: "Summarize", priority: "medium", status: "pending" },
        ],
      })
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Let me check the files." } })
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "List directory",
        kind: "execute",
        status: "pending",
      })
      // Claude-adapter quirk (observed live): tool_call re-sent for the same
      // id with richer rawInput — the shaper must upsert, not duplicate.
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "call_1",
        title: "List directory",
        kind: "execute",
        status: "pending",
        rawInput: { command: "ls" },
      })
      await send({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: "in_progress" })
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: "call_1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "a.txt\nb.txt" } }],
      })
      await send({
        sessionUpdate: "plan",
        entries: [
          { content: "List directory", priority: "high", status: "completed" },
          { content: "Summarize", priority: "medium", status: "in_progress" },
        ],
      })
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "There are " } })
      await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "two files." } })
      const effort = sessionEffort.get(params.sessionId)
      if (effort && effort !== "default") {
        await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` [effort=${effort}]` } })
      }

      return {
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 42, totalTokens: 142 },
      }
    },
    async cancel() {},
  }),
  ndJsonStream(stdout, Bun.stdin.stream()),
)
