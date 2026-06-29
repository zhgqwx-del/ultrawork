# 024 — 右侧栏「计划执行进度」：工具调用日志 vs 任务规划步骤

> 状态：✅ 已落地（见 **ADR-038**，真机+真模型+ACP+切回 e2e 验收）— Q1=方案 B（规划为主+活动兜底）· Q2=连带做 ACP plan 归一 · Q3=Team 仅显示主 agent 规划，不聚合子会话
> ⚠️ **ACP 承载方案已在 ADR-038 升级**：本文 §5.1/§6 初版写的"ACP 靠消息历史里的结构化 plan part 水合"已**否决**，改为「**独立 `plan.updated` 事件 + 新增 `GET /acp/session/:id/plan` 快照端点**」——plan 作会话级状态、不新增 message part 类型、与 OpenCode `todo.updated`/REST 对称、与真 reasoning 解耦（三路实现级核验后的结论，详见 ADR-038 决策 §2/替代方案）。下文保留初版分析作演进记录。
> 日期：2026-06-29
> 关联：discussions/022（会话切回忙碌态以后端真相为源 + 缓存水合）· ADR-035（多 Team 委派归属 / `ownerSessionId` 过滤）· discussions/014 + ADR-027（ACP 事件归一化）· ADR-036 + discussions/023（渐进式工具披露，`todowrite` 属 EAGER 永不折叠）· gotchas §1（OpenCode message part 契约）
> 范围：**只覆盖右侧栏这一个面板「展示什么 + 如何保证完整与对齐」**。不涉及让模型「更爱做规划」的提示词调优（仅在 §7 点到）、也不重做整个消息渲染。

---

## 0. 一句话

现在右上角的「计划执行进度」名不副实——它把 assistant 消息里**所有工具调用**平铺成一条流水（read/bash/edit… 一条条），既不是"规划"也没有"任务"的概念。而我们 pin 的 OpenCode **本身已内置完整的 todo（任务规划）子系统**（`todowrite` 工具 + SQLite 持久化 + `todo.updated` SSE + REST 快照），前端只是**没接**。主流（Claude Code / Cursor / Codex / Cline）都把这块做成**任务规划清单**而非工具流水。建议改造为「规划步骤视图」，并因为 OpenCode 的 todo 是**整表替换**语义，完整性与状态对齐几乎是"白送"的——前提是把数据源从「本地扫消息」换成「后端真相（REST 水合 + SSE 订阅）」。

---

## 1. 现状（代码实证）

| 项 | 事实 | 位置 |
|----|------|------|
| 面板标题 | i18n `session.rightSidebar.plan` = "计划执行进度" | `packages/client/desktop/src/lib/i18n-context.tsx` |
| 容器 | `<RightSidebarSection title=plan><ProgressPanel messages={allMessages}/></RightSidebarSection>` | `packages/client/desktop/src/pages/Session.tsx:316` |
| 实现 | `ProgressPanel` + `extractToolSteps()` | `packages/client/desktop/src/components/session/progress-panel.tsx` |
| **数据源** | **扫 `allMessages` 里 `role==="assistant"` 的每个 `part.type==="tool"`**，取 `tool / state.status / state.title / state.error`，平铺成 `ToolStep[]` | 同上 |
| 计数 | `completed / total` = 已完成工具数 / 工具总数 | 同上 |
| 图标 | running=转圈 · completed=绿勾 · error=红叉 · 其余=灰点 | `StepIcon` |

**结论**：当前展示的就是**工具调用记录**（tool-call log），用户的判断正确。它有两个本质问题：
1. **粒度错位**：一个"任务步骤"（如"重构鉴权模块"）在底层可能是十几次 read/edit/bash；把每次工具调用当一个"步骤"，列表又长又碎，且和用户脑中的"计划"对不上。
2. **没有规划语义**：没有"任务被拆成哪几步、现在做到第几步"的概念，只有"调了哪些工具"。

---

## 2. 主流做法调研

**业界共识：复杂任务展示「任务规划清单（todo / plan）」，不是工具流水。** 工具调用流水属于"活动日志/可观测性"，是另一层东西。

| 产品 | 规划机制 | 形态 |
|------|---------|------|
| Claude Code（早期） | `TodoWrite` 工具：**一次性重写整个 `todos` 数组**，item = `{content, status, activeForm}`，status = `pending\|in_progress\|completed` | 终端内实时清单，⬜/🔄(带 spinner)/✅ |
| Claude Code（新，CC v2.1.142 / SDK 0.3.142） | 迁移到结构化 `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet`：**按 `taskId` 增量 patch**，多 `deleted` 状态、`blockedBy` 依赖、`owner` | 同上，但前端需按 id 维护 map 累积 |
| 官方诉求 | Issue #31243：把 todo 清单放进**侧栏常驻**、不随聊天滚动、可点击跳转到对应消息（与本提案诉求一致） | ⬜/🔄/✅ |
| Cursor | Plan Mode（Shift+Tab）：先出**可审阅计划**再执行；带依赖的 todo，实时更新 | 计划面板 + 勾选 |
| Codex / Cline | 把复杂请求拆成带依赖的 todo，实时更新 | 清单 |

**同步语义两类**（直接决定前端怎么对齐，关键）：
- **整表替换**（旧 TodoWrite）：每次事件/工具结果携带**完整数组**，"取最新一份"即完整一致，**不会漂移、不会漏步**。
- **增量 patch**（新 Task tools）：每次只来一条增删改，前端必须按 id 累积合并，漏一条就错位。

> ⚠️ **我们 pin 的 OpenCode v1.3.13 用的是整表替换语义**（见 §3），这是本方案"完整性几乎白送"的根基。若将来 vendor bump 到带 Task tools 的版本，消费模型要改（见 §8 vendor bump 连带）。

来源：
- [Todo Lists — Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/todo-tracking)（todo 生命周期 / 整表 vs 增量 / 监听 tool_use）
- [anthropics/claude-code#31243](https://github.com/anthropics/claude-code/issues/31243)（侧栏常驻 todo 提案）
- [Cursor — Plan Mode](https://cursor.com/docs/agent/plan-mode) · [Agent best practices](https://cursor.com/blog/agent-best-practices)
- [How Agents Plan Tasks with To-Do Lists — Towards Data Science](https://towardsdatascience.com/how-agents-plan-tasks-with-to-do-lists/)

---

## 3. 上游能力盘点：OpenCode 已内置完整 todo 子系统（前端没接）

我们 pin 的 `vendor/opencode`（v1.3.13）**已经全套就绪**，零需新增后端能力：

| 能力 | 事实 | 位置 |
|------|------|------|
| 工具 | `todowrite`（模型按需调用） | `vendor/opencode/.../tool/todo.ts` |
| 数据模型 | `Todo.Info = { content, status, priority }`，status ∈ `pending\|in_progress\|completed\|cancelled`，priority ∈ `high\|medium\|low` | `.../session/todo.ts:11` |
| **持久化** | **SQLite `TodoTable` 按 `session_id` 存**，含 `position` 排序字段 → 会话级真相，跨切换不丢 | `.../session/todo.ts:42` |
| **SSE 广播** | **`todo.updated` 事件**：`{ sessionID, todos: Todo[] }`（整表） | `.../session/todo.ts:20` |
| **REST 快照** | **`GET /session/{sessionID}/todo` → `Todo[]`** | `.../server/routes/session.ts:161` |
| 冗余通道 | `todowrite` 的 ToolPart 还带 `metadata.todos`（整表），且工具 input 也是整表 | `.../tool/todo.ts:27` |
| 上游 UI 参考 | OpenCode 自己的 UI 把它渲染成 checkbox 清单，标题 `x/y` | `.../ui/.../message-part.tsx:2140` |
| 披露层保障 | `todowrite` 在 ADR-036 的 **EAGER_BUILTINS**，永不被工具折叠关停 → 规划能力始终对模型可用 | `tool-disclosure.ts` |

**Ultrawork desktop 现状**：完全没消费——无 `todo.updated` 监听、无 `EventTodoUpdated` 引用、无 todo UI。即"后端一直在生产规划数据，前端从没读过"。

**这意味着**：把面板从工具流水改成规划清单，**不是从零造，而是把已有后端数据接上**。

---

## 3.5 ACP 后端的 plan 这条线（关键修正：不是"没流进来"，是"流进来但被压扁丢了结构"）

ACP 后端（`claude-agent-acp`/gemini 等，`packages/agent/acp-client`，**我们自己的代码、非 vendor**）也有 plan 能力，且**已经在流**，但形态和 OpenCode 完全不同：

| 维度 | ACP 现状 | 位置 |
|------|---------|------|
| 协议数据 | `session/update` 的 `plan` / `plan_update`，整表，`PlanEntry = { content, status, priority? }`，status ∈ `pending\|in_progress\|completed`（**比 OpenCode 少 `cancelled`**） | `@agentclientprotocol/sdk` · `turn-shaper.ts:17,143` |
| 接收/分发 | `acp-connection.ts` → `TurnShaper.handleUpdate()` 的 `case "plan"/"plan_update"` 已处理 | `acp-client/src/turn-shaper.ts:125-161` |
| **致命点** | **`onPlan()` 把整表 `formatPlan()` 成一段纯文本（`Plan\n○…→…✓…`）塞进一个 `reasoning` part** —— 结构在过 connector **之前**就被销毁 | `turn-shaper.ts:297-311` |
| 归一化 | connector 只是 opencode-shaped **透传**（`backends/acp.ts:60`），没有真正的 plan 归一；`BackendCapabilities.plan=true` 两后端都声明但没人消费 | `connector/src/backends/acp.ts` · `types.ts:34` |
| 前端现状 | 该 reasoning part 被 `ExecutionFlow` 渲染成「**深度思考**」折叠块（`message.deepThinking`），纯文本、无结构 | `chat/execution-flow.tsx:161-181` |
| 持久化 | **ACP 无 REST 快照、无 SQLite 持久化** —— 与 OpenCode（`todo.updated`+REST+SQLite）严重不对称 | — |

**结论（直接决定 §6 设计）**：要让 ACP 会话也显示结构化「任务规划」，**必须改 `turn-shaper.onPlan()`**——停止把 plan 压成 reasoning 文本，改为发**结构化 plan**（好在这是我们自己的代码，**无需 vendor patch**）。同时 ACP 没有 REST 快照，水合策略必须分后端（见 §6）。

> ⚠️ 行为变更风险：今天 ACP plan 是以「深度思考」块出现在聊天里的。改成结构化后，要确保聊天内仍渲染为「任务规划」行（别让聊天丢掉 plan），即两个 surface（侧栏 + 聊天）一致升级。

---

## 4. Q1 — 保持现状 vs 改为任务规划步骤？

**推荐：改为「任务规划步骤」为主视图；工具流水降级为可选的次级"活动"视图（兜底简单任务）。**

理由：①与主流收敛一致；②上游数据现成；③粒度对齐用户心智；④面板名「计划执行进度」本就该名副其实。

三个候选形态（请用户拍板，见末尾）：

| 方案 | 主视图 | 工具流水去向 | 简单任务（无 todo）时 | 评价 |
|------|--------|-------------|---------------------|------|
| **A 纯替换** | todo 清单 | 删除 | 显示空态/折叠 | 最干净，但丢了对"AI 到底在做什么"的可观测性，简单任务面板常年空 |
| **B 双区共存**（推荐） | 上「任务规划」(有 todo 才显示) + 下「执行活动」(工具流水，常在/可折叠) | 保留为次级区 | 只剩活动区，不空 | 规划与活动各司其职；复杂任务看规划、简单任务看活动；改动可控 |
| **C 规划+嵌套活动** | todo 清单，每个 `in_progress` 步骤下嵌套该步期间发生的工具调用（按回合时间窗关联） | 嵌进对应 todo | 退化为纯活动 | 信息最丰富、最像 Claude Code，但需"工具调用归属到哪个 todo"的时间窗关联，复杂度最高 → 建议作为 B 之上的后续增强 |

> ✅ **已采纳 B**（规划为主、活动保底），C 列为后续（§8 Phase 4）。B 满足"这块应是任务规划步骤"的核心诉求，又不牺牲现有可观测性，简单任务不出现"空面板"。

---

## 5. Q2 — 如何保证完整、不缺失、状态对齐（核心）

用户的三条担忧逐条拆解，对应到机制：

### 5.1 「该有规划都有规划、不丢失」= 完整性

**根因优势：两后端的 plan 都是整表语义**（OpenCode todo / ACP plan 每次都给完整数组）。"完整性"= "取最新一份非空整表"，不需要增量合并、不会累积幽灵步骤、不会漏步——这是相对新 Task tools（增量 patch）的关键简化。

但两后端的**水合（hydrate）能力不对称**，必须分后端设计：

**OpenCode 路径（三路冗余、单一真相）**：
1. **水合**：进入/切回会话时 `GET /session/{id}/todo` 拉**权威快照** → 立刻拿到完整当前清单，**天然解决 discussions/022 同类的"切回丢状态"问题**（不依赖本地累积、不会因重挂清零）。
2. **订阅**：SSE `todo.updated` 分支 → 实时整表替换。
3. **兜底**：`todowrite` 的 ToolPart `metadata.todos` 也是整表；漏了 SSE 可从最近一条 todowrite part 重建。

**ACP 路径（无 REST、无持久化 → 靠消息历史里的结构化 plan part）**：
1. **改 `turn-shaper.onPlan()`**：停止压成 reasoning 文本，改为发**结构化 plan part**（携带 `entries: PlanStep[]` 整表）。
2. **订阅**：该 plan part 经 `message.part.updated` 实时到前端（同现有通道，只是载荷从文本变结构）。
3. **水合**：ACP 无 REST 快照 → **切回时从 `fetchHistory` 的消息历史里取最近一条结构化 plan part 重建**（plan part 随消息持久化，故切回不丢；这是 ACP 没有 REST 时的等效水合）。
   - 仅当"回合进行中切走再切回"且历史增量持久化滞后才可能短暂不全 → 若实测有缺口，再补一个 ACP sidecar 的 plan 快照端点（对齐 022 的 `GET /acp/global/events` 思路，列为 §8 后续）。

> 两条路最终都写进**同一个按 sessionID 缓存的 `PlanStep[]`**，前端面板对后端无感（见 §6 归一化）。

**真正的"可能没有规划"** 来自模型：OpenCode 只在复杂任务时调 `todowrite`（受 `todowrite.txt` 系统提示约束）。简单任务**本就不该有**规划步骤——这正是用户说的"可能只有复杂任务才会有"。对应：方案 B 在无 todo 时退回活动区，不强造规划。若希望复杂任务"更稳地"产出规划，属提示词调优（§7），不在本面板范围。

### 5.2 「状态步骤和实际一致」= 状态对齐

两个失配方向：

- **方向一：实际做完了，步骤还停在 in_progress（最常见担忧）。**
  - 本质：**模型没回头调 `todowrite` 标完成**，不是前端同步 bug。后端是真相源，我们忠实反映模型写了什么，**不能凭空捏造完成**。
  - 缓解：复用 discussions/022 已建立的**回合结束判定（后端 `session.status` 真相）**——当回合已结束（idle）但仍有 `in_progress` 残留时，把图标从"转圈"改为**静态"未确认/已暂停"提示**，而非永久转圈误导用户。即"不假装完成，但也不假装还在跑"。
- **方向二：多出/错位的步骤。** 整表替换语义下不存在——最新整表即权威，旧步骤被整体覆盖。

### 5.3 跨会话不串（Team / 多委派）

plan 按 `sessionID` 取（OpenCode todo 按 session 持久化；ACP plan part 也带 sessionID）。面板必须**严格按当前查看的会话 ID 取 plan**。结合 ADR-035 的 `ownerSessionId` 过滤：
- 单 agent / 普通会话：取本会话 plan。
- **Team（已拍板 Q3）**：**只显示主 agent（Leader/当前会话）的规划，不聚合 delegate 子会话的规划**。即面板 = 当前查看会话的 plan，逻辑与单会话完全一致，无需特殊聚合 → 实现最简、也不会出现子会话规划串显。子会话各自的规划在切到该子会话时自然显示。

---

## 6. 数据模型 & 链路设计（方案 B 草案）

**统一前端模型**（与后端解耦，便于跨后端归一）：

```ts
interface PlanStep {
  content: string
  status: "pending" | "in_progress" | "completed" | "cancelled" // ACP 只产前三种
  priority?: "high" | "medium" | "low"
}
// 面板状态：按 sessionID 缓存的 PlanStep[]（取最新整表）
```

**归一化落点：在 connector 层把两后端归一成同一个 `plan.updated` 事件 + `getPlan(sessionId)` 能力**（connector 本就是干这个的；今天它对 plan 只是假透传，要补真归一）：

| 后端 | 实时事件 → 归一为 `plan.updated {sessionID, entries: PlanStep[]}` | 水合 `getPlan(sessionId)` |
|------|------|------|
| OpenCode | `backends/opencode.ts` 把 SSE `todo.updated` 映射为 `plan.updated`（字段几乎同形） | `GET /session/{id}/todo` |
| ACP | `turn-shaper.onPlan()` 发结构化 plan → `backends/acp.ts` 映射为 `plan.updated` | 从 `fetchHistory` 最近结构化 plan part 取（无 REST） |

**链路**：

```
进入/切回会话 ──► connector.getPlan(id)  ─┐  (OpenCode=REST / ACP=历史 plan part)
                                          ├─► 水合 planCache[sessionID]
实时 plan.updated {sessionID, entries} ──┘    (整表替换)
                                                      │
                                                      ▼
       回合结束判定(session.status, 来自022) ──► in_progress 残留降级展示
                                                      ▼
   ProgressPanel: 有 PlanStep → 规划清单(主区) ; 无 → 仅活动区(B)
   工具流水(extractToolSteps) ─────────────────────► 活动次级区(B，常在/可折叠)
```

**改动面（预估，待细化）**：
- `core/api-client`：暴露 `GET /session/{id}/todo` + `todo.updated` 类型（SDK 已有 `EventTodoUpdated`/`Todo`）。
- `agent/acp-client`：`turn-shaper.onPlan()` 改发**结构化 plan part**（停用 `formatPlan` 压文本）；保留聊天内渲染（见 §3.5 行为变更注意）。
- `core/connector`：`backends/opencode.ts` + `backends/acp.ts` 各自把后端 plan 映射为统一 `plan.updated`；新增 `getPlan(sessionId)` 分后端实现。
- `use-session-plan.ts`（新 hook）：`getPlan` 水合 + 订阅 `plan.updated` + 按 sessionID 缓存（与现有 message 缓存解耦，避免互相污染）。
- `progress-panel.tsx`：主区渲染 `PlanStep[]`；现有 `extractToolSteps` 迁到"活动"次级区（方案 B）。
- `chat/execution-flow.tsx`：ACP plan 从「深度思考」改渲染为「任务规划」结构化行（两 surface 一致）。

---

## 7. 决策与剩余边界

**已拍板（2026-06-29）**：
1. **Q1 形态 = 方案 B**：规划清单为主区 + 工具流水降级为「活动」次级区兜底简单任务。
2. **Q2 跨后端 = 连带做 ACP plan 归一**：本期同时覆盖 OpenCode todo 与 ACP plan，统一成 `plan.updated` + `PlanStep`（否则 ACP 会话面板恒空）。注意 ACP 侧需改 `turn-shaper`（我们代码、无 vendor patch）。
3. **Q3 Team 范围 = 只显示主 agent（当前会话）的规划**，不聚合 delegate 子会话 → 实现 = 单会话逻辑，最简且天然不串显。

**剩余可在实现期定的小边界（非阻塞）**：
- **stuck in_progress 文案**：回合 idle 后残留 in_progress 的措辞（"已暂停/未确认/回合已结束"）——实现期定，倾向"回合已结束"+静态图标。
- **priority 呈现**：OpenCode 有 priority、ACP 可选有。v1 建议按原序（OpenCode `position` / ACP entries 顺序），不重排，可对 high 加一个小标记。
- **ACP 回合中途切走的水合缺口**：v1 用历史 plan part 重建；若实测有滞后缺口，再补 ACP sidecar plan 快照端点（§8 后续）。
- **提示词调优（范围外，仅记录）**：若复杂任务"该有规划却没产出"，可微调 `todowrite.txt` / ACP agent 提示鼓励规划——另一议题，不混入本面板改造。

---

## 8. 落地拆解（先不执行，待拍板）

> 用户明确：方案完备后再启动开发。以下为拍板后（B + ACP + 单会话范围）的建议顺序。

- **Phase 1（统一 plan 数据层 + OpenCode）**：api-client 暴露 todo REST + `todo.updated` 类型 → connector 加 `plan.updated` 归一 + `getPlan()`（OpenCode 分支）→ `use-session-plan` 水合+订阅+按 sessionID 缓存 → 单测（整表替换/切回水合/空态）。
- **Phase 2（ACP plan 归一）**：`turn-shaper.onPlan()` 改发结构化 plan part（停 `formatPlan` 压文本）→ connector ACP 分支映射 `plan.updated` + `getPlan`（历史重建）→ `execution-flow.tsx` ACP plan 从「深度思考」改「任务规划」结构化行 → ACP 会话验证（含切回）。
- **Phase 3（面板形态 B）**：`ProgressPanel` 主区渲染 `PlanStep[]`（图标对齐 pending/in_progress/completed/cancelled + `x/y` 计数）+ 工具流水降为「活动」次级区（可折叠）+ 回合结束判定接入 stuck in_progress 降级。
- **Phase 4（增强，可选）**：方案 C（工具调用按时间窗归属到 step）；点击步骤跳转对应消息；priority 视觉；（按需）ACP plan 快照端点。
- **验收**：OpenCode + ACP 各跑复杂任务真机（含切走再切回，对齐 022 验收模式）+ 简单任务（无规划退活动区）+ Team 切到不同会话规划各自正确不串 + headless 回归。

**vendor bump 连带**（写入 Pending Issues）：本方案基于 **TodoWrite 整表语义**。若 bump 到引入 `TaskCreate/TaskUpdate` 增量语义的 OpenCode 版本，§5 的"取最新整表"必须改为"按 taskId 累积合并"，且新增 `deleted` 状态与 `blockedBy` 依赖渲染——届时复核本文 §2/§5/§6。

---

## 9. 结论

- **Q1（已定=方案 B）**：当前是"工具流水挂了规划的名"，改为**任务规划步骤为主区 + 工具流水降级活动次级区兜底**，与主流收敛、与上游已有数据对接。
- **Q2（已定=连带 ACP）**：完整性与对齐**靠"后端真相 + 整表语义 + connector 归一"而非前端拼装**。两后端都整表（天然防漏步/防幽灵步），归一成统一 `plan.updated`+`getPlan`；OpenCode 走 REST 水合（解决切回丢失），ACP 走历史 plan part 重建（无 REST 的等效水合，且需把 `turn-shaper` 现在压成文本的 plan 改回结构化）。唯一无法自动消除的是"模型忘标完成"，用回合结束判定降级展示而非捏造。
- **Q3（已定=单会话范围）**：Team 只显示当前/主 agent 会话规划，不聚合子会话 → 实现最简、不串显。
- **关键风险点（实现期盯）**：① ACP 把 plan 压成 reasoning 文本是历史包袱，改 `turn-shaper` 时别让聊天丢掉 plan 展示；② ACP 无 REST，回合中途切走的水合靠历史，若有缺口再补 sidecar 端点；③ vendor bump 到 Task tools 增量语义会推翻"取最新整表"，须复核（见下）。

**下一步**：方案已完备且三决定锁定，可正式化为 ADR（接 ADR-036 后下一号）并按 §8 Phase 1→4 开工。
