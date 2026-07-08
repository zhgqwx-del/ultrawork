/**
 * Settings → 消息渠道 section. Moved verbatim out of pages/Settings.tsx
 * (ChannelsSection + ChannelCard + ChannelAddForm + WeChatQRLogin) with brand
 * icons added; QR flow/state machine untouched.
 */
import { useState, useEffect, useMemo, type ComponentType } from "react"
import { AlertCircle, CheckCircle2, ChevronDown, ExternalLink, KeyRound, Loader2, Plus, Radio, RefreshCw, Smartphone, X } from "lucide-react"
import { QRCodeSVG } from "qrcode.react"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DingTalkIcon, WeChatIcon, WeComIcon } from "@/components/brand-icons"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"
import { useChannels } from "@/lib/use-channels"
import { useWorkspace } from "@/lib/workspace-context"
import { cn } from "@/lib/utils"
import type { ChannelStatus, ChannelConfig } from "@agent/api-client"

/** Brand icon per channel type. New channel types (feishu/wecom, discussion
 * 028 B2/B3) must land here together with their `channel.type.*` i18n keys —
 * the badge below renders the raw key if either half is missing. */
const CHANNEL_TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  wechat: WeChatIcon,
  dingtalk: DingTalkIcon,
  wecom: WeComIcon,
}

/** Channel types whose QR flow has a credentials-form fallback (device flows). */
type ManualFormType = "dingtalk" | "wecom"

/** Field sets for the manual credentials form, per channel type. */
const MANUAL_FORM_FIELDS: Record<ManualFormType, { key: string; labelKey: string; placeholderKey: string; password?: boolean }[]> = {
  dingtalk: [
    { key: "clientId", labelKey: "channel.clientId", placeholderKey: "channel.clientIdPlaceholder" },
    { key: "clientSecret", labelKey: "channel.clientSecret", placeholderKey: "channel.clientSecretPlaceholder", password: true },
  ],
  wecom: [
    { key: "botId", labelKey: "channel.botId", placeholderKey: "channel.botIdPlaceholder" },
    { key: "secret", labelKey: "channel.secret", placeholderKey: "channel.secretPlaceholder", password: true },
  ],
}

export function ChannelsSection() {
  const { t } = useI18n()
  const {
    channels, configs, loading, error, actionLoading,
    handleAdd, handleRemove, handleConnect, handleDisconnect, refresh,
    requestChannelQR, pollChannelQRStatus, cancelChannelQR,
  } = useChannels()
  // Plain type opens the QR flow; "<type>-manual" is the credentials-form
  // fallback (mirrors the device-flow manual path).
  const [showAdd, setShowAdd] = useState<false | "dingtalk" | "dingtalk-manual" | "wechat" | "wecom" | "wecom-manual">(false)
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

  const onQRDone = () => {
    setShowAdd(false)
    // Auto-connect runs in the background after addChannel resolves (the
    // adapter reports "connecting" until its first poll/handshake succeeds).
    // One refresh would catch the "connecting" snapshot and the UI would stay
    // stale. Schedule a few more refreshes to catch the state flip whenever
    // it lands (typically within ~10s on a healthy link).
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
              <DropdownMenuItem onClick={() => setShowAdd("wecom")}>
                <WeComIcon className="mr-2 size-4" />
                {t("channel.type.wecom")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Manual credentials form (fallback from the device-flow QR) */}
      {(showAdd === "dingtalk-manual" || showAdd === "wecom-manual") && (
        <ChannelAddForm
          type={showAdd === "dingtalk-manual" ? "dingtalk" : "wecom"}
          onAdd={onAdd}
          onCancel={() => setShowAdd(false)}
          loading={actionLoading === "__add__"}
        />
      )}

      {/* QR login (wechat / dingtalk / wecom) */}
      {(showAdd === "wechat" || showAdd === "dingtalk" || showAdd === "wecom") && (
        <ChannelQRLogin
          type={showAdd}
          onDone={onQRDone}
          onCancel={() => setShowAdd(false)}
          onManualInput={
            showAdd === "wechat"
              ? undefined
              : (() => { const flow = `${showAdd}-manual` as "dingtalk-manual" | "wecom-manual"; return () => setShowAdd(flow) })()
          }
          requestQR={(type, name, workspaceDir) => requestChannelQR(type, name, workspaceDir)}
          pollStatus={pollChannelQRStatus}
          cancelQR={cancelChannelQR}
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
  type,
  onAdd,
  onCancel,
  loading,
}: {
  type: ManualFormType
  onAdd: (config: Omit<ChannelConfig, "id">) => Promise<void>
  onCancel: () => void
  loading: boolean
}) {
  const { t } = useI18n()
  const { workspacePath } = useWorkspace()
  const fields = MANUAL_FORM_FIELDS[type]
  const BrandIcon = CHANNEL_TYPE_ICONS[type]
  const [name, setName] = useState("")
  const [values, setValues] = useState<Record<string, string>>({})
  const [autoConnect, setAutoConnect] = useState(true)

  const canSubmit = name.trim() && fields.every((f) => values[f.key]?.trim())

  const handleSubmit = () => {
    if (!canSubmit) return
    const credentials = Object.fromEntries(fields.map((f) => [f.key, values[f.key].trim()]))
    onAdd({
      type,
      name: name.trim(),
      ...credentials,
      workspaceDir: workspacePath!,
      autoConnect,
    } as unknown as Omit<ChannelConfig, "id">)
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {BrandIcon && <BrandIcon className="size-4" />}
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.addChannel")} — {t(`channel.type.${type}`)}</h3>
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

        {fields.map((field) => (
          <div key={field.key} className="space-y-2">
            <label className="text-sm font-medium text-[var(--color-fg)]">{t(field.labelKey)}</label>
            <input
              type={field.password ? "password" : "text"}
              value={values[field.key] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
              placeholder={t(field.placeholderKey)}
              className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-ring)]"
            />
          </div>
        ))}

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

/** QR login flow component (wechat / dingtalk / future providers).
 * States come from the gateway's cached QR session snapshot (qr-registry.ts):
 * pending → scanned → authorized, or expired/denied/error. The gateway does
 * the upstream polling; this component only reads the cache. */
function ChannelQRLogin({
  type,
  onDone,
  onCancel,
  onManualInput,
  requestQR,
  pollStatus,
  cancelQR,
  existingChannels,
}: {
  type: "wechat" | "dingtalk" | "wecom"
  onDone: () => void
  onCancel: () => void
  /** Present for flows with a credentials-form fallback (device flows). */
  onManualInput?: () => void
  requestQR: (type: string, name: string, workspaceDir: string) => Promise<{ qrContent: string; token: string; browserUrl?: string }>
  pollStatus: (type: string, token: string) => Promise<{ status: string; channelId?: string; error?: string }>
  cancelQR: (type: string, token: string) => Promise<void>
  existingChannels: { id: string; type: string; name: string }[]
}) {
  const { t } = useI18n()
  const { workspacePath } = useWorkspace()
  const [qrUrl, setQrUrl] = useState("")
  const [browserUrl, setBrowserUrl] = useState<string | undefined>(undefined)
  const [qrToken, setQrToken] = useState("")
  const [scanStatus, setScanStatus] = useState<string>("pending")
  const [errorMsg, setErrorMsg] = useState("")
  const [refreshCount, setRefreshCount] = useState(0)
  const MAX_REFRESH = 3

  const label = t(`channel.type.${type}`)
  const BrandIcon = CHANNEL_TYPE_ICONS[type]
  // Device flows: the QR page is a regular web page (scannable or openable in
  // a browser) and auto-creates the bot app. The ilink wechat QR is app-only.
  const isDeviceFlow = type !== "wechat"

  // Cancel the gateway-side session when the user closes the flow (stops the
  // background poll loop; sessions also expire on their own via TTL).
  const abandonSession = (token: string, status: string) => {
    if (token && status !== "authorized") void cancelQR(type, token)
  }
  const handleCancel = () => {
    abandonSession(qrToken, scanStatus)
    onCancel()
  }

  // Auto-generate channel name
  const autoName = useMemo(() => {
    const existingNames = new Set(
      existingChannels.filter((c) => c.type === type).map((c) => c.name),
    )
    if (!existingNames.has(label)) return label
    for (let i = 2; ; i++) {
      const candidate = `${label}-${i}`
      if (!existingNames.has(candidate)) return candidate
    }
  }, [existingChannels, type, label])

  // Auto-start QR flow on mount
  useEffect(() => {
    if (!workspacePath) return
    let cancelled = false
    const start = async () => {
      try {
        const data = await requestQR(type, autoName, workspacePath)
        if (cancelled) return
        setQrUrl(data.qrContent)
        setBrowserUrl(data.browserUrl)
        setQrToken(data.token)
        setScanStatus("pending")
      } catch (err) {
        if (cancelled) return
        setErrorMsg(t("channel.qr.error"))
        console.error(`${type} QR request failed:`, err)
      }
    }
    start()
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Poll the gateway's cached session state
  useEffect(() => {
    if (!qrToken) return

    let cancelled = false
    const poll = async () => {
      while (!cancelled) {
        try {
          const resp = await pollStatus(type, qrToken)
          if (cancelled) break
          setScanStatus(resp.status)

          if (resp.status === "authorized") {
            // Success — close and refresh
            setTimeout(onDone, 1500)
            return
          }

          if (resp.status === "denied" || resp.status === "error") {
            setErrorMsg(resp.error || t("channel.qr.error"))
            return
          }

          if (resp.status === "expired") {
            // Auto-refresh QR code
            if (refreshCount < MAX_REFRESH) {
              setRefreshCount((c) => c + 1)
              try {
                const data = await requestQR(type, autoName, workspacePath!)
                if (cancelled) break
                setQrUrl(data.qrContent)
                setBrowserUrl(data.browserUrl)
                setQrToken(data.token)
                setScanStatus("pending")
              } catch {
                setErrorMsg(t("channel.qr.error"))
                return
              }
            } else {
              setErrorMsg(t("channel.qr.expired"))
              return
            }
            continue
          }

          // For "pending" and "scanned", keep polling the gateway cache
          await new Promise((r) => setTimeout(r, 1000))
        } catch (err) {
          if (cancelled) break
          // 404 = session already cleaned up on the gateway → treat as expired
          if (err instanceof Error && err.message.includes("404")) {
            setErrorMsg(t("channel.qr.expired"))
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

  const statusText = scanStatus === "pending"
    ? t("channel.qr.waitingScan")
    : scanStatus === "scanned"
    ? t("channel.qr.scanned")
    : scanStatus === "authorized"
    ? t("channel.qr.confirmed")
    : ""

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {BrandIcon && <BrandIcon className="size-4" />}
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{t("channel.qr.scanTitle", { label })}</h3>
        </div>
        <button onClick={handleCancel} className="rounded p-1 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]">
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
                requestQR(type, autoName, workspacePath).then((data) => {
                  setQrUrl(data.qrContent)
                  setBrowserUrl(data.browserUrl)
                  setQrToken(data.token)
                  setScanStatus("pending")
                }).catch((err) => {
                  setErrorMsg(t("channel.qr.error"))
                  console.error(`${type} QR retry failed:`, err)
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
          {scanStatus === "authorized" ? (
            <CheckCircle2 className="size-4 text-green-500" />
          ) : scanStatus === "scanned" ? (
            <Smartphone className="size-4 text-blue-500" />
          ) : (
            <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
          )}
          <span className={cn(
            scanStatus === "authorized" ? "text-green-600 dark:text-green-400" :
            scanStatus === "scanned" ? "text-blue-600 dark:text-blue-400" :
            "text-[var(--color-fg-muted)]"
          )}>
            {statusText}
          </span>
        </div>

        {isDeviceFlow && !errorMsg && (
          <p className="text-xs text-[var(--color-fg-muted)]">{t("channel.qr.autoCreateHint", { label })}</p>
        )}

        {errorMsg && (
          <p className="text-xs text-red-500">{errorMsg}</p>
        )}

        <div className="flex items-center gap-2">
          {isDeviceFlow && qrUrl && (
            <Button variant="outline" size="sm" onClick={() => { void openUrl(browserUrl ?? qrUrl) }}>
              <ExternalLink className="mr-1.5 size-3.5" />
              {t("channel.qr.openInBrowser")}
            </Button>
          )}
          {onManualInput && (
            <Button variant="outline" size="sm" onClick={() => {
              abandonSession(qrToken, scanStatus)
              onManualInput()
            }}>
              <KeyRound className="mr-1.5 size-3.5" />
              {t("channel.qr.manualInput")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleCancel}>
            {t("button.cancel")}
          </Button>
        </div>
      </div>
    </div>
  )
}
