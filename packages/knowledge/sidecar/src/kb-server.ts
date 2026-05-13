import { Hono } from "hono"
import { cors } from "hono/cors"
import type { Indexer } from "./indexer"
import type { SearchResult } from "./types"
import type { SearchOptions } from "./retriever"

export function createApp(
  indexer: Indexer,
  search: (options: SearchOptions) => SearchResult[],
): Hono {
  const app = new Hono()

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

      // Start indexing (async, but we wait for completion in Phase 1)
      const status = await indexer.indexFolder(folderPath)
      return c.json(status, 201)
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      )
    }
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
      const status = await indexer.indexFolder(folderPath)
      return c.json(status)
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
