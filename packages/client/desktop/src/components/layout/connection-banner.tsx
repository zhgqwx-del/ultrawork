import { useEffect, useState } from "react"
import { WifiOff } from "lucide-react"
import { useSSEConnected, useSSEReconnect } from "@/lib/sse-context"
import { useBackendLiveness } from "@/lib/use-backend-liveness"
import { useCredentialResync } from "@/lib/use-credential-resync"
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
 * "The sidecar process died" and "the stream dropped" get different words,
 * because nothing restarts a sidecar after boot — offering "reconnect" for a
 * dead one is a lie. That distinction was first attempted with a Rust-side
 * `sidecar-exited` event, which made the Windows test binary fail to LOAD
 * (STATUS_ENTRYPOINT_NOT_FOUND, isolated by two CI bisections; ADR-071). It is
 * now derived in the renderer instead, by probing the port — no Rust, and it
 * reports what is true NOW rather than replaying a one-off event.
 */
export function ConnectionBanner() {
  const connected = useSSEConnected()
  const reconnect = useSSEReconnect()
  const { t } = useI18n()
  const [showing, setShowing] = useState(false)
  // Only probe once the banner is up: a healthy app must not poll the port, and
  // an ordinary blip resolves inside the grace window anyway.
  const liveness = useBackendLiveness(showing)
  // Lives here because this is where the two facts meet: the stream is down AND
  // the port just told us why. Recovering a stale password is the one kind of
  // "disconnected" the app can fix by itself.
  useCredentialResync(liveness)

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
      <span>{liveness === "absent" ? t("connection.sidecarExited") : t("connection.offline")}</span>
      {/* A dead process cannot be reconnected to — offering the button would be
          the same lie the message avoids. */}
      {liveness !== "absent" && (
      <button
        onClick={reconnect}
        className="rounded px-1.5 py-0.5 font-medium underline underline-offset-2 transition-colors hover:bg-amber-500/20"
      >
        {t("connection.retry")}
      </button>
      )}
    </div>
  )
}
