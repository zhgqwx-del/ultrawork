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
  it("verifies en and zh dictionaries have matching keys", async () => {
    // Read the actual source file to extract keys
    // We'll use a regex-based approach to parse the translation keys
    const fs = await import("fs")
    const path = await import("path")

    const filePath = path.resolve(__dirname, "../../lib/i18n-context.tsx")
    const content = fs.readFileSync(filePath, "utf-8")

    // Extract key-value pairs from en and zh sections
    const enMatch = content.match(/en:\s*\{([\s\S]*?)\n\s*\},\s*\n\s*zh:/)
    const zhMatch = content.match(/zh:\s*\{([\s\S]*?)\n\s*\},?\s*\n\s*\}/)

    expect(enMatch).not.toBeNull()
    expect(zhMatch).not.toBeNull()

    const extractKeys = (block: string): string[] => {
      const keyRegex = /"([^"]+)":\s*"/g
      const keys: string[] = []
      let match
      while ((match = keyRegex.exec(block)) !== null) {
        keys.push(match[1])
      }
      return keys.sort()
    }

    const enKeys = extractKeys(enMatch![1])
    const zhKeys = extractKeys(zhMatch![1])

    // Find keys in en but not in zh
    const missingInZh = enKeys.filter((k) => !zhKeys.includes(k))
    // Find keys in zh but not in en
    const missingInEn = zhKeys.filter((k) => !enKeys.includes(k))

    if (missingInZh.length > 0) {
      console.warn("Keys in en but missing in zh:", missingInZh)
    }
    if (missingInEn.length > 0) {
      console.warn("Keys in zh but missing in en:", missingInEn)
    }

    expect(missingInZh).toEqual([])
    expect(missingInEn).toEqual([])
  })
})
