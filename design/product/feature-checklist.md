# 备注版本

[https://muserender.antgroup-inc.cn/app/acgmphgbp13r](https://muserender.antgroup-inc.cn/app/acgmphgbp13r)

> **实现状态标注 (2026-03-09)**
> - ✅ 已实现
> - 🔲 未实现（规划中）
> - ⚠️ 部分实现

# 引导

（首次安装后展示，工作目录预设）：🔲 整体未实现

*   用户名 🔲

*   常用的工作场景 🔲

*   根据选择的工作场景推荐prompt，一键执行 🔲

*   工作目录预设 ⚠️ 有 WorkspaceSelector 页面，但非引导流程

# 主会话区

*   输入框内推荐的提示语轮播（依据工作场景），Tab键输入 🔲

*   工作目录选择（切换）? ✅ WorkspaceSelector 页面

*   文件/图片/音频/文本-上传【第一版本】 🔲

*   点击+

    *   MCP(enabled list 和 管理入口)【第一版本】 ✅ MCP Panel + 右侧栏管理

    *   plugins(enabled list 和 管理入口)【第一版本】 🔲

    *   skills（(enabled list 和 管理入口)）【第一版本】 ✅ Skills Panel 按来源分组 + 点击填入 + Settings 技能管理

*   模型切换（思考模式选择）【第一版本】 ✅ ModelSelector Popover

    *   预置模型【第一版本】 ✅ Provider 列表 + TTL 缓存

    *   快速配置Provider入口【第一版本】 ✅ ModelDialog + AddProviderDialog


# 任务执行过程

*   执行节点过程展示：默认展示，执行完成后收缩，支持手动展开和收缩【第一版本】 ✅

    *   think【第一版本】 ✅ ReasoningBlock (collapsible)

    *   search【第一版本】 ✅ ToolCallBlock

    *   execute等【第一版本】 ✅ ToolCallBlock (7 种 Part 类型)

*   过程交互

    *   执行过程给出按钮或者复选框让用户选择 ✅ QuestionDock (单选/多选)

    *   权限类的弹窗 ✅ PermissionDock (once/always/reject)

    *   支持input ✅ QuestionDock 支持自由输入

*   右侧边栏

    *   process

        *   plan及执行进度 ✅ ProgressPanel

    *   产出物preview   【第一版本】 ✅ ArtifactsPanel + ArtifactPreview

        *   过程产物preview【第一版本】 ✅ 产物列表实时更新

        *   最终产物preview【第一版本】 ✅ 50/50 split-screen (code/md/image/diff)

        *   支持快速访问（website html、pdf/ppt/md/codes）【第一版本】 ⚠️ 支持代码/MD/图片/Diff预览，不支持 website/pdf/ppt

        *   支持打开工作目录【第一版本】 ✅ WorkspacePanel 文件树 + Git 状态

    *   context（使用到）

        *   skills的列表及执行结果 ✅ SkillsPanel 按来源分组

        *   MCP的列表及执行结果 ✅ MCPPanel 连接/断开/状态

        *   plugins的列表及执行结果 🔲

*   支持分享、停止【第一版本】、过程暂停及恢复
    *   停止 ✅ ExecutionStatus + frozen message 保护
    *   分享 🔲
    *   暂停及恢复 🔲

# 左边栏

*   新建任务【第一版本】 ✅ New Chat 按钮 + Home 页发送

*   搜索 🔲

*   定时任务 🔲 已隐藏（依赖 Proactive Cron 服务）

*   定制 ⚠️

    *   skills ✅ SkillsPanel + Settings 技能管理页（列表、搜索、分组、路径/URL配置）

        *   列表、详情、执行、开关、搜索 ⚠️ 有列表/搜索/点击填入，无详情/开关

        *   新建、编辑 🔲

    *   MCPs ✅ MCPPanel + Settings 远程服务页（ServiceCard + ServiceAddForm）

        *   列表、详情、连接开关、搜索 ⚠️ 有列表/连接开关，无详情/搜索

    *   plugins 🔲

        *   列表、详情、新建、搜索 🔲

    *   Personal (个性化，主动性， 记忆， Agent.md) 🔲

*   定时任务最近5条执行历史（滚动查看更多）【第一版本】 🔲 已隐藏

    *   置顶running的定时任务【第一版本】 🔲

*   最近10条任务（滚动查看更多）【第一版本】 ✅ Session 列表（按日期分组，滚动加载）

    *   置顶running的任务【第一版本】 ✅ activeSessionIds 真实活跃状态追踪

    *   更多操作：收藏、重命名、删除【第一版本】 ⚠️ 有删除，收藏有 hook 未接入 UI，重命名未实现


# 左上角：

*   左边栏展开开关【第一版本】 ✅ Sidebar 折叠/展开

*   页面前进、后退【第一版本】 ⚠️ 有 Logo 点击导航回首页，无浏览器式前进后退按钮


# 右上角：

*   右边栏展开开关【第一版本】 ✅ TopBar 右侧栏切换按钮（5 个 tab）

*   问题反馈 🔲

*   Token用量 🔲 StepIndicator 显示 token 统计但非全局用量面板


# 左下角：

*   头像【第一版本】 ✅ Avatar 占位

*   昵称【第一版本】 ✅ 显示用户名

*   点击任何区域：【第一版本】 ✅ SettingsPopover 弹出菜单

    *   设置：【第一版本】 ✅ Settings 完整页面

        *   通用（general）【第一版本】 ⚠️

            *   全称【第一版本】 🔲

            *   昵称【第一版本】 🔲

            *   工作场景【第一版本】 🔲

            *   回复偏好（您的偏好将适用于所有对话） 🔲

            *   开机自启动 🔲

            *   后台运行控制 🔲

            *   桌面通知 🔲

            *   主题风格 ✅ light/dark/system 三种模式

                *   深色、浅色、跟随系统 ✅

            *   chat字体 🔲

        *   隐私 🔲

            *   数据保护、使用条款链接 🔲

            *   数据导入、导出（工作目录、对话、用户） 🔲

            *   会话共享 🔲

            *   记忆偏好 🔲

        *   能力配置 🔲

            *   从聊天记录生成记忆  -开关 🔲

            *   导入、导出记忆 🔲

            *   工具访问模式 （控制连接器工具在新对话中加载的方式） 🔲

    *   语言切换（中英等）【第一版本】 ✅ SettingsPopover 语言子菜单 + Settings 通用页

    *   工作目录（配置代码环境和工作目录） ⚠️ WorkspaceSelector 选择页面，无 Settings 内管理页

        *   列表及编辑 🔲

        *   沙盒、本机选择 🔲

    *   模型（供应商）【第一版本】 ✅ ModelDialog 完整管理

        *   默认模型及供应商【第一版本】 ✅

        *   供应商及模型（包括参数）自定义【第一版本】 ✅ AddProviderDialog + API Key 配置

    *   消息通道（channels）【第一版本】 🔲 Round 13 规划完成

        *   预置钉钉【第一版本】 🔲 Round 13 规划完成 (dingtalk-stream WebSocket + 独立 Gateway sidecar + Settings Channels 页面)
        *   飞书、企业微信配置入口 🔲 架构预留接口

    *   远程服务连接 ✅ Settings 远程服务页面 (ServiceCard + ServiceAddForm)

    *   帮助文档【第一版本】 ✅ 外部浏览器打开（Tauri opener 插件）

        *   链接【第一版本】 ✅

    *   关于我们【第一版本】 ✅ About 页面

        *   版本信息【第一版本】 ✅

        *   版本更新 🔲

        *   官网链接 ✅

        *   问题反馈 🔲
