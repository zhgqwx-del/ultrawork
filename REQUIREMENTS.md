# UltraWork 需求文档

## 产品定位

UltraWork（无影）是一款桌面 AI Agent 应用，基于 OpenCode Server 作为 sidecar 后端，提供智能对话、工具执行、文件操作等能力。

## 参考项目

- [OpenCode](https://github.com/anomalyco/opencode) — 核心依赖，作为 sidecar server 提供 agent 能力（REST API + SSE 事件流）
- [WorkAny](https://github.com/workany-ai/workany) — 交互设计参考
- 交互设计稿：`product-uxd-design/` 目录（HTML 原型 + 功能清单 + Figma 原型图）

## 技术栈

| 层级 | 技术 |
|------|------|
| Desktop Shell | Tauri 2 (Rust) |
| 前端框架 | React 19 |
| 构建工具 | Vite 7 |
| 样式 | Tailwind CSS 4 |
| UI 组件 | shadcn/ui (Radix + Tailwind) |
| 包管理 | Bun (monorepo + workspaces) |
| 构建编排 | Turborepo |
| 后端 | OpenCode Server (Go, 编译为 sidecar binary) |
| 状态管理 | React Context |
| 路由 | react-router-dom v7 |
| 国际化 | 自研 i18n (I18nProvider + `t()`) |

## 架构

详见 `docs/architecture-phase1.md`。

Monorepo 结构：

| 包 | 路径 | 状态 | 说明 |
|----|------|------|------|
| `@agent/api-client` | `packages/core/api-client` | ✅ 已实现 | OpenCode REST/SSE SDK |
| `@agent/server-manager` | `packages/core/server-manager` | ✅ 已实现 | Sidecar 进程管理 |
| `@agent/client-desktop` | `packages/client/desktop` | ✅ 已实现 | Tauri 桌面应用 |
| `@agent/connector` | `packages/core/connector` | 🔲 规划中 | 连接抽象层 |
| `@agent/ui` | `packages/core/ui` | 🔲 规划中 | 共享组件库（当前组件在 desktop 内） |
| `@agent/workspace` | `packages/core/workspace` | 🔲 规划中 | ~/.ultrawork/ 目录管理 |
| `@agent/notifier` | `packages/core/notifier` | 🔲 规划中 | 通知分发 |
| `@agent/channel-gateway` | `packages/channel/gateway` | 🔲 Round 13 规划完成 | IM 集成网关（钉钉 Stream Mode，独立 sidecar 进程 :4097） |
| `@agent/proactive-heartbeat` | `packages/proactive/heartbeat` | 🔲 规划中 | 心跳服务 |
| `@agent/proactive-cron` | `packages/proactive/cron` | 🔲 规划中 | 定时任务服务 |

## Phase 1 已实现功能 (Round 0 ~ Round 12)

### 核心聊天

- [x] SSE 实时流式消息渲染
- [x] 结构化消息渲染（7 种 Part：Text、Reasoning、ToolCall、StepFinish、Patch、File、Image）
- [x] 执行状态显示（working/done/error/stopped）
- [x] 停止执行 + frozen message 保护
- [x] Permission Dock（权限授权）
- [x] Question Dock（agent 提问，单选/多选）
- [x] Slash Commands（/init、/review）
- [x] 乐观消息（新建会话即时显示用户消息）
- [x] 中文输入法 composing 处理

### 模型管理

- [x] ModelDialog（Provider 添加/API Key 配置）
- [x] ModelSelector（快速切换模型 Popover）
- [x] ModelProvider（全局模型状态 Context）
- [x] prompt_async model override（运行时模型切换）
- [x] Provider 列表 TTL 缓存（5 分钟）

### 会话管理

- [x] 会话列表（按日期分组：今天/昨天/更早）
- [x] 会话创建/删除
- [x] 会话真实活跃状态追踪（activeSessionIds）
- [x] SSE 全局化（SSEProvider app 级单连接）
- [x] SSE 心跳超时自动重连

### 工作区管理

- [x] WorkspaceSelector 选择页面
- [x] `x-opencode-directory` header 传递工作目录
- [x] Session 按目录隔离

### 右侧栏

- [x] Progress Panel（进度面板）
- [x] Artifacts Panel（产物面板，点击预览）
- [x] Workspace Panel（文件树 + Git 状态）
- [x] MCP Panel（MCP 服务器管理 + 连接/断开）
- [x] Skills Panel（按来源分组 + 点击填入 + 管理入口）
- [x] ArtifactPreview（50/50 split-screen 文件预览：代码/MD/图片/Diff）

### 设置

- [x] SettingsPopover 快捷菜单（主题/语言子菜单/帮助/技能/远程服务/关于）
- [x] Settings 完整页面（通用/模型/远程服务/技能管理/关于）
- [x] 主题切换（light/dark/system）
- [x] 语言切换（中/英）
- [x] About 页面（版本信息/官网链接）
- [x] 帮助文档（外部浏览器打开）

### 布局

- [x] 三栏布局：左侧栏(w-72/w-14 双态) + 主内容 + 右侧栏(w-80)
- [x] TopBar（导航/右侧栏切换）
- [x] 品牌设计（Logo/名称/渐变色）
- [x] Error Boundary + Toast 通知

### 基础设施

- [x] Tauri sidecar 自动启动 + Basic Auth
- [x] Vite 代理 15+ 路由到 localhost:4096
- [x] TypeScript 严格类型检查
- [x] 47 项单元测试
- [x] Tauri opener 插件（外部链接）
- [x] MCP 状态 localStorage 持久化
- [x] vendor opencode.json patch + sidecar 重编译

## Phase 1 未实现功能（规划中）

- [ ] 引导流程（首次安装用户名/工作场景/工作目录预设）
- [ ] 文件/图片/音频上传
- [ ] 输入框推荐提示语轮播
- [ ] Plugins 面板
- [ ] 搜索（会话搜索）
- [ ] 定时任务（已隐藏，依赖 Proactive Cron 服务）
- [ ] 定制面板（Personal 个性化/记忆/Agent.md）
- [ ] 收藏/重命名功能
- [ ] Settings 隐私/能力配置页
- [ ] Settings 工作目录管理页
- [ ] 渠道(Channels)配置 — Round 13 规划完成: 钉钉企业内部机器人 (dingtalk-stream WebSocket)
- [ ] IM Channel Gateway — Round 13 规划完成: 独立 sidecar 进程 + Hono HTTP API + Bridge 会话桥接
- [ ] Desktop Channels 设置页面 — Round 13 规划完成: ChannelsSection + use-channels hook
- [ ] Sidecar 启动健壮性 — Round 13 规划完成: 端口冲突检测 + 残留清理
- [ ] Agent Workspace (~/.ultrawork/ 目录，IDENTITY/SOUL/MEMORY)
- [ ] Proactive Services（Heartbeat/Cron）
- [ ] System Tray / 后台常驻
- [ ] OS Keychain 凭证存储

## Phase 2 规划: 钉钉 Channel (Round 13)

### 目标

实现钉钉企业内部机器人接入，用户可通过钉钉单聊/群聊与 OpenCode Agent 交互。

### 技术方案

| 项目 | 选型 |
|------|------|
| SDK | `dingtalk-stream` v2.1.4 (WebSocket Stream Mode, 无需公网 IP) |
| Gateway 进程 | 独立 sidecar (bun build --compile, :4097) |
| HTTP 框架 | Hono (轻量 ~14KB) |
| 会话桥接 | Bridge (chatId→sessionId 映射 + Sequential Queue + SSE 订阅) |
| 生命周期 | 与桌面端同生同死 (Tauri 托管)，后续 System Tray 演进为 7×24 |

### 实施步骤 (7 步)

1. **Step 0.5**: Sidecar 启动健壮性 (端口检测 + 残留清理)
2. **Step 1**: `@agent/channel-gateway` 包骨架
3. **Step 2**: 核心类型 + ChannelManager
4. **Step 3**: Bridge 会话桥接层
5. **Step 4**: DingTalk Adapter (dingtalk-stream SDK)
6. **Step 5**: Gateway Server + Sidecar 集成
7. **Step 6**: Desktop UI Channels 页面 (Settings + use-channels hook)

### 参考项目

- [openwork/opencode-router](https://github.com/different-ai/openwork/tree/dev/packages/opencode-router) — Bridge 架构参考
- [nanobot/channels](https://github.com/HKUDS/nanobot/tree/main/nanobot/channels) — DingTalk adapter 参考

详见 `.claude/.../memory/dingtalk-channel-plan.md`。

## 开发进度

详见 `PROGRESS.md`。
