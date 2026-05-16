import { useState, useCallback, useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace-context"
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
  const { workspacePath } = useWorkspace()
  const api = useApi()
  const { t } = useI18n()

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

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  const ensureMCPRegistered = useCallback(async () => {
    if (!workspacePath) return
    try {
      const configs = await invoke<Record<string, unknown>>("read_mcp_config", {
        workspace: workspacePath,
      })
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

      // 1. Write to workspace opencode.json (for persistence across restarts)
      await invoke("write_mcp_config", {
        workspace: workspacePath,
        name: MCP_NAME,
        config: mcpConfig,
      })

      // 2. Write to OpenCode's config via PATCH /config (so it appears in status list)
      try {
        await api.patchConfig({ mcp: { [MCP_NAME]: mcpConfig } } as any)
      } catch {
        // Non-critical: status listing may not show it, but tool still works
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
  }, [workspacePath, api])

  const addFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        // Ensure MCP is registered before first use
        await ensureMCPRegistered()

        const status = await kbFetch<KBSource>("/sources", {
          method: "POST",
          body: JSON.stringify({ folderPath }),
        })
        toast.success(
          t("knowledge.indexComplete")
            .replace("{files}", String(status.indexedFiles))
            .replace("{folder}", folderPath.split("/").pop() || folderPath),
        )
        await fetchSources()
      } catch (err) {
        toast.error(t("knowledge.indexFailed"))
        console.error("Failed to add folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [fetchSources, ensureMCPRegistered, t],
  )

  const removeFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        await kbFetch(`/sources/${encodeURIComponent(folderPath)}`, {
          method: "DELETE",
        })
        toast.success(t("knowledge.removed"))
        await fetchSources()
      } catch (err) {
        toast.error(t("knowledge.removeFailed"))
        console.error("Failed to remove folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [fetchSources, t],
  )

  const reindexFolder = useCallback(
    async (folderPath: string) => {
      setActionLoading(folderPath)
      try {
        await kbFetch(`/sources/${encodeURIComponent(folderPath)}/reindex`, {
          method: "POST",
        })
        toast.success(t("knowledge.reindexComplete"))
        await fetchSources()
      } catch (err) {
        toast.error(t("knowledge.reindexFailed"))
        console.error("Failed to reindex folder:", err)
      } finally {
        setActionLoading(null)
      }
    },
    [fetchSources, t],
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
