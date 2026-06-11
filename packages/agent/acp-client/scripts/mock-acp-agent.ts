// Deterministic mock ACP agent for offline turn-shaping tests.
//
// Speaks real ACP (JSON-RPC over stdio via the SDK) and replays a fixed turn:
// thought ×2 → narration → tool_call (pending → in_progress → completed) →
// final answer ×2 chunks → end_turn with usage. This is the canonical
// "reasoning + tool + answer" sequence W1 must shape correctly.

import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { SessionUpdate } from "@agentclientprotocol/sdk"

const stdout = new WritableStream<Uint8Array>({
  write: (chunk) =>
    new Promise<void>((resolve, reject) =>
      process.stdout.write(chunk, (err) => (err ? reject(err) : resolve())),
    ),
})

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
    async newSession() {
      return { sessionId: "mock-session-1" }
    },
    // W4b: replay a fixed prior turn as session/update notifications, the way
    // real agents stream history during session/load. The sidecar must
    // suppress all of it (history renders from its own store).
    async loadSession(params) {
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
      return {}
    },
    async prompt(params) {
      const send = (update: SessionUpdate) =>
        conn.sessionUpdate({ sessionId: params.sessionId, update })

      await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "I should list " } })
      await send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "the directory first." } })

      // Ask permission before running the tool (W3 loop). A denied/cancelled
      // outcome ends the turn without the tool, mirroring real agents.
      const perm = await conn.requestPermission({
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call_1", title: "List directory", kind: "execute" },
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

      return {
        stopReason: "end_turn",
        usage: { inputTokens: 100, outputTokens: 42, totalTokens: 142 },
      }
    },
    async cancel() {},
  }),
  ndJsonStream(stdout, Bun.stdin.stream()),
)
