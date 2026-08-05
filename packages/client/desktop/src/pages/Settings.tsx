import { useState, useEffect, useRef, useSyncExternalStore, type ComponentType, type ReactNode } from "react"
import { toast } from "sonner"
import { useNavigate, useLocation } from "react-router-dom"
import { Settings, Shield, Cpu, Info, CheckCircle2, XCircle, Loader2, Globe, MessageSquare, Sparkles, ExternalLink, Server, Plus, RefreshCw, X, AlertCircle, Search, Terminal, Radio, ChevronDown, FileJson, Trash2, BookOpen, FolderOpen, Database, Bot, Package, Download, Wrench, AlertTriangle, SlidersHorizontal, Building2, Layers, Plug, FileText} from "lucide-react"
import { TabsContent } from "@/components/ui/tabs"
import { Toggle } from "@/components/ui/toggle"
import { SectionTabs, type SectionTab } from "@/components/settings/section-tabs"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { AgentsSection } from "@/components/settings/agents-section"
import { ChannelsSection } from "@/components/settings/channels-section"
import { DingTalkIcon, FeishuIcon, WeComIcon } from "@/components/brand-icons"
import { ModelsSection } from "@/components/settings/models-section"
import { SearchToolsSection } from "@/components/settings/search-tools-section"
import { Logo } from "@/components/ui/logo"
import { AddSourceDialog } from "@/components/knowledge/add-source-dialog"
import { TopBar } from "@/components/layout/top-bar"
import { useSidebar } from "@/components/layout/sidebar-context"
import { useConfig } from "@/lib/config-context"
import { isAutoApiBaseUrl, resolveApiBaseUrl } from "@/lib/config"
import { sidecarPorts, sidecarPortsVersion, subscribeSidecarPorts } from "@/lib/sidecar-ports"
import { useI18n } from "@/lib/i18n-context"
import { isMacOS, isWindows } from "@/lib/platform"
import { useTheme } from "@/lib/theme-context"
import { useMCPServers } from "@/lib/use-mcp-servers"
import { useBrowserMCP } from "@/lib/use-browser-mcp"
import { useCliConnectors } from "@/lib/use-cli-connectors"
import { CopyButton } from "@/components/chat/copy-button"
import { useKnowledgeBase, type KBSource } from "@/lib/use-knowledge-base"
import { useSkills } from "@/lib/use-skills"
import { useSkillDeps, BUILTIN_DEP_MAP, PIP_HINTS, missingDeps, unavailableFeatures, type DepMap } from "@/lib/use-skill-deps"
import { useBuiltinShadow } from "@/lib/use-builtin-shadow"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { MCPStatus, MCPConfig } from "@agent/api-client"
import { openUrl } from "@tauri-apps/plugin-opener"
import { openExternal } from "@/lib/external-url"
import type { SkillSource, SkillItem } from "@/lib/use-skills"
import { APP_VERSION } from "@/lib/app-version"
import { OssLicensesView, LegalDocView, LegalEntryButton } from "@/components/settings/about-legal"

type SettingsSection = "general" | "models" | "privacy" | "capabilities" | "agents" | "services" | "tools" | "channels" | "knowledge" | "skills" | "about"

// Sub-tabs inside the Connectors (services) section — see CONNECTOR_TABS.
// The IDs are a runtime array (not just a type) because a deep-link carries a
// tab id as an untrusted string that has to be validated. Skills and Knowledge
// have no deep-link, so a bare union suffices there.
const CONNECTOR_TAB_IDS = ["mcp", "office-cli"] as const
type ConnectorTabId = (typeof CONNECTOR_TAB_IDS)[number]

// Sub-tabs inside the Skills section — see SKILL_TABS.
type SkillTabId = "builtin" | "installable" | "custom"

// Sub-tabs inside the Knowledge section — see KNOWLEDGE_TABS. Unlike the other
// two sections these tabs are overlapping subsets of ONE list ("all" contains
// every other tab's sources), which is why their panels must never forceMount.
type KnowledgeTabId = "all" | "local_folder" | "platform" | "custom_api"

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
      { key: "services", icon: Plug, labelKey: "settingsPage.services" },
      { key: "tools", icon: Wrench, labelKey: "settingsPage.tools" },
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
  const navState = location.state as { section?: SettingsSection; tab?: string } | null
  const sectionFromState = navState?.section
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
            {activeSection === "services" && <ServicesSection initialTab={navState?.tab} />}
            {activeSection === "tools" && <SearchToolsSection />}
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
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: "en", label: "English" },
            { value: "zh-Hans", label: "简体中文" },
            { value: "zh-Hant", label: "繁體中文" },
          ] as const).map((lang) => (
            <button
              key={lang.value}
              className={cn(
                "rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]",
                config.language === lang.value
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                  : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
              )}
              onClick={() => updateConfig({ language: lang.value })}
            >
              {lang.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">{t("general.language.description")}</p>
      </div>

      {/* Auto-reveal the side panel on the session's first task plan (ADR-048 D1).
          Every auto-behaviour needs a kill switch; turning this off leaves the
          manual toggle and the artifact badge working. */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="settings-planAutoReveal" className="text-sm font-medium text-[var(--color-fg)]">
            {t("settings.planAutoReveal")}
          </label>
          <Toggle
            id="settings-planAutoReveal"
            checked={config.planAutoReveal}
            onChange={(v) => updateConfig({ planAutoReveal: v })}
          />
        </div>
        <p className="text-xs text-[var(--color-fg-muted)]">{t("settings.planAutoRevealHint")}</p>
      </div>

      {/* Notifications (ADR-053). All three fire under the same condition: the window
          is unfocused, OR it is focused on a different session. */}
      <div className="space-y-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("settings.notify")}</h3>
          <p className="text-xs text-[var(--color-fg-muted)]">{t("settings.notifyHint")}</p>
        </div>
        {([
          { key: "notifySound", label: "settings.notifySound", hint: "settings.notifySoundHint" },
          { key: "notifySystem", label: "settings.notifySystem", hint: "settings.notifySystemHint" },
          { key: "notifyFlash", label: "settings.notifyFlash", hint: "settings.notifyFlashHint" },
        ] as const).map((row) => (
          <div key={row.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor={`settings-${row.key}`} className="text-sm font-medium text-[var(--color-fg)]">
                {t(row.label)}
              </label>
              <Toggle
                id={`settings-${row.key}`}
                checked={config[row.key]}
                onChange={(v) => updateConfig({ [row.key]: v })}
              />
            </div>
            <p className="text-xs text-[var(--color-fg-muted)]">{t(row.hint)}</p>
          </div>
        ))}
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

  // In auto mode the port is picked per launch, so the field shows where opencode
  // actually landed and is not editable. (Dev still routes through the Vite proxy —
  // `resolveApiBaseUrl` returns "" there — but the port shown is the real one.)
  // Subscribe rather than read once: a sidecar that loses a bind race moves, and a
  // read-only field showing a port nobody is listening on is worse than no field.
  useSyncExternalStore(subscribeSidecarPorts, sidecarPortsVersion)
  const autoApiBaseUrl = isAutoApiBaseUrl(formData.apiBaseUrl)
  const displayApiBaseUrl = `http://localhost:${sidecarPorts().opencode}`

  const handleSave = () => {
    updateConfig(formData)
  }

  const handleTestConnection = async () => {
    setTestingConnection(true)
    setConnectionStatus("idle")
    try {
      const url = `${resolveApiBaseUrl(formData.apiBaseUrl)}/global/health`
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
            value={autoApiBaseUrl ? displayApiBaseUrl : formData.apiBaseUrl}
            onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
            placeholder={t("connection.apiBaseUrl.placeholder")}
            readOnly={autoApiBaseUrl}
            aria-readonly={autoApiBaseUrl}
            className={`w-full rounded-md border border-[var(--color-border)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)] ${
              autoApiBaseUrl ? "cursor-default bg-[var(--color-bg-subtle)]" : "bg-[var(--color-bg)]"
            }`}
          />
          <p className="text-xs text-[var(--color-fg-muted)]">
            {autoApiBaseUrl ? t("connection.apiBaseUrl.auto") : t("connection.apiBaseUrl.description")}
          </p>
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

/** Connector-managed CLI deps: installed via 设置 → 连接器 → 办公 CLI, never via terminal. */
const CONNECTOR_MANAGED_DEPS = new Set(["lark-cli", "dws", "wecom-cli"])

/** Office CLI connectors rendered in the Office CLI group (mirrors Rust CLI_CONNECTORS). */
const OFFICE_CLI_CONNECTORS = [
  { id: "lark", titleKey: "cliConnector.lark.title", descKey: "cliConnector.lark.desc" },
  { id: "dingtalk", titleKey: "cliConnector.dingtalk.title", descKey: "cliConnector.dingtalk.desc" },
  { id: "wecom", titleKey: "cliConnector.wecom.title", descKey: "cliConnector.wecom.desc" },
] as const

/** Display-only brand icons per connector — presentation stays out of the Rust registry. */
const CLI_CONNECTOR_ICONS: Record<(typeof OFFICE_CLI_CONNECTORS)[number]["id"], ComponentType<{ className?: string }>> = {
  lark: FeishuIcon,
  dingtalk: DingTalkIcon,
  wecom: WeComIcon,
}

export function ServicesSection({ initialTab }: { initialTab?: string }) {
  const { t } = useI18n()
  const {
    statusMap, configMap, loading, error, actionLoading,
    handleToggle, handleAdd, handleRemove, refresh,
  } = useMCPServers()
  // One hook instance for every CLI connector card — a per-card instance
  // would fire duplicate probe processes on mount.
  const cliApi = useCliConnectors()
  const [addMode, setAddMode] = useState<"none" | "manual" | "json">("none")
  const [refreshing, setRefreshing] = useState(false)

  const entries = Object.entries(statusMap)
  const mcpConnectedCount = entries.filter(([, s]) => s.status === "connected").length
  const cliConnectedCount = Object.values(cliApi.statuses).filter((s) => s.state === "connected").length
  const connectedCount = mcpConnectedCount + cliConnectedCount

  // Data-driven tab registry — a future connector category (3rd/4th) is one
  // entry here plus a matching <TabsContent> block below; the header, the
  // combined count, and the global refresh above the tabs stay put.
  // Counts are ENTRY counts (configured servers / available CLIs), matching
  // Skills and Knowledge; the header badge owns the connection state.
  const CONNECTOR_TABS: readonly SectionTab<ConnectorTabId>[] = [
    { id: "mcp", labelKey: "services.groupMcp", icon: Server, count: entries.length },
    { id: "office-cli", labelKey: "services.groupOfficeCli", icon: Building2, count: OFFICE_CLI_CONNECTORS.length },
  ]
  const isTabId = (v: string | undefined): v is ConnectorTabId =>
    (CONNECTOR_TAB_IDS as readonly string[]).includes(v ?? "")
  const [tab, setTab] = useState<ConnectorTabId>(isTabId(initialTab) ? initialTab : "mcp")
  // A deep-link may retarget the sub-tab while ServicesSection is already
  // mounted (navigate to /settings with {section:"services", tab}). Fire only
  // when initialTab actually changes, so a manual tab click within one mount is
  // not overwritten on unrelated re-renders. (On a full remount the useState
  // initializer above re-reads initialTab, so returning to Connectors re-honors
  // the deep-link — intended stickiness, not a within-mount clobber.)
  useEffect(() => {
    if (initialTab && (CONNECTOR_TAB_IDS as readonly string[]).includes(initialTab)) {
      setTab(initialTab as ConnectorTabId)
    }
  }, [initialTab])

  const onRefresh = async () => {
    setRefreshing(true)
    // Both hooks feed the section (MCP list + combined connected count) —
    // refresh them together so neither renders off stale probe data.
    try { await Promise.all([refresh(), cliApi.refresh()]) } finally { setRefreshing(false) }
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
      {/* Header — global across all connector categories: title, combined
          connected count, and refresh (onRefresh reloads both MCP + CLI). */}
      <div className="flex items-start justify-between gap-3">
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
        <Button variant="outline" size="sm" className="shrink-0" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn("mr-1.5 size-3.5", refreshing && "animate-spin")} />
          {t("workspace.refresh")}
        </Button>
      </div>

      <SectionTabs tabs={CONNECTOR_TABS} value={tab} onValueChange={setTab}>
        {/* ── MCP ──
            forceMount: keep this panel mounted (hidden when inactive) so
            in-flight component-local state survives a tab switch — the browser
            MCP install progress (useBrowserMCP) and half-filled add-server /
            JSON-import forms would otherwise be destroyed on unmount and could
            let the user re-trigger a running install. The Office-CLI panel needs
            no forceMount (all its flow state lives in the hoisted cliApi hook). */}
        <TabsContent value="mcp" forceMount className="space-y-4 data-[state=inactive]:hidden">
          {/* Add-server toolbar (MCP-only action) */}
          <div className="flex items-center justify-end">
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
        </TabsContent>

        {/* ── Office CLI ── */}
        <TabsContent value="office-cli" className="space-y-3">
          <p className="text-xs text-[var(--color-fg-muted)]">{t("services.groupOfficeCliDesc")}</p>
          {OFFICE_CLI_CONNECTORS.map((c) => (
            <CliConnectorCard key={c.id} connector={c} api={cliApi} />
          ))}
        </TabsContent>
      </SectionTabs>
    </div>
  )
}

function CliConnectorCard({
  connector,
  api,
}: {
  connector: (typeof OFFICE_CLI_CONNECTORS)[number]
  api: ReturnType<typeof useCliConnectors>
}) {
  const { t } = useI18n()
  const { statuses, checking, phases, errors, pendingUrls, refresh, install, configure, authorize } = api
  const { id } = connector
  const BrandIcon = CLI_CONNECTOR_ICONS[id]
  const status = statuses[id]
  const phase = phases[id] ?? "idle"
  const flowError = errors[id] ?? null
  const pendingUrl = pendingUrls[id] ?? null
  const state = status?.state ?? "not_installed"
  const busy = phase !== "idle"

  if (checking) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] p-4">
        <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
        <p className="text-sm text-[var(--color-fg-muted)]">{t("cliConnector.checking")}</p>
      </div>
    )
  }

  const stateBadge = {
    not_installed: { label: t("cliConnector.notInstalled"), cls: "bg-[var(--color-accent)] text-[var(--color-fg-muted)]" },
    not_configured: { label: t("cliConnector.notConfigured"), cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    not_authorized: { label: t("cliConnector.notAuthorized"), cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    not_enabled: { label: t("cliConnector.notEnabled"), cls: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
    connected: { label: t("cliConnector.connected"), cls: "bg-green-500/10 text-green-600 dark:text-green-400" },
    error: { label: t("cliConnector.error"), cls: "bg-red-500/10 text-red-600 dark:text-red-400" },
  }[state]

  // Primary action per probed state (same lookup idiom as stateBadge above);
  // label switches to the in-flight variant. Hints are per-connector — the
  // flows differ (lark: hosted app page; dingtalk/wecom: no config step).
  const action = {
    not_installed: {
      label: phase === "installing" ? t("cliConnector.installing") : t("cliConnector.install"),
      run: () => install(id),
      hint: null as string | null,
    },
    not_configured: {
      label: phase === "configuring" ? t("cliConnector.configuring") : t("cliConnector.configure"),
      run: () => configure(id),
      hint: t(`cliConnector.${id}.configHint`),
    },
    not_authorized: {
      label: phase === "authorizing" ? t("cliConnector.authorizing") : t("cliConnector.authorize"),
      run: () => authorize(id),
      hint: t(`cliConnector.${id}.authHint`),
    },
    // Org admin hasn't enabled CLI access: authorize again after they flip
    // the switch (the banner below carries the guidance + console link).
    not_enabled: {
      label: phase === "authorizing" ? t("cliConnector.authorizing") : t("cliConnector.reauthorize"),
      run: () => authorize(id),
      hint: t("cliConnector.notEnabledHint"),
    },
    error: { label: t("cliConnector.retry"), run: () => refresh(id), hint: null },
    connected: null,
  }[state]

  return (
    <div className="rounded-lg border border-[var(--color-border)] p-4">
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className={cn(
            "mt-0.5 flex size-8 items-center justify-center rounded-lg",
            state === "connected" ? "bg-green-500/10" : state === "error" ? "bg-red-500/10" : "bg-blue-500/10",
          )}>
            <BrandIcon className="size-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-medium text-[var(--color-fg)]">{t(connector.titleKey)}</h3>
              <span className={cn("inline-flex items-center rounded-full px-2 py-px text-[10px] font-medium", stateBadge.cls)}>
                {state === "connected" && <CheckCircle2 className="mr-1 size-3" />}
                {stateBadge.label}
              </span>
              {status?.version && (
                <span className="text-[10px] text-[var(--color-fg-muted)] opacity-60">
                  {t("cliConnector.version", { version: status.version })}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{t(connector.descKey)}</p>
            {state === "connected" && status?.detail && (
              <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
                <CheckCircle2 className="size-3 text-green-500" />
                {status.detail}
              </p>
            )}
            {action?.hint && !busy && (
              <p className="mt-1 text-[10px] text-[var(--color-fg-muted)] opacity-80">{action.hint}</p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => refresh(id)}
            disabled={busy}
            title={t("cliConnector.refresh")}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          {/* Repair/upgrade path: install_office_cli is install-or-repair, but the
              primary action only offers it when not_installed — without this, an
              externally-installed stale CLI stuck in `error`, a missing dws skill
              tree ("重新点安装" per dingtalk-assistant), or a bumped pin on an
              existing install would have no UI way to reinstall the managed copy. */}
          {state !== "not_installed" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => install(id)}
              disabled={busy}
              title={t("cliConnector.reinstall")}
            >
              <Download className="size-3.5" />
            </Button>
          )}
          {action && (
            <Button size="sm" onClick={action.run} disabled={busy}>
              {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {action.label}
            </Button>
          )}
        </div>
      </div>

      {/* Waiting on the browser: surface the link for manual copy (remote/VM cases). */}
      {busy && pendingUrl && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          <ExternalLink className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={pendingUrl}>{t("cliConnector.openedBrowser")}</span>
          <CopyButton text={pendingUrl} label={t("cliConnector.copyLink")} iconClassName="size-3" />
        </div>
      )}

      {/* Vendor org hasn't enabled CLI access (dws): guided amber banner —
          who to ask (the CLI names the super admin) + admin-console deep link. */}
      {state === "not_enabled" && !busy && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            {status?.detail && <p className="whitespace-pre-line break-words">{status.detail}</p>}
          </div>
          {status?.action_url && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void openUrl(status.action_url!)}
            >
              <ExternalLink className="mr-1 size-3" />
              {t("cliConnector.openAdminConsole")}
            </Button>
          )}
        </div>
      )}

      {(flowError || (state === "error" && status?.detail)) && (
        <div className="mt-3 flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <AlertCircle className="size-3.5 shrink-0" />
          <span className="flex-1 break-all">{flowError || status?.detail}</span>
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

export function KnowledgeSection() {
  const { t } = useI18n()
  const {
    sources, loading, error, actionLoading,
    addFolder, removeSource, reindexSource, testConnection, refresh,
  } = useKnowledgeBase()
  const [refreshing, setRefreshing] = useState(false)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [tab, setTab] = useState<KnowledgeTabId>("all")

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

  // "platform" is a UI grouping, not a source type — it maps onto the `ima`
  // type. Every other tab id is the source type verbatim.
  const sourcesForTab = (id: KnowledgeTabId) =>
    id === "all"
      ? sources
      : id === "platform"
        ? sources.filter((s) => s.type === "ima")
        : sources.filter((s) => s.type === id)

  const KNOWLEDGE_TABS: readonly SectionTab<KnowledgeTabId>[] = [
    { id: "all", labelKey: "knowledge.filterAll", icon: Layers, count: sources.length },
    { id: "local_folder", labelKey: "knowledge.filterLocal", icon: FolderOpen, count: localCount },
    { id: "platform", labelKey: "knowledge.filterPlatform", icon: BookOpen, count: platformCount },
    { id: "custom_api", labelKey: "knowledge.filterApi", icon: Plug, count: apiCount },
  ]

  // One renderer for all four panels — they show the same card, over different
  // slices of the same list.
  const renderSources = (list: KBSource[]) =>
    list.length > 0 ? (
      <div className="space-y-3">
        {list.map((source) => (
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

      {/* Tabs: 全部 / 本地文件夹 / 第三方平台 / 自定义 API.
          NO forceMount here: a source in "local_folder" also lives in "all", so
          mounting both panels would render its card twice — two DOM nodes, two
          copies of KnowledgeSourceCard's indexing-progress timer. Nothing in a
          panel holds in-flight local state worth preserving across a switch. */}
      {!loading && !error && sources.length > 0 && (
        <SectionTabs tabs={KNOWLEDGE_TABS} value={tab} onValueChange={setTab}>
          {KNOWLEDGE_TABS.map((tabDef) => (
            <TabsContent key={tabDef.id} value={tabDef.id} className="space-y-3">
              {renderSources(sourcesForTab(tabDef.id))}
            </TabsContent>
          ))}
        </SectionTabs>
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

// Curated, permissively-licensed (Apache-2.0 / MIT) community skills the user
// can install on demand via the built-in skill-installer. Keep this list to
// known-good, non-proprietary sources only. `method: "git"` forces the install
// prompt to mandate `--method git` (sparse checkout) — skill-installer's auto
// mode downloads the whole repo zip first, which for huge repos (ppt-master's
// upstream ships ~580MB of examples) is hundreds of MB.
const INSTALLABLE_SKILLS: { name: string; descKey: string; repo: string; path: string; method?: "git" }[] = [
  { name: "mcp-builder", descKey: "skills.catalog.mcpBuilder", repo: "anthropics/skills", path: "skills/mcp-builder" },
  { name: "webapp-testing", descKey: "skills.catalog.webappTesting", repo: "anthropics/skills", path: "skills/webapp-testing" },
  { name: "frontend-design", descKey: "skills.catalog.frontendDesign", repo: "anthropics/skills", path: "skills/frontend-design" },
  { name: "algorithmic-art", descKey: "skills.catalog.algorithmicArt", repo: "anthropics/skills", path: "skills/algorithmic-art" },
  // ppt-master long-tail retreat: it was removed from the bundle in P3 (ADR-061 /
  // discussions/043 §18.5) now that deckcraft is the default deck skill, but stays
  // installable from here for its 1:1-beautify / template-pack niche. Installing it
  // registers a user skill under ~/.config/ultrawork/skills (no builtin copy to shadow).
  { name: "ppt-master", descKey: "skills.catalog.pptMaster", repo: "hugohe3/ppt-master", path: "skills/ppt-master", method: "git" },
]

function matchesQuery(name: string, description: string, q: string) {
  const s = q.toLowerCase()
  return name.toLowerCase().includes(s) || description.toLowerCase().includes(s)
}

export function SkillsSection() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const {
    allItems, loading, error, totalCount,
    skillsConfig, refresh, updateSkillsConfig,
  } = useSkills()
  const { deps, loading: depsLoading } = useSkillDeps()
  const { status: builtinStatus, reconcile, removeOverride } = useBuiltinShadow()
  const [searchQuery, setSearchQuery] = useState("")
  const [refreshing, setRefreshing] = useState(false)
  const [newPath, setNewPath] = useState("")
  const [newUrl, setNewUrl] = useState("")
  const [tab, setTab] = useState<SkillTabId>("builtin")
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  // Coordination (hook contract): a reconcile that mutated disk (`changed`)
  // leaves opencode's skill cache stale — follow with a soft refresh + refetch
  // exactly once per status object, or the tabs show both copies / a live
  // skill whose files are gone (e.g. mount reconcile pruning after an
  // in-session skill-installer run).
  const handledStatusRef = useRef<unknown>(null)
  useEffect(() => {
    if (builtinStatus.changed && handledStatusRef.current !== builtinStatus) {
      handledStatusRef.current = builtinStatus
      refresh()
    }
  }, [builtinStatus, refresh])

  const onRefresh = async () => {
    setRefreshing(true)
    try {
      // Reconcile FIRST so the shadow status and the list update together —
      // otherwise a mid-session install leaves a pruned builtin with no shadow
      // card (or a stale card after an external user-copy delete).
      handledStatusRef.current = await reconcile()
      await refresh()
    } finally { setRefreshing(false) }
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
  // Builtin skills currently overridden by a user install (fs truth from Rust):
  // their builtin disk copy is pruned, so they surface in customItems — the
  // builtin tab shows an explanatory shadow card with a restore action instead.
  const shadowedNames = builtinStatus.shadowed
    .filter((n) => !q || matchesQuery(n, t("skills.shadowedDetail", { name: n }), q))
  // "Installed" for the catalog means a USER copy exists — a builtin twin does
  // not count (the catalog entry is exactly the builtin's self-update channel).
  const userInstalledNames = new Set(allItems.filter((i) => !i.builtin).map((i) => i.name))
  const catalogItems = INSTALLABLE_SKILLS
    .filter((s) => !q || matchesQuery(s.name, t(s.descKey), q))

  // Install a curated skill by handing the request to the built-in skill-installer
  // in a fresh chat (avoids reimplementing git/auth in the shell).
  const handleInstall = (s: { name: string; repo: string; path: string; method?: "git" }) => {
    const key = s.method === "git" ? "skills.installPromptGit" : "skills.installPrompt"
    const prompt = t(key, { name: s.name, repo: s.repo, path: s.path })
    navigate("/", { state: { initialInput: prompt } })
  }

  // Remove the user override of a builtin skill and restore the bundled copy;
  // soft-refresh (ADR-039) so the restored skill is live without a restart.
  const handleRestoreBuiltin = async () => {
    if (!restoreTarget) return
    setRestoring(true)
    try {
      handledStatusRef.current = await removeOverride(restoreTarget)
      await refresh()
      toast.success(t("skills.restoreDone"))
      setRestoreTarget(null)
    } catch (err) {
      console.error("restore builtin skill failed:", err)
      toast.error(t("skills.restoreFailed"))
      // The Rust command may have mutated disk BEFORE erroring (e.g. a stale
      // card: its pre-check reconcile restores the builtin, then rejects the
      // override removal — the `changed` info dies with the Err). Resync the
      // status AND unconditionally refresh the list; the follow-up reconcile
      // alone can report changed:false against already-steady disk.
      reconcile()
        .then(async (s) => {
          handledStatusRef.current = s
          await refresh()
        })
        .catch(() => {})
    } finally {
      setRestoring(false)
    }
  }

  // Missing skill dependencies: hand off to the AI in a fresh chat, which detects the
  // OS and walks the user through platform-appropriate installs (same pattern as install).
  // Office-CLI binaries are the exception: the connector card installs them (pinned
  // version + sha256), so the generic terminal walkthrough (whose convergence criterion
  // is python/pptx-specific anyway) would both mislead and produce an unpinned copy —
  // send a prompt that routes the user to the connector card instead.
  const handleDepGuide = (item: SkillItem, missing: string[]) => {
    const promptKey = missing.every((d) => CONNECTOR_MANAGED_DEPS.has(d))
      ? "skills.depGuidePromptCli"
      : "skills.depGuidePrompt"
    const prompt = t(promptKey, {
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

  const SKILL_TABS: readonly SectionTab<SkillTabId>[] = [
    { id: "builtin", labelKey: "skills.zone.builtin", icon: Package, count: builtinItems.length + shadowedNames.length },
    { id: "installable", labelKey: "skills.zone.installable", icon: Download, count: catalogItems.length },
    { id: "custom", labelKey: "skills.zone.custom", icon: Wrench, count: customItems.length },
  ]

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

      {/* Tabs: 内置 / 推荐安装 / 自定义.
          Counts reflect the active search filter (the search box sits above the
          tabs and narrows every category at once) — a zero tells the user the
          query missed that category, not that the category is empty.
          No forceMount: every panel's state lives in hoisted hooks, and the
          install action navigates away from the page entirely. */}
      {!loading && !error && totalCount > 0 && (
        <SectionTabs tabs={SKILL_TABS} value={tab} onValueChange={setTab}>
          {/* 内置 */}
          <TabsContent value="builtin" className="space-y-2">
            <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.zone.builtinNote")}</p>
            {shadowedNames.map((name) => (
              <ShadowedSkillCard key={name} name={name} onRestore={() => setRestoreTarget(name)} />
            ))}
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
              : shadowedNames.length === 0 && tabEmptyHint}
          </TabsContent>

          {/* 推荐安装 */}
          <TabsContent value="installable" className="space-y-2">
            <p className="text-xs text-[var(--color-fg-muted)]">{t("skills.zone.installableNote")}</p>
            {catalogItems.length > 0
              ? catalogItems.map((s) => {
                  const installed = userInstalledNames.has(s.name)
                  const builtinBacked = builtinStatus.bundled.includes(s.name)
                  return (
                    <div key={s.name} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
                      <div className="flex items-start gap-3">
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-[var(--color-fg)]">{s.name}</span>
                            <button
                              type="button"
                              title={`https://github.com/${s.repo}/tree/main/${s.path}`}
                              onClick={() => openExternal(`https://github.com/${s.repo}/tree/main/${s.path}`)}
                              className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                            >
                              <ExternalLink className="size-3" />
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t(s.descKey)}</p>
                          {builtinBacked && !installed && (
                            <p className="mt-1 text-[10px] text-[var(--color-fg-muted)]">{t("skills.builtinUpdateHint")}</p>
                          )}
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
              // A user skill that shadows a builtin (name in BUILTIN_DEP_MAP)
              // runs on the same external tools — keep the readiness badge and
              // the guided install visible where the raw-upstream copy lives.
              customItems.map((item) => (
                <SettingsSkillCard
                  key={item.name}
                  item={item}
                  depBadge={
                    BUILTIN_DEP_MAP[item.name] ? (
                      <DepBadge
                        skillName={item.name}
                        deps={deps}
                        loading={depsLoading}
                        onGuide={(missing) => handleDepGuide(item, missing)}
                      />
                    ) : undefined
                  }
                />
              ))
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
        </SectionTabs>
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

      {/* 恢复内置 confirm: deleting the user override is destructive */}
      <Dialog open={restoreTarget !== null} onOpenChange={(open) => { if (!open && !restoring) setRestoreTarget(null) }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("skills.restoreConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("skills.restoreConfirmBody", { name: restoreTarget ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(null)} disabled={restoring}>
              {t("button.cancel")}
            </Button>
            <Button size="sm" onClick={handleRestoreBuiltin} disabled={restoring}>
              {restoring && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              {t("skills.restoreBuiltin")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Builtin-tab placeholder for a builtin skill whose disk copy is pruned because
 *  a user-installed same-name skill overrides it (the user copy itself shows in
 *  the custom tab). Explains the permanent-shadow rule and offers the restore. */
function ShadowedSkillCard({ name, onRestore }: { name: string; onRestore: () => void }) {
  const { t } = useI18n()
  return (
    <div className="rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-start gap-3">
        <Package className="mt-0.5 size-4 shrink-0 text-[var(--color-fg-muted)]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-fg)]">/{name}</span>
            <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3" />
              {t("skills.shadowedBadge")}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{t("skills.shadowedDetail", { name })}</p>
        </div>
        <Button variant="outline" size="sm" className="shrink-0" onClick={onRestore}>
          <RefreshCw className="mr-1 size-3.5" />
          {t("skills.restoreBuiltin")}
        </Button>
      </div>
    </div>
  )
}

// Install-guidance hints shown when a dependency is missing (per host platform).
const DEP_HINTS: Record<string, string> = isWindows
  ? {
      ...PIP_HINTS,
      python3: "winget install Python.Python.3.12 / python.org",
      "python3.10+": "winget install Python.Python.3.12 / python.org",
      node: "winget install OpenJS.NodeJS.LTS / nodejs.org",
      pandoc: "winget install JohnMacFarlane.Pandoc",
      soffice: "LibreOffice",
      pdftoppm: "scoop/choco install poppler",
      git: "winget install Git.Git / git-scm.com",
      "markdown-exporter": "pip install md-exporter",
      "lark-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
      dws: "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
      "wecom-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
      "chrome-or-edge": "winget install Google.Chrome / google.com/chrome（已装 Edge 亦可）",
    }
  : isMacOS
    ? {
        ...PIP_HINTS,
        python3: "brew install python / python.org",
        "python3.10+": "brew install python / python.org (>= 3.10)",
        node: "brew install node / nodejs.org",
        pandoc: "brew install pandoc",
        soffice: "LibreOffice",
        pdftoppm: "brew install poppler",
        git: "brew install git / git-scm.com",
        "markdown-exporter": "pip install md-exporter",
        "lark-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        dws: "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        "wecom-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        "chrome-or-edge": "brew install --cask google-chrome / google.com/chrome",
      }
    : {
        ...PIP_HINTS,
        python3: "apt/dnf install python3",
        "python3.10+": "apt/dnf install python3 (>= 3.10)",
        node: "apt/dnf install nodejs / nodejs.org",
        pandoc: "apt/dnf install pandoc",
        soffice: "LibreOffice (apt install libreoffice)",
        pdftoppm: "apt/dnf install poppler-utils",
        git: "apt/dnf install git",
        "markdown-exporter": "pip install md-exporter",
        "lark-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        dws: "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        "wecom-cli": "设置 → 连接器 → 办公 CLI / Settings → Connectors → Office CLI",
        "chrome-or-edge": "apt/dnf install google-chrome-stable / chromium",
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
  // Optional deps never gate readiness, but staying silent about them is how a user
  // finds out that "make a deck from this PDF" does nothing — by trying it. Named
  // as the capability, not the package: `curl_cffi` means nothing, "URL" does.
  const partial = unavailableFeatures(skillName, deps)
  const partialChip = partial.length ? (
    <span
      title={`${t("skills.depPartialHint")}: ${partial
        .map((g) => `${g.label} — ${g.missing.map((m) => DEP_HINTS[m] ?? m).join(", ")}`)
        .join("; ")}`}
      // NOT shrink-0, unlike the verdict chip beside it. Measured at 700px: seven
      // groups make this 300px wide and it pushed 72px of content out of the row
      // (0px without it — the control says this one is mine, not the pre-existing
      // narrow-width defect). The verdict must never be squeezed; this is extra
      // information and gives way first, with the full list one hover away.
      className="inline-flex min-w-0 cursor-help items-center gap-1 truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-fg-muted)]"
    >
      {t("skills.depPartial")}: {partial.map((g) => g.label).join(", ")}
    </span>
  ) : null
  if (missing.length === 0) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-green-600 dark:text-green-400">
          <CheckCircle2 className="size-3" />
          {t("skills.depReady")}
        </span>
        {partialChip}
      </span>
    )
  }
  // Append the actually-probed binary path when the probe reported one — makes
  // "installed but still missing" self-explanatory (wrong interpreter resolved).
  const hint = missing
    .map((m) => (DEP_HINTS[m] ?? m) + (deps[m]?.path ? ` [${deps[m].path}]` : ""))
    .join("; ")
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span
        title={`${t("skills.depMissingHint")}: ${hint}`}
        className="inline-flex shrink-0 cursor-help items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400"
      >
        <AlertTriangle className="size-3" />
        {t("skills.depMissing")}: {missing.join(", ")}
      </span>
      {partialChip}
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
  // About root vs. one of the three legal/compliance sub-views (独立整页, ADR/047).
  const [view, setView] = useState<"root" | "oss" | "eula" | "privacy">("root")

  const LINKS = [
    { icon: Globe, labelKey: "about.website", href: "https://ultrawork.ai" },
    { icon: MessageSquare, labelKey: "about.feedback", href: "https://github.com/anthropics/ultrawork/issues" },
  ]

  // Compliance entries (mirror the reference product's About footer row).
  const LEGAL_ENTRIES = [
    { key: "oss" as const, icon: Package, labelKey: "about.legal.thirdParty" },
    { key: "eula" as const, icon: FileText, labelKey: "about.legal.terms" },
    { key: "privacy" as const, icon: Shield, labelKey: "about.legal.privacy" },
  ]

  if (view === "oss") return <OssLicensesView onBack={() => setView("root")} />
  if (view === "eula") return <LegalDocView doc="eula" onBack={() => setView("root")} />
  if (view === "privacy") return <LegalDocView doc="privacy" onBack={() => setView("root")} />

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
          <div className="mt-1 font-mono text-sm font-medium text-[var(--color-fg)]">{APP_VERSION}</div>
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
        <InfoRow label={t("about.opencode")} value={`localhost:${sidecarPorts().opencode}`} />
      </div>

      {/* Bottom action row — website, feedback + the three compliance views, all
          in ONE row (mirrors the reference product's About footer). External
          links carry a ↗ glyph; the in-app views carry a › chevron. */}
      <div className="flex flex-wrap gap-2">
        {LINKS.map((link) => (
          <button
            key={link.labelKey}
            type="button"
            title={link.href}
            onClick={() => openExternal(link.href)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-1.5 text-xs text-[var(--color-fg)] transition-colors hover:bg-[var(--color-accent)]"
          >
            <link.icon className="size-3.5" />
            {t(link.labelKey)}
            <ExternalLink className="size-3 text-[var(--color-fg-muted)]" />
          </button>
        ))}
        {LEGAL_ENTRIES.map((e) => (
          <LegalEntryButton key={e.key} icon={e.icon} label={t(e.labelKey)} onClick={() => setView(e.key)} />
        ))}
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-[var(--color-fg-muted)]">
        {t("about.poweredBy")}
      </p>
      <p className="text-center text-[10px] text-[var(--color-fg-muted)] opacity-70">
        {t("about.trademarks")}
      </p>
    </div>
  )
}

function InfoRow({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-[var(--color-fg-muted)]">{label}</span>
      {href ? (
        <button
          type="button"
          title={href}
          onClick={() => openExternal(href)}
          className="inline-flex items-center gap-1 text-sm text-[var(--color-fg)] hover:text-[var(--color-primary)]"
        >
          {value}
          <ExternalLink className="size-3" />
        </button>
      ) : (
        <span className="text-sm text-[var(--color-fg)]">{value}</span>
      )}
    </div>
  )
}
