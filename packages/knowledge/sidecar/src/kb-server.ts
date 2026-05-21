import { Hono } from "hono"
import { cors } from "hono/cors"
import { streamSSE } from "hono/streaming"
import type { Indexer } from "./indexer"
import type { SearchResult, IndexProgressEvent, KnowledgeSourceRow } from "./types"
import type { SearchOptions } from "./retriever"
import type { FileWatcher } from "./watcher"
import type { KnowledgeStore } from "./store"
import { getAdapter } from "./adapters/registry"

export interface AppDeps {
  indexer: Indexer
  search: (options: SearchOptions) => SearchResult[]
  store: KnowledgeStore
  watcher?: FileWatcher
}

export function createApp(deps: AppDeps): Hono {
  const { indexer, search, store, watcher } = deps
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

  // ---------------------------------------------------------------------------
  // Unified sources API (ID-based + backward compat)
  // ---------------------------------------------------------------------------

  // List all knowledge sources (unified)
  app.get("/kb/sources", (c) => {
    const ksSources = store.listKnowledgeSources()

    // Merge indexer status for local_folder sources
    const sources = ksSources.map((ks) => {
      if (ks.type === "local_folder") {
        const config = JSON.parse(ks.config_json) as { folderPath?: string }
        if (config.folderPath) {
          const indexerStatus = indexer.getStatus(config.folderPath)
          return {
            ...ksToResponse(ks),
            totalFiles: indexerStatus.totalFiles,
            indexedFiles: indexerStatus.indexedFiles,
            skippedFiles: indexerStatus.skippedFiles,
            currentFile: indexerStatus.currentFile,
            folderPath: config.folderPath, // backward compat
          }
        }
      }
      return ksToResponse(ks)
    })

    return c.json({ sources })
  })

  // SSE endpoint for real-time indexing progress
  app.get("/kb/sources/events", (c) => {
    return streamSSE(c, async (stream) => {
      const listener = (event: IndexProgressEvent) => {
        stream.writeSSE({
          event: event.status,
          data: JSON.stringify(event),
        }).catch(() => {})
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

      try {
        while (true) {
          await stream.sleep(30_000)
        }
      } catch {
        // Stream closed by client
      } finally {
        sseListeners.delete(listener)
      }
    })
  })

  // Create a new knowledge source (unified)
  app.post("/kb/sources", async (c) => {
    try {
      const body = await c.req.json<Record<string, unknown>>()

      // Backward compat: detect old { folderPath } shape
      if (body.folderPath && !body.type) {
        return handleAddLocalFolder(c, body.folderPath as string)
      }

      const type = body.type as string
      const name = body.name as string
      const config = (body.config ?? {}) as Record<string, unknown>

      if (!type || !name) {
        return c.json({ error: "type and name are required" }, 400)
      }

      if (type === "local_folder") {
        return handleAddLocalFolder(c, (config.folderPath ?? name) as string)
      }

      // Remote source types (IMA, custom_api): just create and return
      const id = store.createKnowledgeSource(type, name, config)
      return c.json({ id, type, name, status: "idle" }, 201)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // Get / Update / Delete by ID (numeric)
  app.get("/kb/sources/:idOrPath{[0-9]+}", (c) => {
    const id = parseInt(c.req.param("idOrPath"))
    const ks = store.getKnowledgeSource(id)
    if (!ks) return c.json({ error: "Source not found" }, 404)

    if (ks.type === "local_folder") {
      const config = JSON.parse(ks.config_json) as { folderPath?: string }
      if (config.folderPath) {
        const status = indexer.getStatus(config.folderPath)
        return c.json({
          ...ksToResponse(ks),
          ...status,
          folderPath: config.folderPath,
        })
      }
    }
    return c.json(ksToResponse(ks))
  })

  app.put("/kb/sources/:id{[0-9]+}", async (c) => {
    try {
      const id = parseInt(c.req.param("id"))
      const ks = store.getKnowledgeSource(id)
      if (!ks) return c.json({ error: "Source not found" }, 404)

      const body = await c.req.json<Record<string, unknown>>()
      const updates: Partial<{
        name: string
        config_json: string
        enabled: number
        status: string
        error_message: string | null
      }> = {}

      if (body.name !== undefined) updates.name = body.name as string
      if (body.config !== undefined) updates.config_json = JSON.stringify(body.config)
      if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0

      store.updateKnowledgeSource(id, updates)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  app.delete("/kb/sources/:id{[0-9]+}", (c) => {
    try {
      const id = parseInt(c.req.param("id"))
      const ks = store.getKnowledgeSource(id)
      if (!ks) return c.json({ error: "Source not found" }, 404)

      if (ks.type === "local_folder") {
        const config = JSON.parse(ks.config_json) as { folderPath?: string }
        if (config.folderPath) {
          watcher?.unwatchFolder(config.folderPath)
        }
      }

      store.deleteKnowledgeSource(id)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // Test connection
  app.post("/kb/sources/:id{[0-9]+}/test-connection", async (c) => {
    try {
      const id = parseInt(c.req.param("id"))
      const ks = store.getKnowledgeSource(id)
      if (!ks) return c.json({ error: "Source not found" }, 404)

      const adapter = getAdapter(ks.type)
      if (!adapter) return c.json({ error: `No adapter for type: ${ks.type}` }, 400)

      const config = JSON.parse(ks.config_json)
      const result = await adapter.testConnection(config)

      store.updateKnowledgeSource(id, {
        status: result.ok ? "connected" : "error",
        error_message: result.ok ? null : (result.message ?? "Connection failed"),
      })

      return c.json(result)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // List sub-bases (IMA)
  app.get("/kb/sources/:id{[0-9]+}/bases", async (c) => {
    try {
      const id = parseInt(c.req.param("id"))
      const ks = store.getKnowledgeSource(id)
      if (!ks) return c.json({ error: "Source not found" }, 404)

      const adapter = getAdapter(ks.type)
      if (!adapter?.listBases) return c.json({ error: "Source type does not support listing bases" }, 400)

      const config = JSON.parse(ks.config_json)
      const bases = await adapter.listBases(config)
      return c.json({ bases })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // Re-index (local_folder only, by ID)
  app.post("/kb/sources/:id{[0-9]+}/reindex", async (c) => {
    try {
      const id = parseInt(c.req.param("id"))
      const ks = store.getKnowledgeSource(id)
      if (!ks) return c.json({ error: "Source not found" }, 404)
      if (ks.type !== "local_folder") return c.json({ error: "Only local_folder sources can be reindexed" }, 400)

      const config = JSON.parse(ks.config_json) as { folderPath: string }
      const sync = c.req.query("sync") === "true"

      if (sync) {
        const status = await indexer.indexFolder(config.folderPath)
        return c.json(status)
      }

      setTimeout(() => {
        indexer.indexFolder(config.folderPath).catch((err) => {
          console.error(`Background reindex failed for ${config.folderPath}:`, err)
        })
      }, 50)

      return c.json({ id, folderPath: config.folderPath, status: "indexing" }, 202)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Legacy path-based routes (backward compat)
  // ---------------------------------------------------------------------------

  // Get status by folder path
  app.get("/kb/sources/:folderPath{.+}", (c) => {
    const folderPath = decodeURIComponent(c.req.param("folderPath"))
    const status = indexer.getStatus(folderPath)
    return c.json(status)
  })

  // Delete by folder path (legacy)
  app.delete("/kb/sources/:folderPath{.+}", async (c) => {
    try {
      const folderPath = decodeURIComponent(c.req.param("folderPath"))

      // Also delete from knowledge_sources
      const ks = store.getKnowledgeSourceByFolderPath(folderPath)
      if (ks) {
        store.deleteKnowledgeSource(ks.id)
      } else {
        await indexer.removeFolder(folderPath)
      }

      watcher?.unwatchFolder(folderPath)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // Re-index by folder path (legacy)
  app.post("/kb/sources/:folderPath{.+}/reindex", async (c) => {
    try {
      const folderPath = decodeURIComponent(c.req.param("folderPath"))
      const sync = c.req.query("sync") === "true"

      if (sync) {
        const status = await indexer.indexFolder(folderPath)
        return c.json(status)
      }

      setTimeout(() => {
        indexer.indexFolder(folderPath).catch((err) => {
          console.error(`Background reindex failed for ${folderPath}:`, err)
        })
      }, 50)

      return c.json({ folderPath, status: "indexing" }, 202)
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Search (unchanged)
  // ---------------------------------------------------------------------------

  app.post("/kb/search", async (c) => {
    try {
      const body = await c.req.json<{
        query: string
        limit?: number
        retrieval?: "hybrid" | "semantic" | "keyword"
        source_ids?: number[]
      }>()

      if (!body.query || typeof body.query !== "string") {
        return c.json({ error: "query is required" }, 400)
      }

      const maxResults = Math.min(body.limit ?? 5, 50)

      // Local folder search via existing retriever
      const localResults = search({
        query: body.query,
        limit: maxResults,
        retrieval: body.retrieval,
      })

      // Also search remote sources (IMA etc.) via adapters
      const ksSources = store.listKnowledgeSources()
      const remoteSources = ksSources.filter((ks) => {
        if (ks.type === "local_folder" || ks.enabled !== 1) return false
        if (body.source_ids && body.source_ids.length > 0) return body.source_ids.includes(ks.id)
        return true
      })

      const remoteResults: import("./types").AdapterSearchResult[] = []
      for (const ks of remoteSources) {
        const adapter = getAdapter(ks.type)
        if (!adapter) continue
        try {
          const config = JSON.parse(ks.config_json)
          const results = await adapter.search(body.query, config, { limit: maxResults })
          remoteResults.push(...results.map((r) => ({ ...r, sourceId: ks.id })))
        } catch (err) {
          console.error(`[search] Adapter ${ks.type} error:`, err)
        }
      }

      return c.json({ results: localResults, remoteResults })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function handleAddLocalFolder(c: any, folderPath: string) {
    if (!folderPath || typeof folderPath !== "string") {
      return c.json({ error: "folderPath is required" }, 400)
    }

    // Create or find knowledge_source entry
    let ks = store.getKnowledgeSourceByFolderPath(folderPath)
    if (!ks) {
      const name = folderPath.split("/").pop() || folderPath
      const id = store.createKnowledgeSource("local_folder", name, { folderPath })
      ks = store.getKnowledgeSource(id)
      if (!ks) {
        return c.json({ error: "Failed to create knowledge source" }, 500)
      }
    }

    const sync = c.req.query("sync") === "true"

    if (sync) {
      const status = await indexer.indexFolder(folderPath)
      return c.json({ id: ks.id, ...status }, 201)
    }

    // Delay indexing start so the POST response reaches the frontend first.
    // Without this, SSE events arrive before the frontend adds the source to state,
    // causing events to be dropped (race condition).
    setTimeout(() => {
      indexer.indexFolder(folderPath).catch((err) => {
        console.error(`Background indexing failed for ${folderPath}:`, err)
      })
    }, 50)

    return c.json(
      { id: ks.id, folderPath, type: "local_folder", name: ks.name, status: "indexing" },
      202,
    )
  }

  return app
}

function ksToResponse(ks: KnowledgeSourceRow) {
  const config = JSON.parse(ks.config_json)
  return {
    id: ks.id,
    type: ks.type,
    name: ks.name,
    config: sanitizeConfig(ks.type, config),
    enabled: ks.enabled === 1,
    status: ks.status,
    error: ks.error_message,
    createdAt: ks.created_at,
    updatedAt: ks.updated_at,
  }
}

/** Strip sensitive credentials from config before sending to frontend */
function sanitizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  if (type === "ima") {
    const { apiKey, ...safe } = config
    return { ...safe, hasApiKey: !!apiKey }
  }
  if (type === "custom_api") {
    const { headers, ...safe } = config as Record<string, unknown>
    return { ...safe, hasHeaders: !!(headers && Object.keys(headers as Record<string, unknown>).length) }
  }
  return config
}
