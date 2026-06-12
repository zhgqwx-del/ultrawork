# 017 · Team 页 — agent 驱动编排的独立 surface（阶段3 第三批形态提案）

> **状态**：讨论中（形态提案，待拍板后作为阶段3 第三批 scope，落地时回写 ADR-031）
> **日期**：2026-06-12
> **缘起**：阶段3 第二批收口后用户真机体验发现：经「编排模式」开关 + 普通会话提示词驱动 delegate 的 UX 不可用于普通用户（须点名 `orchestrator_delegate` 工具、模型与内置 task 混淆、开关是全局 config 注入且关闭须重启）。用户拍板倾向 **AionUi Team 页范式**：普通对话保持纯单 agent 不动，委派在独立 Team 页是**默认行为**。
> **承接**：[ADR-031](../decisions/031-multi-agent-orchestration.md) D-7 原旨（「建议承载在独立 orchestration/team 路由，单会话聊天保持纯净」）· [016](./016-aionui-multi-agent-competitor.md) §6 UI 共存范式（AionUi `pages/team` 独立 / `pages/conversation` 零改动，源码核实）· [agent-os-target-architecture.md](../agent-os-target-architecture.md) §3.6（不破坏现有 UX）。

---

## TL;DR

1. **问题**：第二批的 agent 驱动 delegate 把「编排能力」塞进普通会话——能力是通的（真机全验证），但 UX 是工程师级的：用户要会写提示词技巧，开关还有全局注入三脏（影响所有 opencode 会话 / 关闭须重启 / per-directory instance 即时生效边界）。
2. **提案**：新增 **Team 页**（与现有 `/orchestration` 流水线表单合为一个路由的两个 tab）。Team 页主体 = **Leader 会话聊天框**：用户只描述任务，拆分与委派由 Leader 的 system 提示驱动成为**默认行为**；普通会话回到纯单 agent（物理上无 delegate 工具）。
3. **地基全部现成**：ACP per-session `orchestrate` 旗标、M1 的 `tools` deny 机制（反向用 = opencode 的 per-session 语义）、delegate 卡片/DelegateDock/子会话懒加载、`list_agents`。增量集中在 **Leader system 提示 + tab UI + 成员选择**。
4. 「编排模式」开关随之**移除**（被 Team 页取代）；阻塞式 delegate 维持（mailbox 仍留后续）。

---

## 1. 现状问题（第二批真机结论）

| 问题 | 根源 |
|------|------|
| 用户须写「请调用名为 orchestrator_delegate 的 MCP 工具…」级别的提示词 | 委派不是会话的默认语义，模型把它当普通工具；qwen 会选内置 `task`，claude 有自家 subagent 工具抢 |
| agentId/cwd/model 参数暴露给用户 | `list_agents` 可自助发现、cwd 模型可自愈、model 可选——但没有 system 级引导时模型不稳定 |
| 「编排模式」开关 = opencode 全局 config 注入 | vendor MCP 无 per-session 注入：影响所有工作区会话、关闭须重启（无 DELETE /mcp）、运行时注册仅当前工作区 instance 生效（gotchas §3） |
| 普通会话被编排能力「污染」的潜在风险 | 开关打开后任何 opencode 会话理论上都可能自发调 delegate |

## 2. 提案形态

### 2.1 路由与导航

- **一个路由两个 tab**（推荐，备选见 §5）：现有 `/orchestration` 扩展为
  - **「Team 协作」tab（新，agent 驱动）**：Leader 会话聊天面
  - **「流水线」tab（现有，代码驱动）**：Pipeline / Fan-out recipe 表单
- 正好对应 ADR-031 D-1 混合原则的两面：开放任务走 Team（灵活），固定模式走 recipe（可复现）。侧栏入口仍是现有「编排」一个。

### 2.2 Team tab 主体 = Leader 会话

```
┌──────────────────────────────────────────────┐
│ [Team 协作] [流水线]                          │
│ Leader: [claude ▾]   成员: ☑opencode ☑claude  │
│──────────────────────────────────────────────│
│  （Leader 会话消息流，复用 MessageList）       │
│   ├ 执行流程                                  │
│   │  ├ 委派 → opencode:default  …            │ ← 复用 delegate-row
│   │  └ 委派 → acp:claude  …                  │
│   └ 汇总回答                                  │
│──────────────────────────────────────────────│
│  [DelegateDock：委派中 / 权限内联]            │ ← 复用
│  [输入框：直接描述任务即可]                    │
└──────────────────────────────────────────────┘
```

- 用户输入 = 纯任务描述（「帮我做一份西湖一日游攻略」）。
- 拆分/委派/汇总 = Leader 模型在 **system 提示**引导下的默认行为（见 §2.4）。
- 委派过程渲染 = 第二批的 delegate 卡片 + DelegateDock，零新渲染器。

### 2.3 注入机制（per-backend，全部复用既有原语）

| Leader backend | delegate 工具注入 | system 提示注入 | 普通会话隔离 |
|---|---|---|---|
| **ACP（claude/gemini/qoder）** | per-session `orchestrate: true`（第二批已实现，`POST /acp/session`） | adapter 0.44 `_meta.systemPrompt`（preset append）；不支持的 agent 退化为首条 prompt 前置 | 普通 ACP 会话不传 orchestrate（现状即如此），物理无工具 |
| **opencode** | 全局注册 orchestrator MCP（Team 功能启用时一次性写入，不再做用户开关） | `promptAsync` 的 `system` 参数（每轮携带） | **反向用 M1 机制**：desktop 普通 opencode 会话每次 prompt 恒传 `tools:{"orchestrator_*":false}` → sticky session permission deny，普通会话物理无工具。per-session 语义从 config 级原语中构造出来 |

- 子会话防递归不变（第二批双保险照旧）；Leader 的并发委派仍受 orchestrator `maxConcurrent` 治理。
- **「编排模式」Settings 开关移除**：全局 MCP 注册降级为 Team 功能的内部实现细节（首次进入 Team tab 时静默 ensure，knowledge-base MCP 同模式）。

### 2.4 Leader system 提示（草案要点）

> 你是一个任务编排者（Leader）。收到任务后：① 判断是否值得拆分（简单任务直接自己回答）；② 需要拆分时用 `list_agents` 查看可委派成员，把任务拆成独立、自包含的子任务，用 `delegate` 工具委派（子任务描述必须自包含——对方看不到本对话；cwd 用当前项目根目录；可并行的委派尽量在同一轮并行发出）；③ 全部交付物返回后做汇总，标注各部分来自哪个成员。不要使用内置的 task/subagent 工具做跨成员委派。

- 成员勾选（§2.2 顶栏）注入到 system 提示的「可委派成员」清单（同时作为 `list_agents` 结果的展示过滤）；MVP 不做服务端强制（Leader 委派未勾选成员仅是提示约束——治理护栏兜底）。

### 2.5 Leader 会话的存储与列表

- Leader 会话 = 普通会话存储（opencode session / ACP session 原机制），**不进左侧栏**（防止与单 agent 会话混淆）：opencode leader 挂隐藏父（第二批机制）或按 title 前缀过滤；ACP leader 不传 clientSessionId 即天然不可见。
- Team tab 自带「历史 Team 会话」列表（复用 run 列表的样式），点开即恢复 Leader 会话继续聊。
- **不引入 AionUi 式常驻 Team 实体/SQLite**（teams/mailbox/team_tasks 表）——我们的 MVP 是「会话即团队」，常驻团队（命名、成员固化、跨会话复用）留观察真实使用后再定。

## 3. 与 AionUi 对照（差异即取舍）

| 维度 | AionUi Team Mode | 本提案 MVP | 备注 |
|---|---|---|---|
| 独立 surface | `pages/team` | `/orchestration` Team tab | ✅ 同范式 |
| Leader 委派默认化 | Leader agent + Team MCP | Leader system 提示 + delegate MCP | ✅ 同构 |
| 回卷 | 异步 mailbox | 阻塞工具返回 | 取舍：MVP 维持阻塞（D-6 完整形态后续）；并行度靠 Leader 同轮多工具调用 |
| 常驻 Team 实体 | SQLite teams + 成员增删 | 会话即团队（无持久实体） | 取舍：轻量先行 |
| per-agent 并行面板 | ≥400px 横滚面板 | delegate 卡片 + dock | 取舍：留后续（实时内联 P1-3 Phase 2 一并考虑） |
| 运行时 per-agent 换模型 | ✅ | delegate 的 model 参数（Leader 决定） | 基本等价 |

## 4. MVP 范围（= 阶段3 第三批主体）

**做**：
1. Team tab UI（Leader 选择 + 成员勾选 + 聊天面 + 历史列表）
2. Leader 会话创建与注入（ACP orchestrate / opencode system 参数 + 全局 MCP ensure）
3. Leader system 提示（含成员清单动态拼接）
4. 普通 opencode 会话恒传 `orchestrator_*` deny（隔离闭环）
5. 移除「编排模式」Settings 开关（含 use-orchestrate-mode 清理）
6. 复用 delegate 卡片/DelegateDock（如需小调：dock 在 Team 页内常显区域化）

**不做（留观察/后续）**：
- 非阻塞 mailbox 回卷（D-6 完整形态）
- per-agent 并行面板 / 子会话实时内联（P1-3 Phase 2）
- 常驻 Team 实体与成员持久化
- 档3 自动调度（ADR-027 阶段4）

## 5. 待拍板

1. **路由形态**：`/orchestration` 两 tab（推荐：一个编排心智、侧栏一个入口）vs 独立 `/team` 路由（更贴 AionUi，但与 recipe 页割裂）。
2. **Leader 默认 agent**：推荐默认 claude（拆分质量与并行工具调用能力实测最好），下拉可换 opencode/其它；还是跟随全局默认 agent？
3. **成员约束强度**：MVP 仅提示约束（推荐，零增量）vs 服务端强制（delegate 端点校验成员白名单——需要把成员集传给 :4099，增量中等）。
4. **普通会话 deny 的范围**：仅 opencode（推荐，ACP 本来就不注入）；是否也给 gateway/IM 渠道的会话加（IM 场景暂无编排诉求，建议一并 deny 防意外）。
5. **「编排模式」开关**：直接移除（推荐）vs 降级为高级选项保留。

---

### 来源
- 内部：[ADR-031](../decisions/031-multi-agent-orchestration.md)（D-1/D-3/D-7 + 第二批落地备注）· [016](./016-aionui-multi-agent-competitor.md) §4/§6 · [agent-os-target-architecture.md](../agent-os-target-architecture.md) §3.6 · `docs/gotchas.md` §3（per-directory instance）/§9（注入侧防递归、超时三件套）
- 真机依据：第二批 GUI 走查（2026-06-12，用户）——提示词复杂度反馈即本提案缘起
