import { KnowledgeStore } from "./store"
import { createTfIdfEmbedder } from "./embedder"
import { Indexer } from "./indexer"
import { createApp, KB_SERVE_IDLE_TIMEOUT, type SidecarAuth } from "./kb-server"
import { startMcpBridge } from "./mcp-bridge"
import { createRetriever } from "./retriever"
import { FileWatcher } from "./watcher"
import { registerAdapter } from "./adapters/registry"
import { LocalFolderAdapter } from "./adapters/local-folder"
import { IMAAdapter } from "./adapters/ima"
import { homedir } from "node:os"
import { join } from "node:path"

// The Tauri host picks the port and injects it; the literal is the fallback for
// a standalone run (tests, `bun run`). Read `server.port` afterwards, never this
// — with port 0 the kernel picks and only the server knows.
const KB_PORT = Number(process.env.KB_PORT ?? 4098)

/**
 * Inbound Basic auth credentials, injected by the Tauri host (ADR-028's
 * per-install random password). Fail fast rather than start unauthenticated:
 * silently serving an unprotected /kb/* to every local process is worse than
 * not starting, and the host always sets this. Not reached by `mcp-stdio`,
 * which never opens a port.
 */
function requireSidecarAuth(name: string): SidecarAuth {
  const password = process.env.ULTRAWORK_SIDECAR_PASSWORD
  if (!password) {
    throw new Error(`ULTRAWORK_SIDECAR_PASSWORD is not set — the Tauri host must spawn ${name} with this env var`)
  }
  return { username: process.env.ULTRAWORK_SIDECAR_USERNAME ?? "opencode", password }
}
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

  const app = createApp({ indexer, search: retriever, store, watcher }, requireSidecarAuth("knowledge-sidecar"))

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: KB_PORT,
    idleTimeout: KB_SERVE_IDLE_TIMEOUT,
    fetch: (req) => app.fetch(req),
  })

  console.log(`Knowledge Sidecar listening on 127.0.0.1:${server.port}`)
  // Re-indexing runs through ONE sequential queue.
  //
  // A flush hands over every file in the batch at once, and each `reindexFile`
  // reads, hashes, chunks and embeds. Firing them together — which is what
  // fire-and-forget did — meant a single `git checkout` could put hundreds of
  // embedding runs in flight simultaneously and wedge the sidecar. Serialising
  // costs nothing in the common case (one or two edited files) and is the
  // difference between "slower for a while" and "unresponsive".
  let indexQueue: Promise<void> = Promise.resolve()
  const enqueue = (label: string, work: () => Promise<unknown>) => {
    indexQueue = indexQueue.then(() =>
      work().then(
        () => {},
        (err) => console.error(`[watcher] ${label} failed:`, err),
      ),
    )
  }

  watcher.onChange((folderPath, filePath, eventType) => {
    if (eventType === "change") {
      enqueue(`re-index ${filePath}`, () => indexer.reindexFile(folderPath, filePath))
    } else if (eventType === "delete") {
      indexer.removeFile(filePath)
    } else if (eventType === "rescan") {
      // A burst too large to even track file-by-file (watcher MAX_BATCH_FILES).
      // indexFolder is itself sequential and guarded against overlapping runs.
      enqueue(`full re-index ${folderPath}`, () => indexer.indexFolder(folderPath))
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
