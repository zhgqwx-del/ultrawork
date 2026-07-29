import { useEffect, useState } from "react"
import { WifiOff } from "lucide-react"
import { useSSEConnected, useSSEReconnect } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"

/**
 * How long the stream may be down before we say so. Ordinary reconnects (a
 * sidecar restart, a dropped socket) resolve in a second or two, and flashing a
 * scary banner at every one of them trains people to ignore it.
 */
const GRACE_MS = 4000

/**
 * Standing "we are disconnected" indicator.
 *
 * Before this the only signal was a single toast fired the moment fast retries
 * ran out — miss it and the app looks fine while silently receiving nothing:
 * you can type, the message goes nowhere visible, and no reply ever arrives.
 * A state that persists needs an indicator that persists.
 *
 * NOT distinguished here: "the sidecar process died" vs "the stream dropped".
 * That distinction matters — nothing restarts a dead sidecar, so offering
 * "reconnect" for it is misleading — but the Rust-side `sidecar-exited` event
 * that carried it made the Windows test binary fail to LOAD
 * (STATUS_ENTRYPOINT_NOT_FOUND, isolated to the AppHandle/Manager half by two
 * CI bisections). Deferred rather than shipped broken; see ADR-071 §遗留.
 */
export function ConnectionBanner() {
  const connected = useSSEConnected()
  const reconnect = useSSEReconnect()
  const { t } = useI18n()
  const [showing, setShowing] = useState(false)

  useEffect(() => {
    if (connected) {
      setShowing(false)
      return
    }
    const timer = setTimeout(() => setShowing(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [connected])

  if (!showing) return null

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      <WifiOff className="size-3.5 shrink-0" />
      <span>{t("connection.offline")}</span>
      <button
        onClick={reconnect}
        className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-colors hover:bg-amber-500/20"
      >
        {t("connection.retry")}
      </button>
    </div>
  )
}
