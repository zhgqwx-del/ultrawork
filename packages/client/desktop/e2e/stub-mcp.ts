// Stub stdio MCP that echoes the call's `_meta` back as the tool result, so the
// meta-passthrough harness can verify opencode forwards the running sessionID via
// MCP `_meta` (ADR-035 vendor patch). stdout belongs to MCP — log via stderr only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

const server = new McpServer({ name: "metachk", version: "0.1.0" })
server.tool("ping", "Returns the MCP _meta of this call.", {}, async (_input, extra) => {
  return { content: [{ type: "text", text: "META:" + JSON.stringify((extra as { _meta?: unknown })._meta ?? {}) }] }
})
await server.connect(new StdioServerTransport())
console.error("[stub-mcp] connected")
