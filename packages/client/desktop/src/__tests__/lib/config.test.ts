import { describe, it, expect, beforeEach } from "vitest"
import { ConfigStorage, DEFAULT_CONFIG, type AppConfig } from "@/lib/config"

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

    it("apiBaseUrl is empty in DEV mode", () => {
      // import.meta.env.DEV is true in test setup
      expect(DEFAULT_CONFIG.apiBaseUrl).toBe("")
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
        JSON.stringify({ theme: "dark", language: "zh", apiPassword: "stored-pw" })
      )
      const config = ConfigStorage.load()
      expect(config.theme).toBe("dark")
      expect(config.language).toBe("zh")
      expect(config.apiPassword).toBe("stored-pw")
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
        language: "zh",
      }
      ConfigStorage.save(config)
      const stored = JSON.parse(localStorage.getItem("ultrawork-config")!)
      expect(stored.theme).toBe("dark")
      expect(stored.language).toBe("zh")
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
