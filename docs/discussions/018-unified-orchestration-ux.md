# 018 · 编排 UX 统一与视觉升级（Team 页后续形态）

> **状态**：讨论中（形态提案，待拍板）
> **日期**：2026-06-12
> **缘起**：阶段3 第三批（017）落地并真机走查全过后，用户对**形态**提出两点反馈（截屏 2026-06-12 19.48.12 / 19.48.23 / 19.48.45）：① 「编排」页 UI/UE 粗糙，可参考 AionUi 优化；② 期望编排/非编排是**统一交互**——一个任务/聊天按需选择模式，而不是去独立页面，为此可调整界面元素与布局（功能和逻辑不动）。
> **承接**：[017](./017-team-page-agent-driven-orchestration.md)（Team 页独立 surface）· [016](./016-aionui-multi-agent-competitor.md) §6（AionUi Team Mode UI）· ADR-031 D-7

---

## TL;DR

1. **017 的「独立 surface」解决的是安全与委派默认化，不是「必须分页面」**——隔离闭环靠 prompt 级 deny 机制，与入口位置无关。统一入口可以做到**功能逻辑零改动**（registry / 注入 / deny / delegate 卡片全复用），改的只是 surface。
2. **议题 A（主）：模式 = 任务的出生属性**。在 Home/新建任务处选「单 agent / Team 协作」，Team 会话进侧栏带标识，Session 页同一聊天面渲染；`/orchestration` 留给流水线（代码驱动 recipe，受众与心智不同）。
3. **议题 B（辅）：视觉升级参考 AionUi**（列表摘要标题、agent 头像、成员管理体验）。**B 必须在 A 拍板之后做**——否则是在美化将被拆掉的页面。

## 1. 现状问题（按截图）

| 截图 | 问题 |
|------|------|
| Team tab 列表（19.48.12） | 创建卡 + 历史列表同屏堆叠无重心；历史条目千篇一律「Team 会话 · Leader」（registry `title` 未回填，没有任务摘要）；成员勾选是裸 checkbox，无 agent 身份感 |
| 流水线 tab（19.48.23） | 表单密集、开发者工具感重（受众本就偏高级，优先级低） |
| Team 聊天面（19.48.45） | 本体已可用（执行流程 + 汇总表格 + token 页脚都在）；问题集中在 header 成员条简陋 |
| 整体 | **入口割裂**：普通聊天在 Home/侧栏，Team 在「编排」页内嵌 tab——同是「发起一个任务」，两套心智、两个入口 |

## 2. 议题 A：统一交互（主）

### 2.1 不变量（这些是 017 拍板沉淀的机制，统一交互不碰）

- 普通会话物理隔离：connector 缺省 deny `orchestrator_*` + gateway 显式 deny。
- Team 会话 = Leader 会话：opencode 每轮 system + `task:false`；ACP `_meta.systemPrompt` + orchestrate 旗标。
- 模式**出生时锁定**：ACP leader 的 system prompt 在 session/new 固化，不支持中途切换（opencode 理论可中途升级但与 ACP 不对称，不做）。
- 服务端 team 注册表（成员/leader 元数据来源）。

### 2.2 形态草案

- **Home 输入区**：AgentSelector 旁增「协作」选择（segmented：单 agent | Team 协作）。选 Team → 控件变为 Leader 下拉 + 成员勾选（浮层/抽屉）；首条消息发出即创建 Team 会话（与现有「出生即绑定」一致）。
- **侧栏**：Team 会话**进侧栏**，带模式标识（👑 图标或「Team」徽标；或单独分组）。点开即 Session 页。
- **Session 页**：识别 team 元数据（registry 查询或 session 标记）→ 注入 promptOptions/directory + 渲染成员头部条；其余与普通会话同一渲染（delegate 卡片/DelegateDock 本就通用）。TeamChat 组件与 SessionPage 合流。
- **`/orchestration`**：回归单一「流水线」页（代码驱动 recipe / run 列表 / run 详情不动）；Team tab 移除。

### 2.3 工程量评估

功能逻辑零改动；surface 改动集中四处：Home 入口控件、侧栏列表（Team 标识 + registry 联动）、Session 页接 team 元数据、`/orchestration` 收敛。约一个中等里程碑（与 017 M4 体量相当）。

### 2.4 待拍板

| # | 问题 | 倾向 |
|---|------|------|
| A-1 | Team 会话进侧栏的形态：混排 + 徽标 vs 独立分组 vs 维持现状不进侧栏 | 混排 + 徽标（最贴「统一交互」诉求；分组备选） |
| A-2 | 模式出生锁定 vs 支持普通会话中途「升级」为 Team | 锁定（ACP 技术约束 + 心智简单） |
| A-3 | `/orchestration` 去留 | 留流水线、去 Team tab（代码驱动面受众不同，保持独立） |
| A-4 | Leader 会话的隐藏父机制是否取消 | 进侧栏则 leader 应建为 root（不再挂隐藏父）——sidecar 创建路径微调，属逻辑小改；twin/委派子会话的隐藏机制**不变** |

> A-4 是唯一触及「逻辑」的点（一行级：创建 leader 时不传 parentSessionId），其余纯 UI。
> 兼容：已存在的（挂隐藏父的）存量 Team 会话进不了 roots 列表——侧栏数据源需并上 team 注册表，或一次性迁移（量小，实施时定）。

## 3. 议题 B：视觉升级（辅，参考 AionUi）

- **列表条目**：任务摘要做标题（回填 opencode 自动生成的会话标题，或首条用户消息截断）+ leader/成员头像组 + 相对时间。
- **成员选择**：agent 头像 + 名称的卡片式多选（替代裸 checkbox）。
- **聊天面 header**：头像组 + hover 展开成员详情；DelegateDock 常显区域化（017 遗留小项）。
- **per-agent 并行面板**：维持后置（016 取舍不变，等实时内联一并考虑）。
- ⚠️ 借鉴边界：AionUi 是 Electron + **独立** Team 页，它没有「单 agent 主聊天」要融合——借它的**视觉模式**（头像/面板/状态点），不借它的**布局结论**（独立页方向与议题 A 相反）。

## 4. 建议节奏

1. 拍板议题 A（四项）→ 2. 实施 A（surface 重排，一个里程碑）→ 3. B 随 A 的新施工面一并做（列表/入口/header 都是 A 重排后的组件）。
反模式：先按 B 美化现 Team tab，再按 A 拆掉它。

---

### 来源
- 用户真机反馈截图（2026-06-12 19:48 ×3）
- [017](./017-team-page-agent-driven-orchestration.md) §2/§5（独立 surface 原始论证——其 §5-1 预留的是「Team tab 长重升格独立路由」，本议题是反向：降格融入主流程）
- [016](./016-aionui-multi-agent-competitor.md) §6（AionUi `pages/team` UI 结构）
