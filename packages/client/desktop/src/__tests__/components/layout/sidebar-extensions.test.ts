import { describe, it, expect } from "vitest"
import { EXTENSION_ENTRIES } from "@/components/layout/left-sidebar"
import { en } from "@/lib/i18n-translations"

// Guardrail for the sidebar "Extensions" quick-access shortcuts. These entries
// deep-link into /settings via router history state, so the contract that must
// not silently drift is: (1) they point at real settings sections, and (2) their
// labels resolve to real i18n keys. The nav wiring itself is a trivial map over
// this registry; this test pins the data that wiring depends on.

// The valid settings-section ids that a deep-link may carry — mirrors the
// SettingsSection union in pages/Settings.tsx (a type, so it can't be imported).
const VALID_SECTIONS = new Set([
  "general", "models", "privacy", "capabilities", "agents",
  "services", "tools", "channels", "knowledge", "skills", "about",
])

describe("sidebar Extensions quick-access entries", () => {
  it("exposes exactly the four capability-extension sections", () => {
    expect(EXTENSION_ENTRIES.map((e) => e.section)).toEqual([
      "channels", "services", "skills", "tools",
    ])
  })

  it("every entry targets a real settings section", () => {
    for (const entry of EXTENSION_ENTRIES) {
      expect(VALID_SECTIONS.has(entry.section)).toBe(true)
    }
  })

  it("every entry label resolves to a real i18n key", () => {
    for (const entry of EXTENSION_ENTRIES) {
      expect(en[entry.labelKey]).toBeTruthy()
    }
  })

  it("has no duplicate sections", () => {
    const sections = EXTENSION_ENTRIES.map((e) => e.section)
    expect(new Set(sections).size).toBe(sections.length)
  })
})
