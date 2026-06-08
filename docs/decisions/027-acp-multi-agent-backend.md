# ADR-027: ACP 多 Agent 后端支持 — 经 Agent Client Protocol 统一调度多 agent

**状态**: Accepted（架构决策）· 实现规划中（阶段1 待 re-baseline 落地）
**日期**: 2026-05-25（编号预留）· 2026-06-08（正式化 + 实现规划）
**关联**: ADR-002 (OpenCode Headless Sidecar), ADR-005 (Permission & Question Dock), ADR-026 (知识库架构), ADR-028 (sidecar 副本/进程清理), ADR-029 (执行流程回合分组)
**探索来源**: [discussions/013](../discussions/013-agent-os-acp-multi-backend.md)（架构可行性 + 三档模型）· [discussions/014](../discussions/014-stage1-acp-normalization-plan.md)（阶段1 实现方案）
**分支**: `feat/acp-support`（28 commit MVP，未合并 main，需 re-baseline）

---

## 背景

### 问题与愿景
Ultrawork 当前 = opencode 作 agent loop + Tauri 客户端，**绑定单一后端**。愿景是把 Ultrawork 升级为「**统一交互层 / Agent OS**」：既用 opencode，也能用 claude code / qoder / gemini 等支持 **ACP（Zed Agent Client Protocol）** 的 agent 作后端，由客户端动态或指定地把会话/任务分配给不同 agent。

### 协议选型背景
- **ACP**（Zed 主导，Apache-2.0，JSON-RPC 2.0 over stdio，「编码 agent 界的 LSP」）专为「一个 host 统一驱动多个异构 coding agent」设计。**opencode 原生支持**（`opencode acp`）、qoder CLI / gemini CLI 原生、claude code 经官方 adapter、20+ agent 可接；host 端有 TS/Rust SDK。
- 区分：ACP = Client↔Agent（驱动单个 agent）；**多 agent 对等编排属 A2A + 编排层**，ACP 不管（详见 discussions/013 §4.x）。

### 现状（feat/acp-support 分支）
分支已实现 MVP（ACP Client Sidecar :4099、`UnifiedAgent` 抽象、agent-selector、agents.json、auto-connect），但：
- **管道通，归一化未完成**：opencode 后端体验正常，**非 opencode agent 的结果渲染 + 交互仍有大量问题**（事件映射不全、权限 auto-approve、无优雅关闭）。
- **基于 ADR-029 之前的旧渲染器**（删了 main 的 `assistant-turn/execution-flow`），与当前 main 漂移，**需 re-baseline**。

---

## 决策

### D-1 · 采用 ACP 作为多后端协议，opencode 保留 REST
采用 ACP 接入外部 agent；**opencode 继续走 REST/SSE**（已深度集成 permission/question/file），**不**为「统一」改走 ACP（会丢集成深度）。`UnifiedAgent` 抽象同时容纳「opencode-REST」与「ACP」两类后端。

### D-2 · 三档能力模型，放弃「对等换手」
```
档1 会话级（挑一个 agent） → 档2 delegate/编排（父→子委派 + 原语） → 档3 自动调度
```
- **档1**：一个会话绑一个 agent（类 openclaw bindings）。
- **档2**：orchestrator 拥有主对话，把**子任务**委派给其它 agent，结果以**交付物契约**回卷；多个委派组成 Fan-out/Pipeline/Supervisor/Debate 等拓扑（**这些不是内置设施，是用原语 emergent 的**）。
- **档3**：router 自动决定派给谁（远期）。
- **明确否决「对等换手」**（同一对话历史里对等 agent 逐轮透明换手）——业界无人造、ACP/A2A 不支持、有损且不可归因，是伪命题。

### D-3 · 归一化放在 sidecar（不另建前端 ACP 渲染器）
sidecar 把 ACP `session/update` **忠实翻译成 Ultrawork 公共事件模型（当前 == opencode SSE 形状）**，**复用 main 的 ADR-029 turn 渲染器**。判据：sidecar 发出的 SSE「长得和 opencode 自己发的一模一样」，前端无从区分来源。否决「前端建独立 ACP 渲染器」（双轨维护、体验漂移）。

### D-4 · 分层：渲染统一（阶段1）→ 控制统一 connector（阶段2）→ 编排（档2/阶段3）
- **①渲染统一**（事件模型）= 阶段1 在 sidecar 做，档1 够用。
- **②控制统一**（后端无关的 `prompt/subscribe/cancel/delegate/steer` 接口）= **`@agent/connector`**（架构 Part II 规划），阶段2 引入，阶段3 编排依赖。
- 照搬 openclaw/acpx 的**可插拔 backend** 分层：协议适配 + 子进程生命周期封装成 backend，只暴露 spawn/steer 原语；编排逻辑在上层。

### D-5 · 先档1 后档2（依赖关系，非偏好）
档1 拆两层：**①协议/进程基座**（驱动 + 读取每个 agent）对档2 **硬前置**——驱动不了/读不懂的 agent 无法编排；**②UI 表层**对「可发布、可诊断的档2」必须，但**可只先做要编排的 1–2 个 agent**（建议 claude + opencode），与档2 原型并行。

---

## 实现章节（阶段1 = 档1 单 agent 异构归一化）

> 完整任务级细节见 [discussions/014](../discussions/014-stage1-acp-normalization-plan.md)。本章节为决策级摘要。
> **目标判据**：claude code / gemini / qoder **逐个**「结果正确渲染 + 交互（权限/能力）正常 + 进程稳定」。**只验 opencode 不算完成。**

### W0 · re-baseline（前置）
把 `feat/acp-support` rebase 到当前 main，**保留 ADR-029 turn 渲染器**（放弃分支对 `assistant-turn/execution-flow/message-list` 的回退）；保留与渲染无关的 `agent-types/use-agents/agent-context/agent-router/use-acp-sse/acp-client sidecar/agent-selector/agents-section`；解决 `use-session-messages.ts` 合并冲突。

### W1 · sidecar 事件桥归一化（核心）
`acp-connection.ts:355-455 handleSessionUpdate` 当前把整轮挂单条 message、映射不全。
- **1a turn 整形（最关键）**：ACP 整轮挂一条 message → `buildTurnModel`（`assistant-turn.tsx:53`）见含 tool part → **答案被埋进折叠区**。须模仿 opencode「N-message/回合」（ADR-029）：过程步骤发**过程 message**、最终文本发**独立答案 message（仅 text）**、回合结束发 `message.updated` 带 `info.finish`（当前**无终态事件 → 最后一轮永远转圈**）。
- **1b 映射修全**：`agent_thought_chunk`→显式建 `type:"reasoning"` part（当前降级为文本）；`tool_call` 补 `callID/input/kind/title`；`tool_call_update` 按 `toolCallId` upsert（修覆盖 bug）、`failed`→`error`；`usage_update` 填 token/cost；`ToolCallStatus` 全集 `pending/in_progress/completed/failed`。
- **参考**：acpx `src/session/conversation-model.ts`（`SESSION_UPDATE_HANDLERS`）已把这套做完，`tool_call`/`tool_call_update` 同一 `applyToolCallUpdate` upsert、token snake/camel 归一可几乎照搬。

### W2 · 前端渲染对接（最小）
W1 发「opencode 形状」后前端基本无需改；仅补 `use-session-messages.ts:311-321` 的防御缺口（delta 先到时按 `type` 建 part，不硬编码 text）。

### W3 · 权限归一化
去掉 auto-approve（`acp-connection.ts:315`）。ACP `request_permission` 是同步 RPC → 建「挂起 promise + `permission.asked` SSE + `POST /acp/session/:id/permission` 回复端点」回环，复用 `permission-dock`；option `kind`(allow_once/always/reject) 映射 dock 按钮；**超时/取消默认 deny**。参考 acpx `src/permissions.ts`（host 回调 + 三段式解析）。

### W4 · 能力协商 + 宿主 MCP 转发
读 `initialize` 的 `agentCapabilities`（loadSession/promptCapabilities）→ 条件启用 UI；`newSession` 透传宿主 MCP（最小：知识库 :4098），让外部 agent 可 `knowledge_search`；loadSession 须加 replay 抑制（acpx：idle 80ms / timeout 5s）避免历史重渲染。

### W5 · 进程稳定性（移植 acpx 常量）
- **三阶段关闭**：`stdin.end()`（grace 100ms，qoder 750ms）→ SIGTERM（1500ms）→ SIGKILL（1000ms）→ detach+unref。
- **退出四分类 + `unexpectedDuringPrompt`**（`!closing && activePrompt`）。
- **per-agent 怪癖**：Claude `session/new` 60s 超时；Gemini initialize 15s 超时 + `--version` 2s 探测（<0.33.0 用 `--experimental-acp`）；Copilot `--help` 2s 预检；Qoder 750ms + benign stdout 过滤；Windows `.cmd/.bat` → `shell:true`。

### 阶段1 验收（以非 opencode agent 为准，逐个）
流式文本/推理(Brain)/计划渲染、工具 input/output/diff/失败标红、最终答案正文显示、token/cost 页脚 + 回合收尾不转圈、权限弹窗、能力条件 UI、进程异常可恢复无僵尸——**claude/gemini/qoder 各自全过才算完成**。

### 后续阶段（本 ADR 框定方向，细节另立实现 ADR）
- **阶段2**：引入 `@agent/connector`（控制统一，照搬 acpx backend-plugin + queue-owner 骨架）；Gateway 支持选 agent；宿主能力反向暴露（内置 MCP，默认关）。
- **阶段3（档2）**：自建跨厂商 orchestrator（opencode 当不了，它是 ACP Server），只暴露 spawn/steer 原语；先支持 Pipeline/Fan-out；UI 呈现嵌套委派（接 P1-3 task 卡片）。
- **阶段4（档3）**：自动调度 router。

---

## 考虑过的替代方案

| 方案 | 否决理由 |
|------|---------|
| **前端建独立 ACP 渲染器**（vs D-3 sidecar 归一化） | 与 opencode 渲染双轨维护、体验漂移；ADR-029 turn 渲染器已成熟，应复用 |
| **opencode 也改走 ACP 以「统一」** | 丢掉现有 REST 深度集成（permission/question/file）；无收益 |
| **对等换手**（同一对话多 agent 逐轮换手） | 业界无人造、ACP/A2A 不支持、有损且不可归因——伪命题 |
| **靠 opencode 自带 subagent 当跨厂商编排器** | opencode 是 ACP **Server**，只能派自家 general/explore，派不出去外部 claude/qoder |
| **直接合并 feat/acp-support 分支** | 基于 ADR-029 之前旧渲染器，直接合并会回退 main 的 chat 重构；必须 re-baseline |
| **把 ACP 翻译逻辑放前端/connector（vs sidecar）** | 阶段1 放 sidecar 最省（wire 已归一、Gateway 也能直接消费）；阶段2 connector 再收敛控制层即可，不冲突 |

---

## 后果

### 正面
- 解锁「一个客户端调度多个异构 agent」，且复用 ACP 生态（opencode/claude/qoder/gemini/codex…即插即用，靠 `agent name→命令` registry）。
- 复用 ADR-029 渲染器 + 现有 permission-dock，前端改动最小。
- 分层清晰（渲染统一→connector→编排）为档2/3 留出连贯演进路径，不返工。
- opencode 路径零影响（仍走 REST）。

### 负面 / 成本
- 阶段1 工作量集中在 sidecar 事件桥（~9–15 天 + 三 agent 逐个联调）；per-agent 怪癖维护面随接入 agent 数增长。
- 「控制统一 connector」与「跨厂商 orchestrator」是真实增量投入（opencode 不提供）。
- 重二进制 sidecar 之外再加 ACP 子进程，进程/资源管理复杂度上升。

### 风险
- **turn 整形**能否让 `buildTurnModel` 正确切 process/answer = 最大不确定点，须 W1 第一步端到端验证。
- **SDK 版本**：分支 pin `@agentclientprotocol/sdk 0.21.1` 未实装（vendor 自带 0.16.1），落地前须统一并复核 `session/update` 变体。
- **战略竞合**：Jockey（Tauri+ACP）、openclaw+acpx 已在做通用 ACP host；Ultrawork 差异化须靠 ACP **之外**的层（国内 IM 深度 + 本地 RAG + 中文场景），而非「又一个能接 claude code 的壳」。

### 待决策（落地前拍板）
> ✅ **已全部拍板（2026-06-08）**，结果见 [`agent-os-target-architecture.md`](../agent-os-target-architecture.md) §0 决策基线表（B1-B4）。
1. 首批做满哪 1–2 个 agent → **claude + opencode**（qoder/gemini 二期）。
2. `feat/acp-support` rebase 合入 vs 参考重写 → **参考重写**（在当前 main 上重建，保留 ADR-029 渲染器）。
3. SDK 版本统一到 0.21.x 还是跟 vendor 0.16.1 → **pin 最新 stable ≥0.21.x**（host SDK 与 vendor 自带 0.16.1 无关，opencode 走 REST）。
4. W4 宿主 MCP 透传范围 → **仅知识库（:4098），默认关、显式 opt-in**。
