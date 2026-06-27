import { KnowledgeStore } from "./store"
import { createTfIdfEmbedder } from "./embedder"
import { Indexer } from "./indexer"
import { createApp } from "./kb-server"
import { startMcpBridge } from "./mcp-bridge"
import { createRetriever } from "./retriever"
import { FileWatcher } from "./watcher"
import { registerAdapter } from "./adapters/registry"
import { LocalFolderAdapter } from "./adapters/local-folder"
import { IMAAdapter } from "./adapters/ima"
import { homedir } from "node:os"
import { join } from "node:path"

const KB_PORT = 4098
// os.homedir() resolves USERPROFILE on Windows and HOME on macOS/Linux.
const DB_DIR = join(homedir(), ".ultrawork", "knowledge")
const DB_PATH = join(DB_DIR, "kb.db")

async function ensureDir(dir: string) {
  const fs = await import("fs")
  if (!fs.existsSync(dir)) {
    // mode is a no-op on Windows; harmless and correct on Unix.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

async function initCore() {
  const store = new KnowledgeStore(DB_PATH)
  const embedder = createTfIdfEmbedder({ dimension: 384 })
  const indexer = new Indexer(store, embedder)
  const retriever = createRetriever(store, embedder)

  // Register adapters
  registerAdapter(new LocalFolderAdapter(retriever))
  registerAdapter(new IMAAdapter())

  return { store, embedder, indexer, retriever }
}

async function serve() {
  console.log("Knowledge Sidecar starting...")

  await ensureDir(DB_DIR)

  const { store, indexer, retriever } = await initCore()

  // File watcher — auto re-index on changes
  const watcher = new FileWatcher()

  const app = createApp({ indexer, search: retriever, store, watcher })

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: KB_PORT,
    fetch: (req) => app.fetch(req),
  })

  console.log(`Knowledge Sidecar listening on 127.0.0.1:${server.port}`)
  watcher.onChange((folderPath, filePath, eventType) => {
    if (eventType === "change") {
      indexer.reindexFile(folderPath, filePath).catch((err) => {
        console.error(`[watcher] Re-index failed for ${filePath}:`, err)
      })
    } else if (eventType === "delete") {
      indexer.removeFile(filePath)
    }
  })

  // Watch all currently indexed folders
  for (const folder of indexer.listFolders()) {
    if (folder.status === "complete") {
      watcher.watchFolder(folder.folderPath)
    }
  }

  // Watch new folders as they get indexed
  indexer.addProgressListener((event) => {
    if (event.status === "complete") {
      watcher.watchFolder(event.folderPath)
    }
  })

  // Auto-migrate legacy Phase 1 data to parent-child chunks (background)
  indexer.autoMigrate().catch((err) => {
    console.error("[serve] Auto-migration failed:", err)
  })

  let shuttingDown = false
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log("Knowledge Sidecar shutting down...")
    watcher.unwatchAll()
    store.close()
    server.stop()
    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

async function mcpStdio() {
  await ensureDir(DB_DIR)

  const { store, indexer, retriever } = await initCore()

  const shutdown = () => {
    store.close()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  // Direct mode — search in-process, no HTTP proxy needed
  await startMcpBridge({ search: retriever, indexer, store })
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
