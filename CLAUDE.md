# Ultrawork — Claude Code Instructions

## 自动加载的上下文

每次 session 启动时，Claude Code 自动读取以下三个文件：

| 文件 | 内容 |
|------|------|
| **本文件 (CLAUDE.md)** | 工作流程指令 |
| **AGENTS.md** | 项目概览、包结构、API 摘要、关键文件地图 |
| **.claude/memory/MEMORY.md** | 索引 + 瞬时状态（环境、Current Status、Pending Issues、知识索引指针） |

以下文件**不会自动加载**，需要在相关任务开始前主动 Read：

| 文件 | 何时需要 |
|------|---------|
| `docs/conventions.md` | 写新组件/修改状态管理/处理 SSE 时（正向模式） |
| `docs/gotchas.md` | 调 OpenCode/MCP/Gateway/IMA/Tauri API 或排查诡异行为时（反向坑点，**强烈建议任务前必读对应章节**） |
| `docs/architecture-phase1.md` | 理解系统架构、模块职责时 |
| `docs/api-reference.md` | 调用 OpenCode API、排查请求格式时（端点 SSOT） |
| `docs/quality-gates.md` | 改动合入/收尾前对照完成定义时 |
| `docs/decisions/README.md` | 需要了解某个技术选型的背景时 |
| `docs/requirements.md` | 确认功能需求、实现状态与验收判据时 |
| `docs/testing.md` | 编写或运行测试时 |
| `docs/build-and-deploy.md` | 编译/打包/安装包时（**§〇 = macOS/Windows/Linux 三平台 dev+build 速查**；§二–§七 mac 签名公证；§八–§九 交叉编译与 CI） |
| `docs/vendor-patch-workflow.md` | **修改 `vendor/opencode/` 源码或 bump submodule 时（必读）**：patch 内容表 + 重新生成命令 + 自动化保障 |
| `docs/document-map.md` | 找不到某个文档在哪时 |

---

## Session 开始流程

当用户开始一个新的开发任务时：

### 1. 判断任务类型，按需加载上下文

| 任务类型 | 需要额外 Read 的文件 |
|----------|---------------------|
| 新建 UI 组件 | `docs/conventions.md`（组件模式、状态管理约定） |
| 修改 SSE/消息流 | `docs/conventions.md` §3 + §5 + `docs/gotchas.md` §1 |
| 调用 OpenCode API | `docs/api-reference.md` + `docs/gotchas.md` §1-2 |
| 修改 Gateway/Channel | `docs/gotchas.md` §4 + `AGENTS.md` §Key Files |
| 知识库/IMA | `docs/gotchas.md` §5 + ADR-026 |
| Tauri/桌面壳 | `docs/gotchas.md` §6 |
| 架构层变更 | `docs/architecture-phase1.md` + 相关 ADR |
| 修复 Bug | 先定位文件，再按涉及模块选读（含 `docs/gotchas.md`） |
| 全新功能/跨模块 | `docs/conventions.md` + `docs/architecture-phase1.md` |
| **涉及路径/进程/文件IO/外部命令/构建脚本/Rust** | `docs/conventions.md §13`（跨平台编码规范）+ `gotchas.md §12` —— 默认三平台兼容 |

### 2. 检查当前状态

MEMORY.md 的 `## Current Status` 已自动加载，无需额外操作。

### 3. 如果用户没说明上下文

主动问一句：「这次要做什么？我根据任务类型加载对应文档。」

---

## 记忆与文档分工（重要）

为保障"长期 + 团队"质量，知识按"是否稳定、是否团队需要"分流，**不要把稳定的团队知识只留在本地 MEMORY**（本地记忆不入 git、不可共享、不可评审）：

| 知识类型 | 落点 | 说明 |
|---------|------|------|
| 稳定的反向坑点 / 上游非直觉契约 | `docs/gotchas.md`（SSOT） | OpenCode/MCP/Gateway/IMA/Tauri/构建 |
| 正向开发模式 | `docs/conventions.md` | 状态管理、SSE、组件 |
| API 端点 | `docs/api-reference.md`（SSOT） | 其余处只放摘要 + 指针 |
| 关键文件地图 | `AGENTS.md` §Key Files | 每次自动加载且入 git |
| 架构决策 | `docs/decisions/NNN-*.md` | |
| **瞬时 / 个人 / 状态** | **MEMORY.md** | 环境、Current Status、staging、Pending Issues、偏好 |
| 分支专属 / 未合并 | auto-memory 专题文件 | 如 `acp-branch.md` |

**SSOT 原则**：每类事实指定唯一权威源，其余位置放"摘要 + 链接"，避免多副本各自漂移。高频救命项（bunx 不用 npx、路径相对、camelCase、`/global/health`）允许刻意冗余，但仍以 gotchas 为准。

## 开发过程中

### 发现新模式/坑点时
**先写到 MEMORY.md 的 `## New Patterns (pending sync)` staging 区**（一行摘要即可）。
不要开发中直接改 git 文档——等任务收尾时按上表分流：正向模式→`conventions.md`，反向坑点→`gotchas.md`，个人/瞬时→留 MEMORY。

### 做了重大技术选型时
记下来，任务收尾时写 ADR。开发中不必停下来写。

---

## 任务收尾流程

用户说「收尾」「wrap up」或类似指令时，按顺序执行：

### Step 1: 同步 staging 区（conventions.md / gotchas.md）
1. 读取 MEMORY.md 的 `## New Patterns (pending sync)` 区域
2. 如果有新条目，按"记忆与文档分工"表分流：
   - **正向模式** → 格式化（含代码示例）追加到 `docs/conventions.md` 对应章节
   - **反向坑点 / 上游契约** → 追加到 `docs/gotchas.md` 对应章节
   - 不属于现有章节则在末尾新增
   - 更新对应文件顶部的 `<!-- last-synced: YYYY-MM-DD -->` 标记
   - 清空 MEMORY.md 的 staging 区（保留注释模板）
3. 如果没有新条目，跳过

### Step 2: 更新 CHANGELOG.md
在 `## [Unreleased]` 下追加本次任务变更摘要（Added/Changed/Fixed）。
- 条目格式：`#issue-number: 描述`（如有关联 Issue）

### Step 3: 更新 MEMORY.md + 体检
- 更新 `## Current Status` 区域，标记本次任务完成
- 新的 Key Files → 写入 `AGENTS.md` §Key Files（不要堆回 MEMORY）；新 API 端点 → `docs/api-reference.md`
- **MEMORY 体检**（防膨胀，防地基被截断）：
  - 确认行数 **< 200**（`wc -l`）；逼近则把 detail 下沉到 git 文档或专题记忆文件，只留指针
  - 检查是否有"稳定 + 团队需要"的坑点滞留在 MEMORY 各 section → 固化到 `docs/gotchas.md`
  - 删除已失效 / 已纠错 / 已合并的条目（如分支专属内容合并后清理）

### Step 3.5: 文档漂移校验
运行 `bun run --bun scripts/check-docs.ts`，修复报告的漂移（ADR/分层计数、失效引用路径与 Markdown 链接、§N 章节号越界、版本号一致性、MEMORY 行数等；CI `docs` job 同跑兜底）。

### Step 4: 检查状态文档
如果本次任务涉及**模块状态变更**（新模块实现、功能完成、技术迁移等），检查并更新以下文档中的过时标记：

| 文档 | 检查内容 |
|------|---------|
| `docs/requirements.md` | 功能状态（`🔲→✅`、`[ ]→[x]`），已完成功能从"未实现"移到"已实现" |
| `docs/architecture-phase1.md` | 顶部状态表 + Module Overview + Feature Summary + Data Flow |
| `docs/decisions/README.md` | ADR 索引状态（新增条目、标记 Superseded 等） |
| `docs/document-map.md` | 文件计数、新增文档条目 |
| `docs/build-and-deploy.md` | 新 sidecar / 构建步骤变更 |
| `docs/testing.md` | 测试描述中引用的技术细节是否过时 |
| `docs/gotchas.md` | 引用的"已修复/已 patch"坑点是否仍准确（vendor 升级后尤其） |
| `AGENTS.md` | Key Files 地图、ADR 计数、包状态是否过时 |

> **判断标准**：如果只是 bug fix 或小改动，通常不需要更新状态文档。涉及新模块上线、持久化方案迁移、新 adapter 等里程碑式变更时才触发此步骤。

### Step 5: 新建 ADR（如有架构决策）
在 `docs/decisions/` 新建 ADR 文件，更新 `docs/decisions/README.md` 索引。

### Step 6: 输出收尾摘要
告诉用户本次任务做了什么文档更新，例如：
> 收尾完成：conventions.md 新增 2 条模式、CHANGELOG 已更新、新建 ADR-016。

---

## 通用约定

- 用中文交流（当用户用中文时）
- **跨平台默认要求（macOS / Windows / Linux，ADR-037）**：本项目要在三平台打包可安装软件，**所有新特性/改动默认必须三平台兼容**——不硬编码 `/` 拼路径（用 `path.join`/`PathBuf::join`）、不用 `process.env.HOME`（用 `os.homedir()`）、不硬编码 `/tmp`/`:`(PATH 分隔符)、不调 unix-only 命令（`lsof`/`ps`/`pgrep`/`which`/`open`/`/bin/sh` 等）未做平台分支；renderer（`.tsx`）路径用 `@/lib/path-utils`（WebView 无 `node:path`）；Rust 优先运行时 `if cfg!(target_os=…)` 分支而非 `#[cfg]` 属性（本机 `cargo check` 才能验全分支）。正向模式 → `docs/conventions.md §13`；反向坑 → `gotchas.md §12`；收尾对照 `quality-gates.md §2` 跨平台自检。**强制门禁 = CI**（`.github/workflows/ci.yml` 三平台 typecheck+test+`cargo test`）——本机改完无法验 Windows，靠 CI 兜底。
- 所有脚本用 `bun run --bun`，不要用 `npx` 或系统 Node.js
- TypeCheck：`bun run --bun turbo run typecheck`
- 测试：见 `docs/getting-started.md`
- 健康检查端点：`/global/health`（不是 `/health`）
- Gateway 修改后需 `bun run build:gateway` 重编译
- Commit message 格式：`fix(#42): 描述` / `feat(#42): 描述`（关联 Issue 时在 scope 中写 `#issue-number`）

---


## Vendor Patch（vendor/opencode）— 核心规则

**动 `vendor/opencode/` 源码前必读 `docs/vendor-patch-workflow.md`**（patch 内容表、重新生成 patch 的完整命令、submodule 更新流程、自动化保障）。常驻三条铁律：

1. **不要直接 commit 到 submodule**——所有 vendor 修改经 `patches/vendor-opencode-config-fix.patch` 管理（重新生成时必须列全涉及文件，新文件先 `git add -N`）
2. `vendor/opencode (modified content)` 是正常状态；patch 后重编译 `bun run --bun scripts/build-opencode.ts`
3. patch 文件提交主仓库，submodule 指针只在 bump upstream 时动
