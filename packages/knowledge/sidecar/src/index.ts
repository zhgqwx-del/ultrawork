import { KnowledgeStore } from "./store"
import { createTfIdfEmbedder } from "./embedder"
import { Indexer } from "./indexer"
import { createApp } from "./kb-server"
import { startMcpBridge } from "./mcp-bridge"
import { createRetriever } from "./retriever"

const KB_PORT = 4098
const DB_DIR = `${process.env.HOME}/.ultrawork/knowledge`
const DB_PATH = `${DB_DIR}/kb.db`

async function ensureDir(dir: string) {
  const fs = await import("fs")
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function initCore() {
  const store = new KnowledgeStore(DB_PATH)
  const embedder = createTfIdfEmbedder({ dimension: 384 })
  const indexer = new Indexer(store, embedder)
  const retriever = createRetriever(store, embedder)
  return { store, embedder, indexer, retriever }
}

async function serve() {
  console.log("Knowledge Sidecar starting...")

  await ensureDir(DB_DIR)

  const { store, indexer, retriever } = initCore()
  const app = createApp(indexer, retriever)

  const server = Bun.serve({
    port: KB_PORT,
    fetch: (req) => app.fetch(req),
  })

  console.log(`Knowledge Sidecar listening on port ${server.port}`)

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log("Knowledge Sidecar shutting down...")
    store.close()
    server.stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function mcpStdio() {
  await ensureDir(DB_DIR)

  const { indexer, retriever } = initCore()

  // Direct mode — search in-process, no HTTP proxy needed
  await startMcpBridge({ search: retriever, indexer })
}

async function main() {
  const subcommand = process.argv[2]

  if (subcommand === "mcp-stdio") {
    await mcpStdio()
  } else {
    await serve()
  }
}

main().catch((err) => {
  console.error("Knowledge Sidecar failed:", err)
  process.exit(1)
})
