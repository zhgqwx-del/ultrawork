# ADR-029: 主对话「执行流程」收纳 — 回合级消息分组与过程/答案分层

**状态**: Accepted (✅ 已实现)
**日期**: 2026-06-06
**关联**: ADR-004 (Structured Message Parts), ADR-020 (配置隔离), ADR-021 (长对话性能优化)

---

## 背景

### 问题描述

主对话区在多步任务（工具循环）下显得「碎」：每一段思考（`reasoning`）、每一次工具调用（`tool`）、每一条 token 统计（`step-finish`）都被平铺成一张独立卡片竖排堆叠，最终答案淹没在中间过程里。参考竞品（JVS Copilot）把整回合的中间过程收进一个可折叠的「执行流程」容器，过程折叠后答案干净呈现——目标是对齐这种「过程/结果分层」的组织方式。

### 根因（关键发现）

通过源码与实测双重验证确认：**OpenCode 一个 user 回合会产出 N 条 assistant message，而非一条。**

`vendor/opencode/.../session/prompt.ts` 的生成主循环中，每经过一次工具循环 step 就 `MessageID.ascending()` 新建一条 assistant message：

```ts
// session/prompt.ts —— step 循环（简化）
while (true) {
  // 若上一条 assistant 已 finish 且非 "tool-calls" 且无 tool 调用 → break（回合结束）
  if (lastAssistant?.finish && !["tool-calls"].includes(lastAssistant.finish)
      && !hasToolCalls && lastUser.id < lastAssistant.id) break
  step++
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),     // ← 每个 step 新建一条 assistant message
    parentID: lastUser.id,         // ← 全部指向同一个触发的 user 消息
    role: "assistant", ...
  }
  yield* sessions.updateMessage(msg)
  // 流式把 parts 灌进 msg；finish === "tool-calls" → 继续 → 下一条 message
}
```

客户端 `use-session-messages.ts` 按 `messageID` 聚合 part（同 messageID 的 part 进同一条消息，新 messageID 新建一条），`message-list.tsx` 再把每条 assistant message 各渲染成一个 `AssistantMessage`。于是 **N step = N 条 message = N 摞卡片**，这就是「碎」的根因。

### 验证（动手前已钉死）

1. **源码源**：`vendor/opencode` 为 git submodule，pin 在历史 commit `8e9e79d2`（2026-04-03，已是 Effect/SQLite 重写版），**非社区最新**。本 ADR 的源码结论针对该 pin 成立。
2. **经验源**：本项目启用配置隔离（ADR-020），聊天历史落在 XDG 数据目录 `~/.local/share/ultrawork/opencode.db`（patch 中 `path.join(xdgData, app)`，app=`ultrawork`）。直接查该库统计「每个 `parentID` 对应几条 assistant message」：

   | 每回合 assistant 消息数 | 回合数 |
   |----|----|
   | 1（简单问答） | 9 |
   | 2 | 5 |
   | 4 | 1 |
   | **15** | 1 |

   其中 15 条的回合，`finish` 序列为 **14×`tool-calls` + 1×`stop`**，与源码 step 循环完全吻合。

> 这两个来源恰好就是动手前用于取证的来源——pin 的源码 + 隔离后的真实库——因此补充信息对方案/实现**无需任何修正**，只是确认取证基础正确。

---

## 设计决策

### 核心：回合级分组 + 过程/答案分层

把渲染从「按 message 平铺」改为「按回合（turn）组织」：

- **回合边界**：一条 user message + 其后连续的 assistant message（`MessageID.ascending()` 保证有序连续）。分组在 `message-list.tsx` 完成（不能放在只见单条 message 的 `AssistantMessage` 里）。
- **过程 / 答案切分**：最终答案 = 回合**最后一条** message 的输出 part（`text`/`file`/`patch`）；其余全部（更早各条的全部 part + 最后一条的 `reasoning`/`step-*`）= 过程。这与「最后一条 message 必为 `finish≠tool-calls` 的答案步」一致。**额外约束**：若最后一条仍含 `tool` part，则它是「在途工具步」（循环保证答案步无 tool 调用），其全部 part 归过程、答案暂空——避免流式中途把工具步的叙述 text 误显为最终答案。
- **回合是否在生成**：不取瞬时的 `streamingMessageId`（多步任务里它在 step 间与工具执行期会反复置 null），改由「最后一条消息 `finish` 是否为终态（存在且≠`tool-calls`）+ 是否末回合 + 未被 stop」综合判定。这样 `isStreaming` 在整回合内稳定为 true、结束时翻转一次，执行流程容器不会中途折叠抖动。
- **过程收纳**：过程 part 收进可折叠的 `ExecutionFlow`，行式时间线，每行一项（思考/工具/中间叙述）。**外观无卡片包裹**（对齐参考图）：仅「标题行 + 左侧竖线时间线」，去掉圆角边框/底色/分隔线；标题行保留点击切换与轻量 hover 高亮。
- **时间线细节**：左侧竖线为 body 容器单条 `border-l`（非每行各一段），`ml-[7px]` 对齐标题状态图标正中下方，构成贯穿所有步骤的连续线；执行流程与下方答案以 `mt-2 mb-3` 拉开呼吸感。
- **状态图标 + 动效**：标题图标按 spinner（流式）→ `CircleStop`（已停止，灰）→ ✗（出错）→ ✓（完成）优先级显示（`isStopped` 由 message-list 透传）；reasoning 行「已开始未结束」（`time.start` 有、`time.end` 无）时大脑图标 `animate-pulse`，工具行沿用 running spinner。
- **答案直出**：答案 part 在容器外正常 markdown 渲染。
- **空过程不显容器**：若过程无可见行（纯问答，只有 `step-finish`），不渲染容器，直接出答案——比参考图更干净。

### 四个交互取舍（已与用户确认）

| 决策点 | 选择 | 说明 |
|--------|------|------|
| 执行流程边界 | **整回合合并** | 跨多条 assistant message 合并为一个容器，贴近参考图 |
| 工具 INPUT/OUTPUT | **行内二级展开** | 流程内工具压成一行，点行再展开看 JSON，渐进披露 |
| 中间叙述文本归属 | **末段为答案** | 仅最后一条 message 的输出 part 是答案，其余叙述 text 进流程 |
| 折叠与流式 | **流式展开 / 完成折叠** | 生成中容器展开实时显示，回合结束自动折叠为 summary |

### 容器 summary 聚合

- 步数 = 回合内 assistant message 条数。
- token / cost = 累加各 message 的 `info.tokens`/`info.cost`（缺失时回退累加 `step-finish` part）。
- 耗时 = 首条 `time.created` → 末条 `time.completed`（流式中不显）。
- 状态图标 = 流式 spinner / 出错 ✗ / 完成 ✓。

### 回合页脚（对齐参考图 good5）

回合结束后在答案下方渲染一条明细页脚（沿用 execution-flow 重构前「每步统计行」的信息，但收成整回合一行）：

`时间戳 · 输入: N · 输出: N · 推理: N · 缓存: Nr/Nw · $cost · 模型: <id>`

- 仅在 `!isStreaming` 且有 token 或完成时间时显示；推理/缓存/成本为 0 时省略对应项。
- 时间戳取末条 `time.completed`（回退 `created`），`toLocaleString()`；模型取末条 `info.modelID`；缓存读写累加自 `info.tokens.cache`（回退 step-finish）。
- 与容器头不重复：头部给概览（步数·耗时·总 tok·$），页脚给明细（时间·分项 token·缓存·模型）。

---

## 考虑过的替代方案

### A1. 按位置分组 vs 按 parentID 分组

`MessageInfo.parentID` 客户端已暴露，理论上可直接 `group by parentID`。但流式期间，由 `message.part.updated` 即时合成的 assistant message 在 `message.updated` 到达前没有 `parentID`。故**主用位置分组**（user 后连续 assistant），`parentID` 仅作语义佐证。位置分组对窗口化（`displayMessages` 在 user 边界切片）也天然安全。

### A2. 末段答案 = 「尾部连续输出 part」vs「最后一条 message 的输出 part」

若按「尾部连续 text/file/patch」回溯，末条 message 常以 `step-finish` 结尾会打断连续性、误判答案为空。改用「最后一条 message 的输出 part」，与 step 循环语义对齐、顺序无关，更稳。

### A3. 把工具详情移到右侧面板 / 完全砍掉

均被否。行内二级展开在「主对话干净」与「可回看调试信息」之间取得平衡，不引入跨面板跳转。

---

## 实施

纯前端改动，隔离在 chat 渲染层；不碰 SSE 处理、状态管理、API。

| 文件 | 改动 |
|------|------|
| `components/chat/message-parts.tsx` | **新建**：抽出共享 `MarkdownContent`/`FileBlock`/`PatchBlock` + `MARKDOWN_COMPONENTS`（去重） |
| `components/chat/execution-flow.tsx` | **新建**：「执行流程」+ header summary + 行式时间线（`FlowRow`/`ReasoningRow`/`ToolRow`/`NarrationRow`/`ArtifactRow`），无卡片包裹、左侧时间线竖线。流式展开、完成自动折叠（`prevStreaming` ref 检测翻转） |
| `components/chat/assistant-turn.tsx` | **新建**：`buildTurnModel()` 拼整回合 parts → 切过程/答案 → 聚合 token/cache/cost/步数/耗时/模型/错误；答案下方渲染回合页脚 |
| `components/chat/message-list.tsx` | 改：`groupIntoTurns()` 把连续 assistant message 分组，渲染 `AssistantTurn`；streaming/stopped/`content-visibility` 上移到回合级 |
| `components/chat/assistant-message.tsx` | 改：复用 `message-parts`（去重，保留为 legacy 向后兼容组件，主路径不再使用） |
| `components/chat/index.ts` | 导出 `AssistantTurn`/`ExecutionFlow`/`message-parts` |
| `lib/i18n-context.tsx` | 加 `message.executionFlow`/`message.steps`/`message.deepThinking`/`message.cache`/`message.model`（中英） |
| `__tests__/components/chat/assistant-turn-logic.test.ts` | **新建**：`groupIntoTurns`/`buildTurnModel` 纯函数单测（8 例，含页脚聚合） |

### 验证结果

- `bun run --bun turbo run typecheck`：**5/5 通过**
- chat 组件测试：**71/71 通过**（含新增 8 例回合逻辑单测；保留的 `ReasoningBlock`/`ToolCallBlock`/`StepIndicator` 未改动）

---

## 兼容性与风险

| 风险 | 评估 | 处置 |
|------|------|------|
| 窗口化切片落在回合中间 | 低 | `displayMessages` 按 user 索引切片，窗口恒从 user 边界起，回合不被截断 |
| 多步流式回合折叠/图标抖动 | 中 → **已修复** | step 间与工具执行期 `streamingMessageId` 会置 null。改用 finish 终态 + 末回合判定，`isStreaming` 整回合稳定 |
| 流式期间工具步叙述 text 被当答案 | 中 → **已修复** | 末条含 `tool` part 即判为工具步，全部归过程，答案暂空 |
| token/cost 回退只统计首条 step-finish | 低 → **已修复** | 回退改为对所有 step-finish 完整求和 |
| `groupIntoTurns` 每次渲染重建数组 → 流式中所有历史回合 memo 失效、重算 `buildTurnModel` | 中 → **已修复** | `AssistantTurn` 加自定义 memo 比较器（按 `messages` 元素引用 + isStreaming/isStopped/onArtifactClick 比较）。历史 message 对象引用稳定（state 只换变化的那条），故仅流式回合重渲染；`onArtifactClick` 为 `useCallback([id])` 稳定引用 |
| 历史中断的回合（末条 `finish="tool-calls"`）在末回合位时显示为流式 | 低 | 仅影响崩溃/中断后重载的边缘场景；普通完成回合末条为 `stop` 终态，正常折叠 |
| legacy SSE 事件（`message.delta`/`message.completed`） | 无新增 | 未触及 SSE 处理逻辑，沿用 `use-session-messages` 现状 |

> 核心纯函数 `groupIntoTurns` / `buildTurnModel` 已导出并有单测覆盖（`__tests__/components/chat/assistant-turn-logic.test.ts`，7 例）。

### 不做的事

- 不改 SSE 协议 / 状态层 / API。
- 不跨右侧面板搬运工具详情。
- 不对历史消息做内容裁剪/压缩（保持数据完整）。

---

## 备注

vendor pin（`8e9e79d2`）若未来升级，需复验 step 循环是否仍「每 step 一条 message」——若上游改为单 message 多 step，则本 ADR 的回合分组可简化为单 message 内分区。但客户端按 `messageID` 聚合 + 位置分组的逻辑对两种形态均兼容，属向前安全。
