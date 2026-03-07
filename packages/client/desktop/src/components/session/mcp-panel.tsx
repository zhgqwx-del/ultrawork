import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { Plug, PlugZap, AlertCircle, Plus, X, Loader2 } from "lucide-react"
import type { MCPStatusMap, MCPStatus, MCPConfig } from "@agent/api-client"

export function MCPPanel() {
  const api = useApi()
  const { t } = useI18n()
  const [statusMap, setStatusMap] = useState<MCPStatusMap>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)

  const fetchMCP = useCallback(async () => {
    try {
      const data = await api.getMCP()
      setStatusMap(data)
      setError(false)
    } catch (err) {
      console.error("Failed to fetch MCP:", err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => { fetchMCP() }, [fetchMCP])

  const handleToggle = async (name: string, currentStatus: string) => {
    setActionLoading(name)
    try {
      if (currentStatus === "connected") {
        await api.disconnectMCP(name)
      } else {
        await api.connectMCP(name)
      }
      await fetchMCP()
    } catch (err) {
      console.error("MCP toggle failed:", err)
      toast.error(t("error.mcpToggle"))
    } finally {
      setActionLoading(null)
    }
  }

  const handleAdd = async (name: string, config: MCPConfig) => {
    setActionLoading("__add__")
    try {
      const data = await api.createMCP(name, config)
      setStatusMap(data)
      setShowAdd(false)
    } catch (err) {
      console.error("Failed to add MCP:", err)
      toast.error(t("error.addMCP"))
    } finally {
      setActionLoading(null)
    }
  }

  const entries = Object.entries(statusMap)

  if (loading) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("common.loading")}</p>
  }

  if (error) {
    return <p className="py-2 text-xs text-red-500">{t("error.fetchMCP")}</p>
  }

  return (
    <div className="space-y-1.5">
      {entries.length === 0 && !showAdd && (
        <p className="py-1 text-xs text-[var(--color-fg-muted)]">{t("mcp.noServers")}</p>
      )}

      {entries.map(([name, status]) => (
        <MCPServerItem
          key={name}
          name={name}
          status={status}
          loading={actionLoading === name}
          onToggle={() => handleToggle(name, status.status)}
        />
      ))}

      {showAdd ? (
        <AddMCPForm
          onAdd={handleAdd}
          onCancel={() => setShowAdd(false)}
          loading={actionLoading === "__add__"}
        />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          <Plus className="size-3" />
          {t("mcp.addServer")}
        </button>
      )}
    </div>
  )
}

function MCPServerItem({
  name,
  status,
  loading,
  onToggle,
}: {
  name: string
  status: MCPStatus
  loading: boolean
  onToggle: () => void
}) {
  const { t } = useI18n()
  const isConnected = status.status === "connected"
  const isFailed = status.status === "failed"
  const isDisabled = status.status === "disabled"
  const needsAuth = status.status === "needs_auth" || status.status === "needs_client_registration"

  const statusLabel = isConnected
    ? t("mcp.connected")
    : isFailed
    ? t("mcp.failed")
    : isDisabled
    ? t("mcp.disabled")
    : needsAuth
    ? t("mcp.needsAuth")
    : t("mcp.disabled")

  const StatusIcon = isConnected ? PlugZap : (isFailed || needsAuth) ? AlertCircle : Plug

  return (
    <div className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5">
      <StatusIcon
        className={`size-3.5 shrink-0 ${
          isConnected
            ? "text-green-500"
            : isFailed
            ? "text-red-400"
            : needsAuth
            ? "text-amber-400"
            : "text-[var(--color-fg-muted)]"
        }`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-[var(--color-fg)]">{name}</p>
        <p className={`text-[10px] ${isFailed ? "text-red-400" : needsAuth ? "text-amber-400" : "text-[var(--color-fg-muted)]"}`}>
          {"error" in status && status.error ? status.error : statusLabel}
        </p>
      </div>
      <button
        onClick={onToggle}
        disabled={loading}
        className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
      >
        {loading ? (
          <Loader2 className="size-3 animate-spin" />
        ) : isConnected ? (
          t("mcp.disconnect")
        ) : (
          t("mcp.connect")
        )}
      </button>
    </div>
  )
}

function AddMCPForm({
  onAdd,
  onCancel,
  loading,
}: {
  onAdd: (name: string, config: MCPConfig) => void
  onCancel: () => void
  loading: boolean
}) {
  const { t } = useI18n()
  const [name, setName] = useState("")
  const [type, setType] = useState<"local" | "remote">("remote")
  const [url, setUrl] = useState("")
  const [command, setCommand] = useState("")

  const canSubmit = name.trim() && (type === "remote" ? url.trim() : command.trim())

  const handleSubmit = () => {
    if (!canSubmit) return
    const config: MCPConfig =
      type === "remote"
        ? { type: "remote", url: url.trim() }
        : { type: "local", command: command.trim().split(/\s+/) }
    onAdd(name.trim(), config)
  }

  return (
    <div className="space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-accent)] p-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-[var(--color-fg)]">{t("mcp.addServer")}</span>
        <button onClick={onCancel} className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
          <X className="size-3.5" />
        </button>
      </div>

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("mcp.namePlaceholder")}
        className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none"
      />

      <div className="flex gap-1">
        {(["remote", "local"] as const).map((v) => (
          <button
            key={v}
            onClick={() => setType(v)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              type === v
                ? "bg-[var(--color-brand)] text-white"
                : "bg-[var(--color-bg)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {v === "remote" ? t("mcp.typeRemote") : t("mcp.typeLocal")}
          </button>
        ))}
      </div>

      {type === "remote" ? (
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp-server.example.com"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none"
        />
      ) : (
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="python -m mcp_server"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none"
        />
      )}

      <button
        onClick={handleSubmit}
        disabled={!canSubmit || loading}
        className="w-full rounded bg-[var(--color-brand)] px-2 py-1 text-xs font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
      >
        {loading ? <Loader2 className="mx-auto size-3 animate-spin" /> : t("mcp.add")}
      </button>
    </div>
  )
}
