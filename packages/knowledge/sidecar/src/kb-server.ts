import { Hono } from "hono"
import { cors } from "hono/cors"
import { basicAuth } from "hono/basic-auth"
import { streamSSE } from "hono/streaming"
import { basename } from "node:path"
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

/** Per-install credentials the Tauri host generates and hands to every sidecar. */
export interface SidecarAuth {
  username: string
  password: string
}

/**
 * `auth` is required rather than optional so a caller must state its intent.
 * `null` means "no authentication" and is only for unit tests — a loopback port
 * is not a security boundary, any local process can reach it (ADR-028 / 029 §9).
 */
export function createApp(deps: AppDeps, auth: SidecarAuth | null): Hono {
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

  // After cors(): hono's cors middleware answers the preflight OPTIONS itself and
  // never calls next(), so the browser's unauthenticated preflight is not rejected.
  // Health is behind auth too — `prepare_port` treats a healthy responder as its own
  // sidecar and reuses it, so answering /kb/health must prove the credential.
  if (auth) {
    app.use("/*", basicAuth({ username: auth.username, password: auth.password }))
  }

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
            status: indexerStatus.status, // runtime status overrides DB
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
      console.log(`[kb-server] create source: type=${type} name=${name} module=${(config as any).module ?? "n/a"}`)
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
      console.log(`[kb-server] test-connection id=${id} type=${ks.type} module=${config.module ?? "default"}`)
      const result = await adapter.testConnection(config)
      console.log(`[kb-server] test-connection result: ok=${result.ok} bases=${result.bases?.length ?? 0}${result.message ? ` msg=${result.message}` : ""}`)

      store.updateKnowledgeSource(id, {
        status: result.ok ? "connected" : "error",
        error_message: result.ok ? null : (result.message ?? "Connection failed"),
      })

      return c.json(result)
    } catch (err) {
      console.error(`[kb-server] test-connection error:`, err)
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

      console.log(`[kb-server] search query="${body.query}" local=${localResults.length} remoteSources=${remoteSources.length}`)

      const remoteResults: import("./types").AdapterSearchResult[] = []
      for (const ks of remoteSources) {
        const adapter = getAdapter(ks.type)
        if (!adapter) continue
        try {
          const config = JSON.parse(ks.config_json)
          console.log(`[kb-server] searching adapter: id=${ks.id} type=${ks.type} module=${config.module ?? "wiki"}`)
          const results = await adapter.search(body.query, config, { limit: maxResults })
          console.log(`[kb-server] adapter ${ks.id} returned ${results.length} results, hasFullContent=${results.filter(r => r.metadata?.hasFullContent).length}`)
          remoteResults.push(...results.map((r) => ({ ...r, sourceId: ks.id })))
        } catch (err) {
          console.error(`[kb-server] adapter ${ks.type} search error:`, err)
        }
      }

      return c.json({ results: localResults, remoteResults })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  // ---------------------------------------------------------------------------
  // Notes write endpoints (Phase 4c)
  // ---------------------------------------------------------------------------

  app.post("/kb/notes/create", async (c) => {
    try {
      const body = await c.req.json<{
        content: string
        title?: string
        source_id?: number
      }>()

      if (!body.content?.trim()) {
        return c.json({ error: "content is required" }, 400)
      }

      const source = findNotesSource(body.source_id)
      if (!source) return c.json({ error: "No connected IMA Notes source found" }, 400)

      const config = JSON.parse(source.ks.config_json)
      const adapter = getAdapter(source.ks.type)
      if (!adapter?.createNote) return c.json({ error: "Adapter does not support note creation" }, 400)

      console.log(`[kb-server] notes/create: source=${source.ks.id} ${body.content.length} chars`)
      const result = await adapter.createNote(config, body.content, {
        title: body.title,
        folderId: config.notebookId,
      })
      return c.json(result, 201)
    } catch (err) {
      console.error(`[kb-server] notes/create error:`, err)
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  app.post("/kb/notes/append", async (c) => {
    try {
      const body = await c.req.json<{
        content: string
        note_id: string
        source_id?: number
      }>()

      if (!body.content?.trim()) {
        return c.json({ error: "content is required" }, 400)
      }
      if (!body.note_id) {
        return c.json({ error: "note_id is required" }, 400)
      }

      const source = findNotesSource(body.source_id)
      if (!source) return c.json({ error: "No connected IMA Notes source found" }, 400)

      const config = JSON.parse(source.ks.config_json)
      const adapter = getAdapter(source.ks.type)
      if (!adapter?.appendNote) return c.json({ error: "Adapter does not support note append" }, 400)

      console.log(`[kb-server] notes/append: source=${source.ks.id} note_id=${body.note_id} ${body.content.length} chars`)
      const result = await adapter.appendNote(config, body.note_id, body.content)
      return c.json(result)
    } catch (err) {
      console.error(`[kb-server] notes/append error:`, err)
      return c.json({ error: err instanceof Error ? err.message : "Internal error" }, 500)
    }
  })

  /** Find a connected IMA Notes source, optionally by ID */
  function findNotesSource(sourceId?: number) {
    const ksSources = store.listKnowledgeSources()
    const ks = ksSources.find((s) => {
      if (s.type !== "ima" || s.enabled !== 1) return false
      if (sourceId) return s.id === sourceId
      const config = JSON.parse(s.config_json)
      return config.module === "notes"
    })
    return ks ? { ks } : null
  }

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
      const name = basename(folderPath) || folderPath
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
