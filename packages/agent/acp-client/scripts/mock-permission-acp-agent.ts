// Actual stdio RPC fixture for sparse Codex permission presentation. No tools,
// network, model account or user files are accessed by this test agent.
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk"
import type { SessionUpdate } from "@agentclientprotocol/sdk"

const output = new WritableStream<Uint8Array>({ write: (chunk) => new Promise<void>((yes, no) => process.stdout.write(chunk, (error) => error ? no(error) : yes())) })
new AgentSideConnection((conn) => ({
  async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} } },
  async authenticate() { return {} },
  async newSession() { return { sessionId: "permission-fixture-session" } },
  async cancel() {},
  async prompt(params) {
    const send = (update: SessionUpdate) => conn.sessionUpdate({ sessionId: params.sessionId, update })
    const toolCallId = "exec-permission-fixture"
    const shell = process.env.MOCK_PERMISSION_SCENARIO === "shell"
    const rawInput = shell ? { command: "echo fixture-only", server: "orchestrator", tool: "delegate", arguments: {} } :
      { server: "orchestrator", tool: "delegate", arguments: { agentId: "acp:member", cwd: "客户 workspace", task: "你是谁？" } }
    await send({ sessionUpdate: "tool_call", toolCallId, title: toolCallId, kind: "execute", status: "pending" })
    await send({ sessionUpdate: "tool_call_update", toolCallId, title: "mcp.orchestrator.delegate", rawInput, status: "in_progress" })
    const reply = await conn.requestPermission({
      sessionId: params.sessionId,
      toolCall: { toolCallId, kind: "execute", title: toolCallId },
      options: [
        { kind: "allow_once", optionId: "one-exact-option", name: "Allow once" },
        { kind: "allow_always", optionId: "always-exact-option", name: "Always allow" },
        { kind: "reject_once", optionId: "reject-exact-option", name: "Reject" },
      ],
    })
    const selected = reply.outcome.outcome === "selected" ? reply.outcome.optionId : "cancelled"
    const allowed = ["one-exact-option", "always-exact-option"].includes(selected)
    await send({ sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed", content: [] })
    await send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ selected, allowed }) } })
    return { stopReason: "end_turn" }
  },
}), ndJsonStream(output, Bun.stdin.stream()))
