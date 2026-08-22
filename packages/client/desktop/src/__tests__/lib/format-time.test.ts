import { describe, it, expect } from "vitest"
import { formatDateTime, formatDateOnly, toIsoTimestamp } from "@/lib/format-time"

// 2026-08-22 11:16:07 local time.
const TS = new Date(2026, 7, 22, 11, 16, 7).getTime()

describe("format-time", () => {
  // The visible string depends on the environment's default locale (node resolves
  // to en-US on this machine, and CI's three platforms make no promise), so every
  // exact assertion below pins the locale explicitly. Asserting the no-locale
  // output against `toLocaleString()` would be measuring the thing with itself.
  // ICU 72 changed en-US to put U+202F (narrow no-break space) before AM/PM, so a
  // hard-coded en-US literal is a platform-dependent trap — the three CI runners
  // need not share an ICU version. Normalise the exotic spaces before comparing.
  const norm = (s: string | null) => s?.replace(/[\u202f\u00a0]/g, " ") ?? null

  it("formats date + time in the given locale", () => {
    expect(formatDateTime(TS, "zh-Hans")).toBe("2026/8/22 11:16:07")
    expect(norm(formatDateTime(TS, "en-US"))).toBe("8/22/2026, 11:16:07 AM")
  })

  it("matches toLocaleString() field-for-field — caching costs no fidelity", () => {
    for (const locale of ["zh-Hans", "zh-Hant", "en-US"]) {
      expect(formatDateTime(TS, locale)).toBe(new Date(TS).toLocaleString(locale))
      expect(formatDateOnly(TS, locale)).toBe(new Date(TS).toLocaleDateString(locale))
    }
  })

  it("keeps a per-locale formatter — switching language switches the output", () => {
    // A single cached instance would keep answering in the first locale asked for,
    // silently pinning timestamps to whatever language the app started in.
    const zh = formatDateTime(TS, "zh-Hans")
    const en = formatDateTime(TS, "en-US")
    expect(formatDateTime(TS, "zh-Hans")).toBe(zh)
    expect(zh).not.toBe(en)
  })

  it("returns null instead of throwing or printing 1970 for a bad timestamp", () => {
    for (const bad of [undefined, null, 0, -1, NaN, Infinity, 1e20]) {
      expect(formatDateTime(bad as number | undefined, "en-US")).toBeNull()
      expect(formatDateOnly(bad as number | undefined, "en-US")).toBeNull()
      expect(toIsoTimestamp(bad as number | undefined)).toBeUndefined()
    }
  })

  it("falls back to the system locale instead of throwing on a malformed tag", () => {
    // Negative control for the guard: this tag makes `new Intl.DateTimeFormat`
    // throw RangeError, which inside the transcript would take the view down.
    expect(() => new Intl.DateTimeFormat("not a tag")).toThrow()
    expect(formatDateTime(TS, "not a tag")).toBe(new Date(TS).toLocaleString())
    expect(formatDateOnly(TS, "not a tag")).toBe(new Date(TS).toLocaleDateString())
  })

  it("emits a locale-independent ISO string for <time dateTime>", () => {
    expect(toIsoTimestamp(TS)).toBe(new Date(TS).toISOString())
    expect(toIsoTimestamp(TS)).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/)
  })
})
