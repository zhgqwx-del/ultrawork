import { createContext, useContext, useState, useCallback, type ReactNode } from "react"
import { AppConfig, ConfigStorage, DEFAULT_CONFIG } from "./config"

interface ConfigContextValue {
  config: AppConfig
  updateConfig: (config: Partial<AppConfig>) => void
  resetConfig: () => void
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(() => ConfigStorage.load())

  const updateConfig = useCallback((updates: Partial<AppConfig>) => {
    setConfig(prev => {
      const newConfig = { ...prev, ...updates }
      ConfigStorage.save(newConfig)
      return newConfig
    })
  }, [])

  const resetConfig = useCallback(() => {
    setConfig(DEFAULT_CONFIG)
    ConfigStorage.reset()
  }, [])

  return (
    <ConfigContext.Provider value={{ config, updateConfig, resetConfig }}>
      {children}
    </ConfigContext.Provider>
  )
}

export function useConfig() {
  const context = useContext(ConfigContext)
  if (!context) {
    throw new Error("useConfig must be used within ConfigProvider")
  }
  return context
}
