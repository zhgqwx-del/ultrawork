# 013 · Ultrawork 作为「统一交互层 / Agent OS」— 经 ACP 调度多 Agent 后端

> **状态**：讨论中（架构愿景评估，未定论；含事实调研 + 提案，落地前需评审）
> **日期**：2026-06-08
> **范围**：纯调研 / 分析，**不修改代码**。
> **缘起**：当前 Ultrawork = opencode 作 agent loop + Tauri 客户端。设想升级为「**统一交互层**」：既可用 opencode 作后端，也可用 claude code / qoder / gemini 等支持 **ACP** 的 agent 作后端，让客户端像「操作系统」一样，把每一轮会话**动态或指定**地分配给不同 agent——类似 openclaw `acpx` 的方式，也类似 opencode 内置 agent 的选择体验。
> **关键前提**：Ultrawork **已经有 `feat/acp-support` 分支**（28 commit，未合并 main）实现了这个愿景的**基座**。本文不是从零设计，而是评估「现有 MVP → 完整 Agent OS」的可行性、难点与路径。
> **对标**：[011](./011-architecture-comparison.md) 已横向对比 openclaw / hermes / opencode desktop。
> **后续细化（2026-06-09，forward-pointer）**：本文 §3/§4 的「backend 接入」与 openclaw/hermes 定性已由 [015](./015-backend-taxonomy-non-acp.md) 源级调研细化/部分修正——**「支持 ACP 非二元」**（openclaw `openclaw acp` 是 Gateway 薄桥、最差面；hermes/qoder 原生富 ACP）、**传输族 × adapter 分类法**、openclaw 对外**三面**（ACP 桥 / OpenAI HTTP / **WebSocket Gateway native**）。§11 的 qoder flag 歧义亦在 015 §4.4 调研（缩小未消除）。**backend 分类与三家定性以 [015](./015-backend-taxonomy-non-acp.md) + [ADR-030](../decisions/030-agent-connector-control-layer.md) D-8 为准。**

---

## TL;DR

1. **愿景成立、且已被反复验证**。ACP（Zed 主导的 Agent Client Protocol，"AI coding agent 界的 LSP"）正是为「一个 host 统一驱动多个异构 agent」而设计。**opencode 原生支持 ACP**（`opencode acp`）、**qoder CLI**、**gemini CLI（参考实现）**原生支持，**claude code / codex 经官方 Apache adapter** 支持，另有 20+ agent。host 端有现成 **TypeScript / Rust SDK**。openclaw 的 **`acpx`** 就是「统一层调度多 ACP agent」的现成参考实现。

2. **Ultrawork 已经走在这条路上，但只走通了「协议管道」**。`feat/acp-support` 分支已建：ACP Client Sidecar（:4099，SDK `@agentclientprotocol/sdk`）、`UnifiedAgent` 抽象（统一 opencode + ACP agent）、agent-selector UI、`agents.json` 配置、auto-connect、ACP session/update → SSE → 复用 opencode 渲染。**但实测显示：opencode 后端体验正常，claude code / gemini / qoder 等非 opencode agent 的「结果渲染 + 交互」仍有大量问题**（根因见 §5）。即——**管道通了，异构 agent 的归一化没做完。**

3. **多 agent 的正确模型是「档1 会话级 → 档2 delegate/编排 → 档3 自动调度」**（见 §6，已重构）：
   - **档1 · 会话级绑定**（一个会话固定一个 agent）：✅ 现成、分支已通管道，深水区在「异构归一化」。
   - **档2 · delegate / 编排**（orchestrator 拥有主对话，把**子任务**委派给其它 agent，结果回卷；多个委派组成 Fan-out/Pipeline/Supervisor/Debate/Swarm 五种拓扑）：⚠️ 这才是「多 agent 协作」的正确形态。**交接走显式产物/子会话契约**——比「同一对话里对等 agent 逐轮透明换手」（伪命题，业界无人造、ACP/A2A 不支持，**已弃**）干净得多。必须 **Ultrawork 自建 orchestrator**（opencode 是 ACP Server，当不了编排器）。
   - **档3 · 自动调度**（router 自动决定子任务派给谁）：🔬 在档2 之上加路由策略，最远期。

4. **ACP 是「编码 agent + 编辑器」形状的**。它覆盖会话/流式/工具/权限/文件编辑很好，但**完全不覆盖** IM 多渠道、知识库、自定义非编码面板——这些仍是 Ultrawork 自己的层。Ultrawork 的差异化（国内 IM + RAG）恰好落在 ACP 之外，与「统一调度编码 agent」互补而非冲突。

5. **建议**：把愿景拆成「**档1 会话级多后端（短期、基于现有分支 re-baseline）**」与「**档2 delegate/编排（中长期、需自建 orchestrator）**」推进，不要混为一谈。**先档1 后档2 不是偏好而是依赖关系**——分支实测显示单个非 opencode agent 的结果/交互都还不稳，档1 的真正工作量在「异构 agent 归一化」（渲染 + 权限 + 能力协商），必须先做对，编排才有意义。档2 作为独立 ADR 深入设计，**采用 delegate/五种模式，放弃「对等换手」**。

---

## 1. 愿景重述与「OS」类比的边界

设想里把 Ultrawork 类比成「操作系统」——统一交互层，调度各 agent 完成任务。这个类比对，但要厘清一处：

opencode 的**内置 agent（build/plan/general/explore）**是「**同一个 agent loop 内**的 persona/mode 切换」——共享同一 session、同一对话历史，换的只是 prompt/工具/权限（见 [004](./004-opencode-multi-agent.md) / [008](./008-opencode-builtin-agents-orchestration.md)）。切换 `agent` 字段之所以无缝，正因为是**同一进程、同一上下文**。

而 **claude code / qoder / opencode 之间**是**完全独立的 agent 产品**——各自独立进程、独立 session 状态、独立对话历史、独立工具集。把一轮派给 claude、下一轮派给 opencode，它们**彼此不知道对方做了什么**。所以「像内置 agent 那样切」在体验上可以对齐，但在**机制上根本不同**：内置 agent 是「一个字段」，跨后端 agent 是「一套进程编排 + 上下文交接协议」。

这一区别是本文所有结论的基础。

---

## 2. ACP 是什么、为何契合这个愿景（事实）

- **定位**：Zed 主导的开放协议（Apache-2.0，`agentclientprotocol.com`），标准化**编辑器/编排器（Client）↔ 编码 agent（Agent）**的通信，被称为「AI coding agent 的 LSP」。JetBrains×Zed 官方合作（2025-10），Gemini CLI 是参考实现。
- **传输**：JSON-RPC 2.0 over stdio（NDJSON，双向）；Client **spawn agent 子进程**。远程 HTTP/WebSocket 仍是 WIP。
- **角色**：Client = 宿主（spawn agent、拥有 fs/terminal/UI）；Agent = 子进程（驱动模型、请求工具/权限）。
- **核心模型**：
  - `initialize` 能力协商（protocolVersion，当前稳定 = 1；client/agent capabilities）。
  - `session/new`（传 cwd + MCP servers，返回 sessionId）；`session/load`（恢复会话，agent 把**整段历史以 `session/update` 重放**——注意：仅限**该 agent 自己的**历史）。
  - **prompt turn**：`session/prompt` 发起 → agent 流式回 `session/update`（`agent_message_chunk` 文本 / `agent_thought_chunk` 推理 / `plan` / `tool_call` + `tool_call_update` / `usage_update`）→ 以 `StopReason` 结束（end_turn / max_tokens / cancelled…）。
  - **tool call**：`tool_call`（toolCallId/title/kind/status/content/locations/diff），kind ∈ read/edit/execute/search/fetch…，status pending→in_progress→completed/failed。
  - **permission**：`session/request_permission`，host 弹给用户。
  - **文件编辑**：以 diff（path/oldText/newText）表达，`locations` 驱动编辑器 follow-along；terminal 实时输出。
- **为何契合**：它给了一套**agent 无关的「会话 / 流式 / 工具 / 权限 / 文件」契约**——正是「统一交互层」需要的标准接口。换 agent 只是换一个 stdio 子进程，host 端渲染逻辑不变。

> 来源：[introduction](https://agentclientprotocol.com/get-started/introduction)、[session-setup](https://agentclientprotocol.com/protocol/session-setup)、[prompt-turn](https://agentclientprotocol.com/protocol/prompt-turn)、[tool-calls](https://agentclientprotocol.com/protocol/tool-calls)、[zed.dev/acp](https://zed.dev/acp)。

---

## 3. 生态现状：哪些 agent 说 ACP（事实，决定可行性）

| Agent | ACP 支持 | 方式 | 备注 |
|-------|---------|------|------|
| **opencode** | ✅ **原生** | `opencode acp`（stdio） | 全功能对等（工具/MCP/规则/权限），实现在 `packages/opencode/src/acp`，非 adapter。**与 Ultrawork 现用的 REST/SSE 是它的另一套接口** |
| **Qoder CLI** | ✅ 原生 | `qoder acp` | 阿里巴巴出品（其 IDE 内部用 MCP，CLI 才说 ACP） |
| **Gemini CLI** | ✅ 原生 | 参考实现 | |
| **Claude Code** | ✅ adapter | `@zed-industries/claude-code-acp`（现 `agentclientprotocol/claude-agent-acp`，Apache 开源） | 包装 Claude Agent SDK |
| **Codex CLI** | ✅ adapter | Zed adapter | |
| 其他 | ✅ 多为原生 | — | Cursor / Copilot CLI(`--acp`) / Goose / Cline / Qwen / Kimi / Hermes 等 20+ |

- **host 端可复用 SDK**：Rust [`agent-client-protocol`](https://docs.rs/agent-client-protocol/)（Zed 自用）、TypeScript [typescript-sdk](https://agentclientprotocol.github.io/typescript-sdk/)、Python、Kotlin。→ **Ultrawork 做 host 端不必自研协议栈**，TS SDK 直接给「spawn agent + 交换 JSON-RPC + 渲染 update」的能力（现有分支已用 `@agentclientprotocol/sdk`）。
- **已有 host 先例**：Zed、JetBrains（Junie + ACP Agent Registry，2026-01）、Neovim、社区 VS Code 扩展——证明「一个 host 编排多 ACP agent」是成熟现实。

> 关键结论：愿景里点名的 opencode / claude code / qoder **全部可经同一 ACP 接口接入**，每个作为 stdio 子进程，配置形如 `agent_servers`。这是愿景成立的硬基础。

---

## 4. 参考实现：openclaw `acpx`（最接近）/ hermes（以 server 为主）

- **openclaw `acpx`（[独立仓库](https://github.com/openclaw/acpx)，最值得抄）**：自我定位「最小可用的 ACP client」，内置 adapter（codex/claude/gemini/cursor/copilot/opencode/qodercli/kimi/qwen…），CLI `acpx <agent> '<prompt>'` + session 管理。openclaw 主程序经 **bindings**（会话 channel+peer ↔ ACP session ↔ agentId）做路由，省略时回落 `defaultAgent`，能力**条件可见**（后端不可用就隐藏）。
  - **进程生命周期层（踩坑经验，直接可借鉴）**：`AcpClient` spawn piped-stdio 子进程；**三阶段优雅关闭**（stdin EOF → SIGTERM 1.5s → SIGKILL 1s）；退出原因细分 + `unexpectedDuringPrompt`（prompt 中崩溃）标记；**per-agent 特判**（Claude persistent-session 会 stall 需超时、Gemini OAuth 可能挂起、Copilot 需先验 ACP 支持、Windows `.bat` 需 `shell:true`、Qoder/Codex 关闭过滤 stderr）；auth 走 env 注入。
  - **工具暴露默认关**：默认不把宿主工具给外部 agent，需要时注入内置 MCP server（`openclaw-plugin-tools`）反向暴露——安全/能力的好折中。
- **hermes**：主线是 ACP **server**（`acp_adapter/` 把自己暴露给 Zed）；通用「多 agent client 编排」是**未合并提案**（Issue #5257，提议 `acp://{agent}` + Agent Registry 映射 14 agent 启动命令）。其 `acp_registry/` 只是「把自己登记进外部 Registry」的单 manifest，**不是**多 agent 注册表（易误读）。

> 借鉴要点：① 直接抄 acpx 的进程生命周期层与 per-agent 怪癖处理；② 把「UI 会话 ↔ ACP session ↔ agentId」做成一等映射 + defaultAgent 回落；③ 能力条件可见；④ 外部 agent 当 **session/delegate 后端**，**不要**当「一个 tool」塞进单轮（会丢上下文、难取消、难流式）；⑤ client 链路（调别人）与 server 链路（被别人调）分开设计——本愿景主要需 client 链路。

### 4.x 协议栈定位 & 「编排层必须自建」（补充自桌面《ACP 协议技术调研》《OpenClaw+acpx 编排方案》）

- **三协议分层，别混用**：**MCP**（Agent→工具，垂直）/ **ACP-Zed**（Client→Agent，垂直，**只负责"驱动单个 agent"**）/ **A2A**（Agent↔Agent，**水平对等协作**，原 IBM ACP 已并入 A2A）。完整应用三者并用：`用户 ─[ACP]→ Agent ─[A2A]→ Agent ─[MCP]→ Tool`。**含义**：本愿景里「驱动 claude/qoder/opencode」用 ACP；但「多 agent 对等协作」属于 **A2A + 编排层**职责，**ACP 本身不提供多 agent 编排**。
- **三层栈心智模型**：可视化层（UI）/ 协议层（acpx 这类 ACP client）/ **编排层**（路由/记忆/并发/失败恢复）。Ultrawork 要做的是**可视化层 + 编排层**，协议层可直接用 ACP SDK。
- **关键事实：opencode 是 ACP Server，不是 Client**。`opencode acp` 是把自己暴露给别人调；反向「opencode 经 acpx 调别的 agent」**无生产级方案**（权限割裂、丢结构化事件、失败恢复弱）。opencode 的多 agent 是**进程内** subagent（general/explore + Oh My Opencode）。→ **跨厂商编排器只能由 host（Ultrawork）自建**，正如 OpenClaw 自建编排层，**不能指望 opencode 来编排**。
- **最直接对标：Jockey**（Tauri 桌面端 + ACP 多 agent 协调）——与本愿景形态几乎相同，应纳入竞品观察（见 §8）。

---

## 5. Ultrawork 现有 ACP 分支盘点（关键：不是从零）

`feat/acp-support`（28 commit，5003cfe..116ed30，起于 2026-05-25，对应预留的 **ADR-027**，**未合并 main**；专题记忆 `acp-branch.md`）：

**已实现**：
- `packages/agent/acp-client/`，**ACP Client Sidecar :4099**，协议 ACP v1，SDK `@agentclientprotocol/sdk`。
- 配置 `~/.config/ultrawork/agents.json`（agents.command/args/env）；Sidecar 启动 **auto-connect** 所有配置 agent。
- **`UnifiedAgent` 抽象**（`src/lib/agent-types.ts`）：统一 opencode agent + ACP agent，含 `AgentSource`/`AgentStatus`/`makeAgentId`/`fromOpenCodeAgent`。
- `use-agents.ts`（并行 fetch opencode + ACP agents）、`agent-context.tsx`（当前选择 + `getPromptAgent` 路由 + SSE agent 切换检测）、`agent-router.ts`（ACP Sidecar HTTP 客户端）、`use-acp-sse.ts`。
- **agent-selector** UI（chat 输入区）、Settings **agents-section.tsx**（agent 管理 UI，414 行）。
- 消息流：ACP `session/update` → SSE event bridge → 前端 `useACPSSE` → 复用 opencode 消息渲染。
- 工程：`build:acp` / `scripts/build-acp.ts`；macOS PATH（`rich_path()`）+ 智能标点坑（`sanitizeCliText()`）；readTextFile/writeTextFile CWD 沙箱（`validatePath`）；initialize 15s 超时 + SSE 3 次退避重连。

**已知限制（正是「OS 愿景」要突破的）**：
- ❌ **不支持同 session 混合 Agent**（= 只做到档1「会话级绑定」，没做档2 delegate/编排）。
- ❌ 消息不跨应用重启（前端内存 Map）。
- ❌ 权限自动批准（未接 ACP `request_permission` → UI）。
- ❌ SSE 事件类型映射不完整。

**实测信号（关键，来自分支使用反馈）**：分支「走通了」（端到端能连、opencode 后端体验正常），但 **claude code / gemini / qoder 等非 opencode agent 的「结果」与「交互」仍有很多问题**。根因可定位到上面两条限制：
- **渲染层是「opencode 事件模型」形状的**（分支「复用 opencode 渲染」+「SSE 事件映射不完整」）。opencode-as-ACP 恰好能 round-trip（同一家实现），但**其他 agent 发的是 ACP 标准 `session/update`**（`agent_thought_chunk` / `plan` / `tool_call` 的 kind 与 content 结构都不同），经 opencode 形状的渲染器就**失真 → 结果显示出错/丢内容**。
- **权限自动批准**：opencode 路径下 Ultrawork 已深度接了 permission/question dock，但 ACP 路径直接 auto-approve → 需要确认/输入的非 opencode agent **交互就断了**。
- **per-agent 怪癖未处理**（Claude session stall、Gemini OAuth 挂起等，见 §4 acpx 经验）也会表现为「某些 agent 起不来/卡住」。

> **这条信号改变了对「档1」难度的判断**：档1 不是「接通即完成的现成红利」，它自己有个**深水区 = 异构 agent 的结果归一化 + 交互（权限/能力协商）**。分支证明了「协议管道能通」，但**没做完「把异构 agent 渲染/交互做对」**——这恰恰是阶段 1 的真正工作量所在（见 §9 修订）。

**重要现实——分支漂移**：该分支起于 5-25，其 diff 显示它**删掉了** `assistant-turn.tsx`/`execution-flow.tsx`/`message-parts.tsx`——而这些正是 main 后来 ADR-029「执行流程收纳」的产物。即**分支落后于 main 的 chat 重构**，直接合并会回退 main 的工作。**re-baseline 成本真实存在**（acp-branch.md 也写明「合并后再做一轮 review」）。

> 结论：愿景的**档1（会话级多后端）已有可用实现**，但需先 re-baseline 到当前 main（处理与 ADR-029 chat 渲染的冲突）。档2（delegate/编排）现有分支**明确未做**。

---

## 6. 多 agent 的正确模型：A 会话级 → delegate/编排 → 自动调度

> **本节是 013 的核心，已按「delegate/编排优于对等换手」重构。** 早期草案设过一个「粒度 B = 同一对话里对等 agent 逐轮透明换手」的设想——经调研与讨论确认它是**伪命题（业界无人这么造，且 ACP/A2A 都不支持），已弃用**。正确的谱系如下。

### 6.0 三档谱系（替代原 A/B/C）

```
档1 · 会话级（挑一个 agent）  →  档2 · delegate/编排（父→子委派 + 五种模式）  →  档3 · 自动调度（dispatch）
```

| 档 | 是什么 | 机制 | 成熟度 |
|----|--------|------|--------|
| **1 会话级** | 一个会话绑一个 agent | bindings（会话↔agentId），ACP 直接给 | 分支已通管道，深水区在归一化 |
| **2 delegate/编排** | orchestrator 拥有主对话，把**子任务**委派给其它 agent，结果回卷；多个委派组成五种拓扑 | 父→子 session + **显式产物交接** | 需 Ultrawork 自建 orchestrator（独立 ADR） |
| **3 自动调度** | 由 router 自动决定子任务派给谁 | 规则 / LLM router，在档2 之上加路由 | 远期 |

### 6.1 档1 · 会话级绑定（管道已通，深水区在「异构归一化」）
一个会话固定绑定一个 agent（opencode / claude / qoder…）。用户新建会话时选，或按规则绑定（类 openclaw bindings）。
- **机制**：每个会话 = 一个 ACP session（或 opencode session），生命周期独立。
- **现状**：`feat/acp-support` 已通**协议管道**，但**非 opencode agent 的结果/交互仍不达标**（§5 实测信号）。
- **真正成本（不是协议，是归一化）**：① 渲染层从「opencode 事件模型」改为**直接消费 ACP 标准 `session/update`**（thought/plan/tool_call/diff 统一映射）；② 接 ACP `request_permission` → 复用 permission-dock（去掉自动批准）；③ 按 `initialize` 能力协商**条件启用 UI**；④ 移植 acpx 的 per-agent 进程怪癖处理。
- **体验**：像「为这个任务挑一个 agent」。**推荐作为第一档目标——A 的工作量在归一化，不在接通。**

### 6.2 档2 · delegate / 编排（这才是「多 agent 协作」的正确形态）

**为什么 delegate 优于「对等换手」**——两者都有「跨 agent 上下文会丢」的问题，但**损失发生的位置不同**，这决定优劣：

| 维度 | 对等换手（已弃） | **delegate / 编排** |
|------|----------------|---------------------|
| 谁拥有对话 | 模糊，没有 owner | **清晰**：orchestrator 独占主对话 |
| 交接形态 | 把**整段历史**塞给另一个 agent（隐式、模糊、发生在对话中途） | 给子 agent **明确的子任务 prompt**，子 agent 回**结构化结果**（`<task_result>` 回卷） |
| 损失发生在哪 | 对话**中间**——用户困惑「现在谁在说、它知道前文吗」 | **干净的接口边界**——「派活→交付物」，损失被封装成可接受的契约 |
| 可归因 | 难 | 易（每个子任务一个产物，可追溯） |
| 协议支持 | ACP/A2A 都不支持，要自建无支持的管道 | **opencode task 工具、hermes delegate_tool、openclaw sessions_spawn 全都原生这么做** |

**关键洞察**：delegate 的「有损」和对等换手一样存在（父 orchestrator 只看到子 agent 的**最终文本**，看不到其推理/diff），但它发生在**一个明确的契约接口上**（交付物），而非对话中途——**这就是 delegate 干净、可接受的根本原因**。

**delegate 是积木，五种模式是拓扑**——「多 agent 协作」= 委派 + 显式产物交接搭出的拓扑（桌面《OpenClaw+acpx 编排方案》调研）：

| 模式 | 拓扑 | 交接方式（全是显式产物 / 隔离环境，无透明换手） |
|------|------|----------------|
| **Fan-out** | 1 planner → N worker 并行 | 各 worker 独立**命名会话 + git worktree**，互不污染 |
| **Pipeline** | A→B→C 串接 | 上一步**输出文件**作下一步输入（`ARCH_REVIEW.md`→…） |
| **Supervisor** | Boss 审 worker，不过打回 | Boss 意见**转回 worker 原会话**；Boss 用强模型、worker 用便宜模型 |
| **Debate** | 多 agent 互质疑 + 裁判 | 各持**独立 thread**，裁判综合；降低「随大流」 |
| **Swarm** | 对等跨实例 | 走 **A2A**（非 ACP） |

> ⚠️ **纠偏（acpx/openclaw 源码核实后）**：上表的五种模式是**业界归纳的拓扑**，但**openclaw 并未把它们做成一等公民**——经源码核实，**`/acp fanout`、`/acp debate`、`/acp send` 等命令不存在**（桌面调研文档里的这些命令示例是理想化/失实的）；openclaw 也**没有 `dispatch.rules` 规则引擎**。openclaw 真实提供的是一组**细粒度原语**：`/acp spawn`、`sessions_spawn`、`sessions_steer`、`/acp cancel/close/status/steer` + `streamTo:"parent"` 进度回流 + `maxConcurrentSessions` 限流。**五种模式是用这些原语 + 一个 LLM 编排者 emergent 出来的，不是内置设施。** → 对 Ultrawork 的含义：若要内置 fanout/pipeline 等模式，是 openclaw **之上**的自研增量；先做对原语（spawn/steer/cancel + 产物交接 + 限流），模式留给上层。

> **delegate 在你的技术栈里已是事实**：opencode 自己的 build agent 就是通过 task 工具 delegate 给 explore/general 子 agent（[004](./004-opencode-multi-agent.md)/[008](./008-opencode-builtin-agents-orchestration.md)）。本愿景只是把「能被 delegate 的子 agent」从「opencode 自家的」扩展到「外部 ACP agent（claude/qoder）」。

### 6.3 档3 · 自动调度（dispatch，远期）
不由用户指定，而是 **router 自动决定子任务派给谁**（按任务类型/成本/能力）。在档2 之上加路由策略。**注意**：openclaw 的「自动路由」**不是规则引擎**（无 `dispatch.rules`）——它把路由**二分**：① **身份路由**（会话↔agent）= 确定性 specificity 链（`bindings[]`，peer>guild>account>default）；② **任务委派**=**LLM 编排者按自然语言意图**判断后调 `sessions_spawn`（+ `allowedAgents` 白名单 + `acp.dispatch.enabled` 门控）。→ Ultrawork 若想要确定性的「按任务类型/多模态规则路由」，那是 openclaw **没有、需自研**的；可借鉴的是「身份用确定性链、任务用 LLM 意图，两者分开」。风险：误路由、router 延迟/成本、可解释性差。建议**远期**，auto 与手动指定并存。

### 6.4 三个必须想清楚的设计点（决定档2 到底好不好用）

1. **谁来当 orchestrator？——这是关键卡点。** opencode 自带的 delegate **只能派给它自己的子 agent**（general/explore），**派不出去给外部 claude/qoder**——因为 opencode 是 ACP **Server**，当不了 Client（§4.x）。所以「跨厂商 delegate」**必须 Ultrawork 自建 orchestrator 层**（正如 openclaw），这是真实工程投入，不是白来的。
2. **agent 驱动 vs 代码驱动的编排——别只想着前者。** agent 驱动（LLM orchestrator 运行时决定派给谁）：灵活但不确定、会误派、烧 orchestrator token、难复现；代码驱动 / workflow（确定性流水线，如 `pr-review-pipeline.md`）：可复现可调试但死板。**成熟做法是混合**——已知模式走确定性 workflow，开放任务才交 agent 决策。
3. **别过度工程化。** 大多数用户大多数时候只想**「这个任务用 claude」**（档1 就够）。完整 delegate/编排只对**真正可拆解的多步任务**值得。把编排当默认会让简单场景变复杂——**档1 覆盖约 80% 价值，档2 是给复杂任务的「高级档」**。

### 6.5 为何「档1 必须先于档2」——精确拆分（基座硬前置 / UI 层可流水线）
「档1 是档2 前置」大体成立，但要把档1 拆成**两层**，对档2 的必要性不同，别一刀切：

| 档1 的组成 | 对档2 | 理由 |
|-----------|-------|------|
| **① 协议/进程基座**：可靠 spawn + keepalive + 关闭、per-agent 怪癖、**正确消费 ACP `session/update`** | ✅ **硬前置，绕不开** | 档2 的「委派」本质 = orchestrator 起一个子 agent ACP 会话 → 读它的 `session/update` → 拿结果。这条**「驱动 + 读取」链路就是档1 基座**；档2 **建在**它之上，不是并排。**驱动不了、读不懂的 agent，无法被编排。** |
| **② UI 表层**：完整渲染打磨、per-request 权限 dock | ⚠️ **非机械必需，但对本产品必须** | 理论上档2 可让子 agent **headless 跑** + **sandbox/approve-all/worktree 隔离**（那份编排调研里就是生产配置），不接 UI 也能机械跑通。**但**编排失败极难诊断——结果不对时要分清「派错 / 子 agent 输出垃圾 / 撞怪癖卡死 / 交接丢上下文」，**没渲染就是盲飞**。分支已证明单 agent 输出本身就不稳，「不稳 + 不可观测」拿去编排 = **不可归因的烂摊子**；且桌面产品里用户会看到嵌套子卡片，乱的不可发布。 |

**重要松绑**：前置的是「**你要编排的那几个 agent** 的档1」，**不是「所有 agent 的档1 全做完」**。可以**先把 claude + opencode 两个归一化做扎实，就拿这俩并行启动档2 原型**，同时再去归一化 qoder/gemini。所以档1→档2 **按 agent 可流水线**，不必串成一道大墙。

> **结论（修正过的精确版）**：档1 **基座层**对档2 **硬前置**（驱动不了就编排不了）；档1 **UI 层**对「可发布、可诊断的档2」必须，但**可只先做你要编排的 1–2 个 agent**，与档2 原型并行推进。不是「100% 档1 才能动档2」，是「**编排所用 agent 的档1 先到位**」。

### 6.6 档2 的架构骨架：connector（控制统一）+ 可插拔 backend（协议+进程）+ 编排原语

这一节回答「适配层放哪、阶段1 的适配能否延用到档2/3」，并被 openclaw/acpx 的源码分层印证。

**两个不同的「统一点」，别混为一谈**：

| 统一点 | 是什么 | 谁需要 | 阶段1（014）现状 |
|--------|--------|--------|-----------------|
| **① 渲染统一** | 所有后端产出渲染器要的 message/part/turn 模型 | 档1 够用 | ✅ 014 在 **sidecar** 把 ACP→opencode SSE 形状（复用 ADR-029 渲染器） |
| **② 控制统一** | 后端无关的**编程接口**：`prompt / subscribe / cancel / delegate(spawn) / steer` | **档2/3 编排必需** | ❌ 014 未做（仍是 api-client + agent-router 两个 client） |

> 014 的 sidecar 适配解决的是 ①；它**不是** api-client 统一。「ACP→opencode 形状」应理解为「适配到 **Ultrawork 公共事件模型**（当前恰好 == opencode 形状）」的**有意契约**，不是永久假装 opencode。

**档2/3 需要 ②，因此引入 `@agent/connector`（Part II 早有规划）**。openclaw/acpx 的源码给出了**经过验证的分层**，可直接照搬其骨架：

```
前端 / Gateway / Orchestrator
   └─ @agent/connector（控制统一 + 公共事件模型）          ← 阶段2 引入，阶段3 依赖
        ├─ OpenCodeBackend → REST/SSE :4096
        └─ ACPBackend      → :4099 sidecar（ACP↔公共模型 + 进程生命周期 + per-agent 怪癖）
```

- **可插拔 backend = acpx 的等价物**：openclaw 把「ACP 协议适配 + 子进程生命周期」封装成一个 **Backend Plugin**，只对编排层暴露 `supports()` / `runAttempt()` + 注册 **`sessions_spawn` / `sessions_steer`** 两个原语；**编排逻辑全在 openclaw core 一侧**，backend 不关心模式。→ Ultrawork 的 ACPBackend 应同样**只暴露 spawn/steer/cancel/subscribe 原语**，orchestrator 消费原语。
- **复用一个连接、排队多请求**：acpx 用 **queue owner 进程 + 租约 + ownerGeneration**（`waitForCompletion` 控制 fire-and-forget，`accepted→event→result/error` 流式回传）——这正是 connector「复用一个 agent 连接、串行/排队多请求、可取消」的成熟蓝本。
- **委派 = 后台异步任务**：openclaw 的 `sessions_spawn` 是非阻塞 background task，进度经 `streamTo:"parent"` 回流为 system event，完成走独立 announce 通道回卷（**不是**阻塞等待）。Ultrawork orchestrator 应照此设计。
- **宿主能力反向暴露**：把知识库等宿主工具包成一个**内置 MCP server，默认关、显式 opt-in**（openclaw `openclaw-plugin-tools` bridge），`session/new` 时注入给被委派的外部 agent。

**阶段1 的适配能否延用到阶段3？**——① 渲染统一**能延用**（子 agent 事件已是统一形状 → 嵌套子卡片同一渲染器画）；但阶段3 **还需** ② 控制统一（orchestrator 编程式 spawn/await/cancel 子会话）。**所以阶段1 wire 适配 → 阶段2 引入 connector → 阶段3 编排建在 connector 上，是连贯递进、不是返工。**

> **核心建议**：① 先把**档1**做扎实（重点是**异构 agent 归一化**，不是接通）；② 阶段2 引入 **`@agent/connector`**（控制统一，照搬 acpx 的 backend-plugin + queue-owner 骨架）；③ **档2 = delegate/编排**单独立项（自建 orchestrator + 只暴露 spawn/steer 原语 + 模式留上层 + UI 呈现嵌套委派 + 保真度契约），**放弃「对等换手」伪命题**；④ 档3 自动调度远期。

---

## 7. ACP 覆盖不到的部分 & 与宿主能力打通

ACP 是「编码 agent + 编辑器」形状的。它**不覆盖**：IM 多渠道路由、远程/多租户服务、推送到外部 channel、任意非编码 UI 面板。这些恰是 Ultrawork 的差异化（[011](./011-architecture-comparison.md)）。含义：

- **Gateway（钉钉/微信）× 多 agent**：IM 一轮消息要派给某 ACP agent 时，Gateway 也需走「会话 ↔ agent」绑定（与桌面同一套路由抽象）。注意 ACP agent 的流式是 `session/update`，要再经 P1-1 的 block/preview 适配到 IM。**印证**：openclaw 对 IM 正是用 `stream.coalesceIdleMs:300 + maxChunkChars:1200` 合并流式 chunk 再下发——与 [012](./012-p1-execution-plan.md) P1-1 的「block 流式合并」方案、参数量级吻合，可直接复用。
- **知识库 / 宿主工具 → 外部 agent**：外部 ACP agent 默认拿不到 Ultrawork 的 `knowledge_search` 等能力。借鉴 openclaw：**按需注入一个内置 MCP server**（`session/new` 时把宿主 MCP 传给 agent），让外部 agent 反向调用知识库/宿主工具。这是把「Ultrawork 能力」嫁接到「任意 ACP agent」的关键桥。
- **UI 归一化**：不同 agent 的 tool kind、plan、thought 粒度不一；host 渲染需对 ACP 标准 `session/update` 做统一映射（现有分支「复用 opencode 渲染」是对的方向，但要补全 §5 的「事件映射不完整」）。
- **能力异构**：有的 agent 支持 `loadSession`、有的不支持；有的支持 image/audio。需按 `initialize` 协商结果**条件启用 UI**（类 openclaw 条件可见）。

---

## 8. 风险与取舍

1. **战略竞合**：Zed/JetBrains/VS Code 都在做「ACP host」；更直接的是 **[AionUi](./016-aionui-multi-agent-competitor.md)（开源 Electron 多-agent 桌面，已 ship 档1+档2 Team Mode，最贴本愿景）**、**Jockey（Tauri 桌面 + ACP 多 agent 协调）**、**OpenClaw + acpx**（聊天/CLI 形态的编排平台，已支持飞书/钉钉/企业微信 Channel）。Ultrawork 做通用 ACP host 会进入红海（档1/档2 已是追平项，非护城河）。**差异化必须靠 ACP 之外的层**（国内 IM 深度集成 + 本地知识库 RAG + 桌面体验 + 中文场景），而非「又一个能接 claude code 的壳」。注意 OpenClaw 已覆盖国内 IM Channel，「IM 接入」的护城河需更具体（钉钉/微信深度 + IMA 知识库 + 本地 RAG 组合）。
2. **per-agent 进程怪癖**：Claude stall / Gemini OAuth / Copilot 预检 / Windows shell / 各家关闭信号不同——统一 spawn 路径会被边角击穿。**直接移植 acpx 的处理**，否则稳定性堪忧。
3. **保真度预期管理**（档2 delegate）：跨厂商委派时父 orchestrator 只看到子 agent 的**最终交付物**，看不到其推理/diff——损失虽在干净接口上但仍真实。需在 UI 明确「子 agent 交回的是成果、不是全过程」，别让用户以为是「无缝接管」。
4. **维护面爆炸**：每接一个 agent 多一套版本/认证/怪癖。建议**靠 ACP Registry 生态**（`agent name → 命令 + env` 配置表）而非为每个 agent 写专用 connector，降低边际成本。
5. **opencode 双接口的取舍**：opencode 既有 REST/SSE（现用，全功能 + Ultrawork 已深度集成 permission/question/file 等）又有 ACP。**不建议**为了「统一」把 opencode 也改走 ACP——会丢掉现有 REST 集成深度。**建议 connector 抽象同时容纳「opencode-REST」与「ACP」两类后端**（现有 `UnifiedAgent` 正是此意），opencode 继续走 REST，新 agent 走 ACP。
6. **安全**：外部 agent 是任意第三方进程，沙箱（现有 `validatePath`）、权限批准（需补 `request_permission` → UI，别再自动批准）、宿主工具暴露范围（默认关）都要收紧。
7. **与规划中的 `@agent/connector`**：架构 Part II 早已规划 connector 抽象层；本愿景实际上**就是 connector 的最佳落地动机**——可借此把 Desktop/Gateway 对后端的直连，收敛到统一 connector（opencode-REST + ACP 双实现）。

---

## 9. 分阶段路径（基于现有分支，非从零）

**阶段 0 · re-baseline（前置）**
- 把 `feat/acp-support` rebase 到当前 main，解决与 ADR-029（assistant-turn/execution-flow）chat 渲染的冲突；补 `acp-branch.md` 列出的限制中「SSE 事件映射不完整」。产出可合并的「会话级多后端」MVP。

**阶段 1 · 会话级多后端（档1，重点 = 异构 agent 归一化）**
> 分支已证明「管道能通」；本阶段的真正工作量是把**非 opencode agent 的结果与交互做对**（§5 实测信号）。
- 合入 ACP Client Sidecar + UnifiedAgent + agent-selector；agents.json 配置 opencode(REST) / claude(adapter) / qoder / gemini。
- **渲染归一化（核心）**：把消息渲染从「opencode 事件模型」改为**直接消费 ACP 标准 `session/update`**——`agent_message_chunk` / `agent_thought_chunk` / `plan` / `tool_call`(+kind/status/diff/locations) / `usage_update` 各自有标准映射；补全分支「SSE 事件映射不完整」的缺口。
- **交互归一化**：接 ACP `request_permission` → 复用现有 permission-dock（**去掉自动批准**）；按 `initialize` 能力协商**条件启用 UI**（loadSession / image 等）。
- **进程稳定性**：移植 acpx 进程生命周期层（三阶段关闭 + per-agent 特判：Claude stall / Gemini OAuth / Copilot 预检 / Windows shell）。
- **验收（以非 opencode agent 为准，不能只验 opencode）**：对 claude code / gemini / qoder **逐个**验证——流式文本/推理/计划正确渲染、工具调用与 diff 正常显示、需要确认时权限弹窗工作、进程异常能恢复。**任一非 opencode agent 结果/交互不达标，则阶段 1 未完成。**

**阶段 2 · 宿主能力嫁接 + 收敛 connector**
- `session/new` 时把宿主 MCP（知识库等）传给外部 agent（openclaw 式 MCP bridge），让任意 agent 用上 Ultrawork 知识库。
- 把 Desktop/Gateway 的后端访问收敛到统一 `@agent/connector`（opencode-REST + ACP 双实现），兑现 Part II 规划。
- Gateway（钉钉/微信）支持选 agent（复用同一路由抽象 + P1-1 流式适配）。

**阶段 3 · delegate / 编排（档2，「OS」标志能力，独立 ADR）**
- **启动门槛**：不必等所有 agent 档1 全完工——**只要先把要编排的 1–2 个 agent（建议 claude + opencode）档1 归一化做扎实，即可并行启动编排原型**，其余 agent 的归一化与编排开发并行推进（§6.5）。
- 自建跨厂商 orchestrator（opencode 当不了，必须 Ultrawork 做）：父 orchestrator 拥有主对话，经统一抽象 delegate 给外部 ACP agent 子会话，结果以契约（交付物）回卷。
- 先支持最有价值的 1–2 种模式（建议 **Pipeline**（产物串接）+ **Fan-out**（worktree 并行）），agent 驱动与代码驱动 workflow 混合。
- UI 难点：呈现**嵌套委派**（接 [012](./012-p1-execution-plan.md) P1-3 的「task 卡片 → 展开子 session」）。
- 验收：一个可拆解任务能被编排到多个 agent 子会话协作完成，产物可追溯、过程可见。

**阶段 4 · 自动调度（档3，远期研究）**
- router（规则 / LLM）自动决定子任务派给谁，用户可覆盖。

---

## 10. 待决策清单

1. **要不要做这个升级**——它把 Ultrawork 从「opencode 桌面客户端」变成「多 agent host」，是产品定位级决策（与 [011](./011-architecture-comparison.md) 的「差异化应靠 IM+知识库」结论协调：ACP 多后端是能力扩展，护城河仍在 ACP 之外）。
2. **目标定到哪档**：档1（会话级，现成）/ 档2（delegate/编排，需自建 orchestrator）/ 档3（自动调度，远期）？建议先档1，档2 单独立项并采用 delegate/五种模式（**不做「对等换手」**）。
3. **opencode 走 REST 还是 ACP**：建议**保持 REST**，connector 双实现，不为统一牺牲现有集成深度。
4. **接哪些 agent**：claude code（adapter）/ qoder / gemini / codex / copilot——按目标用户取舍（国内场景 qoder 值得优先验证）。
5. **`feat/acp-support` 的处置**：re-baseline 合入，还是参考其设计重写？（28 commit 有价值，但漂移大）
6. **是否同时做 ACP server**（把 Ultrawork 暴露给 Zed/IDE）——独立决策，本愿景不需要，**建议暂不做**。

## 11. 信息缺口

- Qoder ACP 的精确启动 flag（`qoder acp` vs `--acp`）来源有歧义，落地前需实测。
- ACP 远程（HTTP/WS）传输仍 WIP——目前多后端只能本地 stdio 子进程（对桌面 OK，对远程/移动需另想）。
- `feat/acp-support` 与当前 main 的实际冲突面未逐文件评估（仅从 diff stat 推断漂移）；re-baseline 工作量需实测。
- hermes 通用 ACP client（#5257）未合并，无可参考的成熟多-agent-client 代码——参考对象应是 **acpx**。

### 来源

- **ACP 协议/生态**：[agentclientprotocol.com](https://agentclientprotocol.com/get-started/introduction) · [agents 列表](https://agentclientprotocol.com/get-started/agents) · [opencode ACP](https://opencode.ai/docs/acp/) · [zed.dev/acp](https://zed.dev/acp) · [claude-code-acp（Zed blog）](https://zed.dev/blog/claude-code-via-acp) · host SDK：[Rust](https://docs.rs/agent-client-protocol/) / [TS](https://agentclientprotocol.github.io/typescript-sdk/)
- **openclaw acpx（源码级，github.com/openclaw/acpx）**：`src/acp/client.ts`、`agent-command.ts`、`src/session/conversation-model.ts`、`src/permissions.ts`、`src/agent-registry.ts` 等逐文件读（详见 [014](./014-stage1-acp-normalization-plan.md) 来源）· [AGENTS.md](https://github.com/openclaw/acpx/blob/main/AGENTS.md)
- **openclaw 编排层（源码/文档核实）**：[ACP agents](https://docs.openclaw.ai/tools/acp-agents) · [setup/MCP bridge](https://docs.openclaw.ai/tools/acp-agents-setup) · [Multi-agent bindings](https://docs.openclaw.ai/concepts/multi-agent) · [Configuration reference](https://docs.openclaw.ai/gateway/configuration-reference) · [DeepWiki backend-plugin](https://deepwiki.com/openclaw/docs/6.4-acp-agents-and-multi-agent-tools)。**经此核实纠正了桌面调研文档的失实**：`/acp fanout`/`/acp debate` 命令与 `dispatch.rules` 规则引擎均不存在（§6.2/§6.3）。
- **hermes ACP**：[ACP Internals](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals) · [Issue #5257](https://github.com/NousResearch/hermes-agent/issues/5257)
- **Ultrawork 现状**：`feat/acp-support` 分支（28 commit）+ 专题记忆 `acp-branch.md` + ADR-027（预留）+ [architecture-phase1.md](../architecture-phase1.md) Part II（@agent/connector 规划）
- **桌面调研资料（用户提供，整合于 §4.x / §6 delegate-编排模型 / §8）**：《OpenClaw+acpx 编码 Agent 编排方案调研》（三层栈、五种编排模式、opencode 作 Server 不作 Client、dispatch 路由、stream 合并参数、Jockey 等竞品）、《ACP 协议技术调研报告》（ACP-Zed vs IBM-ACP/A2A 区分、MCP/ACP/A2A 三层协议栈、生态支持现状）。这两份与本文外部网络调研相互印证。
