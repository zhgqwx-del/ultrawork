import { useState } from "react"
import { useI18n } from "@/lib/i18n-context"
import { useMCPServers } from "@/lib/use-mcp-servers"
import { useBrowserMCP } from "@/lib/use-browser-mcp"
import { Plug, PlugZap, AlertCircle, Plus, X, Loader2, Trash2, Globe, CheckCircle2, XCircle } from "lucide-react"
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
      <BrowserMCPSection />

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

function BrowserMCPSection() {
  const { t } = useI18n()
  const {
    nodeVersion, nodeEmbedded, chromeAvailable,
    installed, installing, error, setup, checking,
    mode, switchMode, switchingMode,
  } = useBrowserMCP()

  if (checking) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-2 py-1.5">
        <Globe className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
        <p className="text-xs text-[var(--color-fg-muted)]">{t("mcp.browser.checking")}</p>
      </div>
    )
  }

  const modeLabel = mode === "playwright" ? t("mcp.browser.modePlaywright") : t("mcp.browser.modeDevtools")

  return (
    <div className="rounded-md bg-[var(--color-accent)] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <Globe className={`size-3.5 shrink-0 ${installed ? "text-green-500" : "text-blue-400"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="text-xs font-medium text-[var(--color-fg)]">{t("mcp.browser.title")}</p>
            <span className="rounded bg-[var(--color-bg)] px-1 py-px text-[9px] text-[var(--color-fg-muted)]">
              {modeLabel}
            </span>
          </div>
          <p className="text-[10px] text-[var(--color-fg-muted)]">{t("mcp.browser.desc")}</p>
          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-[var(--color-fg-muted)]">
            {nodeVersion && (
              <span className="flex items-center gap-0.5">
                <CheckCircle2 className="size-2.5 text-green-500" />
                {t("mcp.browser.nodeVersion", { version: nodeVersion })}
                {nodeEmbedded && <span className="ml-0.5 text-[9px] opacity-60">({t("mcp.browser.nodeEmbedded")})</span>}
              </span>
            )}
            <span className="flex items-center gap-0.5">
              {chromeAvailable
                ? <><CheckCircle2 className="size-2.5 text-green-500" />{t("mcp.browser.chromeDetected")}</>
                : <><XCircle className="size-2.5 text-[var(--color-fg-muted)]" />{t("mcp.browser.chromeNotDetected")}</>
              }
            </span>
          </div>
        </div>
        <div className="shrink-0">
          {installed ? (
            <span className="rounded bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-500">
              {t("mcp.browser.installed")}
            </span>
          ) : (
            <button
              onClick={setup}
              disabled={installing || switchingMode}
              className="rounded bg-[var(--color-brand)] px-2 py-0.5 text-[10px] font-medium text-white transition-colors hover:opacity-90 disabled:opacity-50"
            >
              {installing ? (
                <span className="flex items-center gap-1">
                  <Loader2 className="size-3 animate-spin" />
                  {t("mcp.browser.installing")}
                </span>
              ) : (
                t("mcp.browser.enable")
              )}
            </button>
          )}
        </div>
      </div>
      {/* Mode switcher (compact for sidebar) */}
      <div className="mt-1 flex gap-1">
        {(["playwright", "devtools"] as const).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            disabled={switchingMode || mode === m}
            className={`rounded px-1.5 py-px text-[9px] font-medium transition-colors ${
              mode === m
                ? "bg-[var(--color-brand)] text-white"
                : "bg-[var(--color-bg)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            } disabled:opacity-50`}
          >
            {m === "playwright" ? t("mcp.browser.modePlaywright") : t("mcp.browser.modeDevtools")}
          </button>
        ))}
        {switchingMode && <Loader2 className="size-3 animate-spin text-[var(--color-fg-muted)]" />}
      </div>
      {error && (
        <div className="mt-1 flex items-center gap-1">
          <p className="flex-1 text-[10px] text-red-400">{error}</p>
          <button
            onClick={setup}
            disabled={installing}
            className="text-[10px] text-[var(--color-brand)] hover:underline"
          >
            {t("mcp.browser.retry")}
          </button>
        </div>
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
