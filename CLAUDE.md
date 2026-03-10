# Ultrawork — Claude Code Instructions

## 自动加载的上下文

每次 session 启动时，Claude Code 自动读取以下三个文件：

| 文件 | 内容 |
|------|------|
| **本文件 (CLAUDE.md)** | 工作流程指令 |
| **AGENTS.md** | 项目概览、包结构、API 摘要 |
| **.claude/memory/MEMORY.md** | 环境变量、API 类型细节、已知坑点、当前状态 |

以下文件**不会自动加载**，需要在相关任务开始前主动 Read：

| 文件 | 何时需要 |
|------|---------|
| `docs/conventions.md` | 写新组件/修改状态管理/处理 SSE 时 |
| `docs/architecture-phase1.md` | 理解系统架构、模块职责时 |
| `docs/api-reference.md` | 调用 OpenCode API、排查请求格式时 |
| `docs/decisions/README.md` | 需要了解某个技术选型的背景时 |
| `docs/requirements.md` | 确认功能需求和验收标准时 |
| `docs/testing.md` | 编写或运行测试时 |
| `docs/document-map.md` | 找不到某个文档在哪时 |

---

## Session 开始流程

当用户开始一个新的开发任务时：

### 1. 判断任务类型，按需加载上下文

| 任务类型 | 需要额外 Read 的文件 |
|----------|---------------------|
| 新建 UI 组件 | `docs/conventions.md`（组件模式、状态管理约定） |
| 修改 SSE/消息流 | `docs/conventions.md` §3 + §5 |
| 调用 OpenCode API | `docs/api-reference.md` |
| 修改 Gateway/Channel | MEMORY.md §Gateway 已自动加载，够用 |
| 架构层变更 | `docs/architecture-phase1.md` + 相关 ADR |
| 修复 Bug | 先定位文件，再按涉及模块选读 |
| 全新功能/跨模块 | `docs/conventions.md` + `docs/architecture-phase1.md` |

### 2. 检查当前状态

MEMORY.md 的 `## Current Status` 已自动加载，无需额外操作。

### 3. 如果用户没说明上下文

主动问一句：「这次要做什么？我根据任务类型加载对应文档。」

---

## 开发过程中

### 发现新模式/坑点时
**写到 MEMORY.md 的 `## New Patterns (pending sync)` staging 区**（一行摘要即可）。
不要直接改 `docs/conventions.md`——等任务收尾时统一整理。

### 做了重大技术选型时
记下来，任务收尾时写 ADR。开发中不必停下来写。

---

## 任务收尾流程

用户说「收尾」「wrap up」或类似指令时，按顺序执行：

### Step 1: 同步 conventions.md
1. 读取 MEMORY.md 的 `## New Patterns (pending sync)` 区域
2. 如果有新条目：
   - 将每条模式格式化为完整描述（含代码示例），追加到 `docs/conventions.md` 对应章节
   - 如果不属于任何现有章节，在末尾新增章节
   - 更新 `docs/conventions.md` 顶部的 `<!-- last-synced: YYYY-MM-DD -->` 标记
   - 清空 MEMORY.md 的 staging 区（保留注释模板）
3. 如果没有新条目，跳过

### Step 2: 更新 CHANGELOG.md
在 `## [Unreleased]` 下追加本次任务变更摘要（Added/Changed/Fixed）。
- 条目格式：`#issue-number: 描述`（如有关联 Issue）

### Step 3: 更新 MEMORY.md
- 更新 `## Current Status` 区域，标记本次任务完成
- 如果有新的 Key Files 或 API 发现，更新对应 section

### Step 4: 新建 ADR（如有架构决策）
在 `docs/decisions/` 新建 ADR 文件，更新 `docs/decisions/README.md` 索引。

### Step 5: 输出收尾摘要
告诉用户本次任务做了什么文档更新，例如：
> 收尾完成：conventions.md 新增 2 条模式、CHANGELOG 已更新、新建 ADR-016。

---

## 通用约定

- 用中文交流（当用户用中文时）
- 所有脚本用 `bun run --bun`，不要用 `npx` 或系统 Node.js
- TypeCheck：`bun run --bun turbo run typecheck`
- 测试：见 `docs/getting-started.md`
- 健康检查端点：`/global/health`（不是 `/health`）
- Gateway 修改后需 `bun run build:gateway` 重编译
- Commit message 格式：`fix(#42): 描述` / `feat(#42): 描述`（关联 Issue 时在 scope 中写 `#issue-number`）
