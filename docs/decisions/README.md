# Architecture Decision Records (ADR)

本目录记录 Ultrawork 项目中的关键架构决策。每个 ADR 描述一个重要的技术选择、其背景、考虑过的替代方案和后果。

## 格式

每个 ADR 遵循统一模板：

```markdown
# ADR-NNN: 标题

**状态**: Accepted | Superseded | Deprecated
**日期**: YYYY-MM-DD
**关联轮次**: Round N / Phase N

## 背景
为什么需要做这个决策？

## 决策
选择了什么方案？

## 考虑过的替代方案
还考虑过哪些方案？为什么没选？

## 后果
这个决策带来了哪些影响（正面和负面）？
```

## 索引

| # | 标题 | 轮次 | 状态 |
|---|------|------|------|
| [001](./001-tauri-react.md) | Tauri 2 + React 19 技术选型 | Phase 1 | Accepted |
| [002](./002-opencode-sidecar.md) | OpenCode Headless Sidecar | Phase 1 | Accepted |
| [003](./003-shadcn-tailwind.md) | shadcn/ui + Tailwind CSS 4 | Phase 2 | Accepted |
| [004](./004-structured-message-parts.md) | 结构化消息 7 Part Types | Round 2 | Accepted |
| [005](./005-permission-question-dock.md) | Permission & Question Dock | Round 3 | Accepted |
| [006](./006-model-management.md) | 模型管理独立 Dialog | Round 4 | Accepted |
| [007](./007-workspace-isolation.md) | 工作区目录隔离 | Round 5 | Accepted |
| [008](./008-sse-global-polling-fallback.md) | SSE 全局化 + 轮询兜底 | Round 5 | Accepted |
| [009](./009-artifact-preview-split.md) | 产物预览 50/50 分屏 | Round 7 | Accepted |
| [010](./010-shared-hook-pattern.md) | 共享 Hook 提取模式 | Round 10 | Accepted |
| [011](./011-mcp-localstorage-persistence.md) | MCP 状态 localStorage 持久化 | Round 11 | Superseded (→ opencode.json, Issue#18) |
| [012](./012-optimistic-message-active-tracking.md) | 乐观消息 + 活跃状态追踪 | Round 12 | Accepted |
| [013](./013-channel-gateway-sidecar.md) | Channel Gateway 独立 Sidecar | Round 13 | Accepted (✅ 已实现) |
| [014](./014-dingtalk-stream-sdk.md) | DingTalk Stream SDK 选型 | Round 13 | Accepted (✅ 已实现) |
| [015](./015-dark-mode-codemirror.md) | 深色模式 + CodeMirror 6 | Round 15 | Accepted |
| [016](./016-browser-mcp-node-detection.md) | Browser MCP — 检测 Node.js + 按需安装 | 2026-03-15 | Accepted |
| [017](./017-browser-mcp-dual-mode.md) | Browser MCP 双模式 — Playwright 默认 + DevTools 可选 | 2026-03-17 | Accepted |
| [018](./018-wechat-channel-ilink.md) | 微信 Channel — ilink 协议接入 | 2026-03-24 | Accepted (Phase 1+2 实现) |
| [019](./019-knowledge-base-integration.md) | 知识库集成 — IMA 优先 + MCP 架构 | 2026-03-31 | Withdrawn |
| [020](./020-config-isolation.md) | Ultrawork 与 OpenCode 配置隔离 | 2026-04-20 | Accepted (✅ 已实现) |
| [021](./021-long-session-performance.md) | 长对话性能优化 — 渐进式渲染与分页加载 | 2026-04-23 | Accepted (✅ 已实现) |
| [022](./022-model-switch-side-effects.md) | 运行时模型切换的副作用分析与修复 | 2026-04-24 | Accepted |
| [023](./023-titlebar-overlay.md) | macOS 标题栏 Overlay 模式 | 2026-05-08 | Accepted |
| [024](./024-workspace-path-display.md) | 工作目录路径展示优化 | 2026-05-12 | Accepted (✅ 已实现) |
| [025](./025-window-layout-symmetry.md) | 窗口布局对称性修复与平台感知适配 | 2026-05-12 | Accepted |
| [026](./026-knowledge-base-architecture.md) | 知识库能力架构 — 本地 RAG + 第三方平台 + 自定义 API | 2026-05-13 | Accepted (Phase 1-3 + 4a + 4c 实现) |
| [028](./028-release-readiness-hardening.md) | 发布前 readiness 硬化 — sidecar 副本 / 凭证随机化 / 安全收紧 / MCP 启动性能 | 2026-05-28 | Accepted |
| 027 | ACP 多 Agent 支持（占位） | 2026-05-25 | Pending（在 `feat/acp-support` 分支，未合并 main） |
| [029](./029-execution-flow-turn-grouping.md) | 主对话「执行流程」收纳 — 回合级消息分组与过程/答案分层 | 2026-06-06 | Accepted (✅ 已实现) |

> ADR-027 编号为 `feat/acp-support` 分支预留（ACP 多 Agent 架构）。该分支合并 main 后补正式 ADR 文件；在此之前 main 上无 027 文件，索引中以上方占位行保持编号连续。

## 新增 ADR

1. 复制模板到 `NNN-short-name.md`
2. 填写各段落
3. 更新本 README 索引表
