import { useState, useEffect } from "react"
import { useNavigate } from "react-router-dom"
import { Settings, Shield, Cpu, CheckCircle2, XCircle, Loader2 } from "lucide-react"
import { TopBar } from "@/components/layout/top-bar"
import { useConfig } from "@/lib/config-context"
import { useI18n } from "@/lib/i18n-context"
import { useTheme } from "@/lib/theme-context"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type SettingsSection = "general" | "privacy" | "capabilities"

const NAV_ITEMS: { key: SettingsSection; icon: typeof Settings; labelKey: string }[] = [
  { key: "general", icon: Settings, labelKey: "settingsPage.general" },
  { key: "privacy", icon: Shield, labelKey: "settingsPage.privacy" },
  { key: "capabilities", icon: Cpu, labelKey: "settingsPage.capabilities" },
]

export function SettingsPage() {
  const navigate = useNavigate()
  const [activeSection, setActiveSection] = useState<SettingsSection>("general")
  const { t } = useI18n()

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TopBar title={t("settingsPage.title")} onClose={() => navigate("/")} />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left nav */}
        <nav className="flex w-56 shrink-0 flex-col gap-1 border-r border-[--color-border] p-3">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.key}
              onClick={() => setActiveSection(item.key)}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                activeSection === item.key
                  ? "bg-[--color-accent] font-medium text-[--color-fg]"
                  : "text-[--color-fg-muted] hover:bg-[--color-accent] hover:text-[--color-fg]"
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
      <h2 className="text-lg font-semibold text-[--color-fg]">{t("settingsPage.general")}</h2>

      {/* Theme */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[--color-fg]">{t("general.theme")}</label>
        <div className="grid grid-cols-3 gap-2">
          {(["light", "dark", "system"] as const).map((v) => (
            <button
              key={v}
              className={cn(
                "rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[--color-ring]",
                theme === v
                  ? "border-[--color-primary] bg-[--color-primary]/10 text-[--color-primary]"
                  : "border-[--color-border] bg-[--color-bg] text-[--color-fg] hover:bg-[--color-accent]"
              )}
              onClick={() => setTheme(v)}
            >
              {t(`general.theme.${v}`)}
            </button>
          ))}
        </div>
        <p className="text-xs text-[--color-fg-muted]">{t("general.theme.description")}</p>
      </div>

      {/* Language */}
      <div className="space-y-2">
        <label className="text-sm font-medium text-[--color-fg]">{t("general.language")}</label>
        <select
          className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
          value={config.language}
          onChange={(e) => updateConfig({ language: e.target.value as "en" | "zh" })}
        >
          <option value="en">English</option>
          <option value="zh">简体中文</option>
        </select>
        <p className="text-xs text-[--color-fg-muted]">{t("general.language.description")}</p>
      </div>
    </div>
  )
}

function PrivacySection() {
  const { t } = useI18n()

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-[--color-fg]">{t("settingsPage.privacy.title")}</h2>
      <p className="text-sm text-[--color-fg-muted]">{t("settingsPage.privacy.desc")}</p>
      <div className="rounded-lg border border-[--color-border] bg-[--color-bg-subtle] p-6 text-center text-sm text-[--color-fg-muted]">
        More privacy settings coming soon.
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
      const url = `${formData.apiBaseUrl}/api/health`
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
      <h2 className="text-lg font-semibold text-[--color-fg]">{t("settingsPage.capabilities.title")}</h2>

      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-[--color-fg]">{t("connection.apiBaseUrl")}</label>
          <input
            type="text"
            value={formData.apiBaseUrl}
            onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
            placeholder={t("connection.apiBaseUrl.placeholder")}
            className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[--color-fg]">{t("connection.username")}</label>
          <input
            type="text"
            value={formData.apiUsername || ""}
            onChange={(e) => setFormData({ ...formData, apiUsername: e.target.value })}
            placeholder={t("connection.username.placeholder")}
            className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
          />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-[--color-fg]">{t("connection.password")}</label>
          <input
            type="password"
            value={formData.apiPassword}
            onChange={(e) => setFormData({ ...formData, apiPassword: e.target.value })}
            placeholder={t("connection.password.placeholder")}
            className="w-full rounded-md border border-[--color-border] bg-[--color-bg] px-3 py-2 text-sm text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none focus:ring-2 focus:ring-[--color-ring]"
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
