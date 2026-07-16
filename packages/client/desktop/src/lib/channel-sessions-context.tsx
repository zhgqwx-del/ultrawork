// Channel-session registry, desktop side. The gateway owns the chatId→session
// bindings; the sidebar needs them to answer "which of these sessions came from
// WeChat?" — a question opencode itself cannot answer (its Session schema has no
// metadata/tags field, and PATCH /session only accepts title + archived, so the
// only in-band marker was a "[钉钉·张三]" prefix the gateway back-patches into the
// title AFTER the first turn completes).
//
// Gateway unreachable (not running, or no channels configured at all) degrades to
// an empty registry — every consumer must keep working badge-less.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import type { ChannelSessionEntry, ChannelSessionsResponse } from "@agent/api-client"
import { gatewayBaseUrl } from "./sidecar-ports"
import { sidecarAuthHeaders } from "./sidecar-auth"

export type { ChannelSessionEntry }

/** Poll interval. The gateway has no SSE stream of its own, and a channel session
 *  is only *born* on the first IM message — rare enough that a slow poll is fine.
 *  Session activity itself (the part that reorders the sidebar) rides opencode's
 *  global SSE and is already live; this only backfills the badge. */
const POLL_MS = 30_000

/** First retry after a failure. The gateway is spawned in a non-blocking background
 *  thread AFTER the renderer gate opens (opencode-gated, not gateway-gated), so at
 *  cold boot this provider's first fetch reliably beats the gateway to `listen()` and
 *  gets ECONNREFUSED. Retrying from 1s (not straight to 30s) means a gateway that is
 *  merely still starting is picked up within a second or two, so IM badges appear
 *  promptly instead of after a full poll interval. */
const BOOT_RETRY_MS = 1_000

/** Back off when the gateway is unreachable. Most users configure no IM channel at
 *  all, and the provider is mounted app-wide — without this it would hammer a dead
 *  port for the entire life of the app. The retry delay grows geometrically from
 *  BOOT_RETRY_MS and is capped here, so a genuinely-absent gateway still settles to a
 *  slow poll after a handful of cheap early retries. Resets on any success. */
const MAX_BACKOFF_MS = 5 * 60_000

/** Next poll delay given the count of consecutive failures. No failures → steady
 *  {@link POLL_MS}. Otherwise a geometric retry from {@link BOOT_RETRY_MS}
 *  (1s, 2s, 4s…) capped at {@link MAX_BACKOFF_MS}. Extracted (and exported) so the
 *  cadence can be locked deterministically without driving the async timer loop. */
export function nextChannelPollDelay(failures: number): number {
  if (failures <= 0) return POLL_MS
  return Math.min(BOOT_RETRY_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
}

interface ChannelSessionsValue {
  entries: ChannelSessionEntry[]
  entryOf: (sessionId: string | undefined) => ChannelSessionEntry | undefined
  refresh: () => Promise<void>
}

const ChannelSessionsContext = createContext<ChannelSessionsValue | null>(null)

async function fetchChannelSessions(): Promise<ChannelSessionEntry[]> {
  // gatewayBaseUrl() ALREADY ends in /channel ("/channel" under the dev proxy,
  // "http://localhost:<port>/channel" in prod), so the path appended here must not
  // repeat it — `${base}/channel/sessions` resolves to /channel/channel/sessions
  // and 404s. Same convention as use-channels.ts, where listing is gatewayFetch("").
  const resp = await fetch(`${gatewayBaseUrl()}/sessions`, {
    headers: { ...sidecarAuthHeaders() },
  })
  if (!resp.ok) throw new Error(`Gateway ${resp.status}`)
  const body = (await resp.json()) as ChannelSessionsResponse
  return body.sessions ?? []
}

export function ChannelSessionsProvider({ children }: { children: React.ReactNode }) {
  const [entries, setEntries] = useState<ChannelSessionEntry[]>([])

  const refresh = useCallback(async () => {
    try {
      setEntries(await fetchChannelSessions())
    } catch {
      // gateway down / no channels — keep whatever we have
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let failures = 0

    let warned = false
    const tick = async () => {
      try {
        const list = await fetchChannelSessions()
        if (cancelled) return
        setEntries(list)
        failures = 0
      } catch (err) {
        // Degrading silently is right for a gateway that is simply down, but it is
        // also how a wrong URL hid: the badge just never appeared and nothing said
        // why. Say it once, then stay quiet and back off.
        if (!warned) {
          warned = true
          console.warn("[channel-sessions] registry unreachable — sidebar stays badge-less:", err)
        }
        failures += 1
      }
      if (cancelled) return
      timer = setTimeout(tick, nextChannelPollDelay(failures))
    }

    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const bySessionId = useMemo(
    () => new Map(entries.map((e) => [e.sessionId, e])),
    [entries],
  )
  const entryOf = useCallback(
    (sessionId: string | undefined) => (sessionId ? bySessionId.get(sessionId) : undefined),
    [bySessionId],
  )

  const value = useMemo(() => ({ entries, entryOf, refresh }), [entries, entryOf, refresh])

  return (
    <ChannelSessionsContext.Provider value={value}>{children}</ChannelSessionsContext.Provider>
  )
}

export function useChannelSessions(): ChannelSessionsValue {
  const ctx = useContext(ChannelSessionsContext)
  if (!ctx) throw new Error("useChannelSessions must be used within ChannelSessionsProvider")
  return ctx
}
