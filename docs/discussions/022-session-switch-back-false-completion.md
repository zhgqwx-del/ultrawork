# 022 — 会话切走再切回：正在运行的回合被误渲染成"已完成"

> 状态：调研记录（根因，多角度交叉确认）+ 讨论中（方案，未开工）
> 日期：2026-06-24
> 关联：conventions §5（回合分组渲染）· gotchas §1（出错回合形状 / `tool-calls` 步间假完成 / 拖尾去抖）· ADR-029（执行流程回合分组）· ADR-034（LLM 流式 idle 看门狗）· ADR-030/031（connector 能力分流 / delegate）

---

## 0. 现象（真机复现）

1. 发一个长任务（"收集信息后预测阿里巴巴何时裁员"），AI 开始执行，回合内转圈 / doing。
2. **切到别的会话，再切回来**：执行流程显示"打勾了"（折叠 + 绿勾 + 统计页脚，像是完成了），但其实后端仍在跑——用户无法判断是真完成、失败、还是缺陷。
3. 又过一会儿，回合真正完成。

步骤 2 的"既像完成又像在跑"是真实存在的 **UI/UX 状态不一致**，属于"假完成"家族（conventions §5 / gotchas §1 记录过同族 bug），但这是一条**之前所有修复都没覆盖的新触发路径：会话切走/切回**。

---

## 1. 根因链（逐行可核验）

### 1.1 判流式的兜底门控在 `sessionActive` 上

`message-list.ts` 的纯函数：

```ts
// message-list.ts:34
export function isTurnTerminal(lastInfo) {
  return !!lastInfo?.error || (!!lastInfo?.finish && lastInfo.finish !== "tool-calls")
}
// message-list.ts:42-56
export function isTurnStreaming(opts) {
  ...
  const containsStreaming = turnMessages.some((m) => m.info.id === streamingMessageId)
  const lastInfo = turnMessages[turnMessages.length - 1]?.info
  return containsStreaming || (isLastGroup && !isTurnTerminal(lastInfo) && sessionActive)
  //                                                                       ^^^^^^^^^^^^^ 兜底门控
}
```

"步间间隙靠'末条非终态'推断仍在流式"这条兜底，**被门控在 `sessionActive` 上**。这个门控是 2026-06-13 为修**相反方向**的 bug 加的——防止历史 / 出错 / 被中断的回合（末条非终态）在重开会话时**永久转圈**。它的设计哲学正确：**不信任消息形状本身**，必须有一个独立的"本会话现在真有请求在飞"信号才允许推断流式。

### 1.2 `sessionActive` 是本地组件 state，切换会话即清零

`Session.tsx:100`：

```ts
const isAgentActive = sending || streamingMessageId !== null
```

`sending` / `streamingMessageId` 都是 `useSessionMessages` 的**本地 React state**。切换会话 = react-router 卸载 / 重挂 `SessionPage`，hook 的 `[sessionId]` reset effect（`use-session-messages.ts:102-153`）清零它们：

```ts
setStreamingMessageId(null)                       // :105
const isSendingFromNav = !!opts?.initialSending   // :116
setSending(isSendingFromNav)                      // :117
```

`initialSending` **只在 Home→Session 导航时为 true**（`Session.tsx:91` 读 `navState.sending`）。从**侧栏切回**一个正在跑的会话时它是 `false`。于是切回瞬间 `sending=false`、`streamingMessageId=null` → `sessionActive=false`。

### 1.3 历史拉回 + 思考间隙 = 持续假完成

切回后 `fetchHistory` 拉回的历史里，正在跑的回合末条 assistant message 多半停在 `finish:"tool-calls"`（步已封板）→ `isTurnTerminal=false`。代入 `isTurnStreaming`：`containsStreaming=false` + `sessionActive=false` → **返回 false → 回合渲染成"已完成"**（折叠执行流程 + 绿勾 + 统计页脚）。

而后端还在跑。**模型思考间隙（首 token 慢、可达数十秒，gotchas §1 反复强调）里没有任何 SSE message 事件**，所以这个假完成会**稳定持续数十秒**，直到下一个 step 的 `message.part.delta` 到达 → `setStreamingMessageId()` → `sessionActive` 变回 true → 翻成转圈 → 最终 `session.status:idle`（opencode）/ 终态 finish（ACP）收尾。这就是"打勾→过会儿又转圈→再过会儿真完成"。

### 1.4 为什么没有兜底真相源能把它救回来

切回时本应从某个"跨会话切换仍存活的真相源"重新水合 `sending`，但**这个源不存在 / 不可靠 / 没人读**：

- `activeSessionIds`（侧栏忙碌点的来源，`use-sessions.ts:45`）**只由 `markSessionActive/Idle` 显式维护**（`:53/:62`），而这两个只在**当前挂载的会话**的 hook 里调用。
- 全局那个 `useSSESubscribe`（`use-sessions.ts:204-237`）**只处理 `session.updated`/`session.deleted`，不处理 `session.status` 或 message 事件** → `activeSessionIds` 从不反映"某后台会话仍在跑"。
- 更糟：切走时的卸载清理（`use-session-messages.ts:511-517`）`if (sendingRef.current) markSessionIdle(sessionId)` —— **一个仍在后端跑的会话，被切走的瞬间就被标记为 idle**（侧栏忙碌点也跟着说谎）。
- 切回时 reset effect 既没读 `activeSessionIds`、也没重新查 session 忙碌态来给 `sending` 播种。

**唯一能让 UI 自愈的信号，就是等下一个 SSE delta 自己到**——间隙越长，假完成越久。

### 一句话根因

> 「回合是否 live」当前完全由 `useSessionMessages` 的**本地组件 state**（`sending`/`streamingMessageId`）表达；这套 state 只在**发起 prompt 的那次挂载**里被正确维护（gotchas §1 的"步间保持 sending=true"、"8s timer 取消"、"拖尾去抖"全是在那个挂载内修的）。会话切走/切回会卸载重挂、清零这套 state，而**没有从后端真相重新水合**。`isTurnStreaming` 的兜底又门控在它上面，于是切回后正在跑的回合在思考间隙被判成"已完成"。

---

## 2. 多角度交叉确认：根因比"转圈"更广

`sessionActive` / `isAgentActive` **不止驱动回合转圈**，切回清零会同时打坏多个消费者——这从侧面坐实根因不是"渲染分支写错"，而是"live 真相源被清零且不水合"这件根上的事：

| 消费者 | 位置 | 切回后（isAgentActive=false）的后果 |
|--------|------|--------------------------------------|
| 回合流式渲染 | `message-list.ts:55` | 思考间隙误判"已完成"（本文主诉） |
| **底部停止按钮** | `Session.tsx:197`（`sending && !stopped`）+ `ChatInput loading/disabled`（`:227-235`，仅看 `sending`） | **正在跑的回合，用户失去停止入口**，输入框还变回普通发送态（可误发新消息打断） |
| **权限/问答轮询** | `use-session-permission.ts:71`（`useEffect` 门控 `isAgentActive` + `pollable`） | **轮询不启动**。权限/提问只能靠 SSE；SSE 漏一帧（conventions §3 轮询正是为此兜底）→ 用户永远看不到授权 Dock → 回合卡在等授权且无任何 UI。**仅 opencode**：`pollable` 还要求 `capabilities.questions`，而 ACP `questions:false` → ACP 本就从不轮询（`isAgentActive` 修复对 ACP 权限轮询是 no-op；ACP 切回后挂起权限的恢复另走 per-session SSE 重订阅，不在本次范围）。 |
| 产物 mtime 扫描 | `artifacts-panel.tsx:340-354`（`if (active) return` 仅空闲扫）+ `:359 sessionTurnWindows(messages, active)` | active=false 会在**回合仍在跑时**就扫（churn），且最后一回合时间窗按"已完成"收口（`active=false` 不再开放到 `Infinity`）→ 在飞产物可能漏归属 |

**结论**：把 `sessionActive` 修对，是同时修好上述全部的**单点**；任何"只补回合渲染分支"的局部修法都会留下停止按钮 / 权限轮询的尾巴。

---

## 3. 关键架构不对称（决定方案完备性）

排查中发现一处对照鲜明的事实，直接决定了方案怎么选才完备：

### 3.1 delegate 的运行状态：服务端权威 + 订阅即快照（已经做对了）

- `GET /orchestration/delegates`（`orchestration-client.ts:71`）可**随时查**当前所有 delegate。
- `subscribeDelegateEvents`（`:77-89`）**首帧永远是 `delegate.snapshot`**（注释明写 "no initial fetch needed"），`DelegateDock`（`delegate-dock.tsx:34-67`）订阅即拿到全量快照、跨会话切换重挂后**立即重建状态**。
- orchestration run 同理：`subscribeRunEvents` 首帧即 `run.updated` 全量快照（`:51-67`）。

即 **delegate / run 的 live 真相在服务端权威维护，重挂可无损恢复**。

### 3.2 单会话回合的忙碌态：没有等价物

- opencode：有 `session.status` 事件（`connector/events.ts:20`，`busy`/`idle`/`retry`），backend 能力位 `sessionStatus:true`（`backends/opencode.ts:62`）。但这是**流式转换通知，没有"查当前状态"的 REST**——`Session` 对象本身**无 busy/idle 字段**（`api-client/types.ts:176-188`）。重挂后错过的转换补不回来。
- ACP：`sessionStatus:false`（`backends/acp.ts:40`），**完全没有忙碌态事件**，靠前端在终态 finish 时补 `markSessionIdle`（gotchas §8）。sidecar 也无"该会话此刻是否在跑 prompt"的查询端点。

> **不对称**：delegate/run 有服务端可快照查询的真相源；**单会话回合的忙碌态没有**（opencode 只流转换、ACP 啥也没有）。这正是切回水合不出来的根。修复的样板，就是**让单会话忙碌态享受 delegate 已有的"服务端权威 + 订阅即快照"待遇**。

---

## 4. 方案与完备性评估（含单 agent vs Team）

目标：给"切回"补一个**跨会话切换仍存活、可在挂载时读到**的 live 真相源来水合 `sending`/`sessionActive`，从而一并修好回合渲染、停止按钮、权限轮询、产物扫描。

### 方案 A：切回时查后端"当前忙碌态"
切回（初始 `fetchHistory`）时顺带查会话当前是否在跑，忙则 `setSending(true)`。
- **致命缺陷**：§3.2 表明**这个查询端点目前不存在**。opencode `Session` 无 busy 字段、ACP 无任何接口。**A 必须先补后端**才能成立，不能单独落地。

### 方案 B：把 live 真相提升为 app 级、跨切换存活（推荐骨架）
让 `activeSessionIds`（或新的 busy registry）成为**真正的全局事实**：
1. 在全局 `useSSESubscribe`（`use-sessions.ts`）里**新增监听 `session.status`**（busy→add / idle→remove）——opencode 的忙碌态从此 app 级维护，不随 Session 页卸载而丢。
2. **删掉 / 改写**切走即 `markSessionIdle` 的卸载清理（`use-session-messages.ts:511`）——卸载不再篡改全局忙碌态，由全局 idle 信号收口。
3. 切回时 reset effect **从 `activeSessionIds` 播种 `sending`**（`setSending(activeSessionIds.has(sessionId))`）。
- **优点**：一处真相，同时修好侧栏点、停止按钮、权限轮询、产物扫描；opencode 路径完全自洽（session.status 本就是权威流）。
- **完备性缺口**：**ACP 不发 session.status** → 全局监听对 ACP 收不到任何 busy 信号 → ACP 会话切回仍水合不出来。**B 只对 opencode 完备**。

### 方案 C：历史末条形状 + 时间窗启发式
切回时若末条非终态且 `time` 较新就当 live。
- 回到"信任消息形状"的老问题（正是 §1.1 那个门控要避免的），长间隙 / 卡死会误判，与 ADR-034 的 idle 看门狗职责重叠。**不可单用**，至多作为无后端信号时的降级兜底。

### 方案 D：补 ACP 侧的服务端忙碌态（补全 B 的 ACP 缺口）
照搬 §3.1 delegate 的样板：sidecar 维护每会话"是否有 prompt 在飞"，提供 `GET /acp/session/:id/status`（或在现有 `GET /acp/sessions` 列表加 `running` 字段）+ 订阅即快照。前端切回时查它播种 `sending`。
- **优点**：让 ACP 也有权威可查的真相，B+D 合起来对两种后端都完备。
- **代价**：动 sidecar + 新端点；需与 ADR-034 的 idle 看门狗对齐（看门狗 abort 后该会话应立即标记非 running）。

### 4.1 单 agent 模式完备性

| 后端 | B 单独 | B + D |
|------|--------|-------|
| opencode 会话 | ✅ 完备（session.status 权威） | ✅ |
| ACP 会话 | ❌ 收不到 busy，切回仍假完成 | ✅ 补齐 |

### 4.2 Team / 编排模式完备性

事实（已核验）：Team 会话**完全复用** `SessionPage` + `useSessionMessages` + `sessionActive` 这套（`Session.tsx` 经 `teamEntry` 仅区分 UI，状态机同源）——所以**Leader 会话有与单 agent 一模一样的切回假完成**，无 Team 特有保护。但有两点 Team 特性影响方案：

1. **Leader 的后端类型决定走 B 还是 D**：opencode leader → B 覆盖；ACP leader（`isACPAgentId(leaderAgentId)`）→ 需要 D。即 Team 完备性**等价于"其 Leader 后端的单 agent 完备性"**，不引入新维度。
2. **delegate 子任务已有现成的全局真相源**（§3.1）：一个 Leader 回合"忙不忙"其实还可被 delegate 状态**佐证**——只要该会话名下有 `status==="running"` 的 delegate（`DelegateDock` 跨切换可重建），它必然在跑。这给了 Team 模式一条**额外的、已存在的**可靠信号：
   - 可作为 B/D 的**交叉校验**（有 running delegate ⇒ 强制 `sessionActive=true`），尤其对 ACP leader 能部分补上 §3.2 的缺口；
   - 注意边界：Leader 在"派完 delegate、等结果"与"delegate 全done、Leader 正收尾"之间仍可能无 running delegate 却在跑 LLM，**delegate 信号是充分非必要**，不能单独当 live 判据。
3. **delegate 子会话渲染不受影响**：`delegate-row.tsx:124` 给 `LazyMessageList` 写死 `sessionActive={false}`（懒加载历史永不 live，conventions §5），切回不会让子卡片误转圈——Team 模式**只有 Leader 回合这一处**需要修，面收敛。

**Team 结论**：方案对 Team 与单 agent **同构**，不需要 Team 专属机制；Leader 后端是 opencode 用 B、是 ACP 用 B+D；delegate 全局状态是可选的、已存在的强化信号（充分非必要）。

---

## 5. 倾向性建议（待拍板，未开工）

- **以 B 为骨架**：把 `session.status` 接进全局 SSE 监听、让忙碌态成为 app 级事实、切回从中播种 `sending`、移除"切走即 markIdle"的篡改。这一步把 opencode（含 opencode leader 的 Team）全部修好，且**顺带修好停止按钮、权限轮询、侧栏点、产物扫描**——投入产出比最高。
- **再补 D 闭合 ACP**：照 delegate 样板给 sidecar 加"会话 running"快照查询，与 ADR-034 看门狗对齐。
- **C 仅作降级兜底**，不单独依赖。
- **可选**：Team 模式用 delegate running 作交叉校验，作为 ACP leader 在 D 落地前的部分缓解。
- 实施前建议**先按截图逐元素核对**（页脚 / 折叠态 / spinner 各对应哪个渲染分支），把"绿勾与转圈是快速翻转还是同帧并存"确认到像素级——本文机制是从代码时序推出的最可能解释，根因不受其影响，但能帮验证修复后的目标态。

---

## 6. 元素 → 渲染分支映射（代码级 + 真机像素确认）

两个驱动量：`streaming`（`assistant-turn.tsx:217` = `useStableStreaming(isStreaming)`，下降沿去抖 600ms；`isStreaming` 即 `message-list.ts:55` 门控在 `sessionActive` 上的值）；`sending` / `sessionActive=sending||streamingMessageId`（切回被清零）。

| 可见元素 | 文件:行 | 控制条件 |
|---|---|---|
| 执行流程头部图标（勾/转圈/停止/错） | `execution-flow.tsx:266-271,318` | `streaming`（去抖） |
| 流程展开/折叠 | `execution-flow.tsx:300-307` | `open` 初值=`isStreaming`，仅当其**变化**时改 |
| **单工具行转圈** | `execution-flow.tsx:91-102`（`ToolStatusIcon`） | **只看 `state.status==="running"`，与回合 live 无关**（无条件 `animate-spin`） |
| 统计页脚 | `assistant-turn.tsx:233` | `!streaming && (totalTokens>0 \|\| completedAt!=null)` |
| typing 三点 | `assistant-turn.tsx:298` | `streaming && !hasAnswerText` |
| 底部 working+停止条 | `Session.tsx:197` | **只看 `sending`** |
| 输入框 停止/发送态 | `Session.tsx:227,235` | **只看 `sending`** |

### 真机像素确认（截图 14.26.17 vs 14.27.55，opencode 会话 qwen3.6-plus）

**14.26.17（切回后的假完成现场）**：头部**绿勾**（`CheckCircle2`，streaming=false）+ 头部仅"1步"无时长无 tok + 深度思考行 685ms(已完成) + 工具行 "Search Alibaba layoff news" **橙色转圈**（`ToolStatusIcon` status:running 无条件 spin）+ 统计页脚 "14:23:36 · 输入:0 · 输出:0"（completedAt 回落 created、tokens 全 0）+ 底部**无停止键**（sending=false）。→ **预测的"绿勾+转圈同框"矛盾像素命中**。

**14.27.55（同一回合真完成）**：头部绿勾 "**2步 · 3分15 · 37.9k tok**" + 同一工具行变 "**✓ 181.2s**"（completed）+ 答案 step（裁员分析表格）出现。

**最强证据**：该工具执行 **181.2s**。单个长工具运行期间 opencode **不发 message delta** → 切回后 `sessionActive=false` 的假完成**持续 ~3 分钟**，坐实"分钟级假完成"而非毫秒抖动。

### 由此校准的两点

1. 本 repro 是 **opencode 会话** → **方案 B 单独即可修好此案例**；D 仅为 ACP-agent 会话补完备。
2. "工具行转圈 vs 绿勾头部"矛盾 **B 可消除**（sessionActive 全程为真 → 头部也转圈、与工具行一致、停止键恢复）。**唯一残留**：真·终态回合里工具被留在 `running`（出错于工具执行中途、后端没补终态工具状态）→ 该工具行永久转圈，独立 part 级小修（回合非 live 时把 `running` 钳为中性，或后端补终态），**不属 B 范围**。

---

## 7. 方案 B + ② 实现记录（opencode 路径，✅ 已实现）

实现时把草案的"切回一次性 seed `sending`"**升级为更稳健的"派生 `sessionActive`"**：全局 handler 永不卸载、无挂载竞态，且自动级联所有 `isAgentActive` 消费者。**实改 3 处（B）+ 1 处（②）**：

**B-① 全局 SSE 监听维护忙碌真相**（`use-sessions.ts`，与 `session.updated`/`session.deleted` 并列；deps 加 `markSessionActive/markSessionIdle`）：
```ts
else if (event.type === "session.status") {
  const sid = event.properties?.sessionID
  const type = event.properties?.status?.type
  if (sid) { if (type === "idle") markSessionIdle(sid); else markSessionActive(sid) }
}
```
> 此后 `activeSessionIds` 由**永不卸载的 app 级 handler** 据 `session.status` 维护（opencode 在全局流发，已核 `subscribeGlobal` 广播全部原始事件）——后台会话仍在跑也不丢。

**B-② 派生 `sessionActive`**（`Session.tsx`）：
```ts
const { sessions, activeSessionIds } = useSessionsContext()
const sessionBusy = !!id && activeSessionIds.has(id)
const isAgentActive = sending || streamingMessageId !== null || sessionBusy
```
切回后 `sending/streamingMessageId` 虽被重挂清零，但 `sessionBusy` 仍真 → `isAgentActive` 真 → 不再假完成。**无 seed、无竞态**；turn 结束时全局 `session.status:idle` 清 `sessionBusy`，挂载会话亦自清，不会永久转圈。

**B-③ 切走不再篡改忙碌真相 + 停止/输入接 `isAgentActive`**：
- 卸载清理（`use-session-messages.ts`）gate 成 `!capabilities.sessionStatus`（opencode 由全局 idle 收口，切走不再 markIdle；ACP 暂留启发式——**D 落地后改 `!capabilities.globalEvents`**，见下）。
- `Session.tsx`：底部 `ExecutionStatus`（`:197`）与 `ChatInput` 的 `disabled/loading`（`:235`）由 `sending` 改为 `isAgentActive` → 切回的运行回合恢复停止键、输入锁。

**级联收益（一处 `isAgentActive` 修复）**：回合 `isTurnStreaming` 兜底恢复（不再假完成）→ 头部转圈与工具行一致 → 统计页脚不早现 → 底部停止条/输入停止态恢复 → 权限轮询恢复（`use-session-permission.ts:71`）→ 产物扫描门控恢复（`artifacts-panel.tsx:340`，均经 `isAgentActive`）。

**② part 级 `running` 残留钳制**（`execution-flow.tsx` `ToolStatusIcon`）：新增 `live` 参数，`!live && status==="running"` 时渲染中性 `Circle` 而非无限 `Loader2`——治真·终态回合里被留在 `running` 的工具（B 范围外）。`ToolRow` 传 `live={isStreaming}`。

**验证**：desktop typecheck 通过；`use-session-messages-sending.test.ts` 扩 2 条切走用例（opencode 不 markIdle / ACP markIdle）共 7/7；`assistant-turn-*` 16/16。

**残留**：① 冷启动（无 session.status 快照可回放）时正跑的 turn 仍假完成——§3.2 的更深缺口，opencode 无状态查询端点；② ACP 会话（→ 方案 D）。

---

## 8. 方案 D 实现记录（ACP 路径，✅ 已实现）

ripple 已核定：opencode `globalEvents/sessionStatus=true`；ACP 两者 false 且**无全局流**（仅 per-session `/acp/session/:id/events`）。`connector.subscribeGlobal` 自动 fan-out 所有 `globalEvents && subscribeGlobal` 的后端。故 D = **给 ACP 建一条全局流发 `session.status`**，前端复用 B-① handler 零改动。**关键：不翻 `capabilities.sessionStatus`**（保持 false），新全局 `session.status` 只喂 `activeSessionIds`，与 orchestrator `waitsForIdle`（`turn.ts:62`）解耦、零 ripple。

**Sidecar（`packages/agent/acp-client`）**：
- `types.ts`：`UwSSEEvent` 加 `{ type:"session.status", properties:{ sessionID, status:{type:"busy"|"idle"} } }`。
- `acp-manager.ts`：加 `globalSubscribers:Set` + `subscribeGlobal/unsubscribe`；新增 `dispatchGlobal(event)` 推全局订阅者。
- `acp-connection.ts` `prompt()`：`activePrompts.add` 后发 `session.status busy`；`finally`（`activePrompts.delete` 处）发 `session.status idle`——经 `onEvent`→manager→全局订阅者。与 ADR-034 idle 看门狗对齐（abort 落终态时一并 idle）。
- `acp-server.ts`：新增 `GET /acp/global/events` SSE 端点（镜像 per-session 流，订阅 `manager.subscribeGlobal`）。可选：`listSessions()` 加 `running` 字段（快照，顺带缓解冷启动缺口）。

**Connector（`backends/acp.ts`）**：`globalEvents:true`；实现 `subscribeGlobal(handler)`（懒开 `/acp/global/events` EventSource、广播、引用计数关闭，镜像 per-session pool）；**`sessionStatus` 保持 false**。

**前端**：仅一处——`use-session-messages.ts` 卸载清理 gate 由 `!capabilities.sessionStatus` 改为 `!capabilities.globalEvents`（D 后 ACP `globalEvents=true` → 切走不再清 ACP 标记、不抵消 D；两后端均 globalEvents=true → 该兜底实际不再触发，仅为无全局流的未来后端保留）。B-① handler 零改。

**实改清单**：`types.ts`（+`session.status`）·`acp-manager.ts`（`globalSubscribers`/`subscribeGlobal`/`emitStatus` + `prompt()` busy→try→finally idle）·`acp-server.ts`（`GET /acp/global/events`）·`acp-http.ts`（`globalEventsURL`）·`backends/acp.ts`（`globalEvents:true` + 引用计数 `subscribeGlobal`/`openGlobal` + dispose）·`use-session-messages.ts`（卸载 gate 改 `!globalEvents`）。**`sessionStatus` 保持 false**。

**验证**：`global-status.test.ts` 2/2（mock e2e 断 busy→idle 序列、不泄漏 per-session、unsubscribe 生效）；acp-client 110/110、connector 75/75、monorepo typecheck 8/8；重编 ACP sidecar（`build-acp.ts`）+ 真机冒烟新端点返回 `200 text/event-stream`（与 per-session 对等）。

---

## 8.5 真机回归发现的两个问题（已确认根因 + 已修）

真机 opencode+qwen 走查（B 验证通过）后暴露两个问题。**两路独立审查 + `git diff` 客观核实：均非本次 diff 的结构性回归**（`use-session-messages.ts` 的数据重建路径 `setMessages([])`/fetchHistory merge/part.updated/part.delta **0 改动**；delegate/orchestration/deny 文件 **0 改动**）。

**Issue 1 — 切回后流式答案丢中段、完成时复原（opencode 特有）。**
- 根因：切回时 `[sessionId]` reset `setMessages([])` → 从 fetchHistory 快照重建。opencode 增量持久化**滞后于 live delta**，重建 = 滞后快照 + 从当前偏移续接的 delta → 中间断流段缺失，直到终态完整 `part.updated` upsert 复原。ACP 因 `acp-manager` 每事件同步 fold 而免疫。
- 归属：既有数据缺陷；此前被"切回假完成"遮蔽不可见，本次修复让切回**正确续流**后才**暴露成可见现象**。
- 修复（纯前端 `use-session-messages.ts`）：模块级**跨切换消息缓存** + fetchHistory merge 里的 **busy 门控「文本补丁」**（切回时按 id 把已在 `base` 里的消息文本换成缓存里更长的版本，**只补文本、不改成员/顺序**；idle 信快照）+ **cache-sync 在 `loading` 期不写**（见下 clobber）。
- **第三轮审查修正**：初版"缓存全量 seed + 不缩短 merge"被对抗审查抓到 **F1**（`fetchHistory` 分页，>80 条会话旧消息落 `sseOnly` → 乱序）、**F2**（revert 回合被复活）。改为 **text-only patch（不 seed、不改成员）**消除 F1/F2。
- **真机日志定位的真根因（关键）**：text-patch 仍失败——真机 `[SWB]` 日志显示**缓存被砸**（hook 的 cache-sync 在 fetch 窗口期把"被 delta 从零重建的 partial"写回缓存、覆盖了 len 442/1036/1540 的好缓存 → 砸成 len5；缓存其实远**领先**于滞后快照 len167）。更深层：**会话切走后，没有任何挂载的 hook 在处理它的 delta**，缓存冻结在切走点 → `[切走点,当前]` 那段流式文本客户端根本没收到。
- **完整修复（根治，无残留）**：新增 **app 级全局监听**——`use-sessions` 的全局 `useSSESubscribe` 把**每个会话**（含未挂载的后台会话）的 opencode message 事件经 `applyMessageEventToCache` 折叠进缓存。于是缓存**永远是当前的**（切走期 delta 也照进），切回 patch 出来零缺口。移除了 hook 的 cache-sync（缓存改由全局监听单一维护 → 不存在 clobber）；patch 改为**保留快照 info、只换缓存的 parts**（避免覆盖刚到的终态 finish）。ACP 的 message 事件不在全局流上，但 ACP 历史本就同步、不需要缓存。
- **第四轮审查修正（M1/M2/L1）**：① **M1** LRU(30) 被 task/编排子会话刷爆会驱逐 leader → 改为**只折叠"已注册（被看过）"的会话**（hook 挂载时 `registerMessageCacheSession`，子会话永不注册）；② **M2** patch 整段换 parts 仅比文本长度 → 可丢非文本 part / 复活已删 part → 改为**按 part id 合并**（升级文本、保留 base part、追加 cache-only part）+ `applyMessageEventToCache` 处理 `message.part.removed`；③ **L1** `deleteSession` 调 `forgetMessageCacheSession` 清缓存。
- 回归测试（`...-sending.test.ts`）：gap 复现 + **"切走期文本被捕获"**（核心）+ 不复活/不乱序（F1/F2）+ **缓存漏 tool part 不丢（M2）** + idle 信快照。
- **✅ 真实 opencode 路径自动化验证（金标准 A/B）**：搭 mock OpenAI-compatible LLM（流式 70 个 `M001..M070` 标记 token）驱动**真实 opencode**（有真实持久化滞后）+ Vite + Chrome；流式中 SPA 切走 3s 再切回，断言答案 marker 序列**连续无缺口**。结果：**启用全局监听 → 切回即 33 markers 无缺口（firstGap=null）、完成 70/70**；**禁用全局监听（阴性对照）→ 切回 firstGap=1 缺口、完成时自愈**（精确复现用户原始症状）。切回时 `[SWB]` 实测 `snapLen=25 / cacheLen=165`——快照滞后、缓存领先，patch 用缓存补齐，机制坐实。脚本：`scratchpad/{mock-llm,oc-switchback-e2e}.ts`。

**Issue 2 — 单 agent 会话显示了别的 team 会话的委派条目。**
- 根因：`DelegateDock` 在 `Session.tsx` 无条件渲染、且按 **workspace** 过滤（`delegate-dock.tsx:72`），不按当前 session；`DelegateRecord` 无"发起会话 id"字段，且全局委派 MCP（`orchestrator`）看不到调用方会话 id（MCP 协议不传），故无法按发起会话过滤。
- 归属：纯既有问题，与本次 diff 无关。
- 修复（纯前端 `Session.tsx`）：`DelegateDock` 仅在 **`canShowDelegates = teamEntry || isACPAgentId(绑定agent)`** 时渲染。
- **第三轮审查修正**：初版只 gate `teamEntry`，被审查抓到 **G1**——ACP agent 开 `orchestratorMcp` 后当单 agent 用**确实能委派**，但无 teamEntry → 会被隐藏 dock **连同 child 权限中继**（子会话卡等授权无 UI，功能性回归）。改为含所有 ACP-bound 会话（拿 `orchestratorMcp` 需异步 fetch，故宽松包含；非委派 ACP 会话只是空 dock，但**绝不隐藏会委派会话的 dock**）。
- **真机复测修正（team↔team）**：单 agent 串显已解决，但**已完成的 team 会话仍显示别的 team 在跑的委派**（同 workspace）。`DelegateRecord` 无 owner-session、委派 MCP 不传 caller session（已逐行核 `orchestrator/delegate.ts`：`parentSessionId` 只是隐藏 `[delegates]` 父、非 leader），**按发起会话精确过滤不可行**。可行修法：dock 再 gate 一层 **`isAgentActive`**——委派调用阻塞 leader 回合，故有在跑委派的会话本身必忙；**已完成/idle 会话 → 不渲染 dock → 不再串显**。**残留**（需 MCP 层 caller-session，不可行）：两个 team 同 workspace **同时活跃**仍互串（少见）。
- **根治（team↔team 同时活跃也不串）**：给委派加**发起会话 id**（owner-session）并按它精确过滤——我重新逐环核查后**两条通道都可行**：
  - **数据链**：`DelegateRequest.ownerSessionId` + `DelegateRecord.ownerSessionId`（orchestrator `delegate.ts`）；shim（`delegate-mcp.ts`）把它放进委派请求；`DelegateDock` 按 `d.ownerSessionId === sessionId` 过滤（无 owner 的退化为 workspace+`isAgentActive` 兜底）。
  - **ACP leader**：orchestrate MCP 是 per-session 注入（`acp-connection.ts hostMcpServers`），spawn 时塞 env `ULTRAWORK_DELEGATE_SESSION = emitSessionId`（leader 会话）→ shim 读 env。**干净、无 vendor patch。**
  - **opencode leader**：MCP 工具 execute 不传会话 + orchestrate MCP 全局 → **vendor patch**：`session/llm.ts` 把 `experimental_context:{sessionID}` 传给 streamText；`mcp/index.ts` execute 读 `options.experimental_context.sessionID` 注入 `client.callTool` 的 `_meta.ultrawork_session`；shim 读 `extra._meta`。
- 最终 dock 过滤：`canShowDelegates && isAgentActive`（渲染门控）+ 按 `ownerSessionId` 精确过滤（成员）。
- **分层防御**：`isAgentActive` 门控独立地修好"已完成会话串显"（与 ownerSessionId 无关、所有后端/agent 成立）；`ownerSessionId` 过滤再修"同时活跃串显"——opencode **完全健壮**（per-call `_meta`，运行时已验）。
- **ACP env 透传的进程隔离性（审查 M1 → 代码确证消解）**：审查担心"同一 ACP agent + 多 team 复用一个 MCP 进程 → env 静态误归属"。**读 `@agentclientprotocol/claude-agent-acp@0.51.0` 源码确证不成立**：`computeSessionFingerprint`（`acp-agent.js:45-49`）= `{cwd, mcpServers}`（含完整 env），`this.sessions` 按 sessionId 分键、**每会话各自 query 各自 spawn MCP**——不同 `ULTRAWORK_DELEGATE_SESSION` env → fingerprint 不同 → 独立进程独立 env。claude leader **per-session、正确**。仅剩理论残留：某个**不遵守 ACP per-session mcpServers 语义**的第三方 adapter（属 adapter bug，不可控）。

验证：typecheck 8/8；acp-client **112**、orchestrator **68**（+delegate ownerSessionId 拷贝）、desktop **243**（+`delegate-mcp` env/opts ×3、+DelegateDock owner 过滤/workspace 兜底 ×2）。**全链逐环验证**：① opencode `_meta` 透传**真机运行时**（stub MCP 实测 `extra._meta.ultrawork_session === sessionId`，`scratchpad/verify-meta.ts`）② shim→请求 ownerSessionId（callDelegate 单测）③ 请求→record（orchestrator 单测）④ record→dock 过滤（DelegateDock 单测）。重编 opencode+acp sidecar + 重生成 vendor patch。
- 第N轮审查修正：**L3** Session.tsx 过时注释（已更正为 owner 过滤）；**L5** delegate-mcp 测试传显式 `{env:{}}` 防 flaky。

---

## 9. 待办 / 验证记录

实现（B/②/D）：
- [x] 全局 `use-sessions` SSE 维护 `session.status` 忙碌 set（B-①）。
- [x] `Session.tsx` 派生 `sessionActive += sessionBusy`；停止条/输入接 `isAgentActive`（B-②/③）。
- [x] 切走清理 gate `!globalEvents`；`ToolStatusIcon` `live` 钳制（B-③/②）。
- [x] 方案 D：ACP sidecar 全局 `session.status` 流 + connector `subscribeGlobal`；重编 sidecar。

第二轮系统 review（两路对抗审查）修复：
- [x] **M1**：全局 handler 处理 `server.instance.disposed` → 清空忙碌 set（防 opencode instance dispose 后后台会话永久卡 busy）。
- [x] **M2**：ACP manager 订阅即快照（`running` set，仿 delegate.snapshot）→ 自愈 SSE 重连 + 闭合 ACP 应用冷启动；connector `openGlobal` 加 `gave-up` 告警。
- [x] **M3**：`sendMessage` guard 加 `activeSessionIds` 防御（切回防双发不只靠 UI disabled）。
- [x] **L6**：`markSessionIdle` 对不在侧栏列表的 id 跳过 `setSessions`（子会话 idle 不再 churn）。
- [x] **G3 文档更正**：§2 "ACP 靠轮询" 表述（ACP `questions:false` → 从不轮询）。

验证矩阵（全绿）：
- [x] typecheck 8/8；desktop **236/236**（含切走清理 ×2 / sendMessage guard ×2 / sse-context 全局接线回归）；acp-client **111/111**（global-status busy/idle + 快照 ×3）；connector **75/75**。
- [x] **headless API e2e（真实编译二进制）**：`POST /prompt` → `/acp/global/events` 实发 `session.status` busy→idle。
- [x] **Chrome + Vite + Playwright 走查（真实 app + ACP mock agent，`MOCK_ACP_HOLD_MS` 持有回合）**：① 初始流式 ② **goBack→goForward(SPA remount) 后仍流式 + 停止键（测 B）** ③ **整页 reload 后仍流式（测 M2 快照）**；截图肉眼确认头部转圈/打字点/停止键/侧栏忙碌点，非绿勾假完成。
- 测试基建增量：devDep `playwright-core`；`mock-acp-agent.ts` 新增 `MOCK_ACP_HOLD_MS`（additive/gated）。走查脚本在 scratchpad（可按需固化为 `packages/client/desktop/scripts/` 复用 harness）。

残留（已知、可接受、文档在册）：
- [ ] 真机用户顺手确认（浏览器走查已等价覆盖，可选）。
- [ ] G1 冷启动 opencode 侧无快照（ACP 已由 M2 闭合，opencode 对称缺口，opencode 无状态查询端点）；G2 Team leader 等 delegate 间隙（§4.2，可选交叉校验）。
