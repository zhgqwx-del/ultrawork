import { ACPManager } from "./acp-manager"
import { createApp } from "./acp-server"

const ACP_PORT = 4099

async function serve() {
  console.log("[ACP] Starting ACP Client Sidecar...")

  // Initialize manager and load agent configs
  const manager = new ACPManager()
  await manager.loadConfigs()

  // Create HTTP server
  const app = createApp(manager)
  const server = Bun.serve({
    port: ACP_PORT,
    fetch: (req) => app.fetch(req),
  })

  console.log(`[ACP] Listening on http://localhost:${server.port}`)

  // Graceful shutdown
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log("[ACP] Shutting down...")
    await manager.shutdown()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function main() {
  await serve()
}

main().catch((err) => {
  console.error("[ACP] Fatal error:", err)
  process.exit(1)
})
