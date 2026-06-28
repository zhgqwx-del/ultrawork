import { useState, useEffect, useCallback, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import type { MCPStatusMap, MCPConfig } from "@agent/api-client"

// Built-in MCP servers managed by dedicated UI (not shown in the generic MCP
// list, so users can't delete/disable them there and silently break the feature).
// "browser" → Settings → MCP browser toggle; "knowledge-base" → Settings →
// Knowledge Base (add/remove sources). The knowledge-base entry is registered
// for ANY source type (incl. IMA/remote-only) and is also surfaced by the
// runtime MCP.status() patch, so it must be hidden here too.
const BUILTIN_MCP_NAMES = new Set(["browser", "knowledge-base"])

/** Filter built-in servers from a backend response */
function filterBuiltin(data: MCPStatusMap): MCPStatusMap {
  const filtered: MCPStatusMap = {}
  for (const [name, status] of Object.entries(data)) {
    if (!BUILTIN_MCP_NAMES.has(name)) filtered[name] = status
  }
  return filtered
}

export function useMCPServers() {
  const api = useApi()
  const { t } = useI18n()
  const [statusMap, setStatusMap] = useState<MCPStatusMap>({})
  const [configMap, setConfigMap] = useState<Record<string, MCPConfig>>({})
  const configMapRef = useRef(configMap)
  configMapRef.current = configMap
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchMCP = useCallback(async (): Promise<boolean> => {
    try {
      // 1. Backend runtime status (only reports config-file-based servers)
      const backendStatus = await api.getMCP()
      // 2. Persisted configs from global opencode.json (~/.config/ultrawork/opencode.json)
      const savedConfigs = await invoke<Record<string, MCPConfig>>("read_mcp_config")
      // 3. Merge: config is the source of truth for which MCPs exist;
      //    backend provides runtime status for those that are connected.
      //    When an MCP is enabled in config but missing from the runtime
      //    response, assume OpenCode hasn't finished registering yet — show
      //    "connected" optimistically (the actual call will fail visibly if
      //    the MCP is broken). Only show "disabled" when config explicitly
      //    has enabled: false.
      const merged: MCPStatusMap = {}
      let hasPendingRuntime = false
      for (const [name, config] of Object.entries(savedConfigs)) {
        if (BUILTIN_MCP_NAMES.has(name)) continue
        const runtime = backendStatus[name]
        if (runtime) {
          merged[name] = runtime
        } else if (config.enabled === false) {
          merged[name] = { status: "disabled" }
        } else {
          merged[name] = { status: "connected" }
          hasPendingRuntime = true
        }
      }
      setStatusMap(merged)
      setConfigMap(savedConfigs)
      setError(false)
      return hasPendingRuntime
    } catch (err) {
      console.error("Failed to fetch MCP:", err)
      setError(true)
      return false
    } finally {
      setLoading(false)
    }
  }, [api])

  // Re-fetch a few times while any enabled MCP is still missing from the runtime
  // response. OpenCode's MCP registration can lag the initial UI mount, especially
  // on first launch when sidecars are still being copied/spawned.
  useEffect(() => {
    let cancelled = false
    let attempt = 0
    const RETRY_DELAYS_MS = [2000, 4000, 8000]
    const run = async () => {
      const stillPending = await fetchMCP()
      if (!stillPending) return
      if (cancelled || attempt >= RETRY_DELAYS_MS.length) return
      const delay = RETRY_DELAYS_MS[attempt++]!
      setTimeout(() => { if (!cancelled) void run() }, delay)
    }
    void run()
    return () => { cancelled = true }
  }, [fetchMCP])

  // One-time migration: localStorage → global opencode.json
  useEffect(() => {
    const oldRaw = localStorage.getItem("ultrawork_mcp_configs")
    if (!oldRaw) return
    ;(async () => {
      try {
        const oldConfigs = JSON.parse(oldRaw) as Record<string, MCPConfig>
        for (const [name, config] of Object.entries(oldConfigs)) {
          await invoke("write_mcp_config", { name, config })
        }
        localStorage.removeItem("ultrawork_mcp_configs")
        localStorage.removeItem("ultrawork_mcp_statuses")
        localStorage.removeItem("ultrawork_mcp_hidden")
        console.info("Migrated MCP configs from localStorage to global opencode.json")
        fetchMCP()
      } catch (err) {
        console.error("MCP config migration failed:", err)
      }
    })()
  // Run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleToggle = useCallback(async (name: string, currentStatus: string) => {
    setActionLoading(name)
    try {
      if (currentStatus === "connected") {
        await api.disconnectMCP(name)
        const config = configMapRef.current[name]
        if (config) {
          await invoke("write_mcp_config", {
            name,
            config: { ...config, enabled: false },
          })
          setConfigMap(prev => ({ ...prev, [name]: { ...config, enabled: false } }))
        }
        setStatusMap(prev => ({ ...prev, [name]: { status: "disabled" } }))
      } else {
        const config = configMapRef.current[name]
        if (config) {
          await invoke("write_mcp_config", {
            name,
            config: { ...config, enabled: true },
          })
          setConfigMap(prev => ({ ...prev, [name]: { ...config, enabled: true } }))
          const raw = await api.createMCP(name, { ...config, enabled: true })
          setStatusMap(prev => ({ ...prev, ...filterBuiltin(raw) }))
        }
      }
    } catch (err) {
      console.error("MCP toggle failed:", err)
      toast.error(t("error.mcpToggle"))
    } finally {
      setActionLoading(null)
    }
  }, [api, t])

  const handleAdd = useCallback(async (name: string, config: MCPConfig) => {
    setActionLoading("__add__")
    try {
      const configWithEnabled = { ...config, enabled: true }
      // 1. Persist to global opencode.json
      await invoke("write_mcp_config", { name, config: configWithEnabled })
      // 2. Connect immediately via POST /mcp
      const raw = await api.createMCP(name, configWithEnabled)
      // 3. Update local state
      setConfigMap(prev => ({ ...prev, [name]: configWithEnabled }))
      setStatusMap(prev => ({ ...prev, ...filterBuiltin(raw) }))
    } catch (err) {
      console.error("Failed to add MCP:", err)
      toast.error(t("error.addMCP"))
      throw err
    } finally {
      setActionLoading(null)
    }
  }, [api, t])

  const handleRemove = useCallback(async (name: string, currentStatus: string) => {
    // 1. Disconnect if connected
    if (currentStatus === "connected") {
      await api.disconnectMCP(name).catch(() => {})
    }
    // 2. Remove from global opencode.json
    await invoke("remove_mcp_config", { name })
    // 3. Update local state
    setStatusMap(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setConfigMap(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }, [api])

  return {
    statusMap,
    configMap,
    loading,
    error,
    actionLoading,
    handleToggle,
    handleAdd,
    handleRemove,
    refresh: fetchMCP,
  }
}
