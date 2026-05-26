import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react"
import { invoke } from "@tauri-apps/api/core"
import { AppConfig, ConfigStorage, DEFAULT_CONFIG } from "./config"

interface ConfigContextValue {
  config: AppConfig
  updateConfig: (config: Partial<AppConfig>) => void
  resetConfig: () => void
}

const ConfigContext = createContext<ConfigContextValue | null>(null)

interface SidecarCredentials {
  username: string
  password: string
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(() => ConfigStorage.load())

  // Fetch per-install sidecar credentials from Tauri on mount.
  // First launch generates a random password and persists it under
  // ~/.config/ultrawork/sidecar-auth.json — replaces the old hardcoded "test123".
  useEffect(() => {
    // Migrate existing dev users with the old hardcoded "test123" creds in localStorage.
    const isLegacyDefault =
      config.apiPassword === "test123" && config.apiUsername === "opencode"
    if (config.apiPassword && config.apiUsername && !isLegacyDefault) return

    invoke<SidecarCredentials>("get_sidecar_credentials")
      .then(creds => {
        setConfig(prev => {
          const next = {
            ...prev,
            apiPassword: creds.password,
            apiUsername: creds.username,
          }
          ConfigStorage.save(next)
          return next
        })
      })
      .catch(err => {
        console.error("Failed to load sidecar credentials:", err)
      })
  }, [config.apiPassword, config.apiUsername])

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
