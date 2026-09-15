import { describe, it, expect, vi, beforeEach } from "vitest"
import { translations } from "@/lib/i18n-context"

/**
 * Tray / menu-bar labels (discussions/061). The Rust side deserializes exactly
 * this camelCase shape (`background.rs` TrayLabels, rename_all = "camelCase");
 * a missing key would leak the raw key into the OS menu, and a renamed field
 * would make the invoke fail silently (fire-and-forget by design) — so both
 * ends are pinned here.
 */
const h = vi.hoisted(() => ({ invoke: vi.fn(async () => undefined) }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }))

const KEYS = ["open", "quit", "tooltip", "hintTitle", "hintBody"] as const

describe("tray labels", () => {
  beforeEach(() => {
    h.invoke.mockClear()
    vi.resetModules()
  })

  for (const lang of ["en", "zh-Hans", "zh-Hant"] as const) {
    it(`${lang}: every tray.* key is translated`, () => {
      const missing = KEYS.filter((k) => !translations[lang][`tray.${k}`])
      expect(missing).toEqual([])
    })
  }

  it("builds the exact camelCase payload Rust deserializes", async () => {
    const { trayLabelsFrom } = await import("@/lib/tray-labels")
    const labels = trayLabelsFrom((k) => `<${k}>`)
    expect(Object.keys(labels).sort()).toEqual([...KEYS].sort())
    expect(labels.hintTitle).toBe("<tray.hintTitle>")
  })

  it("is a no-op without the Tauri bridge", async () => {
    const { syncTrayLabels } = await import("@/lib/tray-labels")
    syncTrayLabels((k) => k)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  it("invokes set_tray_labels with { labels } when the bridge exists", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    try {
      const { syncTrayLabels } = await import("@/lib/tray-labels")
      syncTrayLabels((k) => `t:${k}`)
      expect(h.invoke).toHaveBeenCalledTimes(1)
      expect(h.invoke).toHaveBeenCalledWith("set_tray_labels", {
        labels: {
          open: "t:tray.open",
          quit: "t:tray.quit",
          tooltip: "t:tray.tooltip",
          hintTitle: "t:tray.hintTitle",
          hintBody: "t:tray.hintBody",
        },
      })
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })

  it("swallows a rejected invoke (fire-and-forget)", async () => {
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    h.invoke.mockRejectedValueOnce(new Error("no such command"))
    try {
      const { syncTrayLabels } = await import("@/lib/tray-labels")
      expect(() => syncTrayLabels((k) => k)).not.toThrow()
      await Promise.resolve()
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    }
  })
})
