import { useState } from "react"
import { useI18n } from "@/lib/i18n-context"
import { useMCPServers } from "@/lib/use-mcp-servers"
import { Plug, PlugZap, AlertCircle, Plus, X, Loader2, Trash2 } from "lucide-react"
import type { MCPStatus, MCPConfig } from "@agent/api-client"

export function MCPPanel() {
  const { t } = useI18n()
  const {
    statusMap, loading, error, actionLoading,
    handleToggle, handleAdd, handleRemove,
  } = useMCPServers()
  const [showAdd, setShowAdd] = useState(false)

  const entries = Object.entries(statusMap)

  if (loading) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("common.loading")}</p>
  }

  if (error) {
    return <p className="py-2 text-xs text-red-500">{t("error.fetchMCP")}</p>
  }

  const onAdd = async (name: string, config: MCPConfig) => {
    try {
      await handleAdd(name, config)
      setShowAdd(false)
    } catch {
      // error already toasted by hook
    }
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
          onRemove={() => handleRemove(name, status.status)}
        />
      ))}

      {showAdd ? (
        <AddMCPForm
          onAdd={onAdd}
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
  onRemove,
}: {
  name: string
  status: MCPStatus
  loading: boolean
  onToggle: () => void
  onRemove: () => void
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
        {isFailed && "error" in status && typeof status.error === "string" && status.error.includes("Connection closed") && (
          <p className="text-[10px] text-amber-500">{t("mcp.hintBunx")}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={onToggle}
          disabled={loading}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-[var(--color-bg)] disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : isConnected ? (
            t("mcp.disconnect")
          ) : (
            t("mcp.connect")
          )}
        </button>
        {!isConnected && !loading && (
          <button
            onClick={onRemove}
            title={t("mcp.remove")}
            className="rounded p-0.5 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-red-400"
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </div>
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
          placeholder="bunx --bun @mcp/server"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none"
        />
      )}

      {type === "local" && (
        <p className="text-[10px] text-[var(--color-fg-muted)]">{t("mcp.hintBunx")}</p>
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
