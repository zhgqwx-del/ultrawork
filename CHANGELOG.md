# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

<!-- Round 1-18 使用线性编号；此后改用 GitHub Issue# 标识（如 #42: 描述） -->

## [Unreleased]

### Fixed
- 运行时模型切换后 `sending` 状态卡住导致输入框永久禁用（`server.instance.disposed` 事件重置状态）
- `session.error` SSE 事件未处理，后端 API 错误（鉴权失败、额度不足等）静默吞掉无提示

### Added
- ADR-022: 运行时模型切换的副作用分析与修复

### Removed
- 移除 IMA MCP Server POC 代码（`packages/knowledge/ima-mcp/`）及 workspace2 MCP 配置，ADR-019 标记为 Withdrawn

### Added
- ADR-021: 长对话性能优化 — React.memo 全消息组件 + CSS content-visibility + 分页加载(limit=80) + 历史窗口(15轮初始/8轮backfill) + "加载更早消息"按钮
- `useSessionMessages` hook：从 Session.tsx 提取消息状态 + SSE 处理 + 历史窗口 + 发送/停止
- `useSessionPermission` hook：从 Session.tsx 提取权限/问题处理 + 轮询 fallback
- `useSessionScroll` hook：智能滚动管理（markAuto/isAuto 区分 + ResizeObserver + settle 延迟 + passive 事件 + overflow-anchor）
- `api-client`: `requestWithResponse()` 基础方法 + `getMessagesPaginated()` 分页接口 + `PaginatedMessagesResponse` 类型
- `scripts/test-long-session.ts`：长对话生成测试脚本
- `scripts/sync-plugin-version.ts`：vendor/opencode 更新后自动同步 `PINNED_PLUGIN_VERSION` + 重新生成 patch 文件
- `package.json` 新增 `sync:plugin-version` 脚本

### Changed
- Session.tsx 从 763 行瘦身为 252 行组装层，核心逻辑拆分到 3 个 hook
- `assistant-message.tsx`: MARKDOWN_COMPONENTS 提取到模块顶层，FileBlock/PatchBlock 拆为独立 memo 组件
- `workspaceRefreshKey` 从 O(n×m) useMemo 改为 SSE 增量计数器
- 消息初始加载改用分页 API（limit=80），仅渲染最近 15 轮

### Fixed
- Gateway Bridge stale session：sidecar 重启后旧 session-map 映射失效导致渠道消息无回复。新增 `getSession` 主动验证 + 自动重建 session；新增 `session.error` SSE 事件处理作为兜底
- `build-gateway.ts`：bun ≥1.3.12 编译的 gateway 二进制缺少签名导致 macOS SIGKILL，构建后自动 ad-hoc 签名（与 `build-opencode.ts` 对齐）
- Gateway Bridge 即时确认（⏳）延迟：将 ack 移到 session 验证之前发送，避免网络调用阻塞用户反馈
- opencode sidecar 每次启动都触发 npm reify：`installDependencies` 将 `@opencode-ai/plugin` 版本固定为 `1.3.13` + 添加快速路径（已安装则跳过），消除启动时的无效网络请求
- `build-opencode.ts`：bun ≥1.3.12 编译产物缺少签名导致 Apple Silicon SIGKILL，构建后自动 ad-hoc 签名；签名失败时报错退出（不再静默复制无效二进制）；用 mtime 区分 smoke test 失败与真实编译错误

### Changed
- 微信 Channel（Phase 1）：ilink 协议接入，扫码登录 + 文本收发 + 语音 STT
- 微信 Channel（Phase 2）：侧边栏渠道状态指示器 + 打字指示器
- 微信 QR 登录 UI：Settings → Channels → 添加微信 → 二维码扫码 → 自动连接
- 渠道类型选择：添加渠道改为下拉菜单（钉钉 / 微信）
- Gateway QR API：`POST /channel/wechat/qrcode` + `GET /channel/wechat/qrcode-status`
- ChannelConfig 联合类型：`DingTalkChannelConfig | WeChatChannelConfig`，支持不同渠道不同配置字段
- Bridge 动态渠道前缀：session 标题自动加 `[微信·xxx]` 或 `[钉钉·xxx]`
- 侧边栏渠道状态：展开模式显示 连接数/总数 + 状态点，折叠模式显示状态图标，点击跳转 Settings

- 钉钉 Channel 即时确认：收到消息立刻回复 `⏳ 收到，正在处理`
- 钉钉 Channel Session 命名：AI 回复后自动加 `[钉钉·用户名]` 前缀，侧边栏可区分来源
- 钉钉 Channel `/new` 指令：重置当前聊天 session，开启新对话
- Session 映射持久化：chatId→sessionId 写入 `~/.ultrawork/session-map.json`，gateway 重启后自动恢复
- 侧边栏实时更新：通过 SSE 订阅 `session.updated` 事件，钉钉新建/更新 session 实时反映

### Changed
- vendor/opencode 子模块更新至 `8e9e79d`（2026-04-03 dev），获取最新模型列表（含 qwen3.6-plus-free 等新模型）
- vendor patch 文件更新以匹配新版代码结构

- Bridge queue 清理：完成后自动删除 entry，防止内存泄漏
- Bridge poll timer 超时保护：5 分钟自动停止，防止 session 卡住时无限轮询
- Bridge shutdown 时先 flush 待发消息再清理，避免用户收不到回复

- 工作区自动恢复：启动时自动恢复上次工作区，无需每次手动确认
- 默认工作区：首次安装自动创建 `~/.ultrawork/workspace/`，零配置即可使用
- Tauri commands: `ensure_default_workspace`, `check_directory_exists`
- 全新品牌 Logo：等轴测水晶棱镜设计（靛蓝→青色渐变），替换旧版字母 "U" 图标
- Logo React 组件 `<Logo />`（`useId` 避免多实例 gradient ID 冲突），用于侧边栏 + Settings 关于页
- 全平台应用图标更新：PNG/ICO/ICNS/iOS/Android 全尺寸（via `@tauri-apps/cli icon`）
- Logo 设计源文件：`design/logo/` (SVG + 1024px PNG + 预览 HTML)
- Browser MCP 双模式架构：按需下载 Node.js v22 + 默认 Playwright MCP（标准）+ 可选 chrome-devtools-mcp（高级），DMG 零增量
- 按需下载 Node.js：首次启用浏览器时从 nodejs.org 下载 (~45MB)，strip 优化，后续复用
- Tauri commands: `download_node`, `detect_browser_env`, `install_playwright_mcp`, `install_devtools_mcp`, `get/set_browser_mode`, `kill_browser_mcp_processes`
- 设置页 + sidebar 双入口模式切换 UI（标准/高级），安装过程 toast 分阶段反馈（下载→安装→注册）
- 浏览器进程清理：模式切换时自动清理 Chrome 子进程，防止"会话锁定"
- 产物面板：MCP 工具产物提取（input 参数 + output 文本），过滤 temp 路径和 data URI

### Changed
- MCP 服务持久化从 localStorage 迁移到 `opencode.json`：通过 Tauri command 直接读写工作区配置文件，OpenCode 重启后自动连接，不依赖 WebView 缓存（含浏览器 MCP 自动恢复）
- Tauri commands 新增: `read_mcp_config`, `write_mcp_config`, `remove_mcp_config`
- MCP 服务页面文案统一为「MCP 服务」（原「远程服务」「服务」不一致）
- 隐藏面向开发者的内置命令 `/init`、`/review`，普通用户不再看到（skills-panel + command-selector + Settings 页统一过滤）
- 任务追踪从线性 Round 编号迁移到 GitHub Issue# 标识，支持多人并行开发
- CLAUDE.md 收尾流程从「轮次收尾」改为「任务收尾」，conventions.md last-synced 改用日期格式
- document-map.md 标注 `.claude/memory/` 为本地文件（不入 git），新增维护规则说明
- CHANGELOG 新条目格式改为 `#issue-number: 描述`
- 新增 commit message 约定：`fix(#42): 描述` 格式

### Fixed
- setup.sh 新 clone 后 build:opencode 失败 — vendor/opencode 依赖未安装导致 `@opentui/solid/preload` 解析失败
- build-opencode.ts `Bun.file().size()` 应为属性访问 `.size`，修复 bun 1.3.10 兼容性
- Round 18: vendor/opencode submodule 指向本地 commit 导致同事 clone 失败 — 重置到上游 commit + patch 管理
- Round 18: core 包 `tsc --noEmit` 与 `composite: true` 冲突，新环境无 `.d.ts` 导致 typecheck 失败 — 改为 `tsc --build`
- Round 18: `.gitignore` 补充 `opencode.json`（本地配置）和 `*.tsbuildinfo`（构建缓存）
- Round 17: DMG 打包后渠道页面无法加载 — Gateway 缺少 CORS 支持 + 前端 production 下未使用绝对 URL

## [0.1.0] - 2026-03-09

### Added
- Round 15: 深色模式统一纯黑 (#000000) + CodeMirror 6 产物预览（17 语言包）
- Round 14: Channel UX 优化 — 自动工作区/模型同步/自动连接/启动加速
- Round 13: 钉钉 Channel Gateway — dingtalk-stream WebSocket + 独立 sidecar + Desktop UI
- Round 12: 新建会话乐观消息 + Sidebar 真实活跃状态追踪
- Round 11: 技能面板增强 — useSkills hook + 分组面板 + Settings 管理
- Round 10: 远程服务设置页面 — useMCPServers hook + ServicesSection
- Round 8: 技术债清理 — Provider 缓存/SSE 重连/React key 修复
- Round 7: 产物预览优化 + MCP bunx 提示
- Round 5: 工作区管理 — WorkspaceSelector + x-opencode-directory + SSE 全局化
- Round 4: 模型管理 + MCP/Slash Commands + 文件产物预览
- Round 3: Permission Dock + Question Dock
- Round 2: 结构化消息渲染（7 Part types）+ 执行状态 + 进度面板
- Round 1: UI 架构重构对齐设计稿
- Round 0: Error Boundary + Toast + 环境修复
- Phase 2: 完整 UI 体验（布局/消息/SSE/设置/会话管理）
- Phase 1: MVP — Tauri sidecar + 基础聊天

### Fixed
- Round 15: Bridge SSE 竞态修复 + idle 超时兜底 + webhook 过期 fallback
- Round 9: 16+5 缺陷修复（竞态/闭包/内存泄漏/状态管理）

### Tests
- 236/236 单元测试通过 (Gateway 113 + Desktop 123)
- TypeCheck 4/4 通过
- 手动测试 E1-E10 + U1-U12 + M1-M4 + C1-C4 = 30 项通过
