/**
 * The whole "should we bother the user, and how" decision — a pure function, so
 * every trap in discussions/036 §2 is nailed down by unit tests instead of by a
 * hand-verified side effect nobody can drive from a test (the chime, the banner and
 * the dock bounce are only observable with human eyes and ears).
 */

export type NotifyKind =
  /** An assistant turn reached a terminal finish. */
  | "completed"
  /** The turn died (idle-guard timeout, provider error, …) — ADR-034/049. */
  | "failed"
  /** The agent is blocked on the user: a permission request or a question. */
  | "attention"

export interface NotifyTrigger {
  kind: NotifyKind
  /** The ROOT session the user would return to — never a delegate child's id. */
  sessionId: string
}

export interface NotifyContext {
  /**
   * `getCurrentWindow().isFocused()`, re-queried at decision time.
   *
   * One bool covers all four "the user cannot see us" states — another app in
   * front, minimised, cmd+H hidden, or on another Space (discussions/036 §4 V3).
   * Do NOT substitute `document.visibilityState`: it flaps between visible and
   * hidden within a single state because it is computed from occlusion.
   */
  focused: boolean
  /** The session currently on screen, if the user is on a session route. */
  viewingSessionId?: string
  /** Is this session in the locally-prompted allowlist (notify-registry)? */
  locallyPrompted: boolean
  /**
   * Has this session already raised an unanswered `attention` alert?
   *
   * With `permission: ask`, an agent asks once per bash call — a user who steps away
   * for ten minutes would come back to a dozen banners and a dozen dock bounces.
   * One alert per session until they come back and deal with it (the flag is cleared
   * on window focus), NOT a time window: a time window still accumulates across a
   * long absence, which is exactly the case that hurts.
   */
  alreadyAlerted: boolean
  settings: NotifySettings
}

export interface NotifySettings {
  sound: boolean
  system: boolean
  flash: boolean
}

export interface NotifyChannels {
  sound: boolean
  system: boolean
  flash: boolean
}

const SILENT: NotifyChannels = { sound: false, system: false, flash: false }

export function decideChannels(trigger: NotifyTrigger, ctx: NotifyContext): NotifyChannels {
  // Not ours to announce: IM channel turns, delegate children, backend-initiated
  // work. See notify-registry for why one allowlist covers all three.
  if (!ctx.locallyPrompted) return SILENT

  // The user is looking straight at this session — announcing it is noise, and noise
  // is what makes people switch the whole feature off. Note the gate is deliberately
  // wider than "unfocused": a focused window sitting on session A must still announce
  // session B, which the reference implementation we were shown cannot do.
  if (ctx.focused && ctx.viewingSessionId === trigger.sessionId) return SILENT

  // Storm control, attention only. A completion happens once per turn and needs no throttle.
  if (trigger.kind === "attention" && ctx.alreadyAlerted) return SILENT

  return {
    sound: ctx.settings.sound,
    system: ctx.settings.system,
    flash: ctx.settings.flash,
  }
}
