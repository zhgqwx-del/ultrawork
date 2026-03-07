export interface AppConfig {
  apiBaseUrl: string
  apiPassword: string
  apiUsername?: string
  theme: "light" | "dark" | "system"
  language: "en" | "zh"
}

export const DEFAULT_CONFIG: AppConfig = {
  apiBaseUrl: import.meta.env.DEV ? "" : "http://localhost:4096",
  apiPassword: "test123",
  apiUsername: "opencode",
  theme: "system",
  language: "en",
}

const CONFIG_STORAGE_KEY = "ultrawork-config"

export class ConfigStorage {
  static load(): AppConfig {
    try {
      const stored = localStorage.getItem(CONFIG_STORAGE_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        const merged = { ...DEFAULT_CONFIG, ...parsed }
        // Ensure credentials fall back to defaults if stored as empty
        if (!merged.apiPassword) merged.apiPassword = DEFAULT_CONFIG.apiPassword
        if (!merged.apiUsername) merged.apiUsername = DEFAULT_CONFIG.apiUsername
        return merged
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
