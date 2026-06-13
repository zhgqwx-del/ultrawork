# 019 · 流水线 UI 收纳与形态（编排 surface 的「另一半」）

> **状态**：✅ 已拍板待开工（2026-06-13。D1=伞名「自动化」+页内「流水线·Fan-out」/ D2=保留侧栏 footer 二级微调 / D3=做视觉对齐 / D4=做自我说明。承接 018 收尾时 Q2 三项反馈拍板：「值得单开一个 discussion 先拍形态再动手」）
> **日期**：2026-06-13
> **缘起**：018 把 **Team 协作**（agent 驱动、对话式即兴委派）从 `/orchestration` 抽进主聊天流（Home segmented + 侧栏混排 + Session 页合流），`/orchestration` 回归为**纯流水线页**（代码驱动 recipe）。Team 拿到了一等公民的入口与视觉，**流水线却被留在原地**——侧栏底部一个 `Workflow` 按钮，step 行还是裸 `<select>`，与 Team 的 agent-avatar 卡片视觉割裂。018 收尾讨论时定性：删可惜（唯一代码驱动 recipe 入口）、不并进 Team（心智不同，016/017/018 刻意分开），**给它一个稳定二级入口 +复用 agent-avatar/chip 视觉对齐 +一句话说明**；先单开 discussion 拍形态。
> **承接**：[018](./018-unified-orchestration-ux.md)（Team 进主流程）· [017](./017-team-page-agent-driven-orchestration.md)（Team 页独立 surface）· ADR-031 D-1（代码驱动面）/ D-7

---

## TL;DR

1. **流水线 ≠ Team，是编排的「另一半」**：Team = **对话式 / 即兴 / 不确定**（你跟 Leader 聊，它当场决定派谁）；流水线 = **预定义 / 确定性 / 无对话**（你写死 DAG，跑出来就是那样）。018 刻意分开是对的——两套心智不该挤一个入口。本讨论**不动这条边界**，只解决流水线这一半的「入口稳定性 + 命名 + 视觉对齐 + 自我说明」。
2. **入口其实已存在但偏弱**：侧栏底部 footer 一个 `Workflow` 图标按钮（展开态）+ 折叠态图标，标签 `orchestration.title` = 「流水线」/「Pipelines」。问题不是「没入口」，是**不稳定/不自明**——夹在 Channels/连接状态/用户头像里，无图标语义区分度，新用户不知道点进去是什么、何时用。
3. **四个待拍板点**：**D1 命名**（流水线 / 编排 / 自动化）· **D2 入口位置**（保留 footer 二级 / 提升 / 并入某处）· **D3 视觉对齐**（step·worker 行复用 agent-avatar + chip）· **D4 自我说明**（页内一句话「这是什么 / 何时用 / 与 Team 区别」）。**功能逻辑零改动**（recipe / DAG 执行器 / run 列表 / Fan-out 全复用），改的只是 surface + 文案 + 行内视觉。

---

## 1. 现状（代码核实，2026-06-13）

| 位置 | 现状 | 文件 |
|------|------|------|
| 入口（展开） | 侧栏底部 footer 区，`Workflow` 图标 + 「流水线」文字按钮，与 Channels / ConnectionStatus / 用户头像同区堆叠 | `left-sidebar.tsx:288` |
| 入口（折叠） | 仅 `Workflow` 图标按钮 + tooltip「流水线」 | `left-sidebar.tsx:368` |
| 页面 | `TopBar 流水线` + `PipelineTab`；纯净，无任何「这是什么」说明 | `pages/Orchestration.tsx` |
| 模式 | segmented「流水线 \| Fan-out 并行」，共用 DAG 执行器 | `pipeline-tab.tsx` |
| step / worker 行 | **裸 `<select agentId>` + textarea + model 下拉**，无 agent 身份感（与 Team 的 TeamMemberSelect agent-avatar 卡片视觉割裂） | `pipeline-tab.tsx` `StepDraft` / `EMPTY_STEP` |
| 命名 | `orchestration.title` 已是「流水线」；但 i18n key 前缀仍是 `orchestration.*`（历史遗留，017 时叫「编排」页） | `i18n-context.tsx:61/628` |

**核心症结**：018 给了 Team「身份 + 入口 + 视觉」三件套，流水线三样都偏弱——**入口埋在 footer、无自我说明、行内无身份感**。它不是坏，是「没被收纳进 018 建立的新视觉语言」。

## 2. 不变量（不碰）

- 流水线 / Team 的**心智边界**：确定性 recipe vs 对话式委派，分两个 surface（018 已拍）。
- DAG 执行器、Pipeline / Fan-out recipe 结构、run 持久化、worktree 隔离、step 级 model 覆盖——**功能逻辑全部不动**。
- `/orchestration` 路由保留（深链接 / 侧栏入口指向它）。

## 3. 形态草案与拍板点

### D1 · 命名（这是「流水线」还是「编排」还是「自动化」？）

| 选项 | 含义 | 利 | 弊 |
|------|------|----|----|
| **a. 保留「流水线」**（现状） | Pipeline 直译，准确描述「串行/DAG recipe」 | 已落地、零改动、技术准确 | Fan-out 模式其实不止「线」；对非技术用户略生硬 |
| **b. 改「编排」** | Orchestration | 涵盖 pipeline+fanout | **与 Team 心智撞车**——018 后用户心里「编排=跟 Leader 协作」，再叫这个会混 |
| **c. 改「自动化」** | Automation | 点出本质：预定义、确定性、无人值守 | 与「流水线」并存可能；范畴略大 |
| **d. 伞名 +子名**：入口「自动化」，页内模式仍「流水线 / Fan-out」 | 入口讲价值，页内讲机制 | 入口自明 +机制准确 | 多一层命名 |

> **建议**：**d**（入口「自动化」/页内保留「流水线·Fan-out」）或 **a**（全保留「流水线」）。**避免 b**——「编排」语义在 018 后已归 Team。倾向 **d**：入口名回答「我为什么点它」（把重复任务自动化），页内名回答「它怎么跑」。

### D2 · 入口位置（footer 二级够不够稳定？）

| 选项 | 说明 |
|------|------|
| **a. 保留 footer 二级**（现状微调） | 仍在侧栏底部，但与 Channels/状态拉开间距、加分隔、图标/文案更自明 |
| **b. 提升到侧栏顶部主区** | 与「新任务 / 会话列表」并列做一等入口 |
| **c. Home 也给一个入口** | 在 Home 工具行（018 已重排）加「自动化」快捷，与「单 Agent\|Team」并置 |

> **建议**：**a**（保留二级，符合 Q2「稳定二级入口」定调——流水线受众偏高级、频次低，不该与日常聊天抢一等位）。**不选 b**（会喧宾夺主）。**c 可选**：若希望发现性更强，Home 工具行加一个轻量「自动化」入口跳 `/orchestration`，但不并入聊天（守住心智边界）。先 a，c 留作可选增强。

### D3 · 视觉对齐（行内复用 agent-avatar + chip）

- step / worker 行的「选 agent」从裸 `<select>` → 复用 **agent-avatar 首字母头像 + chip**（与 018 的 TeamMemberSelect / AgentSelector 卡片同一视觉语言）。
- 已有可复用件：`agent-avatar`（首字母头像 + 状态点）、AgentSelector 卡片下拉、chip flex-wrap 兜底（018 ab08528 落地）。
- run 列表 / run 详情的 agent 标识同步用 agent-avatar，与主聊天 delegate 卡片一致。

> **建议**：**做**。低风险纯视觉收敛，且是 018 视觉升级的自然延伸（018 议题 B 只覆盖了 Team，流水线没轮到）。

### D4 · 页内自我说明（一句话：这是什么 / 何时用）

- 页顶加一行说明 + 「流水线 vs Team」的极简对照（何时用哪个）。草案文案：
  - **流水线**：把多步骤任务写成**固定配方**，按顺序（或并行 Fan-out）自动跑，每步产物喂下一步。**适合**重复、确定的工作流。
  - **想跟 AI 边聊边定怎么做？** → 用 **Team 协作**（Home 新建任务时选）。
- 空态（无 run 时）尤其需要——当前空态是冷的表单，新用户无从下手。

> **建议**：**做**。配合 D3，把「冷工具」变成「能自解释的功能」。

### ✅ 拍板结果（2026-06-13）

| 点 | 拍板 | 落地要点 |
|----|------|---------|
| **D1 命名** | **伞名「自动化」+ 页内「流水线·Fan-out」**（选项 d） | 入口文案改「自动化」；页内模式名「流水线 / Fan-out 并行」保留；i18n key 前缀 `orchestration.*` 不强求重命名（只改 displayed 文案，避免全引用改动） |
| **D2 入口** | **保留侧栏 footer 二级，微调**（选项 a） | footer 与 Channels/状态拉开间距 + 分隔；图标/文案更自明（标签「自动化」）；不进 Home、不提升一等位 |
| **D3 视觉** | **做** | step/worker 行裸 `<select>` → agent-avatar 首字母头像 + chip；run 列表/详情 agent 标识同步对齐主聊天 delegate 卡片 |
| **D4 说明** | **做** | 页顶一句话说明 + 「流水线 vs Team 何时用」极简对照；暖化空态（当前冷表单） |

## 4. 工程量评估（全部 surface 层，功能零改动）

| 项 | 量 | 风险 |
|----|----|------|
| D1 命名 | i18n 文案 +（可选）key 前缀重命名 | 低（key 重命名涉及全引用，可只改 displayed 文案不动 key） |
| D2 入口 | left-sidebar footer 微调；可选 Home 工具行加一项 | 低 |
| D3 视觉 | pipeline-tab step/worker 行换 agent-avatar + chip；run 列表对齐 | 低（复用现成件） |
| D4 说明 | 页顶说明 + 空态文案 + 对照 | 低 |

预计 1-2 个 commit，无新依赖，无后端改动，无新测试面（纯渲染；现有 orchestrator/desktop 测试不受影响）。

## 5. 建议节奏

1. **本讨论拍板 D1-D4**（命名 / 入口 / 视觉 / 说明）。
2. 一次性落地（surface + 文案 + 行内视觉），GUI 走查（隔离栈，参 018 harness 教训）。
3. 收尾：CHANGELOG、本讨论状态转 ✅、README 索引、（命名若改）i18n。
4. 落地后 → 本分支 `feat/agent-os-phase0` 编排 surface「整体完成」，接 hermes（视场景）或整体合 main。

> **节奏与分支**：019 在 `feat/agent-os-phase0` 分支继续，**整体完成后一次合入 main**（与 017/018 同策略，用户已定）。

### 来源
- 018 收尾 Q2 拍板（MEMORY「下一步与待决」2026-06-13）；代码核实 `left-sidebar.tsx` / `pages/Orchestration.tsx` / `pipeline-tab.tsx` / `i18n-context.tsx`（2026-06-13）。
