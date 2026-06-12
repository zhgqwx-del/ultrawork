// ACP Client Sidecar entry point (:4099).
//
// Subcommand dispatch runs BEFORE any server/manager construction:
// `acp-client delegate-mcp` is a stdio MCP shim whose stdout belongs to the
// MCP protocol — starting Bun.serve or logging to stdout there would corrupt
// the stream (knowledge-sidecar mcp-stdio precedent).

async function startServer(): Promise<void> {
  const { createServer } = await import("./acp-server.js")
  const { ACPManager } = await import("./acp-manager.js")
  const { loadAgentConfigs, agentsConfigPath } = await import("./agents-config.js")
  const { createOrchestrator } = await import("./orchestration.js")
  const { orchestrationRoutes } = await import("./orchestration-routes.js")

  const ACP_PORT = Number(process.env.ACP_CLIENT_PORT ?? 4099)

  const configs = loadAgentConfigs()
  const manager = new ACPManager(configs)
  const app = createServer(manager)

  // Orchestration layer (ADR-031): hosted here so runs survive WebView reloads.
  // Interrupted runs are marked, never auto-resumed.
  const { orchestrator, delegates } = createOrchestrator(manager)
  orchestrator.loadPersisted()
  app.route(
    "/",
    orchestrationRoutes(orchestrator, delegates, {
      // Delegate targets offered to the shim's list_agents tool: every
      // configured ACP agent (namespaced) plus the default opencode backend.
      listAgents: () => [
        { id: "opencode:default", name: "OpenCode", status: "available" },
        ...manager.listAgents().map((agent) => ({
          id: `acp:${agent.id}`,
          name: agent.label,
          status: agent.status,
          description: agent.description,
        })),
      ],
    }),
  )

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: ACP_PORT,
    idleTimeout: 0,
    fetch: (req) => app.fetch(req),
  })

  console.log(`[acp] sidecar listening on http://127.0.0.1:${server.port}`)
  console.log(`[acp] agents config: ${agentsConfigPath()} (${configs.map((c) => c.id).join(", ") || "none"})`)

  function shutdown() {
    void manager.shutdown().finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function main(): Promise<void> {
  if (process.argv[2] === "delegate-mcp") {
    const { runDelegateMcp } = await import("./delegate-mcp.js")
    await runDelegateMcp()
  } else {
    await startServer()
  }
}

main().catch((err) => {
  console.error("[acp] sidecar failed:", err)
  process.exit(1)
})
