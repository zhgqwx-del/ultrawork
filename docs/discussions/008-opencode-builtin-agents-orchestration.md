# Discussion 008: OpenCode 内置 Agent 全景、相互调用机制与 runLoop 引擎 — 谁能调用谁、谁来调度、怎么驱动

- **日期**: 2026-06-04
- **状态**: 调研记录（仅分析，无代码改动）
- **参与者**: 用户 + Claude
- **范围**: 基于 `vendor/opencode/packages/opencode/src/` 源码（submodule，已 apply Ultrawork patch）
- **关联**: [Discussion 004](004-opencode-multi-agent.md)（默认 agent / 自定义 / 子 agent 委派的用户视角）、[Discussion 007](007-opencode-builtin-tools.md)（内置工具全景）

> 本文回答用户的核心问题：
> 1. OpenCode 有哪些**内置 agent**？（不止 `build`/`general`/`explore`，还有几个隐藏的系统 agent）
> 2. 这些 agent 之间**如何相互调用**？
> 3. 都是 `primary` 的 agent，`build` 能不能调用 `compaction`？（结论：**不能**——它根本进不了 `task` 工具的候选列表）
> 4. 那 `compaction`/`title` 这些是**谁调用的**？（结论：不是任何 agent 调用的，是 **session 运行时循环**直接调度的）
> 5. （追加）驱动这一切的 **`runLoop` 引擎**本身是怎样的技术流程与架构？（见 §5）
>
> 所有结论均带源码定位（`文件:行号`，相对 `vendor/opencode/packages/opencode/src/`），可直接跳读核对。

---

## TL;DR

1. **内置 agent 共 7 个**（`agent/agent.ts:107-234`）：`build`、`plan`、`general`、`explore`、`compaction`、`title`、`summary`。前 4 个用户可见，后 3 个 `hidden: true` 是系统内部 agent。
2. **`mode` 字段决定一个 agent 能否被「委派」**：只有 `mode !== "primary"` 的 agent（即 `subagent`/`all`）才会进入 `task` 工具的候选列表（`tool/task.ts:29`）。`build`/`plan`/`compaction`/`title`/`summary` 全是 `primary`，**永远不可能通过 `task` 工具互相调用**。
3. **存在三种 agent 协同形式，但只有第一种是真正的「调用」**：
   - **路径 A — LLM 驱动委派（调用）**：模型主动调 `task` 工具 → 只能调到 `general`/`explore`/自定义 subagent，在独立子 session 跑。这是 Discussion 004 讲的链路。
   - **路径 B — 运行时编排调度**：`compaction`/`title` 由 **session 主循环 `runLoop`**（`session/prompt.ts`）在特定时机**直接调用**，绕过 LLM、绕过 `task` 工具、绕过权限询问。它们不是「被某个 agent 调用」，而是「被引擎调度」。
   - **路径 C — primary 间模式切换**：`plan`/`build` 等 primary 之间无法互相调用，靠用户**逐条消息切换** + 引擎注入衔接 system-reminder（plan↔build）协作（§4）。
4. **所以「`build` 调用 `compaction`」这个命题本身不成立**：`build` 这个 agent（即跑在 `build` 模式下的那个 LLM）从来不知道 `compaction` 的存在，也没有任何工具能触达它。是 `runLoop` 在检测到上下文溢出时，**替整个 session** 插入一条 compaction 任务（`prompt.ts:1412-1419`）。
5. **`summary` agent 已定义但当前无活跃调用方**——全代码库搜不到 `agents.get("summary")`，属于「保留/休眠」状态（§3.4）。真正在跑的「会话摘要」是 `compaction`，而 `SessionSummary` 命名空间只做 git diff 统计、不调 LLM。
6. **三条路径全由同一个引擎 `runLoop` 驱动**（`session/prompt.ts`）。它是「每 session 一个 Runner」的 `while` 主循环，逐轮调 `processor.process()` 流式跑一步 LLM + 执行工具，按返回的 `continue/stop/compact` 三态决定继续/收尾/压缩，并在轮内分发 subtask(A)/compaction(B)/agent 切换(C)。技术流程详见 §5。

---

## 1. 内置 Agent 全景

所有内置 agent 在 `Agent.layer` 初始化时硬编码进 `agents` 字典（`agent/agent.ts:107-234`），随后被用户 `opencode.json` 的 `agent` 字段覆盖/扩展（`agent.ts:236-263`）。

### 1.1 七个内置 agent 一览

| Agent | `mode` | `hidden` | `native` | 关键权限 | 用途 |
|-------|--------|----------|----------|---------|------|
| `build` | `primary` | — | ✅ | 继承默认 `"*": "allow"` + `question/plan_enter: allow` | 默认主 agent，能用全部工具 |
| `plan` | `primary` | — | ✅ | `edit: "*"→deny`（只允许写 plan 文件）、`plan_exit: allow` | 计划模式，禁止改代码 |
| `general` | `subagent` | — | ✅ | 继承默认 + `todowrite: deny` | 通用子 agent，可并行执行多步任务 |
| `explore` | `subagent` | — | ✅ | `"*": deny` 仅放行只读工具（grep/glob/list/read/bash/webfetch/websearch/codesearch） | 只读探索代码库 |
| `compaction` | `primary` | ✅ | ✅ | `"*": deny`（不能用任何工具） | 上下文压缩/会话续写摘要 |
| `title` | `primary` | ✅ | ✅ | `"*": deny`，`temperature: 0.5` | 给会话生成标题 |
| `summary` | `primary` | ✅ | ✅ | `"*": deny` | （已定义，当前无活跃调用方，§3.4） |

> 字段语义见 `Agent.Info` schema（`agent/agent.ts:27-52`）：`mode: "subagent" | "primary" | "all"`，`hidden` 控制是否在 UI/列表展示，`native` 标记内置（区别于用户自定义）。

### 1.2 `mode` 三态的真正含义

- **`primary`**：可作为「会话主驱动 agent」（用户直接跟它对话的那个）。**不能**被 `task` 委派。
- **`subagent`**：只能被 `task` 委派，**不能**作为会话主 agent（`defaultAgent()` 显式拒绝 subagent，`agent.ts:302`）。
- **`all`**：两者皆可——既能当主 agent，也能被委派。用户自定义 agent 若没在配置里写 `mode`，默认就是 `all`（`agent.ts:243-249`）。

这一区分是后面所有调用规则的根基：**`task` 工具的候选列表 = 所有 `mode !== "primary"` 的 agent**。

### 1.3 两个易混淆点的澄清

- **`generate` / `generate.txt` 不是第 8 个 agent**。`Agent.generate()`（`agent/agent.ts:329-390`）是「用 AI 根据一句话描述**生成一份新 agent 配置**」的脚手架方法（产出 `{identifier, whenToUse, systemPrompt}`），`generate.txt` 是它的 system prompt。它是 CLI/UI 的「创建自定义 agent」功能，不是运行时会被调度的 agent，不在 `agents` 字典里。
- **各 agent 用什么模型**，规则不一：
  - 子 agent（task 委派）：`agent.model ?? 父 assistant 消息的模型`（`tool/task.ts:108-111`）。
  - `title`：`agent.model ?? provider.getSmallModel()`（优先小模型省钱，`prompt.ts:214-217`）。
  - `compaction`：`agent.model ?? 触发时 user 消息的模型`（`compaction.ts:179-182`）。
  - 即：系统 agent 默认复用当前会话模型，但都可在 `opencode.json` 里给 `title`/`compaction` 单独配 `model` 覆盖。

---

## 2. 调用路径 A：LLM 驱动的 `task` 委派（agent → subagent）

这是「一个 agent 调用另一个 agent」唯一存在的形式，且只能 primary/all → subagent/all。

### 2.1 `task` 工具如何裁剪候选 agent

`tool/task.ts:28-43`：

```ts
export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))  // ← 关键：踢掉所有 primary

  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => Permission.evaluate("task", a.name, caller.permission).action !== "deny")  // ← 再按调用方权限过滤
    : agents
  const list = accessibleAgents.toSorted((a, b) => a.name.localeCompare(b.name))

  const description = DESCRIPTION.replace("{agents}", list.map(...).join("\n"))  // ← 候选 agent 写进工具描述喂给 LLM
  ...
})
```

两道过滤：

1. **`mode !== "primary"`**（`task.ts:29`）——`build`/`plan`/`compaction`/`title`/`summary` 在这一步就被全部排除。LLM 拿到的 `task` 工具描述里**根本不会列出它们**，模型无从调用。
2. **调用方 `task` 权限**（`task.ts:33-35`）——再按当前 agent 的 permission 评估 `task:<目标名>` 是否为 `deny`，把没权限的也过滤掉。

> 因此「`build` 调 `compaction`」在第 1 道过滤就死了：`compaction.mode === "primary"`，不在候选列表里。

### 2.2 委派的执行：独立子 session + 权限降级

`task` 工具执行时（`task.ts:47-164`）：

- 为子任务**新建一个子 session**（`parentID: ctx.sessionID`，`task.ts:75-103`），子 session 不污染侧边栏。
- **默认收紧子 agent 权限**：若目标 agent 自身没有 `todowrite`/`task` 权限规则，就给子 session 注入 `todowrite: deny` / `task: deny`（`task.ts:78-96`）——**这就是为什么子 agent 默认不能再往下递归派发 task**（防止无限委派）。
- 通过 `SessionPrompt.prompt()` 在子 session 里跑目标 agent（`task.ts:130-144`），最终把最后一条 text 包进 `<task_result>` 返回给调用方（`task.ts:146-154`）。

### 2.3 `@agent` 显式提及：旁路确认但仍走 task

当用户用 `@general` 之类显式提及时，会产生一个 `agent` 类型的 part，`createUserMessage` 把它转成「请调用 task 工具，subagent: <name>」的合成提示（`prompt.ts:1238-1254`）；真正执行时 `handleSubtask` 用 `bypassAgentCheck: true` 调 `task` 工具（`prompt.ts:616-624`），跳过权限询问但**链路本质仍是 task 委派**——所以同样只能 @ 到非 primary 的 agent。

---

## 3. 调用路径 B：运行时编排调度（引擎 → 系统 agent）

`compaction`/`title` 这类 primary + hidden 的 agent，**没有任何「agent 调用 agent」的入口**。它们由 session 主循环 `runLoop`（`session/prompt.ts:1337-1565`）在固定时机直接驱动。调用者是「引擎」，不是「某个 agent」。

### 3.1 `title`：主循环在第 1 步 fork 一个标题任务

`prompt.ts:1383-1390`：

```ts
step++
if (step === 1)
  yield* title({ session, modelID: ..., providerID: ..., history: msgs })
    .pipe(Effect.ignore, Effect.forkIn(scope))   // ← fork 出去，不阻塞主回答
```

`title()`（`prompt.ts:189-250`）内部：`agents.get("title")` 取到 title agent → 直接调 `LLM.stream({ agent: ag, tools: {}, ... })` 生成标题 → `setTitle` 落库。**全程不经过 task 工具，不经过权限询问，用的是小模型**（`getSmallModel`，`prompt.ts:216`）。

### 3.2 `compaction`：上下文溢出时引擎自动插入压缩任务

主循环每轮都检查上一条 assistant 消息的 token 是否溢出（`prompt.ts:1412-1419`）：

```ts
if (lastFinished && lastFinished.summary !== true &&
    (yield* compaction.isOverflow({ tokens: lastFinished.tokens, model }))) {
  yield* compaction.create({ sessionID, agent: lastUser.agent, model: lastUser.model, auto: true })
  continue   // ← 下一轮循环就会处理这条 compaction 任务
}
```

`compaction.create`（`session/compaction.ts:349-372`）只是往会话里插一条带 `type: "compaction"` part 的 user 消息。下一轮循环 `runLoop` 检测到这条 compaction part（`prompt.ts:1400-1410`）就调 `compaction.process`：

```ts
if (task?.type === "compaction") {
  const result = yield* compaction.process({ messages: msgs, parentID: lastUser.id, sessionID, auto: task.auto, overflow: task.overflow })
  if (result === "stop") break
  continue
}
```

`compaction.process`（`compaction.ts:141-347`）才真正：`agents.get("compaction")` 取到 compaction agent → 用其专属 prompt（`prompt/compaction.txt` 或默认模板，`compaction.ts:189-219`）+ `tools: {}` 跑一次 LLM（`compaction.ts:256-271`），产出一段「续写摘要」，并以 `mode: "compaction", summary: true` 的 assistant 消息写回（`compaction.ts:224-250`）。`auto` 模式下还会自动追加一条「Continue...」user 消息让原 agent 接着干（`compaction.ts:285-342`）。

**触发 compaction 的三个入口**，全都不是「agent 调用」：

| 入口 | 位置 | 触发者 |
|------|------|--------|
| 自动溢出检测 | `prompt.ts:1412-1419` | 主循环每轮检查 |
| 模型返回 `compact` 信号（硬溢出） | `prompt.ts:1542-1550` | 处理器结果分支 |
| 手动 `/compact` | `server/routes/session.ts:535` | HTTP 路由（用户操作） |

注意手动入口（`server/routes/session.ts:527-544`）：它先取**当前会话的 agent**（`build` 之类）作为 `compaction.create` 的 `agent` 参数，但这个参数只用于「压缩完成后让哪个 agent 续写」，**压缩本身用的仍是 `compaction` agent**（`compaction.ts:179`）。这正是用户问题的精确答案——`build` 不「调用」compaction，而是 compaction 完成后把控制权**交还**给 build。

### 3.3 还有一层非 LLM 的 `prune`

`runLoop` 每轮收尾还会 fork 一个 `compaction.prune`（`prompt.ts:1562`）。`prune`（`compaction.ts:93-139`）是纯算法——倒着扫工具输出，把超过 `PRUNE_PROTECT`(40k) 的老旧工具结果标记为已压缩以腾空间，**不调任何 LLM、不涉及任何 agent**。它和 compaction agent 是两回事：prune 删旧工具输出，compaction 生成摘要。

### 3.4 `summary` agent：定义了但当前没人调

`summary` agent 在 `agent.ts:219-233` 有完整定义（含 `PROMPT_SUMMARY`），但全代码库**搜不到 `agents.get("summary")` 的调用方**（已 grep 确认）。容易混淆的 `SessionSummary` 命名空间（`session/summary.ts`）实际只做 **git diff 统计**（增删行数、文件数，`summary.ts:106-133`），**不调 LLM、不读 summary agent**。

结论：`summary` agent 属于**保留/休眠**状态，可能是为将来某个「会话总结」功能预留，或是历史遗留。当前 Ultrawork 运行时不会触发它。

---

## 4. 第三种协作：primary agent 之间靠「模式切换」而非「调用」

既然 primary agent 之间不能用 `task` 互相调用，那 `build` 和 `plan` 这两个 primary 到底怎么协作？答案是：**不通过调用，而是用户在同一 session 内逐条消息切换 agent，引擎负责注入「衔接提示」补齐上下文。**

### 4.1 每条 user 消息自带 agent，主循环逐条切换

会话主 agent 不是会话级固定的，而是**消息级**的——每条 user 消息都带自己的 `agent` 字段，主循环用 `agents.get(lastUser.agent)` 取当前这条消息该用哪个 primary（`prompt.ts:1421`）。所以用户完全可以：第 1 条消息用 `plan`（只读规划），第 2 条切到 `build`（动手执行），同一 session 内自由流转。这不是 agent A「调用」agent B，而是引擎按每条消息的 `agent` 字段切换驱动者。

### 4.2 引擎在切换边界注入衔接 system-reminder

切换 primary 时，`insertReminders`（`prompt.ts:252-299`）会检测「模式是否变了」并注入对应提示，让新 agent 知道自己的角色变化：

- **进入 `plan`**：注入 `plan.txt`（`prompt.ts:261-270`）——强约束「只读、禁止任何文件修改、禁止 sed/echo 等写操作」。注意 plan agent 的系统提示里明确写着 *"delegate explore agents to construct a plan"*——**plan 模式靠 `task` 委派 `explore`（路径 A）来读代码**，自己不动手。
- **从 `plan` 切回 `build`**：注入 `build-switch.txt`（`prompt.ts:271-281`）：

  ```
  <system-reminder>
  Your operational mode has changed from plan to build.
  You are no longer in read-only mode.
  You are permitted to make file changes, run shell commands...
  </system-reminder>
  ```

  若存在 plan 文件，还会追加「A plan file exists at <path>. You should execute on the plan defined within it」（`prompt.ts:289-298`），实现 plan→build 的「交接」。

所以 `plan` 与 `build` 的协作本质是：**用户切换 + 引擎注入衔接提示 + plan 文件作为载体**，而非任何形式的「agent 调用 agent」。这与路径 B（引擎调度 compaction/title）和路径 A（task 委派 subagent）共同构成了 OpenCode 里全部三种「多 agent 协同」形式。

---

## 5. 引擎内核：`runLoop` 的技术流程与架构

前面三条路径（A 委派 / B 调度 / C 切换）都由同一个引擎驱动——`session/prompt.ts` 的 `runLoop`。它是「一条用户消息进来后，把 agent 反复推进到完成」的主循环。这一节自底向上拆开它。

### 5.1 调用分层：从 HTTP 到 LLM

```
HTTP 路由 (server/routes/session.ts)            ← 用户发消息 / /compact / 命令
   │  SessionPrompt.prompt() | command() | shell()
   ▼
prompt()            (prompt.ts:1305-1324)        ← 建 user 消息、按 tools 参数写 session 权限
   │
   ▼
loop()              (prompt.ts:1567-1573)        ← 取「每 session 一个」的 Runner，并发去重
   │  runner.ensureRunning(runLoop(sessionID))
   ▼
runLoop()           (prompt.ts:1337-1565)        ← 主循环：每轮推进一步，直到 agent 收尾【核心】
   │  每轮 yield* processor.create(...).process(...)
   ▼
processor.process() (processor.ts:445-490)       ← 单步：流式跑一次 LLM + 执行工具，返回三态
   │  llm.stream(...)
   ▼
llm.stream()        (session/llm.ts)             ← 真正调 provider，吐出事件流
```

每一层职责单一：`prompt` 负责建消息和权限、`loop` 负责并发控制、`runLoop` 负责「推进到完成」的迭代决策、`processor` 负责「一步」的流式处理与工具执行、`llm` 负责协议适配。

### 5.2 并发模型：每 session 一个 Runner

`getRunner`（`prompt.ts:118-134`）为每个 sessionID 维护**最多一个活跃 Runner**：

- `ensureRunning`：若该 session 已有运行中的循环就复用，否则启动 `runLoop`——**保证同一 session 不会并发跑两个循环**。
- `busy()` 抛 `Session.BusyError`（`prompt.ts:128-130`）：会话忙时再发消息直接报忙。
- `onBusy`/`onIdle` 回调切换会话状态（`status.set` → idle/busy，`prompt.ts:122-126`），`onIdle` 时把 runner 从 map 删除。
- `cancel`（`prompt.ts:144-153`）触发 `runner.cancel` → 中断 Effect fiber → 传播到 `processor.abort()`（`processor.ts:432-443`）。
- scope finalizer 在实例关闭时取消所有 runner（`prompt.ts:108-113`）。

### 5.3 `runLoop` 每轮迭代流程

`runLoop`（`prompt.ts:1337-1565`）是一个 `while(true)`，每轮做如下决策（按源码顺序）：

```
while (true):
  status = busy                                         (1346)
  msgs = filterCompactedEffect(sessionID)               (1348) ← 折叠已压缩消息
  反向扫描 msgs，定位：                                   (1354-1362)
    lastUser / lastAssistant / lastFinished
    pending tasks = 末尾未完成的 compaction/subtask part

  ── 退出判定 ──                                          (1373-1381)
  if lastAssistant 已 finish 且 finish≠"tool-calls"
       且 无 tool 调用 且 在 lastUser 之后:  break        ← agent 答完了，退出循环

  step++
  if step==1:  fork title()                              (1384-1390) ← 路径 B：标题
  task = pending tasks.pop()

  ── 分支 1：子任务委派 ──                                 (1395-1398)
  if task.type=="subtask":  handleSubtask(); continue    ← 路径 A：task 工具

  ── 分支 2：压缩任务 ──                                   (1400-1410)
  if task.type=="compaction":
       r = compaction.process(); if r=="stop" break; continue  ← 路径 B：压缩

  ── 分支 3：自动溢出 ──                                   (1412-1419)
  if lastFinished 未压缩 且 isOverflow(tokens):
       compaction.create(auto); continue                 ← 触发下一轮走分支 2

  ── 分支 4：正常推进一步（主体）──                         (1421-1559)
  agent = agents.get(lastUser.agent)                     (1421) ← 路径 C：按消息切 agent
  insertReminders(msgs, agent)                           (1431) ← 路径 C：注入 plan/build 衔接提示
  新建 assistant 消息 + processor.create()               (1433-1453)
  tools = resolveTools(agent, session, ...)              (1460) ← 注册表+MCP，权限感知
  system = [环境, skills, instructions]                  (1501-1507)
  result = handle.process({user, agent, tools, system, messages, model})  (1510)
  分发 result：
     structured 输出齐全           → break               (1522-1527)
     result=="stop"                → break               (1541)
     result=="compact"             → compaction.create(auto, overflow); continue  (1542-1550)
     result=="continue"            → continue            (1551)

收尾：fork compaction.prune()                             (1562) ← 纯算法清理旧工具输出
return lastAssistant(sessionID)                          (1563)
```

要点：

- **多 agent 三条路径全在这一个循环里分发**：subtask→A、compaction→B、`agents.get(lastUser.agent)`+`insertReminders`→C。
- **`maxSteps`**：agent 可配 `steps` 上限（`prompt.ts:1429-1430`），到上限时给模型塞一条 `max-steps.txt` 提示（`prompt.ts:1516`）促其收尾。
- **`step==1` 还会触发 `SessionSummary.summarize`**（`prompt.ts:1479`，git diff 统计）和「首条消息生成标题」。
- **退出循环 ≠ 结束**：`break` 后仍 fork 一个 `prune` 再返回最后一条 assistant 消息给调用方。

### 5.4 `processor.process`：单步内部如何流式处理

`runLoop` 每轮调一次 `handle.process()`（`processor.ts:445-490`），它把 `llm.stream()` 的事件流逐个喂给 `handleEvent`，并返回 `"compact" | "stop" | "continue"` 三态：

```
process(streamInput):
  needsCompaction = false
  shouldBreak = (continue_loop_on_deny !== true)          (448)
  llm.stream(streamInput)
     .tap(handleEvent)                                    (457) ← 逐事件落库 + 副作用
     .takeUntil(() => needsCompaction)                    (458) ← 流中途检测到溢出就提前停
     .runDrain
     |> retry(SessionRetry.policy)                        (467) ← 瞬时错误自动重试(状态转 retry)
     |> catch(halt) |> ensuring(cleanup)                  (479-480)
  if needsCompaction:  return "compact"                   (486)
  if blocked | error | aborted:  return "stop"            (487)
  return "continue"                                       (488)
```

`handleEvent`（`processor.ts:111-430`）处理的关键事件：

| 事件 | 处理 | 源码 |
|------|------|------|
| `text-delta` / `reasoning-*` | 增量拼接文本/思维链 part | 117- |
| `tool-input-available` | 工具转 `running`；**doom-loop 检测**：连续 3 次相同工具+相同入参（`DOOM_LOOP_THRESHOLD=3`）触发 `doom_loop` 权限询问 | 180-212 |
| `tool-result` | 工具转 `completed`，写 output/metadata | 215-232 |
| `tool-error` | 工具转 `error`；若是 `Permission.RejectedError`/`Question.RejectedError` 则 `blocked = shouldBreak` | 234-251 |
| `start-step` | 抓 git snapshot，写 `step-start` part | 256-265 |
| `finish-step` | 累计 cost/tokens、写 `step-finish`、生成 `patch`(文件改动)、**溢出检测 → `needsCompaction=true`** | 267-309 |
| `error` | 抛出 → 进重试/halt | 253-254 |

所以「上下文溢出」有两个触发点：流式中途 `finish-step` 里探测（`processor.ts:305-309`，`takeUntil` 让本步提前收尾返回 `"compact"`），以及 `runLoop` 轮间 `isOverflow` 复查（`prompt.ts:1412`）。两者最终都汇到 `compaction.create` → 下一轮分支 2。

### 5.5 三态返回值如何驱动外层循环

`processor` 的三态是 `runLoop` 继续/停止的唯一信号：

- **`continue`** → `runLoop` 进入下一轮，把工具结果回灌给模型继续推进（agent 还没答完）。
- **`stop`** → `break`，结束循环（模型自然收尾，或被权限拒绝 `blocked`，或出错，或用户中断 `aborted`）。
- **`compact`** → `runLoop` 调 `compaction.create(auto, overflow)` 插入压缩任务，下一轮由分支 2 执行压缩，压缩完再 `continue` 让原 agent 接着干（`prompt.ts:1542-1550`）。

### 5.6 横切关注点

- **状态机**：`SessionStatus` 在 `idle / busy / retry` 间切换（`processor.ts:114, 470-476`、Runner 的 onBusy/onIdle），经 bus 推到前端（Ultrawork 的执行状态条）。
- **snapshot/patch/revert**：每步前后抓 git snapshot（`processor.ts:90, 257, 279`），算出 `patch` part 用于 diff 展示与 revert（呼应 MEMORY 里的 `/session/:id/diff|revert`）。
- **abort 传播**：用户取消 → `runner.cancel` → fiber interrupt → `Effect.onInterrupt` 置 `aborted` → `processor.abort()` halt + cleanup（`processor.ts:462, 489, 432-443`）。
- **重试**：`SessionRetry.policy`（`processor.ts:467`）对非中断类瞬时错误自动退避重试，期间状态转 `retry` 并把进度推前端。
- **bus/SSE**：所有 part/message 的 `session.updatePart`/`updateMessage` 都会广播事件，正是 MEMORY 里记录的 `message.part.updated` / `message.part.delta` / `message.updated` 等 SSE 事件来源。

### 5.7 runLoop 里的多 agent：谁在哪跑

「runLoop 中会出现多 agent」成立，但**同一个 runLoop 实例、同一时刻只驱动一个 agent**。多 agent 以三种不同方式出现，运行位置不同——这是最容易混淆的点：

| 方式 | 路径 | 运行位置 | 同一时刻并发？ |
|------|------|----------|---------------|
| 跨轮切换 primary（plan↔build） | C | **当前 session 的同一个 runLoop**，不同轮换 agent | 否，串行换人 |
| 轮内切到 `compaction` 跑一步 | B | **当前 session 的同一个 runLoop**（`compaction.process` 用当前 sessionID，`compaction.ts:251-255`） | 否，占当前轮 |
| `title` | B | fork 出的独立 `LLM.stream`，**不占 runLoop 步骤、不开子循环** | 是（后台 fork） |
| 委派子 agent（task） | A | **子 session 的另一个 runLoop**（独立 Runner），父 runLoop 阻塞等结果 | 可并行多个子 session |

#### 关键区分：委派子 agent 是「runLoop 调 runLoop」，不是「一个 runLoop 跑多 agent」

无论是 `handleSubtask` 分支（`prompt.ts:1395`、`@` 提及/命令子任务），还是模型在分支 4 里主动调 `task` 工具，最终都走 `TaskTool.execute` → `Session.create({ parentID })` 建**子 session** → `SessionPrompt.prompt(子session)` → `loop` → `getRunner(子sessionID)` 拿到**独立 Runner** → **子 session 自己的 runLoop**（`task.ts:75, 130-144`；Runner 按 sessionID 区分，`prompt.ts:118-120`）。

所以父 runLoop **从不直接跑子 agent 的多步迭代**——它只是发起一次工具调用，然后 `await` 子 session 的 runLoop 把子 agent 跑完、返回 `<task_result>`：

```
父 session runLoop (build)
  └─ 分支4：模型调 task 工具 / 分支：handleSubtask
       └─ TaskTool.execute → 建子 session → SessionPrompt.prompt(子session)
            └─ 子 session runLoop (general)        ← 另一个 Runner，独立 while 循环
                 ├─ 第1轮…  第2轮…  第N轮…          ← 子 agent 的多步全在这里
                 └─ return lastAssistant → <task_result>
       ◀── 父 runLoop 在此阻塞等待，拿到结果后继续本轮
```

#### 并行委派：一步发起多个 task → 多个子 runLoop 并跑

`task.txt:19` 明确指示模型「Launch multiple agents concurrently ... use a single message with multiple tool uses」。当模型在**同一个 assistant step** 里发出多个 `task` 工具调用时，AI SDK 并行执行这些 tool call，于是会**同时存在多个子 session 的 runLoop 在跑**（每个独立 Runner、独立 while 循环）。父 runLoop 等这一批全部返回后才进入下一轮。这是 OpenCode 实现「并行多 agent」的方式——靠子 session 横向扩展，而非单循环内并发。

> 注意 `handleSubtask` 分支是**串行**的：`tasks.pop()` 每轮只取一个 subtask part（`prompt.ts:1393`）。真正的并行只发生在「模型主动一步多调 task」时。

#### 嵌套深度：默认封顶两层

子 agent 默认**不能再往下委派**——`TaskTool.execute` 给子 session 注入 `task: deny`（除非目标 agent 显式声明了 `task` 权限，`task.ts:88-96`）。所以默认情况下 runLoop 嵌套最多两层：`build`(父) → `general`/`explore`(子)，子 runLoop 不会再开孙 runLoop。只有给自定义 agent 显式开 `task` 权限，才可能出现三层及以上的 runLoop 嵌套。

### 5.8 委派的闭环与异常

§5.7 讲了父 runLoop 发起委派后「阻塞等待」，这一节补上**等到之后拿到什么、出错/取消时怎么办**——即委派的完整生命周期。

#### 闭环：子 session 结果如何回灌父 runLoop

子 runLoop 跑完后，`TaskTool.execute` 取子 session **最后一条 text**，包成带 `task_id` 的 `<task_result>` 字符串作为**工具结果**返回（`task.ts:146-154`）：

```
task_id: <子sessionID> (for resuming to continue this task if needed)

<task_result>
（子 agent 的最终回答文本）
</task_result>
```

这个结果落回父 session 的 **task 工具 part**：

- **模型主动调 task** 路径：经父 processor 的 `tool-result` 事件写成 `completed` part（`processor.ts:215-232`）。
- **`handleSubtask`** 路径（`@` 提及/命令子任务）：直接写成 `completed` 的 task 工具 part（`prompt.ts:691-700`）。

无论哪条，结果都成为父 session 的一条工具 part → **下一轮父 runLoop** 通过 `toModelMessages` 把它回灌给父模型，父 agent 据此继续推进。**子 agent 的中间步骤不进入父上下文，只有最终 `<task_result>` 进**——这正是「委派」相对「同 session 多步」的上下文隔离优势。

#### 异常：子任务失败被隔离，不炸父循环

子 agent 跑挂时，失败被收敛成父 session 的**一条 error 工具 part**，父 runLoop 照常进行：

- **`handleSubtask`** 路径：`taskTool.execute` 的 reject 被 `.catch` 捕获（`prompt.ts:647-651`），转成 error part，父循环继续。
- **模型主动调 task** 路径：抛错经 `tool-error` 事件转 error part（`processor.ts:234-251`）；父模型在下一轮看到错误结果，可自行决定重试或换路。

#### 取消：父 abort 向下级联到子 runLoop

父 session 被取消时，取消信号**向下传播**终止子 runLoop——`TaskTool.execute` 在子 session 启动前注册了 abort 监听（`task.ts:123-127`）：

```ts
function cancel() { SessionPrompt.cancel(session.id) }   // session.id 是子 session
ctx.abort.addEventListener("abort", cancel)
using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
```

父 runLoop 的 abort（`runner.cancel` → fiber interrupt）传到 task 工具的 `ctx.abort` → 触发 `cancel()` → `SessionPrompt.cancel(子session)` → 子 Runner 取消 → 子 runLoop 中断。并行的多个子 session 各自被各自的 abort 监听级联取消。

#### 续接：`task_id` 可恢复同一子 session

返回结果里带的 `task_id` 不只是展示——`task` 工具的 `task_id` 参数允许「续接」：传入既有 `task_id` 时，`TaskTool.execute` 复用该子 session（`Session.get` 命中则不新建，`task.ts:70-73`），子 agent 带着之前的消息与工具输出继续，而非全新上下文。这让父 agent 能「分多次推进同一个子任务」。

---

## 6. 调用关系全景图

```
                    ┌─────────────────────────────────────────────┐
                    │         session 运行时循环 runLoop            │
                    │            (session/prompt.ts)                │
                    └─────────────────────────────────────────────┘
                       │ 调度(非 LLM 决策，引擎按时机直接调用)
        ┌──────────────┼───────────────────────────┬──────────────┐
        │ step==1 fork │ 溢出/硬compact/手动 /compact │ 每轮收尾 fork │
        ▼              ▼                            ▼              
   ┌─────────┐   ┌──────────────┐            ┌──────────┐         
   │ title   │   │ compaction   │            │  prune   │ (纯算法,无agent)
   │(primary,│   │ (primary,    │            └──────────┘         
   │ hidden) │   │  hidden)     │                                  
   └─────────┘   └──────────────┘                                  
                        │ 压缩完成后交还控制权 (auto: 追加"Continue")
                        ▼
   ┌───────────────────────────────────────────────────────────┐
   │  会话主 agent (primary/all)：build / plan / 自定义           │
   │   —— 用户直接对话的那个 LLM                                  │
   └───────────────────────────────────────────────────────────┘
                        │ LLM 主动调 task 工具 (路径 A)
                        │ 仅候选 mode != "primary" 的 agent (task.ts:29)
                        ▼
   ┌───────────────────────────────────────────────────────────┐
   │  子 agent (subagent/all)：general / explore / 自定义         │
   │   —— 在独立子 session 运行，权限默认收紧(禁 task/todowrite)   │
   └───────────────────────────────────────────────────────────┘

   ✗ build ──task──▶ compaction   不可能：compaction.mode==="primary"，被 task.ts:29 过滤
   ✗ build ──task──▶ title/plan   同上，所有 primary 都进不了 task 候选
   ✓ build ──task──▶ general/explore   可以（路径 A）
   ✓ runLoop ─调度─▶ compaction/title   引擎调度（路径 B，非 agent 行为）
   ↹ plan ⇄ build   用户逐条消息切换 primary + 引擎注入衔接提示（路径 C，非调用）
```

---

## 7. 直接回答用户的问题

**Q1: OpenCode 有哪些内置 agent？**
7 个：`build`、`plan`、`general`、`explore`（前 4 个可见）+ `compaction`、`title`、`summary`（后 3 个 `hidden` 系统 agent）。见 §1。

**Q2: 它们如何相互调用？**
三种协同形式，但只有第一种是真正的「agent 调 agent」：
- **路径 A（调用）**：primary/all 主 agent 通过 `task` 工具委派给 subagent/all 子 agent。
- **路径 B（引擎调度）**：`compaction`/`title` 由 session 引擎在固定时机直接驱动，不算 agent 间调用。
- **路径 C（模式切换）**：`plan` 与 `build` 等 primary 之间靠用户逐条消息切换 + 引擎注入衔接提示协作，也不是调用（§4）。

**Q3: 都是 primary，`build` 能调用 `compaction` 吗（用 task 派发）？**
**不能。** 两道闸门：
1. `task` 工具候选列表在 `task.ts:29` 就 `filter(a => a.mode !== "primary")`，`compaction` 是 primary，根本不出现在工具描述里，LLM 无从调用。
2. 退一步说，`compaction` 的 permission 是 `"*": deny`，连自己都不能用工具，更不是被派发的目标。

primary agent 之间（build/plan/compaction/title/summary）**互相都不能用 task 调用**——task 的设计就是「主→子」单向委派，不支持「主→主」。

**Q4: 那 `compaction`/`title` 是谁调用的？**
是 **session 主循环 `runLoop`**（`session/prompt.ts`）：
- `title` —— 每个会话第 1 步 fork 调用（`prompt.ts:1385`）。
- `compaction` —— 检测到 token 溢出 / 模型返回 compact 信号 / 用户手动 `/compact` 时，由引擎插入并执行（`prompt.ts:1412-1419`、`1542-1550`、`server/routes/session.ts:535`）。

它们由「引擎」按固定时机直接驱动 LLM，**绕过 task 工具、绕过权限询问、用各自专属 prompt**。所以严格说不是「被某个 agent 调用」，而是「被会话运行时调度」。手动 `/compact` 时虽然传入了当前 agent（如 build）的名字，但那只决定**压缩后由谁续写**，压缩动作本身永远由 `compaction` agent 完成。

---

## 关键源码索引

| 主题 | 位置 |
|------|------|
| 7 个内置 agent 定义 | `agent/agent.ts:107-234` |
| `Agent.Info` schema（mode/hidden/native） | `agent/agent.ts:27-52` |
| 默认 agent 决议（拒绝 subagent/hidden） | `agent/agent.ts:297-309` |
| `task` 候选过滤（踢掉 primary + 权限过滤） | `tool/task.ts:28-43` |
| `task` 子 session 创建 + 权限降级 | `tool/task.ts:69-103` |
| `@agent` → subtask → task（bypassAgentCheck） | `session/prompt.ts:1238-1254`、`553-646` |
| 主循环 `runLoop` | `session/prompt.ts:1337-1565` |
| `title` fork 调用 | `session/prompt.ts:1385-1390`、`title()` 189-250 |
| compaction 溢出自动触发 | `session/prompt.ts:1412-1419` |
| compaction 硬溢出（compact 信号） | `session/prompt.ts:1542-1550` |
| compaction 任务处理分支 | `session/prompt.ts:1400-1410` |
| `compaction.process`（真正跑 LLM 摘要） | `session/compaction.ts:141-347` |
| `compaction.create`（插入 compaction part） | `session/compaction.ts:349-372` |
| `prune`（纯算法删旧工具输出） | `session/compaction.ts:93-139` |
| 手动 `/compact` HTTP 路由 | `server/routes/session.ts:527-544` |
| `summary` agent 定义（无活跃调用方） | `agent/agent.ts:219-233` |
| `SessionSummary`（只做 diff 统计） | `session/summary.ts:106-133` |
| 工具按 permission `deny` 从模型可见列表移除 | `session/llm.ts:336-342`、`permission/index.ts:299-308` |
| primary 模式切换 + 衔接提示注入（plan↔build） | `session/prompt.ts:252-299`、`prompt/build-switch.txt`、`prompt/plan.txt` |
| 每条 user 消息按自身 agent 字段切换驱动者 | `session/prompt.ts:1421` |
| `generate`（生成 agent 配置的脚手架，非运行时 agent） | `agent/agent.ts:329-390`、`agent/generate.txt` |
| 各 agent 模型选择（子/title/compaction） | `tool/task.ts:108-111`、`session/prompt.ts:214-217`、`session/compaction.ts:179-182` |
| 调用分层 prompt→loop→runLoop→processor→llm | `session/prompt.ts:1305-1324, 1567-1573, 1337-1565`、`session/processor.ts:445-490`、`session/llm.ts` |
| Runner 并发模型（每 session 一个 + BusyError） | `session/prompt.ts:118-134, 144-153` |
| `runLoop` 主循环每轮分支与退出判定 | `session/prompt.ts:1344-1563` |
| `processor.process` 三态返回（compact/stop/continue） | `session/processor.ts:445-490` |
| 工具流式事件处理（含 doom-loop、溢出检测） | `session/processor.ts:111-430`（doom-loop 188-212、溢出 305-309） |
| abort 传播 / 重试 / 状态机 | `session/processor.ts:432-443, 462-480`、Runner onBusy/onIdle |
| 委派子 agent = 子 session 的独立 runLoop（runLoop 调 runLoop） | `tool/task.ts:75, 130-144`、`session/prompt.ts:118-120, 1395` |
| 并行委派（一步多 task → 多子 runLoop 并跑） | `tool/task.txt:19` |
| 子 agent 默认不能再委派（嵌套封顶两层） | `tool/task.ts:88-96` |
| 结果回灌：`<task_result>` 作为工具结果 | `tool/task.ts:146-154`、`session/processor.ts:215-232`、`session/prompt.ts:691-700` |
| 子任务失败隔离（不炸父循环） | `session/prompt.ts:647-651`、`session/processor.ts:234-251` |
| 父 abort 向下级联到子 runLoop | `tool/task.ts:123-127` |
| `task_id` 续接同一子 session | `tool/task.ts:70-73` |

---

## 附：与 Ultrawork 的关系（仅说明，无改动建议）

- Ultrawork 前端发消息不传 `agent`，落到默认 `build`（见 [Discussion 004 §1](004-opencode-multi-agent.md)）。所以普通会话里：用户 ↔ `build`，`build` 可按需 `task` 委派给 `general`/`explore`，引擎在背后自动跑 `title`（首条消息生成标题）和 `compaction`（上下文满时压缩）。
- 这三类系统 agent 对前端是透明的：`title` 结果体现为会话标题更新；`compaction` 体现为聊天流里一条 `summary: true` 的助手消息（被 `filterCompactedEffect` 折叠）。Ultrawork 当前 UI 未单独暴露「触发压缩 / 看 title agent」的入口，全靠 sidecar 自动调度。
- `summary` agent 休眠，不影响 Ultrawork。
