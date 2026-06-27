import { useState, useCallback, useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"

const KB_BASE = import.meta.env.DEV ? "/kb" : "http://localhost:4098/kb"
const MCP_NAME = "knowledge-base"

export interface KBSource {
  id: number
  type: "local_folder" | "ima" | "custom_api"
  name: string
  config: Record<string, unknown>
  enabled: boolean
  status: "idle" | "indexing" | "complete" | "connected" | "error"
  error?: string | null
  // Local folder specific (merged from indexer status)
  totalFiles?: number
  indexedFiles?: number
  skippedFiles?: number
  currentFile?: string
  folderPath?: string
}

async function kbFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${KB_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`KB ${resp.status}: ${body}`)
  }
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export function useKnowledgeBase() {
  const [sources, setSources] = useState<KBSource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const api = useApi()
  const { t } = useI18n()
  const eventSourceRef = useRef<EventSource | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const fetchSources = useCallback(async () => {
    try {
      setError(null)
      const data = await kbFetch<{ sources: KBSource[] }>("/sources")
      setSources(data.sources || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
      setSources([])
    } finally {
      setLoading(false)
    }
  }, [])

  // SSE connection for real-time progress updates (local folders)
  const connectSSE = useCallback(() => {
    if (eventSourceRef.current) return

    const sseUrl = import.meta.env.DEV
      ? "/kb/sources/events"
      : "http://localhost:4098/kb/sources/events"

    try {
      const es = new EventSource(sseUrl)
      eventSourceRef.current = es

      // Update local folder sources from SSE events
      const handleStatusSync = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as {
            folderPath: string
            status: string
            totalFiles: number
            indexedFiles: number
            skippedFiles: number
            currentFile?: string
            error?: string
          }
          setSources((prev) =>
            prev.map((s) =>
              s.type === "local_folder" && s.folderPath === event.folderPath
                ? {
                    ...s,
                    status: event.status as KBSource["status"],
                    totalFiles: event.totalFiles,
                    indexedFiles: event.indexedFiles,
                    skippedFiles: event.skippedFiles,
                    currentFile: event.currentFile,
                    error: event.error,
                  }
                : s,
            ),
          )
        } catch { /* ignore parse errors */ }
      }

      const handleProgressEvent = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as {
            folderPath: string
            status: string
            indexedFiles: number
          }
          handleStatusSync(e)

          if (event.status === "complete") {
            toast.success(
              t("knowledge.indexComplete")
                .replace("{files}", String(event.indexedFiles))
                .replace("{folder}", pathBasename(event.folderPath)),
            )
          } else if (event.status === "error") {
            toast.error(t("knowledge.indexFailed"))
          }
        } catch { /* ignore parse errors */ }
      }

      es.addEventListener("status", handleStatusSync)
      es.addEventListener("indexing", handleProgressEvent)
      es.addEventListener("complete", handleProgressEvent)
      es.addEventListener("error", handleProgressEvent)

      es.onerror = () => {
        es.close()
        eventSourceRef.current = null
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          connectSSE()
        }, 5000)
      }
    } catch {
      // SSE not available
    }
  }, [t])

  const disconnectSSE = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (eventSourceRef.current) {
      eventSourceRef.current.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    fetchSources()
    connectSSE()
    return disconnectSSE
  }, [fetchSources, connectSSE, disconnectSSE])

  const ensureMCPRegistered = useCallback(async () => {
    try {
      const configs = await invoke<Record<string, unknown>>("read_mcp_config")
      if (configs && configs[MCP_NAME]) return

      const sidecarPath = await invoke<string>("get_sidecar_path", {
        name: "knowledge-sidecar",
      })

      const mcpConfig = {
        type: "local" as const,
        command: [sidecarPath, "mcp-stdio"],
        enabled: true,
      }

      // Persist only to the global config (~/.config/ultrawork/opencode.json)
      // per ADR-020. Do NOT also call api.patchConfig — that endpoint writes
      // into OpenCode's working directory, which would duplicate the MCP entry
      // into every workspace's opencode.json.
      await invoke("write_mcp_config", {
        name: MCP_NAME,
        config: mcpConfig,
      })

      // Runtime registration (POST /mcp) so the already-running OpenCode picks
      // up the new MCP without a restart. This call does not persist.
      try {
        await api.createMCP(MCP_NAME, mcpConfig as any)
      } catch { /* Will connect on next restart */ }
    } catch (err) {
      console.error("Failed to register knowledge MCP:", err)
    }
  }, [api])

  const addFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        await ensureMCPRegistered()

        const result = await kbFetch<{ id: number }>("/sources", {
          method: "POST",
          body: JSON.stringify({ folderPath }),
        })

        setSources((prev) => {
          if (prev.some((s) => s.folderPath === folderPath)) return prev
          return [...prev, {
            id: result.id,
            type: "local_folder" as const,
            name: pathBasename(folderPath),
            config: { folderPath },
            enabled: true,
            status: "indexing" as const,
            folderPath,
            totalFiles: 0,
            indexedFiles: 0,
            skippedFiles: 0,
          }]
        })

        // Fallback: refresh sources after a short delay to catch any SSE events
        // that arrived before the optimistic state was set (race condition)
        setTimeout(() => fetchSources(), 500)
      } catch (err) {
        toast.error(t("knowledge.indexFailed"))
        console.error("Failed to add folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [ensureMCPRegistered, t],
  )

  const removeSource = useCallback(
    async (id: number) => {
      setActionLoading(String(id))
      try {
        await kbFetch(`/sources/${id}`, { method: "DELETE" })
        toast.success(t("knowledge.removed"))
        setSources((prev) => prev.filter((s) => s.id !== id))
      } catch (err) {
        toast.error(t("knowledge.removeFailed"))
        console.error("Failed to remove source:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const reindexSource = useCallback(
    async (id: number) => {
      setActionLoading(String(id))
      try {
        await kbFetch(`/sources/${id}/reindex`, { method: "POST" })
        setSources((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, status: "indexing" as const, totalFiles: 0, indexedFiles: 0, currentFile: undefined } : s,
          ),
        )
      } catch (err) {
        toast.error(t("knowledge.reindexFailed"))
        console.error("Failed to reindex source:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const testConnection = useCallback(
    async (id: number) => {
      setActionLoading(String(id))
      try {
        const result = await kbFetch<{ ok: boolean; message?: string }>(
          `/sources/${id}/test-connection`,
          { method: "POST" },
        )
        if (result.ok) {
          toast.success(t("knowledge.connectionSuccess"))
          setSources((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: "connected" as const, error: null } : s)),
          )
        } else {
          toast.error(result.message || t("knowledge.connectionFailed"))
          setSources((prev) =>
            prev.map((s) => (s.id === id ? { ...s, status: "error" as const, error: result.message } : s)),
          )
        }
      } catch (err) {
        toast.error(t("knowledge.connectionFailed"))
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  return {
    sources,
    loading,
    error,
    actionLoading,
    addFolder,
    removeSource,
    reindexSource,
    testConnection,
    refresh: fetchSources,
    ensureMCPRegistered,
  }
}
