# Ultrawork as Agent OS — 目标架构

> **状态**：设计基线（决策已拍板，作为开发起点）· 全档蓝图，首期启动档1
> **日期**：2026-06-08 · 2026-06-09 修订（新增 C4/C5 backend 分类法；§3.1/§3.3/TL;DR/§9 对齐 ADR-030 D-8 + discussion 015）
> **定位**：本文是**独立完备**的目标架构说明——把 Ultrawork 从「绑定 opencode 的桌面客户端」升级为「经 ACP 统一调度多个异构 agent 后端的 Agent OS」。读本文即可理解目标形态并启动开发，无需先读探索文档。
> **决策依据**：[ADR-027](./decisions/027-acp-multi-agent-backend.md)（ACP 多后端 + 三档模型）· [ADR-030](./decisions/030-agent-connector-control-layer.md)（@agent/connector 控制统一）· [ADR-031](./decisions/031-multi-agent-orchestration.md)（档2 delegate 编排）。探索过程见 [discussions/011-014](./discussions/)。
> **本文不替代 ADR**：ADR 记录「为什么这样决策」；本文记录「目标系统长什么样、怎么分阶段建」。冲突以最新 ADR 为准。

---

## TL;DR

1. **愿景**：一个客户端（Ultrawork）统一调度 opencode / claude code / qoder / gemini 等异构 agent 作后端，复用 ACP（Zed Agent Client Protocol，「编码 agent 界的 LSP」）生态。
2. **三档能力模型**：**档1 会话级**（一会话绑一 agent）→ **档2 delegate 编排**（orchestrator 拥有主对话、把子任务委派给其它 agent、交付物回卷）→ **档3 自动调度**（router 自动派单，远期）。**明确否决「对等换手」**（同对话对等 agent 逐轮透明换手——伪命题）。
3. **分层**：协议层（两传输族：`acp-stdio` + `product-native`〔opencode REST 等〕）→ **①渲染统一**（sidecar 把 ACP 事件翻译成公共事件模型）→ **②控制统一**（`@agent/connector` 后端无关控制面）→ **③编排层**（自建 orchestrator，消费 connector 原语）。
4. **backend 分类法**（C4/C5 · ADR-030 D-8 / 015）：`BackendKind` 开放，按「**协议族（ACP 标准 / 产品自有）× adapter**」建模，**两族对等**（轴是协议非线缆，WebSocket/HTTP 归 product-native 内）；选型按 **native + 保真 + 性能**（「支持 ACP 非二元」——hermes/qoder 原生富 ACP→零增量；openclaw 薄桥→黑盒低优先）。opencode = default + reference。
5. **首期启动档1**，但本文给出全档目标，确保分层「渲染统一→connector→编排」连贯递进、不返工。
6. **护城河仍在 ACP 之外**：国内 IM 深度（钉钉/微信）+ 本地 RAG（IMA 知识库）+ 中文桌面体验。ACP 多后端是能力扩展，不是差异化本身。

---

## 0. 决策基线（已拍板）

> 落地前的待决策项已逐条拍板。本表是开发的唯一事实源；后续若调整须改 ADR + 本表。

| # | 决策项 | 拍板结果 | 出处 |
|---|--------|---------|------|
| **战略** | | | |
| S1 | 要不要做升级 | ✅ 做，定位为**能力扩展**（护城河仍在 IM+RAG） | 013 §10-1 |
| S2 | opencode 走 REST 还是 ACP | **保持 REST**（不为统一牺牲集成深度），connector 双 backend 容纳 | ADR-027 D-1 |
| S3 | 是否同时做 ACP Server | **暂不做**（Ultrawork 只做 host/Client 链路） | 013 §10-6 |
| S4 | 目标雄心 / 文档范围 | **全档蓝图，首期启动档1** | 本次拍板 |
| **阶段1（档1）** | | | |
| B1 | 首批做满的 agent | **claude + opencode**（qoder/gemini 二期跟进） | ADR-027 待决1 |
| B2 | feat/acp-support 处置 | **参考其设计重写**（不 rebase 合入；在当前 main 上重建，保留 ADR-029 渲染器） | ADR-027 待决2 |
| B3 | ACP host SDK 版本 | 落地时 pin **最新 stable（≥0.21.x）**，复核 `session/update` 变体（与 vendor opencode 自带 0.16.1 无关——opencode 走 REST） | ADR-027 待决3 |
| B4 | 宿主 MCP 透传范围 | **仅知识库（:4098），默认关、显式 opt-in** | ADR-027 待决4 |
| **阶段2（connector）** | | | |
| C1 | 迁移顺序 | **OpenCodeBackend 等价层 → Desktop → Gateway → ACPBackend** | ADR-030 待决1 |
| C2 | queue-owner | **阶段2 只预留接口边界，实现留阶段3** | ADR-030 待决2 |
| C3 | 公共事件模型 | **沿用 opencode SSE 形状**，中立化留后续 | ADR-030 待决3 |
| C4 | backend 分类法 | **`BackendKind` 开放化 + 协议族（acp-stdio / product-native〔HTTP+SSE/WebSocket〕/ acp-remote）× adapter + 选型决策树（native+保真+性能）**；两族对等、轴是协议非线缆；opencode = default+reference；黑盒后端经 capabilities 降级 | ADR-030 D-8 / [015](./discussions/015-backend-taxonomy-non-acp.md) |
| C5 | openclaw / hermes / qoder 接入 | **hermes·qoder** 原生富 ACP → branch A（acp-stdio 通用，零增量，非首批；qoder 启动命令 `qoder acp` vs `qodercli --acp` 待实测锁定）；**openclaw** → branch C 黑盒、低优先、不进首批：对外三面（ACP 桥最差 < OpenAI HTTP < **WebSocket Gateway native 最富**），接哪面待实测 | [015](./discussions/015-backend-taxonomy-non-acp.md) |
| **阶段3（编排）** | | | |
| D1 | orchestrator 形态 | **独立包 `packages/core/orchestrator`**（connector 只做控制+事件） | ADR-031 待决1 |
| D2 | 首发模式 | **Pipeline 先做**（产物串接，确定性最强），Fan-out 紧随 | ADR-031 待决2 |
| D3 | delegate 工具可见性 | **仅「编排模式」opt-in 注入**（按需高级档） | ADR-031 待决3 |
| D4 | 子会话归属 | **MVP 懒加载**（展开拉历史），实时内联留后续 | ADR-031 待决4 |

---

## 1. 愿景与边界

### 1.1 是什么
当前 Ultrawork = opencode 作 agent loop + Tauri 客户端，**绑定单一后端**。目标是「**统一交互层 / Agent OS**」：把每个会话（或编排中的每个子任务）动态或指定地分配给不同的异构 agent，host 端渲染/交互/编排逻辑统一。

### 1.2 「OS」类比的精确边界
- opencode 的**内置 agent**（build/plan/general/explore）是**同一进程、同一对话历史**内的 persona 切换——切 `agent` 字段无缝，因为是「一个字段」。
- **claude / qoder / opencode 之间**是**完全独立的进程、独立 session、独立历史、独立工具集**——是「一套进程编排 + 上下文交接协议」。体验可对齐，机制根本不同。**这是全部架构结论的基础。**

### 1.3 三协议分层（别混用）
```
用户 ─[ACP]→ Agent ─[A2A]→ Agent ─[MCP]→ Tool
```
- **MCP**：Agent→工具（垂直）。
- **ACP-Zed**：Client→Agent（垂直，**只驱动单个 agent**）。Ultrawork 用它接 claude/qoder/gemini。
- **A2A**：Agent↔Agent（水平对等协作）。**ACP 不提供多 agent 编排**——编排层必须自建。

### 1.4 关键事实
- **opencode 是 ACP Server，不是 Client**：`opencode acp` 是把自己暴露给别人调；它自带的 `task` 工具只能派给**自家** general/explore，**派不出去**外部 claude/qoder。→ **跨厂商 orchestrator 必须 Ultrawork 自建**（正如 openclaw）。
- **ACP 覆盖**：会话/流式/工具/权限/文件编辑。**ACP 不覆盖**：IM 多渠道、知识库、非编码面板——这些是 Ultrawork 自己的层，恰是差异化所在。

---

## 2. 目标架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  可视化层：Desktop (Tauri+React)  ·  Gateway (钉钉/微信)        │
│  渲染：ADR-029 turn 渲染器（assistant-turn / execution-flow）   │  ← 统一，与后端无关
└───────────────────────────┬─────────────────────────────────┘
                            │ call(REST 语义) + subscribe(事件流)
┌───────────────────────────┴─────────────────────────────────┐
│  ② 控制统一：@agent/connector（packages/core/connector）       │  ← 阶段2
│     后端无关控制面 + 公共事件模型 + capabilities 声明           │
│     ┌──────────────────────┐   ┌──────────────────────────┐  │
│     │ OpenCodeBackend       │   │ ACPBackend                │  │
│     │ = ApiClient(REST)     │   │ = acp-client 前端 router  │  │
│     │   + SSEClient(事件)   │   │   + EventSource(事件)     │  │
│     └──────────┬───────────┘   └────────────┬─────────────┘  │
└────────────────┼──────────────────────────┼─────────────────┘
                 │ REST/SSE :4096            │ HTTP/SSE :4099
        ┌────────┴────────┐         ┌────────┴──────────────────────┐
        │ opencode sidecar│         │ ACP Client Sidecar :4099        │  ← 阶段1
        │ (二进制)         │         │ ① 渲染统一：ACP session/update  │
        └─────────────────┘         │   → 公共事件模型(==opencode形状) │
                                    │ + 进程生命周期 + per-agent 怪癖  │
                                    │   ┌──────┬───────┬──────┐       │
                                    │   │claude│gemini │qoder │…     │  ← ACP stdio 子进程
                                    │   └──────┴───────┴──────┘       │
                                    └─────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  ③ 编排层：orchestrator（packages/core/orchestrator）          │  ← 阶段3
│     消费 connector 原语 spawn/steer/await/cancel               │
│     delegate 语义 + 治理护栏 + 后台任务跟踪 + 回卷             │
└─────────────────────────────────────────────────────────────┘
```

> 图示首发两个 backend；**backend 类是开放的**（ADR-030 D-8 / §0 C4）——再接 agent = 注册新 adapter（原生 ACP 走 `acp-stdio` 复用整族；openclaw 等 `product-native` 走 WebSocket/HTTP bespoke），ACP Sidecar 框内的 claude/gemini/qoder 只是 acp-stdio 族示例。主架构不变。

**三个统一点，分阶段建，互不返工：**

| 统一点 | 内容 | 谁需要 | 落点 / 阶段 |
|--------|------|--------|------------|
| ① 渲染统一 | 所有后端产出渲染器要的 message/part/turn 模型 | 档1 够用 | **sidecar**（阶段1） |
| ② 控制统一 | 后端无关编程接口 `prompt/subscribe/cancel/createSession` | 档2/3 必需 | **@agent/connector**（阶段2） |
| ③ 编排 | spawn 拓扑 / delegate / dispatch | 档2/3 | **orchestrator**（阶段3） |

> 阶段1 在 wire 层把 ACP 归一成公共事件模型 → 阶段2 引入 connector 收编控制面 → 阶段3 编排建在 connector 原语之上。**连贯递进，非返工。**

---

## 3. 分层详解

### 3.1 协议层
后端按**两传输族**接入（ADR-030 D-8 / §0 C4），详见 §3.3：
- **opencode**（`product-native`，HTTP+SSE，**default + reference**）：继续走 **REST/SSE :4096**（已深度集成 permission/question/file，见 ADR-002/008）。**不改走 ACP。**
- **原生 ACP agent**（`acp-stdio`）：claude/qoder/gemini/hermes 等，**ACP（JSON-RPC 2.0 over stdio）**，host 端 TypeScript SDK（pin ≥0.21.x，protocolVersion 稳定=1）；每 agent = 一个 stdio 子进程，配置 `agent name → 命令 + args + env`（`~/.config/ultrawork/agents.json`）。**一个通用 adapter 复用整族。**
- **其它 `product-native`（非 ACP）**：产品自有协议，线缆 HTTP+SSE 或 WebSocket（如 openclaw 的 **WebSocket Gateway**、hermes-HTTP），每产品一个 bespoke adapter，按需接入（C5）。**外部 agent ≠ 必走 ACP。**
- **ACP 核心模型**：`initialize`（能力协商）→ `session/new`（传 cwd + MCP servers）/ `session/load`（重放该 agent 自己的历史）→ `session/prompt` → 流式 `session/update`（`agent_message_chunk`/`agent_thought_chunk`/`plan`/`tool_call`+`tool_call_update`/`usage_update`）→ `StopReason` 结束 → `session/request_permission`（同步 RPC，host 弹给用户）。

### 3.2 ① 渲染统一 — sidecar 事件桥（ADR-027 D-3）
**判据**：sidecar 发出的 SSE「长得和 opencode 自己发的一模一样」，前端无从区分来源，**复用 ADR-029 的 turn 渲染器**，前端改动最小。

- **turn 整形（最关键）**：ACP 一整轮挂一条 message 会让 `buildTurnModel` 把答案埋进折叠区。须模仿 opencode「N-message/回合」：过程步骤发**过程 message**、最终文本发**独立答案 message（仅 text）**、回合结束发 `message.updated` 带 `info.finish`（否则最后一轮永远转圈）。
- **映射修全**：`agent_thought_chunk`→显式 `type:"reasoning"` part；`tool_call` 补 `callID/input/kind/title`；`tool_call_update` 按 `toolCallId` upsert（`failed`→`error`）；`usage_update` 填 token/cost；`ToolCallStatus` 全集 `pending/in_progress/completed/failed`。
- **参考**：acpx 仓库 `acpx/src/session/conversation-model.ts`（`SESSION_UPDATE_HANDLERS`）已把这套做完，可照搬归一化逻辑（**注意 B2：参考重写，不复制分支旧代码**）。

### 3.3 ② 控制统一 — @agent/connector（ADR-030）
新增包 `packages/core/connector`，定义后端无关控制面，下挂可插拔 backend adapter。**包装而非取代** api-client。**backend 类是开放的**（`BackendKind` 非封闭 union，见 §0 C4 / ADR-030 D-8 的「传输族 × adapter」分类法）；首发两个 backend：

- **OpenCodeBackend**（传输族 `product-native`，线缆 HTTP+SSE，**default + reference**）= 包装现有 `ApiClient`（REST）+ `SSEClient`（事件），REST 路径不变。公共事件模型即其 SSE 形状（C3）。
- **ACPBackend**（传输族 `acp-stdio`，**一个 adapter 复用整族**）= 包装 **重写后** 的 acp-client 前端 router（**B2 决策：不复用 `feat/acp-support` 分支的 router，在当前 main 上参考重建**）+ EventSource。claude/qoder/gemini/hermes 等原生 ACP agent 共用它。
- **两族对等**：`acp-stdio`（ACP 标准，一个 adapter N agent）与 `product-native`（产品自有，线缆 HTTP+SSE 或 WebSocket，每产品一个 adapter）并列，无主从——轴是「协议」非「线缆」。
- **未来扩展**：再接 agent = 注册新 adapter，按决策树选（原生富 ACP→acp-stdio；产品平台/黑盒如 openclaw→product-native，**走其 native 线缆**——openclaw 即 WebSocket Gateway——或降级 acp-stdio，capabilities 降级）。主架构不变。

- **核心公共面**（两 backend 都实现）：`createSession / prompt / cancel / revert / subscribe / listAgents / status`。
- **能力声明** `capabilities`（不做最小公约数阉割）：消费方按 `capabilities` 条件调用 backend-specific 方法（`getProviders/getMCP/getFileTree` 仅 opencode；`agentConfig CRUD/connect` 仅 ACP）。
- **吸收三套 SSE 重复**：连接配置 + 鉴权 header（Basic Auth + `x-opencode-directory`）、心跳看门狗、指数退避重连、事件类型联合解析、sessionID 过滤——收敛到 connector 的 `subscribe()`，不再各端手写。
- **会话级 backend 绑定（D-4）**：`bindSession(sessionId, kind)`，消费方只调 `connector.prompt(sessionId, ...)`，由 connector 派发到对应 adapter。

```ts
type TransportFamily = "acp-stdio" | "product-native" | "acp-remote"   // D-8；product-native 线缆 = HTTP+SSE | WebSocket
type BackendKind = string   // 开放注册（opencode/acp/openclaw/hermes…），非封闭 union
interface BackendCapabilities { providers; mcp; file; agentCrud; loadSession; image;
  permissions; fileDiffs; plan; reasoning; historyReplay }   // 黑盒后端把对应项声明 false

interface AgentBackend {                       // 可插拔 backend 边界（acpx 模型）
  readonly kind: BackendKind
  readonly capabilities: BackendCapabilities
  createSession(opts): Promise<SessionRef>
  prompt(sessionId, message, opts?: {agent?; model?}): Promise<void>
  cancel(sessionId): Promise<void>
  revert?(sessionId, messageID): Promise<void>
  subscribe(sessionId, handler:(e:AgentEvent)=>void): Unsubscribe   // 统一事件
  listAgents(): Promise<UnifiedAgent[]>
  status(): ConnectionStatus
  // backend-specific（按 capabilities 暴露）
}

interface Connector {
  registerBackend(b: AgentBackend): void
  bindSession(sessionId, kind: BackendKind): void
  prompt(sessionId, msg, opts?): Promise<void>
  subscribe(sessionId, handler): Unsubscribe
  cancel(sessionId): Promise<void>
  onStatusChange(cb): void; onError(cb): void
  // 阶段3 用：原语 + 可选 queue-owner（连接复用/排队，C2 留阶段3）
}
```

**范围边界（D-7，明确不做）**：connector **只做控制+事件**。不含记忆/工作区注入（归 P1-2，connector 只提供 `onSessionCreate` 挂载时机）、不含编排（归 orchestrator）。

### 3.4 ③ 编排层 — orchestrator（ADR-031，独立包）
`packages/core/orchestrator`，消费 connector 原语，实现 delegate 语义。

- **delegate 机制 = 子会话 + 子任务 prompt + 交付物契约**（非 transcript 注入）：
  1. orchestrator 拥有主对话（canonical），用户与之交互。
  2. delegate 时经 `connector.createSession`（目标 backend + 指定 cwd）→ 子会话。
  3. 交接的是**明确子任务 prompt + 引用产物/文件路径**（不是塞主对话历史）。
  4. 子会话跑完，取**交付物**（最终 text / 写出文件）回卷给父；中间过程不进父上下文（对齐 opencode `<task_result>`）。
  5. **保真度边界（诚实标注）**：父只见交付物、不见子的推理/diff——UI 须表达「子 agent 交回成果、非全过程」。
- **delegate 工具**（经宿主 MCP bridge，仅 opt-in 编排模式注入，schema 借鉴 openclaw `sessions_spawn`）：
  ```
  delegate(agentId, task, cwd?, model?, deliverable?:"text"|"file", timeoutMs?, tokenBudget?)
    -> { deliverable, sessionId, tokens, cost }
  ```
- **混合驱动**：已知固定模式（PR review pipeline）走**代码驱动 workflow recipe**（可复现可调试）；开放任务走 **agent 驱动 delegate**（灵活）。
- **首发模式（D2）**：**Pipeline**（A→B→C，上一步输出文件作下一步输入）先做；**Fan-out**（1 planner→N worker 并行，独立 cwd/worktree）紧随。Supervisor/Debate 作组合留后续；**Swarm 走 A2A，不在范围**。

### 3.5 Gateway × 多 agent（IM 流式适配）
Gateway（钉钉/微信）与 Desktop 共用同一条控制链路（经 connector），但 IM 渠道的**流式形态不同**——不能像桌面那样逐 chunk 刷新，须把 ACP/opencode 的细粒度流合并成「块」再下发，否则 IM 消息会被刷屏。

- **会话↔agent 绑定**：IM 一轮消息要派给某 agent 时，Gateway 走与 Desktop **同一套** `connector.bindSession` 路由抽象，不另写一套。
- **流式合并（接 P1-1）**：把 `agent_message_chunk` 经 block 合并再下发——参数量级对齐 openclaw 实证：`coalesceIdleMs ≈ 300` + `maxChunkChars ≈ 1200`（013 §7）。这层在 connector 之上、Gateway 侧实现，对 backend 透明。
- **权限/question**：保留 Gateway 现有轮询兜底语义（ADR-008），由 connector 完整透传，避免 IM 侧权限自动应答回退（ADR-030 风险项）。

---

## 4. 端到端数据流

### 4.1 档1 单会话（外部 agent，如 claude）
```
用户输入 → connector.prompt(sessionId)
  → ACPBackend → ACP Sidecar:4099 → session/prompt → claude 子进程
  → claude 流式 session/update → sidecar 归一化成 opencode SSE 形状
  → connector.subscribe handler → handleSSEEvent（唯一实现）
  → ADR-029 buildTurnModel 切 process/answer → 渲染
权限：claude 发 request_permission(同步RPC) → sidecar 挂起 promise + permission.asked SSE
  → permission-dock → POST /acp/session/:id/permission → resolve
```

### 4.2 档2 delegate（如 opencode 主对话委派 claude 子任务）
```
主 agent 调 delegate(claude, task, cwd) [经宿主 MCP bridge]
  → orchestrator.spawn → connector.createSession(kind:acp, cwd)
  → 子会话异步后台跑（非阻塞父回合）
  → 进度 streamTo:parent 回流为 system event
  → 子会话完成 → 取交付物 → 作为 delegate 工具结果回卷给父
  → UI：主对话出现 delegate 卡片（targetAgent + 子任务），归入 ADR-029 ExecutionFlow
       展开 = 懒加载拉子会话历史（D4）
父干预（ADR-031 D-6）：跑动中父可 steer(中途纠偏) / cancel(终止) 子会话；子失败不挂死父对话
治理：maxConcurrent(~8) / maxDepth(1，禁子 agent 再 delegate) / token 预算 + 超时
```

---

## 5. 能力模型（三档）

| 档 | 是什么 | 机制 | 状态 |
|----|--------|------|------|
| **1 会话级** | 一会话绑一 agent | `connector.bindSession` | **首期目标**（深水区在异构归一化，非接通） |
| **2 delegate 编排** | orchestrator 拥主对话，委派子任务，交付物回卷 | 父→子 session + 显式产物交接 | 阶段3，独立 ADR-031 |
| **3 自动调度** | router 自动决定派给谁 | 身份路由（确定性链）+ 任务委派（LLM 意图） | 远期阶段4 |

**否决「对等换手」**（同对话对等 agent 逐轮透明换手）：业界无人造、ACP/A2A 不支持、有损且不可归因——伪命题。delegate 的「有损」也存在（父只见交付物），但发生在**干净契约接口**上，可接受。

---

## 6. 安全与治理护栏

- **权限**：去掉自动批准；ACP `request_permission` → 挂起 promise + SSE → permission-dock → 回复端点；option kind（allow_once/always/reject）映射 dock 按钮；**超时/取消默认 deny**。
- **路径沙箱**：readTextFile/writeTextFile CWD 沙箱（`validatePath`）。
- **宿主工具暴露**：默认关、显式 opt-in；首期仅知识库 :4098（B4）。外部 agent 是任意第三方进程，最小暴露面。
- **编排护栏（ADR-031 D-5，必须先行）**：`maxConcurrent`（默认 ~8）、`maxDepth`（默认 **1**，禁递归 delegate）、子 agent 模型可配更便宜、子 toolset 默认收紧、每 delegate 带 token 预算 + 超时。
- **进程稳定性**：三阶段关闭（`stdin.end()` grace → SIGTERM 1500ms → SIGKILL 1000ms → detach+unref）；退出四分类 + `unexpectedDuringPrompt`；per-agent 怪癖（Claude `session/new` 60s 超时；Gemini OAuth 挂起；Windows `.cmd/.bat`→`shell:true`）。

---

## 7. 路线图

| 阶段 | 内容 | 依赖 | 验收 |
|------|------|------|------|
| **0 · 重写基线** | **参考 feat/acp-support 设计，在当前 main 上重建**（B2）：ACP Sidecar :4099 / UnifiedAgent / agent-selector / agents.json / auto-connect。**保留 ADR-029 渲染器**，不回退 chat 重构。 | — | 协议管道在 main 上重新跑通（opencode + claude 可连） |
| **1 · 档1 异构归一化** | 渲染归一化（sidecar 事件桥，§3.2）+ 交互归一化（权限/能力协商）+ 进程稳定性。**首批 claude + opencode**（B1）。 | 阶段0 | **以非 opencode agent 为准**：claude 流式/推理/计划/工具/diff/答案/token 页脚/权限弹窗/进程恢复**全过**；只验 opencode 不算完成 |
| **2 · @agent/connector** | 建包 + OpenCodeBackend 等价层 → Desktop 收敛(16 个 useApi) → Gateway 收敛 → ACPBackend 收编（C1）。三套 SSE→一处。宿主 MCP 透传（知识库，opt-in）。 | 阶段1 | 全部后端调用经 connector；切 backend 对上层透明；Gateway 复用 connector；暴露 spawn/prompt/cancel/subscribe 原语 |
| **3 · 档2 编排** | 独立包 orchestrator（D1）；原语层（spawn/await/steer/cancel + 治理护栏）→ agent 驱动 delegate（opt-in，D3）→ UI 嵌套懒加载（D4）→ **Pipeline 先**（D2）→ Fan-out。 | 阶段2 | 主 agent 能 delegate 给外部 backend，交付物回卷、UI 可见嵌套、护栏生效；一个 Pipeline recipe 端到端；Fan-out worktree 隔离 |
| **4 · 档3 自动调度** | router（规则/LLM）自动派单，用户可覆盖。 | 阶段3 | 远期研究 |

---

## 8. 开发起点（立即可做 — 阶段0→1，claude + opencode）

> 首期不必等所有 agent 档1 完工——**先把 claude + opencode 归一化做扎实**即可（这俩正是档2 编排原型的最小组合，§6.5）。

1. **阶段0 重写**：在当前 main 上新建 `packages/agent/acp-client`（ACP Sidecar :4099），参考 feat/acp-support 的 sidecar/UnifiedAgent/agents.json 设计**重写**（不 cherry-pick 旧渲染器代码）；接入 SDK ≥0.21.x。
2. **W1 turn 整形（最关键、风险最高）**：sidecar 把 claude 的 `session/update` 整形为「过程 message + 独立答案 message + finish 终态」。**第一步就端到端验证 `buildTurnModel` 能正确切 process/answer**——这是全局最大不确定点。
3. **W1 映射修全**：reasoning / tool_call / tool_call_update upsert / usage_update / ToolCallStatus 全集。
4. **W3 权限归一化**：去 auto-approve，接 `request_permission` → permission-dock 回环。
5. **W4 能力协商**：读 `initialize.agentCapabilities` 条件启用 UI；`session/new` 透传知识库 MCP（opt-in）。
6. **W5 进程稳定性**：移植 acpx 三阶段关闭 + claude per-agent 怪癖（`session/new` 60s 超时）。
7. **逐 agent 验收**：claude 全链路达标后，再扩 qoder/gemini。

**关键文件锚点**（重写时对照，见 [ADR-027 实现章节](./decisions/027-acp-multi-agent-backend.md) + [discussions/014](./discussions/014-stage1-acp-normalization-plan.md)）：
- sidecar 事件桥：`acp-connection.ts` `handleSessionUpdate`（映射核心）
- turn 渲染：`assistant-turn.tsx` `buildTurnModel`、`message-list.groupIntoTurns`（ADR-029）
- 前端消费：`use-session-messages.ts` `handleSSEEvent`
- 权限：复用 `permission-dock`

---

## 9. 风险 / 竞合 / 信息缺口

### 风险
- **turn 整形**能否让 `buildTurnModel` 正确切 process/answer = 最大不确定点，阶段1 第一步必须端到端验证。
- **per-agent 怪癖**：统一 spawn 路径会被边角击穿（Claude stall / Gemini OAuth / Windows shell）——直接移植 acpx 处理。
- **保真度预期**（档2）：跨厂商委派父只见交付物，UI 须明确标注，别让用户以为「无缝接管」。
- **维护面**：每接一 agent 多一套版本/认证/怪癖——靠 `agent name→命令` registry 而非专用 connector，降边际成本。

### 竞合
**AionUi**（开源 Electron 多-agent 桌面，[discussions/016](./discussions/016-aionui-multi-agent-competitor.md)）是**形态最贴的竞品**——已 ship 档1（并行多后端）+ 档2（Team Mode 编排），且其 `NON_ACP_BACKENDS` 路由与本架构 D-8 一字不差。此外 Jockey（Tauri+ACP）、openclaw+acpx（已覆盖飞书/钉钉/企业微信 Channel）、Zed/JetBrains 都在做通用 ACP host。**含义：档1/档2「调度多 agent + 跨厂商编排」本身已是追平项、非护城河**（可大胆借鉴其已验证范式提速）；**差异化必须靠 ACP 之外**：钉钉/微信深度 + IMA 知识库 + 本地 RAG + 中文场景（AionUi 等竞品均空白）。「又一个能接 claude code 的壳」无护城河。

### 信息缺口（落地前实测）
> openclaw/hermes/qoder 三家接入调研见 [discussions/015 §11](./discussions/015-backend-taxonomy-non-acp.md)（均 desk research，真·实测待落地前做）。
- **qoder 启动命令两源不一**（Zed `qoder acp` vs Qoder 文档/acpx `qodercli --acp`，含二进制名 `qoder`/`qodercli`）+ slash 透传，须实机 `--version`/`--help` 锁定（015 §4.4 已定性 branch A 原生富 ACP）。
- **openclaw 接哪面待实测**：对外三面（ACP 桥 / OpenAI HTTP / WebSocket Gateway native），各面 agent-event 粒度（diff/plan）未运行验证（015 §3.4/§11）。
- ACP 远程（HTTP/WS）传输 WIP——目前多后端只能本地 stdio 子进程（桌面 OK，远程/移动需另想）。
- ACP host SDK ≥0.21.x 的 `session/update` 变体须落地前复核。

---

## 附：相关文档

- 决策：[ADR-027](./decisions/027-acp-multi-agent-backend.md) / [ADR-030](./decisions/030-agent-connector-control-layer.md) / [ADR-031](./decisions/031-multi-agent-orchestration.md)
- 探索：[011 横向对标](./discussions/011-architecture-comparison.md) / [012 P1 执行](./discussions/012-p1-execution-plan.md) / [013 Agent OS 可行性](./discussions/013-agent-os-acp-multi-backend.md) / [014 阶段1 实现底稿](./discussions/014-stage1-acp-normalization-plan.md)
- 现状架构：[architecture-phase1.md](./architecture-phase1.md)（Part II 含 connector 草案，被 ADR-030 修正）
- 渲染基线：ADR-029（执行流程回合分组）
