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
    // Brand
    "brand.name": "UltraWork",

    // Sidebar
    "sidebar.newTask": "New Task",
    "sidebar.search": "Search",
    "sidebar.scheduled": "Scheduled Tasks",
    "sidebar.custom": "Custom",
    "sidebar.searchPlaceholder": "Search sessions...",
    "sidebar.noMatch": "No matching sessions",
    "sidebar.noSessions": "No sessions yet",
    "sidebar.user": "User",

    // Settings popover
    "settingsPopover.general": "General Settings",
    "settingsPopover.language": "Language",
    "settingsPopover.models": "Model Management",
    "settingsPopover.workspace": "Workspace",
    "settingsPopover.channels": "Channels",
    "settingsPopover.remote": "Remote Services",
    "settingsPopover.help": "Help Docs",
    "settingsPopover.about": "About",

    // Home
    "home.headline": "Chat & Work, Simple & Easy",
    "home.subtitle": "Your AI-powered productivity assistant",
    "home.startNow": "Start Now",
    "home.card.files": "File Organization",
    "home.card.files.desc": "Automatically sort, rename and organize your files",
    "home.card.content": "Content Creation",
    "home.card.content.desc": "Generate articles, emails and creative content",
    "home.card.docs": "Document Processing",
    "home.card.docs.desc": "Analyze, summarize and transform documents",

    // Settings page
    "settingsPage.title": "Settings",
    "settingsPage.general": "General",
    "settingsPage.privacy": "Privacy",
    "settingsPage.capabilities": "Capabilities",
    "settingsPage.privacy.title": "Data & Privacy",
    "settingsPage.privacy.desc": "Manage your data and privacy settings. Your data is processed locally and never shared without your consent.",
    "settingsPage.capabilities.title": "Connection Settings",

    // Session right sidebar
    "session.rightSidebar.plan": "Plan Progress",
    "session.rightSidebar.workspace": "Workspace",
    "session.rightSidebar.artifacts": "Artifacts",
    "session.rightSidebar.mcp": "MCP Services",
    "session.rightSidebar.skills": "Skills",

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

    // Date groups
    "dateGroup.today": "Today",
    "dateGroup.yesterday": "Yesterday",
    "dateGroup.thisWeek": "This Week",
    "dateGroup.earlier": "Earlier",

    // Session menu
    "session.pin": "Pin",
    "session.unpin": "Unpin",
    "session.rename": "Rename",
    "session.delete": "Delete",
    "session.sessions": "Sessions",

    // Connection status
    "connectionStatus.connected": "Connected",
    "connectionStatus.disconnected": "Disconnected",

    // Time
    "time.justNow": "just now",
    "time.mAgo": "{n}m ago",
    "time.hAgo": "{n}h ago",
    "time.dAgo": "{n}d ago",

    // Placeholders
    "placeholder.comingSoon": "Coming soon",
    "placeholder.comingInRound2": "Coming in Round 2",
    "placeholder.privacyComingSoon": "More privacy settings coming soon.",
    "placeholder.sendMessage": "Send a message to start chatting",

    // Message parts
    "message.reasoning": "Thought Process",
    "message.toolCall": "Tool Call",
    "message.tokensInput": "In",
    "message.tokensOutput": "Out",
    "message.tokensReasoning": "Reasoning",
    "message.executionWorking": "Working on it...",
    "message.executionDone": "Execution complete",
    "message.executionError": "Execution failed",
    "message.stopExecution": "Stop",
    "message.progressTitle": "Plan Progress",
    "message.artifactsTitle": "Artifacts",
    "message.workspaceTitle": "Workspace",
    "message.workingDirectory": "Working Directory",
    "message.noArtifacts": "No artifacts yet",
    "message.noSteps": "No steps yet",

    // Permission dock
    "permission.title": "Permission Required",
    "permission.description": "The agent needs your permission to proceed with this action.",
    "permission.allowOnce": "Allow Once",
    "permission.allowAlways": "Always Allow",
    "permission.reject": "Reject",

    // Question dock
    "question.title": "Question",
    "question.submit": "Submit",
    "question.dismiss": "Dismiss",
    "question.next": "Next",
    "question.back": "Back",
    "question.customInput": "Or type a custom answer...",

    // Common
    "common.loading": "Loading...",
    "common.error": "Error",
  },
  zh: {
    // Brand
    "brand.name": "UltraWork",

    // Sidebar
    "sidebar.newTask": "新建任务",
    "sidebar.search": "搜索",
    "sidebar.scheduled": "定时任务",
    "sidebar.custom": "自定义",
    "sidebar.searchPlaceholder": "搜索会话...",
    "sidebar.noMatch": "没有匹配的会话",
    "sidebar.noSessions": "暂无会话",
    "sidebar.user": "用户",

    // Settings popover
    "settingsPopover.general": "通用设置",
    "settingsPopover.language": "语言",
    "settingsPopover.models": "模型管理",
    "settingsPopover.workspace": "工作区",
    "settingsPopover.channels": "渠道",
    "settingsPopover.remote": "远程服务",
    "settingsPopover.help": "帮助文档",
    "settingsPopover.about": "关于",

    // Home
    "home.headline": "聊天办公，简单轻松",
    "home.subtitle": "AI 驱动的智能办公助手",
    "home.startNow": "马上开始",
    "home.card.files": "文件整理",
    "home.card.files.desc": "自动分类、重命名和整理您的文件",
    "home.card.content": "内容创作",
    "home.card.content.desc": "生成文章、邮件和创意内容",
    "home.card.docs": "文档处理",
    "home.card.docs.desc": "分析、总结和转换各类文档",

    // Settings page
    "settingsPage.title": "设置",
    "settingsPage.general": "通用",
    "settingsPage.privacy": "隐私",
    "settingsPage.capabilities": "能力配置",
    "settingsPage.privacy.title": "数据与隐私",
    "settingsPage.privacy.desc": "管理您的数据和隐私设置。您的数据在本地处理，未经您的同意不会共享。",
    "settingsPage.capabilities.title": "连接设置",

    // Session right sidebar
    "session.rightSidebar.plan": "计划执行进度",
    "session.rightSidebar.workspace": "工作区",
    "session.rightSidebar.artifacts": "产物",
    "session.rightSidebar.mcp": "MCP服务",
    "session.rightSidebar.skills": "技能",

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

    // Date groups
    "dateGroup.today": "今天",
    "dateGroup.yesterday": "昨天",
    "dateGroup.thisWeek": "本周",
    "dateGroup.earlier": "更早",

    // Session menu
    "session.pin": "置顶",
    "session.unpin": "取消置顶",
    "session.rename": "重命名",
    "session.delete": "删除",
    "session.sessions": "会话",

    // Connection status
    "connectionStatus.connected": "已连接",
    "connectionStatus.disconnected": "未连接",

    // Time
    "time.justNow": "刚刚",
    "time.mAgo": "{n}分钟前",
    "time.hAgo": "{n}小时前",
    "time.dAgo": "{n}天前",

    // Placeholders
    "placeholder.comingSoon": "即将推出",
    "placeholder.comingInRound2": "Round 2 开发中",
    "placeholder.privacyComingSoon": "更多隐私设置即将推出。",
    "placeholder.sendMessage": "发送消息开始聊天",

    // Message parts
    "message.reasoning": "思考过程",
    "message.toolCall": "工具调用",
    "message.tokensInput": "输入",
    "message.tokensOutput": "输出",
    "message.tokensReasoning": "推理",
    "message.executionWorking": "正在执行...",
    "message.executionDone": "执行完成",
    "message.executionError": "执行失败",
    "message.stopExecution": "停止",
    "message.progressTitle": "计划执行进度",
    "message.artifactsTitle": "产物",
    "message.workspaceTitle": "工作区",
    "message.workingDirectory": "工作目录",
    "message.noArtifacts": "暂无产物",
    "message.noSteps": "暂无步骤",

    // Permission dock
    "permission.title": "需要授权",
    "permission.description": "Agent 需要您的授权才能执行此操作。",
    "permission.allowOnce": "允许一次",
    "permission.allowAlways": "始终允许",
    "permission.reject": "拒绝",

    // Question dock
    "question.title": "提问",
    "question.submit": "提交",
    "question.dismiss": "取消",
    "question.next": "下一个",
    "question.back": "返回",
    "question.customInput": "或输入自定义答案...",

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
