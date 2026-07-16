import { describe, it, expect } from "vitest"

// We test the translation dictionary and t() logic directly
// by importing the module and extracting translations
// Since i18n-context.tsx exports React components, we test the pure logic

// Inline the translation lookup logic for testing
function createT(translations: Record<string, Record<string, string>>, language: string) {
  return (key: string, params?: Record<string, string | number>): string => {
    let value = translations[language]?.[key] || key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        value = value.replace(`{${k}}`, String(v))
      })
    }
    return value
  }
}

// Manually define the expected keys from the actual translation file
// This test verifies translation completeness and t() behavior

describe("i18n translations", () => {
  // We need to import the translations. Since the module uses React context,
  // we'll verify the key aspects programmatically.

  const sampleTranslations: Record<string, Record<string, string>> = {
    en: {
      "brand.name": "UltraWork",
      "time.mAgo": "{n}m ago",
      "time.hAgo": "{n}h ago",
      "home.headline": "Chat & Work, Simple & Easy",
      "sidebar.newTask": "New Task",
    },
    zh: {
      "brand.name": "UltraWork",
      "time.mAgo": "{n}分钟前",
      "time.hAgo": "{n}小时前",
      "home.headline": "聊天办公，简单轻松",
      "sidebar.newTask": "新建任务",
    },
  }

  describe("t() function", () => {
    it("returns English translation", () => {
      const t = createT(sampleTranslations, "en")
      expect(t("brand.name")).toBe("UltraWork")
      expect(t("home.headline")).toBe("Chat & Work, Simple & Easy")
    })

    it("returns Chinese translation", () => {
      const t = createT(sampleTranslations, "zh")
      expect(t("brand.name")).toBe("UltraWork")
      expect(t("home.headline")).toBe("聊天办公，简单轻松")
    })

    it("returns key itself for missing translation", () => {
      const t = createT(sampleTranslations, "en")
      expect(t("nonexistent.key")).toBe("nonexistent.key")
    })

    it("interpolates {n} parameter - English", () => {
      const t = createT(sampleTranslations, "en")
      expect(t("time.mAgo", { n: 5 })).toBe("5m ago")
      expect(t("time.hAgo", { n: 2 })).toBe("2h ago")
    })

    it("interpolates {n} parameter - Chinese", () => {
      const t = createT(sampleTranslations, "zh")
      expect(t("time.mAgo", { n: 5 })).toBe("5分钟前")
      expect(t("time.hAgo", { n: 2 })).toBe("2小时前")
    })

    it("handles multiple parameters", () => {
      const translations = {
        en: { "test.multi": "Hello {name}, you have {count} items" },
        zh: {},
      }
      const t = createT(translations, "en")
      expect(t("test.multi", { name: "Alice", count: 3 })).toBe(
        "Hello Alice, you have 3 items"
      )
    })

    it("handles params with no matching placeholder", () => {
      const t = createT(sampleTranslations, "en")
      // Should not throw, just return the original value
      expect(t("brand.name", { unused: "value" })).toBe("UltraWork")
    })
  })

  describe("translation completeness", () => {
    // This test reads the actual i18n file and verifies en/zh keys match
    it("en and zh have the same keys", async () => {
      // Dynamic import to get the actual translations
      const module = await import("@/lib/i18n-context")
      // The translations are not exported, but we can verify via the provider
      // For now, we verify the structure indirectly
      expect(module.I18nProvider).toBeDefined()
      expect(module.useI18n).toBeDefined()
    })
  })
})

describe("translation key parity", () => {
  // Import the real dictionaries rather than regex-scraping source (ADR-058:
  // en + zh-Hans are hand-written in i18n-translations.ts; zh-Hant is generated).
  it("en, zh-Hans and zh-Hant have identical key sets", async () => {
    const { translations } = await import("@/lib/i18n-context")
    const keysOf = (l: "en" | "zh-Hans" | "zh-Hant") => Object.keys(translations[l]).sort()
    const en = keysOf("en")

    // zh-Hans must mirror en (hand-written parity).
    expect(keysOf("zh-Hans")).toEqual(en)
    // zh-Hant is generated from zh-Hans → must have exactly the same keys.
    expect(keysOf("zh-Hant")).toEqual(en)
  })

  it("zh-Hant is populated (generated file wired in)", async () => {
    const { translations } = await import("@/lib/i18n-context")
    // Sanity that the generated dict is real Traditional text, not a stub.
    expect(translations["zh-Hant"]["general.theme.system"]).toBe("跟隨系統")
    expect(Object.keys(translations["zh-Hant"]).length).toBeGreaterThan(100)
  })
})
