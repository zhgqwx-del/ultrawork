# Discussion 005: Permission Dock 与 Question Dock 机制调研 — 挂起式权限/提问的端到端实现

- **日期**: 2026-06-04
- **状态**: 调研记录（仅分析，无代码改动）
- **参与者**: 用户 + Claude
- **范围**: 基于 `vendor/opencode` 源码（submodule，已 apply Ultrawork patch）+ Ultrawork main 分支前端代码

> 本文回答三个问题：(1) Permission Dock / Question Dock 的原理是什么？(2) 从工具调用到 UI 弹出再到回复，完整技术流程如何流转？(3) 当前 UI 形态——它们到底是不是「主聊天区弹窗」？
>
> 所有结论均带源码定位（`文件:行号`），可直接跳读核对。

---

## TL;DR

1. **两套机制结构高度对称，本质都是「挂起式询问」**。OpenCode 服务端用 Effect 的 `Deferred`（可挂起的 Promise）把工具的执行流**冻结**，通过 SSE 广播一个 `*.asked` 事件，客户端回复后再 `succeed`/`fail` 该 Deferred 唤醒工具继续。Permission 管「该不该执行这个副作用」，Question 管「AI 想问用户一个选择题」。

2. **它们不是浮层弹窗（modal/popup），而是底部输入区的「内嵌替换卡片」**。在 `Session.tsx` 里，底部那块区域是三选一互斥渲染：`pendingQuestion ? <QuestionDock> : pendingPermission ? <PermissionDock> : <ChatInput>`。两个 Dock 直接**顶替**了聊天输入框的位置，停留在消息流下方、正常文档流中（非 `fixed`/`absolute` 遮罩层），自身用 `mx-auto max-w-[800px]` 居中。优先级：question > permission > 输入框。

3. **触发是被动的、由 SSE 驱动 + 3 秒轮询兜底**。前端 `useSessionPermission` hook 订阅 SSE 的 `permission.asked` / `question.asked`，按 `sessionID` 过滤后塞进**单槽**状态（不是队列，新事件覆盖旧的）。同时在 agent 活跃期每 3 秒拉一次 `GET /permission` 和 `GET /question` 做漏事件兜底。回复采用**乐观清除 + 失败回滚**。

---

## 1. 整体架构：一次「挂起式询问」的生命周期

以最常见的 **edit 工具写文件需要授权** 为例，端到端链路如下：

```
① AI 决定调用 edit 工具
       │
② edit 工具在真正写盘前调用 ctx.ask({permission:"edit", patterns:[相对路径], metadata:{diff}})
       │   tool/edit.ts:65 / 100
③ Permission.ask 求值规则：deny→直接拒 / allow→直接放行 / 默认→需要询问
       │   permission/index.ts:167-202, evaluate.ts:9-15
④ 需要询问 → 创建 Deferred，存入 pending Map，bus.publish("permission.asked", request)
       │   permission/index.ts:193-195
       │   ⇩ 工具执行流在 Deferred.await 处冻结（permission/index.ts:197）
⑤ 事件经 wildcard PubSub 流入 GET /event SSE 流，推给客户端
       │   bus/index.ts:83-99 → server/routes/event.ts:64-77
⑥ 前端 useSessionPermission 收到 permission.asked，setPendingPermission(request)
       │   use-session-permission.ts:30-36
⑦ Session.tsx 检测到 pendingPermission 非空，底部渲染 <PermissionDock>（顶替 ChatInput）
       │   pages/Session.tsx:159-191
⑧ 用户点 Allow Once / Allow Always / Reject
       │
⑨ 前端乐观清除 dock，POST /permission/{id}/reply {reply}
       │   use-session-permission.ts:84-96 → api-client client.ts:205-214
⑩ Permission.reply 取出 Deferred，succeed（放行）或 fail（抛 RejectedError）
       │   permission/index.ts:204-260
       │   ⇩ ④ 处 await 解冻
⑪ once→执行写盘；reject→工具抛错；always→写盘 + 把模式写进 approved 规则集
       │   edit tool 在 ask 之后才 Filesystem.write（tool/edit.ts:74）
```

Question 走的是同一套骨架（`Deferred` + `bus.publish` + SSE + HTTP reply），只是没有「规则评估/always 持久化」这一层——每次都挂起询问，且返回值是用户选的答案 `string[][]` 而非简单放行。

**核心设计点**：服务端用 `Deferred` 把异步「等待用户」变成可挂起的同步流程，`Effect.ensuring` 保证无论结果如何都从 `pending` 表清理；SSE 是**单向广播**通道，回复走**独立的 HTTP POST** 路由——两条通道解耦。

---

## 2. 服务端（vendor/opencode）

### 2.1 Permission 机制

**核心文件：`vendor/opencode/packages/opencode/src/permission/index.ts`**

数据结构（行 43-63）：

```ts
Request = { id, sessionID, permission, patterns[], metadata, always[], tool? }
Reply   = enum(["once", "always", "reject"])
```

内部状态（行 123-131）：

```ts
interface PendingEntry { info: Request; deferred: Deferred<void, RejectedError|CorrectedError> }
interface State { pending: Map<PermissionID, PendingEntry>; approved: Ruleset }
```

`pending` 是挂起请求表，`approved` 是已批准规则集（启动时从 `PermissionTable` 按 project_id 读取，行 146-152）。

**`ask`（行 167-202）** 是核心：

1. 对每个 `pattern` 调用 `evaluate(permission, pattern, ruleset, approved)` 求值：
   - `deny` → 立即 `DeniedError`（不询问，直接拒）
   - `allow` → 跳过
   - 否则（默认 `ask`）→ 标记 `needsAsk = true`
2. 若全部 allow → 直接 return（行 184，工具无感放行）
3. 否则创建挂起：

```ts
const deferred = yield* Deferred.make<void, RejectedError|CorrectedError>()  // 行 193
pending.set(id, { info, deferred })
yield* bus.publish(Event.Asked, info)                                       // 行 195 → permission.asked
return yield* Effect.ensuring(
  Deferred.await(deferred),                                                 // 行 197 挂起等待 reply
  Effect.sync(() => { pending.delete(id) }),                                // finalizer 清理
)
```

**求值默认值**：`permission/evaluate.ts:9-15` 用 `findLast` 匹配规则（permission + pattern 双 Wildcard），**无匹配时默认 `{action:"ask"}`** —— 即默认询问，安全优先。

**`reply`（行 204-260）** 的三种语义：

- **`reject`**（行 216-233）：有 `message` 则 `CorrectedError({feedback})`，否则 `RejectedError`，`Deferred.fail` 让工具抛错。然后**级联拒绝同 session 的所有其他 pending**（行 222-231）——一次 reject 清空该 session 待批准请求。
- **`once`**（行 235-236）：`Deferred.succeed(deferred, undefined)` 放行本次，不写入 approved。
- **`always`**（行 238-259）：先 succeed 本次；把 `info.always` 的 pattern 追加进 `approved`（action `allow`）；再**重新求值同 session 其他 pending**，凡现在全部 allow 的也一并放行。

> `always` 只改内存 Ruleset；持久化到 `PermissionTable` 的逻辑在 state 初始化时读取（行 146-152）。

**HTTP 路由**（`server/routes/permission.ts`，挂载于 `server/instance.ts:51`）：

| 路由 | Method | Body | 行号 |
|---|---|---|---|
| `/permission/:requestID/reply` | POST | `{ reply, message? }` | 11-46 |
| `/permission` | GET | — (返回 pending `Request[]`) | 47-68 |

> 另有 session 级别名 `POST /session/:sessionID/permissions/:permissionID`（`session.ts:996-1025`，转发到 `Permission.reply`）。

### 2.2 Question 机制

**核心文件：`vendor/opencode/packages/opencode/src/question/index.ts`** —— 结构与 Permission 对称，但**无规则评估层**，每次都问。

数据结构（行 16-58）：

```ts
Option  = { label, description }
Info    = { question, header, options[], multiple?, custom? }   // 单个问题
Request = { id, sessionID, questions: Info[], tool? }
Answer  = string[]                                              // 某问题选中的 label 数组
Reply   = { answers: Answer[] }                                // 即 string[][]：外层对应每个 question
```

**`ask`（行 132-157）**：`Deferred.make<Answer[], RejectedError>()` → `pending.set` → `bus.publish(Event.Asked, info)`（行 149，广播 `question.asked`）→ `Deferred.await` 挂起。

**触发场景（谁调用 `Question.ask`）**：

- `tool/question.ts:6-33`：内置 **question tool**，AI 主动调用向用户提问，把 `answers` 格式化回填给模型。
- `tool/plan.ts:25,82`：plan 工具用问答确认计划（答 "No" 抛 `Question.RejectedError`）。

**`reply` / `reject`**（行 159-190）：reply → 广播 `Event.Replied` + `Deferred.succeed(answers)`，AI 收到答案继续；reject → 广播 `Event.Rejected` + `Deferred.fail`（"The user dismissed this question"）。

**HTTP 路由**（`server/routes/question.ts`，挂载于 `server/instance.ts:52`）：

| 路由 | Method | Body | 行号 |
|---|---|---|---|
| `/question` | GET | — (返回 pending `Request[]`) | 12-33 |
| `/question/:requestID/reply` | POST | `{ answers: string[][] }` | 34-68 |
| `/question/:requestID/reject` | POST | — | 69-97 |

### 2.3 SSE 事件总线：从 `bus.publish` 到 `/event`

**Bus**（`bus/index.ts`）：
- `publish`（行 83-99）对 typed PubSub 和 **wildcard PubSub** 各发布一份，并额外 `GlobalBus.emit("event", ...)`（跨实例广播）。
- `subscribeAll`（行 112-120 / 182-184）从 wildcard PubSub 取流，回调形式订阅。

**`/event` SSE 路由**（`server/routes/event.ts`，挂载于根 `server/instance.ts:55`）：

```ts
// 行 64-77
Bus.subscribeAll((event) => q.push(JSON.stringify(event)))   // 任何 bus.publish 的事件都进队列
for await (const data of q) await stream.writeSSE({ data })  // 逐条推给客户端
```

每 10s 推 `server.heartbeat`（行 46-53），收到 `Bus.InstanceDisposed` 或 `stream.onAbort` 时清理。**`permission.asked` / `question.asked` / `*.replied` / `*.rejected` 全部经此通道**推送给客户端。

> 注意：事件的 `properties` **直接就是 Request 对象**（不是嵌套结构），与 MEMORY.md「SSE blocking events properties 直接是 request 对象」记录一致。

### 2.4 工具调用如何绑定 Permission

工具拿到的 `ctx.ask` 在 `session/prompt.ts:425-434` 注入：

```ts
ask: (req) => Effect.runPromise(
  permission.ask({
    ...req,
    sessionID: input.session.id,
    tool: { messageID: ..., callID: options.toolCallId },
    ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),  // 行 431
  }),
)
```

关键：**ruleset = agent 权限 ∪ session 权限合并**。

具体工具示例：

- **edit tool**（`tool/edit.ts:65,100`）：写盘前 `ctx.ask({permission:"edit", patterns:[相对路径], metadata:{diff}})`，`metadata.diff` 让前端可预览改动；被 reject 则 `write` 不执行。
- **bash tool**（`tool/bash.ts:267-288`）：静态扫描命令后分别按 `external_directory` 和 `bash` 两种 permission 询问，patterns 是具体命令片段。
- **MCP 工具**（`session/prompt.ts:492`）：统一按工具名 `ctx.ask({permission:<toolName>, patterns:["*"], always:["*"]})`。
- `permission/index.ts:297` 的 `EDIT_TOOLS = ["edit","write","apply_patch","multiedit"]` 统一映射到 `"edit"` 权限——一条 `edit` 规则管控所有编辑类工具。

---

## 3. 前端（Ultrawork main 分支）

### 3.1 触发与状态：`useSessionPermission` hook

**文件：`packages/client/desktop/src/lib/use-session-permission.ts`**

状态（行 17-18）是**单槽**，不是队列——新事件覆盖旧的：

```ts
const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
const [pendingQuestion,   setPendingQuestion]   = useState<QuestionRequest | null>(null)
```

**SSE 订阅**（行 27-60，`useSSESubscribe(handleSSEEvent)`）：

| 事件 | 处理 | 行号 |
|---|---|---|
| `permission.asked` | `setPendingPermission`（按 `sessionID` 过滤） | 30-36 |
| `permission.replied` | 清除 `pendingPermission` | 37-41 |
| `question.asked` | `setPendingQuestion`（按 `sessionID` 过滤） | 42-48 |
| `question.replied` / `question.rejected` | 清除 `pendingQuestion` | 49-54 |

**3 秒轮询兜底**（行 63-81）：当 `sessionID` 存在、`isAgentActive` 为真、且当前无 pending 时，立即 `api.listPermissions()` + `api.listQuestions()`，之后每 3000ms 轮询一次，按 `sessionID` 匹配——补 SSE 漏掉的事件。

**回复：乐观清除 + 失败回滚**（行 84-121）：

```ts
function replyPermission(reply) {
  const perm = pendingPermission
  setPendingPermission(null)                         // 先乐观清 UI
  api.replyPermission(perm.id, reply).catch(() => {
    setPendingPermission(perm)                       // 失败回滚
    toast.error(t("error.replyPermission"))
  })
}
```

`replyQuestion(answers)` 和 `rejectQuestion()` 同理。

### 3.2 渲染：底部输入区的「三选一互斥替换」

**文件：`packages/client/desktop/src/pages/Session.tsx:159-191`**

```tsx
{/* Reply Input / Permission Dock / Question Dock */}
<div className="relative flex shrink-0 justify-center">
  {pendingQuestion ? (
    <QuestionDock request={pendingQuestion} onReply={replyQuestion} onReject={rejectQuestion} />
  ) : pendingPermission ? (
    <PermissionDock request={pendingPermission} onReply={replyPermission} />
  ) : (
    <div className="w-full max-w-[800px] px-4 py-3"><ChatInput .../></div>
  )}
</div>
```

**关于「是否是主聊天区弹窗」的结论**：

> **严格说，不是浮层弹窗（modal/dialog/popup）。** 它们是底部输入框区域的**内嵌替换卡片**——当有 pending 时，Dock 直接顶替了 `ChatInput` 的位置，处于正常文档流（非 `fixed`/`absolute` 遮罩）。父容器 `flex shrink-0 justify-center` 是消息流（可滚动区 `Session.tsx:134-157`）下方的非滚动 footer，Dock 自身用 `mx-auto max-w-[800px]` 居中。
>
> 因此体感上「在主聊天区底部冒出来一张卡片要你点」，但实现上**没有遮罩、不阻断页面其余部分、不是 z-index 浮层**，而是占位式替换。优先级 question > permission > 输入框。`isAgentActive = sending || streamingMessageId !== null`（`Session.tsx:63`）。

### 3.3 PermissionDock 组件（无状态）

**文件：`packages/client/desktop/src/components/chat/permission-dock.tsx`**

Props（行 5-8）：`{ request: PermissionRequest; onReply: (reply: "once"|"always"|"reject") => void }`。

是个**纯受控组件、无内部 state**。渲染（行 23-77）：琥珀色主题卡片（`border-amber-500/30 bg-amber-500/5`，`max-w-[800px]` 居中），含：
- `Shield` 图标 + 标题 `{t("permission.title")} — {label}`，`label` 由 `permissionLabels` 查表（行 10-21）：`bash → "Bash Command"`、`edit`、`write`、`read`、`external_directory`，未命中回退原始字符串。
- 描述文本 + `request.patterns[]` 列表（每条渲染为 `<code>` 块，行 40-51）。
- 三个按钮直接调 `onReply`（行 54-74）：Reject → `onReply("reject")`；Allow Always → `onReply("always")`；Allow Once → `onReply("once")`（主按钮）。

### 3.4 QuestionDock 组件（有状态的多问题向导）

**文件：`packages/client/desktop/src/components/chat/question-dock.tsx`**

Props（行 6-10）：`{ request: QuestionRequest; onReply: (answers: string[][]) => void; onReject: () => void }`。

是个**有状态的多问题 wizard**（一个 `QuestionRequest` 可含 `questions: QuestionInfo[]`）。状态（行 14-25）：

```ts
const [currentIndex, setCurrentIndex] = useState(0)        // 当前显示第几题
const [answers, setAnswers]           = useState<string[][]>(...)  // 每题选中的 label
const [customInputs, setCustomInputs] = useState<string[]>(...)    // 每题自由文本
useEffect(() => { /* reset all */ }, [request.id])         // request 变化时重置（处理连续提问）
```

每题渲染（行 68-157）：`HelpCircle` 图标 + `q.header` + `current/total` 计数器；问题文本；选项列表（每项 `opt.label` + `opt.description`，蓝色 radio 指示器）；`q.custom !== false` 时显示自由文本 `<input>`。

交互逻辑：
- `toggleOption`（行 34-47）：`q.multiple === true` 时多选切换；否则单选。
- `handleNext`（行 49-60）：若是最后一题，把非空 trimmed 自由文本作为额外答案条目合并进 `finalAnswers`，调 `onReply(finalAnswers)`；否则 `currentIndex++`。
- `handleBack`（行 62-64）：`currentIndex--`（仅 `currentIndex > 0` 显示）。
- 按钮（行 133-156）：Dismiss → `onReject()`；Back；Next/Submit（最后一题文案为 Submit，`!hasSelection` 时禁用——`hasSelection` = 有选中项或非空自由文本）。

### 3.5 api-client 方法

**文件：`packages/core/api-client/src/client.ts`**（行 205-233）

```ts
listPermissions()                   → GET  /permission                       → PermissionRequest[]
replyPermission(id, reply)          → POST /permission/{id}/reply  {reply}    → void
listQuestions()                     → GET  /question                         → QuestionRequest[]
replyQuestion(id, answers)          → POST /question/{id}/reply    {answers}  → void
rejectQuestion(id)                  → POST /question/{id}/reject              → void
```

类型（`packages/core/api-client/src/types.ts:182-210`）：

```ts
interface PermissionRequest {
  id; sessionID; permission; patterns: string[]; metadata; always: string[]
  tool?: { messageID; callID }
}
interface QuestionInfo { question; header; options: {label,description}[]; multiple?; custom? }
interface QuestionRequest { id; sessionID; questions: QuestionInfo[]; tool? }
```

---

## 3.6 前端 SSE 链路：`/event` 如何送到 hook

`useSessionPermission` 订阅的不是它自己开的连接，而是一个**全局共享的 SSE 流**：

- **连接方式**：`packages/client/desktop/src/lib/sse-client.ts:78-177` 用 `fetch()` 流式读取 `/event`（**不是原生 `EventSource`**，因为要带 `Authorization: Basic` 头，sse-client.ts:99-103）。目标 URL = `new URL("/event", config.baseUrl)`。
  - Dev 模式 `baseUrl=""` → 相对路径走 **Vite proxy**（`vite.config.ts:27` `/event → localhost:4096`）。
  - 生产模式 `baseUrl=apiBaseUrl` → **直连 OpenCode sidecar `localhost:4096`**。
  - 两种模式都打到 OpenCode :4096，**不经过 Gateway**。
- **广播分发**：`SSEProvider`（`sse-context.tsx:18-93`）按 workspace 创建**唯一一个** `SSEClient`，注册一个 `masterHandler`（:28-45）；该 handler 把每个事件 `handlersRef.current.forEach((h) => h(event))` 广播给所有订阅者。组件用 `useSSESubscribe(handler)`（:96-110）加入同一个全局 `Set`。底层 `SSEClient.handlers` 是 `Set<SSEEventHandler>`（sse-client.ts:68），解析每行 `data:` 后 `forEach` 分发（:149-158）。
- 即：**一个 fetch 流（每 workspace 一个）→ masterHandler → 广播给所有 `useSSESubscribe` 订阅者**；`useSessionPermission` 只是其中之一，自己按 `sessionID` 过滤。

## 3.7 渠道（钉钉/微信）场景：没有桌面 UI 时怎么办？

这是 Dock 机制的一个**重要边界**——当 session 由 Gateway（`packages/channel/gateway`）驱动、前台没有桌面 UI 时，`permission.asked` / `question.asked` 由谁来回复？

**(1) 默认很少触发 ask**：Gateway 发 prompt 时 `bridge.ts:206` 只传 `{ model }`，**不带 agent、不设 permission**。OpenCode 回退到默认 agent `build`，其 permission 基线是 `"*": "allow"`（`vendor/.../agent/agent.ts:86-119`），绝大多数工具直接放行、不触发 ask。仅少数项仍会 `ask`：读取 `*.env`、工作区外路径（`external_directory`）、`doom_loop` 等。

**(2) Gateway 自己充当「无头回复端」**：Bridge 也订阅了 OpenCode 的 `/event` SSE（`bridge.ts:294-391`，直连 `127.0.0.1:4096`）并自动处理：
  - `onPermissionAsked`（`bridge.ts:463-475`）→ 自动 `replyPermission(id, "once")`（**自动批准**）。
  - `onQuestionAsked`（`bridge.ts:478-490`）→ 自动 `rejectQuestion(id)`（**自动拒绝**，因为无人能在渠道里答选择题）。
  - 同样有 **3 秒轮询兜底**（`bridge.ts:528-567`，`POLL_MAX_LIFETIME_MS` 最长 5 分钟）。
  - 前提 guard：`activeContexts.get(sessionID)` 必须存在（`bridge.ts:464-465/479-480`），该 context 在 prompt 发送后建立、idle/error 时清除。

**(3) 会永久挂起吗？** vendor 的 `Permission.ask` 在有 `ask` 项时创建 `Deferred` 并 `Deferred.await` **阻塞工具调用**，直到 reply 端 `succeed/fail`（`permission/index.ts:193-197`）。
  - **正常情况不会挂起**：Bridge 的 auto-reply + 轮询会 resolve 它。
  - **边缘情况会挂起**：若 permission 在 `activeContext` 已被清理后才送达（guard 直接 return 不回复）、且已超过 5 分钟轮询窗口，则该 Deferred 无人 resolve，工具一直阻塞——唯一兜底是 OpenCode 实例 dispose 时的 finalizer 遍历 `pending` 全部 `Deferred.fail(RejectedError)`（`permission/index.ts:154-161`）。由于默认 agent 触发 ask 的场景本就少见，这是低概率边界。

> 设计含义：Permission/Question Dock 是**桌面端 UI 的人工确认通道**；渠道端则是 Bridge 内置的「自动批准权限 + 自动拒绝提问」策略——两者共用服务端同一套挂起机制，但回复端完全不同。

---

## 4. 关键文件清单

| 关注点 | 文件:行 |
|---|---|
| **服务端** | |
| Permission ask / reply / list | `vendor/opencode/.../permission/index.ts`（ask 167-202，reply 204-260） |
| Permission 规则求值（默认 ask） | `vendor/opencode/.../permission/evaluate.ts:9-15` |
| Permission HTTP 路由 | `vendor/opencode/.../server/routes/permission.ts`（reply 11-46，list 47-68） |
| Question ask / reply / reject | `vendor/opencode/.../question/index.ts`（ask 132-157，reply 159-174，reject 176-190） |
| Question HTTP 路由 | `vendor/opencode/.../server/routes/question.ts`（list 12-33，reply 34-68，reject 69-97） |
| 事件总线 publish / subscribeAll | `vendor/opencode/.../bus/index.ts`（publish 83-99，subscribeAll 112-120） |
| /event SSE 流 | `vendor/opencode/.../server/routes/event.ts:64-77` |
| 路由挂载 | `vendor/opencode/.../server/instance.ts:51-55` |
| ctx.ask 注入（agent+session ruleset 合并） | `vendor/opencode/.../session/prompt.ts:425-434, 492` |
| edit / bash 工具权限示例 | `vendor/opencode/.../tool/edit.ts:65,100`；`tool/bash.ts:267-288` |
| question 工具（AI 主动提问） | `vendor/opencode/.../tool/question.ts:12`；`tool/plan.ts:25,82` |
| **前端** | |
| 触发 + 状态 + 轮询兜底 + 回复 | `packages/client/desktop/src/lib/use-session-permission.ts` |
| Dock 挂载点（三选一替换） | `packages/client/desktop/src/pages/Session.tsx:161-191` |
| 前端 SSE 流（fetch + Basic auth） | `packages/client/desktop/src/lib/sse-client.ts:78-177` |
| SSE 全局广播（masterHandler + Set） | `packages/client/desktop/src/lib/sse-context.tsx:18-110` |
| **渠道（无头）端** | |
| Gateway 发 prompt（无 agent/无 permission） | `packages/channel/gateway/src/bridge.ts:206` |
| Gateway 自动批准/拒绝 | `packages/channel/gateway/src/bridge.ts:463-490` |
| Gateway 轮询兜底（5 分钟上限） | `packages/channel/gateway/src/bridge.ts:528-567` |
| 默认 agent build 的 permission 基线 | `vendor/opencode/.../agent/agent.ts:86-119, 297-309` |
| dispose finalizer 兜底失败 | `vendor/opencode/.../permission/index.ts:154-161` |
| PermissionDock（无状态） | `packages/client/desktop/src/components/chat/permission-dock.tsx` |
| QuestionDock（多问题向导） | `packages/client/desktop/src/components/chat/question-dock.tsx` |
| SSE 事件类型定义 | `packages/client/desktop/src/lib/sse-client.ts:21-25` |
| api-client 方法 | `packages/core/api-client/src/client.ts:205-233` |
| 类型定义 | `packages/core/api-client/src/types.ts:182-210` |

---

## 5. 设计要点总结与观察

1. **挂起机制统一用 Effect `Deferred`**：ask 创建并 await，把工具执行流冻结；reply/reject 端 succeed/fail 唤醒。`Effect.ensuring` 保证一定从 pending 表清理。Permission 与 Question 共用这套骨架。

2. **Permission 有规则评估层，Question 没有**：Permission 的 deny/allow/ask 三态 + `always` 写入内存规则集 + 级联放行；Question 每次都问，返回用户实际选择。

3. **reject 级联**：Permission reject 会拒掉同 session 所有 pending（`index.ts:222-231`），避免逐条拒绝的繁琐。

4. **SSE 单向广播 + HTTP 单向回复，两通道解耦**：所有事件经 wildcard PubSub 流入 `/event`；回复走独立 POST 路由。前端 `properties` 直接是 Request 对象。

5. **UI 形态是「占位替换」而非「浮层弹窗」**：Dock 顶替底部输入框，无遮罩、不阻断其余 UI。优点是不打断滚动浏览历史；潜在局限：

   - **单槽而非队列**（`use-session-permission.ts:17-18`）：同一时刻只显示一个 pending，若服务端短时间产生多个 `*.asked`，前端只保留最后一个槽位值（被覆盖的那条仍在服务端 pending 表里，靠 3 秒轮询兜底逐步补上，但 UI 无「还有 N 条待处理」的提示）。
   - **优先级写死 question > permission**：若同时存在两类 pending，权限会被问题挡在后面。
   - **轮询固定 3 秒**：SSE 正常时是冗余开销；SSE 断连时是唯一兜底，最坏延迟 3 秒。

   > 这些都是观察，不构成改动建议——当前形态对「人在桌面端逐个确认」的主路径是够用的。

---

## 附：与现有文档的关系

- 本文是纯调研，不产生 ADR。若后续要改 Dock 的 UI 形态（如改为队列 / 浮层 / 多条待办列表），再起 ADR。
- 相关既有记录：MEMORY.md `## OpenCode Upstream Type Alignment` 段已记录 Permission/Question API 的类型与端点；本文补全了「为什么是这样」的服务端挂起原理与前端渲染细节。
