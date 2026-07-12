/**
 * Turn-completion / needs-you notifications (ADR-053, discussions/036).
 *
 * Mounted once, at the layout, so it sees EVERY session — including the ones the user is
 * not looking at, which is the entire point of the feature.
 *
 * Two event sources, because no single one carries everything:
 *
 *   - the GLOBAL stream — `session.status` for every session, both backends.
 *   - a PER-SESSION stream for each in-flight session — the ACP sidecar publishes
 *     `permission.asked` / `question.asked` only there (`acp-manager` feeds
 *     `globalSubscribers` from `emitStatus()` alone), so a global-only listener would be
 *     deaf to "the agent needs you" for every Claude/Gemini session — the one class of
 *     event where missing it costs the whole task, not just the notice.
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { useLocation } from "react-router-dom"
import { useSSESubscribe, useSessionSubscribe } from "@/lib/sse-context"
import { useSessionsContext } from "@/lib/sessions-context"
import { useConfig } from "@/lib/config-context"
import { useI18n } from "@/lib/i18n-context"
import { subscribeDelegateEvents } from "@/lib/orchestration-client"
import {
  consumeLocallyPrompted,
  inFlightSnapshot,
  isLocallyPrompted,
  subscribeInFlight,
} from "./notify-registry"
import { decideChannels, type NotifyKind, type NotifyTrigger } from "./notify-decide"
import {
  clearAttentionRequest,
  flashWindow,
  isWindowFocused,
  onWindowFocused,
  playChime,
  sendSystemNotification,
} from "./notify-effects"

/** `/session/:id` → the id. Anything else → undefined (Home, Settings, workspace picker). */
function viewingSessionIdOf(pathname: string): string | undefined {
  return /^\/session\/([^/]+)/.exec(pathname)?.[1]
}

type Fire = (kind: NotifyKind, sessionId: string, locallyPrompted: boolean, detail?: string) => void

export function Notifications() {
  const { sessions } = useSessionsContext()
  const { config } = useConfig()
  const { t } = useI18n()
  const location = useLocation()

  // Refs, not deps: the SSE handler must not resubscribe every time the route or a
  // session title changes — a resubscribe drops events in the gap.
  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions
  const viewingRef = useRef<string | undefined>(undefined)
  viewingRef.current = viewingSessionIdOf(location.pathname)
  const settingsRef = useRef({ sound: false, system: false, flash: false })
  settingsRef.current = {
    sound: config.notifySound,
    system: config.notifySystem,
    flash: config.notifyFlash,
  }

  /** Sessions with an unanswered attention alert (discussions/036 §2.5). */
  const alertedRef = useRef<Set<string>>(new Set())

  /**
   * A session's last error, held until the turn actually ends.
   *
   * `session.error` is NOT terminal in opencode: a context overflow publishes it and then
   * compacts and keeps running (processor.ts returns before `status.set(idle)`), and an
   * unreadable file attachment publishes it mid-turn too. Firing "failed" on the event
   * itself would raise a false alarm AND consume the allowlist entry, so the turn's real
   * completion would then go unannounced. Instead the error is remembered, cleared if the
   * turn produces more output, and only reported if the session goes idle still carrying it.
   */
  const pendingErrorRef = useRef<Map<string, string>>(new Map())

  useEffect(
    () =>
      onWindowFocused(() => {
        // Coming back IS the user dealing with it: re-arm the throttle.
        alertedRef.current.clear()
        // And drop the attention request itself. macOS ignores this (the bounce ends when
        // the app is focused, which just happened), but on Windows it cancels FLASHW and
        // on X11 it clears the urgency hint — which otherwise stays asserted forever.
        void clearAttentionRequest()
      }),
    [],
  )

  const fire = useCallback<Fire>(
    (kind, sessionId, locallyPrompted, detail) => {
      void (async () => {
        // Read focus FIRST and finish the decision synchronously afterwards. Checking the
        // throttle before the await and marking it after would let every attention event
        // that arrives while this promise is in flight (two delegates under one owner; a
        // permission and a question in one SSE batch) sail through as "not yet alerted".
        const focused = await isWindowFocused()

        const trigger: NotifyTrigger = { kind, sessionId }
        const channels = decideChannels(trigger, {
          focused,
          viewingSessionId: viewingRef.current,
          locallyPrompted,
          alreadyAlerted: alertedRef.current.has(sessionId),
          settings: settingsRef.current,
        })

        // The three effects are invisible to any test runner (a banner, a chime, a
        // bouncing dock). VITE_NOTIFY_TRACE=1 makes the DECISION observable instead, so a
        // packaged-app run can prove the wiring end to end — which is the only place the
        // notification path is real at all (discussions/036 §4 V1).
        if (import.meta.env.VITE_NOTIFY_TRACE === "1") {
          void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("probe_log", {
              msg: `notify ${kind} session=${sessionId} local=${locallyPrompted} → ${JSON.stringify(channels)}`,
            }).catch(() => {}),
          )
        }

        if (!channels.sound && !channels.system && !channels.flash) return
        if (kind === "attention") alertedRef.current.add(sessionId)

        const title = sessionsRef.current.find((s) => s.id === sessionId)?.title || t("session.newChat")
        const body =
          kind === "completed"
            ? t("notify.completed", { title })
            : kind === "failed"
              ? t("notify.failed", { title, error: detail ?? t("error.unknown") })
              : t("notify.attention", { title })

        if (channels.sound) void playChime()
        if (channels.system) void sendSystemNotification(t("notify.appName"), body)
        if (channels.flash) void flashWindow()
      })()
    },
    [t],
  )

  /** The turn ended. Which of the two endings it was depends on a held-back error. */
  const settle = useCallback(
    (sessionId: string) => {
      // Whatever the outcome, the session is no longer waiting on the user.
      alertedRef.current.delete(sessionId)
      const error = pendingErrorRef.current.get(sessionId)
      pendingErrorRef.current.delete(sessionId)
      if (!consumeLocallyPrompted(sessionId)) return
      if (error) fire("failed", sessionId, true, error)
      else fire("completed", sessionId, true)
    },
    [fire],
  )

  useSSESubscribe(
    useCallback(
      (event) => {
        switch (event.type) {
          case "session.status": {
            // The app-level idle truth for every session (use-sessions.ts). NOT the
            // renderer's streaming flag, which flickers false→true→false mid-turn
            // (assistant-turn.tsx debounces it) and would fire twice.
            const sid = event.properties?.sessionID as string | undefined
            if (!sid || event.properties?.status?.type !== "idle") return
            settle(sid)
            return
          }

          case "session.error": {
            const { sessionID, error } = event.properties as {
              sessionID?: string
              error?: { name?: string; data?: { message?: string } }
            }
            // Unattributed errors are dropped rather than pinned on a guessed session.
            if (!sessionID) return
            if (!isLocallyPrompted(sessionID)) return
            pendingErrorRef.current.set(sessionID, error?.data?.message || error?.name || "")
            return
          }

          case "message.part.delta":
          case "message.part.updated":
          case "message.updated": {
            // The turn is still producing output, so whatever error we were holding was
            // not the end of it (context overflow → compaction → the turn carries on).
            const sid = (event.properties as any)?.part?.sessionID ?? (event.properties as any)?.info?.sessionID ?? (event.properties as any)?.sessionID
            if (typeof sid === "string") pendingErrorRef.current.delete(sid)
            return
          }

          // server.instance.disposed is deliberately NOT handled. It clears every busy
          // marker at once (use-sessions.ts:266), so treating it as "everything finished"
          // would fire a burst of alerts every time a sidecar restarts.
        }
      },
      [settle],
    ),
  )

  // Delegate (sub-agent) permission requests arrive on the orchestration stream, not SSE.
  // The request's sessionID is the CHILD's, which the user cannot navigate to — so it is
  // announced against the owner session, exactly like the delegate dock does.
  useEffect(() => {
    const owners = new Map<string, string>() // delegateId → ownerSessionId
    return subscribeDelegateEvents((event) => {
      if (event.type === "delegate.snapshot") {
        for (const d of event.properties.delegates) {
          if (d.ownerSessionId) owners.set(d.id, d.ownerSessionId)
        }
      } else if (event.type === "delegate.updated") {
        const d = event.properties.delegate
        if (d.ownerSessionId) owners.set(d.id, d.ownerSessionId)
      } else if (event.type === "delegate.permission") {
        const inner = event.properties.event as { type: string }
        if (inner.type !== "permission.asked") return
        const owner = owners.get(event.properties.delegateId as string)
        // No owner known ⇒ no session to send the user to. Stay quiet rather than raise an
        // alert that leads nowhere.
        if (!owner) return
        fire("attention", owner, isLocallyPrompted(owner))
      }
    })
  }, [fire])

  // One watcher per in-flight session — see the header: ACP's permission/question events
  // never reach the global stream.
  const inFlight = useSyncExternalStore(subscribeInFlight, inFlightSnapshot, inFlightSnapshot)
  const watchers = useMemo(
    () => inFlight.map((id) => <AttentionWatcher key={id} sessionId={id} fire={fire} alerted={alertedRef} />),
    [inFlight, fire],
  )
  return <>{watchers}</>
}

/**
 * Watches ONE in-flight session for "the agent is blocked on you".
 *
 * Renders nothing. `useSessionSubscribe` routes to whichever stream that backend uses, so
 * this covers opencode (filtered global stream) and ACP (its own per-session stream) with
 * one subscription each — and only for sessions the user actually started, which is also
 * exactly the set allowed to notify.
 */
function AttentionWatcher({
  sessionId,
  fire,
  alerted,
}: {
  sessionId: string
  fire: Fire
  alerted: React.RefObject<Set<string>>
}) {
  useSessionSubscribe(
    sessionId,
    useCallback(
      (event) => {
        switch (event.type) {
          case "permission.asked":
          case "question.asked":
            // Cannot be inferred from idle: a question blocks INSIDE the tool call, so the
            // session stays busy and emits nothing at all while it waits (ADR-050 measured
            // 195s of silence). Peek, don't consume — this turn still owes a completion.
            fire("attention", sessionId, isLocallyPrompted(sessionId))
            return

          case "permission.replied":
          case "question.replied":
          case "question.rejected":
            // The user dealt with it. Re-arm the throttle NOW, not at the next focus gain:
            // an alert raised while the window was focused (you were in another session)
            // would otherwise still be marked "already alerted" when you next walk away,
            // and the next question — the one you are not there to see — would be silent.
            alerted.current?.delete(sessionId)
            return
        }
      },
      [sessionId, fire, alerted],
    ),
  )
  return null
}
