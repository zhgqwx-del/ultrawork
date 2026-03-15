import { useState, useEffect, useCallback, useRef } from "react"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import type { MCPStatusMap, MCPConfig } from "@agent/api-client"

const MCP_CONFIGS_KEY = "ultrawork_mcp_configs"
const MCP_HIDDEN_KEY = "ultrawork_mcp_hidden"
const MCP_STATUSES_KEY = "ultrawork_mcp_statuses"

function loadSavedConfigs(): Record<string, MCPConfig> {
  try {
    const raw = localStorage.getItem(MCP_CONFIGS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveConfigs(configs: Record<string, MCPConfig>) {
  try {
    localStorage.setItem(MCP_CONFIGS_KEY, JSON.stringify(configs))
  } catch {}
}

function loadSavedStatuses(): MCPStatusMap {
  try {
    const raw = localStorage.getItem(MCP_STATUSES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveSavedStatuses(statuses: MCPStatusMap) {
  try {
    localStorage.setItem(MCP_STATUSES_KEY, JSON.stringify(statuses))
  } catch {}
}

function loadHiddenSet(): Set<string> {
  try {
    const raw = localStorage.getItem(MCP_HIDDEN_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function saveHiddenSet(set: Set<string>) {
  try {
    localStorage.setItem(MCP_HIDDEN_KEY, JSON.stringify([...set]))
  } catch {}
}

// Built-in MCP servers managed by dedicated UI (not shown in generic list)
const BUILTIN_MCP_NAMES = new Set(["browser"])

/** Filter out user-hidden servers and built-in servers from a backend response */
function filterHidden(data: MCPStatusMap): MCPStatusMap {
  const hidden = loadHiddenSet()
  const filtered: MCPStatusMap = {}
  for (const [name, status] of Object.entries(data)) {
    if (!hidden.has(name) && !BUILTIN_MCP_NAMES.has(name)) filtered[name] = status
  }
  return filtered
}

export function useMCPServers() {
  const api = useApi()
  const { t } = useI18n()
  const [statusMap, setStatusMap] = useState<MCPStatusMap>({})
  const [configMap, setConfigMap] = useState<Record<string, MCPConfig>>(loadSavedConfigs)
  const configMapRef = useRef(configMap)
  configMapRef.current = configMap
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchMCP = useCallback(async () => {
    try {
      const raw = await api.getMCP()
      const data = filterHidden(raw)
      // Merge: backend active servers + locally saved disconnected servers
      const saved = loadSavedConfigs()
      const savedStatuses = loadSavedStatuses()
      const hidden = loadHiddenSet()
      const merged: MCPStatusMap = { ...data }
      for (const name of Object.keys(saved)) {
        if (!(name in merged) && !hidden.has(name) && !BUILTIN_MCP_NAMES.has(name)) {
          // Use last-known status from localStorage instead of assuming "disabled".
          // GET /mcp only reports config-file-based servers; dynamically added
          // servers (POST /mcp) are in memory but not reported by the endpoint.
          merged[name] = savedStatuses[name] ?? { status: "disabled" }
        }
      }
      setStatusMap(merged)
      setError(false)
    } catch (err) {
      console.error("Failed to fetch MCP:", err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { fetchMCP() }, [fetchMCP])

  const handleToggle = useCallback(async (name: string, currentStatus: string) => {
    setActionLoading(name)
    try {
      if (currentStatus === "connected") {
        await api.disconnectMCP(name)
        // Backend removes disconnected servers from GET /mcp response,
        // so update locally to preserve the entry as "disabled"
        setStatusMap(prev => ({ ...prev, [name]: { status: "disabled" } }))
        // Persist disabled status
        const ss = loadSavedStatuses()
        ss[name] = { status: "disabled" }
        saveSavedStatuses(ss)
      } else {
        // Backend forgets disconnected servers, so connectMCP(name) won't work.
        // Re-create the server using stored config (createMCP adds + connects).
        const config = configMapRef.current[name]
        if (config) {
          const raw = await api.createMCP(name, config)
          const filtered = filterHidden(raw)
          setStatusMap(prev => ({ ...prev, ...filtered }))
          // Persist connected statuses
          const ss = loadSavedStatuses()
          for (const [k, v] of Object.entries(filtered)) ss[k] = v
          saveSavedStatuses(ss)
        } else {
          // Fallback for servers loaded before we tracked configs
          await api.connectMCP(name)
          const raw = await api.getMCP()
          setStatusMap(prev => ({ ...prev, ...filterHidden(raw) }))
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
      const raw = await api.createMCP(name, config)
      // Persist config for reconnection across restarts
      setConfigMap(prev => {
        const newConfigs = { ...prev, [name]: config }
        saveConfigs(newConfigs)
        return newConfigs
      })
      // Un-hide this server if it was previously removed
      const hidden = loadHiddenSet()
      if (hidden.has(name)) {
        hidden.delete(name)
        saveHiddenSet(hidden)
      }
      const filtered = filterHidden(raw)
      setStatusMap(prev => ({ ...prev, ...filtered }))
      // Persist statuses so page navigation doesn't lose connected state.
      // GET /mcp only reports config-file servers; dynamically added servers
      // need localStorage to remember their status across re-mounts.
      const ss = loadSavedStatuses()
      for (const [k, v] of Object.entries(filtered)) ss[k] = v
      saveSavedStatuses(ss)
    } catch (err) {
      console.error("Failed to add MCP:", err)
      toast.error(t("error.addMCP"))
      throw err // Let caller know it failed
    } finally {
      setActionLoading(null)
    }
  }, [api, t])

  const handleRemove = useCallback(async (name: string, currentStatus: string) => {
    // If connected, disconnect from backend first
    if (currentStatus === "connected") {
      try {
        await api.disconnectMCP(name)
      } catch {
        // Ignore - we're removing it anyway
      }
    }
    // Add to hidden set so backend responses won't resurrect it
    const hidden = loadHiddenSet()
    hidden.add(name)
    saveHiddenSet(hidden)
    // Remove from local state and localStorage
    setStatusMap(prev => {
      const next = { ...prev }
      delete next[name]
      return next
    })
    setConfigMap(prev => {
      const next = { ...prev }
      delete next[name]
      saveConfigs(next)
      return next
    })
    // Clean up saved status
    const ss = loadSavedStatuses()
    delete ss[name]
    saveSavedStatuses(ss)
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
