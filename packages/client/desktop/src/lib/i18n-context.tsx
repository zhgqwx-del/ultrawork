import { createContext, useContext } from "react"
import { useConfig } from "./config-context"

type Language = "en" | "zh"

interface I18nContextValue {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextValue | undefined>(undefined)

// Translation dictionary
const translations: Record<Language, Record<string, string>> = {
  en: {
    // Settings
    "settings.title": "Settings",
    "settings.description": "Configure your application preferences",
    "settings.connection": "Connection",
    "settings.general": "General",
    "settings.about": "About",

    // Connection tab
    "connection.apiBaseUrl": "API Base URL",
    "connection.apiBaseUrl.placeholder": "http://localhost:4096",
    "connection.apiBaseUrl.description": "The base URL of your OpenCode server",
    "connection.username": "Username (optional)",
    "connection.username.placeholder": "opencode",
    "connection.username.description": "Leave empty to use default (opencode)",
    "connection.password": "Password",
    "connection.password.placeholder": "Enter password",
    "connection.password.description": "Your OpenCode server password",
    "connection.testConnection": "Test Connection",
    "connection.testing": "Testing...",
    "connection.success": "Connection successful!",
    "connection.failed": "Connection failed",

    // General tab
    "general.theme": "Theme",
    "general.theme.light": "Light",
    "general.theme.dark": "Dark",
    "general.theme.system": "System",
    "general.theme.description": "Choose your preferred theme",
    "general.language": "Language",
    "general.language.description": "Choose your preferred language",

    // About tab
    "about.version": "Version",
    "about.opencode": "OpenCode Server",
    "about.documentation": "Documentation",
    "about.github": "GitHub Repository",
    "about.copyright": "© 2026 Ultrawork. All rights reserved.",

    // Buttons
    "button.save": "Save Changes",
    "button.cancel": "Cancel",
    "button.reset": "Reset to Default",

    // Common
    "common.loading": "Loading...",
    "common.error": "Error",
  },
  zh: {
    // Settings
    "settings.title": "设置",
    "settings.description": "配置您的应用程序偏好",
    "settings.connection": "连接",
    "settings.general": "通用",
    "settings.about": "关于",

    // Connection tab
    "connection.apiBaseUrl": "API 基础 URL",
    "connection.apiBaseUrl.placeholder": "http://localhost:4096",
    "connection.apiBaseUrl.description": "您的 OpenCode 服务器的基础 URL",
    "connection.username": "用户名（可选）",
    "connection.username.placeholder": "opencode",
    "connection.username.description": "留空使用默认值（opencode）",
    "connection.password": "密码",
    "connection.password.placeholder": "输入密码",
    "connection.password.description": "您的 OpenCode 服务器密码",
    "connection.testConnection": "测试连接",
    "connection.testing": "测试中...",
    "connection.success": "连接成功！",
    "connection.failed": "连接失败",

    // General tab
    "general.theme": "主题",
    "general.theme.light": "浅色",
    "general.theme.dark": "深色",
    "general.theme.system": "跟随系统",
    "general.theme.description": "选择您喜欢的主题",
    "general.language": "语言",
    "general.language.description": "选择您喜欢的语言",

    // About tab
    "about.version": "版本",
    "about.opencode": "OpenCode 服务器",
    "about.documentation": "文档",
    "about.github": "GitHub 仓库",
    "about.copyright": "© 2026 Ultrawork. 保留所有权利。",

    // Buttons
    "button.save": "保存更改",
    "button.cancel": "取消",
    "button.reset": "重置为默认",

    // Common
    "common.loading": "加载中...",
    "common.error": "错误",
  },
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const { config, updateConfig } = useConfig()

  const setLanguage = (lang: Language) => {
    updateConfig({ language: lang })
  }

  const t = (key: string): string => {
    return translations[config.language]?.[key] || key
  }

  return (
    <I18nContext.Provider value={{ language: config.language, setLanguage, t }}>
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
