import { createContext, useContext, useEffect, useState } from "react"
import { useConfig } from "./config-context"

type Theme = "light" | "dark" | "system"

interface ThemeContextValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  resolvedTheme: "light" | "dark"
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { config, updateConfig } = useConfig()
  // Seeded from the class the inline script in index.html already resolved, not from a
  // hardcoded "light". The effect below sets the *class* correctly on the first pass,
  // but consumers of `resolvedTheme` (the Toaster, CodeMirror's theme) render before it
  // runs — so a dark-mode user used to get one light-themed frame of those regardless.
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light"
  )

  const setTheme = (theme: Theme) => {
    updateConfig({ theme })
  }

  useEffect(() => {
    const root = window.document.documentElement

    // Remove existing theme classes
    root.classList.remove("light", "dark")

    let effectiveTheme: "light" | "dark"

    if (config.theme === "system") {
      // Use system preference
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      effectiveTheme = systemTheme
    } else {
      effectiveTheme = config.theme
    }

    root.classList.add(effectiveTheme)
    setResolvedTheme(effectiveTheme)
  }, [config.theme])

  // Listen for system theme changes when in system mode
  useEffect(() => {
    if (config.theme !== "system") return

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      const systemTheme = mediaQuery.matches ? "dark" : "light"
      const root = window.document.documentElement
      root.classList.remove("light", "dark")
      root.classList.add(systemTheme)
      setResolvedTheme(systemTheme)
    }

    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [config.theme])

  return (
    <ThemeContext.Provider value={{ theme: config.theme, setTheme, resolvedTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
