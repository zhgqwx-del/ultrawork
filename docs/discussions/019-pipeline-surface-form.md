# 019 · 流水线 UI 收纳与形态（编排 surface 的「另一半」）

> **状态**：✅ 已落地（2026-06-13，分支 `feat/agent-os-phase0`。D1-D5 一次性全实现，全 surface 层、功能零改动；typecheck 8/8 + desktop 159 + 隔离栈 GUI 走查 7/7。详见 §6 落地备注）。原拍板：D1=伞名「自动化」+页内「流水线·Fan-out」/ D2=footer 精简（保留二级入口）/ D3=做视觉对齐 / D4=做自我说明 / **D5=footer 去渠道 + WiFi 连接状态迁到 AgentSelector chip 按所选后端着色（顺修 opencode 硬编码 available）**。承接 018 收尾 Q2「先拍形态再动手」+ 用户 footer 两点反馈
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

### D5 · footer 区精简 + 连接状态迁移（2026-06-13 用户反馈追加）

footer 现有三类占位（`left-sidebar.tsx`）：①「自动化」入口（D1/D2）② **渠道**（`ChannelStatusBar` + 折叠态 `ChannelStatusDot`：IM 渠道 connected/total + 彩点，点击跳 Settings>channels，**无渠道时自动隐藏**）③ **WiFi「已连接」**（`ConnectionStatus` = `useSSEConnected()` 全局 SSE 心跳 = opencode 默认后端 `/event` 流是否连上）。两点反馈：

- **D5a · 去掉「渠道」**：Settings>channels 已有全部详情，footer 这条是重复。去掉展开 + 折叠两处。权衡：IM 用户失去「一眼看连接数」——但渠道是后台基础设施，真要紧的是**掉线告警**，可用「掉线 toast / Settings 入口小红点」替代常驻一行（可选、可后置）。
- **D5b · WiFi 状态迁到模型选择器**：独立「已连接」常年绿=横幅失明、且 WiFi 图标语义含糊（像网络非「opencode sidecar」）。迁到 **AgentSelector 的 trigger chip**（当前显示的模型）做红绿点，把健康信号放到「你正在对话的对象」上。
  - **⚠️ 顺带修一个失真 bug**：opencode 默认 agent 的 `status` 当前**硬编码 `"available"`**（`agent-context.tsx:23`），不反映 SSE 真连接——sidecar 挂了也显绿。
  - **着色按「所选后端」**（拍板细化版，非死板 opencode）：选 opencode → SSE 心跳（`useSSEConnected`）；选 ACP agent → 该 agent `status()`（connected/disconnected/懒连接）。语义严格正确，信息量 > 单一 opencode WiFi。
  - 基础设施已现成：`STATUS_DOT` 配色 + `connector.onStatusChange(kind,status)` + `ACPBackend.status()`；trigger chip 现**无**状态点（点只在展开下拉每行），需加。
  - 权衡：Settings/自动化页无选择器 → 失去连接信号；但 sidecar 挂时用户基本在聊天页（chip 可见）+ 发送报错兜底，可接受。

> **建议**：D5a **去**（可选保留掉线告警）；D5b **做**（按所选后端着色 + 修 opencode 硬编码）。两者都在 footer/selector 同一施工面，与 D2 一次性收拾。

### ✅ 拍板结果（2026-06-13）

| 点 | 拍板 | 落地要点 |
|----|------|---------|
| **D1 命名** | **伞名「自动化」+ 页内「流水线·Fan-out」**（选项 d） | 入口文案改「自动化」；页内模式名「流水线 / Fan-out 并行」保留；i18n key 前缀 `orchestration.*` 不强求重命名（只改 displayed 文案，避免全引用改动） |
| **D2 入口** | **保留侧栏 footer 二级**（选项 a）；随 D5 升级为「footer 精简」 | footer 去掉渠道 + WiFi 后只留「自动化」入口 + 用户/设置；图标/文案更自明（标签「自动化」）；不进 Home、不提升一等位 |
| **D5a 渠道** | **去掉**（展开 `ChannelStatusBar` + 折叠 `ChannelStatusDot`） | Settings>channels 已有详情；掉线告警（toast / 小红点）可选后置 |
| **D5b 连接状态** | **迁到 AgentSelector trigger chip，按所选后端着色** | 删 footer `ConnectionStatus`；opencode→`useSSEConnected`（**并修 `agent-context.tsx:23` 硬编码 `available`**），ACP→`status()`；trigger chip 加状态点（复用 `STATUS_DOT` + `connector.onStatusChange`） |
| **D3 视觉** | **做** | step/worker 行裸 `<select>` → agent-avatar 首字母头像 + chip；run 列表/详情 agent 标识同步对齐主聊天 delegate 卡片 |
| **D4 说明** | **做** | 页顶一句话说明 + 「流水线 vs Team 何时用」极简对照；暖化空态（当前冷表单） |

## 4. 工程量评估（全部 surface 层，功能零改动）

| 项 | 量 | 风险 |
|----|----|------|
| D1 命名 | i18n 文案 +（可选）key 前缀重命名 | 低（key 重命名涉及全引用，可只改 displayed 文案不动 key） |
| D2 入口 | left-sidebar footer 微调；可选 Home 工具行加一项 | 低 |
| D3 视觉 | pipeline-tab step/worker 行换 agent-avatar + chip；run 列表对齐 | 低（复用现成件） |
| D4 说明 | 页顶说明 + 空态文案 + 对照 | 低 |
| D5a 渠道 | 删 left-sidebar `ChannelStatusBar` + `ChannelStatusDot` 两处 | 低 |
| D5b 连接状态 | 删 footer `ConnectionStatus`；opencode agent.status 接 `useSSEConnected`（修硬编码）；AgentSelector trigger 加状态点（按 currentId 取 agent.status 着色） | 低-中（多一处 status 接线，但件已现成） |

预计 1-2 个 commit，无新依赖，无后端改动，无新测试面（纯渲染 + 一处 status 接线；现有 orchestrator/desktop 测试不受影响，selector 状态点可补一条渲染断言）。

## 5. 建议节奏

1. **本讨论拍板 D1-D5**（命名 / 入口 / 视觉 / 说明 / footer 精简 + 连接状态迁移）。
2. 一次性落地（surface + 文案 + 行内视觉），GUI 走查（隔离栈，参 018 harness 教训）。
3. 收尾：CHANGELOG、本讨论状态转 ✅、README 索引、（命名若改）i18n。
4. 落地后 → 本分支 `feat/agent-os-phase0` 编排 surface「整体完成」，接 hermes（视场景）或整体合 main。

> **节奏与分支**：019 在 `feat/agent-os-phase0` 分支继续，**整体完成后一次合入 main**（与 017/018 同策略，用户已定）。

## 6. 落地备注（2026-06-13）

D1-D5 一次性全实现，全 surface 层、功能逻辑零改动。改动文件：
- **D1**：`i18n-context.tsx` 新增 `orchestration.entryTitle`（自动化/Automation）；`left-sidebar.tsx`（展开按钮+折叠 aria/tooltip）+ `pages/Orchestration.tsx`（TopBar title）改用之。页内模式名「流水线/Fan-out 并行」+ `orchestration.*` key 前缀均保留。
- **D2/D5a**：`left-sidebar.tsx` footer 删 `ChannelStatusBar`/`ChannelStatusDot`（展开+折叠），只留「自动化」入口 + 用户/设置；删 `connection-status.tsx`（`ConnectionStatus` 组件 + barrel 导出）。`use-channels.ts` 保留（Settings 仍用）。
- **D5b**：`agent-context.tsx` 修 opencode 默认 agent `status` 硬编码 `available`——改由 `useSSEConnected()` + `useMemo` 派生（connected/disconnected）；`agent-selector.tsx` trigger chip 加状态点（`STATUS_DOT[current.status]`），opencode→SSE 心跳、ACP→该 agent `status()`。
- **D3**：`pipeline-tab.tsx` step/worker 行 `<select>` 包进 `AgentAvatar` chip（`<label>` 内嵌 select 零行为改动）+ run 列表行头像簇；`pages/OrchestrationRun.tsx` step 卡片裸 `agentId` 换 `AgentAvatar` + 显示名。
- **D4**：`pipeline-tab.tsx` 顶部 `<header>` 加 `orchestration.intro` + `introVsTeam`；runs 空态加 `noRunsHint`。

验收：typecheck 8/8、desktop vitest 159 全绿；隔离栈 GUI 走查（opencode :4096〔`XDG_DATA_HOME=/tmp` 隔离，真实库零碰〕+ acp :4099 + Chrome+Playwright，脚本 `/tmp/uw-gui-test/v019-gui.ts`）**7/7**：footer 精简 / chip 绿点（opencode SSE 连上，证修复硬编码）/ chip 灰点（切 ACP claude disconnected）/ 页头「自动化」+ intro + vs Team / step 行头像 / run 列表头像簇 / run 详情 step 头像。唯一未实时验证项=暖空态文案（隔离栈 acp orchestrator runs 全局持久化含用户真实 run、列表非空，不删真实数据则拿不到 0-run 态；2 行条件渲染 + 已定义 i18n key，code review 覆盖）。

> **走查 harness 教训复用**：浏览器无 Tauri invoke → 导航走 SPA 内点击（整页 goto 落工作区确认页，点「继续使用」过门）；localStorage 预置 `ultrawork-config`（apiUsername/apiPassword 取自真实 `sidecar-auth.json`）+ `workspace_path`；opencode 用真实凭证但 `XDG_DATA_HOME=/tmp` 隔离 DB；起栈后 `lsof` 核 PID 归属、收尾按 PID kill + 清隔离数据。

## 7. Pipeline surface 暂时下线（2026-06-13，落地后用户拍板）

019 把流水线 surface 收拾干净后，用户在真机（桌面截图 16:00/16:01）复看，判定**当前 UI 仍偏「表单堆砌」、不够第一方质感**，决定**暂时下线「自动化」入口**，等有真正的 UI/UE 设计或确有需求再恢复。

**具体 UI 问题（落地后实物核实）**：① 分段控件「流水线 | Fan-out 并行」被拉成满宽、选项浮在大片空白里、激活态对比弱（应为居中紧凑 pill）；② 原生 `<select>`（模型/agent 下拉）与自定义 avatar chip 风格割裂、显廉价；③ 整体多个带边框盒子竖叠、节奏乱，没有「被设计过」的层级感；④ 顶部说明两行灰字略飘。结论：要做对**不是改 CSS，是一次真设计**，而流水线属低频高级功能（Team 已覆盖日常多 agent 委派），现在投设计性价比低。

**处置（最小、可逆、零后端改动）**：
- **去掉** `left-sidebar.tsx` footer 的「自动化」入口（展开 + 折叠两处）+ 未用的 `Workflow` 图标 import。
- **保留** `/orchestration` 与 `/orchestration/run/:id` 路由（`router.tsx`，可深链访问，便于调试/恢复）。
- **代码全部原样保留**：`PipelineTab` / `OrchestrationRun` / `orchestration-client` / `@agent/orchestrator` 包一行不动；019 已落地的 footer 精简、D5b chip 连接状态（含 ACP 4s 轮询修复）与流水线页无关，**保留有效**；只有 D1 命名 / D3 step·run 头像 / D4 页顶说明随页雪藏（代码在册）。

**关键安全垫**：隐藏入口**不会让 orchestrator 后端变死代码**——Team 协作的 delegate 与流水线**共用同一 orchestrator 后端**，Team 在主聊天里持续使用。砍的只是「代码驱动 recipe」这一个前端入口。

**重启条件（满足其一即恢复 nav 入口，约 1 分钟）**：① 出现真实、重复、确定性的多步骤工作流需求；② 有更好的 UI/UE 设计方案。恢复方式：在 `left-sidebar.tsx` footer（+折叠态）加回指向 `/orchestration` 的入口即可。

### 来源
- 018 收尾 Q2 拍板（MEMORY「下一步与待决」2026-06-13）；用户 footer 两点反馈（2026-06-13，桌面截图）；代码核实 `left-sidebar.tsx` / `pages/Orchestration.tsx` / `pipeline-tab.tsx` / `i18n-context.tsx` / `settings/connection-status.tsx` / `chat/agent-selector.tsx` / `lib/agent-context.tsx` / `core/connector`（2026-06-13）。
