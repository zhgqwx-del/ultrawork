# Changelog

All notable changes to this project will be documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

<!-- Round 1-18 使用线性编号；此后改用 GitHub Issue# 标识（如 #42: 描述） -->

## [Unreleased]

### Added
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
