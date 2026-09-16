import { invoke } from "@tauri-apps/api/core"

/**
 * Push the UI language's tray / menu-bar strings to Rust (discussions/061).
 *
 * The tray is built in Rust before the renderer exists and Rust never reads the
 * renderer's config, so its menu starts in English; this call replaces the labels
 * once i18n is up and again on every language switch. Outside Tauri (vitest,
 * plain Chrome) there is no bridge and nothing to sync — silently a no-op, like
 * the other `@tauri-apps/api` callers in `lib/`.
 */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export type TrayLabels = {
  open: string
  quit: string
  tooltip: string
  hintTitle: string
  hintBody: string
}

export function trayLabelsFrom(t: (key: string) => string): TrayLabels {
  return {
    open: t("tray.open"),
    quit: t("tray.quit"),
    tooltip: t("tray.tooltip"),
    hintTitle: t("tray.hintTitle"),
    hintBody: t("tray.hintBody"),
  }
}

export function syncTrayLabels(t: (key: string) => string): void {
  if (!inTauri) return
  // Fire-and-forget: a stale tray label is not worth surfacing to the user.
  void invoke("set_tray_labels", { labels: trayLabelsFrom(t) }).catch(() => {})
}
