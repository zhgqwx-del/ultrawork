# Discussion 007: OpenCode 内置工具全景调研 — 功能、使用场景、实现路径

- **日期**: 2026-06-04
- **状态**: 调研记录（仅分析，无代码改动）
- **参与者**: 用户 + Claude
- **范围**: 基于 `vendor/opencode/packages/opencode/src/tool/` 源码（submodule，已 apply Ultrawork patch）

> 本文系统梳理 OpenCode server 提供给 LLM 的**内置工具（built-in tools）**：每个工具是什么、参数、执行流程、使用场景、启用条件，以及它们背后的统一框架（注册、权限、截断、模型适配）。
>
> 所有结论均带源码定位（`文件:行号`，文件相对 `vendor/opencode/packages/opencode/src/tool/`），可直接跳读核对。

---

## TL;DR

1. **工具不是静态清单，而是「按 client + 模型 + flag + 配置」动态过滤出来的**。注册中心 `registry.ts` 维护一个候选列表，再根据当前 provider、模型 ID、实验 flag、`opencode.json` 配置裁剪。Ultrawork 是 desktop client，所以 `question` 工具默认开启。
2. **同一类能力会按模型分流**。`edit`/`write` 与 `apply_patch` **互斥**：GPT 系列（非 oss、非 gpt-4）走 `apply_patch`，其余模型（Claude 等）走 `edit`/`write`（`registry.ts:169-175`）。Ultrawork 默认用的模型走 `edit`/`write` 路径。
3. **每个工具共享一套统一框架**：`Tool.define()` 做参数校验 + 自动输出截断（2000 行 / 50KB，超出落盘并提示用 Task+Grep 处理），`ctx.ask()` 做权限挂起，`ctx.metadata()` 做实时状态回传。理解这套框架比逐个背工具更重要（§1、§5）。
4. **`multiedit` 和 `plan_enter` 有源文件但当前未被注册**——不在 `registry.ts` 的候选列表里，LLM 实际拿不到（§4.6）。
5. **`codesearch`/`websearch`/`webfetch` 是联网工具**，前两者依赖 Exa API 且需 `providerID===opencode` 或 `OPENCODE_ENABLE_EXA`；`lsp` 是实验工具需 flag（§3）。

---

## 1. 工具框架：所有内置工具的共同骨架

在看具体工具之前，先理解贯穿所有工具的统一抽象——这决定了「参数怎么校验、权限怎么问、输出怎么截断」。

### 1.1 `Tool` 类型与 `Tool.define()`

`tool.ts:28-41` 定义了工具的核心接口 `Tool.Def`：

```ts
export interface Def<Parameters extends z.ZodType, M> {
  description: string                 // 工具说明（通常来自同名 .txt）
  parameters: Parameters              // zod schema
  execute(args, ctx): Promise<{
    title: string                     // UI 卡片标题
    metadata: M                       // 结构化元数据（diff、诊断、耗时…）
    output: string                    // 回传给 LLM 的文本
    attachments?: FilePart[]          // 图片/PDF 等附件
  }>
  formatValidationError?(error): string
}
```

`Tool.define(id, init)`（`tool.ts:51-91`）是工厂函数，给每个工具包了两层通用逻辑：

- **入口参数校验**（`tool.ts:60-71`）：执行前用 zod `parameters.parse(args)`，失败时抛出可读错误（或走工具自定义的 `formatValidationError`）。
- **出口输出截断**（`tool.ts:73-86`）：除非工具自己已处理截断（`metadata.truncated !== undefined`），否则统一调用 `Truncate.output()`。

### 1.2 工具上下文 `Tool.Context`（`tool.ts:17-27`）

每次 `execute` 都收到一个 `ctx`，关键字段：

| 字段 | 作用 |
|------|------|
| `sessionID` / `messageID` / `agent` | 当前会话、消息、agent 身份 |
| `abort: AbortSignal` | 中止信号（用户取消 / 超时），长任务须监听 |
| `messages` | 当前会话已有消息（task / plan 用来继承 model） |
| `metadata({title, metadata})` | **实时**回传状态给前端（如 bash 流式输出、diff） |
| `ask(request)` | **挂起式权限请求**，详见 §1.4 |

### 1.3 输出截断 `Truncate`（`truncate.ts`）

- 阈值：`MAX_LINES = 2000`、`MAX_BYTES = 50 * 1024`（`truncate.ts:17-18`）。
- 超限时：完整输出写入 truncation 目录落盘，回传内容只保留**预览 + 提示**（`truncate.ts:110-118`）。
- 提示文案明确引导：**"用 Task 工具让 explore agent 配合 Grep/Read(offset/limit) 处理该文件，不要自己读全文以节省上下文"**（`truncate.ts:110`）。这正是 Ultrawork/Claude 侧看到的「输出已截断，完整内容保存到 …」的来源。

### 1.4 权限模型 `ctx.ask()`

工具在做敏感操作前调用 `ctx.ask({ permission, ... })` 发起**挂起式权限请求**，由 client 侧弹 Permission Dock 等待用户批准/拒绝/always。各工具的权限名：`read`/`edit`/`list`/`glob`/`grep`/`bash`/`external_directory`/`task`/`skill`/`todowrite`/`webfetch`/`codesearch`/`websearch`/`lsp` 等。权限端到端机制详见 [Discussion 005](./005-permission-question-dock.md)。

### 1.5 注册中心 `ToolRegistry`（`registry.ts`）

- `all()`（`registry.ts:115-140`）返回**候选**内置工具列表。
- `tools(model, agent)`（`registry.ts:158-197`）按当前模型/flag 过滤候选，再对每个工具 `init()` 生成最终 `{description, parameters, execute}`，并触发 `tool.definition` 插件 hook（允许插件改写描述/参数）。
- 自定义工具来源（`registry.ts:89-109`）：工作区 `tool/`、`tools/` 目录下的 `.js/.ts`，以及插件 `p.tool`。它们和内置工具一起进入候选。

---

## 2. 文件操作工具：read / write / edit / apply_patch / list

这是日常使用频率最高的一组。核心安全机制是 **「先读后写」时间戳校验**（防止覆盖用户/外部未读改动）与 **「行尾归一化 + 多级模糊匹配」**。

### 2.1 `read` — 读文件 / 目录

- **功能**：读文件或目录，支持行号区间、图片/PDF 作为附件返回、指令注入。
- **入参**（`read.ts:23-27`）：`filePath`（必填，绝对路径）、`offset`（起始行，1-based）、`limit`（最多行数，默认 2000）。
- **流程**：
  - 路径规范化 → `ctx.ask("read")` 权限（`read.ts:43-53`）。
  - 目录：分页列条目，目录项加 `/` 后缀（`read.ts:79-119`）。
  - 文件：图片（非 SVG）/PDF → base64 attachment（`read.ts:127-144`）；二进制检测（扩展名 + 字节采样，`read.ts:238-296`）；流式 `readline` 读大文件；**单行截断 2000 字符、总输出 50KB**；输出格式 `<行号>: <内容>`。
  - **指令注入**：`Instruction.resolve()` 命中时在末尾追加 `<system-reminder>`（`read.ts:121-224`）。
  - **记录读取时间戳** `FileTime.read()`（`read.ts:220`）——这是后续 write/edit 防覆盖的前提。
- **约束**：必须绝对路径；默认前 2000 行，更多用 `offset` 翻页；避免反复读小片段。

### 2.2 `write` — 创建/全量覆盖文件

- **功能**：从零创建或**整体覆盖**文件（覆盖时需先 read）。
- **入参**（`write.ts:22-25`）：`content`（必填）、`filePath`（必填，绝对路径）。
- **流程**：路径规范化 → `assertExternalDirectory()` 外部目录校验 → 文件已存在则 `FileTime.assert()` **防覆盖校验**（比对 mtime/size，`write.ts:30-32`）→ 生成 diff → `ctx.ask("edit")` → 写入 → `Format.file()` 格式化 → 发 `File.Edited`/`FileWatcher.Updated` 事件 → **LSP 诊断**（最多 20 条错误，`write.ts:55-72`）。
- **约束**：覆盖前必须先 read；不主动创建 .md/README（除非明确要求）；避免随意写 emoji。

### 2.3 `edit` — 精确字符串替换（核心编辑工具）

- **功能**：把 `oldString` 替换为 `newString`，带多级模糊匹配兜底。
- **入参**（`edit.ts:39-44`）：`filePath`、`oldString`、`newString`（必须 ≠ oldString）、`replaceAll`（默认只替换唯一匹配）。
- **流程亮点**：
  - `FileTime.withLock()` 串行化并发编辑（`edit.ts:60`）。
  - 空 `oldString` 视为新建/追加，跳过时间戳校验（`edit.ts:61-83`）。
  - **行尾归一化**：检测原文件 `\n` / `\r\n` 并把输入转成同款（`edit.ts:91-93`），避免行尾不一致导致匹配失败。
  - **9 级模糊匹配降级**（`replace()`，`edit.ts:630-667`）：Simple → LineTrimmed → BlockAnchor（Levenshtein 相似度）→ WhitespaceNormalized → IndentationFlexible → EscapeNormalized → TrimmedBoundary → ContextAware → MultiOccurrence。
  - 写入后再读回验证、重算 diff、跑 LSP 诊断。
- **约束**：必须先 read；`oldString` 不含 `行号:` 前缀；匹配不到或多处匹配会报错（提供更多上下文或 `replaceAll`）。

### 2.4 `apply_patch` — 补丁格式批量文件操作

- **功能**：用一种「文件导向 diff」语法，在**一次调用里** add/update/delete/move 多个文件。
- **入参**（`apply_patch.ts:18-20`）：`patchText`（必填）。
- **Patch 语法**（`apply_patch.txt`）：

  ```
  *** Begin Patch
  *** Add File: <path>
  +<新内容>
  *** Update File: <path>
  *** Move to: <new path>        # 可选，重命名
  @@ <上下文>
  -<删除行>
  +<新增行>
   <保持行>
  *** Delete File: <path>
  *** End Patch
  ```

- **流程**：`Patch.parsePatch()` 解析 → 对 update 用 `deriveNewContentsFromChunks()` 的**四级匹配**（精确 → rstrip → 两端 trim → Unicode 归一化，处理 smart quotes/dashes，`patch/index.ts:311-400`）→ `ctx.ask("edit")` → 逆序应用替换避免索引偏移 → 格式化 + LSP 诊断 → 汇总 `A/M/D` 摘要。

### 2.5 `list`（id 为 `list`，文件 `ls.ts`）— 目录树

- **功能**：列目录树，带忽略模式，用 ripgrep 高效扫描。
- **入参**（`ls.ts:40-43`）：`path`（默认 `.`）、`ignore`（额外 glob 数组）。
- **流程**：`assertExternalDirectory()` + `ctx.ask("list")` → 预设忽略 15 项（node_modules/.git/dist/build/target/vendor… `ls.ts:9-34`）+ 用户忽略 → `Ripgrep.files()` 扫描（**上限 100**）→ 递归渲染树。
- **约束**：prompt 建议优先用 `glob`/`grep`，list 更适合「看结构」。

### 2.6 edit / write vs apply_patch 的模型分流（关键）

`registry.ts:169-175`：

```ts
const usePatch =
  !!Env.get("OPENCODE_E2E_LLM_URL") ||
  (model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4"))
if (tool.id === "apply_patch") return usePatch
if (tool.id === "edit" || tool.id === "write") return !usePatch
```

- **GPT 系列（非 oss、非 gpt-4）或 E2E 测试** → 只暴露 `apply_patch`，隐藏 `edit`/`write`。
- **其余模型（Claude 等）** → 只暴露 `edit`/`write`，隐藏 `apply_patch`。
- 二者**永不同时出现**，避免模型在两套编辑范式间混淆。

### 2.7 文件工具能力速查

| 特性 | read | write | edit | apply_patch | list |
|------|------|-------|------|-------------|------|
| 单行/总截断 | 2000 字符 / 50KB | - | - | - | 100 文件 |
| 图片/PDF 附件 | ✓ | ✗ | ✗ | ✗ | ✗ |
| 模糊匹配 | ✗ | ✗ | 9 级 | 4 级 | ✗ |
| 「先读后写」校验 | 记录时间戳 | ✓ | ✓（空串除外） | update 时 | ✗ |
| LSP 诊断 | ✗ | ✓ | ✓ | ✓ | ✗ |
| 单次文件数 | 1 | 1 | 1 | 多 | 列表 |

---

## 3. 搜索 / 联网工具：glob / grep / codesearch / websearch / webfetch / lsp

### 3.1 `glob` — 文件名模式匹配

- **入参**（`glob.ts`）：`pattern`（必填，如 `**/*.ts`）、`path`（默认工作目录）。
- **流程**：`ctx.ask("glob")` → `Ripgrep.files()`（`rg --files --glob=…`）扫描 → 取每个文件 mtime → **按 mtime 降序**（最近改的优先）→ 上限 **100**，超出标 truncated。
- **场景**：按名字找文件。无条件启用。

### 3.2 `grep` — 文件内容正则搜索

- **入参**（`grep.ts`）：`pattern`（必填，正则）、`path`、`include`（文件 glob 过滤）。
- **流程**：`ctx.ask("grep")` → 直接 spawn ripgrep（`-nH --hidden --no-messages --field-match-separator=| --regexp`）→ 退出码 0/1/2 分别表示有匹配/无匹配/部分错误 → 按文件分组、按 mtime 降序 → 上限 **100 匹配**，单行 2000 字符截断。
- **场景**：搜代码内容。**精确计数请改用 Bash 直接调 `rg`**。无条件启用。

### 3.3 `codesearch` — Exa Code 编程语境检索

- **入参**（`codesearch.ts`）：`query`（必填）、`tokensNum`（1000–50000，默认 5000）。
- **流程**：`ctx.ask("codesearch")` → POST `https://mcp.exa.ai/mcp`，MCP `tools/call` 调 `get_code_context_exa`（`codesearch.ts:67-85`）→ 30s 超时 → 解析 SSE。
- **场景**：查框架/库/SDK 最新用法和示例。
- **启用条件**：`providerID===opencode` 或 `OPENCODE_ENABLE_EXA`（`registry.ts:165-166`）。

### 3.4 `websearch` — Exa 实时网络搜索

- **入参**（`websearch.ts`）：`query`（必填）、`numResults`（默认 8）、`livecrawl`（`fallback`/`preferred`）、`type`（`auto`/`fast`/`deep`）、`contextMaxCharacters`（默认 10000）。
- **流程**：描述里 `{{year}}` 替换为当前年份（强制搜最新）→ `ctx.ask("websearch")` → POST Exa MCP 调 `web_search_exa` → 25s 超时 → 解析 SSE。
- **启用条件**：同 codesearch。

### 3.5 `webfetch` — 抓取 URL 内容

- **入参**（`webfetch.ts`）：`url`（必填，http/https）、`format`（`text`/`markdown`(默认)/`html`）、`timeout`（默认 30s，最大 120s）。
- **流程**：`ctx.ask("webfetch")` → 按 format 设 Accept 头 → fetch（403 + Cloudflare challenge 时换简洁 UA 重试）→ **5MB 上限** → 图片转 base64 attachment；HTML→Markdown 用 TurndownService、HTML→纯文本用 HTMLRewriter 去 script/style。
- **启用条件**：无条件启用。

### 3.6 `lsp` — Language Server 代码智能（实验）

- **入参**（`lsp.ts`）：`operation`（9 选 1）、`filePath`、`line`（1-based）、`character`（1-based）。
- **支持操作**：`goToDefinition` / `findReferences` / `hover` / `documentSymbol` / `workspaceSymbol` / `goToImplementation` / `prepareCallHierarchy` / `incomingCalls` / `outgoingCalls`。
- **流程**：`ctx.ask("lsp")` → 文件存在性检查 → `LSP.hasClients()` 确认有对应语言 server → `touchFile()` 打开 → 1-based 转 0-based → 分发到 `LSP.*` → 结果 JSON 输出。
- **启用条件**：`OPENCODE_EXPERIMENTAL_LSP_TOOL` 或 `OPENCODE_EXPERIMENTAL`（`registry.ts:135`、`flag/flag.ts:67`）。

---

## 4. 执行 / 编排 / 交互工具：bash / task / batch / skill / todowrite / question / plan_exit / invalid

### 4.1 `bash` — 执行 Shell 命令

- **入参**（`bash.ts:455-469`）：`command`（必填）、`timeout`（默认 120000ms）、`workdir`（默认工作目录）、`description`（必填，5-10 字）。
- **流程亮点**：
  - **AST 解析命令**（tree-sitter bash/powershell）扫描 rm/cp/mv/mkdir/chmod 等文件操作和目录访问，据此请求 `external_directory` + `bash` 权限（`bash.ts:28-49`、`225-288`）。
  - Plugin hook 注入额外环境变量；PowerShell / Windows cygpath 特殊处理。
  - Effect 子进程 + 并行监听「退出 / abort / 超时」；超时后 `forceKillAfter: 3 seconds`。
  - 实时流式输出进 metadata（`MAX_METADATA_LENGTH=30000`），超限落盘截断。
- **约束**：**别用 cat/head/tail/grep/find**——改用专用工具（read/grep/glob）；推荐用 `workdir` 而非 `cd`。无条件启用。

### 4.2 `task` — 委派子 Agent（subagent）

- **入参**（`task.ts:15-26`）：`description`（3-5 字）、`prompt`（必填，可含斜杠命令）、`subagent_type`（必填，agent 名）、`task_id`（可选，续联）、`command`（可选）。
- **流程**：列出非 primary agent 并按权限过滤 → `ctx.ask("task")` → `task_id` 存在则恢复 session，否则 `Session.create(parentID=ctx.sessionID)` 新建子 session → 子 session 内**禁用 `todowrite`/`task`**（防递归）→ `SessionPrompt.prompt()` 跑子 agent 循环 → 提取最后一条 text，包成 `<task_result>` 回传。
- **场景**：复杂多步自治任务、隔离上下文、并发委派。子 agent 中间步骤对用户不可见。无条件启用。详见 [Discussion 004](./004-opencode-multi-agent.md)。

### 4.3 `batch` — 并行调用多个工具（实验）

- **入参**（`batch.ts:14-22`）：`tool_calls`（1–25 个，每个 `{tool, parameters}`）。
- **流程**：切片至 25 → 校验工具存在且不在 DISALLOWED（含 `batch` 自身，禁嵌套）→ 各 call 独立 partID → `Promise.all` 并行 → 各自 catch 不互相中断 → 汇总成功/失败数 + 合并 attachments。
- **约束**：只适合**无依赖**操作（不能先 create 再 read 同一文件）。
- **启用条件**：`config.experimental.batch_tool === true`（`registry.ts:136`）。

### 4.4 `skill` — 加载技能指令

- **入参**（`skill.ts:36-38`）：`name`（必填，来自 `Skill.available`）。
- **流程**：`Skill.get(name)` 加载 → `ctx.ask("skill")` → ripgrep 扫 skill 目录采样最多 10 个文件 → 包成 `<skill_content name=…>`（含 content + base 目录 URL + 文件清单）回传。
- **场景**：任务匹配某 skill 时把详细工作流注入上下文。无条件启用。

### 4.5 `todowrite` — 任务清单

- **入参**（`todo.ts:8-10`）：`todos`（`{content, status(pending/in_progress/completed/cancelled), priority(high/medium/low)}[]`）。
- **流程**：`ctx.ask("todowrite")` → `Todo.update()` 数据库事务（删旧插新，按 position）→ 发 `Todo.Event.Updated` 至 Bus（`session/todo.ts:42-61`）。
- **约束**：3 步以上复杂任务才用；同时只允许 1 个 `in_progress`。无条件启用。

### 4.6 `question` — 向用户提问（挂起等待）

- **入参**（`question.ts:8-10`）：`questions`（`{question, header(<30字), options[{label,description}], multiple?, custom?(默认 true)}[]`）。
- **流程**：生成 QuestionID → 建 Deferred Promise 存入 pending Map → 发 `Event.Asked` → **阻塞等待** client 回 `Question.reply({answers})` 或 `reject` → 格式化答案回传（`question/index.ts:132-190`）。
- **启用条件**：`OPENCODE_CLIENT ∈ {app,cli,desktop}` 或 `OPENCODE_ENABLE_QUESTION_TOOL`（`registry.ts:117-121`）——**Ultrawork 是 desktop，所以默认开启**。端到端见 [Discussion 005](./005-permission-question-dock.md)。

### 4.7 `plan_exit` — 从 plan 模式切到 build（实验）

- **入参**：无（`plan.ts:21`）。
- **流程**：`Question.ask()` 弹「是否执行计划」→ 选 No 抛 `RejectedError` 留在 plan；选 Yes 则**插入一条 `agent="build"` 的合成 user message**（继承历史 model）驱动切换（`plan.ts:44-70`）。
- **启用条件**：`OPENCODE_EXPERIMENTAL_PLAN_MODE && OPENCODE_CLIENT === "cli"`（`registry.ts:137`）——**Ultrawork（desktop）拿不到**。

### 4.8 `invalid` — 兜底

- **入参**（`invalid.ts:4-9`）：`tool`、`error`。
- **流程**：仅返回 `The arguments provided to the tool are invalid: {error}`（`invalid.ts:10-16`），用于参数校验失败 / 调用不存在工具时的安全降级。始终在候选首位（`registry.ts:120`）。

---

## 5. 内置工具总表与启用条件

| id | 文件 | 一句话功能 | 启用条件 | Ultrawork(desktop) 默认 |
|----|------|-----------|---------|------|
| `invalid` | invalid.ts | 非法工具调用兜底 | 无条件 | ✅ |
| `question` | question.ts | 向用户提问并挂起 | client∈{app,cli,desktop} 或 flag | ✅ |
| `bash` | bash.ts | 执行 shell 命令 | 无条件 | ✅ |
| `read` | read.ts | 读文件/目录 | 无条件 | ✅ |
| `glob` | glob.ts | 文件名模式匹配 | 无条件 | ✅ |
| `grep` | grep.ts | 内容正则搜索 | 无条件 | ✅ |
| `edit` | edit.ts | 字符串替换编辑 | **非** apply_patch 模型 | ✅ |
| `write` | write.ts | 创建/覆盖文件 | **非** apply_patch 模型 | ✅ |
| `apply_patch` | apply_patch.ts | 补丁批量改文件 | GPT 系/E2E 模型 | ❌（Claude 时） |
| `task` | task.ts | 委派子 agent | 无条件 | ✅ |
| `webfetch` | webfetch.ts | 抓取 URL | 无条件 | ✅ |
| `todowrite` | todo.ts | 任务清单 | 无条件 | ✅ |
| `websearch` | websearch.ts | Exa 实时网搜 | providerID=opencode 或 OPENCODE_ENABLE_EXA | 视 provider |
| `codesearch` | codesearch.ts | Exa 编程检索 | providerID=opencode 或 OPENCODE_ENABLE_EXA | 视 provider |
| `skill` | skill.ts | 加载技能 | 无条件 | ✅ |
| `lsp` | lsp.ts | LSP 代码智能 | OPENCODE_EXPERIMENTAL_LSP_TOOL | ❌（需 flag） |
| `batch` | batch.ts | 并行多工具 | experimental.batch_tool | ❌（需配置） |
| `plan_exit` | plan.ts | plan→build 切换 | EXPERIMENTAL_PLAN_MODE && cli | ❌（desktop） |

> **未注册的源文件**：`multiedit.ts`（id `multiedit`）与 `plan_enter`（id `plan_enter`）**存在但不在 `registry.ts` 的候选列表里**，当前构建下 LLM 拿不到。两者未注册的原因截然不同，见 §5.1。

### 5.1 为什么 `multiedit` / `plan_enter` 没被注册？

**`plan_enter` —— 被「故意临时禁用」**

- 提交 `fa559b038`（Dax Raad，2026-02-24）标题即原因：**"core: temporarily disable plan enter tool to prevent unintended mode switches during task execution"**。
- 该提交同时：(1) 从 `registry.ts` 的 import 与候选数组移除 `PlanEnterTool`（只留 `PlanExitTool`）；(2) 把 `plan.ts:74-133` 的 `PlanEnterTool` 定义**整段注释掉**。
- **动机**：模型在执行任务过程中会**误调用** `plan_enter`，导致非预期地切进 plan 模式。直接下线工具是最稳妥的止血。
- `plan_enter` 作为**权限名**仍存活：`agent.ts:94/116`（build agent `allow`、其余 `deny`）、`cli/cmd/run.ts:364`（deny）。进入 plan 模式现在改为**直接选用内置 `plan` agent**（`agent.ts:124`，「Plan mode. Disallows all edit tools.」），而不再依赖模型调工具切换。
- 顺带注意：`plan_exit` 自身也仅在 `OPENCODE_EXPERIMENTAL_PLAN_MODE && OPENCODE_CLIENT === "cli"` 下注册——**两个 plan 工具都是 CLI-only 实验特性**，desktop（Ultrawork）本就拿不到。

**`multiedit` —— 从未注册过的遗留代码**

- `git log -S 'MultiEditTool' -- src/tool/registry.ts` **全历史无任何命中**——`MultiEditTool` 从来没有被 import 进注册中心。它属于早期遗留实现，在 `edit` 内置 9 级模糊匹配 + `apply_patch` / `batch` 路径成熟后失去价值，但源文件没被清理。
- 它如今只作为**权限别名**残留：`config/config.ts:601`、`config/config.ts:1449`、`permission/index.ts:297` 都把 `multiedit` 归入 `edit` 权限组（`EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]`），属于防御性前向兼容，并不代表工具可用。
- 结论：`multiedit` 是**死代码**，不要据它推断 OpenCode 支持「单次多编辑」内置工具；要单文件多处修改，对同一文件连续多次 `edit`（后续编辑基于前次结果，注意行号偏移）或用 `apply_patch`。

---

## 6. 典型工具链（在 Ultrawork 里观察到的实际路径）

1. **定位**：`glob`（按名）/ `grep`（按内容）/ `list`（看结构）找到目标文件。
2. **读取**：`read` 获取内容——**同时为后续编辑登记时间戳**（防覆盖前提）。
3. **编辑**：单处 `edit`；新建/覆盖 `write`；GPT 模型下统一走 `apply_patch`。每次写后自动 `Format.file()` + LSP 诊断回流。
4. **执行/验证**：`bash` 跑构建/测试；必要时 `read` 复读验证。
5. **编排**：复杂子任务 `task` 委派子 agent；需用户决策时 `question` 挂起；多步追踪 `todowrite`。
6. **联网**：缺资料时 `webfetch` 抓文档、`websearch`/`codesearch`（依赖 Exa）查最新信息。

---

## 7. 权限默认值：哪些工具会弹权限框？

工具「能不能直接跑 / 要不要先 `ctx.ask()` 等用户批准」由 **agent 的权限规则**决定，而非工具自身。所有内置 agent 共享同一份 `defaults`（`agent/agent.ts:85-103`），再各自 merge 覆盖，最后 merge 用户的 `cfg.permission`。理解这份默认表，就理解了 Ultrawork 里 Permission Dock 的触发时机。

### 7.1 共享默认规则 `defaults`（`agent.ts:85-103`）

```ts
const defaults = Permission.fromConfig({
  "*": "allow",                 // 兜底：未列出的工具一律放行
  doom_loop: "ask",             // 疑似死循环 → 问用户
  external_directory: {         // 越界访问工作区外目录
    "*": "ask",                 //   默认问
    ...whitelistedDirs → "allow" // 白名单目录放行（见 7.3）
  },
  question: "deny",             // 默认禁；仅 build/plan 显式 allow
  plan_enter: "deny",
  plan_exit: "deny",
  read: {                       // 镜像 Node.gitignore 的 .env 规则
    "*": "allow",
    "*.env": "ask",             //   读 .env / .env.* → 问（防泄密）
    "*.env.*": "ask",
    "*.env.example": "allow",   //   示例文件放行
  },
})
```

要点：

- **默认全放行（`"*": "allow"`）**——所以 `read`/`glob`/`grep`/`list`/`edit`/`write`/`bash` 等绝大多数工具**不会**弹框，除非命中下面的细化规则或用户在 `opencode.json` 收紧。
- **三类会主动弹框**：`doom_loop`（死循环保护）、`external_directory`（越界目录）、读 `.env` 类文件。
- **`question`/`plan_enter`/`plan_exit` 默认 deny**，由具体 agent 选择性开启（§7.2）。注意「权限 deny」与「工具未注册」是两回事：`question` 在 desktop 注册了且 build/plan 把它 allow，故 Ultrawork 能用；`plan_*` 既权限 deny 又（在 desktop）未注册。

### 7.2 各内置 agent 的覆盖（`agent.ts:104-180`）

| agent | mode | 关键权限覆盖 | 效果 |
|-------|------|------------|------|
| `build` | primary | `question: allow`、`plan_enter: allow` | 默认 agent，全能；Ultrawork 跑的就是它 |
| `plan` | primary | `question: allow`、`plan_exit: allow`、`edit: { "*": deny, 仅 plan 目录 *.md allow }` | 只读研究 + 只能写计划文件，**禁止改源码** |
| `general` | subagent | `todowrite: deny` | 通用子 agent，被 `task` 委派；不写 todo（避免和主 agent 冲突） |
| `explore` | subagent | `"*": deny` 后**白名单放行** grep/glob/list/bash/read/webfetch/websearch/codesearch | 纯只读探索 agent，**不能 edit/write/task**——这正是截断提示里「交给 explore agent 处理」的角色 |

> `plan` agent 的 `edit` 规则是「黑名单转白名单」典范：先 `"*": "deny"` 关掉所有编辑，再只对 `.opencode/plans/*.md` 和全局 plans 目录 `allow`——所以 plan 模式能写计划、动不了代码。这也是 §5.1 里「禁用 plan_enter 工具后，改用选 plan agent 进入 plan 模式」的落点。

### 7.3 `external_directory` 白名单（`agent.ts:84`）

```ts
const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]
```

- `Truncate.GLOB`（`truncate.ts:20` = 截断落盘目录 `/*`）——保证工具去读「被截断后保存的完整输出」时不会因越界而弹框。
- 各 skill 目录 `/*`——保证 `skill` 工具读取技能附带文件时放行。
- 其余工作区外路径仍 `ask`，由 Permission Dock 让用户决定。

### 7.4 对 Permission Dock 的意义

Ultrawork 默认跑 `build` agent + 默认权限，所以**正常开发流里几乎不弹权限框**；真正会触发 Dock 的是：访问工作区外目录、读 `.env`、疑似死循环。若用户在 `~/.config/ultrawork/opencode.json` 写了 `permission`（如 `"edit": "ask"`），会 merge 进 `user` 覆盖默认——这就是收紧编辑权限的入口。端到端渲染见 [Discussion 005](./005-permission-question-dock.md)。

---

## 8. 自定义工具 / 插件工具加载链

内置工具之外，OpenCode 允许两条途径注入自定义工具，二者都在 `ToolRegistry` 初始化时收集进 `custom`（`registry.ts:61-111`），与内置工具一起进入候选列表。

### 8.1 途径 A：目录扫描（文件即工具）

`registry.ts:89-102`：

```ts
const dirs = yield* config.directories()
const matches = dirs.flatMap((dir) =>
  Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
)
if (matches.length) yield* config.waitForDependencies()
for (const match of matches) {
  const namespace = path.basename(match, path.extname(match))      // 文件名（去扩展名）
  const mod = yield* Effect.promise(() => import(pathToFileURL(match).href))
  for (const [id, def] of Object.entries(mod)) {
    custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
  }
}
```

- **扫描位置**：`config.directories()` 返回的所有配置目录（`config.ts:1343/1488`，来自 `ConfigPaths.directories(directory, worktree)`）下的 `tool/` 或 `tools/` 子目录里的 `.js`/`.ts`。对 Ultrawork，配置目录是全局隔离目录 `~/.config/ultrawork/`（`OPENCODE_APP_NAME=ultrawork`，ADR-020）及工作区 `.opencode/` 等。
- **id 命名规则**（`registry.ts:100`）：
  - `export default` → 工具 id = **文件名**（如 `tools/deploy.ts` 的默认导出 → id `deploy`）。
  - 命名导出 → id = **`文件名_导出名`**（如 `tools/deploy.ts` 里 `export const staging` → id `deploy_staging`）。
  - 一个文件可导出多个工具。
- **依赖安装**：若扫到任何文件，先 `config.waitForDependencies()`（`registry.ts:93`）等待依赖就绪，再 `import`。
- `dot: true` + `symlink: true`：隐藏目录和软链也会被扫到。

### 8.2 途径 B：插件提供工具

`registry.ts:104-109`：

```ts
const plugins = yield* plugin.list()
for (const p of plugins) {
  for (const [id, def] of Object.entries(p.tool ?? {})) {
    custom.push(fromPlugin(id, def))
  }
}
```

插件在其 `tool` 字段里挂一组 `{ id: ToolDefinition }`，id 直接用作工具 id（不加命名空间前缀）。

### 8.3 `ToolDefinition` → `Tool.Info` 的适配（`fromPlugin`，`registry.ts:65-87`）

两条途径都经 `fromPlugin()` 转成统一的 `Tool.Info`：

- `parameters: z.object(def.args)`——插件用 `args`（zod shape）声明参数，包成 zod object。
- `description: def.description`。
- `execute`：调用 `def.execute(args, pluginCtx)`，其中 `pluginCtx` 在标准 `toolCtx` 上补了 `directory` / `worktree`（`registry.ts:72-76`）让插件知道工作目录；返回值再过一遍 `Truncate.output()`（`registry.ts:78`）做统一截断，落盘信息写入 `metadata.truncated/outputPath`。
- 注意自定义工具的 `title` 固定为 `""`（`registry.ts:80`）——UI 卡片标题留空，由前端按 id 兜底渲染。

### 8.4 `tool.definition` hook：插件可改写**任意**工具（含内置）

`registry.ts:186`：每个工具 `init()` 后、暴露给模型前，会触发插件 hook：

```ts
yield* plugin.trigger("tool.definition", { toolID: tool.id }, output) // output = { description, parameters }
```

- 插件能据 `toolID` 修改任意工具的 `description` / `parameters`——**包括 `read`/`bash` 等内置工具**。
- 典型用途：给特定模型微调工具描述、收窄/扩展参数 schema、注入项目专属说明。

### 8.5 注册去重与覆盖（`registry.ts:142-150`）

运行时还可经 `register()` 动态加工具：按 id 查重，存在则**替换**（splice），否则 push。因此后注册的同 id 工具会覆盖先前的——自定义工具可借此覆盖内置工具实现。

---

## 9. 对 Ultrawork 的启示

- **Ultrawork 是 desktop client**，所以 `question` 工具默认开启——这条链路（提问挂起 → Question Dock → 回复）在 sidecar 里完全可用，前端已实现渲染（见 [Discussion 005](./005-permission-question-dock.md)）。
- **`plan_exit` 在 desktop 下拿不到**（要求 `client==="cli"`）。若 Ultrawork 想做 plan 模式，需要自己设计交互而非依赖该内置工具。
- **`batch` / `lsp` 默认关闭**，分别需 `opencode.json` 的 `experimental.batch_tool` 和 `OPENCODE_EXPERIMENTAL_LSP_TOOL` flag。如要启用，落点是 Ultrawork 的全局隔离配置 `~/.config/ultrawork/`（`OPENCODE_APP_NAME=ultrawork`，ADR-020）。
- **截断提示引导用 Task+explore agent 处理大输出**（`truncate.ts:110`）——这解释了为什么大文件输出会被截断并建议委派子 agent，是上下文节流的有意设计。
- **编辑工具按模型分流**：换用 GPT 系模型时，Ultrawork 看到的将是 `apply_patch` 而非 `edit`/`write`，工具卡片形态会变，前端渲染需兼容两种。

---

## 附：关键源码定位速查

| 主题 | 位置 |
|------|------|
| 工具接口 / `Tool.define` | `tool.ts:28-91` |
| 工具上下文 `Context` | `tool.ts:17-27` |
| 输出截断阈值与提示 | `truncate.ts:17-18, 110-118` |
| 候选工具列表 `all()` | `registry.ts:115-140` |
| 模型过滤 / edit↔apply_patch 分流 | `registry.ts:164-176` |
| codesearch/websearch 启用 | `registry.ts:165-166` |
| lsp / batch / plan_exit 启用 | `registry.ts:135-137` |
| 自定义工具 / 插件工具加载 | `registry.ts:61-111` |
| `tool.definition` 改写 hook | `registry.ts:186` |
| 权限默认值 `defaults` | `agent/agent.ts:85-103` |
| 内置 agent 权限覆盖 | `agent/agent.ts:104-180` |
| external_directory 白名单 | `agent/agent.ts:84`、`truncate.ts:20` |
| 时间戳防覆盖 | `file/time.ts:89-108` |
| edit 9 级模糊匹配 | `edit.ts:196-667` |
| apply_patch 4 级匹配 | `patch/index.ts:311-400` |
