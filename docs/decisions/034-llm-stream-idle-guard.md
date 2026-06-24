# ADR-034: LLM 流式 idle 看门狗（工具感知两级超时，opencode + ACP 对称）

- **日期**: 2026-06-24
- **状态**: Accepted（✅ 已实现，两侧 headless 真实二进制验证）

## 背景

真机截图驱动：一个 `alibaba-cn/qwen3.5-plus`（自定义 provider）会话回复中途卡住，永久转圈，重试也无反应。DB（`opencode-.db`）+ 日志逐行取证定位：

- 卡死的 assistant 消息：reasoning part 正常收尾，随后 text part **只有 `time.start` 无 end、零 delta**；消息本身**无 `finish`、无 `info.error`、无 `time.completed`**、tokens/cost 全 0。
- 日志：该会话 prompt loop 只到 `step=3`，无 step 4，全天**零 ERROR/WARN/abort**；sidecar 进程未崩（仍服务别的会话）。
- 后续两条重试 prompt 的 `prompt_async` 被 HTTP 接受，但**再无 `session.prompt step=0`**。

**根因**：provider 的 SSE 流在「发完 reasoning、正文 block 刚开」处**静默 stall**——既不发 chunk、也不发结束帧、也不报错（TCP 挂着）。而 AI SDK v6 `streamText` **只有 `abortSignal`、无任何 idle/stall 超时**，于是 `result.fullStream` 异步迭代器永远不 yield 也不 throw → `session/processor.ts` 的 `Stream.runDrain` 协程**永久挂起** → 回合不收尾、session 忙锁不释放 → 后续 prompt 全部排队卡死。

这与既有两类出错回合**不同**：① qwen 审核 400 → 有 `info.error`（终态）；② 前端「假完成」→ 纯渲染时序。本 case **既无 `finish` 也无 `error`**，是后端真死锁，前端判定全兜不住、单改前端不能根治。

调查确认缺陷在两条路径共享/对称：
- **opencode 后端**（qwen 等 REST provider）：`processor.ts` → `llm.ts` 的 `streamText`/`fullStream`，无 idle 超时。单 Agent + Team-opencode 成员共用此路径。
- **ACP 后端**（claude/gemini/hermes）：`acp-connection.ts` 的 `prompt()` 阻塞到 `conn.prompt` 返回 StopReason，agent 静默则永挂。Team-ACP 成员另有 orchestrator 10min runTurn 兜底，但桌面直连 ACP 裸奔。

## 决策

给两条路径都加**工具感知的两级 idle 看门狗**，把「静默挂死」转成「错误终态 + 解锁会话」。

### 1. opencode 侧：`session/llm.ts` 的 `idleGuard`（vendor patch）

在 `Stream.fromAsyncIterable(result.fullStream, …)` 外包一层 async-generator 看门狗：

- **两级超时**：首 token 前 `STREAM_TTFB_TIMEOUT_MS`（默认 90s，容忍 prefill/冷启动/reasoning 静默思考）；首个 `text-delta`/`reasoning-delta` 后降到 `STREAM_IDLE_TIMEOUT_MS`（默认 30s，流动中 chunk 亚秒级、stall 快报错）。
- **工具感知**：工具在 stream 内部执行（`tool-call`→`tool-result`/`tool-error` 间 `fullStream` 静默，长 bash/webfetch/30min delegate 合法），用 `Set<toolCallId>` 跟踪在飞工具，**有工具在跑时撤销看门狗**。用 Set 而非布尔——并行多工具时布尔会被首个 result 过早重置、误杀仍在跑的兄弟工具。
- **触发动作**：`ctrl.abort()`（断挂死的 fetch、释放连接）+ 抛 **plain Error** → `SessionRetry.policy` 判**不可重试**（plain Error 不命中限流特征）→ `Effect.catch(halt)` → 落 `info.error = "LLM stream idle for Nms"`（终态、解锁、可重试）。
- **fire-and-forget 关闭**：finally 里 `it.return()` 不可 `await`——wedged read 可能让它永挂、反而吞掉刚抛的错误。
- **多 step 天然正确**：每个 opencode step 是独立 streamText/idleGuard（`prompt.ts:1344` 外层 while），工具后下一步首字在新 step 重获 TTFB，无需跨 step 状态（保留防御性 reset 以防 AISDK 未来单流多 step）。

### 2. ACP 侧：`acp-connection.ts` 的 `prompt()` 看门狗 + `TurnShaper.sealed`

`Promise.race(promptPromise, idleWatchdog)`，活动信号 = `session/update`：

- **三级 limit**：有工具在跑（`activeTools` 非空）用 `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认 10min，治 gemini interactive-shell 类挂死工具 / 完成事件缺 status 的泄漏）；否则按是否「已开口」选 `ACP_PROMPT_TTFB_TIMEOUT_MS`（90s）或 `ACP_PROMPT_IDLE_TIMEOUT_MS`（30s）。
- **`sawFirst` 只认内容帧**（`agent_message_chunk`/`agent_thought_chunk`）——`plan`/`usage_update` 打头不算「已开口」（Claude 系有 plan 帧，否则提前降级 30s 误杀）。
- **工具完成重置 `sawFirst`**——ACP 整回合一个 `prompt()`，工具后 agent 重读大上下文产答案的首字要重获 TTFB。
- **触发**：`cancel(sessionId)` + plain Error → `failTurn` 发 `session.error` → 桌面 502 解锁。
- **并发护栏**：同 session 已有在飞 prompt 直接 reject（`promptActivity` 按 sessionId keyed）。
- **`sealed` 防僵尸**：`endTurn`/`failTurn` 封口、`startTurn` 解封、`handleUpdate` 封口时早返回——abort 后 agent 在 cancel 落地前继续吐的 chunk 不会在 `session.error` 后再开新消息。

### 3. 默认值与可调性

首字 90s / 流中 30s / 工具静默 10min。两侧常量均 env 可覆盖（ACP lazy 读便于测试/ops；opencode 模块载入读）。

## 备选与权衡

- **Effect `Stream.timeout`**：是整流/空闲超时但**对工具盲**（工具执行窗口会误杀），故弃用，改自写工具感知 async-generator。
- **单级固定超时**：90s 太长（用户干等 1.5min）、30s 全局太短（慢首字误杀）。两级兼得：流中挂死 30s 快报错、慢首字仍 90s。
- **前端兜底**：可显示「回合异常中断」，但无法解锁后端死锁、重试仍废 → 必须后端修。

## 验证

- acp-client **108 单测**（idle 套件 11 例：TTFB/idle 两级、工具豁免、wedged、重新武装、并发护栏、sealed、P1-1/P1-2 回归）；vendor `llm.ts` typecheck 净。
- **三轮对抗审查**：P0 并行工具布尔→Set；await 永挂→fire-and-forget；updateChain 毒化→`.catch`；两级 `sawFirst` 语义 P1-1（工具后误杀）/P1-2（plan 打头降级）。
- **Headless 真实二进制**：ACP **14/14**（TTFB 3s / idle 1.5s / 工具静默 / 正常不误杀，隔离 XDG + mock ACP agent）；opencode **6/6**（流中挂死→`idle for 2000ms`、首字前→`idle for 3500ms`、正常 finish=stop，隔离 sidecar + mock OpenAI-compatible provider）。隔离沙箱零碰真实数据。

## 已知限制

- **首字 TTFB > 90s 的极端慢首字**会误判（冷启动 + 超大上下文 + 慢 provider 同时发生），罕见；env 可调。
- opencode 纯工具回合（无 text/reasoning）停顿检测用 90s（慢但不误杀）。
- ACP 合法长工具若 > 10min 完全静默（无任何进度帧）会被砍；多数 ACP agent 会周期发 `tool_call_update`，且 Team 路径另有 orchestrator 10min 兜底。

## 关联

- 缺陷与契约固化：[gotchas §1](../gotchas.md)（opencode/llm.ts）、[gotchas §8](../gotchas.md)（ACP）。
- headless 复现配方：[testing.md](../testing.md)。
- vendor patch：`patches/vendor-opencode-config-fix.patch`（新增 `session/llm.ts`）。
