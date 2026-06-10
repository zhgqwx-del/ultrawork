// ACP Client Sidecar entry point (:4099).

import { createServer } from "./acp-server.js"
import { ACPManager } from "./acp-manager.js"
import { loadAgentConfigs, agentsConfigPath } from "./agents-config.js"

const ACP_PORT = Number(process.env.ACP_CLIENT_PORT ?? 4099)

const configs = loadAgentConfigs()
const manager = new ACPManager(configs)
const app = createServer(manager)

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: ACP_PORT,
  idleTimeout: 0,
  fetch: (req) => app.fetch(req),
})

console.log(`[acp] sidecar listening on http://127.0.0.1:${server.port}`)
console.log(`[acp] agents config: ${agentsConfigPath()} (${configs.map((c) => c.id).join(", ") || "none"})`)

function shutdown() {
  manager.shutdown()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
