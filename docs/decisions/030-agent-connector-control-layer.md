# ADR-030: @agent/connector — 后端无关的控制 + 事件统一层（OpenCode REST + ACP 双 backend）

**状态**: Accepted（架构决策）· 实现规划中（阶段2，依赖阶段1/ADR-027 落地）
**日期**: 2026-06-08
**关联**: ADR-002 (OpenCode Headless Sidecar), ADR-008 (SSE 全局化 + 轮询兜底), ADR-013 (Channel Gateway Sidecar), ADR-027 (ACP 多 Agent 后端支持)
**取代/细化**: `docs/architecture-phase1.md` Part II「连接抽象 @agent/connector」草案（修正其两处缺陷，见下）
**探索来源**: [discussions/013](../discussions/013-agent-os-acp-multi-backend.md) §6.6（控制统一 + 可插拔 backend）

---

## 背景

### 现状：后端耦合逻辑在三处重复
ADR-027 D-4 把 ACP 落地分为「①渲染统一（阶段1，sidecar）→ ②控制统一（阶段2，本 ADR）→ 编排（阶段3）」。阶段1 只让 ACP 事件「长得像 opencode」；但**前端/Gateway 对后端的控制调用仍各写各的**。盘点（file:line 见 discussions 调研）：

- **api-client 是纯 REST**（`packages/core/api-client/src/client.ts`，~35 个方法）；**SSE 不在其中**，由三套独立实现承担：Desktop `sse-client.ts`（fetch-reader）、Gateway `bridge.ts:320-391`（fetch-reader）、ACP 分支 `use-acp-sse.ts`（EventSource）。
- **Basic Auth + `x-opencode-directory` header 手写三份**（`client.ts:56` / `sse-client.ts:95` / `bridge.ts:336`）。
- **SSE 流解析 + 指数退避重连写两份**（`sse-client.ts` vs `bridge.ts`，近乎一样）。
- **Desktop**：31 文件 import api-client、16 文件直接 `useApi()` 发 REST；事件形状（part/message/session 13+ 类型）直接耦合在 `use-session-messages.ts:249-459`。
- **Gateway**：硬编码 `:4096`、`getClient(workspaceDir)` Map 缓存、自写 SSE + permission/question 轮询——与 Desktop 同语义重复。
- **ACP 客户端是完全并行的第二实现**（分支 `agent-router.ts`：裸 fetch、硬编码 `:4099`、无鉴权、EventSource、还有 api-client 没有的 agent CRUD）；路由分流散在 `agent-context.tsx:57` + `use-session-messages` 分支版。

### Part II 草案的两处缺陷（本 ADR 修正）
`architecture-phase1.md:1082-1209` 的 `createConnector({mode:local|remote})` 草案：
1. **漏了 SSE**：`Connection.client` 直接暴露 `ApiClient`，事件订阅写成 `api-client.events.subscribe()`——但 api-client **现实里没有 events 方法**，SSE 在各端自实现。
2. **没考虑 ACP backend**：草案只设想 OpenCode 的 local/remote 两种连接（早于 ADR-027/ACP）。

### 阶段3 的前置需求
ADR-027 阶段3 编排需要「后端无关地 spawn 子会话 / await 交付物 / cancel / subscribe」——这正是 connector 要提供的**控制原语**（照搬 openclaw/acpx 的可插拔 backend 模型）。

---

## 决策

### D-1 · `@agent/connector` = 控制 + 事件统一层，包装而非取代 api-client
新增包 `packages/core/connector`。它定义一个**后端无关的控制面**，下挂多个 **backend adapter**：
- `OpenCodeBackend` = 包装现有 `ApiClient`（REST）+ `SSEClient`（事件）。
- `ACPBackend` = 包装 `agent-router`（:4099 REST）+ EventSource（事件）。
api-client / agent-router **保持不变**，只是被 adapter 包住。

### D-2 · 把 SSE 纳入 connector（修正 Part II 缺陷）
connector 提供 `subscribe()`，**吸收三套 SSE 实现的公共逻辑**：连接配置 + 鉴权 header、心跳看门狗（Desktop 30s）、指数退避重连（三处）、事件类型联合解析、sessionID 过滤/改写。控制面统一为「**call（REST 语义）+ subscribe（事件流）**」双面，不再让消费方各自手写 SSE。

### D-3 · 公共事件模型 = ADR-027 的模型（opencode SSE 形状）
backend 向上吐出**统一事件**（`SendMessageResponse[]` / SSE 事件联合）。ACP 事件已在 sidecar（ADR-027 D-3）归一化成此形状，故 connector 消费侧**与 backend 无关**。`use-session-messages.ts` 的 `handleSSEEvent` 成为「消费公共事件模型」的唯一实现，Desktop/Gateway 共享。

### D-4 · backend 选择 = 会话级绑定（对齐 ADR-027 D-2 档1）
一个会话绑定到一个 backend（opencode-REST 或 ACP）。把分散的路由判定（`agent-context.getPromptAgent` + `use-session-messages` 分支分流）**收敛进 connector**：消费方只调 `connector.prompt(sessionId, ...)`，由 connector 按会话的 backend 绑定派发到对应 adapter。

### D-5 · 核心公共面 + 能力声明（不强求最小公约数）
两 backend 能力不对称（opencode 有 config/provider/mcp/file/diff；ACP 有 agent CRUD/connect）。connector 设：
- **核心公共面**（两者都实现）：`createSession / prompt / cancel / revert / subscribe / listAgents / connectionStatus`。
- **能力声明** `capabilities`（由 `initialize`/backend 类型决定，对齐 ADR-027 W4）：消费方按 `capabilities` 条件调用 backend-specific 方法（如 `getProviders` 仅 opencode、`agentConfigCRUD` 仅 ACP）。不做 lowest-common-denominator 阉割。

### D-6 · 暴露阶段3 所需原语
backend adapter 接口即「可插拔 backend 边界」（acpx 模型）：对上暴露 `createSession / prompt / cancel / subscribe`（= spawn/steer/await 的底座）。connector 之上的 orchestrator（阶段3）**只消费这些原语**，不碰协议/进程细节。可借鉴 acpx 的 **queue-owner**（复用一个 agent 连接、串行/排队多请求、`waitForCompletion` 控 fire-and-forget）。

### D-7 · 范围边界（明确不做）
connector **只做控制 + 事件统一**。**不含**：
- **记忆/工作区注入**（Part II 草案把 IDENTITY/SOUL/MEMORY 注入捆进 connector）——分离关注点，归 [012](../discussions/012-p1-execution-plan.md) P1-2 / 记忆专项，connector 只提供注入的挂载时机（如 `onSessionCreate` hook），不拥有记忆逻辑。
- **编排**（spawn 拓扑/dispatch）——归 ADR-027 阶段3，建在 connector 原语之上。

---

## 实现章节

> 目标：消除 Desktop ↔ Gateway 的后端耦合重复，并把 ACP 并行客户端收编为一个 backend；为阶段3 编排备好原语。

### 包结构
`packages/core/connector`，deps `@agent/api-client`（OpenCodeBackend）+ ACP 客户端（`packages/agent/acp-client` 的前端 router，ACPBackend）+ `@agent/server-manager`（连接/spawn 生命周期）。

### 接口草图（示意，落地以实现为准）
```ts
type BackendKind = "opencode" | "acp"
interface BackendCapabilities { providers:boolean; mcp:boolean; file:boolean; agentCrud:boolean; loadSession:boolean; image:boolean }

interface AgentBackend {                       // 可插拔 backend 边界（acpx 模型）
  readonly kind: BackendKind
  readonly capabilities: BackendCapabilities
  // 核心公共面
  createSession(opts): Promise<SessionRef>
  prompt(sessionId, message, opts?: {agent?; model?}): Promise<void>
  cancel(sessionId): Promise<void>
  revert?(sessionId, messageID): Promise<void>
  subscribe(sessionId, handler:(e:AgentEvent)=>void): Unsubscribe   // 统一事件（修正 Part II）
  listAgents(): Promise<UnifiedAgent[]>
  status(): ConnectionStatus
  // backend-specific（按 capabilities 暴露）：getProviders/getMCP/getFileTree（opencode）；agentConfig CRUD/connect（acp）
}

interface Connector {
  registerBackend(b: AgentBackend): void
  bindSession(sessionId, kind: BackendKind): void     // 会话级 backend 绑定（D-4）
  // 统一控制面：按会话绑定派发到对应 backend
  prompt(sessionId, msg, opts?): Promise<void>
  subscribe(sessionId, handler): Unsubscribe
  cancel(sessionId): Promise<void>
  // 连接生命周期（吸收 Part II 草案）
  onStatusChange(cb): void; onError(cb): void
  // 阶段3 用：原语 + 可选 queue-owner（复用连接/排队）
}
```

### 迁移策略（增量，非大爆炸）
1. **建包 + OpenCodeBackend**：包装现有 ApiClient + SSEClient，对外暴露统一面；**行为等价**（先不改消费方）。
2. **Desktop 收敛**：`use-api.ts` / `sse-context.tsx` 改为产出 connector；16 个 `useApi()` 调用点逐个迁到 connector（一次一个 hook，可回归）；`handleSSEEvent` 成为唯一事件消费实现。
3. **Gateway 收敛**（架构表 `:529` 标注的首要重复面）：`bridge.ts` 的 `getClient()` + 自写 SSE（`connectSSE`）+ 退避 + 轮询，替换为 connector；消除与 Desktop 的重复 SSE/auth/session 逻辑。
4. **ACPBackend 收编**：把分支 `agent-router` + `use-acp-sse` 包成 ACPBackend；`agent-context` 的路由判定改由 `connector.bindSession` 承担；ACP 与 opencode 在 connector 后对消费方透明。
5. **能力门控**：消费方按 `capabilities` 条件调用 backend-specific 方法（接 ADR-027 W4）。

### 验收
- Desktop 全部后端调用经 connector；删除 Desktop/Gateway 的重复 SSE/auth/退避实现（三处 → 一处）。
- 切换会话的 backend（opencode↔ACP）对上层 hook 透明，事件渲染一致（同 `handleSSEEvent`）。
- Gateway 复用 connector，不再自带 SSE/轮询实现。
- 暴露 `createSession/prompt/cancel/subscribe` 原语供阶段3 orchestrator 消费。

---

## 考虑过的替代方案

| 方案 | 否决理由 |
|------|---------|
| **保留 api-client，仅在 ACP 处加并行客户端**（现状分支做法） | Desktop/Gateway 的 SSE/auth/session 重复不消除；ACP 与 opencode 路由分流散落，阶段3 无统一原语 |
| **connector 取代 api-client**（重写 REST 层） | 无谓推翻已验证的 api-client；风险大。应**包装**复用（Part II 草案亦持 `client` 引用） |
| **沿用 Part II 草案原样** | 漏 SSE（假设 `api-client.events` 存在）、未含 ACP backend——不足以支撑双 backend 与阶段3 |
| **把记忆注入/编排也塞进 connector**（Part II 把记忆捆绑） | 关注点混淆；connector 只做控制+事件，记忆归 P1-2、编排归阶段3，各自独立演进 |
| **最小公约数接口**（只暴露两 backend 都有的能力） | 砍掉 opencode 的 provider/mcp/file 与 ACP 的 agent CRUD——能力倒退。用 capabilities 声明而非阉割 |

---

## 后果

### 正面
- 三套 SSE + 三份鉴权 + 两份退避 → 一处；Desktop 与 Gateway 共享后端逻辑，维护面大幅收敛。
- ACP 从「并行第二客户端」收编为「一个 backend」，opencode↔ACP 对上层透明，兑现 ADR-027 的「档1 会话级绑定」。
- 为阶段3 编排备好后端无关原语（spawn/steer/await/subscribe），且 backend 可插拔（再接 codex/gemini 等只是新 adapter）。
- 修正 Part II 草案缺陷，使「连接抽象」真正可落地。

### 负面 / 成本
- 一次跨 Desktop + Gateway + ACP 分支的中等规模重构；需逐消费点迁移（16 个 `useApi()` + bridge），回归面广。
- 引入一层抽象，调试时多一跳；能力不对称需 `capabilities` 门控，增加分支逻辑。
- 依赖阶段1（ADR-027）先落地（ACP 事件已归一化），否则 ACPBackend 吐的事件不达标。

### 风险
- **抽象过度**：若 connector 试图统一两 backend 差异过大的能力，接口会臃肿——靠 D-5「核心面 + capabilities」克制。
- **迁移期双轨**：迁移过程中 connector 与直接 `useApi()` 并存，需保证行为等价、避免回归（建议 OpenCodeBackend 首版严格等价）。
- **Gateway 时序**：bridge 的 permission/question 轮询兜底（ADR-008）语义须在 connector 完整保留，否则 IM 侧权限自动应答回退。

### 待决策（落地前）
1. 迁移顺序：先 Desktop 收敛还是先建 OpenCodeBackend 等价层跑通？（建议先等价层，再 Desktop，再 Gateway，最后 ACPBackend。）
2. queue-owner（连接复用/排队）阶段2 就做，还是留阶段3 编排时再引入？
3. 公共事件模型是否就锁定为「opencode SSE 形状」，还是借此机会定义中立 schema（成本更高，需同时改 opencode 消费侧）？建议阶段2 先沿用 opencode 形状（ADR-027 D-3），中立化留后续。
