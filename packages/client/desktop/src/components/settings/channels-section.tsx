/**
 * Settings → 消息渠道 section. Moved verbatim out of pages/Settings.tsx
 * (ChannelsSection + ChannelCard + ChannelAddForm + WeChatQRLogin) with brand
 * icons added; QR flow/state machine untouched.
 */
import { useState, useEffect, useMemo, type ComponentType } from "react"
import { AlertCircle, CheckCircle2, ChevronDown, Loader2, Plus, Radio, RefreshCw, Smartphone, X } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DingTalkIcon, WeChatIcon } from "@/components/brand-icons"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"
import { useChannels } from "@/lib/use-channels"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import type { ChannelStatus, ChannelConfig, DingTalkChannelConfig } from "@agent/api-client"

/** Brand icon per channel type. New channel types (feishu/wecom, discussion
 * 028 B2/B3) must land here together with their `channel.type.*` i18n keys —
 * the badge below renders the raw key if either half is missing. */
const CHANNEL_TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  wechat: WeChatIcon,
  dingtalk: DingTalkIcon,
}

export function ChannelsSection() {
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
                <DingTalkIcon className="mr-2 size-4" />
                {t("channel.type.dingtalk")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowAdd("wechat")}>
                <WeChatIcon className="mr-2 size-4" />
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
            <WeChatIcon className="mr-1.5 size-3.5" />
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
  const BrandIcon = CHANNEL_TYPE_ICONS[channel.type]

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
            {BrandIcon && <BrandIcon className="size-5" />}
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
        <div className="flex items-center gap-2">
          <DingTalkIcon className="size-4" />
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.addChannel")} — {t("channel.type.dingtalk")}</h3>
        </div>
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
        <div className="flex items-center gap-2">
          <WeChatIcon className="size-4" />
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.wechat.scanQR")}</h3>
        </div>
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
