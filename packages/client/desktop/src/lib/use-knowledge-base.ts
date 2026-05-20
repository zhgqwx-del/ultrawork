import { useState, useCallback, useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"

const KB_BASE = import.meta.env.DEV ? "/kb" : "http://localhost:4098/kb"
const MCP_NAME = "knowledge-base"

export interface KBSource {
  folderPath: string
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  status: "idle" | "indexing" | "complete" | "error"
  error?: string
  currentFile?: string
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

  // SSE connection for real-time progress updates
  const connectSSE = useCallback(() => {
    // Don't reconnect if already connected
    if (eventSourceRef.current) return

    const sseUrl = import.meta.env.DEV
      ? "/kb/sources/events"
      : "http://localhost:4098/kb/sources/events"

    try {
      const es = new EventSource(sseUrl)
      eventSourceRef.current = es

      // Update sources state from any SSE event (no toast)
      const handleStatusSync = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as KBSource
          setSources((prev) => {
            const idx = prev.findIndex((s) => s.folderPath === event.folderPath)
            if (idx >= 0) {
              const updated = [...prev]
              updated[idx] = event
              return updated
            }
            return [...prev, event]
          })
        } catch { /* ignore parse errors */ }
      }

      // Progress events: update state + show toast on completion/error
      const handleProgressEvent = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as KBSource
          handleStatusSync(e)

          if (event.status === "complete") {
            toast.success(
              t("knowledge.indexComplete")
                .replace("{files}", String(event.indexedFiles))
                .replace("{folder}", event.folderPath.split("/").pop() || event.folderPath),
            )
          } else if (event.status === "error") {
            toast.error(t("knowledge.indexFailed"))
          }
        } catch { /* ignore parse errors */ }
      }

      // "status" = initial state sync (no toast), others = real progress (with toast)
      es.addEventListener("status", handleStatusSync)
      es.addEventListener("indexing", handleProgressEvent)
      es.addEventListener("complete", handleProgressEvent)
      es.addEventListener("error", handleProgressEvent)

      es.onerror = () => {
        es.close()
        eventSourceRef.current = null
        // Reconnect after a delay (clean up old timer first)
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null
          connectSSE()
        }, 5000)
      }
    } catch {
      // SSE not available, fall back to polling
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
      if (configs && configs[MCP_NAME]) return // Already registered

      // Get the sidecar binary path
      const sidecarPath = await invoke<string>("get_sidecar_path", {
        name: "knowledge-sidecar",
      })

      const mcpConfig = {
        type: "local" as const,
        command: [sidecarPath, "mcp-stdio"],
        enabled: true,
      }

      // 1. Write to global opencode.json (~/.config/ultrawork/opencode.json)
      await invoke("write_mcp_config", {
        name: MCP_NAME,
        config: mcpConfig,
      })

      // 2. Write to OpenCode's runtime config (so it appears in status list)
      try {
        await api.patchConfig({ mcp: { [MCP_NAME]: mcpConfig } } as any)
      } catch {
        // Non-critical
      }

      // 3. Register and connect with OpenCode backend
      try {
        await api.createMCP(MCP_NAME, mcpConfig as any)
      } catch {
        // OpenCode might not be ready yet, will connect on next restart
      }
    } catch (err) {
      console.error("Failed to register knowledge MCP:", err)
    }
  }, [api])

  const addFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        // Ensure MCP is registered before first use
        await ensureMCPRegistered()

        // Async mode — returns 202 immediately, progress via SSE
        await kbFetch<KBSource>("/sources", {
          method: "POST",
          body: JSON.stringify({ folderPath }),
        })

        // Optimistically add to sources list
        setSources((prev) => {
          if (prev.some((s) => s.folderPath === folderPath)) return prev
          return [...prev, {
            folderPath,
            totalFiles: 0,
            indexedFiles: 0,
            skippedFiles: 0,
            status: "indexing" as const,
          }]
        })
      } catch (err) {
        toast.error(t("knowledge.indexFailed"))
        console.error("Failed to add folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [ensureMCPRegistered, t],
  )

  const removeFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        await kbFetch(`/sources/${encodeURIComponent(folderPath)}`, {
          method: "DELETE",
        })
        toast.success(t("knowledge.removed"))
        setSources((prev) => prev.filter((s) => s.folderPath !== folderPath))
      } catch (err) {
        toast.error(t("knowledge.removeFailed"))
        console.error("Failed to remove folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const reindexFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        // Async mode — returns 202, progress via SSE
        await kbFetch(`/sources/${encodeURIComponent(folderPath)}/reindex`, {
          method: "POST",
        })

        // Optimistically update status
        setSources((prev) =>
          prev.map((s) =>
            s.folderPath === folderPath ? { ...s, status: "indexing" as const, indexedFiles: 0 } : s,
          ),
        )
      } catch (err) {
        toast.error(t("knowledge.reindexFailed"))
        console.error("Failed to reindex folder:", err)
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
    removeFolder,
    reindexFolder,
    refresh: fetchSources,
  }
}
