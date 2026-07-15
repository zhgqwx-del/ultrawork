import { describe, it, expect, beforeEach } from "vitest"
import {
  AUTO_API_BASE_URL,
  ConfigStorage,
  DEFAULT_CONFIG,
  isAutoApiBaseUrl,
  resolveApiBaseUrl,
  type AppConfig,
} from "@/lib/config"

describe("ConfigStorage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe("DEFAULT_CONFIG", () => {
    it("has correct default values", () => {
      // apiPassword/apiUsername default to empty — ConfigProvider fetches the
      // random per-install credentials from the Tauri backend on mount.
      expect(DEFAULT_CONFIG.apiPassword).toBe("")
      expect(DEFAULT_CONFIG.apiUsername).toBe("")
      expect(DEFAULT_CONFIG.theme).toBe("system")
      expect(DEFAULT_CONFIG.language).toBe("en")
    })

    it("apiBaseUrl defaults to auto — a port is never persisted", () => {
      expect(DEFAULT_CONFIG.apiBaseUrl).toBe(AUTO_API_BASE_URL)
      expect(isAutoApiBaseUrl(DEFAULT_CONFIG.apiBaseUrl)).toBe(true)
    })
  })

  // import.meta.env.DEV is true in test setup, so every resolution goes through
  // the Vite proxy (relative URL) — including an explicit override.
  describe("resolveApiBaseUrl (DEV)", () => {
    it("resolves auto to the relative proxy path", () => {
      expect(resolveApiBaseUrl(AUTO_API_BASE_URL)).toBe("")
    })

    it("ignores an explicit override — the proxy target is baked into vite.config", () => {
      expect(resolveApiBaseUrl("http://192.168.1.5:4096")).toBe("")
    })
  })

  describe("apiBaseUrl migration", () => {
    const load = (apiBaseUrl: unknown) => {
      localStorage.setItem("ultrawork-config", JSON.stringify({ apiBaseUrl }))
      return ConfigStorage.load().apiBaseUrl
    }

    it.each([
      ["", "the old DEV default (Vite proxy)"],
      ["http://localhost:4096", "the old prod default"],
      ["http://127.0.0.1:4096", "the loopback spelling of the old prod default"],
      ["http://localhost:4096/", "a trailing slash"],
    ])("migrates %j to auto — %s", (stored) => {
      expect(load(stored)).toBe(AUTO_API_BASE_URL)
    })

    it("migrates a missing field to auto", () => {
      expect(load(undefined)).toBe(AUTO_API_BASE_URL)
    })

    // The negative direction: a migration that rewrote everything would pass the
    // assertions above while silently discarding a user's remote server.
    it.each([
      "http://192.168.1.5:4096",
      "https://opencode.example.com",
      "http://localhost:9999",
    ])("preserves the deliberate override %j", (stored) => {
      expect(load(stored)).toBe(stored)
    })
  })

  describe("load", () => {
    it("returns DEFAULT_CONFIG when nothing stored", () => {
      const config = ConfigStorage.load()
      expect(config).toEqual(DEFAULT_CONFIG)
    })

    it("merges stored config with defaults", () => {
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ theme: "dark", language: "zh-Hans", apiPassword: "stored-pw" })
      )
      const config = ConfigStorage.load()
      expect(config.theme).toBe("dark")
      expect(config.language).toBe("zh-Hans")
      expect(config.apiPassword).toBe("stored-pw")
    })

    // ADR-058 D2: old builds persisted "zh" (Simplified). Existing users must
    // land on zh-Hans with zero perceived change.
    it("migrates legacy language \"zh\" to \"zh-Hans\"", () => {
      localStorage.setItem("ultrawork-config", JSON.stringify({ language: "zh" }))
      expect(ConfigStorage.load().language).toBe("zh-Hans")
    })

    it("keeps explicit zh-Hant / zh-Hans / en untouched", () => {
      for (const lang of ["zh-Hant", "zh-Hans", "en"] as const) {
        localStorage.setItem("ultrawork-config", JSON.stringify({ language: lang }))
        expect(ConfigStorage.load().language).toBe(lang)
      }
    })

    it("falls back to a detected default for an unknown language value", () => {
      localStorage.setItem("ultrawork-config", JSON.stringify({ language: "fr" }))
      // jsdom navigator.language is en-US → "en".
      expect(ConfigStorage.load().language).toBe("en")
    })

    it("preserves empty credentials so ConfigProvider can fill them from Tauri", () => {
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ apiPassword: "", apiUsername: "" })
      )
      const config = ConfigStorage.load()
      expect(config.apiPassword).toBe("")
      expect(config.apiUsername).toBe("")
    })

    it("returns DEFAULT_CONFIG on invalid JSON", () => {
      localStorage.setItem("ultrawork-config", "not-json{{{")
      const config = ConfigStorage.load()
      expect(config).toEqual(DEFAULT_CONFIG)
    })
  })

  describe("save", () => {
    it("persists config to localStorage", () => {
      const config: AppConfig = {
        ...DEFAULT_CONFIG,
        theme: "dark",
        language: "zh-Hans",
      }
      ConfigStorage.save(config)
      const stored = JSON.parse(localStorage.getItem("ultrawork-config")!)
      expect(stored.theme).toBe("dark")
      expect(stored.language).toBe("zh-Hans")
    })
  })

  describe("reset", () => {
    it("removes config from localStorage", () => {
      localStorage.setItem("ultrawork-config", JSON.stringify({ theme: "dark" }))
      ConfigStorage.reset()
      expect(localStorage.getItem("ultrawork-config")).toBeNull()
    })
  })
})
