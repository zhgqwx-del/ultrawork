import { createContext, useContext, useCallback, useMemo } from "react"
import { useConfig } from "./config-context"
import { en, zhHans, type Language } from "./i18n-translations"
import { zhHant } from "./i18n-zh-hant.generated"

export type { Language }

interface I18nContextValue {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string, params?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

// Translation dictionary. `en` + `zh-Hans` are hand-written (i18n-translations.ts);
// `zh-Hant` is GENERATED from `zh-Hans` at build time (ADR-058 D3, scripts/gen-zh-hant.ts).
// `translations` is exported for tests only (key-completeness assertions over per-id families).
export const translations: Record<Language, Record<string, string>> = {
  en,
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { config, updateConfig } = useConfig()

  const setLanguage = useCallback((lang: Language) => {
    updateConfig({ language: lang })
  }, [updateConfig])

  const language = config.language

  const t = useCallback((key: string, params?: Record<string, string | number>): string => {
    let value = translations[language]?.[key] || key
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        // split/join: String.replace would interpret `$&`-style sequences in the
        // value (file paths can contain them, e.g. {location}/{path} params).
        value = value.split(`{${k}}`).join(String(v))
      })
    }
    return value
  }, [language])

  const value = useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t])

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  const context = useContext(I18nContext)
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider")
  }
  return context
}
