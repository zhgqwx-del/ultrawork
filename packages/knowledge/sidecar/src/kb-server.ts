import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import type { Indexer } from "./indexer"
import type { SearchResult, IndexProgressEvent } from "./types"
import type { SearchOptions } from "./retriever"
import type { FileWatcher } from "./watcher"

export function createApp(
  indexer: Indexer,
  search: (options: SearchOptions) => SearchResult[],
  watcher?: FileWatcher,
): Hono {
  const app = new Hono()

  // SSE listeners for progress events
  const sseListeners = new Set<(event: IndexProgressEvent) => void>()

  // Wire up indexer progress → SSE broadcast
  indexer.addProgressListener((event) => {
    for (const listener of sseListeners) {
      try { listener(event) } catch { /* ignore closed connections */ }
    }
  })

  // CORS — same origins as Gateway sidecar
  app.use(
    "/*",
    cors({
      origin: [
        "tauri://localhost",
        "https://tauri.localhost",
        "http://tauri.localhost",
        "http://localhost:1420",
      ],
    }),
  )

  // Health check
  app.get("/kb/health", (c) => c.json({ status: "ok" }))

  // List all indexed folders
  app.get("/kb/sources", (c) => {
    const sources = indexer.listFolders()
    return c.json({ sources })
  })

  // Add a folder and start indexing
  app.post("/kb/sources", async (c) => {
    try {
      const { folderPath } = await c.req.json<{ folderPath: string }>()
      if (!folderPath || typeof folderPath !== "string") {
        return c.json({ error: "folderPath is required" }, 400)
      }

      const sync = c.req.query("sync") === "true"

      if (sync) {
        // Synchronous mode: wait for completion (MCP bridge compat)
        const status = await indexer.indexFolder(folderPath)
        return c.json(status, 201)
      }

      // Async mode: start indexing in background, return immediately
      const initialStatus = indexer.getStatus(folderPath)
      indexer.indexFolder(folderPath).catch((err) => {
        console.error(`Background indexing failed for ${folderPath}:`, err)
      })

      return c.json(
        {
          ...initialStatus,
          folderPath,
          status: "indexing",
        },
        202,
      )
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      )
    }
  })

  // SSE endpoint for real-time indexing progress
  app.get("/kb/sources/events", (c) => {
    return streamSSE(c, async (stream) => {
      const listener = (event: IndexProgressEvent) => {
        stream.writeSSE({
          event: event.status,
          data: JSON.stringify(event),
        }).catch(() => {
          // Connection closed, will be cleaned up
        })
      }

      sseListeners.add(listener)

      // Send current statuses as initial state
      const currentSources = indexer.listFolders()
      for (const source of currentSources) {
        await stream.writeSSE({
          event: "status",
          data: JSON.stringify(source),
        })
      }

      // Keep connection alive — abort on client disconnect
      try {
        while (true) {
          await stream.sleep(30_000) // Keep-alive interval
        }
      } catch {
        // Stream closed by client
      } finally {
        sseListeners.delete(listener)
      }
    })
  })

  // Get indexing status for a folder
  app.get("/kb/sources/:folderPath{.+}", (c) => {
    const folderPath = decodeURIComponent(c.req.param("folderPath"))
    const status = indexer.getStatus(folderPath)
    return c.json(status)
  })

  // Remove an indexed folder
  app.delete("/kb/sources/:folderPath{.+}", async (c) => {
    try {
      const folderPath = decodeURIComponent(c.req.param("folderPath"))
      await indexer.removeFolder(folderPath)
      watcher?.unwatchFolder(folderPath)
      return c.json({ ok: true })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      )
    }
  })

  // Re-index a folder
  app.post("/kb/sources/:folderPath{.+}/reindex", async (c) => {
    try {
      const folderPath = decodeURIComponent(c.req.param("folderPath"))

      const sync = c.req.query("sync") === "true"
      if (sync) {
        const status = await indexer.indexFolder(folderPath)
        return c.json(status)
      }

      // Async mode
      indexer.indexFolder(folderPath).catch((err) => {
        console.error(`Background reindex failed for ${folderPath}:`, err)
      })

      return c.json({ folderPath, status: "indexing" }, 202)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      )
    }
  })

  // Search the knowledge base
  app.post("/kb/search", async (c) => {
    try {
      const body = await c.req.json<{
        query: string
        limit?: number
        retrieval?: "hybrid" | "semantic" | "keyword"
      }>()

      if (!body.query || typeof body.query !== "string") {
        return c.json({ error: "query is required" }, 400)
      }

      const results = search({
        query: body.query,
        limit: body.limit,
        retrieval: body.retrieval,
      })

      return c.json({ results })
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      )
    }
  })

  return app
}
