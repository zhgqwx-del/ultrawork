/**
 * Absolute date/time formatting for the transcript and the sidebar.
 *
 * Two things this module exists to get right:
 *
 * 1. **Cached formatters.** `Date.prototype.toLocaleString()` measures ~32µs per
 *    call under JSC (the engine behind macOS WKWebView), versus ~0.84µs for a
 *    cached `Intl.DateTimeFormat` — 38×. That matters because the transcript
 *    re-renders on every streamed token, so an uncached call would sit on the
 *    hot path once per visible message per frame. `DATE_TIME_OPTS` is spelled
 *    out to reproduce `toLocaleString()`'s defaults byte-for-byte (verified for
 *    zh-Hans / zh-Hant / en-US), so caching costs nothing in output fidelity.
 *
 * 2. **Locale follows the UI language, not the OS.** A bare `toLocaleString()`
 *    resolves to the *system* locale — on a machine set to en-US that puts
 *    "8/22/2026, 11:16:07 AM" under a Chinese message. Callers pass the app
 *    language (`useI18n().language`); `undefined` still falls back to the system
 *    locale, which is what non-UI callers want.
 */

/** Reproduces `toLocaleString()`'s default field set (date + time, numeric). */
const DATE_TIME_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
}

/** Reproduces `toLocaleDateString()`'s default field set. */
const DATE_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "numeric",
  day: "numeric",
}

// Keyed by kind + locale. A single shared instance would keep formatting in the
// PREVIOUS language after the user switches — the timestamps would silently stop
// following the UI, with nothing to signal it. `undefined` (system locale) gets
// its own "" slot rather than colliding with a real tag.
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(kind: string, locale: string | undefined, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${kind}:${locale ?? ""}`
  let cached = formatters.get(key)
  if (!cached) {
    try {
      cached = new Intl.DateTimeFormat(locale, opts)
    } catch {
      // A STRUCTURALLY invalid tag throws RangeError (an unknown-but-well-formed
      // one just falls back, which is why a webview missing zh-Hant data degrades
      // quietly). Today `language` is whitelisted to en/zh-Hans/zh-Hant by
      // config.migrateLanguage so this is unreachable — but these formatters render
      // inside the transcript, where an exception costs the whole view, and the
      // module is exported to any future caller. Fall back to the system locale.
      cached = new Intl.DateTimeFormat(undefined, opts)
    }
    formatters.set(key, cached)
  }
  return cached
}

/**
 * A usable ms-epoch timestamp. The upper bound is the ECMAScript Date range
 * (±8.64e15) — past it both `Intl.format` and `toISOString` throw RangeError,
 * so this guard is what keeps a corrupt `time.created` from taking the
 * transcript down instead of just rendering nothing.
 */
function isValidTimestamp(ts: number | undefined | null): ts is number {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0 && Math.abs(ts) <= 8.64e15
}

/**
 * Full date + time, e.g. "2026/8/22 11:16:07" (zh-Hans) or
 * "8/22/2026, 11:16:07 AM" (en-US). Returns null for a missing or bogus
 * timestamp so callers can skip the element entirely rather than print
 * "Invalid Date" / 1970.
 */
export function formatDateTime(ts: number | undefined | null, locale?: string): string | null {
  if (!isValidTimestamp(ts)) return null
  return formatter("dt", locale, DATE_TIME_OPTS).format(ts)
}

/** Date only, e.g. "2026/8/22" — the >7d fallback of the sidebar's relative time. */
export function formatDateOnly(ts: number | undefined | null, locale?: string): string | null {
  if (!isValidTimestamp(ts)) return null
  return formatter("d", locale, DATE_OPTS).format(ts)
}

/**
 * ISO 8601 for `<time dateTime>`: machine-readable and locale-independent, which
 * is also what tests can assert exactly (the visible text varies with the
 * environment's default locale and must not be hard-coded).
 */
export function toIsoTimestamp(ts: number | undefined | null): string | undefined {
  if (!isValidTimestamp(ts)) return undefined
  return new Date(ts).toISOString()
}
