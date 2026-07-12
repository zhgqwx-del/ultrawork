/**
 * The three side effects + the focus read. Thin on purpose: everything worth
 * testing lives in notify-decide.ts, because none of this is observable from a
 * test runner (see discussions/036 §5).
 *
 * Every probe result behind these choices is in discussions/036 §4.
 */
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window"
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification"

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

// TEMP (discussions/036): the banner path swallows every failure by design — a broken
// notification must never take the app down — which also means a broken notification is
// invisible. Under VITE_NOTIFY_TRACE it narrates itself instead.
const trace = (msg: string) => {
  if (import.meta.env.VITE_NOTIFY_TRACE !== "1" || !inTauri) return
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("probe_log", { msg }).catch(() => {}))
}

// ---------------------------------------------------------------------- focus

/**
 * True when the user can actually see us.
 *
 * Re-queried at decision time rather than tracked from `onFocusChanged`: the probe
 * caught the event payload disagreeing with the state (`payload=true` while
 * `isFocused()` answered `false` in the same instant), so trusting the payload would
 * misjudge exactly during the window switch we care about (discussions/036 §4 V3).
 */
export async function isWindowFocused(): Promise<boolean> {
  if (!inTauri) return typeof document !== "undefined" ? document.hasFocus() : true
  try {
    return await getCurrentWindow().isFocused()
  } catch {
    // Fail towards silence: a focus read we cannot trust must not become a chime.
    return true
  }
}

/** Fires whenever the window gains focus — the reset signal for the attention throttle. */
export function onWindowFocused(cb: () => void): () => void {
  if (!inTauri) return () => {}
  let disposed = false
  let off: (() => void) | undefined
  void getCurrentWindow()
    .onFocusChanged(({ payload }) => {
      if (payload) cb()
    })
    .then((unlisten) => {
      if (disposed) unlisten()
      else off = unlisten
    })
    .catch(() => {})
  return () => {
    disposed = true
    off?.()
  }
}

// ---------------------------------------------------------------------- chime

/**
 * A two-note chime synthesised at play time.
 *
 * No asset ships: no audio file to license, to bundle, or to load. The probe
 * confirmed WebKit lets us do this with zero user gesture — the context starts
 * `suspended`, `resume()` succeeds anyway, and its clock keeps advancing even while
 * the window is minimised (discussions/036 §4 V2), which is the only state that
 * mattered here.
 */
let audioCtx: AudioContext | null = null

export async function playChime(): Promise<void> {
  try {
    audioCtx ??= new AudioContext()
    const ctx = audioCtx
    if (ctx.state === "suspended") await ctx.resume()

    const now = ctx.currentTime
    // Two rising notes (A5 → E6), short and quiet: a nudge, not an alarm.
    for (const [i, freq] of [880, 1318.5].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const at = now + i * 0.13
      osc.type = "sine"
      osc.frequency.value = freq
      // Envelope, not a raw gate — a square-edged start/stop clicks audibly.
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(0.14, at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.24)
    }
  } catch {
    // A silent chime must never take the notification (or the app) down with it.
  }
}

// --------------------------------------------------------------- system banner

/**
 * ⚠️ Only real in a packaged .app.
 *
 * In `tauri dev` this whole path LIES: `isPermissionGranted()` returns true without
 * ever asking, `sendNotification()` throws nothing — and macOS never registers the
 * app as a notification client, so no banner is ever drawn (discussions/036 §4 V1,
 * gotchas §6). Verify this feature on a bundle, never on `tauri dev`.
 */
export async function sendSystemNotification(title: string, body: string): Promise<void> {
  if (!inTauri) return
  try {
    let granted = await isPermissionGranted()
    trace(`banner: isPermissionGranted=${granted}`)
    if (!granted) {
      // Asked on first use, never at startup: a permission sheet thrown at a user who
      // has no idea what the app does yet gets dismissed, and macOS does not ask twice.
      granted = (await requestPermission()) === "granted"
      trace(`banner: requestPermission → ${granted}`)
    }
    // Denied is a final answer — degrade to chime + dock bounce, don't nag.
    if (granted) {
      sendNotification({ title, body })
      trace(`banner: sendNotification("${title}") dispatched`)
    }
  } catch (e) {
    trace(`banner: THREW ${e}`)
  }
}

// ---------------------------------------------------------------------- flash

/**
 * Dock bounce (macOS) / taskbar flash (Windows) / urgency hint (Linux).
 *
 * On Linux this is honoured on X11 and is a **stub on Wayland** (GTK3's Wayland backend
 * implements set_urgency_hint as an empty function), i.e. on the default GNOME/Ubuntu
 * setup it silently does nothing. We accept that rather than fake it — the chime and the
 * banner still land.
 *
 * `Critical` keeps bouncing until the user comes back, which is the point.
 */
export async function flashWindow(): Promise<void> {
  if (!inTauri) return
  try {
    await getCurrentWindow().requestUserAttention(UserAttentionType.Critical)
  } catch {
    // Ignore.
  }
}

/**
 * Withdraw the attention request. Called when the window regains focus.
 *
 * Not a no-op outside macOS, which is why it exists: on Windows `null` maps to
 * FLASHW_STOP, and on X11 tao does `set_urgency_hint(false)` — without this the urgency
 * flag stays asserted on the window forever after the first alert. (On macOS it really is
 * a no-op — the dock stops bouncing on focus by itself.)
 */
export async function clearAttentionRequest(): Promise<void> {
  if (!inTauri) return
  try {
    await getCurrentWindow().requestUserAttention(null)
  } catch {
    // Ignore.
  }
}
