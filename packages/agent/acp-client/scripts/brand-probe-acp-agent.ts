// Offline ACP fixture for scripts/verify-brand-sidecars.ts --agents. This speaks
// real ACP/MCP but never invokes a model, network account, or shell tool.
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION, type McpServer } from "@agentclientprotocol/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const context = JSON.parse(process.env.ULTRAWORK_BRAND_CONTEXT ?? "null")
assert(context?.identity?.brandId, "The probe agent lost its managed brand")
assert.equal(process.env.OPENCODE_APP_NAME, context.identity.namespace)
const sessions = new Map<string, { cwd: string; servers: McpServer[] }>()
const output = new WritableStream<Uint8Array>({
  write: (chunk) => new Promise<void>((yes, no) => process.stdout.write(chunk, (error) => error ? no(error) : yes())),
})

function record(value: Record<string, unknown>) {
  const file = process.env.BRAND_PROBE_LOG
  assert(file, "Probe log path is required")
  appendFileSync(file, JSON.stringify({ brandId: context.identity.brandId, role: process.env.BRAND_PROBE_ROLE, ...value }) + "\n")
}

async function withMcp(server: McpServer, action: (client: Client) => Promise<unknown>): Promise<unknown> {
  assert("command" in server, "Expected the host's stdio MCP")
  const env = Object.fromEntries(server.env.map(({ name, value }) => [name, value]))
  const childContext = JSON.parse(env.ULTRAWORK_BRAND_CONTEXT)
  assert.equal(childContext.identity.brandId, context.identity.brandId)
  assert.equal(childContext.instanceId, context.instanceId)
  assert(server.args.includes("--brand-context"), "Managed MCP needs an explicit context argument")
  const transport = new StdioClientTransport({ command: server.command, args: server.args, env, stderr: "pipe" })
  const client = new Client({ name: "offline-brand-probe", version: "1.0.0" })
  try {
    await client.connect(transport)
    return await action(client)
  } finally {
    await client.close()
    await transport.close()
  }
}

new AgentSideConnection((conn) => ({
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }
  },
  async authenticate() { return {} },
  async newSession(params) {
    const id = `brand-probe-${randomUUID()}`
    sessions.set(id, { cwd: params.cwd, servers: params.mcpServers })
    record({ event: "session", sessionId: id, cwd: params.cwd, mcp: params.mcpServers.map((server) => ({
      name: server.name, ...("command" in server ? { command: server.command, args: server.args } : {}),
    })) })
    return { sessionId: id }
  },
  async loadSession(params) {
    sessions.set(params.sessionId, { cwd: params.cwd, servers: params.mcpServers })
    record({ event: "restored", sessionId: params.sessionId, cwd: params.cwd })
    return {}
  },
  async prompt(params) {
    const session = sessions.get(params.sessionId)
    assert(session, "Unknown fixture session")
    const prompt = params.prompt.filter((part) => part.type === "text").map((part) => "text" in part ? part.text : "").join("\n")
    const evidence: Record<string, unknown> = { brandId: context.identity.brandId, namespace: process.env.OPENCODE_APP_NAME }
    const knowledge = session.servers.find((server) => server.name === "knowledge-base")
    if (knowledge) {
      const result = await withMcp(knowledge, (client) => client.callTool({ name: "knowledge_list_sources", arguments: {} }))
      assert(!((result as { isError?: boolean }).isError), "Knowledge MCP call failed")
      evidence.knowledge = result
    }
    if (prompt.includes("probe:leader-delegate")) {
      const orchestrator = session.servers.find((server) => server.name === "orchestrator")
      assert(orchestrator, "Team leader lost its delegate MCP")
      evidence.delegated = await withMcp(orchestrator, async (client) => {
        const available = await client.callTool({ name: "list_agents", arguments: { cwd: session.cwd } })
        assert(JSON.stringify(available).includes("acp:brand-member"), "Team member missing from MCP list_agents")
        const result = await client.callTool({ name: "delegate", arguments: {
          agentId: "acp:brand-member", task: "probe:member-answer", cwd: session.cwd, timeoutMs: 15_000,
        } })
        assert(!result.isError, "Delegate MCP rejected the child")
        assert(JSON.stringify(result).includes("completed"), "Delegate failed to complete")
        return result
      })
    }
    const artifact = prompt.match(/\uff08\u8986\u76d6\u5199\uff09\uff1a([^\n]+)/)?.[1]?.trim()
    if (artifact) {
      mkdirSync(dirname(artifact), { recursive: true })
      writeFileSync(artifact, JSON.stringify(evidence) + "\n")
      record({ event: "artifact", artifact, cwd: session.cwd })
    }
    record({ event: "turn", sessionId: params.sessionId, delegated: !!evidence.delegated, knowledge: !!knowledge })
    await conn.sessionUpdate({ sessionId: params.sessionId, update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(evidence) },
    } })
    return { stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
  },
  async cancel() {},
}), ndJsonStream(output, Bun.stdin.stream()))
