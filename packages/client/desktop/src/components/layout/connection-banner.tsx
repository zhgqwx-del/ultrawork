import { useEffect, useState } from "react"
import { listen } from "@tauri-apps/api/event"
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
 */
export function ConnectionBanner() {
  const connected = useSSEConnected()
  const reconnect = useSSEReconnect()
  const { t } = useI18n()
  const [showing, setShowing] = useState(false)
  const [deadSidecar, setDeadSidecar] = useState<string | null>(null)

  useEffect(() => {
    if (connected) {
      setShowing(false)
      setDeadSidecar(null) // the stream recovering proves the backend is alive
      return
    }
    const timer = setTimeout(() => setShowing(true), GRACE_MS)
    return () => clearTimeout(timer)
  }, [connected])

  // A dead sidecar is a different message from a dropped socket: nothing
  // restarts it, so "retrying" would be a lie and relaunching is the only fix.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    listen<{ name: string }>("sidecar-exited", (event) => {
      if (!disposed) setDeadSidecar(event.payload?.name ?? "sidecar")
    })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
      // Non-Tauri host (tests / browser dev): no sidecars to mourn.
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (!showing && !deadSidecar) return null

  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-400"
    >
      <WifiOff className="size-3.5 shrink-0" />
      <span>{deadSidecar ? t("connection.sidecarExited") : t("connection.offline")}</span>
      <button
        onClick={reconnect}
        className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-colors hover:bg-amber-500/20"
      >
        {t("connection.retry")}
      </button>
    </div>
  )
}
