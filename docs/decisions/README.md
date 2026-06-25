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
| [027](./027-acp-multi-agent-backend.md) | ACP 多 Agent 后端支持 — 经 Agent Client Protocol 统一调度多 agent | 2026-05-25 / 2026-06-08 / 2026-06-10 | Accepted · **阶段0-1 已实现**（`@agent/acp-client` :4099，claude 达标；历史持久化/gemini/qoder 二期） |
| [029](./029-execution-flow-turn-grouping.md) | 主对话「执行流程」收纳 — 回合级消息分组与过程/答案分层 | 2026-06-06 | Accepted (✅ 已实现) |
| [030](./030-agent-connector-control-layer.md) | @agent/connector — 后端无关的控制 + 事件统一层（可插拔 backend：OpenCode REST / ACP / 其它，D-8 分类法） | 2026-06-08 · 06-09 修订 | Accepted（架构决策）· 实现规划中（阶段2，依赖 ADR-027） |
| [031](./031-multi-agent-orchestration.md) | 多 Agent 编排（档2 delegate）— orchestrator + spawn/steer 原语 + 编排模式 | 2026-06-08 | Accepted（架构决策）· 实现规划中（阶段3，依赖 ADR-027/030） |
| [032](./032-builtin-skills.md) | 内置技能打包与分发 — Apache-2.0/自写技能集 + 方案 C（拷贝到 configDir/builtin + sentinel）+ 依赖检测不打包 + 设置页三区 | 2026-06-14 | Accepted · 已实现（端到端为手动验证项） |
| [033](./033-artifact-capture-and-pdf-preview.md) | 产物识别改用文件系统真相（mtime 扫描，捕获 bash 副作用）+ 产物/工作文件分类 + PDF 内嵌预览（pdf.js + scope-free `read_file_bytes`） | 2026-06-16 | Accepted (✅ 已实现) |
| [034](./034-llm-stream-idle-guard.md) | LLM 流式 idle 看门狗（工具感知两级超时，opencode `llm.ts` + ACP `prompt()` 对称）— 根治静默挂死导致的会话死锁 | 2026-06-24 | Accepted (✅ 已实现，两侧 headless 验证) |
| [035](./035-delegate-owner-session-scoping.md) | 委派 owner-session 归属（`DelegateRecord.ownerSessionId`，ACP per-session env / opencode `_meta` vendor patch 双通道）— DelegateDock 按发起会话精确过滤，根治同 workspace 多 Team 委派串显 | 2026-06-25 | Accepted (✅ 已实现，运行时+源码双验证) |

> ADR-027 的探索过程见 [discussions/013](../discussions/013-agent-os-acp-multi-backend.md)（架构可行性）与 [discussions/014](../discussions/014-stage1-acp-normalization-plan.md)（阶段1 实现方案）。阶段0-1 已按 B2「参考重写」在 `feat/agent-os-phase0` 分支落地（旧 `feat/acp-support` MVP 弃用）；实测坑点固化在 [gotchas §8](../gotchas.md)。

## 新增 ADR

1. 复制模板到 `NNN-short-name.md`
2. 填写各段落
3. 更新本 README 索引表
