// ACP Client Sidecar entry point (:4099).

import { createServer } from "./acp-server.js"
import { ACPManager } from "./acp-manager.js"
import { loadAgentConfigs, agentsConfigPath } from "./agents-config.js"
import { createOrchestrator } from "./orchestration.js"
import { orchestrationRoutes } from "./orchestration-routes.js"

const ACP_PORT = Number(process.env.ACP_CLIENT_PORT ?? 4099)

const configs = loadAgentConfigs()
const manager = new ACPManager(configs)
const app = createServer(manager)

// Orchestration layer (ADR-031): hosted here so runs survive WebView reloads.
// Interrupted runs are marked, never auto-resumed.
const orchestrator = createOrchestrator(manager)
orchestrator.loadPersisted()
app.route("/", orchestrationRoutes(orchestrator))

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
