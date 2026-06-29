import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { PlanStep } from "@agent/api-client"
import type { SSEEvent } from "@agent/connector"
import { useConnector, useSessionSubscribe } from "@/lib/sse-context"

export interface SessionPlan {
  /** Current task-plan steps (whole list; latest authoritative snapshot). */
  steps: PlanStep[]
  /** True while the initial snapshot is being hydrated. */
  loading: boolean
}

/**
 * Task-plan state for one session (ADR-038). Source of truth is the backend,
 * NOT local accumulation:
 *  - hydrate the authoritative snapshot via `connector.getPlan` on open /
 *    switch-back (opencode REST `/session/{id}/todo`; ACP sidecar snapshot) —
 *    this is what makes switch-back lossless (same principle as discussions/022);
 *  - apply live `plan.updated` events as a WHOLE-LIST replace (整表替换), so
 *    there is no merge/drift, no phantom steps, no missing steps.
 *
 * Plan is session-scoped — the panel shows only the currently-viewed session's
 * plan (no Team aggregation, ADR-038 Q3).
 */
export function useSessionPlan(sessionId: string | undefined): SessionPlan {
  const connector = useConnector()
  const [steps, setSteps] = useState<PlanStep[]>([])
  const [loading, setLoading] = useState(false)
  // True once a live plan.updated has arrived for the CURRENT session. The
  // hydrate snapshot must never clobber a fresher live event that raced ahead
  // of getPlan's resolution (live is always >= the snapshot; whole-list
  // replace). Reset synchronously at the top of the hydrate effect, before any
  // subscription for the new session can fire.
  const liveArrivedRef = useRef(false)

  // The session→backend binding can hydrate asynchronously after this hook
  // mounts (ACP bindings load from the sidecar at launch, ADR-030). Re-run the
  // snapshot when it changes so a session that flips opencode→acp re-hydrates
  // from the correct backend instead of being stuck on the default's empty plan.
  const binding = useSyncExternalStore(
    useCallback((cb) => connector.bindings.onChange(cb), [connector]),
    () => (sessionId ? connector.bindings.get(sessionId) : ""),
  )

  useEffect(() => {
    if (!sessionId) {
      setSteps([])
      setLoading(false)
      return
    }
    let cancelled = false
    liveArrivedRef.current = false
    setLoading(true)
    setSteps([])
    connector
      .getPlan(sessionId)
      .then((plan) => {
        // A live event already won — don't overwrite it with an older snapshot.
        if (!cancelled && !liveArrivedRef.current) setSteps(Array.isArray(plan) ? plan : [])
      })
      .catch(() => {
        // No plan yet / backend without plan support → empty. The panel falls
        // back to the activity view; never throw into render.
        if (!cancelled && !liveArrivedRef.current) setSteps([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connector, sessionId, binding])

  const handler = useCallback(
    (event: SSEEvent) => {
      if (event.type !== "plan.updated") return
      const props = event.properties as { sessionID?: string; entries?: PlanStep[] }
      if (props.sessionID !== sessionId) return
      liveArrivedRef.current = true
      setSteps(Array.isArray(props.entries) ? props.entries : [])
    },
    [sessionId],
  )
  useSessionSubscribe(sessionId, handler)

  return { steps, loading }
}
