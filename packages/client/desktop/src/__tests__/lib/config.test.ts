import { describe, it, expect, beforeEach } from "vitest"
import { ConfigStorage, DEFAULT_CONFIG, type AppConfig } from "@/lib/config"

describe("ConfigStorage", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe("DEFAULT_CONFIG", () => {
    it("has correct default values", () => {
      expect(DEFAULT_CONFIG.apiPassword).toBe("test123")
      expect(DEFAULT_CONFIG.apiUsername).toBe("opencode")
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
        JSON.stringify({ theme: "dark", language: "zh" })
      )
      const config = ConfigStorage.load()
      expect(config.theme).toBe("dark")
      expect(config.language).toBe("zh")
      expect(config.apiPassword).toBe(DEFAULT_CONFIG.apiPassword)
    })

    it("falls back to default password when stored password is empty", () => {
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ apiPassword: "" })
      )
      const config = ConfigStorage.load()
      expect(config.apiPassword).toBe(DEFAULT_CONFIG.apiPassword)
    })

    it("falls back to default username when stored username is empty", () => {
      localStorage.setItem(
        "ultrawork-config",
        JSON.stringify({ apiUsername: "" })
      )
      const config = ConfigStorage.load()
      expect(config.apiUsername).toBe(DEFAULT_CONFIG.apiUsername)
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
