/**
 * The allowlist of sessions this app's user prompted **from the desktop UI**.
 *
 * Completion notifications fire only for sessions in here, which is the one rule
 * that keeps three unrelated classes of session quiet at once (discussions/036 §2.3):
 *
 *   - **IM channel sessions** — a WeChat/DingTalk/Feishu/WeCom message runs a turn
 *     through the same backend and emits the same `session.status: idle`. Chiming
 *     because a colleague messaged the bot is pure noise.
 *   - **Delegate child sessions** — sub-agents emit `session.status` on the global
 *     stream too, and the renderer cannot even tell a child id apart from a root's
 *     (the status event carries only `sessionID`, and the child was never fetched).
 *   - **Anything else** the backend runs on its own.
 *
 * None of them are ever registered here, so none of them can notify — no extra
 * predicate needed.
 *
 * A module singleton rather than React state on purpose: the producers
 * (`useSessionMessages.sendMessage`, `Home`) and the consumer (the notification mount)
 * are in different trees, and this is a fact about the process, not render state.
 * Deliberately NOT persisted: rehydrating it after a reload would replay stale "done"
 * notifications for turns that finished while we were gone.
 */
const locallyPrompted = new Set<string>()

// Subscribers exist because the notification mount opens a per-session event stream for
// every in-flight session — ACP delivers permission/question ONLY there, never on the
// global stream — so it must re-render when the set changes (useSyncExternalStore).
type Listener = () => void
const listeners = new Set<Listener>()

// useSyncExternalStore compares snapshots by identity: a fresh array on every call would
// loop forever. Rebuild it only when the set actually changes.
let snapshot: string[] = []
function publish() {
  snapshot = [...locallyPrompted]
  for (const l of listeners) l()
}

/** The desktop user just sent a prompt into this session. */
export function markLocallyPrompted(sessionId: string): void {
  if (locallyPrompted.has(sessionId)) return
  locallyPrompted.add(sessionId)
  publish()
}

/**
 * Take the session out of the allowlist, reporting whether it was in it.
 * Called when the turn reaches a terminal state — a completion notification is
 * owed exactly once per locally-sent prompt.
 */
export function consumeLocallyPrompted(sessionId: string): boolean {
  const had = locallyPrompted.delete(sessionId)
  if (had) publish()
  return had
}

/**
 * Is a locally-sent turn still in flight here?
 *
 * Used by the attention path (permission / question), which must NOT consume: the same
 * turn still owes a completion alert once the user answers and the agent finishes.
 */
export function isLocallyPrompted(sessionId: string): boolean {
  return locallyPrompted.has(sessionId)
}

/**
 * Drop the session without claiming a notification.
 *
 * Used when the turn ends in a way the user already knows about: they hit Stop, or the
 * prompt POST itself failed and the composer surfaced a toast. Both leave the user
 * staring at the window; notifying them would be telling them what they just did.
 *
 * The failed-POST case matters more than it looks: no turn ever ran, so no `idle` will
 * ever arrive to consume the entry, and a stale entry arms a false "completed" on the
 * next idle that session sees from any source.
 */
export function forgetLocallyPrompted(sessionId: string): void {
  if (locallyPrompted.delete(sessionId)) publish()
}

export function subscribeInFlight(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function inFlightSnapshot(): string[] {
  return snapshot
}

/** Test seam. */
export function __resetNotifyRegistryForTest(): void {
  locallyPrompted.clear()
  publish()
}
