# ADR-049: idle 看门狗补「工具参数生成」相位（600s 兜底杠）

- **日期**: 2026-07-11
- **状态**: Accepted（✅ 已实现）
- **修订**: ADR-034（补其漏掉的第四个相位，并证伪其一条核心假设）

## 背景

真机截图驱动（三张，2026-07-09 / 07-11）：qwen3.7-max 会话在生成 PDF / 写大文件时，回合中途报 `回合出错: LLM stream idle for 30000ms`，最后一个工具显示 `0ms` + `Tool execution aborted`。

完整取证链见 [discussions/032](../discussions/032-llm-idle-guard-tool-input-phase.md)，结论：

1. **工具从未执行**。`0ms` + `Tool execution aborted` 是 `processor.ts` 的 `cleanup()` 在回合失败时给未完成 tool part 打的**墓碑**（且把 `time.start` 重写成 `Date.now()`），不是「工具被中途杀死」。
2. **停流是 provider 的正常行为，且是暂态的**。直连 SSE 探针（绕开 AI SDK，不设 idle 超时）实测：qwen/DashScope 在「流式吐工具参数」相位存在**缓冲模式**——报出函数名 → 吐几十字节参数前缀 → **服务端把整段参数憋完** → 一次性 flush。静默 **37~65s，12/12 复现，12/12 自行恢复并正常收尾**（`finish=tool_calls`）。
3. **DB 时间戳与之同构**：失败回合的墓碑精确落在最后一个事件 +30111ms / +30829ms，而最后一个事件正是 reasoning/text 结束后 +0.1s 的那个参数前缀 chunk。
4. **参数越大 ≠ 静默越久**（反直觉，实测推翻）：6~7 万字符的参数反而**全程逐 chunk 流式吐出**（3900~5000 chunk，maxGap 仅 5~8s，0/3 停流）。⇒ 存在**两种独立模式**（流式 / 缓冲），不是一条随大小单调的曲线。
5. `enable_search`（ADR-042）经 A/B **排除**：开/关两组停流率都是 100%，与本问题无关。

**根因**：`idleGuard` 只认三种状态——首字前（TTFB 90s）、首字后流动中（idle 30s）、工具**执行**中（撤防）。而 **`tool-input-start` → `tool-call` 之间的「工具参数生成中」相位落进了第二档**：此时 `tool-call` 尚未到达 ⇒ `inflightTools` 仍是空集 ⇒ 不撤防；`sawFirstToken` 已被 reasoning/text delta 置真 ⇒ **用最紧的 30s 杠，去量一个 provider 正常需要 40~60 秒的窗口** ⇒ **必然误杀**。参数越大、缓冲模式下憋得越久 ⇒ 任务越复杂越必挂。

> **ADR-034 被证伪的假设**：「一旦 token 开始流动，chunk 间隔就是亚秒级，所以 30s 静默 = 挂死」。该假设在**文本相位**成立（时间线实证文本 chunk 亚秒级），在**工具参数相位**不成立。ADR-034 想到了「工具**执行**」要豁免，漏掉了「工具**参数生成**」同样要。

## 决策

给 `idleGuard` 补第四个相位，用 `pendingInputs: Set<string>` 跟踪「已报出工具名、参数尚未收齐」的工具调用：

```
限额 = inflightTools 非空   → 撤防（工具执行中，不变）
     : pendingInputs 非空   → STREAM_TOOL_INPUT_TIMEOUT_MS = 600_000   ← 新增
     : sawFirstToken        → STREAM_IDLE_TIMEOUT_MS = 30_000（不变）
     : 否则                  → STREAM_TTFB_TIMEOUT_MS = 90_000（不变）
```

### 为什么是 600s，而不是「实测最大值 × N」

两种模式是**独立**的，坏组合（缓冲模式 + 超大参数）我们没测到、也测不完。按实测的 180~250 字符/秒外推，缓冲模式下一次 4 万字符的 write ⇒ 静默约 **200s**；6 万字符 ⇒ 约 **300s**。任何按当前实测上限（65s）乘系数定出的固定阈值（180s / 300s）都会在坏组合上继续误杀。

更根本的一点：**时间上无法区分「服务端在憋参数」和「真挂死」**——两者在 SSE 上完全同构（都是零字节）。既然无法区分，就按两类错误的代价取舍：

| | 代价 |
|---|---|
| **误杀**一个合法的 200s 参数生成 | **硬性产品故障**：工作作废、上下文丢失、用户被迫重来 |
| **真挂死**多等几分钟 | 难受但**可恢复**：用户随时可点「停止」（已代码级验证，见下）；而看门狗的**唯一刚需**是防止 ADR-034 那个 **session 忙锁永不释放的死锁**，一个很长的兜底杠同样能治 |

⇒ 工具参数相位上，看门狗应当**极度保守**。600s **与 ACP 侧 `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认 10 分钟工具静默上限）对称**，两条后端路径语义统一。

**逃生路径已验证**（这是本取舍的地基，不是假设）：`use-session-messages.ts:726` 停止按钮 → `connector.cancel()` → `POST /session/:id/abort` → `SessionPrompt.cancel` → `runner.cancel`（fiber interrupt）→ `Stream.scoped` release → `ctrl.abort()` → 断掉挂着的 fetch。**停流期间点停止能立刻解锁会话，不受 600s 影响。**

### 簿记（基于核实过的 AI SDK v6 事件形状，非推测）

`ai@6.0.138` `TextStreamPart`：`tool-input-start {id, toolName}` → `tool-input-delta {id}` → `tool-input-end {id}` → `tool-call {toolCallId}` → `tool-result | tool-error {toolCallId}`。

**`tool-input-start.id` ≡ `tool-call.toolCallId`**——由 opencode 自身代码坐实：`processor.ts:157` 以 `value.id` 建 part、`:178` 以 `value.toolCallId` 取回同一个 part（取不到即 `return`），真机工具正常渲染 ⇒ key 一直对得上。

⇒ `tool-input-start` 入集；`tool-call` 出集**并**转入 `inflightTools`；**防泄漏**：`tool-result` / `tool-error` 也删（覆盖 `experimental_repairToolCall` 把工具名改写成 `invalid` 等异常路径），`finish-step` 清空整个集合。泄漏的后果不是崩，而是 guard 在该 stream 剩余时间里一直用最松的杠（看门狗部分失效），故必须堵死。

### ACP 侧（同源同形，同一批修复）

**实测坐实**（真 Claude agent + 真 acp-client 二进制，权限自动放行）：让 Claude 一次 Write 写一个 300 行 python 文件——

| 二进制 | 结果 |
|---|---|
| 未修复 | ❌ HTTP 502 `ACP turn idle for 30000ms`，34s 死在 `tool:pending` 且 `input={}` |
| 已修复 | ✅ HTTP 200，61.9s 正常收尾；日志显示参数流式期间 **gap 52.3s 零 `session/update`** |

**根因同构**：claude adapter（`@agentclientprotocol/claude-agent-acp`）对 `input_json_delta` 是 `case "input_json_delta": break` —— **参数流式期间一个 `session/update` 都不发**；它只在 `content_block_start` 发 `tool_call{status:"pending"}`、在 block 收口后发填好 `rawInput` 的 `tool_call_update`。而我们的看门狗只在 **`in_progress`** 时才把工具计入 `activeTools` 撤防（`acp-connection.ts`）⇒ 整个参数窗口用 30s idle 杠去量 ⇒ 必然误杀，写的文件越大越必挂。

**修法对称**：新增 `pendingTools` 集合——`tool_call` 的 `pending`（或**省略 status** 的首帧，SDK 允许）入集、`in_progress` 转入 `activeTools`、`completed`/`failed` 两集合都清；`inTool` 判据改为 `activeTools ∪ pendingTools` 非空 ⇒ 该窗口自动复用**已有的** `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认已是 600s）。**不引入新常量**，两条后端路径四相位语义完全一致。

**一个 code review 抓出来的自伤缺陷（已修）**：adapter 还会在工具**完成之后**发**不带 status** 的 `tool_call_update`（PostToolUse 的 Edit/Write diff、Bash 的 terminal-output meta，见 `acp-agent.js:3346/3457`）。最初的写法把「任何非 in_progress/completed/failed 的帧」都塞进 `pendingTools` ⇒ 这类帧会把**已结束的工具复活**进 pending 集合、而**再无任何路径删它** ⇒ 此后整个回合 `inTool` 恒真、看门狗**永久停在 600s 杠**上，对真正的流中停顿彻底失明（改动前的代码不可能泄漏——它只在 `in_progress` 加、只在终态删，是本次改动引入的）。修法=加 `settledTools` 集合，终态后不再复活。回归用例 + A/B 反证：撤掉守卫后该用例耗时 5021ms（等满 5000ms 工具静默杠而非 100ms idle 杠），泄漏直接被量出来。

**排查中的一处自我纠错**：我最初用 `/acp/global/events` 观测，据此以为「权限请求从未发生」。实际上**全局流只广播 `session.status`**（`acp-manager.ts:327`），`permission.asked` 与消息 part 都走 `/acp/session/:id/events` —— 我的 harness 一直没在听，于是 agent 在等一个没人回的权限，把「回合卡在 pending 20 分钟」的假象算到了缺陷头上。改订阅 + 自动放行后，上表的 A/B 才是干净的。

## 备选与权衡

- **工具参数相位完全撤防**（像工具执行那样）：弃用。参数相位真挂死时会永久挂起，正是 ADR-034 要治的死锁。600s 是「保守但有限」的中间态。
- **180s / 300s 固定阈值**：弃用，理由见上（坏组合仍误杀）。
- **让 idle abort 可重试**（`retry.ts` 识别 + `Session.removePart` 清残留 part）：**本次不做**。主修后误杀消失，这条只覆盖「真挂死」的残余场景，却要引入 part 去重复杂度（失败 attempt 会在同一条 assistant 消息上留下 reasoning + pending tool part，重试会叠加）。列为观察项。
- **收窄 `enable_search`**：A/B 证伪，无关。

## 验证

- **ACP 侧**：acp-client 单测 **141**（+4：pending 期间静默不误杀 / 静默跨过 600s 杠仍报 `tool silent` / 首帧省略 status 也按 pending 处理 / 工具完成后短杠重新武装）+ **A/B 反证**（撤掉 pending 判据 → 3/4 新用例变红）+ 真 Claude agent 端到端 A/B（上表）。
- **Headless 真实二进制**（沿用 ADR-034 配方，`testing.md §8`）：mock OpenAI-compatible provider 新增 `/toolstall` 模式（发工具名 + 几十字节参数前缀 → 静默**跨过旧的 idle 杠** → flush 完整参数 + finish），env 缩小常量以免测试跑太久。断言：① 该回合**不再被杀**、工具正常执行、`finish=stop`；② 静默超过**新的工具参数杠**时**仍然**落 `LLM stream idle` 错误终态（看门狗没被改废）；③ 原有 idle / TTFB / normal 三态不回归。
- **A/B 反证**：删掉 `pendingInputs` 分支，① 必须变红（防止写出「注释里有 env 名就能过」的假守卫）。
- **真机验收**：qwen3.7-max + 原始复现场景（「生成一个 pdf，内容随意」）连跑 5 次不再出现 `LLM stream idle for 30000ms`；停流期间点「停止」，会话立刻解锁。

## 已知边界

- **缓冲模式的触发条件未知**（服务端行为，客户端观测不到）。600s 兜底杠使其无关紧要；若日后 DashScope 把憋参时间拉更长，env 可调。
- **真挂死的用户体感变差**：从「30s 报错」变成「最长干等 600s」。缓解=「停止」按钮。这是上述取舍的自觉代价。
- **其他 provider 是否也有缓冲模式**：未测。但 600s 是**放宽**方向，对其他 provider 只会更安全，无回归风险。
- `Tool execution aborted` + `0ms` 的**显示语义误导**（`cleanup()` 抹掉真实 `time.start`）：既存问题，本次不改。

## 关联

- 调研与全部实证数据：[discussions/032](../discussions/032-llm-idle-guard-tool-input-phase.md)
- 被修订：[ADR-034](./034-llm-stream-idle-guard.md)（两级 idle 看门狗）
- 契约固化：[gotchas §1](../gotchas.md)（qwen/DashScope 工具参数缓冲模式）
- vendor patch：`patches/vendor-opencode-config-fix.patch`（`session/llm.ts`）
