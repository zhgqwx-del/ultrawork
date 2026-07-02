import { useState, useEffect, useMemo, useRef, type ReactNode } from "react"
import { toast } from "sonner"
import { useNavigate, useLocation } from "react-router-dom"
import { Settings, Shield, Cpu, Info, CheckCircle2, XCircle, Loader2, Globe, Code2, Users, Twitter, MessageSquare, Sparkles, ExternalLink, Server, Plus, RefreshCw, X, AlertCircle, Search, Terminal, Radio, ChevronDown, FileJson, Trash2, Smartphone, BookOpen, FolderOpen, Database, Bot, Package, Download, Wrench, AlertTriangle, SlidersHorizontal} from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AgentsSection } from "@/components/settings/agents-section"
import { ModelsSection } from "@/components/settings/models-section"
import { Logo } from "@/components/ui/logo"
import { AddSourceDialog } from "@/components/knowledge/add-source-dialog"
import { TopBar } from "@/components/layout/top-bar"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useConfig } from "@/lib/config-context"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"
import { isMacOS, isWindows } from "@/lib/platform"
import { useTheme } from "@/lib/theme-context"
import { useMCPServers } from "@/lib/use-mcp-servers"
import { useBrowserMCP } from "@/lib/use-browser-mcp"
import { useChannels } from "@/lib/use-channels"
import { useKnowledgeBase, type KBSource } from "@/lib/use-knowledge-base"
import { useSkills } from "@/lib/use-skills"
import { useSkillDeps, BUILTIN_DEP_MAP, missingDeps, type DepMap } from "@/lib/use-skill-deps"
import { useWorkspace } from "@/lib/workspace-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { MCPStatus, MCPConfig, ChannelStatus, ChannelConfig, DingTalkChannelConfig } from "@agent/api-client"
import { QRCodeSVG } from "qrcode.react"
import type { SkillSource, SkillItem } from "@/lib/use-skills"

type SettingsSection = "general" | "models" | "privacy" | "capabilities" | "agents" | "services" | "channels" | "knowledge" | "skills" | "about"

type NavItem = { key: SettingsSection; icon: typeof Settings; labelKey: string }

const NAV_GROUPS: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: "settingsPage.group.general",
    items: [{ key: "general", icon: Settings, labelKey: "settingsPage.general" }],
  },
  {
    titleKey: "settingsPage.group.ai",
    items: [
      { key: "models", icon: Cpu, labelKey: "settingsPage.models" },
      { key: "agents", icon: Bot, labelKey: "settingsPage.agents" },
      { key: "skills", icon: Sparkles, labelKey: "settingsPage.skills" },
      { key: "knowledge", icon: BookOpen, labelKey: "settingsPage.knowledge" },
    ],
  },
  {
    titleKey: "settingsPage.group.integration",
    items: [
      { key: "services", icon: Server, labelKey: "settingsPage.services" },
      { key: "channels", icon: Radio, labelKey: "settingsPage.channels" },
    ],
  },
  {
    titleKey: "settingsPage.group.account",
    items: [
      { key: "capabilities", icon: SlidersHorizontal, labelKey: "settingsPage.capabilities" },
      { key: "privacy", icon: Shield, labelKey: "settingsPage.privacy" },
      { key: "about", icon: Info, labelKey: "settingsPage.about" },
    ],
  },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const sectionFromState = (location.state as { section?: SettingsSection })?.section
  const [activeSection, setActiveSection] = useState<SettingsSection>(sectionFromState || "general")
  const { t } = useI18n()
  const { getReturnPath } = useSidebar()

  // Sync activeSection when navigating to /settings with a different section in state
  useEffect(() => {
    if (sectionFromState) {
      setActiveSection(sectionFromState)
    }
  }, [sectionFromState])

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TopBar
        title={t("settingsPage.title")}
        onBack={() => navigate(getReturnPath(), { replace: true })}
        onClose={() => navigate(getReturnPath(), { replace: true })}
        hideSidebarToggle
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="flex w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--color-border)] p-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.titleKey} className="mb-2 flex flex-col gap-0.5">
              <p className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-fg-muted)]">
                {t(group.titleKey)}
              </p>
              {group.items.map((item) => (
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
            </div>
          ))}
        </nav>

        {/* Right content */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto max-w-3xl">
            {activeSection === "general" && <GeneralSection />}
            {activeSection === "models" && <ModelsSection />}
            {activeSection === "privacy" && <PrivacySection />}
            {activeSection === "capabilities" && <CapabilitiesSection />}
            {activeSection === "agents" && <AgentsSection />}
            {activeSection === "services" && <ServicesSection />}
            {activeSection === "channels" && <ChannelsSection />}
            {activeSection === "knowledge" && <KnowledgeSection />}
            {activeSection === "skills" && <SkillsSection />}
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

function BrowserServiceCard() {
  const { t } = useI18n()
  const {
    nodeAvailable, nodeVersion, nodeEmbedded, chromeAvailable,
    installed, installing, error, setup, checking,
    mode, switchMode, switchingMode,
  } = useBrowserMCP()

  if (checking) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-4">
        <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
        <p className="text-sm text-[var(--color-fg-muted)]">{t("mcp.browser.checking")}</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={cn(
            "mt-0.5 flex size-8 items-center justify-center rounded-lg",
            installed ? "bg-green-500/10" : nodeAvailable ? "bg-blue-500/10" : "bg-amber-500/10",
          )}>
            <Globe className={cn(
              "size-4",
              installed ? "text-green-500" : nodeAvailable ? "text-blue-500" : "text-amber-500",
            )} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.browser.title")}</h3>
              <span className="rounded-full bg-[var(--color-accent)] px-2 py-px text-[10px] font-medium text-[var(--color-fg-muted)]">
                {t("mcp.browser.builtin")}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{t("mcp.browser.desc")}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-[var(--color-fg-muted)]">
              {nodeAvailable ? (
                <span className="flex items-center gap-1">
                  <CheckCircle2 className="size-3 text-green-500" />
                  {t("mcp.browser.nodeVersion", { version: nodeVersion ?? "" })}
                  <span className="text-[10px] opacity-60">
                    ({nodeEmbedded ? t("mcp.browser.nodeEmbedded") : t("mcp.browser.nodeSystem")})
                  </span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[var(--color-fg-muted)]">
                  {t("mcp.browser.toastDownloadingNode").replace("...", "")}
                </span>
              )}
              <span className="flex items-center gap-1">
                {chromeAvailable
                  ? <><CheckCircle2 className="size-3 text-green-500" />{t("mcp.browser.chromeDetected")}</>
                  : <><XCircle className="size-3 text-[var(--color-fg-muted)]" />{t("mcp.browser.chromeNotDetected")}</>
                }
              </span>
            </div>
          </div>
        </div>
        <div className="shrink-0">
            {installed ? (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2.5 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                <CheckCircle2 className="mr-1 size-3" />
                {t("mcp.browser.installed")}
              </span>
            ) : (
              <Button size="sm" onClick={setup} disabled={installing || switchingMode}>
                {installing ? (
                  <><Loader2 className="mr-1.5 size-3.5 animate-spin" />{t("mcp.browser.installing")}</>
                ) : (
                  t("mcp.browser.enable")
                )}
              </Button>
            )}
          </div>
      </div>

      {/* Mode selector */}
      <div className="mt-3 flex gap-2">
          {(["playwright", "devtools"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              disabled={switchingMode || mode === m}
              className={cn(
                "flex-1 rounded-md border px-3 py-2 text-left transition-colors",
                mode === m
                  ? "border-[var(--color-brand)] bg-[var(--color-brand)]/5"
                  : "border-[var(--color-border)] hover:border-[var(--color-fg-muted)]",
                "disabled:opacity-60",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium text-[var(--color-fg)]">
                  {m === "playwright" ? t("mcp.browser.modePlaywright") : t("mcp.browser.modeDevtools")}
                </span>
                {m === "playwright" && (
                  <span className="rounded bg-[var(--color-brand)]/10 px-1 py-px text-[9px] font-medium text-[var(--color-brand)]">
                    {t("mcp.browser.recommended")}
                  </span>
                )}
                {mode === m && <CheckCircle2 className="ml-auto size-3 text-[var(--color-brand)]" />}
              </div>
              <p className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
                {m === "playwright" ? t("mcp.browser.modePlaywrightDesc") : t("mcp.browser.modeDevtoolsDesc")}
              </p>
            </button>
          ))}
          {switchingMode && <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />}
        </div>

      {error && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={setup} disabled={installing} className="font-medium hover:underline">
            {t("mcp.browser.retry")}
          </button>
        </div>
      )}
    </div>
  )
}

function ServicesSection() {
  const { t } = useI18n()
  const {
    statusMap, configMap, loading, error, actionLoading,
    handleToggle, handleAdd, handleRemove, refresh,
  } = useMCPServers()
  const [addMode, setAddMode] = useState<"none" | "manual" | "json">("none")
  const [refreshing, setRefreshing] = useState(false)

  const entries = Object.entries(statusMap)
  const connectedCount = entries.filter(([, s]) => s.status === "connected").length

  const onRefresh = async () => {
    setRefreshing(true)
    try { await refresh() } finally { setRefreshing(false) }
  }

  const onAdd = async (name: string, config: MCPConfig) => {
    try {
      await handleAdd(name, config)
      setAddMode("none")
    } catch {
      // error already toasted by hook
    }
  }

  const [jsonImporting, setJsonImporting] = useState(false)

  const onJsonImport = async (servers: Record<string, MCPConfig>) => {
    const existingNames = new Set(Object.keys(statusMap))
    let imported = 0
    let skipped = 0
    setJsonImporting(true)
    try {
      for (const [name, config] of Object.entries(servers)) {
        if (existingNames.has(name)) {
          skipped++
          continue
        }
        try {
          await handleAdd(name, config)
          imported++
        } catch {
          // error already toasted by hook
        }
      }
      if (imported > 0) {
        toast.success(t("mcp.jsonImportSuccess").replace("{count}", String(imported)))
      }
      if (skipped > 0) {
        toast.info(t("mcp.jsonImportSkipped").replace("{count}", String(skipped)))
      }
      if (imported > 0 || skipped === Object.keys(servers).length) {
        setAddMode("none")
      }
    } finally {
      setJsonImporting(false)
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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={addMode !== "none"}>
                <Plus className="mr-1.5 size-3.5" />
                {t("mcp.addServer")}
                <ChevronDown className="ml-1.5 size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setAddMode("manual")}>
                <Plus className="mr-2 size-4" />
                {t("mcp.addManual")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setAddMode("json")}>
                <FileJson className="mr-2 size-4" />
                {t("mcp.addJsonImport")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Built-in: Browser MCP */}
      <BrowserServiceCard />

      {/* Add form (manual) */}
      {addMode === "manual" && (
        <ServiceAddForm
          onAdd={onAdd}
          onCancel={() => setAddMode("none")}
          loading={actionLoading === "__add__"}
        />
      )}

      {/* JSON import form */}
      {addMode === "json" && (
        <JsonImportForm
          onImport={onJsonImport}
          onCancel={() => setAddMode("none")}
          loading={jsonImporting}
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
      {!loading && !error && entries.length === 0 && addMode === "none" && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Server className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("mcp.noServers")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setAddMode("manual")}>
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

function KeyValueEditor({
  entries,
  onChange,
  namePlaceholder,
  valuePlaceholder,
  addLabel,
  removeLabel,
}: {
  entries: Array<{ key: string; value: string }>
  onChange: (entries: Array<{ key: string; value: string }>) => void
  namePlaceholder: string
  valuePlaceholder: string
  addLabel: string
  removeLabel: string
}) {
  const addEntry = () => onChange([...entries, { key: "", value: "" }])
  const removeEntry = (idx: number) => onChange(entries.filter((_, i) => i !== idx))
  const updateEntry = (idx: number, field: "key" | "value", val: string) => {
    const next = entries.map((e, i) => (i === idx ? { ...e, [field]: val } : e))
    onChange(next)
  }

  return (
    <div className="space-y-2">
      {entries.map((entry, idx) => (
        <div key={idx} className="flex items-center gap-2">
          <input
            value={entry.key}
            onChange={(e) => updateEntry(idx, "key", e.target.value)}
            placeholder={namePlaceholder}
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
          <input
            value={entry.value}
            onChange={(e) => updateEntry(idx, "value", e.target.value)}
            placeholder={valuePlaceholder}
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
          <button
            onClick={() => removeEntry(idx)}
            className="rounded p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500"
            title={removeLabel}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
      <button
        onClick={addEntry}
        className="text-xs font-medium text-[var(--color-primary)] hover:underline"
      >
        + {addLabel}
      </button>
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
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([])
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])

  const canSubmit = name.trim() && (type === "remote" ? url.trim() : command.trim())

  const handleSubmit = () => {
    if (!canSubmit) return
    if (type === "remote") {
      const headersRecord = headers.reduce<Record<string, string>>((acc, h) => {
        if (h.key.trim()) acc[h.key.trim()] = h.value
        return acc
      }, {})
      const config: MCPConfig = {
        type: "remote",
        url: url.trim(),
        ...(Object.keys(headersRecord).length > 0 && { headers: headersRecord }),
      }
      onAdd(name.trim(), config)
    } else {
      const envRecord = envVars.reduce<Record<string, string>>((acc, e) => {
        if (e.key.trim()) acc[e.key.trim()] = e.value
        return acc
      }, {})
      const config: MCPConfig = {
        type: "local",
        command: command.trim().split(/\s+/),
        ...(Object.keys(envRecord).length > 0 && { environment: envRecord }),
      }
      onAdd(name.trim(), config)
    }
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
          <>
            <div className="space-y-2">
              <label className="text-sm font-medium text-[var(--color-fg)]">{t("services.serverUrl")}</label>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp-server.example.com"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
              />
            </div>

            {/* Headers */}
            <div className="space-y-2 rounded-lg border border-dashed border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.headers")}</label>
                  <p className="text-xs text-[var(--color-fg-muted)]">{t("mcp.headersHint")}</p>
                </div>
              </div>
              <KeyValueEditor
                entries={headers}
                onChange={setHeaders}
                namePlaceholder={t("mcp.headerName")}
                valuePlaceholder={t("mcp.headerValue")}
                addLabel={t("mcp.addHeader")}
                removeLabel={t("mcp.headerRemove")}
              />
            </div>
          </>
        ) : (
          <>
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

            {/* Environment variables */}
            <div className="space-y-2 rounded-lg border border-dashed border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.environment")}</label>
                  <p className="text-xs text-[var(--color-fg-muted)]">{t("mcp.environmentHint")}</p>
                </div>
              </div>
              <KeyValueEditor
                entries={envVars}
                onChange={setEnvVars}
                namePlaceholder={t("mcp.envVarName")}
                valuePlaceholder={t("mcp.envVarValue")}
                addLabel={t("mcp.addEnvVar")}
                removeLabel={t("mcp.headerRemove")}
              />
            </div>
          </>
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

function JsonImportForm({
  onImport,
  onCancel,
  loading,
}: {
  onImport: (servers: Record<string, MCPConfig>) => Promise<void> | void
  onCancel: () => void
  loading: boolean
}) {
  const { t } = useI18n()
  const [json, setJson] = useState("")
  const [parseError, setParseError] = useState("")

  const handleImport = () => {
    setParseError("")
    try {
      const parsed = JSON.parse(json)
      // Support both { mcpServers: { ... } } and direct { name: config } format
      const servers: Record<string, any> = parsed.mcpServers ?? parsed
      if (typeof servers !== "object" || Array.isArray(servers)) {
        setParseError(t("mcp.jsonImportError"))
        return
      }

      // Convert to our MCPConfig format
      const result: Record<string, MCPConfig> = {}
      for (const [name, raw] of Object.entries(servers)) {
        if (typeof raw !== "object" || !raw) continue
        const entry = raw as Record<string, any>

        if (entry.url && typeof entry.url === "string") {
          // Remote server
          const hdrs = entry.headers && typeof entry.headers === "object"
            ? entry.headers as Record<string, string>
            : undefined
          result[name] = { type: "remote", url: entry.url, ...(hdrs && { headers: hdrs }) }
        } else if (entry.command) {
          // Local server — handle both `command: string` + `args: string[]` and `command: string[]`
          let cmdArray: string[]
          if (Array.isArray(entry.command)) {
            cmdArray = entry.command.map(String)
          } else {
            cmdArray = [String(entry.command), ...(Array.isArray(entry.args) ? entry.args.map(String) : [])]
          }
          const env = entry.environment && typeof entry.environment === "object"
            ? entry.environment as Record<string, string>
            : entry.env && typeof entry.env === "object"
            ? entry.env as Record<string, string>
            : undefined
          result[name] = { type: "local", command: cmdArray, ...(env && { environment: env }) }
        }
      }

      if (Object.keys(result).length === 0) {
        setParseError(t("mcp.jsonImportError"))
        return
      }

      onImport(result)
    } catch {
      setParseError(t("mcp.jsonImportError"))
    }
  }

  const placeholder = `{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": ["-y", "mcp-server-example"]
    }
  }
}`

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.jsonImportTitle")}</h3>
        <button onClick={onCancel} className="rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]">
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("mcp.jsonImportLabel")}</label>
          <textarea
            value={json}
            onChange={(e) => { setJson(e.target.value); setParseError("") }}
            placeholder={placeholder}
            rows={10}
            className="w-full resize-y rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
          <p className="text-xs text-green-600 dark:text-green-400">{t("mcp.jsonImportHint")}</p>
        </div>

        {parseError && (
          <div className="flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
            <AlertCircle className="size-3.5 shrink-0" />
            <span>{parseError}</span>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>{t("button.cancel")}</Button>
          <Button onClick={handleImport} disabled={!json.trim() || loading}>
            {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            <FileJson className="mr-1.5 size-4" />
            {t("mcp.jsonImportButton")}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChannelsSection() {
  const { t } = useI18n()
  const {
    channels, configs, loading, error, actionLoading,
    handleAdd, handleRemove, handleConnect, handleDisconnect, refresh,
    requestWeChatQR, pollWeChatQRStatus,
  } = useChannels()
  const [showAdd, setShowAdd] = useState<false | "dingtalk" | "wechat">(false)
  const [refreshing, setRefreshing] = useState(false)

  const connectedCount = channels.filter((c) => c.state === "connected").length

  const onRefresh = async () => {
    setRefreshing(true)
    try { await refresh() } finally { setRefreshing(false) }
  }

  const onAdd = async (config: Omit<ChannelConfig, "id">) => {
    try {
      await handleAdd(config)
      setShowAdd(false)
    } catch {
      // error already toasted by hook
    }
  }

  const onWeChatDone = () => {
    setShowAdd(false)
    // WeChat's auto-connect runs in the background after addChannel resolves
    // (the adapter starts a long-poll loop and reports "connecting" until the
    // first poll succeeds). One refresh would catch the "connecting" snapshot
    // and the UI would stay stale. Schedule a few more refreshes to catch the
    // state flip whenever it lands (typically within ~10s on a healthy link).
    refresh()
    for (const delay of [2000, 5000, 10000, 20000, 35000]) {
      setTimeout(() => { refresh() }, delay)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("channel.title")}</h2>
            {connectedCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                {connectedCount} {t("channel.connected")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("channel.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            {t("workspace.refresh")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={!!showAdd}>
                <Plus className="mr-1.5 size-3.5" />
                {t("channel.addChannel")}
                <ChevronDown className="ml-1.5 size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setShowAdd("dingtalk")}>
                <MessageSquare className="mr-2 size-4" />
                {t("channel.type.dingtalk")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowAdd("wechat")}>
                <Smartphone className="mr-2 size-4" />
                {t("channel.type.wechat")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Add DingTalk form */}
      {showAdd === "dingtalk" && (
        <ChannelAddForm
          onAdd={onAdd}
          onCancel={() => setShowAdd(false)}
          loading={actionLoading === "__add__"}
        />
      )}

      {/* WeChat QR login */}
      {showAdd === "wechat" && (
        <WeChatQRLogin
          onDone={onWeChatDone}
          onCancel={() => setShowAdd(false)}
          requestQR={requestWeChatQR}
          pollStatus={pollWeChatQRStatus}
          existingChannels={channels}
        />
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-500/10 p-4 text-sm text-red-600 dark:border-red-800 dark:text-red-400">
          <AlertCircle className="size-4 shrink-0" />
          {t("channel.error.fetch")}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && channels.length === 0 && !showAdd && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Radio className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("channel.noChannels")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowAdd("wechat")}>
            <Smartphone className="mr-1.5 size-3.5" />
            {t("channel.type.wechat")}
          </Button>
        </div>
      )}

      {/* Channel cards */}
      {!loading && !error && channels.length > 0 && (
        <div className="space-y-3">
          {channels.map((ch) => (
            <ChannelCard
              key={ch.id}
              channel={ch}
              workspaceDir={configs.find((c) => c.id === ch.id)?.workspaceDir}
              loading={actionLoading === ch.id}
              onConnect={() => handleConnect(ch.id)}
              onDisconnect={() => handleDisconnect(ch.id)}
              onRemove={() => handleRemove(ch.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ChannelCard({
  channel,
  workspaceDir,
  loading,
  onConnect,
  onDisconnect,
  onRemove,
}: {
  channel: ChannelStatus
  workspaceDir?: string
  loading: boolean
  onConnect: () => void
  onDisconnect: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  const isConnected = channel.state === "connected"
  const isError = channel.state === "error"

  const stateLabel = t(`channel.state.${channel.state}`)

  const dotColor = isConnected
    ? "bg-green-500"
    : isError
    ? "bg-red-500"
    : channel.state === "connecting"
    ? "bg-amber-500"
    : "bg-gray-400"

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={cn("size-2.5 shrink-0 rounded-full", dotColor)} />
            <span className="text-sm font-medium text-[var(--color-fg)]">{channel.name}</span>
            <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
              {t(`channel.type.${channel.type}`)}
            </span>
          </div>
          <p className={cn(
            "mt-1 text-xs",
            isError ? "text-red-500" : "text-[var(--color-fg-muted)]"
          )}>
            {channel.error || stateLabel}
          </p>
          {channel.connectedAt && (
            <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
              {new Date(channel.connectedAt).toLocaleString()}
            </p>
          )}
          {workspaceDir && (
            <p className="mt-1 truncate text-xs text-[var(--color-fg-muted)]" title={workspaceDir}>
              {t("channel.workspaceDir")}: {pathBasename(workspaceDir)}
            </p>
          )}
        </div>
        <div className="ml-4 flex shrink-0 items-center gap-2">
          <Button
            variant={isConnected ? "outline" : "default"}
            size="sm"
            onClick={isConnected ? onDisconnect : onConnect}
            disabled={loading}
          >
            {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
            {isConnected ? t("channel.disconnect") : t("channel.connect")}
          </Button>
          {!isConnected && !loading && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRemove}
              className="text-red-500 hover:bg-red-500/10 hover:text-red-600"
            >
              {t("channel.remove")}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function ChannelAddForm({
  onAdd,
  onCancel,
  loading,
}: {
  onAdd: (config: Omit<ChannelConfig, "id">) => Promise<void>
  onCancel: () => void
  loading: boolean
}) {
  const { t } = useI18n()
  const { workspacePath } = useWorkspace()
  const [name, setName] = useState("")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [autoConnect, setAutoConnect] = useState(true)

  const canSubmit = name.trim() && clientId.trim() && clientSecret.trim()

  const handleSubmit = () => {
    if (!canSubmit) return
    onAdd({
      type: "dingtalk",
      name: name.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      workspaceDir: workspacePath!,
      autoConnect,
    } as Omit<DingTalkChannelConfig, "id">)
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.addChannel")} — {t("channel.type.dingtalk")}</h3>
        <button onClick={onCancel} className="rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]">
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("channel.name")}</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("channel.namePlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("channel.clientId")}</label>
          <input
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder={t("channel.clientIdPlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[var(--color-fg)]">{t("channel.clientSecret")}</label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={t("channel.clientSecretPlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="autoConnect"
            checked={autoConnect}
            onChange={(e) => setAutoConnect(e.target.checked)}
            className="size-4 rounded border-[var(--color-border)]"
          />
          <label htmlFor="autoConnect" className="text-sm text-[var(--color-fg)]">{t("channel.autoConnect")}</label>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>{t("button.cancel")}</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || loading}>
            {loading && <Loader2 className="mr-1.5 size-4 animate-spin" />}
            {t("channel.add")}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** WeChat QR code login flow component */
function WeChatQRLogin({
  onDone,
  onCancel,
  requestQR,
  pollStatus,
  existingChannels,
}: {
  onDone: () => void
  onCancel: () => void
  requestQR: (name: string, workspaceDir: string, autoConnect?: boolean) => Promise<{ qrcodeUrl: string; qrcodeImgContent: string; token: string }>
  pollStatus: (token: string) => Promise<{ status: string; channelId?: string }>
  existingChannels: { id: string; type: string; name: string }[]
}) {
  const { t } = useI18n()
  const { workspacePath } = useWorkspace()
  const [qrUrl, setQrUrl] = useState("")
  const [qrToken, setQrToken] = useState("")
  const [scanStatus, setScanStatus] = useState<string>("wait")
  const [errorMsg, setErrorMsg] = useState("")
  const [refreshCount, setRefreshCount] = useState(0)
  const MAX_REFRESH = 3

  // Auto-generate channel name
  const autoName = useMemo(() => {
    const base = t("channel.type.wechat")
    const wechatNames = new Set(
      existingChannels.filter((c) => c.type === "wechat").map((c) => c.name),
    )
    if (!wechatNames.has(base)) return base
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`
      if (!wechatNames.has(candidate)) return candidate
    }
  }, [existingChannels, t])

  // Auto-start QR flow on mount
  useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    const start = async () => {
      try {
        const data = await requestQR(autoName, workspacePath)
        if (cancelled) return
        setQrUrl(data.qrcodeImgContent || data.qrcodeUrl)
        setQrToken(data.token)
        setScanStatus("wait")
      } catch (err) {
        if (cancelled) return
        setErrorMsg(t("channel.wechat.error"))
        console.error("WeChat QR request failed:", err)
      }
    }
    start()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for scan status
  useEffect(() => {
    if (!qrToken) return

    let cancelled = false
    const poll = async () => {
      while (!cancelled) {
        try {
          const resp = await pollStatus(qrToken)
          if (cancelled) break
          setScanStatus(resp.status)

          if (resp.status === "confirmed") {
            // Success — close and refresh
            setTimeout(onDone, 1500)
            return
          }

          if (resp.status === "expired") {
            // Auto-refresh QR code
            if (refreshCount < MAX_REFRESH) {
              setRefreshCount((c) => c + 1)
              try {
                const data = await requestQR(autoName, workspacePath!)
                if (cancelled) break
                setQrUrl(data.qrcodeImgContent || data.qrcodeUrl)
                setQrToken(data.token)
                setScanStatus("wait")
              } catch {
                setErrorMsg(t("channel.wechat.error"))
                return
              }
            } else {
              setErrorMsg(t("channel.wechat.expired"))
              return
            }
            continue
          }

          // For "wait" and "scaned", keep polling
          await new Promise((r) => setTimeout(r, 1000))
        } catch (err) {
          if (cancelled) break
          // 404 = QR session consumed (confirmed & deleted) — treat as success
          if (err instanceof Error && err.message.includes("404")) {
            setTimeout(onDone, 500)
            return
          }
          // Network error — wait and retry
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    }

    poll()
    return () => { cancelled = true }
  }, [qrToken, refreshCount]) // eslint-disable-line react-hooks/exhaustive-deps

  const statusText = scanStatus === "wait"
    ? t("channel.wechat.waitingScan")
    : scanStatus === "scaned"
    ? t("channel.wechat.scanned")
    : scanStatus === "confirmed"
    ? t("channel.wechat.confirmed")
    : ""

  // QR code display (direct, no name step)
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.wechat.scanQR")}</h3>
        <button onClick={onCancel} className="rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]">
          <X className="size-4" />
        </button>
      </div>

      <div className="mt-4 flex flex-col items-center gap-4">
        {/* QR Code */}
        <div className="rounded-lg border border-[var(--color-border)] bg-white p-4">
          {qrUrl ? (
            <QRCodeSVG value={qrUrl} size={200} level="M" />
          ) : errorMsg ? (
            <div className="flex size-[200px] flex-col items-center justify-center gap-3">
              <AlertCircle className="size-8 text-red-400" />
              <Button variant="outline" size="sm" onClick={() => {
                setErrorMsg("")
                if (!workspacePath) return
                requestQR(autoName, workspacePath).then((data) => {
                  setQrUrl(data.qrcodeImgContent || data.qrcodeUrl)
                  setQrToken(data.token)
                  setScanStatus("wait")
                }).catch((err) => {
                  setErrorMsg(t("channel.wechat.error"))
                  console.error("WeChat QR retry failed:", err)
                })
              }}>
                <RefreshCw className="mr-1.5 size-3.5" />
                {t("button.retry")}
              </Button>
            </div>
          ) : (
            <div className="flex size-[200px] items-center justify-center">
              <Loader2 className="size-8 animate-spin text-gray-400" />
            </div>
          )}
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 text-sm">
          {scanStatus === "confirmed" ? (
            <CheckCircle2 className="size-4 text-green-500" />
          ) : scanStatus === "scaned" ? (
            <Smartphone className="size-4 text-blue-500" />
          ) : (
            <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
          )}
          <span className={cn(
            scanStatus === "confirmed" ? "text-green-600 dark:text-green-400" :
            scanStatus === "scaned" ? "text-blue-600 dark:text-blue-400" :
            "text-[var(--color-fg-muted)]"
          )}>
            {statusText}
          </span>
        </div>

        {errorMsg && (
          <p className="text-xs text-red-500">{errorMsg}</p>
        )}

        <Button variant="outline" size="sm" onClick={onCancel}>
          {t("button.cancel")}
        </Button>
      </div>
    </div>
  )
}

type KBFilterType = "all" | "local_folder" | "platform" | "custom_api"

function KnowledgeSection() {
  const { t } = useI18n()
  const {
    sources, loading, error, actionLoading,
    addFolder, removeSource, reindexSource, testConnection, refresh,
  } = useKnowledgeBase()
  const [refreshing, setRefreshing] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [filter, setFilter] = useState<KBFilterType>("all")

  const onRefresh = async () => {
    setRefreshing(true)
    try { await refresh() } finally { setRefreshing(false) }
  }

  const handleAddFolder = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog")
    const selected = await open({ directory: true, multiple: false })
    if (selected) {
      await addFolder(selected as string)
    }
  }

  const activeSources = sources.filter((s) => s.status === "complete" || s.status === "connected")

  // Count by category
  const localCount = sources.filter((s) => s.type === "local_folder").length
  const platformCount = sources.filter((s) => s.type === "ima").length
  const apiCount = sources.filter((s) => s.type === "custom_api").length

  // Filter sources
  const filteredSources = filter === "all"
    ? sources
    : filter === "platform"
      ? sources.filter((s) => s.type === "ima")
      : sources.filter((s) => s.type === filter)

  const filterChips: { key: KBFilterType; labelKey: string; count: number }[] = [
    { key: "all", labelKey: "knowledge.filterAll", count: sources.length },
    { key: "local_folder", labelKey: "knowledge.filterLocal", count: localCount },
    { key: "platform", labelKey: "knowledge.filterPlatform", count: platformCount },
    { key: "custom_api", labelKey: "knowledge.filterApi", count: apiCount },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("knowledge.title")}</h2>
            {activeSources.length > 0 && (
              <span className="inline-flex items-center rounded-full bg-green-500/10 px-2 py-0.5 text-xs font-medium text-green-600 dark:text-green-400">
                {activeSources.length}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("knowledge.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            {t("workspace.refresh")}
          </Button>
          <Button size="sm" onClick={() => setShowAddDialog(true)} disabled={!!actionLoading}>
            <Plus className="mr-1.5 size-3.5" />
            {t("knowledge.addSource")}
          </Button>
        </div>
      </div>

      {/* Filter chips — only show when there are sources */}
      {!loading && !error && sources.length > 0 && (
        <div className="flex items-center gap-2">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              onClick={() => setFilter(chip.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === chip.key
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "border-[var(--color-border)] text-[var(--color-fg-muted)] hover:border-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
              )}
            >
              {t(chip.labelKey)}
              <span className={cn(
                "inline-flex size-4.5 items-center justify-center rounded-full text-[10px]",
                filter === chip.key
                  ? "bg-[var(--color-primary)]/20"
                  : "bg-[var(--color-bg-hover)]",
              )}>
                {chip.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-500/10 p-4 text-sm text-red-600 dark:border-red-800 dark:text-red-400">
          <AlertCircle className="size-4 shrink-0" />
          {t("knowledge.fetchError")}
        </div>
      )}

      {/* Empty state — no sources at all */}
      {!loading && !error && sources.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Database className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("knowledge.noSources")}</p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t("knowledge.noSourcesHint")}</p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowAddDialog(true)}>
            <Plus className="mr-1.5 size-3.5" />
            {t("knowledge.addSource")}
          </Button>
        </div>
      )}

      {/* Source cards (filtered) */}
      {!loading && !error && sources.length > 0 && (
        filteredSources.length > 0 ? (
          <div className="space-y-3">
            {filteredSources.map((source) => (
              <KnowledgeSourceCard
                key={source.id}
                source={source}
                loading={actionLoading === String(source.id)}
                onReindex={() => reindexSource(source.id)}
                onRemove={() => removeSource(source.id)}
                onTestConnection={() => testConnection(source.id)}
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-12">
            <p className="text-sm text-[var(--color-fg-muted)]">{t("knowledge.noSources")}</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowAddDialog(true)}>
              <Plus className="mr-1.5 size-3.5" />
              {t("knowledge.addSource")}
            </Button>
          </div>
        )
      )}

      <AddSourceDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        onAdded={() => { setShowAddDialog(false); refresh() }}
        onAddLocalFolder={handleAddFolder}
        existingSources={sources}
      />
    </div>
  )
}

function KnowledgeSourceCard({
  source,
  loading,
  onReindex,
  onRemove,
  onTestConnection,
}: {
  source: KBSource
  loading: boolean
  onReindex: () => void
  onRemove: () => void
  onTestConnection: () => void
}) {
  const { t } = useI18n()
  const isLocalFolder = source.type === "local_folder"
  const isComplete = source.status === "complete"
  const isConnected = source.status === "connected"
  const isIndexing = source.status === "indexing"
  const isError = source.status === "error"

  // After indexing completes, keep progress bar visible for a fixed duration
  // so the user can see the final "N / N" state before it disappears
  const FINISH_DISPLAY_MS = 1200
  const [showProgress, setShowProgress] = useState(isIndexing)
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (isIndexing) {
      setShowProgress(true)
      if (finishTimerRef.current) {
        clearTimeout(finishTimerRef.current)
        finishTimerRef.current = null
      }
    } else if (showProgress) {
      // Indexing just ended — keep bar visible for FINISH_DISPLAY_MS
      finishTimerRef.current = setTimeout(() => {
        setShowProgress(false)
        finishTimerRef.current = null
      }, FINISH_DISPLAY_MS)
    }
    return () => {
      if (finishTimerRef.current) clearTimeout(finishTimerRef.current)
    }
  }, [isIndexing]) // eslint-disable-line react-hooks/exhaustive-deps

  // Visual state: use real status, but during finish delay show "completing" progress
  const visualIndexing = isIndexing || showProgress
  const isFinishing = !isIndexing && showProgress // real status is complete but still showing progress

  const statusLabel = isComplete && !isFinishing
    ? t("knowledge.complete")
    : isConnected
    ? t("knowledge.connected")
    : visualIndexing
    ? t("knowledge.indexing")
    : isError
    ? t("knowledge.error")
    : t("knowledge.idle")

  const dotColor = (isComplete && !isFinishing) || isConnected
    ? "bg-green-500"
    : visualIndexing
    ? "bg-amber-500 animate-pulse"
    : isError
    ? "bg-red-500"
    : "bg-gray-400"

  const TypeIcon = isLocalFolder ? FolderOpen : Globe

  // Progress bar calculation
  const hasFileCount = source.totalFiles != null && source.totalFiles > 0
  const progressPct = hasFileCount
    ? Math.round(((source.indexedFiles ?? 0) / source.totalFiles!) * 100)
    : 0

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <span className={cn("size-2.5 shrink-0 rounded-full", dotColor)} />
            <TypeIcon className="size-4 shrink-0 text-[var(--color-fg-muted)]" />
            <span className="text-sm font-medium text-[var(--color-fg)]">{source.name}</span>
            {!isLocalFolder && (
              <span className="rounded bg-purple-500/10 px-1.5 py-0.5 text-[10px] font-medium text-purple-500">
                {source.type.toUpperCase()}
              </span>
            )}
          </div>
          <p className={cn(
            "mt-1 text-xs",
            isError ? "text-red-500" : "text-[var(--color-fg-muted)]"
          )}>
            {source.error || statusLabel}
            {isLocalFolder && isComplete && !isFinishing && source.indexedFiles != null && ` — ${t("knowledge.files").replace("{count}", String(source.indexedFiles))}`}
            {isLocalFolder && visualIndexing && hasFileCount && ` — ${source.indexedFiles ?? 0} / ${source.totalFiles}`}
          </p>
          {/* Progress bar during indexing — always shown for consistency */}
          {isLocalFolder && visualIndexing && (
            <div className="mt-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
                {hasFileCount || isFinishing ? (
                  <div
                    className="h-full rounded-full bg-amber-500 transition-all duration-300"
                    style={{ width: `${isFinishing ? 100 : progressPct}%` }}
                  />
                ) : (
                  <div className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-amber-500" />
                )}
              </div>
              <p className="mt-1 truncate text-xs text-[var(--color-fg-muted)]" title={source.currentFile || ""}>
                {source.currentFile || (!hasFileCount && !isFinishing ? t("knowledge.scanning") : "")}
              </p>
            </div>
          )}
          {isLocalFolder && source.folderPath && (
            <p className="mt-1 truncate font-mono text-xs text-[var(--color-fg-muted)]" title={source.folderPath}>
              {source.folderPath}
            </p>
          )}
        </div>
        <div className="ml-4 flex shrink-0 items-center gap-2">
          {isLocalFolder && (
            <Button
              variant="outline"
              size="sm"
              onClick={onReindex}
              disabled={loading || visualIndexing}
            >
              {(loading || visualIndexing) && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {t("knowledge.reindex")}
            </Button>
          )}
          {!isLocalFolder && (
            <Button
              variant="outline"
              size="sm"
              onClick={onTestConnection}
              disabled={loading}
            >
              {loading && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {isConnected ? t("knowledge.reconnect") : t("knowledge.testConnection")}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRemove}
            disabled={loading || visualIndexing}
            className="text-red-500 hover:bg-red-500/10 hover:text-red-600"
          >
            {t("knowledge.remove")}
          </Button>
        </div>
      </div>
    </div>
  )
}

const SKILL_GROUP_ICONS: Record<SkillSource, typeof Terminal> = {
  command: Terminal,
  mcp: Globe,
  skill: Sparkles,
}

const SOURCE_BADGE_COLORS: Record<SkillSource, string> = {
  command: "bg-gray-500/10 text-gray-600 dark:text-gray-400",
  mcp: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  skill: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
}

// Curated, permissively-licensed (Apache-2.0) community skills the user can
// install on demand via the built-in skill-installer. Keep this list to
// known-good, non-proprietary sources only.
const INSTALLABLE_SKILLS: { name: string; descKey: string; repo: string; path: string }[] = [
  { name: "mcp-builder", descKey: "skills.catalog.mcpBuilder", repo: "anthropics/skills", path: "skills/mcp-builder" },
  { name: "webapp-testing", descKey: "skills.catalog.webappTesting", repo: "anthropics/skills", path: "skills/webapp-testing" },
  { name: "frontend-design", descKey: "skills.catalog.frontendDesign", repo: "anthropics/skills", path: "skills/frontend-design" },
  { name: "algorithmic-art", descKey: "skills.catalog.algorithmicArt", repo: "anthropics/skills", path: "skills/algorithmic-art" },
]

function matchesQuery(name: string, description: string, q: string) {
  const s = q.toLowerCase()
  return name.toLowerCase().includes(s) || description.toLowerCase().includes(s)
}

function SkillsSection() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const {
    allItems, loading, error, totalCount,
    skillsConfig, refresh, updateSkillsConfig,
  } = useSkills()
  const { deps, loading: depsLoading } = useSkillDeps()
  const [searchQuery, setSearchQuery] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [newPath, setNewPath] = useState("")
  const [newUrl, setNewUrl] = useState("")
  const [tab, setTab] = useState<"builtin" | "installable" | "custom">("builtin")
  const [sourcesOpen, setSourcesOpen] = useState(false)

  const onRefresh = async () => {
    setRefreshing(true)
    try { await refresh() } finally { setRefreshing(false) }
  }

  const q = searchQuery.trim()
  // Zone 1: built-in skills (shipped with ultrawork). Zone 3: everything else
  // discovered from the user's own paths/urls/config.
  const builtinItems = allItems
    .filter((i) => i.builtin)
    .filter((i) => !q || matchesQuery(i.name, i.description, q))
  const customItems = allItems
    .filter((i) => !i.builtin)
    .filter((i) => !q || matchesQuery(i.name, i.description, q))
  const installedNames = new Set(allItems.map((i) => i.name))
  const catalogItems = INSTALLABLE_SKILLS
    .filter((s) => !q || matchesQuery(s.name, t(s.descKey), q))

  // Install a curated skill by handing the request to the built-in skill-installer
  // in a fresh chat (avoids reimplementing git/auth in the shell).
  const handleInstall = (s: { name: string; repo: string; path: string }) => {
    const prompt = t("skills.installPrompt", { name: s.name, repo: s.repo, path: s.path })
    navigate("/", { state: { initialInput: prompt } })
  }

  // Missing skill dependencies: hand off to the AI in a fresh chat, which detects the
  // OS and walks the user through platform-appropriate installs (same pattern as install).
  const handleDepGuide = (item: SkillItem, missing: string[]) => {
    const prompt = t("skills.depGuidePrompt", {
      name: item.name,
      deps: missing.join(", "),
      location: item.location ?? "",
    })
    navigate("/", { state: { initialInput: prompt } })
  }

  const handleAddPath = () => {
    const trimmed = newPath.trim()
    if (!trimmed) return
    if (skillsConfig.paths.includes(trimmed)) return
    updateSkillsConfig({ paths: [...skillsConfig.paths, trimmed] })
    setNewPath("")
  }

  const handleRemovePath = (path: string) => {
    updateSkillsConfig({ paths: skillsConfig.paths.filter((p) => p !== path) })
  }

  const handleAddUrl = () => {
    const trimmed = newUrl.trim()
    if (!trimmed) return
    if (skillsConfig.urls.includes(trimmed)) return
    updateSkillsConfig({ urls: [...skillsConfig.urls, trimmed] })
    setNewUrl("")
  }

  const handleRemoveUrl = (url: string) => {
    updateSkillsConfig({ urls: skillsConfig.urls.filter((u) => u !== url) })
  }

  const tabEmptyHint = (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-10">
      <Search className="size-7 text-[var(--color-fg-muted)]" />
      <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t("skills.noSearchResults")}</p>
    </div>
  )

  return (
    <div className="space-y-5">
      {/* Header: title + count | 来源管理 + 刷新 */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-[var(--color-fg)]">{t("skills.settingsTitle")}</h2>
            {totalCount > 0 && (
              <span className="inline-flex items-center rounded-full bg-[var(--color-accent)] px-2 py-0.5 text-xs font-medium text-[var(--color-fg-muted)]">
                {totalCount}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">{t("skills.settingsDescription")}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setSourcesOpen(true)}>
            <SlidersHorizontal className="mr-1.5 size-3.5" />
            {t("skills.manageSources")}
          </Button>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
            {t("workspace.refresh")}
          </Button>
        </div>
      </div>

      {/* Search */}
      {totalCount > 0 && (
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--color-fg-muted)]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("skills.searchPlaceholder")}
            className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-2 pr-3 pl-9 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
          />
        </div>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-[var(--color-fg-muted)]" />
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-500/10 p-4 text-sm text-red-600 dark:border-red-800 dark:text-red-400">
          <AlertCircle className="size-4 shrink-0" />
          {t("error.fetchSkills")}
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && totalCount === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-16">
          <Sparkles className="size-10 text-[var(--color-fg-muted)]" />
          <p className="mt-3 text-sm text-[var(--color-fg-muted)]">{t("skills.empty")}</p>
        </div>
      )}

      {/* Tabs: 内置 / 推荐安装 / 自定义 */}
      {!loading && !error && totalCount > 0 && (
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="w-full justify-start">
            <TabsTrigger value="builtin" className="gap-1.5">
              <Package className="size-3.5" />
              {t("skills.zone.builtin")}
              <span className="text-xs opacity-60">{builtinItems.length}</span>
            </TabsTrigger>
            <TabsTrigger value="installable" className="gap-1.5">
              <Download className="size-3.5" />
              {t("skills.zone.installable")}
              <span className="text-xs opacity-60">{catalogItems.length}</span>
            </TabsTrigger>
            <TabsTrigger value="custom" className="gap-1.5">
              <Wrench className="size-3.5" />
              {t("skills.zone.custom")}
              <span className="text-xs opacity-60">{customItems.length}</span>
            </TabsTrigger>
          </TabsList>

          {/* 内置 */}
          <TabsContent value="builtin" className="space-y-2">
            <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.zone.builtinNote")}</p>
            {builtinItems.length > 0
              ? builtinItems.map((item) => (
                  <SettingsSkillCard
                    key={item.name}
                    item={item}
                    depBadge={
                      <DepBadge
                        skillName={item.name}
                        deps={deps}
                        loading={depsLoading}
                        onGuide={(missing) => handleDepGuide(item, missing)}
                      />
                    }
                  />
                ))
              : tabEmptyHint}
          </TabsContent>

          {/* 推荐安装 */}
          <TabsContent value="installable" className="space-y-2">
            <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.zone.installableNote")}</p>
            {catalogItems.length > 0
              ? catalogItems.map((s) => {
                  const installed = installedNames.has(s.name)
                  return (
                    <div key={s.name} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                      <div className="flex items-start gap-3">
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--color-fg)]">{s.name}</span>
                            <a
                              href={`https://github.com/${s.repo}/tree/main/${s.path}`}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                            >
                              <ExternalLink className="size-3" />
                            </a>
                          </div>
                          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t(s.descKey)}</p>
                        </div>
                        {installed ? (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
                            <CheckCircle2 className="size-3" />
                            {t("skills.installed")}
                          </span>
                        ) : (
                          <Button variant="outline" size="sm" className="shrink-0" onClick={() => handleInstall(s)}>
                            <Download className="mr-1 size-3.5" />
                            {t("skills.install")}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })
              : tabEmptyHint}
          </TabsContent>

          {/* 自定义 */}
          <TabsContent value="custom" className="space-y-2">
            {customItems.length > 0 ? (
              customItems.map((item) => <SettingsSkillCard key={item.name} item={item} />)
            ) : (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-[var(--color-border)] py-10">
                <Wrench className="size-7 text-[var(--color-fg-muted)]" />
                <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{t("skills.customEmpty")}</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={() => setSourcesOpen(true)}>
                  <SlidersHorizontal className="mr-1.5 size-3.5" />
                  {t("skills.manageSources")}
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* 来源管理 dialog: paths/urls config (moved out of the bottom flow) */}
      <Dialog open={sourcesOpen} onOpenChange={setSourcesOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("skills.configTitle")}</DialogTitle>
            <DialogDescription>{t("skills.configNote")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Paths */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-[var(--color-fg)]">{t("skills.pathsLabel")}</label>
                <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.pathsDescription")}</p>
              </div>

              {skillsConfig.paths.map((path, i) => (
                <div key={`${path}-${i}`} className="flex items-center gap-2">
                  <div className="flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-fg)]">
                    {path}
                  </div>
                  <button
                    onClick={() => handleRemovePath(path)}
                    className="rounded p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}

              <div className="flex items-center gap-2">
                <input
                  value={newPath}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddPath() }}
                  placeholder={t("skills.pathPlaceholder")}
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                />
                <Button variant="outline" size="sm" onClick={handleAddPath} disabled={!newPath.trim()}>
                  <Plus className="mr-1 size-3.5" />
                  {t("skills.addPath")}
                </Button>
              </div>
            </div>

            {/* URLs */}
            <div className="space-y-3">
              <div>
                <label className="text-sm font-medium text-[var(--color-fg)]">{t("skills.urlsLabel")}</label>
                <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.urlsDescription")}</p>
              </div>

              {skillsConfig.urls.map((url, i) => (
                <div key={`${url}-${i}`} className="flex items-center gap-2">
                  <div className="flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 font-mono text-sm text-[var(--color-fg)]">
                    {url}
                  </div>
                  <button
                    onClick={() => handleRemoveUrl(url)}
                    className="rounded p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-red-500/10 hover:text-red-500"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}

              <div className="flex items-center gap-2">
                <input
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") handleAddUrl() }}
                  placeholder={t("skills.urlPlaceholder")}
                  className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                />
                <Button variant="outline" size="sm" onClick={handleAddUrl} disabled={!newUrl.trim()}>
                  <Plus className="mr-1 size-3.5" />
                  {t("skills.addUrl")}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Install-guidance hints shown when a dependency is missing (per host platform).
const DEP_HINTS: Record<string, string> = isWindows
  ? {
      python3: "winget install Python.Python.3.12 / python.org",
      "python3.10+": "winget install Python.Python.3.12 / python.org",
      node: "winget install OpenJS.NodeJS.LTS / nodejs.org",
      pandoc: "winget install JohnMacFarlane.Pandoc",
      soffice: "LibreOffice",
      pdftoppm: "scoop/choco install poppler",
      git: "winget install Git.Git / git-scm.com",
      "markdown-exporter": "pip install md-exporter",
      "python-pptx": "pip install python-pptx",
    }
  : isMacOS
    ? {
        python3: "brew install python / python.org",
        "python3.10+": "brew install python / python.org (>= 3.10)",
        node: "brew install node / nodejs.org",
        pandoc: "brew install pandoc",
        soffice: "LibreOffice",
        pdftoppm: "brew install poppler",
        git: "brew install git / git-scm.com",
        "markdown-exporter": "pip install md-exporter",
        "python-pptx": "pip install python-pptx",
      }
    : {
        python3: "apt/dnf install python3",
        "python3.10+": "apt/dnf install python3 (>= 3.10)",
        node: "apt/dnf install nodejs / nodejs.org",
        pandoc: "apt/dnf install pandoc",
        soffice: "LibreOffice (apt install libreoffice)",
        pdftoppm: "apt/dnf install poppler-utils",
        git: "apt/dnf install git",
        "markdown-exporter": "pip install md-exporter",
        "python-pptx": "pip install python-pptx",
      }

function DepBadge({
  skillName,
  deps,
  loading,
  onGuide,
}: {
  skillName: string
  deps: DepMap
  loading: boolean
  /** When set, missing deps render a "guide install" button handing off to a fresh chat. */
  onGuide?: (missing: string[]) => void
}) {
  const { t } = useI18n()
  const required = BUILTIN_DEP_MAP[skillName]
  if (!required) return null
  if (required.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
        {t("skills.depNone")}
      </span>
    )
  }
  if (loading) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]">
        <Loader2 className="size-3 animate-spin" />
        {t("skills.depChecking")}
      </span>
    )
  }
  const missing = missingDeps(skillName, deps)
  if (missing.length === 0) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
        <CheckCircle2 className="size-3" />
        {t("skills.depReady")}
      </span>
    )
  }
  // Append the actually-probed binary path when the probe reported one — makes
  // "installed but still missing" self-explanatory (wrong interpreter resolved).
  const hint = missing
    .map((m) => (DEP_HINTS[m] ?? m) + (deps[m]?.path ? ` [${deps[m].path}]` : ""))
    .join("; ")
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span
        title={`${t("skills.depMissingHint")}: ${hint}`}
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
      >
        <AlertTriangle className="size-3" />
        {t("skills.depMissing")}: {missing.join(", ")}
      </span>
      {onGuide && (
        <button
          type="button"
          onClick={() => onGuide(missing)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg-secondary)]"
        >
          <Download className="size-3" />
          {t("skills.depGuide")}
        </button>
      )}
    </span>
  )
}

function SettingsSkillCard({ item, depBadge }: { item: SkillItem; depBadge?: ReactNode }) {
  const { t } = useI18n()
  const Icon = SKILL_GROUP_ICONS[item.source]

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-fg)]">/{item.name}</span>
            <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", SOURCE_BADGE_COLORS[item.source])}>
              {t(`skills.source.${item.source}`)}
            </span>
            {depBadge}
          </div>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{item.description}</p>
          {item.location && (
            <p className="mt-1 truncate font-mono text-[10px] text-[var(--color-fg-muted)]">{item.location}</p>
          )}
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
          <Logo className="size-10" />
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
