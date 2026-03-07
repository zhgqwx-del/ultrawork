import { useState, useEffect } from "react"
import { useConfig } from "@/lib/config-context"
import { DEFAULT_CONFIG } from "@/lib/config"
import { useI18n } from "@/lib/i18n-context"
import { useTheme } from "@/lib/theme-context"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { CheckCircle2, XCircle, Loader2 } from "lucide-react"

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { config, updateConfig, resetConfig } = useConfig()
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const [formData, setFormData] = useState(config)
  const [activeTab, setActiveTab] = useState("connection")
  const [testingConnection, setTestingConnection] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "success" | "error">("idle")
  const [connectionMessage, setConnectionMessage] = useState("")

  // Sync formData when dialog opens
  useEffect(() => {
    if (open) {
      // Reset form data to current config when dialog opens
      setFormData(config)
      setConnectionStatus("idle")
      setConnectionMessage("")
    }
  }, [open, config])

  const handleSave = () => {
    updateConfig(formData)
    onOpenChange(false)
  }

  const handleReset = () => {
    resetConfig()
    setFormData(DEFAULT_CONFIG)
  }

  const handleCancel = () => {
    setFormData(config)
    onOpenChange(false)
  }

  const handleTestConnection = async () => {
    setTestingConnection(true)
    setConnectionStatus("idle")
    setConnectionMessage("")

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
        setConnectionMessage(`${t("connection.failed")}: ${response.status} ${response.statusText}`)
      }
    } catch (error) {
      setConnectionStatus("error")
      setConnectionMessage(`${t("connection.failed")}: ${error instanceof Error ? error.message : t("common.error")}`)
    } finally {
      setTestingConnection(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>{t("settings.title")}</DialogTitle>
          <DialogDescription>
            {t("settings.description")}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="connection">{t("settings.connection")}</TabsTrigger>
            <TabsTrigger value="general">{t("settings.general")}</TabsTrigger>
            <TabsTrigger value="about">{t("settings.about")}</TabsTrigger>
          </TabsList>

          {/* Connection Tab */}
          <TabsContent value="connection" className="space-y-4">
            <div className="space-y-4 py-4">
              {/* API Base URL */}
              <div className="space-y-2">
                <label htmlFor="apiBaseUrl" className="text-sm font-medium text-[var(--color-fg)]">
                  {t("connection.apiBaseUrl")}
                </label>
                <input
                  id="apiBaseUrl"
                  type="text"
                  value={formData.apiBaseUrl}
                  onChange={(e) => setFormData({ ...formData, apiBaseUrl: e.target.value })}
                  placeholder={t("connection.apiBaseUrl.placeholder")}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                />
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("connection.apiBaseUrl.description")}
                </p>
              </div>

              {/* API Username */}
              <div className="space-y-2">
                <label htmlFor="apiUsername" className="text-sm font-medium text-[var(--color-fg)]">
                  {t("connection.username")}
                </label>
                <input
                  id="apiUsername"
                  type="text"
                  value={formData.apiUsername || ""}
                  onChange={(e) => setFormData({ ...formData, apiUsername: e.target.value })}
                  placeholder={t("connection.username.placeholder")}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                />
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("connection.username.description")}
                </p>
              </div>

              {/* API Password */}
              <div className="space-y-2">
                <label htmlFor="apiPassword" className="text-sm font-medium text-[var(--color-fg)]">
                  {t("connection.password")}
                </label>
                <input
                  id="apiPassword"
                  type="password"
                  value={formData.apiPassword}
                  onChange={(e) => setFormData({ ...formData, apiPassword: e.target.value })}
                  placeholder={t("connection.password.placeholder")}
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                />
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("connection.password.description")}
                </p>
              </div>

              {/* Test Connection */}
              <div className="space-y-2">
                <Button
                  variant="outline"
                  onClick={handleTestConnection}
                  disabled={testingConnection}
                  className="w-full"
                >
                  {testingConnection && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {testingConnection ? t("connection.testing") : t("connection.testConnection")}
                </Button>

                {connectionStatus !== "idle" && (
                  <div
                    className={`flex items-center gap-2 rounded-md p-3 text-sm ${
                      connectionStatus === "success"
                        ? "bg-green-500/10 text-green-600 dark:text-green-400"
                        : "bg-red-500/10 text-red-600 dark:text-red-400"
                    }`}
                  >
                    {connectionStatus === "success" ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <XCircle className="h-4 w-4" />
                    )}
                    <span>{connectionMessage}</span>
                  </div>
                )}
              </div>
            </div>
          </TabsContent>

          {/* General Tab */}
          <TabsContent value="general" className="space-y-4">
            <div className="space-y-4 py-4">
              {/* Theme */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--color-fg)]">
                  {t("general.theme")}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  <button
                    className={`rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)] ${
                      theme === "light"
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
                    }`}
                    onClick={() => setTheme("light")}
                  >
                    {t("general.theme.light")}
                  </button>
                  <button
                    className={`rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)] ${
                      theme === "dark"
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
                    }`}
                    onClick={() => setTheme("dark")}
                  >
                    {t("general.theme.dark")}
                  </button>
                  <button
                    className={`rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)] ${
                      theme === "system"
                        ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                        : "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-fg)] hover:bg-[var(--color-accent)]"
                    }`}
                    onClick={() => setTheme("system")}
                  >
                    {t("general.theme.system")}
                  </button>
                </div>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("general.theme.description")}
                </p>
              </div>

              {/* Language */}
              <div className="space-y-2">
                <label className="text-sm font-medium text-[var(--color-fg)]">
                  {t("general.language")}
                </label>
                <select
                  className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                  value={formData.language}
                  onChange={(e) => setFormData({ ...formData, language: e.target.value as "en" | "zh" })}
                >
                  <option value="en">English</option>
                  <option value="zh">简体中文</option>
                </select>
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("general.language.description")}
                </p>
              </div>
            </div>
          </TabsContent>

          {/* About Tab */}
          <TabsContent value="about" className="space-y-4">
            <div className="space-y-4 py-4">
              {/* App Info */}
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
                  <span className="text-sm font-medium text-[var(--color-fg)]">{t("about.version")}</span>
                  <span className="text-sm text-[var(--color-fg-muted)]">0.1.0</span>
                </div>

                <div className="flex items-center justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
                  <span className="text-sm font-medium text-[var(--color-fg)]">{t("about.opencode")}</span>
                  <span className="text-sm text-[var(--color-fg-muted)]">{formData.apiBaseUrl}</span>
                </div>
              </div>

              {/* Links */}
              <div className="space-y-2">
                <div className="space-y-2">
                  <a
                    href="https://github.com/anomalyco/opencode"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                  >
                    {t("about.github")}
                  </a>
                  <a
                    href="https://opencode.ai/docs/zh-cn/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
                  >
                    {t("about.documentation")}
                  </a>
                </div>
              </div>

              {/* Copyright */}
              <div className="pt-4 text-center">
                <p className="text-xs text-[var(--color-fg-muted)]">
                  {t("about.copyright")}
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* Footer Actions */}
        <div className="flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-4">
          <Button variant="outline" onClick={handleReset}>
            {t("button.reset")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleCancel}>
              {t("button.cancel")}
            </Button>
            <Button onClick={handleSave}>
              {t("button.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
