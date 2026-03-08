import { useState, useEffect } from "react"
import { useNavigate, useLocation } from "react-router-dom"
import { Settings, Shield, Cpu, Info, CheckCircle2, XCircle, Loader2, Globe, Code2, Users, Twitter, MessageSquare, Sparkles, ExternalLink, Server, Plus, RefreshCw, X, AlertCircle } from "lucide-react"
import { TopBar } from "@/components/layout/top-bar"
import { useConfig } from "@/lib/config-context"
import { useI18n } from "@/lib/i18n-context"
import { useTheme } from "@/lib/theme-context"
import { useMCPServers } from "@/lib/use-mcp-servers"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { MCPStatus, MCPConfig } from "@agent/api-client"

type SettingsSection = "general" | "privacy" | "capabilities" | "services" | "about"

const NAV_ITEMS: { key: SettingsSection; icon: typeof Settings; labelKey: string }[] = [
  { key: "general", icon: Settings, labelKey: "settingsPage.general" },
  { key: "privacy", icon: Shield, labelKey: "settingsPage.privacy" },
  { key: "capabilities", icon: Cpu, labelKey: "settingsPage.capabilities" },
  { key: "services", icon: Server, labelKey: "settingsPage.services" },
  { key: "about", icon: Info, labelKey: "settingsPage.about" },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const sectionFromState = (location.state as { section?: SettingsSection })?.section
  const [activeSection, setActiveSection] = useState<SettingsSection>(sectionFromState || "general")
  const { t } = useI18n()

  // Sync activeSection when navigating to /settings with a different section in state
  useEffect(() => {
    if (sectionFromState) {
      setActiveSection(sectionFromState)
    }
  }, [sectionFromState])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TopBar title={t("settingsPage.title")} onClose={() => navigate("/")} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-[var(--color-border)] p-3">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setActiveSection(item.key)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                activeSection === item.key
                  ? "bg-[var(--color-accent)] font-medium text-[var(--color-fg)]"
                  : "text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
              )}
            >
              <item.icon className="size-4" />
              {t(item.labelKey)}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl">
            {activeSection === "general" && <GeneralSection />}
            {activeSection === "privacy" && <PrivacySection />}
            {activeSection === "capabilities" && <CapabilitiesSection />}
            {activeSection === "services" && <ServicesSection />}
            {activeSection === "about" && <AboutSection />}
          </div>
        </div>
      </div>
    </div>
  )
}

function GeneralSection() {
  const { config, updateConfig } = useConfig()
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("settingsPage.general")}</h2>

      {/* Theme */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--color-fg)]">{t("general.theme")}</label>
        <div className="grid grid-cols-3 gap-2">
          {(["light", "dark", "system"] as const).map((v) => (
            <button
              key={v}
              className={cn(
                "rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]",
                theme === v
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
              )}
              onClick={() => setTheme(v)}
            >
              {t(`general.theme.${v}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">{t("general.theme.description")}</p>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[var(--color-fg)]">{t("general.language")}</label>
        <div className="grid grid-cols-2 gap-2">
          {([{ value: "en", label: "English" }, { value: "zh", label: "简体中文" }] as const).map((lang) => (
            <button
              key={lang.value}
              className={cn(
                "rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]",
                config.language === lang.value
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
              )}
              onClick={() => updateConfig({ language: lang.value as "en" | "zh" })}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">{t("general.language.description")}</p>
      </div>
    </div>
  )
}

function PrivacySection() {
  const { t } = useI18n()

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("settingsPage.privacy.title")}</h2>
      <p className="text-sm text-[var(--color-fg-muted)]">{t("settingsPage.privacy.desc")}</p>
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-6 text-center text-sm text-[var(--color-fg-muted)]">
        {t("placeholder.privacyComingSoon")}
      </div>
    </div>
  )
}

function CapabilitiesSection() {
  const { config, updateConfig } = useConfig()
  const { t } = useI18n()
  const [formData, setFormData] = useState(config)
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle")
  const [connectionMessage, setConnectionMessage] = useState("")

  useEffect(() => {
    setFormData(config)
  }, [config])

  const handleSave = () => {
    updateConfig(formData)
  }

  const handleTestConnection = async () => {
    setTestingConnection(true)
    setConnectionStatus("idle")
    try {
      const url = `${formData.apiBaseUrl}/global/health`
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Basic ${btoa(`${formData.apiUsername || "opencode"}:${formData.apiPassword}`)}`,
        },
      })
      if (response.ok) {
        setConnectionStatus("success")
        setConnectionMessage(t("connection.success"))
      } else {
        setConnectionStatus("error")
        setConnectionMessage(`${t("connection.failed")}: ${response.status}`)
      }
    } catch (error) {
      setConnectionStatus("error")
      setConnectionMessage(`${t("connection.failed")}: ${error instanceof Error ? error.message : t("common.error")}`)
    } finally {
      setTestingConnection(false)
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("settingsPage.capabilities.title")}</h2>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("connection.apiBaseUrl")}</label>
          <input
            type="text"
            value={formData.apiBaseUrl}
            onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
            placeholder={t("connection.apiBaseUrl.placeholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("connection.username")}</label>
          <input
            type="text"
            value={formData.apiUsername || ""}
            onChange={(e) => setFormData({ ...formData, apiUsername: e.target.value })}
            placeholder={t("connection.username.placeholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("connection.password")}</label>
          <input
            type="password"
            value={formData.apiPassword}
            onChange={(e) => setFormData({ ...formData, apiPassword: e.target.value })}
            placeholder={t("connection.password.placeholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={handleTestConnection} disabled={testingConnection}>
            {testingConnection && <Loader2 className="mr-2 size-4 animate-spin" />}
            {testingConnection ? t("connection.testing") : t("connection.testConnection")}
          </Button>
          <Button onClick={handleSave}>{t("button.save")}</Button>
        </div>

        {connectionStatus !== "idle" && (
          <div
            className={cn(
              "flex items-center gap-2 rounded-md p-3 text-sm",
              connectionStatus === "success"
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-red-500/10 text-red-600 dark:text-red-400"
            )}
          >
            {connectionStatus === "success" ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            <span>{connectionMessage}</span>
          </div>
        )}
      </div>
    </div>
  )
}

function ServicesSection() {
  const { t } = useI18n()
  const {
    statusMap, configMap, loading, error, actionLoading,
    handleToggle, handleAdd, handleRemove, refresh,
  } = useMCPServers()
  const [showAdd, setShowAdd] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const entries = Object.entries(statusMap)
  const connectedCount = entries.filter(([, s]) => s.status === "connected").length

  const onRefresh = async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
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
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("services.title")}</h2>
            {connectedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                {connectedCount} {t("services.connected")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("services.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            {t("workspace.refresh")}
          </Button>
          <Button size="sm" onClick={() => setShowAdd(true)} disabled={showAdd}>
            <Plus className="mr-1.5 size-3.5" />
            {t("mcp.addServer")}
          </Button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <ServiceAddForm
          onAdd={onAdd}
          onCancel={() => setShowAdd(false)}
          loading={actionLoading === "__add__"}
        />
      )}

      {/* Loading / Error */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      )}

      {error && !loading && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-500/10 p-4 text-sm text-red-600 dark:border-red-800 dark:text-red-400">
          <AlertCircle className="size-4 shrink-0" />
          {t("error.fetchMCP")}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && entries.length === 0 && !showAdd && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Server className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("mcp.noServers")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowAdd(true)}>
            <Plus className="mr-1.5 size-3.5" />
            {t("mcp.addServer")}
          </Button>
        </div>
      )}

      {/* Service cards */}
      {!loading && !error && entries.length > 0 && (
        <div className="space-y-3">
          {entries.map(([name, status]) => (
            <ServiceCard
              key={name}
              name={name}
              status={status}
              config={configMap[name]}
              loading={actionLoading === name}
              onToggle={() => handleToggle(name, status.status)}
              onRemove={() => handleRemove(name, status.status)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ServiceCard({
  name,
  status,
  config,
  loading,
  onToggle,
  onRemove,
}: {
  name: string
  status: MCPStatus
  config?: MCPConfig
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

  const dotColor = isConnected
    ? "bg-green-500"
    : isFailed
    ? "bg-red-500"
    : needsAuth
    ? "bg-amber-500"
    : "bg-gray-400"

  const isRemote = config?.type === "remote"
  const detail = isRemote
    ? (config as { url: string }).url
    : config?.type === "local"
    ? (config as { command: string[] }).command.join(" ")
    : undefined

  const errorText = "error" in status && typeof status.error === "string" ? status.error : undefined
  const showBunxHint = isFailed && errorText?.includes("Connection closed")

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={cn("size-2.5 shrink-0 rounded-full", dotColor)} />
            <span className="text-sm font-medium text-[var(--color-fg)]">{name}</span>
            {config && (
              <span className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                isRemote
                  ? "bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "bg-purple-500/10 text-purple-600 dark:text-purple-400"
              )}>
                {isRemote ? t("mcp.typeRemote") : t("mcp.typeLocal")}
              </span>
            )}
          </div>
          <p className={cn(
            "mt-1 text-xs",
            isFailed ? "text-red-500" : needsAuth ? "text-amber-500" : "text-[var(--color-fg-muted)]"
          )}>
            {errorText || statusLabel}
          </p>
          {detail && (
            <p className="mt-1 truncate font-mono text-xs text-[var(--color-fg-muted)]">{detail}</p>
          )}
          {showBunxHint && (
            <p className="mt-1 text-xs text-amber-500">{t("mcp.hintBunx")}</p>
          )}
        </div>
        <div className="ml-4 flex shrink-0 items-center gap-2">
          <Button
            variant={isConnected ? "outline" : "default"}
            size="sm"
            onClick={onToggle}
            disabled={loading}
          >
            {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {isConnected ? t("mcp.disconnect") : t("mcp.connect")}
          </Button>
          {!isConnected && !loading && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRemove}
              className="text-red-500 hover:bg-red-500/10 hover:text-red-600"
            >
              {t("mcp.remove")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ServiceAddForm({
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
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.addServer")}</h3>
        <button onClick={onCancel} className="rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]">
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("services.serverName")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("mcp.namePlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("services.serverType")}</label>
          <div className="grid grid-cols-2 gap-2">
            {(["remote", "local"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setType(v)}
                className={cn(
                  "rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]",
                  type === v
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                    : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
                )}
              >
                {v === "remote" ? t("mcp.typeRemote") : t("mcp.typeLocal")}
              </button>
            ))}
          </div>
        </div>

        {type === "remote" ? (
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-fg)]">{t("services.serverUrl")}</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://mcp-server.example.com"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-fg)]">{t("services.serverCommand")}</label>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="bunx --bun @mcp/server"
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
            />
            <p className="text-xs text-[var(--color-fg-muted)]">{t("mcp.hintBunx")}</p>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>{t("button.cancel")}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || loading}>
            {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            {t("mcp.add")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function AboutSection() {
  const { t } = useI18n()
  const { config } = useConfig()

  const LINKS = [
    { icon: Globe, labelKey: "about.website", href: "https://ultrawork.ai" },
    { icon: Code2, labelKey: "about.sourceCode", href: "https://github.com/anthropics/ultrawork" },
    { icon: Users, labelKey: "about.community", href: "https://discord.gg/ultrawork" },
    { icon: Twitter, labelKey: "about.followUs", href: "https://x.com/ultrawork" },
    { icon: MessageSquare, labelKey: "about.feedback", href: "https://github.com/anthropics/ultrawork/issues" },
  ]

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("settingsPage.about")}</h2>

      {/* Logo + Brand */}
      <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-orange-400 to-red-500">
            <Sparkles className="size-5 text-white" />
          </div>
          <div>
            <div className="text-base font-semibold text-[var(--color-fg)]">{t("brand.name")}</div>
            <div className="text-xs text-[var(--color-fg-muted)]">{t("about.subtitle")}</div>
          </div>
        </div>
        <Button variant="outline" size="sm" className="text-xs">
          {t("about.checkUpdate")}
        </Button>
      </div>

      {/* Version / Build grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-xs text-[var(--color-fg-muted)]">{t("about.version")}</div>
          <div className="mt-1 font-mono text-sm font-medium text-[var(--color-fg)]">0.1.0</div>
        </div>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
          <div className="text-xs text-[var(--color-fg-muted)]">{t("about.build")}</div>
          <div className="mt-1 font-mono text-sm font-medium text-[var(--color-fg)]">2026.03.08</div>
        </div>
      </div>

      {/* Info rows */}
      <div className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
        <InfoRow label={t("about.author")} value="UltraWork Team" href="https://ultrawork.ai" />
        <InfoRow label={t("about.copyright")} value={t("about.copyrightValue")} />
        <InfoRow label={t("about.license")} value={t("about.licenseValue")} href="https://ultrawork.ai/license" />
        <InfoRow label={t("about.opencode")} value={config.apiBaseUrl || "localhost:4096"} />
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2">
        {LINKS.map((link) => (
          <a
            key={link.labelKey}
            href={link.href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)]"
          >
            <link.icon className="size-3.5" />
            {t(link.labelKey)}
            <ExternalLink className="size-3 text-[var(--color-fg-muted)]" />
          </a>
        ))}
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-[var(--color-fg-muted)]">
        {t("about.poweredBy")}
      </p>
    </div>
  )
}

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-[var(--color-fg-muted)]">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-[var(--color-fg)] hover:text-[var(--color-primary)]"
        >
          {value}
          <ExternalLink className="size-3" />
        </a>
      ) : (
        <span className="text-sm text-[var(--color-fg)]">{value}</span>
      )}
    </div>
  )
}
