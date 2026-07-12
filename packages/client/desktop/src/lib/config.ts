import { opencodeBaseUrl } from "./sidecar-ports"

/** Stored `apiBaseUrl` meaning "whatever port the host actually bound". */
export const AUTO_API_BASE_URL = "auto"

export interface AppConfig {
  /**
   * `"auto"` (the default) or an explicit override. Never store a resolved
   * absolute URL: the port is chosen per launch, so a persisted `:4096` would
   * be wrong the moment the sidecar lands somewhere else. Read it through
   * `resolveApiBaseUrl`, not directly.
   */
  apiBaseUrl: string
  apiPassword: string
  apiUsername?: string
  theme: "light" | "dark" | "system"
  language: "en" | "zh"
  /**
   * Auto-reveal the right sidebar the first time a turn produces a task plan
   * (ADR-048 D1). The kill switch every auto-behaviour needs — and turning it off
   * leaves the manual entry point (the TopBar toggle) and the artifact badge
   * intact, it only stops the panel from opening itself.
   */
  planAutoReveal: boolean
  /**
   * Notifications for "your turn finished" / "the agent needs you" (ADR-053).
   *
   * All three are gated on the same condition — the window is unfocused, OR it is
   * focused on some OTHER session — so none of them can fire while the user is
   * watching the very session that finished.
   */
  notifySound: boolean
  notifySystem: boolean
  notifyFlash: boolean
}

/**
 * Turn a stored `apiBaseUrl` into the URL to actually call.
 *
 * In dev everything goes through the Vite proxy (relative URLs), so an explicit
 * override is ignored there — exactly as before this became configurable. The
 * proxy target is baked into vite.config.ts and Vite starts before the sidecars,
 * so it could not honour a runtime port anyway.
 */
export function resolveApiBaseUrl(apiBaseUrl: string): string {
  if (import.meta.env.DEV) return ""
  return apiBaseUrl === AUTO_API_BASE_URL ? opencodeBaseUrl() : apiBaseUrl
}

export function isAutoApiBaseUrl(apiBaseUrl: string): boolean {
  return apiBaseUrl === AUTO_API_BASE_URL
}

// Detect the user's preferred UI language from the browser/system locale.
// Falls back to "en" when navigator isn't available (SSR/tests) or the
// locale isn't Chinese.
function detectDefaultLanguage(): "en" | "zh" {
  if (typeof navigator === "undefined") return "en"
  const lang = (navigator.language || (navigator.languages?.[0] ?? "")).toLowerCase()
  return lang.startsWith("zh") ? "zh" : "en"
}

// apiPassword/apiUsername default to empty; ConfigProvider fetches the
// per-install random credentials from the Tauri backend on mount.
export const DEFAULT_CONFIG: AppConfig = {
  apiBaseUrl: AUTO_API_BASE_URL,
  apiPassword: "",
  apiUsername: "",
  theme: "system",
  language: detectDefaultLanguage(),
  planAutoReveal: true,
  notifySound: true,
  notifySystem: true,
  notifyFlash: true,
}

const CONFIG_STORAGE_KEY = "ultrawork-config"

// Values older builds persisted as "the default": "" meant "go through the Vite
// dev proxy", and the absolute form was the compile-time prod port. Both now mean
// "auto". A URL that is neither is a deliberate user override and survives.
const LEGACY_DEFAULT_BASE_URL = /^$|^https?:\/\/(localhost|127\.0\.0\.1):4096\/?$/

function migrateApiBaseUrl(apiBaseUrl: unknown): string {
  if (typeof apiBaseUrl !== "string") return AUTO_API_BASE_URL
  return LEGACY_DEFAULT_BASE_URL.test(apiBaseUrl) ? AUTO_API_BASE_URL : apiBaseUrl
}

export class ConfigStorage {
  static load(): AppConfig {
    try {
      const stored = localStorage.getItem(CONFIG_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        return {
          ...DEFAULT_CONFIG,
          ...parsed,
          apiBaseUrl: migrateApiBaseUrl(parsed.apiBaseUrl),
        }
      }
    } catch (err) {
      console.error("Failed to load config:", err)
    }
    return DEFAULT_CONFIG
  }

  static save(config: AppConfig): void {
    try {
      localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config))
    } catch (err) {
      console.error("Failed to save config:", err)
    }
  }

  static reset(): void {
    try {
      localStorage.removeItem(CONFIG_STORAGE_KEY)
    } catch (err) {
      console.error("Failed to reset config:", err)
    }
  }
}
