import { createContext, useContext, useCallback, useMemo } from "react"
import { useConfig } from "./config-context"

type Language = "en" | "zh"

interface I18nContextValue {
  language: Language
  setLanguage: (lang: Language) => void
  t: (key: string, params?: Record<string, string | number>) => string
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
    "settingsPopover.skills": "Skills",

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
    "home.card.files.prompt": "Help me organize and sort files in my folder",
    "home.card.content.prompt": "Help me write an article or email",
    "home.card.docs.prompt": "Help me analyze and summarize a document",

    // Settings page
    "settingsPage.title": "Settings",
    "settingsPage.general": "General",
    "settingsPage.privacy": "Privacy",
    "settingsPage.capabilities": "Capabilities",
    "settingsPage.about": "About",
    "settingsPage.privacy.title": "Data & Privacy",
    "settingsPage.privacy.desc": "Manage your data and privacy settings. Your data is processed locally and never shared without your consent.",
    "settingsPage.services": "Services",
    "settingsPage.channels": "Channels",
    "settingsPage.skills": "Skills",
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

    // About section
    "about.version": "Version",
    "about.build": "Build",
    "about.author": "Author",
    "about.copyright": "Copyright",
    "about.license": "License",
    "about.copyrightValue": "© 2026 Ultrawork. All rights reserved.",
    "about.licenseValue": "UltraWork Community License",
    "about.subtitle": "Desktop AI Agent",
    "about.checkUpdate": "Check for Updates",
    "about.website": "Website",
    "about.sourceCode": "Source Code",
    "about.community": "Community",
    "about.followUs": "Follow Us",
    "about.feedback": "Report Issues",
    "about.poweredBy": "Powered by OpenCode",
    "about.opencode": "OpenCode Server",
    "about.documentation": "Documentation",
    "about.github": "GitHub Repository",

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
    "message.executionStopped": "Execution stopped",
    "message.progressTitle": "Plan Progress",
    "message.artifactsTitle": "Artifacts",
    "message.workspaceTitle": "Workspace",
    "message.workingDirectory": "Working Directory",
    "message.noArtifacts": "No artifacts yet",
    "message.noSteps": "No steps yet",
    "message.aiTyping": "AI is typing...",
    "message.loadingMessages": "Loading messages...",

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

    // Model management
    "model.noModel": "No model",
    "model.selectModel": "Select Model",
    "model.noModels": "No models available",
    "model.manage": "Manage Models",
    "model.dialogTitle": "Model Management",
    "model.searchPlaceholder": "Search providers and models...",
    "model.noProviders": "No matching providers",
    "model.enabled": "Enabled",
    "model.modelsConnected": "models connected",
    "model.apiKeySet": "Key set",
    "model.mInput": "M in",
    "model.mOutput": "M out",
    "model.moreModels": "more models",
    "model.addProvider.success": "Provider configured successfully",
    "model.addProvider.error": "Failed to configure provider",
    "model.configureProvider": "Configure Provider",
    "model.configureProvider.selectHint": "Select a provider to configure API key and connection settings",
    "model.configureProvider.change": "Change",
    "model.configureProvider.envHint": "Or set environment variable",
    "model.configureProvider.optional": "optional",
    "model.modelsAvailable": "models",
    "model.switchSuccess": "Model switched",

    // Services page
    "services.title": "Remote Services",
    "services.description": "Manage MCP servers that extend agent capabilities.",
    "services.connected": "connected",
    "services.serverName": "Server Name",
    "services.serverType": "Server Type",
    "services.serverUrl": "Server URL",
    "services.serverCommand": "Command",

    // Channel
    "channel.title": "Channels",
    "channel.description": "Connect messaging platforms (DingTalk, etc.) to interact with the AI agent.",
    "channel.connected": "connected",
    "channel.noChannels": "No channels configured",
    "channel.addChannel": "Add Channel",
    "channel.add": "Add",
    "channel.connect": "Connect",
    "channel.disconnect": "Disconnect",
    "channel.remove": "Remove",
    "channel.type": "Channel Type",
    "channel.type.dingtalk": "DingTalk",
    "channel.name": "Channel Name",
    "channel.namePlaceholder": "e.g. My DingTalk Bot",
    "channel.clientId": "Client ID (AppKey)",
    "channel.clientIdPlaceholder": "DingTalk app Client ID",
    "channel.clientSecret": "Client Secret (AppSecret)",
    "channel.clientSecretPlaceholder": "DingTalk app Client Secret",
    "channel.workspaceDir": "Workspace Directory",
    "channel.workspaceDirPlaceholder": "/path/to/project",
    "channel.autoConnect": "Auto Connect",
    "channel.state.connected": "Connected",
    "channel.state.connecting": "Connecting",
    "channel.state.disconnected": "Disconnected",
    "channel.state.error": "Error",
    "channel.error.add": "Failed to add channel",
    "channel.error.remove": "Failed to remove channel",
    "channel.error.connect": "Failed to connect channel",
    "channel.error.disconnect": "Failed to disconnect channel",
    "channel.error.fetch": "Failed to load channels. Is the gateway running?",

    // MCP
    "mcp.noServers": "No MCP servers configured",
    "mcp.addServer": "Add MCP Server",
    "mcp.connected": "Connected",
    "mcp.disabled": "Disabled",
    "mcp.failed": "Failed",
    "mcp.needsAuth": "Auth required",
    "mcp.connect": "Connect",
    "mcp.disconnect": "Disconnect",
    "mcp.namePlaceholder": "Server name",
    "mcp.typeRemote": "Remote",
    "mcp.typeLocal": "Local",
    "mcp.add": "Add",
    "mcp.remove": "Remove",
    "mcp.hintBunx": "Local servers: use bunx instead of npx (e.g. bunx --bun @mcp/server)",
    "mcp.browser.title": "Browser Control",
    "mcp.browser.desc": "Let AI browse, screenshot, and interact with web pages",
    "mcp.browser.noNode": "Node.js (v20+) required for browser features",
    "mcp.browser.noNodeHint": "Install from nodejs.org, then restart the app",
    "mcp.browser.enable": "Enable Browser",
    "mcp.browser.installing": "Installing...",
    "mcp.browser.installed": "Installed",
    "mcp.browser.checking": "Checking...",
    "mcp.browser.nodeVersion": "Node.js {version}",
    "mcp.browser.chromeDetected": "Chrome detected",
    "mcp.browser.chromeNotDetected": "Chrome not found (will auto-download)",
    "mcp.browser.retry": "Retry",
    "mcp.browser.builtin": "Built-in",

    // Skills / Commands
    "skills.noItems": "No skills available",
    "skills.empty": "No skills available. Add skills in Settings.",
    "skills.manage": "Manage Skills",
    "skills.group.command": "Built-in",
    "skills.group.mcp": "MCP",
    "skills.group.skill": "Project Skills",
    "skills.settingsTitle": "Skills",
    "skills.settingsDescription": "Manage commands and skills that extend agent capabilities.",
    "skills.searchPlaceholder": "Search skills...",
    "skills.noSearchResults": "No matching skills",
    "skills.source.command": "Built-in",
    "skills.source.mcp": "MCP",
    "skills.source.skill": "Project",
    "skills.configTitle": "Skills Configuration",
    "skills.pathsLabel": "Skills Loading Paths",
    "skills.pathsDescription": "Directories where SKILL.md files are discovered.",
    "skills.pathPlaceholder": "~/.claude/skills/my-skills",
    "skills.addPath": "Add",
    "skills.urlsLabel": "Remote Skills URLs",
    "skills.urlsDescription": "Remote URLs for skill discovery.",
    "skills.urlPlaceholder": "https://example.com/skills",
    "skills.addUrl": "Add",
    "skills.configSaved": "Skills configuration saved",
    "skills.configError": "Failed to save skills configuration",
    "skills.configNote": "Click refresh after saving to load new skills.",
    "command.title": "Commands",

    // Artifact preview
    "artifact.preview": "Preview",
    "artifact.close": "Close Preview",
    "artifact.loading": "Loading...",
    "artifact.loadError": "Failed to load",
    "artifact.noContent": "No content",
    "artifact.noChanges": "No changes",
    "artifact.diff": "Diff",

    // Workspace selector
    "workspace.selectTitle": "Select Workspace",
    "workspace.selectSubtitle": "All session artifacts will be saved in this directory",
    "workspace.current": "Current workspace",
    "workspace.continue": "Continue",
    "workspace.recent": "Recent",
    "workspace.selectNew": "Select New Folder",
    "workspace.removeRecent": "Remove from recent",
    "workspace.awaitingAgent": "Waiting for Agent to generate files...",

    // Workspace file tree
    "workspace.fileTree": "File Tree",
    "workspace.gitModified": "Modified",
    "workspace.gitAdded": "Added",
    "workspace.gitDeleted": "Deleted",
    "workspace.loadError": "Failed to load file tree",
    "workspace.emptyDir": "Empty directory",
    "workspace.filesChanged": "files changed",

    // Errors
    "error.switchModel": "Failed to switch model",
    "error.sendMessage": "Failed to send message",
    "error.loadMessages": "Failed to load messages",
    "error.createSession": "Failed to create session. Please check your connection.",
    "error.replyPermission": "Failed to reply permission",
    "error.replyQuestion": "Failed to reply question",
    "error.rejectQuestion": "Failed to reject question",
    "error.fetchMCP": "Failed to load MCP servers",
    "error.mcpToggle": "MCP operation failed",
    "error.addMCP": "Failed to add MCP server",
    "error.fetchSkills": "Failed to load commands/skills",

    // Additional labels
    "model.addProvider.baseUrl": "Base URL",
    "model.addProvider.apiKey": "API Key",
    "session.newChat": "New Chat",
    "placeholder.reply": "Reply...",
    "placeholder.askAnything": "Ask anything...",
    "workspace.refresh": "Refresh",
    "aria.attachment": "Add attachment",
    "aria.sendMessage": "Send message",
    "aria.stopGenerating": "Stop generating",
    "aria.toggleSidebar": "Toggle right sidebar",

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
    "settingsPopover.skills": "技能管理",

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
    "home.card.files.prompt": "帮我整理和分类文件夹中的文件",
    "home.card.content.prompt": "帮我写一篇文章或邮件",
    "home.card.docs.prompt": "帮我分析和总结一份文档",

    // Settings page
    "settingsPage.title": "设置",
    "settingsPage.general": "通用",
    "settingsPage.privacy": "隐私",
    "settingsPage.capabilities": "能力配置",
    "settingsPage.about": "关于",
    "settingsPage.privacy.title": "数据与隐私",
    "settingsPage.privacy.desc": "管理您的数据和隐私设置。您的数据在本地处理，未经您的同意不会共享。",
    "settingsPage.services": "服务",
    "settingsPage.channels": "渠道",
    "settingsPage.skills": "技能",
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

    // About section
    "about.version": "版本",
    "about.build": "构建",
    "about.author": "作者",
    "about.copyright": "版权",
    "about.license": "许可证",
    "about.copyrightValue": "© 2026 Ultrawork. 保留所有权利。",
    "about.licenseValue": "UltraWork Community License",
    "about.subtitle": "桌面通用 Agent",
    "about.checkUpdate": "检查更新",
    "about.website": "官网",
    "about.sourceCode": "查看源码",
    "about.community": "加入社区",
    "about.followUs": "关注我们",
    "about.feedback": "反馈问题",
    "about.poweredBy": "部分组件使用 OpenCode 构建",
    "about.opencode": "OpenCode 服务器",
    "about.documentation": "文档",
    "about.github": "GitHub 仓库",

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
    "message.executionStopped": "执行已中断",
    "message.progressTitle": "计划执行进度",
    "message.artifactsTitle": "产物",
    "message.workspaceTitle": "工作区",
    "message.workingDirectory": "工作目录",
    "message.noArtifacts": "暂无产物",
    "message.noSteps": "暂无步骤",
    "message.aiTyping": "AI 正在输入...",
    "message.loadingMessages": "加载消息中...",

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

    // Model management
    "model.noModel": "未选择模型",
    "model.selectModel": "选择模型",
    "model.noModels": "暂无可用模型",
    "model.manage": "管理模型",
    "model.dialogTitle": "模型管理",
    "model.searchPlaceholder": "搜索供应商和模型...",
    "model.noProviders": "没有匹配的供应商",
    "model.enabled": "已启用",
    "model.modelsConnected": "个模型已连接",
    "model.apiKeySet": "已配置",
    "model.mInput": "M 输入",
    "model.mOutput": "M 输出",
    "model.moreModels": "个更多模型",
    "model.addProvider.success": "供应商配置已保存",
    "model.addProvider.error": "配置供应商失败",
    "model.configureProvider": "配置供应商",
    "model.configureProvider.selectHint": "选择一个供应商，配置 API 密钥和连接设置",
    "model.configureProvider.change": "更换",
    "model.configureProvider.envHint": "或设置环境变量",
    "model.configureProvider.optional": "可选",
    "model.modelsAvailable": "个模型",
    "model.switchSuccess": "模型已切换",

    // Services page
    "services.title": "远程服务",
    "services.description": "管理 MCP 服务，扩展 Agent 的能力。",
    "services.connected": "已连接",
    "services.serverName": "服务名称",
    "services.serverType": "服务类型",
    "services.serverUrl": "服务 URL",
    "services.serverCommand": "命令",

    // Channel
    "channel.title": "渠道",
    "channel.description": "连接消息平台（钉钉等）与 AI Agent 交互。",
    "channel.connected": "已连接",
    "channel.noChannels": "未配置渠道",
    "channel.addChannel": "添加渠道",
    "channel.add": "添加",
    "channel.connect": "连接",
    "channel.disconnect": "断开",
    "channel.remove": "删除",
    "channel.type": "渠道类型",
    "channel.type.dingtalk": "钉钉",
    "channel.name": "渠道名称",
    "channel.namePlaceholder": "例如 我的钉钉机器人",
    "channel.clientId": "Client ID (AppKey)",
    "channel.clientIdPlaceholder": "钉钉应用的 Client ID",
    "channel.clientSecret": "Client Secret (AppSecret)",
    "channel.clientSecretPlaceholder": "钉钉应用的 Client Secret",
    "channel.workspaceDir": "工作区目录",
    "channel.workspaceDirPlaceholder": "/path/to/project",
    "channel.autoConnect": "自动连接",
    "channel.state.connected": "已连接",
    "channel.state.connecting": "连接中",
    "channel.state.disconnected": "未连接",
    "channel.state.error": "错误",
    "channel.error.add": "添加渠道失败",
    "channel.error.remove": "删除渠道失败",
    "channel.error.connect": "连接渠道失败",
    "channel.error.disconnect": "断开渠道失败",
    "channel.error.fetch": "加载渠道失败，请检查 Gateway 是否运行。",

    // MCP
    "mcp.noServers": "未配置 MCP 服务",
    "mcp.addServer": "添加 MCP 服务",
    "mcp.connected": "已连接",
    "mcp.disabled": "已禁用",
    "mcp.failed": "连接失败",
    "mcp.needsAuth": "需要认证",
    "mcp.connect": "连接",
    "mcp.disconnect": "断开",
    "mcp.namePlaceholder": "服务名称",
    "mcp.typeRemote": "远程",
    "mcp.typeLocal": "本地",
    "mcp.add": "添加",
    "mcp.remove": "移除",
    "mcp.hintBunx": "本地服务：请用 bunx 代替 npx（如 bunx --bun @mcp/server）",
    "mcp.browser.title": "浏览器控制",
    "mcp.browser.desc": "让 AI 浏览网页、截图并与页面交互",
    "mcp.browser.noNode": "需要 Node.js (v20+) 才能使用浏览器功能",
    "mcp.browser.noNodeHint": "请从 nodejs.org 安装后重启应用",
    "mcp.browser.enable": "启用浏览器",
    "mcp.browser.installing": "安装中...",
    "mcp.browser.installed": "已安装",
    "mcp.browser.checking": "检测中...",
    "mcp.browser.nodeVersion": "Node.js {version}",
    "mcp.browser.chromeDetected": "已检测到 Chrome",
    "mcp.browser.chromeNotDetected": "未检测到 Chrome（将自动下载）",
    "mcp.browser.retry": "重试",
    "mcp.browser.builtin": "内置",

    // Skills / Commands
    "skills.noItems": "暂无技能",
    "skills.empty": "暂无可用技能，前往设置添加。",
    "skills.manage": "管理技能",
    "skills.group.command": "内置",
    "skills.group.mcp": "MCP",
    "skills.group.skill": "项目技能",
    "skills.settingsTitle": "技能",
    "skills.settingsDescription": "管理扩展 Agent 能力的命令和技能。",
    "skills.searchPlaceholder": "搜索技能...",
    "skills.noSearchResults": "没有匹配的技能",
    "skills.source.command": "内置",
    "skills.source.mcp": "MCP",
    "skills.source.skill": "项目",
    "skills.configTitle": "技能配置",
    "skills.pathsLabel": "技能加载目录",
    "skills.pathsDescription": "自动发现 SKILL.md 文件的目录。",
    "skills.pathPlaceholder": "~/.claude/skills/my-skills",
    "skills.addPath": "添加",
    "skills.urlsLabel": "远程技能源",
    "skills.urlsDescription": "远程技能发现 URL。",
    "skills.urlPlaceholder": "https://example.com/skills",
    "skills.addUrl": "添加",
    "skills.configSaved": "技能配置已保存",
    "skills.configError": "保存技能配置失败",
    "skills.configNote": "保存后点击刷新即可加载新技能。",
    "command.title": "命令",

    // Artifact preview
    "artifact.preview": "预览",
    "artifact.close": "关闭预览",
    "artifact.loading": "加载中...",
    "artifact.loadError": "加载失败",
    "artifact.noContent": "无内容",
    "artifact.noChanges": "暂无变更",
    "artifact.diff": "差异",

    // Workspace selector
    "workspace.selectTitle": "选择工作区",
    "workspace.selectSubtitle": "所有会话产物将保存在此目录",
    "workspace.current": "当前工作区",
    "workspace.continue": "继续使用",
    "workspace.recent": "最近使用",
    "workspace.selectNew": "选择新文件夹",
    "workspace.removeRecent": "从最近列表移除",
    "workspace.awaitingAgent": "等待 Agent 生成文件...",

    // Workspace file tree
    "workspace.fileTree": "文件树",
    "workspace.gitModified": "已修改",
    "workspace.gitAdded": "新增",
    "workspace.gitDeleted": "已删除",
    "workspace.loadError": "加载文件树失败",
    "workspace.emptyDir": "空目录",
    "workspace.filesChanged": "个文件变更",

    // Errors
    "error.switchModel": "切换模型失败",
    "error.sendMessage": "发送消息失败",
    "error.loadMessages": "加载消息失败",
    "error.createSession": "创建会话失败，请检查连接。",
    "error.replyPermission": "回复授权失败",
    "error.replyQuestion": "回复问题失败",
    "error.rejectQuestion": "拒绝问题失败",
    "error.fetchMCP": "加载 MCP 服务失败",
    "error.mcpToggle": "MCP 操作失败",
    "error.addMCP": "添加 MCP 服务失败",
    "error.fetchSkills": "加载命令/技能失败",

    // Additional labels
    "model.addProvider.apiKey": "API 密钥",
    "model.addProvider.baseUrl": "基础 URL",
    "session.newChat": "新对话",
    "placeholder.reply": "回复...",
    "placeholder.askAnything": "有什么可以帮到你...",
    "workspace.refresh": "刷新",
    "aria.attachment": "添加附件",
    "aria.sendMessage": "发送消息",
    "aria.stopGenerating": "停止生成",
    "aria.toggleSidebar": "切换右侧边栏",

    // Common
    "common.loading": "加载中...",
    "common.error": "错误",
  },
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
        value = value.replace(`{${k}}`, String(v))
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
