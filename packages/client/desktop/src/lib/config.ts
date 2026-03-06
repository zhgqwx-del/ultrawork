export interface AppConfig {
  apiBaseUrl: string
  apiPassword: string
  apiUsername?: string
  theme: "light" | "dark" | "system"
  language: "en" | "zh"
}

export const DEFAULT_CONFIG: AppConfig = {
  apiBaseUrl: "http://localhost:4096",
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
        return { ...DEFAULT_CONFIG, ...parsed }
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
