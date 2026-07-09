import { useState, useCallback, useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"
import { knowledgeBaseUrl } from "@/lib/sidecar-ports"
import { sidecarAuthHeaders } from "@/lib/sidecar-auth"
import { createSseTransport, type SseTransport } from "@agent/connector"

const MCP_NAME = "knowledge-base"

type KBApi = ReturnType<typeof useApi>

/**
 * Register the knowledge-base MCP with OpenCode: persist it to the global
 * opencode.json (so it auto-connects on restart) and register + connect it in
 * the running OpenCode runtime (so it works without a restart). Standalone so
 * any entry point — local folder, IMA, or custom API — can ensure the MCP is
 * live regardless of which source type triggered it.
 */
export async function registerKnowledgeMCP(api: KBApi) {
  const sidecarPath = await invoke<string>("get_sidecar_path", {
    name: "knowledge-sidecar",
  })
  const mcpConfig = {
    type: "local" as const,
    command: [sidecarPath, "mcp-stdio"],
    enabled: true,
  }
  // Persist only to the global config (~/.config/ultrawork/opencode.json) per
  // ADR-020. Do NOT call api.patchConfig — that writes into OpenCode's working
  // directory, duplicating the entry into every workspace's opencode.json.
  await invoke("write_mcp_config", { name: MCP_NAME, config: mcpConfig })
  // Runtime registration (POST /mcp) + explicit connect so the already-running
  // OpenCode picks the MCP up without a restart. Both are best-effort: if the
  // sidecar isn't ready yet, the persisted config makes it connect next launch.
  try { await api.createMCP(MCP_NAME, mcpConfig) } catch { /* may already exist */ }
  try { await api.connectMCP(MCP_NAME) } catch { /* will connect on next restart */ }
}

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

/** Payload of a `/kb/sources/events` frame (any event name). */
interface KBProgressEvent {
  folderPath: string
  status: string
  totalFiles: number
  indexedFiles: number
  skippedFiles: number
  currentFile?: string
  error?: string
}

async function kbFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${knowledgeBaseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...sidecarAuthHeaders(), ...options?.headers },
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
  const transportRef = useRef<SseTransport | null>(null)

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

  // SSE connection for real-time progress updates (local folders).
  //
  // fetch-reader, not EventSource: EventSource has no way to send an Authorization
  // header, which the knowledge sidecar is about to require. Retry is a flat 5s
  // forever, matching the hand-rolled reconnect this replaced.
  const connectSSE = useCallback(() => {
    if (transportRef.current) return

    // The sidecar names its frames: `status` is a full snapshot of a source, while
    // `indexing`/`complete`/`error` are progress ticks. Only the ticks may toast —
    // a snapshot of an already-failed source would otherwise re-toast on every
    // reconnect. The name is the only thing distinguishing them; both carry the
    // source's own `status` field in the payload.
    const applyStatus = (event: KBProgressEvent) => {
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
    }

    const transport = createSseTransport<KBProgressEvent>({
      url: `${knowledgeBaseUrl()}/sources/events`,
      headers: sidecarAuthHeaders,
      retry: { baseDelayMs: 5000, maxDelayMs: 5000 },
      onEvent: (event, eventName) => {
        applyStatus(event)
        if (eventName === "status") return // snapshot, never a toast
        if (event.status === "complete") {
          toast.success(
            t("knowledge.indexComplete")
              .replace("{files}", String(event.indexedFiles))
              .replace("{folder}", pathBasename(event.folderPath)),
          )
        } else if (event.status === "error") {
          toast.error(t("knowledge.indexFailed"))
        }
      },
    })
    transportRef.current = transport
    // connect() resolves when the stream ends; the transport reconnects itself.
    void transport.connect()
  }, [t])

  const disconnectSSE = useCallback(() => {
    if (transportRef.current) {
      transportRef.current.close()
      transportRef.current = null
    }
  }, [])

  useEffect(() => {
    fetchSources()
    connectSSE()
    return disconnectSSE
  }, [fetchSources, connectSSE, disconnectSSE])

  const ensureMCPRegistered = useCallback(async () => {
    try {
      // Check the OpenCode runtime status rather than the persisted config file:
      // a config entry can exist while the MCP is not actually connected (e.g.
      // a prior register failed, or the runtime lost it). Only skip when it is
      // genuinely connected.
      const mcpStatus = await api.getMCP()
      if (mcpStatus[MCP_NAME]?.status === "connected") return
      await registerKnowledgeMCP(api)
    } catch (err) {
      console.error("Failed to register knowledge MCP:", err)
    }
  }, [api])

  // Auto-restore: whenever knowledge sources exist (local folder, IMA, or
  // custom API) but the MCP is not connected, register it. This is the single
  // path that also covers remote-only setups — adding an IMA/custom_api source
  // goes through add-source-dialog, which never calls ensureMCPRegistered, so
  // without this the AI could not query an IMA-only knowledge base.
  const hasSources = sources.length > 0
  useEffect(() => {
    if (loading || !hasSources) return
    let cancelled = false
    ;(async () => {
      // OpenCode (:4096) may still be booting when KB sources (:4098, an
      // independent sidecar) have already loaded, so api.getMCP() can throw
      // transiently. Retry a few times with backoff so a single early failure
      // doesn't leave an IMA/remote-only KB unregistered for the whole session.
      const delays = [0, 1500, 3000, 5000]
      for (const d of delays) {
        if (cancelled) return
        if (d) await new Promise((r) => setTimeout(r, d))
        if (cancelled) return
        try {
          const mcpStatus = await api.getMCP()
          if (cancelled) return
          if (mcpStatus[MCP_NAME]?.status === "connected") return
          await registerKnowledgeMCP(api)
          return // registered (persisted config covers connect on next launch)
        } catch (err) {
          console.error("Knowledge MCP auto-restore attempt failed:", err)
          // transient (OpenCode not reachable yet) — fall through to retry
        }
      }
    })()
    return () => { cancelled = true }
  }, [loading, hasSources, api])

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
