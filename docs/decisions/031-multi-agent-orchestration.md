# ADR-031: 多 Agent 编排（档2 delegate）— orchestrator + spawn/steer 原语 + 编排模式

**状态**: Accepted（架构决策）· **阶段3 第一批 + 第二批 + 第三批已落地（2026-06-12）**——实现章节五项全实现：①原语层 + ④代码驱动 Pipeline + ②agent 驱动 delegate（`delegate-mcp` stdio shim + 双注入路径）+ ⑤Fan-out（DAG 执行器 + worktree 隔离）+ ③UI（独立路由 + 主对话 delegate 卡片/dock）。宿主 = ACP sidecar :4099，`/orchestration/*`。**第三批（[017](../discussions/017-team-page-agent-driven-orchestration.md)）确立 D-3 opt-in 的最终产品形态 = Team 页**：`/orchestration` 两 tab（Team 协作 / 流水线），委派是 Leader 会话的默认行为（system 提示驱动），普通会话物理隔离（全部非 Leader opencode prompt 恒 deny `orchestrator_*`），「编排模式」Settings 开关移除。落地偏差备注见下方「实现章节」。
**日期**: 2026-06-08
**关联**: ADR-005 (Permission & Question Dock), ADR-026 (知识库 MCP), ADR-027 (ACP 多后端，D-2 档2/阶段3), ADR-029 (执行流程回合分组，嵌套渲染), ADR-030 (@agent/connector 控制原语)
**探索来源**: [discussions/013](../discussions/013-agent-os-acp-multi-backend.md) §6（delegate 优于对等换手、五种模式、治理）· [discussions/012](../discussions/012-p1-execution-plan.md) P1-3（嵌套委派 UI）

---

## 背景

「Agent OS」愿景的标志能力是**多 agent 协作**。ADR-027 已定档2 = **delegate/编排**（orchestrator 拥有主对话，把子任务委派给其它 agent，结果以交付物契约回卷），并**否决「对等换手」**（同一对话历史里对等 agent 逐轮透明换手——伪命题）。本 ADR 把档2 展开为实现决策。

三个已确立的前提：
1. **opencode 当不了跨厂商 orchestrator**：它是 ACP **Server**，自带的 `task` 工具只能派给**它自己的**子 agent（general/explore，`tool/task.ts:29`），派不出去外部 claude/qoder。→ **跨厂商 orchestrator 必须 Ultrawork 自建**（正如 openclaw）。
2. **建在 connector 原语之上**：ADR-030 的 backend adapter 暴露 `createSession/prompt/cancel/subscribe`，正是 spawn/await/steer 的底座；编排层只消费原语，不碰协议/进程。
3. **五种模式不是一等公民**：经源码核实，openclaw **没有** `/acp fanout`、`/acp debate` 命令或 `dispatch.rules`——Fan-out/Pipeline/Supervisor/Debate 是用细粒度原语（spawn/steer/cancel/streamTo）+ LLM 编排者 emergent 的。**Ultrawork 应先做对原语，模式作为其上的组合。**

四个 delegate 范式参考（均「父→子委派 + 交付物回卷」，无透明换手）：opencode `task`（child session + `<task_result>`）、hermes `delegate_tool`（ThreadPool 子 AIAgent，默认 3 并发、`max_spawn_depth=1`）、openclaw `sessions_spawn`（`runtime:acp` 后台任务，`streamTo:parent` 回流 + announce 回卷）、**AionUi Team Mode**（**现网已 ship**：Leader 经内置 **Team MCP Server** 分派子任务 → Teammate 并行 → **异步 mailbox 回卷** → Leader 汇总；详见 [discussions/016](../discussions/016-aionui-multi-agent-competitor.md)）。→ **本 ADR 的 host-MCP delegate（D-1）已有现网产品（AionUi）佐证可行，降低实现风险。**

---

## 决策

### D-1 · orchestrator 自建；delegate = 工具（agent 驱动）+ workflow API（代码驱动），混合
- **agent 驱动**：通过 ADR-030/027 的**宿主 MCP bridge**（默认关、opt-in）给当前会话的**主 agent**注入一个 `delegate` 工具。主 agent（无论 opencode/claude/qoder）调 `delegate(agentId, task, …)` 时，Ultrawork orchestrator 用 connector 在目标 backend **spawn 一个子会话**执行，把交付物作为工具结果回卷。这与 openclaw `sessions_spawn`、opencode `task` 同构——**delegate 是一个工具，由宿主实现**。
- **代码驱动**：提供 **workflow recipe API**（确定性流水线，无 LLM 决策），Ultrawork 按 recipe 顺序/并行 spawn + 串接产物。
- **混合原则**（013 §6.4）：已知固定模式（如 PR review pipeline）走代码驱动 workflow（可复现/可调试）；开放任务走 agent 驱动 delegate（灵活）。

### D-2 · delegate 机制 = 子会话 + 子任务 prompt + 交付物契约（非 transcript 注入）
1. orchestrator **拥有主对话**（canonical），用户与之交互。
2. delegate 时经 connector `createSession`（目标 backend + 指定 `cwd`）→ 子会话。
3. 交接的是**明确的子任务 prompt + 引用的产物/文件路径**（**不是**把主对话历史塞给子 agent——有损且业界无人这么做）。
4. 子会话跑完，取其**交付物**（最终 text / 写出的文件）作为 delegate 工具结果回卷给父；子会话中间过程**不进父上下文**（对齐 opencode `<task_result>`）。
5. 保真度边界（诚实标注）：父只见交付物、不见子的推理/diff——损失发生在**干净契约接口**上，可接受（UI 须表达「子 agent 交回成果、非全过程」）。

### D-3 · 模式不内置，由原语组合；首发 Pipeline + Fan-out
不硬编码五种模式。先 ship 两个最有价值的：
- **Pipeline**（产物串接）：A→B→C，上一步**输出文件**作下一步输入。
- **Fan-out**（并行）：1 planner → N worker 并行，各自独立子会话。
Supervisor / Debate / Swarm(A2A) 作为后续组合或留远期；**Swarm 走 A2A，不在 ACP/本 ADR 范围**。

### D-4 · 隔离与产物交接
- **Fan-out 隔离**：每个 worker 子会话用**独立 cwd / git worktree**（connector `createSession({cwd})`），避免并行写冲突；可用 permission glob 限定各 worker 只写自己的路径。
- **Pipeline 交接**：上一步**写产物文件**到共享/约定路径，下一步以路径/文件引用为输入（不靠对话历史传递）。

### D-5 · 治理护栏（必须，否则失控）
- `maxConcurrent`（默认 ~8，对齐 openclaw/acpx）——全局并发子会话上限，保护配额/CPU。
- `maxDepth`（默认 **1**，扁平树）——禁子 agent 再 delegate（防递归爆炸，对齐 hermes `max_spawn_depth=1` / opencode 注入 `task:deny`）。
- **子 agent 成本优化**：子会话可配更便宜/快的 `model`（对齐 hermes/openclaw）。
- **子 agent 权限收窄**：子 toolset 默认收紧（禁 delegate 防递归）；写操作经 permission（复用 ADR-005 dock）或 sandbox/worktree 隔离。
- **预算/超时**：每个 delegate 带 token 预算 + 超时（对齐 opencode task），超限终止并回报。

### D-6 · 异步后台 + 进度回流 + 完成回卷
delegate 是**非阻塞后台任务**（openclaw 模型）：父回合不被独占。进度以 system event 流回父会话（`streamTo:parent` 式），完成走独立回卷通道把交付物交给父。父可用 `steer`（中途纠偏）/ `cancel`（终止）原语干预（对齐 openclaw `/acp steer`/`cancel`）。

### D-7 · UI = 嵌套委派（接 ADR-029 + P1-3）
- delegate 在主对话表现为一张**专用工具卡片**（识别 `delegate`/`task`，展示 `targetAgent + 子任务描述`），归入 ADR-029 的 ExecutionFlow。
- 卡片可展开看**子会话过程**：MVP 用**懒加载**（展开时拉子会话历史，复杂度低）；实时归属（子会话 SSE 内联）留后续（接 [012](../discussions/012-p1-execution-plan.md) P1-3 Phase 2）。
- 并行多 delegate = 多卡片；默认折叠，避免信息密度淹没主对话。
- **不破坏现有 UX（接 [agent-os-target-architecture.md](../agent-os-target-architecture.md) §3.6）**：档2 默认 opt-in（D-3），且**建议承载在独立 orchestration/team 路由**——主对话内仅在用户于该会话显式委派时出现卡片，复杂并行编排放独立面，单会话聊天保持纯净。**现网范式**：AionUi 即 Team Mode 独立页 `pages/team` / 非-Team 普通 `pages/conversation` 不变（[016](../discussions/016-aionui-multi-agent-competitor.md) 源码核实）。

### D-8 · 范围边界
- **不含档3 自动调度**（router 自动决定派给谁）——留 ADR-027 阶段4。本 ADR 是「用户/主 agent 显式委派」。
- **不重做 opencode 内部 subagent**：opencode 自家 general/explore 的 in-session 委派保持原样（ADR-027 W2 暴露），本 ADR 的宿主 delegate 是**跨厂商**扩展，二者并存不冲突。

---

## 实现章节

> 依赖：ADR-027 阶段1（ACP 事件归一化）+ ADR-030 阶段2（connector 原语）先落地。
> **现网设计参考（AionUi Team Mode，[016](../discussions/016-aionui-multi-agent-competitor.md)）**：① **Team MCP Server** 印证本 ADR「delegate 经宿主 MCP bridge」的范式（任务分发 + mailbox 回收 + 共享任务板）——**注**：其 handler 实现体是预构建件、**源不在公开 repo**（016 §9 完整检出确认），只能借鉴**数据流设计**、不能照抄分发实现；② **MCP 注入状态机** `tcp_ready→…→mcp_tools_ready`（+ degraded/error，`teamTypes.ts` ✅源码）可参考 ADR-027 W4；③ **Team/TeamAgent 数据模型**（✅`teamTypes.ts`）+ SQLite 表 `teams`/`mailbox`/`team_tasks`（✅`schema.ts`，为 dispatch board + addressed mailbox 量身设计）+ IPC 事件集，作 orchestrator 数据模型与编排 UI 参考。

### 组件
- **Orchestrator**（新，`packages/core/orchestrator` 或并入 connector 上层）：实现 delegate 语义、治理护栏、后台任务跟踪、进度回流/回卷。
- **delegate 工具**（经宿主 MCP bridge 暴露给主 agent）。schema 借鉴 openclaw `sessions_spawn`：
  ```
  delegate(
    agentId: string,          // 目标 backend agent（claude/qoder/opencode…）
    task: string,             // 子任务 prompt（含引用产物路径）
    cwd?: string,             // 隔离工作目录（Fan-out 用 worktree）
    model?: string,           // 子 agent 模型（成本优化）
    deliverable?: "text"|"file",  // 期望交付物形态
    timeoutMs?, tokenBudget?  // 治理
  ) -> { deliverable, sessionId, tokens, cost }   // 回卷契约
  ```
- **workflow recipe API**（代码驱动）：声明式 recipe（steps[].{agent, task, input/output 文件}）→ orchestrator 顺序/并行执行。
- **UI**：delegate 卡片渲染器（接 ADR-029 ExecutionFlow / tool-call-block）+ 子会话懒加载。

### 阶段拆解
1. **原语层** ✅（2026-06-12）：在 connector 之上实现 `spawn(child)/await(deliverable)/steer/cancel` + 后台任务跟踪 + 治理护栏（maxConcurrent/maxDepth/budget）。
2. **agent 驱动 delegate** ✅（2026-06-12 第二批）：`acp-client delegate-mcp` stdio shim（`delegate`/`list_agents` 工具）→ HTTP 回连 `POST /orchestration/delegate`（**阻塞**返回 D-2 契约，拍板 2026-06-12：opencode task 同构，非阻塞 mailbox 留后续）。双注入路径：ACP per-session（`orchestrate` 旗标，子会话不注入=硬护栏）/ opencode 全局配置（「编排模式」开关；子会话 `tools:{"orchestrator_*":false}` → sticky session permission deny）。
3. **UI 嵌套** ✅（2026-06-12 两批合计）：编排独立路由 `/orchestration`（run 列表/详情 + step 时间线按依赖深度分层 + 权限内联应答 + 子会话懒加载）+ 主对话 delegate 卡片（ExecutionFlow 识别 + 子会话懒加载）+ DelegateDock（阻塞期权限内联应答）。
4. **代码驱动 Pipeline** ✅（2026-06-12）：recipe API + 产物文件串接；真机模板 = 跨厂商两步（opencode 分析 → claude 报告）。
5. **Fan-out** ✅（2026-06-12 第二批）：pipeline 执行器泛化为 **DAG 调度**（inputs 全 completed 即并行启动，失败跳传递性下游、独立分支跑完）+ 按步 `isolation:"worktree"`（git worktree --detach，输入产物复制进 worktree、交付物拷回主 run 目录、成功删失败留）+ 聚合（inputs=全部 workers）。

> **第一批落地备注（2026-06-12）**：
> - **宿主**：orchestrator 实例化在 **ACP sidecar :4099**（非 desktop renderer）——编排跨 WebView reload 存活，② 的 MCP stdio shim 将来可经 HTTP 回连；UI 经 `/orchestration/*` HTTP + per-run SSE（首帧全量快照）消费。
> - **prompt 语义差异**（调研修正）：OpenCodeBackend.prompt 是 fire-and-forget（prompt_async 204），ACP prompt 阻塞至 StopReason——`runTurn` 统一封装双语义终态检测（见 gotchas §9）。
> - **D-6 的「非阻塞 + 回卷」在第一批中体现为**：spawn 即后台任务（TaskHandle.done 永不 reject）+ steer/cancel 可中途干预；MCP 工具形态的交付物回卷随 ② 落地。
> - **D-5 治理**：maxConcurrent 信号量为**排队**语义（非拒绝，为 Fan-out 留路）；tokenBudget 字段预留未执行。
> - 子会话防侧栏污染：ACP 子会话无 opencode twin；opencode 子会话 parentID 挂跨目录隐藏父会话（vendor 接受跨目录 parentID，真机验证）。
>
> **第二批落地备注（2026-06-12）**：
> - **D-2 契约最终形态**：`{status, sessionId, deliverable?, tokens?, cost?, error?}`——deliverable = 子会话最后一条含文本的 assistant 消息（fetchHistory），tokens/cost best-effort 汇总（ACP 无 cost 自然省略）。
> - **阻塞超时三件套**：shim 每 10s 发 MCP progress notification（vendor `resetTimeoutOnProgress:true`）+ opencode mcp entry `timeout:600000`（兼任 connect 超时，勿过大）+ claude spawn env `MCP_TOOL_TIMEOUT` 兜底。
> - **深度护栏残余风险（接受）**：delegate 端点恒 depth 0→1；真正的防递归闸门在注入侧（ACP 子会话不注入 + opencode 子会话 tools deny，均真机验证）。delegate 记录不持久化（重启 = shim 工具错误，与 run interrupted 同级）。
> - **opencode「编排模式」开关限制**：vendor 无 DELETE /mcp——关闭须重启生效；运行时 POST /mcp 仅对当前 workspace instance 生效（gotchas §3）。
> - **真机（2026-06-12 两轮）**：opencode 主 agent 全闭环（qwen-plus 调 `orchestrator_delegate` → 契约回卷）、**claude 主对话全闭环**（per-session 注入 → mcp__orchestrator__delegate 可见 → 权限应答 → 委派 opencode 子任务契约回卷；首轮"工具不可见"的根因是测试栈跑了 M4 之前的旧二进制，重编即愈，注入链路无缺陷）、子会话 deny/隐藏父/侧栏零污染、shim progress keepalive 3 帧、Fan-out 3 步（含 worktree worker）并行+聚合+worktree 回收全过；GUI（Chrome+Vite+Playwright）①③④⑤ 12 项断言全过（delegate 卡片/DelegateDock 权限内联+文件落盘/Fan-out 分层渲染/步骤级 model 下拉）。ACP 卡片识别谓词真机校准：claude 的 tool part `tool='other'`（kind）、input `{agentId,task,cwd,model}` —— rawInput 形状谓词命中。
> - **D-8 真机佐证**：opencode 主对话内置 `task` 与 `orchestrator_delegate` 并存，提示词不点名时模型可能选内置 task——跨厂商委派须点名工具。
> **第三批落地备注（2026-06-12，[017](../discussions/017-team-page-agent-driven-orchestration.md) 五项拍板全实现）**：
> - **D-3 opt-in 的最终产品形态 = Team 页**：`/orchestration` 两 tab；Team tab = Leader 会话聊天面（Leader 下拉默认 opencode + 成员勾选默认全选、创建后锁定 + 历史列表）。用户只描述任务，拆分/委派/汇总由 Leader system 提示（017 §2.4，`team-leader-prompt.ts`）驱动成默认行为。
> - **per-backend 注入**：opencode leader = 全局 MCP 静默 ensure（`orchestrator-mcp.ts`，开关移除）+ **每轮** `promptAsync system`（vendor append 语义）+ 每轮 `tools:{"task":false}`（sticky deny 内置 task，治本工具混淆）；ACP leader = per-session `orchestrate:true` + **`_meta.systemPrompt` object append（claude-agent-acp ≥0.44 真机验证支持）**，非 claude adapter 退化首条 prompt wire 前置（用户回显保持干净）。重启经 session/load 重注入。
> - **隔离闭环（拍板 #4）**：OpenCodeBackend.prompt 的 tools **缺省值** = `{"orchestrator_*":false}`（connector 层兜底）+ gateway IM 链路显式同 deny——普通会话物理无编排工具，全局 MCP 常驻不再有泄漏面。
> - **Leader 会话防侧栏污染**：挂跨目录隐藏 `[team]` 父（与 `[delegates]` 父同机制）；ACP leader 复用 twin+binding 范式。注册表 `team-sessions.json` 服务端持久化（`/orchestration/team/sessions` 3 端点）。
> - **真机（2026-06-12，备用端口栈 14096/14099）**：qwen-plus leader **不点名工具**自发同轮并行 `orchestrator_delegate` ×2 跨厂商（opencode+claude 子会话）+ 汇总标注来源；leader `task` deny / 普通会话 `orchestrator_*` deny sticky ruleset 双验证（探针回复 DENIED）；claude leader `_meta.systemPrompt` 生效（完整复述职责/成员/点名工具）；sidecar 重启注册表恢复 + systemPrompt 重注入 + 上下文连续。
> - **不做（017 §4 后置）**：mailbox 非阻塞回卷（D-6 完整形态）、per-agent 并行面板、常驻 Team 实体、成员服务端白名单（MVP 仅提示约束）。
>
> **018 编排 UX 统一备注（2026-06-12，[018](../discussions/018-unified-orchestration-ux.md) A-1~A-4 + 议题 B 落地）**：Team 从独立 tab 融入主聊天流——模式 = 任务出生属性（Home segmented，出生锁定）、Team 会话进侧栏混排+徽标（`TeamSessionsProvider` 注册表驱动）、Session 页合流（TeamHeader 成员条 + delegate 实时活动环 + 注入逻辑平移）、`/orchestration` 回归纯流水线。**Leader 改为 ROOT 会话**（不挂隐藏 `[team]` 父——该机制从 team-routes 移除；delegate 子会话隐藏父不变）→ opencode 自动标题生效；存量挂父会话经侧栏补显（vendor PATCH 不支持改 parentID）。机制零改动：registry/deny/注入/delegate 卡片全复用。
>
> **018 成员强制（2026-06-13，走查发现 Leader 越界委派后补）**：原 Leader system prompt 让它「用 list_agents 核对成员」，但 list_agents 打的 `/orchestration/agents` 返回全局所有 agent → Leader 委派给了选区外的 gemini/qoder（违反 017「成员=prompt 软约束」的预期）。修复升级为**双层**：① prompt——roster 改为唯一权威、明令禁止委派清单外 agent 且无需调 list_agents；② **服务端硬兜底**——`team-store.teamMembersForWorkspace(workspace)` 给出该 workspace 下所有 Team 成员并集，`/orchestration/delegate` 拒绝非成员（403→模型可见 tool error 自纠）、`/orchestration/agents?workspace=` 按成员过滤。架构约束：全局 delegate shim 只携带 workspace 不携带 Team 会话 id，故按 workspace 并集 scope（多 Team 共享 workspace 时退化为并集，窄残留）。原「成员服务端白名单后置」一项至此**部分落地**（workspace 级硬强制；per-session 精确白名单仍后置）。

### 验收
- 主 agent 能 `delegate` 给一个**外部** backend agent（如 opencode 主对话委派 claude 子任务），交付物正确回卷、UI 可见嵌套过程、治理护栏生效（并发/深度/超时）。
- 一个 Pipeline recipe（如 PR review：架构→细节→文档一致性，跨 claude/codex/gemini）端到端跑通，产物文件串接。
- Fan-out 三 worker 并行于独立 worktree 互不污染，结果聚合。
- cancel/steer 原语可中途干预；子会话失败不挂死父对话。

---

## 考虑过的替代方案

| 方案 | 否决理由 |
|------|---------|
| **对等换手**（同一对话多 agent 逐轮换手） | 业界无人造、ACP/A2A 不支持、有损且不可归因——伪命题（ADR-027 D-2 已否决） |
| **靠 opencode `task` 工具做编排** | 只能派 opencode 自家 general/explore，**到不了外部 claude/qoder**；跨厂商必须自建 orchestrator |
| **内置固化五种模式** | openclaw 实证「模式非一等公民、由原语 emergent」；硬编码模式僵化。先做对原语，模式作组合 |
| **delegate 时注入完整 transcript 给子 agent** | 有损（丢工具/推理中间态）、污染子上下文、token 浪费；应传**明确子任务 + 产物引用** |
| **同步阻塞 delegate** | 父回合被独占、无法并行/取消；应异步后台 + 进度回流（openclaw 模型） |
| **无深度/并发上限** | 递归 delegate 爆炸 + 配额失控；必须 maxDepth=1 + maxConcurrent + 预算 |
| **默认就上编排** | 过度工程化——档1 覆盖约 80% 价值（013 §6.4）；编排是复杂可拆解任务的「高级档」，按需启用 |

---

## 后果

### 正面
- 兑现「Agent OS」标志能力：跨厂商多 agent 协作（Pipeline 取各家所长、Fan-out 并行提速）。
- 复用 connector 原语 + 宿主 MCP + ADR-029 渲染 + permission dock，增量而非另起。
- 原语化（spawn/steer/await）+ 治理护栏，模式可组合、backend 可插拔（再接 agent 只是新 adapter）。
- agent 驱动 + 代码驱动混合，兼顾灵活与可复现。

### 负面 / 成本
- 自建 orchestrator 是真实增量（opencode 不提供）：后台任务跟踪、治理、回卷、嵌套 UI 都要做。
- 嵌套委派 UI 是难点（信息密度、实时归属）；MVP 懒加载规避，但实时体验需后续投入。
- 跨厂商 delegate 保真度有损（仅交付物），对「接管半截复杂编码任务」力不从心——须管理用户预期。
- 依赖阶段1+2 全部到位，链路长。

### 风险
- **orchestrator 质量是瓶颈**（agent 驱动）：弱 orchestrator 会误派/拆错任务；代码驱动 workflow 缓解但僵化。
- **失控风险**：并发/递归/成本若护栏缺失会爆炸——D-5 必须先行。
- **过度工程化**：若把编排当默认会拖累简单场景；保持「按需高级档」定位。
- **战略**：openclaw+acpx / Jockey 已在做编排；Ultrawork 差异化仍须靠 ACP 之外（国内 IM + 知识库），编排是能力补齐非护城河。

### 待决策（落地前）
> ✅ **已全部拍板（2026-06-08）**，结果见 [`agent-os-target-architecture.md`](../agent-os-target-architecture.md) §0 决策基线表（D1-D4）。
1. orchestrator 落地形态：独立包 vs 并入 connector → **独立包 `packages/core/orchestrator`**（connector 只做控制+事件）。
2. 首发模式优先级：Pipeline 还是 Fan-out → **Pipeline 先做**（产物串接最易验证价值），Fan-out 紧随。
3. delegate 工具默认可见 vs 仅「编排模式」opt-in 注入 → **仅 opt-in 注入**（按需高级档）。
4. 实时子会话归属 vs 懒加载 → **MVP 懒加载**，实时内联留后续（接 P1-3 Phase 2）。
