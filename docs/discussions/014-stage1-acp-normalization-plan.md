# 014 · 阶段1 可执行方案 — ACP 单 agent 异构归一化（档1）

> **状态**：✅ 已正式化为 [ADR-027](../decisions/027-acp-multi-agent-backend.md) 的实现章节（2026-06-08）。本文保留为**完整 file:line 级实现细节**的探索底稿；决策级摘要见 ADR-027。
> **日期**：2026-06-08
> **范围**：方案文档，**不含任何代码改动**。file:line 为现状定位（多数在 `feat/acp-support` 分支，用 `git show feat/acp-support:<path>` 读），实施时以当时代码为准。
> **上游**：[013](./013-agent-os-acp-multi-backend.md) §9 阶段1 + §6.1/§6.5。本文把「档1 = 单 agent 异构归一化」展开为可执行任务。
> **目标判据**：阶段1 完成 = **claude code / gemini / qoder 逐个**在 Ultrawork 里「结果正确渲染 + 交互（权限/能力）正常 + 进程稳定」。**只验 opencode 不算完成。**
> **前置**：遵循 [quality-gates.md](../quality-gates.md)；typecheck `bun run --bun turbo run typecheck`；sidecar 改后 `bun run build:acp`。

---

## TL;DR

1. **一个关键设计决策先定（D1）**：归一化放在 **sidecar**（忠实把 ACP `session/update` 翻译成 opencode 的「多-message/回合」SSE 形状，**复用 main 现有 ADR-029 turn 渲染器**），**而非**前端另建一套 ACP 渲染器。理由见 §1——这把 80% 工作量收敛到 sidecar 的事件桥，前端改动最小。

2. **分支现状 = 管道通、归一化半成品**。`feat/acp-support` 已能连、能流式，但事件桥（`acp-connection.ts:355-455`）映射严重不全、权限直接 auto-approve、进程无优雅关闭、且**基于 ADR-029 之前的旧渲染器**（删了 main 的 `assistant-turn/execution-flow`）。所以阶段1 = re-baseline + 把事件桥/权限/进程做对。

3. **六条工作流**（按依赖排序）：**W0 re-baseline** → **W1 事件桥归一化（核心/最大）** → **W2 前端渲染对接（最小）** → **W3 权限归一化** → **W4 能力协商** → **W5 进程稳定性**。W1 是重头。

4. **最隐蔽的坑**：ACP 把整轮 text+reasoning+tool 全挂**一条 message**，而 main 的 `buildTurnModel`（`assistant-turn.tsx:53`）一旦发现该 message 含 tool part 就把**最终答案吞进折叠的 ExecutionFlow，正文不显示**。→ sidecar 必须把一回合拆成「过程 message + 独立答案 message（仅 text）」，**模仿 opencode 自己的 N-message/回合发法**（ADR-029）。

---

## 1. 关键设计决策 D1：归一化放在 sidecar（推荐），不另建前端 ACP 渲染器

| | 方案 A（推荐）：sidecar 忠实翻译 → 复用 main 渲染器 | 方案 B：前端建独立 ACP 渲染器 |
|---|---|---|
| 思路 | sidecar 把 ACP `session/update` 整形成 opencode 的 `message.part.updated/delta` + 多-message/回合 | 前端按 ACP 标准 `session/update` 直接渲染 |
| 复用 | ✅ 复用 ADR-029 的 `groupIntoTurns`/`buildTurnModel`/`ExecutionFlow`（成熟、含 process/answer 切分、统计页脚） | ❌ 重写一套，和 opencode 路径双轨维护 |
| 前端改动 | 小（主要是验证 + 权限回环 + 能力 gating） | 大 |
| 风险 | sidecar 整形必须忠实（turn 切分 + 字段补全） | 渲染分叉、与 opencode 体验漂移 |

> **决策**：取**方案 A**。这是对 [013](./013-agent-os-acp-multi-backend.md) §6.1「渲染层直接消费 ACP 标准 `session/update`」的**落地细化**——"直接消费"指**不丢 ACP 任何事件变体、忠实补全语义**，但承载渲染的仍是 main 的 turn 渲染器；归一化逻辑落在 sidecar 事件桥，而非前端另起炉灶。**判据**：sidecar 发出的 SSE 应「长得和 opencode 自己发的一模一样」，前端无从区分来源。

> **边界澄清（接 [013](./013-agent-os-acp-multi-backend.md) §6.6）**：D1 解决的是**①渲染统一**（公共事件模型，落在 sidecar）。它**不是** api-client 统一——阶段1 仍是 api-client(opencode) + agent-router(ACP) 两个 client。**②控制统一**（后端无关的 `prompt/subscribe/cancel/delegate` 接口 = `@agent/connector`）留给**阶段2**，阶段3 编排依赖它。所以「ACP→opencode 形状」是「适配到 Ultrawork 公共事件模型（当前 == opencode 形状）」的有意契约，不是永久假装 opencode，也不妨碍阶段2 把翻译逻辑收敛进 connector。

---

## W0 · re-baseline（前置，阻塞后续）

**现状**：分支起于 2026-05-25，diff 删除了 main 的 `assistant-turn.tsx`(-258)/`execution-flow.tsx`(-341)/`message-parts.tsx`(-132)，把 `message-list.tsx` 改回 flat `messages.map()→AssistantMessage`。即**分支用的是 ADR-029 之前的旧 flat 渲染器**，而 ACP 事件整形也是为旧渲染器设计的。

**任务**：
- [ ] 把 `feat/acp-support` rebase 到当前 main，**保留 main 的 ADR-029 turn 渲染器**（放弃分支对 `assistant-turn/execution-flow/message-list` 的回退改动）。
- [ ] 保留分支与渲染层无关、可直接复用的部分：`agent-types.ts`/`use-agents.ts`/`agent-context.tsx`/`agent-router.ts`/`use-acp-sse.ts`/`acp-client` sidecar/`agent-selector`/`agents-section.tsx`（这些不依赖渲染层）。
- [ ] 解决 `use-session-messages.ts` 的合并冲突（分支 +542 行 ACP 注入 vs main 的 ADR-029 版）。

**验收**：rebase 后，opencode 路径在 main 的 turn 渲染器下功能不回退；ACP 路径暂可不工作（W1/W2 修）。

---

## W1 · sidecar 事件桥归一化（核心，最大工作量）

**现状**：`acp-connection.ts:355-455 handleSessionUpdate` 把所有 part 挂单一 `messageID = acp-{sessionId}-msg-{N}`，映射严重不全。

### 1a · turn 整形（最关键）
**缺口**：整轮挂一条 message → `buildTurnModel`（`assistant-turn.tsx:53` `lastIsAnswerStep`）见含 tool part → answer 为空 → **最终答案被埋进折叠区**。
**做法**：sidecar 模仿 opencode 的「N-message/回合」（ADR-029）——
- 过程步骤（reasoning / tool / 中间 narration）发为**过程 message**（可多条，每工具 step 一条，对齐 opencode）；
- 回合最终文本发为**独立答案 message**（仅 text part，**不含 tool part**），使 `lastIsAnswerStep=true`，正文正常显示。
- 回合结束发一条 `message.updated` 带 `info.finish`（终态），让 `message-list.tsx:110 isTerminal` 成立、ExecutionFlow 收起、统计页脚出现。**当前完全无终态事件 → 最后一轮永远转圈。**

### 1b · 事件映射修全
**对照表（ACP `session/update` → main 渲染目标）**：

| ACP 事件 | 当前缺陷（file:line） | 修正目标 |
|---|---|---|
| `agent_message_chunk` | 仅 text，丢 image/audio/resource（`:362-376`） | text→答案 message 的 text part；image/resource 至少降级为链接/占位 |
| `agent_thought_chunk` | →delta，但 main delta 新建 part 硬编码 `type:"text"`（`use-session-messages.ts:332`）→ reasoning 降级为普通文本 | **先发 `message.part.updated` 显式建 `type:"reasoning"` part**，再用 delta 追加 → 走 `ReasoningRow`（Brain） |
| `tool_call` | 缺 `callID`、`input:{}`、`output:""`、`kind`、`content`/`locations`（`:392-414`） | 补 `callID=toolCallId`、`state.input=rawInput`、`tool=kind/title`、首帧 title；status `pending/in_progress`→`pending/running` |
| `tool_call_update` | 覆盖 bug：`tool:"tool"`/`title:""` 覆盖原值；`failed`→误判 running（`:415-437,:426`） | 按 `toolCallId` **upsert 保留 title**；`content`→`state.output`；**`failed`→`error`+`state.error`** |
| `usage_update` | 无 token/cost，无 finish（`:438-451`） | 填 `info.tokens.{input,output,reasoning,cache}`+`info.cost` → 统计页脚 |
| `plan` | **未映射**（default 吞掉，`:452`） | 阶段1 可先折叠进 ExecutionFlow narration；后续做 PlanRow |
| `prompt()` 返回 `stopReason` | 仅前端 setSending，无 SSE 终态 | 见 1a 终态信号 |
| `ToolCallStatus` | 只识别 `completed`，其余归 running | 全识别 `pending/in_progress/completed/failed` |

> **参考实现（强烈建议照搬）**：acpx 的 `src/session/conversation-model.ts`（`SESSION_UPDATE_HANDLERS` 映射表）+ `src/runtime/public/events.ts`（`parsePromptEventLine`）已经把这套「ACP `session/update` → 统一模型」做完了，几乎可直接对照：① `tool_call` 与 `tool_call_update` 走**同一个 `applyToolCallUpdate()` 按 `toolCallId` upsert**（拆 identity/input/status/result 四个子更新）——正好修我们的覆盖 bug；② token usage 的 **snake_case/camelCase 双命名归一**（`input_tokens`/`inputTokens`、`cacheReadInputTokens`/`cachedReadTokens`）；③ status 文本判定 `statusIndicatesComplete/Error`（含 complete/done/success/failed/error/cancel）；④ 工具输出摘要截断 `TOOL_OUTPUT_SUMMARY_MAX_CHARS=500`。注意 acpx 的 `plan` **不进**持久会话模型、只作为 status 事件渲染——印证我们阶段1 把 plan 折叠进 narration 的取舍。

**任务**：
- [ ] 改 `handleSessionUpdate` 实现 1a turn 整形（过程/答案 message 拆分 + 终态）
- [ ] 逐项修 1b 映射（reasoning part 显式建、tool 字段补全、tool_call_update upsert、failed→error、usage、status 全集）——**对照 acpx `conversation-model.ts`**
- [ ] `agent_thought_chunk`/`tool_call` 用 `message.part.updated` 建 part（规避前端 delta 建 part 缺陷，见 W2）

**验收**：claude 回一段含「推理 + 工具调用 + 最终答案」的回复时——Brain 区显示推理、ExecutionFlow 显示工具（含 input/output、失败标红）、正文显示最终答案、页脚出 token/cost、回合结束不转圈。

---

## W2 · 前端渲染对接（最小改动）

**思路**：W1 让 sidecar 发「opencode 形状」事件后，前端**理论上无需大改**。但要补一处防御性缺口：

**缺口**：`use-session-messages.ts:306-338` 的 `message.part.delta`——当 message 已存在但 partID 不存在时（`:311-321`）**无 else 分支补建 part → delta 丢弃**；且新建 part 硬编码 `type:"text"`（`:332`）。

**做法（二选一）**：
- **首选**：W1 保证「先 `part.updated` 建正确类型的 part，再 delta 追加」，则**不必改 main**（最干净，符合 D1「长得像 opencode」）。
- **兜底**：若仍有「delta 先到」竞态，给 `:311-321` 补 else：按事件携带的 `type` 建 part（不硬编码 text）。此改动对 opencode 路径也安全（opencode 也总是 part.updated 先行）。

**任务**：
- [ ] 验证 W1 整形后，reasoning/tool/answer 在 main turn 渲染器下正确显示（无需改渲染器）
- [ ] 如有竞态，补 delta 建 part 的 else（防御）
- [ ] `use-acp-sse.ts` 的 sessionID 改写 hack（`:43-54`）随 W1 整形复核（W1 若直接发 opencode sessionId 形状可简化此 hack）

**验收**：ACP 消息与 opencode 消息在同一渲染器下视觉一致，无丢 part、无 reasoning 降级。

---

## W3 · 权限归一化（去掉 auto-approve，接 permission-dock）

**现状**：`acp-connection.ts:315-325` 收到 ACP `session/request_permission`（**同步 RPC**）直接选 `allow_once` 返回，**无 UI、无 SSE**。

**接入点（main）**：`use-session-permission.ts`（监听 `permission.asked`/`replied` + 3s 轮询，`replyPermission(once|always|reject)`）+ `permission-dock.tsx`。`PermissionRequest` 形状 `{id,sessionID,permission,patterns[],always[],tool?}`（`types.ts:182-190`）。

**做法（建立挂起-回复回环）**：
1. sidecar 收到 `request_permission` 时**挂起 promise**（不立即 resolve），生成 permissionId，发一条 `permission.asked` 形状 SSE（把 ACP `options` 的 `kind`：`allow_once/allow_always/reject_once/reject_always` 映射到 dock 的 once/always/reject；`title`→permission label）。
2. 新增 REST 端点 `POST /acp/session/:id/permission`（body: permissionId + 选中 optionId）→ resolve 挂起 promise → 返回 `RequestPermissionResponse{outcome:selected, optionId}`。
3. 前端 `use-session-permission` 复用现有 dock，回复改打到 ACP 端点（按当前会话是 ACP 还是 opencode 分流，复用 agent-context 的 isACPAgent）。
4. 超时/会话取消时默认 `reject`（安全默认）。

> **参考实现（acpx `src/permissions.ts`）**：acpx 的 `request_permission` 回环值得照搬骨架——① 先走 host 回调 `onPermissionRequest`（带 AbortSignal，可被 cancel 中止）；② 否则三段式解析 policy(autoDeny>autoApprove>escalate) → mode(approve-all/deny-all) → approve-reads 回退（`isAutoApprovedReadKind∈{read,search}` 自动放行）；③ `inferToolKind()` 先用 ACP `kind`、否则按 title 关键词；④ session 在 cancelling 集合则立即 `{outcome:"cancelled"}`。**纠正**：acpx 的 `nonInteractivePermissions` 只有 **`"deny"|"fail"`** 两值（无 `skip`/`queue`——"queue"是另一套 queue-owner 机制，别混）。阶段1 可先实现「全部 ask（弹 dock）+ 安全默认 deny」，policy 引擎留作后续。

**任务**：
- [ ] sidecar：挂起 promise + permission.asked SSE + reply 端点 + option 映射
- [ ] 前端：permission 回复按 ACP/opencode 分流到对应端点
- [ ] 安全默认（超时/取消 → deny）

**验收**：claude 要写文件/执行命令时，弹 permission-dock，用户点 once/always/reject 生效；拒绝时 agent 收到 reject 不挂死。

---

## W4 · 能力协商 + 宿主 MCP 转发（条件 UI + 知识库可用）

**现状**：`acp-connection.ts:161` 只取 protocolVersion，**忽略 `agentCapabilities`**；`newSession` 永远 `mcpServers:[]`（`:185`）；prompt 永远只发 text（`:201`）。

**做法**：
- 读取 initialize 返回的 `agentCapabilities`（`loadSession`/`promptCapabilities.{image,audio,embeddedContext}`），存入 UnifiedAgent，前端按之**条件启用 UI**（不支持 loadSession 就不显示「恢复历史」，不支持 image 就禁图片输入）——对齐 agent-selector 的能力展示缺口（B.3）。
- `newSession` 传**宿主 MCP**（知识库 :4098 的 mcp-bridge 等），让外部 ACP agent 也能 `knowledge_search`（呼应 [013](./013-agent-os-acp-multi-backend.md) §7「宿主能力嫁接」；阶段1 可只做最小：把已配置的宿主 MCP 透传）。

**任务**：
- [ ] 解析并存储 agentCapabilities → UnifiedAgent
- [ ] agent-selector / 输入区按能力条件 gating
- [ ] newSession 透传宿主 MCP（最小：知识库）

**验收**：选到不支持 loadSession 的 agent 时 UI 不出现恢复入口；外部 agent 能调用知识库 MCP。

---

## W5 · 进程稳定性（移植 acpx 经验）

**现状**：`acp-connection.ts:509-513` 关闭仅 `process.kill()`（SIGTERM）；**无三阶段优雅关闭**；`CONNECT_TIMEOUT=15s` 只覆盖 initialize，`newSession`/`prompt` 无超时（`:182-205`）；**无 per-agent 怪癖**。已有：watchProcessExit、pending reject、update 顺序化。

**做法（对照 acpx 源码 `src/acp/client.ts` + `agent-command.ts`，常量可直接照搬）**：
- **三阶段关闭**（acpx `terminateAgentProcess` client.ts:1176）：`stdin.end()`（per-agent grace，默认 **100ms**，qoder **750ms**）→ `SIGTERM`（grace **1500ms** `AGENT_CLOSE_TERM_GRACE_MS`）→ `SIGKILL`（grace **1000ms**）→ `detachAgentHandles`（destroy stdin/stdout/stderr + 仍存活则 `unref()` 防挂住父进程）。
- **退出原因四分类 + `unexpectedDuringPrompt`**（acpx client.ts:154/1566）：`process_exit`/`process_close`/`pipe_close`/`connection_close` 四观察者**先到先记录去重**；`unexpectedDuringPrompt = !closing && Boolean(activePrompt)`（区分崩溃 vs 正常收尾）；退出即 reject 所有 pending。**Ultrawork 现有 watchProcessExit 是单点，应升级为四分类。**
- **per-agent 怪癖特判**（acpx `agent-command.ts` 精确值）：
  - **Claude**：`session/new` 已知 stall → `createSession` 包 **60s 超时**（`CLAUDE_ACP_SESSION_CREATE_TIMEOUT_MS`），超时抛 retryable 错误并提示 `--approve-all`；win32 解析 `CLAUDE_CODE_EXECUTABLE`。
  - **Gemini**：initialize 包 **15s 超时**（`GEMINI_ACP_STARTUP_TIMEOUT_MS`，OAuth 挂起兜底）+ 缺 `GEMINI_API_KEY/GOOGLE_API_KEY` 提示；`gemini --version`（**2s**）探测版本，`<0.33.0` 把 `--acp`→`--experimental-acp`。
  - **Copilot**：`copilot --help`（**2s**）预检输出含 `--acp`，否则抛 non-retryable `CopilotAcpUnsupportedError`。
  - **Qoder**：stdin grace 放宽 **750ms** + 过滤 benign stdout（`"Received interrupt signal…"`/`"Cleanup completed…"`）。
  - **Windows `.cmd/.bat`**：`shouldUseWindowsBatchShell()` → spawn 加 `shell:true`（Ultrawork `spawn` 当前无此处理，`:107-112`）。
  - ⚠️ **纠正 013/014 早期假设**：acpx 源码里**只有 qoder 有 stdout 过滤白名单，codex 没有**专门 stderr 过滤。
- **session replay 抑制**（acpx）：`session/load` 老会话时 `suppressReplayUpdates` + `waitForSessionUpdateDrain(idle 80ms / timeout 5s)`，避免把历史重放当新输出。**Ultrawork 做 loadSession（W4）时必须有此机制**，否则恢复会话会重渲染一遍。
- 健康检查从静态 `{status:ok}`（`acp-server.ts:24`）改为反映 agent 连接态。

**任务**：
- [ ] 三阶段优雅关闭（照搬 acpx 常量）
- [ ] newSession/prompt 超时 + Claude/Gemini/Copilot/Windows 特判
- [ ] /acp/health 反映真实连接态

**验收**：杀进程/agent 卡死/启动失败时能干净恢复、有明确错误，不留僵尸进程、不整窗卡死。

---

## 验收总表（以非 opencode agent 为准，逐个过）

| 维度 | claude code | gemini | qoder |
|------|------------|--------|-------|
| 流式文本/推理(Brain)/计划正确渲染 | ☐ | ☐ | ☐ |
| 工具调用 + input/output + diff + 失败标红 | ☐ | ☐ | ☐ |
| 最终答案正文显示（不被吞进折叠区） | ☐ | ☐ | ☐ |
| token/cost 统计页脚 + 回合正常收尾（不转圈） | ☐ | ☐ | ☐ |
| 权限弹窗工作（once/always/reject） | ☐ | ☐ | ☐ |
| 能力条件 UI（loadSession/image 正确启停） | ☐ | ☐ | ☐ |
| 进程异常可恢复、无僵尸 | ☐ | ☐ | ☐ |

> **任一非 opencode agent 任一行不达标 → 阶段1 未完成。** 可按 §013 §6.5 松绑：先把 claude + opencode 做满，即可并行启动档2 原型，再补 gemini/qoder。

---

## 风险与回滚

- **turn 整形是最大不确定点**：sidecar 拆「过程/答案 message」是否能让 `buildTurnModel` 正确显示，需早做端到端验证（建议 W1 第一步就拿 claude 跑通 1a，再做 1b）。
- **SDK 版本**：分支 pin `@agentclientprotocol/sdk 0.21.1` 但未实装；vendor 自带 0.16.1。落地前**先统一并实装 SDK 版本**，复核 `session/update` 变体与 `ToolCallStatus` 是否有新增。
- **权限同步 RPC 挂起**：挂起 promise 若无超时会卡死 agent，必须配 deny 默认。
- **回滚**：各 W 相对独立；W1/W3/W5 都在 sidecar 内，可 feature-flag。最坏回退到「auto-approve + 旧映射」（即分支现状）。

## 工作量（粗估，不含联调打磨）
- W0 re-baseline：1–2 天（冲突在 use-session-messages）
- W1 事件桥：3–5 天（核心，turn 整形 + 全量映射）
- W2 前端对接：0.5–1 天（多为验证）
- W3 权限：1.5–2 天（挂起回环 + 分流）
- W4 能力协商：1–2 天
- W5 进程稳定性：2–3 天（per-agent 怪癖最耗）
- 合计 ~9–15 天 + 三个 agent 逐个联调。

## 待决策
1. **D1 确认**：归一化放 sidecar（推荐）还是前端建 ACP 渲染器？
2. **首批做满哪 1–2 个 agent**：建议 claude + opencode（claude 是 adapter、生态最成熟）。
3. `feat/acp-support` 处置：rebase 合入（推荐）还是参考重写？
4. SDK 版本统一到哪个（0.21.x 实装 vs 跟 vendor 0.16.1）？
5. W4 宿主 MCP 透传范围：阶段1 是否只透传知识库，还是全部已配置 MCP？

## 信息缺口
- SDK 0.21.1 未实装，`session/update` 变体/`ToolCallStatus` 取自 vendor 0.16.1，落地前需对 0.21 复核。
- turn 整形能否让 `buildTurnModel` 正确切 process/answer，属推断，需端到端验证（最高优先级试点）。
- 分支 `assistant-message.tsx`(+130) 的 ACP 专属渲染未逐行展开（re-baseline 后由 main turn 渲染器取代，无需保留）。

### 来源
- **Ultrawork 现状**：`feat/acp-support` 分支 ACP 代码（`packages/agent/acp-client/src/acp-connection.ts` 等）+ main 渲染/权限层（`use-session-messages.ts`/`assistant-turn.tsx`/`execution-flow.tsx`/`use-session-permission.ts`/`permission-dock.tsx`）+ 专题记忆 `acp-branch.md`。
- **acpx 源码级参考**（github.com/openclaw/acpx，逐文件读）：`src/acp/client.ts`（三阶段关闭/退出分类/lifecycle）、`src/acp/agent-command.ts`（per-agent 怪癖常量）、`src/spawn-command-options.ts`（Windows shell）、`src/session/conversation-model.ts` + `src/runtime/public/events.ts`（session/update 映射）、`src/permissions.ts`（权限回环）、`src/agent-registry.ts`（registry）。W1/W5/W3 的具体常量与映射照此。
具体 file:line 见正文。
