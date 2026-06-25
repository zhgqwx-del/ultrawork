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
| 修改 SSE/消息流 | `docs/conventions.md` §3 + §5 + `docs/gotchas.md` §1 |
| 调用 OpenCode API | `docs/api-reference.md` + `docs/gotchas.md` §1-2 |
| 修改 Gateway/Channel | `docs/gotchas.md` §4 + `AGENTS.md` §Key Files |
| 知识库/IMA | `docs/gotchas.md` §5 + ADR-026 |
| Tauri/桌面壳 | `docs/gotchas.md` §6 |
| 架构层变更 | `docs/architecture-phase1.md` + 相关 ADR |
| 修复 Bug | 先定位文件，再按涉及模块选读（含 `docs/gotchas.md`） |
| 全新功能/跨模块 | `docs/conventions.md` + `docs/architecture-phase1.md` |

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
运行 `bun run --bun scripts/check-docs.ts`，修复报告的漂移（ADR 计数、失效引用路径、MEMORY 行数等）。

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
- 所有脚本用 `bun run --bun`，不要用 `npx` 或系统 Node.js
- TypeCheck：`bun run --bun turbo run typecheck`
- 测试：见 `docs/getting-started.md`
- 健康检查端点：`/global/health`（不是 `/health`）
- Gateway 修改后需 `bun run build:gateway` 重编译
- Commit message 格式：`fix(#42): 描述` / `feat(#42): 描述`（关联 Issue 时在 scope 中写 `#issue-number`）

---

## Vendor Patch 管理（vendor/opencode）

`vendor/opencode` 是 git submodule，Ultrawork 在其基础上有**本地 patch**（配置隔离、bug 修复等）。Patch 以 `.patch` 文件形式存储在 `patches/` 目录，由构建脚本自动 apply。

### 核心规则

1. **不要直接 commit 到 submodule**——所有对 `vendor/opencode/` 的源码修改必须通过 patch 文件管理
2. **Patch 文件是 git 跟踪的**——`patches/vendor-opencode-config-fix.patch` 提交在主仓库
3. **Submodule 本身保持指向 upstream commit**——`vendor/opencode (modified content)` 是正常状态

### 当前 patch 内容

`patches/vendor-opencode-config-fix.patch` 包含所有 vendor 修改（单文件累加）：

| 文件 | 修改内容 | 关联 ADR |
|------|---------|---------|
| `global/index.ts` | `OPENCODE_APP_NAME` env var 控制 app 名称 | ADR-020 |
| `config/config.ts` | managed dir 对齐 + endsWith 过滤 + PINNED_PLUGIN_VERSION + config.json→opencode.json 修复 | ADR-020 |
| `config/paths.ts` | 跳过 `~/.opencode/` home 目录搜索 | ADR-020 |
| `mcp/index.ts` | ① MCP 启动握手超时拆为 `CONNECT_TIMEOUT = 5s`（runtime tool 仍 30s）② MCP 工具 execute 把 `options.experimental_context.sessionID` 注入 `callTool` 的 `_meta.ultrawork_session`（委派归属，discussions/022） | ADR-028 / 022 |
| `script/build.ts` | 新增 `--target=<os>-<arch>` 单目标过滤，支持跨编译 darwin-x64（Universal DMG） | ADR-028 |
| `session/llm.ts` | ① `idleGuard`：LLM 流式工具感知两级 idle 超时（首字前 90s/后 30s，`Set<toolCallId>` 豁免工具执行，触发 abort+plain Error 落 error 终态）② streamText `experimental_context:{sessionID}` 暴露给工具 execute（委派归属，discussions/022） | ADR-034 / 022 |

### 修改 vendor/opencode 的完整流程

#### 新增 / 修改 patch

```bash
# 1. 直接编辑 vendor/opencode 下的源码
vim vendor/opencode/packages/opencode/src/...

# 2. 重新生成 patch 文件（覆盖旧的）
#    ⚠️ 必须列全 patch 涉及的所有文件，漏掉任何一个都会在重新生成时丢失对应改动
cd vendor/opencode && git diff -- \
  packages/opencode/src/config/config.ts \
  packages/opencode/src/config/paths.ts \
  packages/opencode/src/global/index.ts \
  packages/opencode/src/mcp/index.ts \
  packages/opencode/src/session/llm.ts \
  packages/opencode/script/build.ts \
  > ../../patches/vendor-opencode-config-fix.patch

# 3. 如果新增了文件，在上面的 git diff 命令中追加路径
# 4. 重编译 sidecar
bun run --bun scripts/build-opencode.ts

# 5. 提交 patch 文件（不提交 submodule 变更）
git add patches/vendor-opencode-config-fix.patch
```

#### 更新 vendor/opencode submodule

```bash
# 1. 拉取 upstream 新版本
cd vendor/opencode && git fetch origin dev && git checkout <new-commit> && cd ../..

# 2. 运行同步脚本（auto-apply patch + 更新 PINNED_PLUGIN_VERSION + 重新生成 patch）
bun run scripts/sync-plugin-version.ts

# 3. 如果 patch apply 失败（upstream 改了 patch 涉及的代码）：
#    - 手动在 vendor 源码中解决冲突
#    - 重新生成 patch 文件（见上方步骤 2）
#    - 重新运行 sync-plugin-version.ts

# 4. 重编译 sidecar
bun run --bun scripts/build-opencode.ts

# 5. 提交
git add vendor/opencode patches/vendor-opencode-config-fix.patch
```

### 自动化保障

| 入口 | 行为 |
|------|------|
| `setup.sh` 第 3 步 | 自动 apply `patches/vendor-opencode-*.patch`（`git apply --check` 幂等） |
| `scripts/build-opencode.ts` | 编译前检测 sentinel，未 apply 则自动 apply（双重保障） |
| `scripts/sync-plugin-version.ts` | submodule 更新后运行，重新 apply + 更新版本 + 重新生成 patch |

**其他人 clone 后只需 `./setup.sh` 即可**——submodule init + patch apply + build 全自动。
