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

## 新增 ADR

1. 复制模板到 `NNN-short-name.md`
2. 填写各段落
3. 更新本 README 索引表
