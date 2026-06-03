# Discussion 004: OpenCode 多 Agent 机制调研 — 默认 Agent、自定义与子 Agent 委派

- **日期**: 2026-06-03
- **状态**: 调研记录（仅分析，无代码改动）
- **参与者**: 用户 + Claude
- **范围**: 基于 `vendor/opencode` 源码（submodule，已 apply Ultrawork patch）+ Ultrawork main 分支代码

> 本文回答三个问题：(1) Ultrawork 跑起来用的默认 agent 是什么？(2) 如何自定义一个 agent？(3) 自定义 agent 能否被默认 agent 调用？
>
> 所有结论均带源码定位（`文件:行号`），可直接跳读核对。

---

## TL;DR

1. **默认 agent 是 `build`**。Ultrawork 前端发消息时**完全不传 `agent` 字段**，opencode server 落到 `Agent.defaultAgent()`，在无 `default_agent` 配置时返回第一个「非 subagent 且非 hidden」的 agent —— 即内置的 `build`。
2. **自定义 agent 有两种主流方式**：(a) markdown 文件放进 agent 目录（带 YAML frontmatter）；(b) 在 `opencode.json` 的 `agent` 字段里写配置对象。对 Ultrawork 来说，配置落点是全局隔离目录 `~/.config/ultrawork/`（`OPENCODE_APP_NAME=ultrawork`，见 ADR-020）。
3. **能被调用，而且开箱即用**。`build` 默认拥有 `task` 工具权限（继承默认 `"*": "allow"`），可通过 `task` 工具把任务委派给任意 `mode` 为 `subagent`/`all` 的 agent，子 agent 在**独立子 session** 运行。**无需任何配置，`build` 现在就能委派给内置的 `general`/`explore`**；自定义 agent 只要 `mode` 设为 `subagent`/`all`，就会自动进入 `task` 候选列表。委派在 Ultrawork 里呈现为聊天流中一张普通的 `task` 工具卡片（只显示输入和最终 `task_result`，子 agent 的中间步骤在被隐藏的子 session 里、看不到）。Ultrawork 前端没有「主动选 agent / 触发委派」的 UI，但这条链路在 sidecar 里完全可用——是否发生取决于 `build` 模型自己是否调用 `task`。实战细节见 §4。

---

## 1. Ultrawork 运行时用的默认 Agent 是什么？

### 1.1 前端不传 agent

Ultrawork 前端发送 prompt 时只带 `model`，不带 `agent`：

- `packages/client/desktop/src/lib/use-session-messages.ts:554`
  ```ts
  api.promptAsync(sessionId, userMessage, { model: model || undefined })
  ```
- `packages/client/desktop/src/pages/Home.tsx:53`：同样只传 `model`。
- `packages/core/api-client/src/client.ts:295-321`：`promptAsync()` **支持** `agent` 参数（`requestBody.agent = options.agent`），但前端从不传入。
- 创建 session 时也不带 agent：`createSession()` 无参数调用。

### 1.2 server 端的默认 agent 决议

当请求里没有 agent 时，opencode 在处理 session 消息时回退到默认 agent：

- `vendor/opencode/.../src/server/routes/session.ts:531`
  ```ts
  currentAgent = info.agent || (await Agent.defaultAgent())
  ```

`defaultAgent()` 的逻辑（`vendor/opencode/.../src/agent/agent.ts:297-309`）：

```ts
const defaultAgent = Effect.fnUntraced(function* () {
  const c = yield* config.get()
  if (c.default_agent) {
    const agent = agents[c.default_agent]
    if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
    if (agent.mode === "subagent") throw new Error(`... is a subagent`)
    if (agent.hidden === true) throw new Error(`... is hidden`)
    return agent.name
  }
  // 没配 default_agent → 取第一个「非 subagent 且非 hidden」的 agent
  const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
  if (!visible) throw new Error("no primary visible agent found")
  return visible.name
})
```

`config.default_agent` 字段定义在 `vendor/opencode/.../src/config/config.ts:909-914`，描述里直接写明：*"Falls back to 'build' if not set or if the specified agent is invalid."*

### 1.3 Ultrawork 没有写 default_agent，也没有任何 agent 配置

- 项目根 `opencode.json` 只有 `permission.edit: "ask"`，**无 `agent` / `default_agent` 字段**。
- Tauri 启动 sidecar 注入的环境变量（`packages/client/desktop/src-tauri/src/lib.rs` ~1432-1461）只有 `OPENCODE_SERVER_PASSWORD` 和 `OPENCODE_APP_NAME`，**不注入 agent**。
- 全局配置写入逻辑只处理 MCP（`read_mcp_config` / `write_mcp_config`），不碰 agent。

### 1.4 内置 agent 全景

定义在 `vendor/opencode/.../src/agent/agent.ts:107-234`（`agents` 字典，按 key 顺序排列，`build` 居首）：

| Agent | mode | hidden | native | 角色 |
|-------|------|--------|--------|------|
| **build** | primary | — | ✅ | **默认 agent**，按权限执行所有工具 |
| plan | primary | — | ✅ | 计划模式，禁用所有编辑工具 |
| general | subagent | — | ✅ | 通用多步任务子 agent（可并行委派） |
| explore | subagent | — | ✅ | 代码库探索子 agent（只读检索类工具） |
| compaction | primary | ✅ | ✅ | 会话压缩（内部用，隐藏） |
| title | primary | ✅ | ✅ | 会话标题生成（内部用，隐藏） |
| summary | primary | ✅ | ✅ | 会话摘要生成（内部用，隐藏） |

`build` 的权限继承默认集 `defaults`（`"*": "allow"` 等，`agent.ts:88-103`），再叠加 `question: "allow"` / `plan_enter: "allow"`，最后叠加用户配置 `user`（`agent.ts:108-122`）。

> **结论**：Ultrawork 当前 = 永远用内置 `build` agent，全局 + 项目配置都没动过 agent 体系。前端虽然有 `getAgents()`（`client.ts:289-291` 调 `GET /agent`）但从未被调用，也没有 agent 选择 UI（agent-selector 只在 `feat/acp-support` 分支）。

---

## 2. 如何自定义一个 Agent？

opencode 加载 agent 配置有三种来源，最终合并进同一个 `agent` 字典（`config.ts:1373-1375` 用 `mergeDeep` 串联）。

### 方式 A：Markdown 文件（推荐，最直观）

加载函数 `loadAgent()`（`config.ts:257-294`）扫描以下 glob：

```
{agent,agents}/**/*.md
```

文件名（去扩展名）即 agent 名，**frontmatter 即配置，markdown 正文即 system prompt**：

```markdown
---
description: Translate content for a specified locale while preserving technical terms
mode: subagent
model: opencode/gpt-5.4
temperature: 0.3
---

You are a professional translator and localization specialist.
```

> 实例可参考 vendor 自带：`vendor/opencode/.opencode/agent/translator.md`、`triage.md`。

**目录搜索位置**（受 `OPENCODE_APP_NAME=ultrawork` 影响，见下方 §2.4）：
- 全局：`~/.config/<app>/agent/*.md`（Ultrawork = `~/.config/ultrawork/agent/`）
- 项目级：工作目录及上级目录的 `.opencode/agent/*.md`

还有一个 **已弃用** 的 `loadMode()`（`config.ts:296-330`）扫描 `{mode,modes}/*.md`，加载后强制 `mode: "primary"`，等价于一个主 agent。新代码应直接用 agent 目录。

### 方式 B：opencode.json 的 `agent` 字段

Schema 在 `config.ts:927-942`：

```jsonc
{
  "agent": {
    "my-reviewer": {
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-6",
      "temperature": 0.2,
      "description": "Reviews diffs for correctness bugs",
      "prompt": "You are a meticulous code reviewer ...",
      "permission": { "edit": "deny", "bash": "ask", "read": "allow" }
    }
  }
}
```

`agent` 是带 `.catchall(Agent)` 的对象，任意 key 都会被当作 agent 名。

### Agent 可配置字段（`Config.Agent` schema，`config.ts:534-621`）

| 字段 | 类型 | 说明 |
|------|------|------|
| `model` | `string` | `provider/model`，运行时经 `Provider.parseModel()` 解析 |
| `variant` | `string` | 模型变体（如 `"high"`） |
| `temperature` / `top_p` | `number` | 采样参数 |
| `prompt` | `string` | system prompt（markdown 形式时来自正文） |
| `mode` | `"subagent" \| "primary" \| "all"` | **决定能否作默认 agent / 能否被委派**（见 §3） |
| `hidden` | `boolean` | 隐藏于 `@` 自动补全（仅对 subagent 有意义） |
| `description` | `string` | 用途描述——**会出现在 task 工具的可选 agent 列表里**（见 §3.2） |
| `color` | `string` | `#RRGGBB` 或主题色名 |
| `steps` | `number` | 最大 agentic 迭代步数 |
| `permission` | object | 细粒度权限（`read`/`edit`/`bash`/`task`/`webfetch`… → `allow`/`deny`/`ask`，支持 glob 模式匹配） |
| `tools` | `{[name]: boolean}` | **已弃用**，会被 transform 成 `permission` |
| `disable` | `boolean` | 删除该 agent（`agent.ts:237-239`） |

合并细节（`agent.ts:236-263`）：未在内置字典中的 key 会新建一个 `mode: "all"`、`native: false` 的 agent；已存在的则逐字段覆盖、权限用 `Permission.merge` 叠加。

### CLI 脚手架

vendor 提供 `opencode agent create` 命令（`vendor/opencode/.../src/cli/cmd/agent.ts`），交互式生成 markdown agent 文件；`opencode agent list` 列出全部。Ultrawork 不直接暴露这个 CLI，但 sidecar 二进制具备此能力。

### 2.4 ⚠️ Ultrawork 的落点：配置隔离

Ultrawork 通过 vendor patch 设置 `OPENCODE_APP_NAME=ultrawork`（ADR-020），并跳过 `~/.opencode/` 的 home 目录搜索。因此：

- **全局自定义 agent 应放在 `~/.config/ultrawork/agent/*.md`**（不是 `~/.config/opencode/`）。
- 或写进 `~/.config/ultrawork/opencode.json` 的 `agent` 字段。
- 项目级 `.opencode/agent/` 也有效，作用域限于该工作目录树。

这意味着：**目前给 Ultrawork 加自定义 agent 是「手工编辑配置文件」级别的操作**，前端没有任何管理 UI，也没有 Tauri command 去写 agent（只有 MCP 的读写命令）。

---

## 3. 自定义 Agent 能否被默认 Agent 调用 / 使用？

**能**——通过内置的 `task` 工具委派，或用户消息里的 `@agent-name` 显式提及。前提是被调 agent 的 `mode` 是 `subagent` 或 `all`。

### 3.1 task 工具：把任务委派给子 agent

定义在 `vendor/opencode/.../src/tool/task.ts`，参数（`task.ts:15-26`）：

```ts
{
  description: string      // 3-5 词的任务简述
  prompt: string           // 给子 agent 的完整指令
  subagent_type: string    // 要调用的 agent 名（如 "general" / "explore" / 自定义名）
  task_id?: string         // 传入则恢复上次的子 agent session，否则新建
  command?: string
}
```

`task` 工具全局注册在工具表（`vendor/opencode/.../src/tool/registry.ts`，`TaskTool` 在 `all()` 列表中），任何拥有 `task` 权限的 agent 都能调用它。

### 3.2 哪些 agent 能被委派？

`task.ts:29-36`：

```ts
const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))
const caller = ctx?.agent
const accessibleAgents = caller
  ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")
  : agents
```

两层过滤：
1. **`mode !== "primary"`** —— 即只有 `subagent` 和 `all` 的 agent 可作子 agent。（`build`/`plan` 是 primary，**不能**被当子 agent 委派。）
2. **调用者权限** —— caller 对 `task` 权限里该 agent 名的评估不能是 `deny`。

通过过滤的 agent 连同其 `description` 一起拼进 task 工具的描述文本（`task.ts:38-43`），模型据此知道有哪些子 agent 可用。

> **所以自定义 agent 要想被 `build` 调用：把 `mode` 设为 `subagent` 或 `all`，给一个清晰的 `description`。** 它会自动进入 `build` 的 task 候选列表，无需额外注册。

### 3.3 `build` 默认就有 task 权限吗？—— 有

`build` 权限继承 `defaults`（含 `"*": "allow"`，`agent.ts:88` 起），未对 `task` 单独 deny，故 `build` 默认可用 task 工具，且对所有子 agent 名评估为 allow。

子 agent 自身的 task 权限差异：
- `general`：继承 defaults → **有** task 权限（可再委派，但运行时通常受限，见 §3.4）。
- `explore`：显式 `"*": "deny"` 后只 allow 检索类工具 → **无** task 权限（不能再起子任务）。

### 3.4 子 agent 在独立 session 运行 + 权限降级

`task.ts:63-104` 执行逻辑：

```ts
const agent = await Agent.get(params.subagent_type)
const hasTaskPermission = agent.permission.some((r) => r.permission === "task")
const hasTodoWritePermission = agent.permission.some((r) => r.permission === "todowrite")

const session = await Session.create({
  parentID: ctx.sessionID,                          // 挂在主 session 之下
  title: params.description + ` (@${agent.name} subagent)`,
  permission: [
    // 子 agent 无 todowrite 权限 → session 级显式禁掉
    ...(hasTodoWritePermission ? [] : [{ permission: "todowrite", pattern: "*", action: "deny" }]),
    // 子 agent 无 task 权限 → 禁止递归再委派
    ...(hasTaskPermission ? [] : [{ permission: "task", pattern: "*", action: "deny" }]),
    ...(config.experimental?.primary_tools?.map((t) => ({ pattern: "*", action: "allow", permission: t })) ?? []),
  ],
})
```

要点：
- 子 agent 跑在**新建的子 session**（`parentID` 指向主 agent 的 session），消息历史隔离。
- 可用 `task_id` 恢复同一子 agent 会话继续对话。
- 权限做「降级」：缺 `task`/`todowrite` 的子 agent 在 session 级被显式 deny，避免越权或无限递归委派。
- 子 agent 跑完，最终文本输出包成 `<task_result>` 返回主 agent，附带 `task_id` 供续接。

### 3.5 `@agent-name` 显式提及（旁路用户确认）

用户消息里写 `@explore ...`，解析链路：

- `vendor/opencode/.../src/config/markdown.ts`：`FILE_REGEX` 提取 `@xxx`。
- `vendor/opencode/.../src/session/prompt.ts`（`resolvePromptParts`）：若 `@name` 不是文件，则 `Agent.get(name)` 命中后生成 `{ type: "agent", name }` part，再追加合成指令 *"... call the task tool with subagent: <name>"*。
- 当本轮用户消息含 agent part 时，`bypassAgentCheck = true`，task 工具跳过 `ctx.ask()` 用户授权（`task.ts:50-61`）——因为是用户主动点名的。但 **agent 自身的权限限制仍然生效**。

> 注意：这条 `@` 链路是 opencode TUI/协议层能力。**Ultrawork 前端是否把输入框里的 `@xxx` 透传成可被解析的文本**取决于前端实现——前端只是把文本塞进 `promptAsync` 的 `parts`，server 端 `resolvePromptParts` 仍会解析，所以理论上在 Ultrawork 输入框打 `@explore` 也能触发。这点值得后续实测确认（本次未跑通验证）。

---

## 4. 实战补充：multi-agent 在 Ultrawork 里实际怎么跑

§1–§3 是机制原理。这一节回答「真在 Ultrawork 里发生委派时，用户和前端会看到什么」——结论是**链路通、但对用户基本不可见**。

### 4.1 子 agent 用哪个模型？

`task.ts:108-111`：

```ts
const model = agent.model ?? {
  modelID: msg.info.modelID,
  providerID: msg.info.providerID,
}
```

- 子 agent **配置了 `model` 就用自己的**；
- 没配则**继承主 session 当前这条 assistant 消息的模型**（即 Ultrawork 里用户当前选的模型）。

所以自定义 subagent 若想固定用某个便宜/快速模型（如让 explore 用 haiku），在其配置里写死 `model` 即可，不受前端模型选择影响。

### 4.2 子 session 不会污染侧边栏 ✅

- opencode `GET /session` 默认返回**所有** session（含带 `parentID` 的子 session），要传 `?roots=true` 才过滤（`session/index.ts` list + `roots` 参数）。
- **Ultrawork 前端正好显式传了 `roots: true`**（`packages/client/desktop/src/lib/use-sessions.ts:44-51`），且前端 `Session` 类型根本没有 `parentID` 字段。
- → 委派产生的子 session **不会出现在侧边栏**，不会有「幽灵 session」。这点现状是干净的。

### 4.3 委派在聊天流里呈现为一张普通 task 卡片

- `task` 工具调用作为主 session 的一个 `type: "tool"` part 出现（`prompt.ts` 的 `handleSubtask` 发 `message.part.updated`，状态 pending→running→completed）。
- 前端 `tool-call-block.tsx` **对 `task` 无任何特殊处理**，渲染成和 bash/edit 一样的通用折叠卡片：标题「task」、状态图标、可展开的 input/output。
- 子 agent 在子 session 内部的逐步消息也会 emit SSE，但**带的是子 session 的 id**；Ultrawork `use-session-messages.ts:243-252` 在事件入口按 `sessionID !== 当前session` 严格丢弃。
- → 用户**只看到一张 task 卡片 + 最终 `<task_result>` 输出**，看不到子 agent 一步步在干什么。对「快速委派拿结果」是好事，对「想观察子 agent 过程」则是缺失。

### 4.4 委派触发权限询问吗？—— `build` 默认不会

- `task` 工具在 `bypassAgentCheck=false` 时会 `ctx.ask({permission:"task", ...})`，走的是和 edit/bash 同一套 `permission.asked` SSE 机制。
- 但 `Permission.ask` 里若该权限评估为 `allow` 就 `needsAsk=false`、**不发事件**。`build` 的 `task` 权限继承默认 `"*": "allow"` → **委派给任意子 agent 都不弹权限确认**，直接执行。
- ⚠️ **潜在 UX 缺口**：若某个 agent 把 `task` 配成 `"ask"`，确实会发 `permission.asked`，但 Ultrawork 的 `permission-dock.tsx:10-21` 的标签白名单只有 `{bash, edit, write, read, external_directory}`，**没有 `task`**——会 fallback 成裸字符串 "task"，且 metadata 里的 `subagent_type`/`description` 不会被友好展示。能用，但标签很糙。

### 4.5 一句话总结现状

> Ultrawork 今天就能让 `build` 委派给 `general`/`explore`（或任何你丢进 `~/.config/ultrawork/agent/` 的 subagent），子 session 不污染侧边栏、委派以一张 task 卡片呈现、`build` 委派不弹权限。代价是：**全程没有 UI 引导，子 agent 过程不可见，task 权限提示标签未本地化**。

---

## 5. 对 Ultrawork 的影响与可选动作（仅建议，未实施）

| 现状 | 说明 |
|------|------|
| 默认 agent = `build` | 无配置，符合 opencode 缺省行为 |
| 多 agent 能力「在 sidecar 里齐备但前端未暴露」 | task 委派、subagent、`@` 提及全部可用，但无 UI 触发；模型可自主调 task |
| 自定义 agent = 手工编辑 `~/.config/ultrawork/` | 无管理 UI、无 Tauri 写入命令 |

**若未来想正式支持多 agent（仅列方向，不在本次范围）：**
1. **最低成本**：在 `~/.config/ultrawork/agent/` 放几个 markdown subagent（如 reviewer、translator），`build` 即可通过 task 自动发现并委派——无需任何代码改动。
2. **前端选择 UI**：调用已有的 `getAgents()`（`client.ts:289`）列出 primary agent，发消息时把选中的 agent 传进 `promptAsync` 的 `agent` 字段（API 已支持）。可参考 `feat/acp-support` 分支的 agent-selector 思路（但那是 ACP agent，机制不同）。
3. **agent 管理 UI + Tauri 写入命令**：类比现有 MCP 配置管理，给 `~/.config/ultrawork/opencode.json` 的 `agent` 字段做增删改。
4. 任一方向落地时再评估是否升级为 ADR。

---

## 关键源码索引

| 主题 | 文件 | 行号 |
|------|------|------|
| 内置 agent 字典（build/plan/general/explore/…） | `vendor/opencode/.../src/agent/agent.ts` | 107-234 |
| 自定义 agent 合并逻辑 | 同上 | 236-263 |
| `defaultAgent()` 决议 | 同上 | 297-309 |
| Agent.Info schema | 同上 | 26-52 |
| `default_agent` 配置字段 | `vendor/opencode/.../src/config/config.ts` | 909-914 |
| `Config.Agent` schema | 同上 | 534-621 |
| `agent` 字段 schema | 同上 | 927-942 |
| markdown agent 加载 `loadAgent()` | 同上 | 257-294 |
| mode 目录加载（弃用）`loadMode()` | 同上 | 296-330 |
| 配置合并顺序 | 同上 | 1373-1375, 1432-1439 |
| task 工具参数 + 过滤 | `vendor/opencode/.../src/tool/task.ts` | 15-36 |
| task 执行 + 子 session + 权限降级 | 同上 | 47-144 |
| task 工具全局注册 | `vendor/opencode/.../src/tool/registry.ts` | `all()` 列表 |
| server 端默认 agent 回退 | `vendor/opencode/.../src/server/routes/session.ts` | 531 |
| `@` 提及解析 | `vendor/opencode/.../src/session/prompt.ts` + `config/markdown.ts` | resolvePromptParts |
| 前端发 prompt（不传 agent） | `packages/client/desktop/src/lib/use-session-messages.ts` | 554 |
| API client `promptAsync`（支持 agent） | `packages/core/api-client/src/client.ts` | 295-321 |
| API client `getAgents`（未被调用） | 同上 | 289-291 |
| 子 agent 模型 fallback（自身 model ?? 主 session 模型） | `vendor/opencode/.../src/tool/task.ts` | 108-111 |
| `GET /session` 的 `roots` 过滤 | `vendor/opencode/.../src/session/index.ts` | list + roots 参数 |
| 委派 SSE（handleSubtask / task part） | `vendor/opencode/.../src/session/prompt.ts` | handleSubtask |
| 前端 session 列表传 `roots:true`（隐藏子 session） | `packages/client/desktop/src/lib/use-sessions.ts` | 44-51 |
| 前端 task 工具渲染（无特殊处理，通用卡片） | `packages/client/desktop/src/components/chat/tool-call-block.tsx` | — |
| 前端权限标签白名单（缺 task） | `packages/client/desktop/src/components/chat/permission-dock.tsx` | 10-21 |
| 前端 SSE 按 sessionID 严格过滤 | `packages/client/desktop/src/lib/use-session-messages.ts` | 243-252 |
| 配置隔离 `OPENCODE_APP_NAME` | ADR-020 | — |
