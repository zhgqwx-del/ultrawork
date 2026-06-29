# ADR-038: 右侧栏「任务规划进度」面板（plan 作会话级状态，跨后端归一）

**状态**: Accepted（✅ 已实现 — 真机+真模型〔qwen3.7-max〕+ACP+切回 e2e 验收；完整调研/论证见 discussions/024）
**日期**: 2026-06-29
**关联**: discussions/024（现状诊断 + 主流调研 + 三路实现级核验）· discussions/022 + ADR-035（会话忙碌态以后端真相为源 / `ownerSessionId` 范围）· ADR-027 + discussions/014（ACP 事件归一为 opencode 形状）· ADR-036（`todowrite` 属 EAGER 永不折叠，规划能力始终可用）

## 背景

右侧栏「计划执行进度」面板名不副实：`ProgressPanel` + `extractToolSteps()`（`packages/client/desktop/src/components/session/progress-panel.tsx`）把 assistant 消息里**所有工具调用**（read/bash/edit…）平铺成一条流水，既无"任务"也无"规划"语义，粒度也和用户心智不符（一个规划步骤底层可能是十几次工具调用）。

主流（Claude Code TodoWrite/Task tools、Cursor Plan Mode、Codex、Cline）都把这块做成**任务规划清单**，工具调用流水属另一层"活动/可观测性"。

关键事实（discussions/024 三路代码核验）：

1. **OpenCode 已内置完整 todo 子系统且数据真在 SSE 线上**：`todowrite` 工具 + 按 session 的 SQLite 持久化 + `GET /session/{id}/todo` 快照 + `todo.updated` SSE 事件（`{sessionID, todos[]}`）。`/event` 端点 `Bus.subscribeAll()` **无白名单全量转发**，connector 原样透传 → `todo.updated` 已到达 desktop（被 catch-all 接住），只是**前端从没消费**。Todo 是**整表替换**语义（每次给完整数组）。
2. **ACP plan 已在流但被压扁丢了结构**：ACP `session/update:plan` → `turn-shaper.onPlan()` 把整表 `PlanEntry[]` `formatPlan()` 成纯文本塞进一个 `reasoning` part，前端当「深度思考」折叠块渲染。结构在过 connector 前即销毁。ACP `PlanEntry = {content, status, priority?}`，status 仅 `pending|in_progress|completed`（比 OpenCode 少 `cancelled`），同样整表语义。
3. **两后端水合能力不对称**：OpenCode 有 REST 快照 + 持久化；ACP 无 REST plan 端点（仅有 `/acp/session/:id/messages` 消息快照、`/acp/global/events` 状态流）。
4. **desktop 消费侧就绪**：message reducer 对未知 part 类型透传保留（MessagePart 有 fallback）；`RightSidebarSection` 已支持多个可折叠 section；忙碌态真相 `activeSessionIds`/`sessionBusy`/`isAgentActive`（discussions/022）可复用。

## 决策

把面板从「工具调用流水」改造为「**任务规划进度**」，并把 **plan 作为会话级状态**（而非 message part）在 connector 层归一，两后端对称（live 事件 + REST 快照）。

### 1. 面板形态 = 方案 B（规划为主 + 活动兜底）
- 主区「任务规划」：渲染 `PlanStep[]`（图标 pending/in_progress/completed/cancelled + `x/y` 计数）。
- 次级区「执行活动」：现有 `extractToolSteps` 逻辑迁此（常在、可折叠），保留对"AI 在做什么"的可观测性。
- 简单任务无 plan 时只显示活动区，不强造规划、不出现空面板。

### 2. plan 不新增 message part 类型，作会话级状态归一为统一事件 + 快照
统一前端模型：`PlanStep { content; status: "pending"|"in_progress"|"completed"|"cancelled"; priority? }`（ACP 只产前三种）。

| 后端 | live：归一为 connector `plan.updated {sessionID, entries: PlanStep[]}` | 水合：connector `getPlan(sessionId)` |
|------|------|------|
| OpenCode | `backends/opencode.ts` 的 `onEvent` 把原生 `todo.updated` 转成 `plan.updated`（字段近同形） | `GET /session/{id}/todo` |
| ACP | `turn-shaper.onPlan()` **停止压成 reasoning 文本**，改发独立 plan 事件 → acp-server `/acp/session/:id/events` 转发 → `backends/acp.ts` 映射 `plan.updated`；并在 session 内存留最新 plan | **新增** `GET /acp/session/:id/plan` 快照端点（acp-server 既有 Hono 模式） |

两后端都整表替换 → "取最新整表"即完整；前端经新 hook `use-session-plan`（getPlan 水合 + 订阅 plan.updated，按 sessionID 缓存、独立于 message 缓存）。

### 3. 完整性 / 状态对齐
- **完整性**：进入/切回 `getPlan()` 水合权威快照（OpenCode=REST 持久化、ACP=会话内存快照，均跨前端切换不丢，同 022「后端真相为源」）+ 实时 `plan.updated` 整表替换。整表语义天然防漏步/防幽灵步。
- **对齐**：唯一治不了的是"模型做完忘标完成"（模型行为非同步 bug），**不捏造完成**；复用 022 的 `sessionBusy`/`isAgentActive`——回合已 idle 但仍有 `in_progress` 残留时，图标从转圈改为静态「回合已结束」提示。
- **Team 范围（Q3）**：面板严格按当前查看会话 ID 取 plan，**只显主/当前 agent 规划，不聚合 delegate 子会话** → 实现 = 单会话逻辑，天然不串显（结合 ADR-035 `ownerSessionId`）。

### 4. 改动点清单（按 Phase）
- **P1 统一数据层 + OpenCode**：api-client `getTodos()`（`/session/{id}/todo`）；connector `events.ts` 加 `plan.updated` 类型 + `sessionIdOf` case；`backends/opencode.ts` onEvent 映射 `todo.updated`→`plan.updated` + `getPlan()`；`use-session-plan` hook。
- **P2 ACP 归一**：`turn-shaper.onPlan()` 发独立结构化 plan 事件（弃 `formatPlan`）；acp-server 新增 `GET /acp/session/:id/plan` + session 留存最新 plan；`backends/acp.ts` 映射 `plan.updated` + `getPlan()`。
- **P3 面板形态 B**：`progress-panel.tsx` 主区渲染 `PlanStep[]`；`extractToolSteps` 迁「执行活动」次级区；接 022 残留 in_progress 降级；i18n 新增「任务规划/执行活动/回合已结束」。
- **P4 增强（可选）**：聊天内结构化 `PlanRow`（取代「深度思考」误渲染，如需 plan 内联）；方案 C（工具调用按时间窗归属到 step）；点击步骤跳转消息；priority 视觉；ACP plan 回合中途切走的快照补强。

## 替代方案

- **保持现状（工具流水）**：否决——名不副实、粒度错位、与主流背离。
- **ACP plan 复用 reasoning part + metadata**：否决——`reasoning` 语义本是"模型思考"，挪作 plan 会与真 thought 混渲、误导，渲染层歧义。
- **ACP plan 走新增 message part 类型（靠消息历史水合）**：024 初版倾向此法以省一个端点，本 ADR **否决/升级**——会污染 message.parts 语义、需新 part 类型穿过"opencode 形状"契约、且把会话级状态错挂在回合消息上。改为「独立事件 + 快照端点」后两后端真正对称、与 OpenCode `todo.updated`/REST 同构、与真 reasoning 解耦，仅多一个低成本端点。
- **本期只做 OpenCode、ACP 后补**：否决（用户已定）——否则 ACP 会话面板恒空，体验割裂。
- **Team 聚合子会话规划**：否决（用户已定 Q3）——增复杂度且易串显；切到子会话自然显示其规划即可。

## 后果

- ✅ 面板名副其实，与主流收敛；规划为主 + 活动兜底，简单任务不空。
- ✅ plan 作会话级状态、connector 归一为单一 `plan.updated`+`getPlan`，desktop 对后端无感；OpenCode 几乎零后端改动（数据现成）。
- ✅ 完整性/对齐靠"后端真相 + 整表语义"而非前端拼装；切回不丢（同 022）。
- ✅ ACP 修掉「plan 被当深度思考」的历史误渲染；真 reasoning 与 plan 解耦。
- ⚠️ **ACP 需改 `turn-shaper`（我方代码、无 vendor patch）+ 加一个快照端点**；改动时确保不误伤真 reasoning，且（若 P4）聊天内 plan 渲染一致升级。
- ⚠️ **状态枚举不对称**：OpenCode 有 `cancelled`、ACP 无 → 统一模型取超集，ACP 永不产 `cancelled`。
- ⚠️ **vendor bump 连带**：本方案基于 OpenCode **TodoWrite 整表语义**。若 bump 到引入 `TaskCreate/TaskUpdate` **增量 patch** 语义的版本，§3 的"取最新整表"须改为"按 taskId 累积合并"，并新增 `deleted` 状态 / `blockedBy` 依赖渲染——届时复核本 ADR 与 discussions/024 §2/§5/§6。
- ⚠️ "模型忘标完成"无法自动消除，仅以"回合已结束"降级展示缓解；如需更稳的规划产出，属提示词调优（另一议题）。
