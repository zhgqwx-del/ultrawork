# 033 — IM 渠道输出质量（思考过程泄漏 / 流式）与交互补全（question / permission）

> 状态：**📋 P0+P1 方案已定稿待实施；P2 单独立项**（2026-07-11 拍板：P0+P1 走一个分支；P2 因需改 `ChannelAdapter` 接口，单独 ADR）
> 日期：2026-07-11
> 输入：用户四张真机截图（微信 / 企微 / 飞书 / 钉钉），提出三个问题——① 思考过程被发到 IM 上了？② 能不能做流式，从而去掉「⏳ 收到，正在处理」？③ IM 会话里是不是不支持 question dock / permission dock？
> 关联：ADR-013（gateway sidecar）· ADR-014（钉钉 Stream SDK，确立 Bridge 形态）· ADR-044（IM 扫码接入三家，其 D5 已把 permission 自动放行列为 known issue）· ADR-005（桌面端 Permission/Question Dock）· discussions/012 §P1-1（IM 流式输出重构，规划过 `block-chunker.ts`，从未实施）
> 范围：`packages/channel/gateway/`（bridge + 四个 adapter）。**不含桌面端**——桌面端只经 HTTP :4097 与 gateway 通信，不引用其源码，本文所有改动对 renderer 零影响。

---

## 0. 一句话

三个问题里，**① 和 ③ 是 bug，② 是能力缺口**。而 ③ 的真相比"不支持"更糟：gateway 不是没接 question/permission，而是**替用户自动答了**——permission 无条件放行、question 无条件拒绝，后者意味着 **agent 一旦反问，在 IM 侧就等于任务直接失败**。

---

## 1. 现状核验（源码级，非推测）

### 1.1 问题①：思考过程泄漏 —— 两个独立缺陷叠加

**缺陷 A：reasoning 从 delta 通道漏出（根因在上游事件 schema）**

opencode 的 `message.part.delta` 事件**不携带 part 类型**，schema 只有 `{sessionID, messageID, partID, field, delta}`（`vendor/opencode/packages/opencode/src/session/message-v2.ts:486-495`）。而 processor 对 reasoning 和正文用的是**同一个 `field: "text"`**：

| 事件 | 位置 | field |
|---|---|---|
| `reasoning-delta` | `processor.ts:135-141` | `field: "text"` |
| `text-delta` | `processor.ts:331-337` | `field: "text"` |

gateway 的 `onPartDelta`（`bridge.ts:368-383`）只判断 `props.field === "content" \|\| props.field === "text"` 就往 `textParts` 累加 ⇒ **无法区分二者**。

值得注意这是个**半吊子过滤**：全量事件路径其实挡住了 reasoning（`onPartUpdated`，`bridge.ts:356`：`if (part.type !== "text") return`，而 `reasoning-start` 走 `updatePart` 且 `type: "reasoning"`，`processor.ts:126`）。所以 `reasoning-start` 被挡、它后续的每一条 delta 却照单全收。**只要 provider 流式吐 reasoning（qwen 等），必漏。**

> ⚠️ 调研中一个 subagent 粗看 `onPartUpdated` 后得出"reasoning 天然被丢"的**错误结论**。以截图 + 上述逐行核验为准：泄漏是真的，且在 delta 路径。

**缺陷 B：回复开头回显用户原话（独立的第二个 bug）**

opencode 把**用户自己**的 text part 也广播成 `message.part.updated`（`prompt.ts:1300` `for (const part of parts) yield* sessions.updatePart(part)`，`session/index.ts:483` 无条件广播、不分 user/assistant）。而 `onPartUpdated` 只看 `part.type`、**从不看这条 part 属于 user 还是 assistant**。

`textParts` 是 `Map`，保持插入顺序 ⇒ `flushAndReply` 的 `join("\n\n")`（`bridge.ts:272`）产出顺序恰是：**用户原话 → reasoning → 正式答案**，与四张截图逐字吻合。

顺带：opencode 还会注入若干 `synthetic: true` 的 user text part（plan 模式提示 `prompt.ts:260-280`、`"Summarize the task tool output above and continue with your task."` `prompt.ts:733-740`），**目前同样会被拼进 IM 回复**。

**工具调用不会泄漏**（两条路都堵死了：全量被类型过滤挡掉；增量侧 opencode 的 `case "tool-input-delta": return` 是空实现，`processor.ts:167`，gotchas §1 已记）。

### 1.2 问题②：「⏳ 收到，正在处理」的来源与不可去除性

硬编码在 `bridge.ts:150-153`，发在**任何网络调用之前**（CHANGELOG 记录过一次专门的前移，为的是让用户尽快看到反馈）。

它存在的**结构性原因**：出站是 `promptAsync`（`POST /session/:id/prompt_async`，204 无 body，不等结果，`api-client/src/client.ts:485`），结果全靠全局 SSE 攒到 `session.status === idle` 才 `flushAndReply` 一次性发出。**长回合期间 IM 侧除这条 ack 外零反馈。**

⇒ **这条 ack 不是可以随手删的装饰，它是"一次性回复"架构的补丁。** 只有当首个可见输出能在数秒内到达（流式或分段），它才失去存在意义。

### 1.3 问题③：question / permission —— 不是"不支持"，是"替用户自动答了"

```ts
// bridge.ts:394-407  —— 无条件放行，不看工具类型、不看用户、无白名单
private onPermissionAsked(perm) { client.replyPermission(perm.id, "once") }

// bridge.ts:410-422  —— 无条件拒绝
private onQuestionAsked(question) { client.rejectQuestion(question.id) }
```

两条后果：

1. **agent 一旦反问 ⇒ IM 侧任务直接失败。** vendor 侧 reject = `Deferred.fail("The user dismissed this question")`。IM 用户永远看不到提问，只会看到 agent 莫名其妙地放弃或走偏。
2. **任何能给机器人发消息的 IM 成员，都能让 agent 无确认地执行任意 edit/bash。** ADR-044 决策 5 已把这条记为 known issue（"渠道消息驱动的 agent 会自动放行 permission"）。

配套设施其实是齐的：SSE + 3s 轮询双保险（`ensurePolling`，`bridge.ts:461-499`），端点 `POST /permission/:id/reply`、`POST /question/:id/reject`；**`replyQuestion(id, answers)` 在 `api-client/src/client.ts:265` 早已就绪、但 gateway 从未调用**——做 IM question dock 的口子是现成的。

**question 的数据结构完全够渲染成 IM 交互**（`vendor/opencode/packages/opencode/src/question/index.ts`）：

```
Request { id, sessionID, questions: Info[] }
Info    { question, header, options: [{label, description}], multiple?, custom? }
Reply   { answers: string[][] }   // 每个 answer 是选中的 label 数组
```

⇒ 编号列表（回 `1` / `2`）即可覆盖；`custom: true` 时允许自由文本。**不依赖任何富 UI，四家通吃。**

---

## 2. 业界调研结论

### 2.1 thinking：一线产品无一例外不发原始 CoT

| 产品 | 做法 |
|---|---|
| **Claude Tag / Claude in Slack** | 只有一行 "is thinking…" + **任务 checklist**（就地编辑）；全量工具记录走 **"Open session" 外链** |
| **opencode 官方 Slack bot** | `parts.filter(p => p.type === "text")`，reasoning part 从未被消费（`vendor/opencode/packages/slack/src/index.ts:127`） |
| **opencode GitHub bot** | `extractResponseText()` 只取最后一个 text part，tools/reasoning 一律不进评论 |
| **Cursor / Devin / Copilot / Codex** | 均不发；Cursor 的 Agent Summary 还可关 |
| **OpenClaw** | 三档 `/reasoning off\|on\|stream`，**默认 off**；`stream` 模式下 reasoning 进临时 preview、**交付后删除** |
| **Hermes Agent** | IM 侧 `show_reasoning: False` **默认关**（CLI 默认开——"终端给你看，IM 不给你看"）；开启则 prepend 且 **>15 行截断** |

**共识：要发就发"在做什么"（工具名 / 任务卡），不发"在想什么"。** Slack 甚至把这个做成了平台能力（Thinking Steps：`task_update` / `plan_update`，**默认折叠**，展示任务标签而非原始 CoT）。

### 2.2 流式：四家能力天差地别（两处纠正了我们的既有假设）

| 渠道 | 真流式 | 载体 | 代价 / 硬约束 |
|---|---|---|---|
| **飞书** | ✅ | CardKit 卡片实体：`POST /open-apis/cardkit/v1/cards` → `PUT .../elements/:eid/content` → `PATCH .../settings` 关流 | **普通自建应用即可**（不需 Aily）。免费。单卡 **10 次/秒**；**JSON 2.0 强制 + 客户端 7.20+**；**流式 10 分钟自动关闭**；`sequence` 须严格递增 |
| **企微** | ✅ | 智能机器人 `msgtype: "stream"`（`replyStream(frame, streamId, content, finish)`） | ⚠️ **纠正既有假设**：企微**有**官方流式，且 **`wecom-adapter` 用的正是 `@wecom/aibot-node-sdk` 长连接——已经站在正确的通道上**，只是没调这个 API。免费。30 条/分、1000 条/时 |
| **钉钉** | ✅ | AI 卡片 `PUT /v1.0/card/streaming`（`Card.Streaming.Write`） | ⚠️ **纠正既有假设**：**不是 AI 助理专属**，企业内部自建机器人即可。但**唯一要花钱的**：每帧 = 一次付费 API 调用（第三方实测 3~10× 普通卡片）；**单帧 content ≤ 1KB**；标准版月调用量仅 1 万次 ⇒ 流式基本必须升专业版。**群 webhook 机器人不行**（发出即不可改） |
| **微信 iLink** | ❌ | 协议无 edit 端点 | **腾讯官方自己的微信 ClawBot 也做不到打字机**：其 npm 包 capabilities 明写 `blockStreaming: true`，策略是"攒够 200 字符或空闲 3 秒发一条新消息"。⇒ **分段多条不是我们的凑合，它就是腾讯官方的答案** |

**三家的流式语义都是"全量覆盖"而非 delta append**（飞书要求新文本以旧文本为前缀；钉钉 markdown 必须 `isFull=true`；企微是全量替换）⇒ 公共层维护累积 buffer，adapter 只负责"把全量文本发出去"。

**节流基线**（源码实测值，非社区外推）：OpenClaw = Telegram/Slack 1000ms、Discord 1200ms、**飞书 160ms**、QQ 500ms；Hermes = **0.8s 或 24 字符双触发** + flood 时 ×2 退避（≤10s）；Slack 官方建议 `chat.update` 每 3 秒一次。

**typing 指示**：只有微信有 API，但**只持续 15 秒且不可续期**（`45081`）⇒ 掩盖不了跑几分钟的 agent。飞书/钉钉/企微都无 typing API（等价物分别是：占位流式卡片 / AI 卡片内置状态机 / stream 首帧）。

### 2.3 确认交互：两大流派

- **闭源一线 = 前置授权 + 沙箱 + 出网白名单，频道内零逐次审批。** Claude Tag 的 Access bundle + Agent Proxy（不在白名单的 host 直接不可达，而不是弹窗问你）；Cursor 的隔离 VM；Copilot/Codex 把 review 外移到 PR。唯一的人在环是 **Devin 的计划级审批**（`Agency` 开关）+ 澄清反问（**自然语言回复**，非按钮）。
- **开源 = 真按钮，形态高度统一。** OpenClaw / Hermes / Droid bot 三家不约而同是 **`Allow Once` / `Allow Always` / `Deny` 三按钮 + 文本兜底关键字**（`/approve <id> allow-once`、`!approve`/`!deny`），审批**有过期时间**（OpenClaw 30 分钟），可定向到 approver 的 DM。Matrix 甚至用表情当按钮。
- **反问最成熟的形态是 Hermes 的 clarify**：数字按钮 `1/2/3` + `✏️ Other (type answer)`，无富 UI 时回落成**编号列表**（回数字或自由文本）。**且审批/反问待决期间，用户消息优先路由到 handler**——否则死锁。这一条对我们至关重要（见 §4.1）。

**一个必须提前知道的协议坑**：飞书流式模式下用户点交互组件，**要先关闭流式模式**才能处理回调；Slack 的 `appendStream` 同样不允许带 blocks（按钮只能在 `stopStream` 时挂）。⇒ **权限/提问卡片必须是独立消息，不能塞进正在流式的那张卡。**

---

## 3. 方案：分三期

### P0 —— 输出净化（小、低风险、四家通吃、不碰任何 adapter 接口）

全部改动在 `bridge.ts` 一个文件：

1. 订阅 `message.updated` 事件（`message-v2.ts:457`，payload 带 `info`，其中 `role: "user" | "assistant"`），记录本轮 assistant 的 messageID。
2. 维护 `partID → type` 白名单：由 `message.part.updated` 的全量事件填充（`text-start` 发 `type: "text"`、`reasoning-start` 发 `type: "reasoning"`）。
3. `onPartUpdated` / `onPartDelta` 双双改为：**只接受「属于 assistant message 且 partID 在 text 白名单里」的内容**。这一改同时干掉缺陷 A（reasoning）、缺陷 B（user 回显）和 synthetic part。
4. **兜底**：若过滤后 `text` 为空（模型只吐了 reasoning 没有正文），不能静默——发一条降级提示，否则比现在更糟（见 §4.2）。

### P1 —— question 走通 + 分段输出（中）

1. **question**：把 `Question.Request` 渲染成编号列表发到 IM（四家通吃，纯文本），用户回 `1`/`2` 或自由文本 → 调 `replyQuestion(id, answers)`（`client.ts:265`，现成未用）。**这是收益最大且零安全风险的一环**——现状是"反问 = 失败"。
   - **前提改造**：引入"挂起等待用户应答"的会话态（见 §4.1，这是 P1 的真正难点）。
2. **block-chunker**（discussions/012 §P1-1 规划过、从未实施）：段落级分块多条发送，不依赖任何编辑能力。四家通吃，微信也立刻有渐进感。
   - **必须带频控预算**（见 §4.3）。
3. **ack 去留**：有首块输出后即可省掉 `⏳`（discussions/012 已有此设想）。微信侧建议保留（那儿除了 ack 什么都没有）。

### P2 —— 真流式卡片 + permission 按钮（大，**单独立项 + 单独 ADR**）

需要破掉当前的接口天花板：`ChannelAdapter` 只有 `sendMessage(chatId, content)`、**不返回消息句柄**，`IncomingMessage.reply` 同样不返回（`gateway/src/types.ts:1-11`）⇒ 四家全都无法编辑已发消息。要引入 `capabilities` 声明 + `StreamingSession`（`start / push / done / fail`）抽象，节流放公共层。

**按性价比排序**：企微（几乎白送，SDK 现成）→ 飞书（免费，CardKit）→ 钉钉（**按帧计费，建议做成开关，默认降级到 P1 的分段**）。permission 三按钮同期做。

---

## 4. 风险与副作用（本次核验新发现）

### 4.1 ⚠️ P1 的硬冲突：question 待答 vs bridge 的会话生命周期（**已实证**）

**探针 1 结论（2026-07-11，真 opencode-server 二进制 + 真 provider qwen3.7-max）**：

```
[ 1.9s] session.status = busy
[14.7s] part.tool question status=pending
[16.1s] question.asked  → 工具进入 running，阻塞
[16.1s → 211.9s]  ← 195 秒内：零 status 事件、零 part 更新
【结论】待答期间 idle：未出现（runner 全程 busy）
```

源码侧一致：`idle` 只在 Runner 的 `onIdle`（整个 prompt run 结束、队列排空，`prompt.ts:124`）与 error 路径（`processor.ts:429`）设置；而 `Question.ask` 阻塞在**工具执行内部**（`tool/question.ts:12`），runner 仍 busy。

⇒ **好消息**：`onSessionStatus → flushAndReply` 这条路**不会**被误触发。
⇒ **但冲突没有消失，只是换了来源**：bridge 的兜底定时器 `IDLE_TIMEOUT_MS = 180_000`（`bridge.ts:248`）由 **part 更新**重置，而探针实测 question 之后 **195 秒零 part 更新** ⇒ 定时器会在 question 后约 180 秒准时开火 → `flushAndReply` → **`activeContexts.delete(sessionId)`**（`bridge.ts:284`）。轮询也会因 `POLL_MAX_LIFETIME_MS = 300_000` 自杀。

**⇒ 用户若 3 分钟内不回答，ctx 被销毁，回答再也接不回去。**

**第二个冲突（同样实证）**：`processMessage` 对每条新消息都走 `promptAsync`（`bridge.ts:221`），而 question 待答期间 session 是 busy 的，opencode 的 `assertNotBusy`（`prompt.ts:136`）会抛 `BusyError` ⇒ **用户的"回答"会被当成新 prompt 打过去然后失败**。这正是 Hermes 那条设计约束的实证：**待决期间用户消息必须优先路由到 handler，否则死锁**。

**P1 因此必须做三件事**（不是"把提问渲染出来"那么简单）：
1. 引入 `awaitingQuestion` 挂起态，**暂停** idle 兜底定时器（否则 180s 后 ctx 被删）；
2. 挂起期间**不延长/不停止**轮询（`POLL_MAX_LIFETIME_MS` 需相应豁免）；
3. 用户的下一条消息**优先路由到 `replyQuestion`**，不走 `promptAsync`。

### 4.2 P0 的副作用：过滤后可能变成完全静默

`flushAndReply` 的 `if (text)`（`bridge.ts:273`）意味着空文本 = 一条都不发。滤掉 reasoning 后，若某轮模型只吐 reasoning 没有正文（罕见但存在），IM 侧会**完全静默** —— 比现在的脏输出更糟。**P0 必须同时加降级提示。**

### 4.3 P1 分段多条会撞频控

| 渠道 | 频控 |
|---|---|
| 企微 | **30 条/分、1000 条/时**（gotchas §4 已记） |
| 钉钉群机器人 | 20 条/分 |
| 微信 iLink | 无 5 条硬额度（个人号通道），但发送频率上限**待验** |

⇒ 分段策略必须带频控预算（chunk 下限 + 空闲合并），否则问题从"一条脏消息"变成"消息被限流丢掉"。腾讯官方 ClawBot 的 `minChars: 200 / idleMs: 3000` 是一个可直接抄的基线。

### 4.4 现存 bug（非本次引入，顺手记录）

ctx 被 `flushAndReply` 删除之后才到达的 permission，两个 handler 都会 `return` ⇒ **无人应答，挂起到 opencode 自己超时**，IM 侧表现为"机器人不理人了"。轮询同样已因 `POLL_MAX_LIFETIME_MS = 300_000` 停掉。

### 4.5 对桌面端的影响：无

桌面端只经 HTTP :4097 与 gateway 通信（`packages/client/desktop/src/lib/sidecar-ports.ts`），**不引用 gateway 任何源码**。P0+P1 全部改动局限在 `packages/channel/gateway/src/`，renderer 的 question/permission dock、SSE、渲染零改动。

**唯一操作性影响**：改完必须 `bun run build:gateway` 重编译 sidecar，否则跑的是旧二进制（gotchas §4 已记）。

---

## 5. 探针结果

| # | 待验 | 结论 |
|---|------|------|
| 1 | question 阻塞期间 `session.status` = idle 还是 busy | ✅ **已实证：全程 busy，195 秒零 idle、零 part 更新**。冲突来源不是 idle 事件而是 **180s 兜底定时器** + `BusyError`。详见 §4.1 |
| 2 | 四渠道分段多条的真实频控 | ✅ **已核实（未真撞频控——那会往真实 IM 刷屏且不可逆）**：四家 adapter 发送路径**零节流**（`adapters/` 里所有 sleep/setTimeout 都是轮询/超时/退避）；已知天花板：企微 **30 条/分、1000 条/时**（gotchas §4 实拍契约，最紧的一道杠）、钉钉群机器人 20 条/分、飞书消息未见硬限、微信 iLink 未知。⇒ 分段必须带**三重预算**：块下限 200 字符 + 空闲合并 3 秒 + **每轮消息数封顶** |
| 3 | `@wecom/aibot-node-sdk` 是否真有 `replyStream` | ⏸ P2 前验 |
| 4 | 飞书 CardKit 权限（`cardkit:card:write`）是否在现有应用授权范围内 | ⏸ P2 前验 |
| 5 | 钉钉标准版 1 万次/月调用量能否承受流式 | ⏸ P2 决策依据 |

---

## 6. 待拍板

1. **P2 的钉钉流式要不要做？**（唯一按帧计费的渠道）建议做成配置开关、默认关、降级到 P1 分段。
2. **permission 默认策略**：保持"IM 全放行"（方便但危险），还是改"ask + 只读工具白名单（read/grep/glob/list）自动放行"？倾向后者，但这是**行为变更**，会影响现有 IM 用户体验。
3. ~~本轮做到哪~~ → **已定：P0+P1 一个分支，P2 单独立项 + 单独 ADR**（2026-07-11）。
</content>
