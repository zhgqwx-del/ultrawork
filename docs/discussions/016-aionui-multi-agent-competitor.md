# 016 · AionUi 多 agent 调研 — 直接竞品 + 档1/档2 实现参考 + D-8/ADR-031 验证

> **状态**：调研记录（AionUi 架构的事实性调研，可信赖）+ 讨论中（据此提的竞品定位与实现参考，待评审）
> **日期**：2026-06-10
> **范围**：纯调研 + 分析，**不修改代码**。
> **缘起**：[iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) 是与本项目「Agent OS」愿景**几乎同形态**的开源桌面多-agent 客户端，且**已 ship 档1（并行多后端）+ 档2（Team Mode 编排）**。评估它对 [ADR-027](../decisions/027-acp-multi-agent-backend.md)/[030](../decisions/030-agent-connector-control-layer.md)/[031](../decisions/031-multi-agent-orchestration.md) + [agent-os-target-architecture.md](../agent-os-target-architecture.md) 的验证、参考与竞品含义。
> **置信度**：核心代码级断言（`NON_ACP_BACKENDS`、Team/TeamAgent 数据模型、`TeamMcpPhase` 状态机、IPC 事件、Team MCP Server、SQLite mailbox/team_tasks 表）**已于 2026-06-10 直读 AionUi 源码核验**（`gh` × `iOfficeAI/AionUi`，文件:行见 §4/§9）——与用户桌面调研 doc 一致。**仍未做运行实测**（mailbox 实际行为/失败恢复/冲突协调按代码结构推断）。其余（官网/wiki 描述、roadmap）为 web 检索。
> **承接**：[011](./011-architecture-comparison.md)（横向对标）· [013](./013-agent-os-acp-multi-backend.md)（Agent OS 可行性）· [015](./015-backend-taxonomy-non-acp.md)（backend 分类法）。

---

## TL;DR

1. **AionUi = 迄今最贴近我们愿景的成熟竞品**：开源跨平台桌面（**Electron** + React19 + Bun），经 ACP（`@agentclientprotocol/sdk` **v0.18.2**）接 20+ CLI agent + 自带内置 agent（Aion CLI/aionrs，Rust），PATH 自动检测，已 ship v1.9.x。
2. **它独立走到了和我们几乎相同的架构**——逐条**验证**我们的决策：一会话绑一 agent（否决对等换手）、ACP + 产品自有协议两族（D-8）、Team Mode = 经宿主 MCP 的 Leader-delegate（档2/ADR-031）、shared/isolated 工作区（Fan-out 隔离）。
3. **最强佐证**：AionUi 代码 `NON_ACP_BACKENDS = {aionrs, openclaw-gateway, nanobot, remote}`，其余走 `acp`——**与 ADR-030 D-8「ACP vs product-native」一字不差**，且**独立证实 [015](./015-backend-taxonomy-non-acp.md) 的 openclaw 走 gateway（WebSocket）非 ACP**。
4. **它已 ship 档2（Team Mode）= 我们档2 设计被现网产品证明可行**（降风险），但也意味**档1/档2 本身不是护城河**——AionUi **无 IM 渠道、无知识库/RAG**，差异化仍在 ACP 之外（钉钉/微信 + IMA RAG + 中文）。
5. **可直接借鉴的落地蓝本**：Team MCP Server、MCP 注入状态机、Team 数据模型、IPC 事件集、SQLite 持久化、per-agent 换模型/独立权限。

---

## 1. 项目概述
- **技术栈**：Electron + Vite + React 19 + Bun（**对比**：Ultrawork = Tauri，更轻，见 [discussions/009](./009-tauri-vs-electron.md)）。
- **定位**：「把多个 CLI Agent 统一到一个界面协作」的 Cowork 平台；本地、开源、免费。
- **规模**：支持 20+ agent（Claude Code/Codex/Qwen/Goose/OpenClaw/Hermes/OpenCode/Gemini CLI/Qoder CLI/Copilot/Kimi/Mistral Vibe/Nanobot…）+ **内置 agent**（Aion CLI/aionrs，开箱即用，零外部依赖）。

## 2. 接入模型
| 层面 | AionUi |
|------|--------|
| 协议 | ACP（JSON-RPC 2.0，本地 stdio / 远端 HTTP·WebSocket）；SDK `@agentclientprotocol/sdk` v0.18.2 |
| **协议路由** | ✅源码 `common/adapter/teamMapper.ts:51`：`const NON_ACP_BACKENDS = new Set(['aionrs','openclaw-gateway','nanobot','remote'])`；`resolveConversationType(backend) = NON_ACP_BACKENDS.has(backend) ? backend : 'acp'`——**ACP 是默认，少数后端走原生协议** |
| agent 发现 | 启动扫 `PATH` + 常见二进制目录，自动点亮已装 CLI |
| 连接 | 每个外部 agent 一个独立子进程，ACP 桥接 JSON-RPC |
| 认证 | **不代管凭证**——每个 CLI 自管 auth/config |
| MCP | `@modelcontextprotocol/sdk` 统一管理工具/资源；**配一次同步到所有 agent** |
| 自定义 agent | 「Custom Agents」手动注册，暴露 `mcpCapabilities.stdio` 即可被 ACP 管理 |

## 3. 会话与并行（= 我们的档1）
- **一会话绑一 agent，不能会话内切换**（切 agent = 新建会话）。✅ 对齐 ADR-027 D-2 / 否决对等换手。
- **Parallel Sessions**：多会话窗口、各绑不同 agent、独立上下文与内存、互不干扰。

## 4. Team Mode（= 我们的档2 delegate 编排）
**架构**：Leader Agent 接收用户任务 → 拆解 → 经**内置 Team MCP Server** 分派子任务 → Teammate（Claude/Codex/Gemini/Snow/aionrs）并行执行 → **异步 mailbox 回传** → Leader 汇总输出。

- **Team 数据模型**（✅源码 `common/types/team/teamTypes.ts:16-44`）：`TTeam{ workspace, workspace_mode:'shared'|'isolated', leader_agent_id, agents[] }`；`TeamAgent{ slot_id, conversation_id（每 agent 独立会话）, role:'leader'|'teammate', agent_type, conversation_type, status:'pending'|'idle'|'active'|'completed'|'failed', model?, cli_path? }`（后端原始 status `idle|working|thinking|tool_use|completed|error` 经 `teamMapper.toStatus()` 映射到这 5 态）。
- **Team MCP Server**（协作枢纽，stdio MCP server）：任务分发（Leader→Teammate）+ 结果回收（mailbox）+ 共享任务板。⚠️**源码核验修正（2026-06-10）**：**其 handler 实现体不在公开源码树**——全 4 package 完整检出后，`mailbox`/`team_tasks` 仅在 `schema.ts`/`migrations.ts`（建表），**无任何源文件读写**；唯一 stdio MCP server 源是 `imageGenServer.ts`；`team-mcp-stdio.js`/`team-guide-mcp-stdio.js` 只在 `electron-builder.yml` 作**预构建产物 glob**（`build-mcp-servers.js` 只编 image-gen、vite input 也无）。→ **DB 表结构 + 类型 + e2e + 打包件证实它运行期真实存在，但分发/mailbox 的 tool handler 逻辑是外置预构建件、源不公开，无法从源码坐实。**
- **MCP 注入管线状态机**（✅源码 `teamTypes.ts:105`，`TeamMcpPhase`）：`tcp_ready → session_injecting → session_ready → mcp_tools_waiting → mcp_tools_ready`（失败 → `session_error / degraded / load_failed`）。
- **隔离**：每 Teammate 独立 session + 独立权限；workspace `shared`（Leader 协调文件冲突）或 `isolated`。
- **IPC 事件**（✅源码 `teamTypes.ts`）：`agentStatusChanged / agentSpawned / agentRemoved / agentRenamed / teamTeammateMessage / teamMcpStatus`。
- **持久化**：Team Manager 用 **SQLite**（表 `teams`/`mailbox`/`team_tasks`，✅`schema.ts`，跨重启）。
- **UI**：并行面板（每 agent ≥400px、可横滚、可全屏）、Leader 蓝色边框区分、运行时 per-agent 换模型、per-agent 独立权限弹窗 + 侧栏待处理 badge、运行时动态增减 Teammate。

## 5. 与 Ultrawork 决策的映射

### 5.1 验证（AionUi 现网印证我们的设计）
| 我们的决策 | AionUi 对应 | 结论 |
|-----------|------------|------|
| ADR-027 D-2 档1：一会话一 agent、**否决对等换手** | 一会话绑一 agent、不能会话内切换 | ✅ 验证 |
| **ADR-030 D-8**：ACP 标准 vs product-native 两族 | `NON_ACP_BACKENDS={aionrs,openclaw-gateway,nanobot,remote}` else `acp`（✅源码 `teamMapper.ts:51`） | ✅✅✅ **一字不差（源码核验）** |
| [015](./015-backend-taxonomy-non-acp.md)：openclaw 走 gateway(WebSocket) 非 ACP | `openclaw-gateway` ∈ NON_ACP_BACKENDS | ✅ 独立佐证 |
| ADR-031 D-1：orchestrator 拥主对话 + 经**宿主 MCP bridge** delegate | Team Mode：Leader + **内置 Team MCP Server** 分派 | ✅✅ 同构 |
| ADR-031 D-2：子任务 + 交付物回卷（非 transcript 注入） | 子任务分派 + **异步 mailbox 回传** | ✅ 验证 |
| ADR-031 D-4：Fan-out 隔离 cwd/worktree | `workspace_mode: shared\|isolated` | ✅ 验证 |
| capabilities/permission/per-agent model | per-agent 独立权限 + 运行时换模型 | ✅ 验证 |

### 5.2 差异（我们的取舍）
- **opencode**：我们保留 **REST 深度集成**（ADR-027 D-1）；AionUi 把大多数走 ACP（但它**也有** NON_ACP 原生后端——同样是「ACP + native」混合，不是纯 ACP）。
- **内置 agent**：AionUi 自建 Aion CLI（aionrs）作 default；我们 default 是 opencode（product-native HTTP+SSE）。形态一致（都有一个特权 native 默认后端）。
- **壳**：Tauri（我们）vs Electron（它）。
- **护城河**：AionUi **无 IM 渠道、无 RAG/知识库**——纯编码 cowork。我们的差异化（钉钉/微信 + IMA RAG + 中文）它不覆盖。

## 6. 可借鉴的实现参考（落地蓝本）
- **Team MCP Server** = ADR-031「delegate 经宿主 MCP bridge」的现成范式（任务分发 + mailbox 回收 + 共享任务板）。
- **MCP 注入状态机**（`tcp_ready→…→mcp_tools_ready` + degraded/error）→ 我们 ADR-027 W4 宿主 MCP 透传的落地状态机参考。
- **协议路由** `NON_ACP_BACKENDS` set → 与 connector 的 backend kind 派发（D-8）同构，可照搬「默认 acp、白名单走原生」。
- **Team / TeamAgent 数据模型**（slot_id/conversation_id/role/agent_type/conversation_type/status/model）→ orchestrator 数据模型参考。
- **IPC 事件集** → 编排 UI 的事件模型参考（接 ADR-029 ExecutionFlow + ADR-031 D-7 嵌套委派）。
- **SQLite 持久化** → 补 [013](./013-agent-os-acp-multi-backend.md) §5 的「消息/会话不跨重启」缺口。
- **per-agent 独立权限 + badge / 并行面板 UI** → 编排/并行会话 UI 参考。
- **UI 共存范式（源码核实）**：Team Mode = 独立页 `renderer/pages/team`；非-Team = 普通 `renderer/pages/conversation` 单会话页**完全不变**——编排**不织进单聊天、另开 surface**。→ 我们档2 走独立 opt-in 路由的现成模式，**主聊天零侵入**（接 [agent-os-target-architecture.md](../agent-os-target-architecture.md) §3.6）。
- **许可证**：Apache-2.0 → 可借鉴甚至 copy 代码（保留归属/NOTICE）；但 Tauri vs Electron + SSE vs IPC，多为**模式参考**而非 1:1 搬运，编排 handler 源不公开须自研。

## 7. 竞品定位与护城河含义
- AionUi 比 [Jockey / openclaw+acpx](./013-agent-os-acp-multi-backend.md#8-风险与取舍) **更贴**我们的形态，且**已 ship 档1+档2**。→ **「能调度多 agent + 跨厂商编排」本身不是护城河**，是追平项。
- **护城河仍成立且更需聚焦**：AionUi（及 openclaw 之外的多数竞品）在**国内 IM 深度（钉钉/微信）+ 本地 RAG（IMA 知识库）+ 中文场景**上是空白。Ultrawork 的差异化必须压在 **ACP 之外的这层**，而非「又一个能接 claude code 的壳」。
- **节奏含义**：档1/档2 已有成熟开源实现 → 我们可**大胆借鉴其已验证的范式**（降风险、提速），把自研预算更多投向护城河层。

## 8. 对现有文档的影响（待评审后落地）
| 文档 | 修订点 |
|------|--------|
| **011 横向对标** | 加 AionUi 一节/一行（最贴竞品：Electron 多-agent 桌面、20+ agent、Team Mode 编排、无 IM/RAG） |
| **ADR-030 D-8** | 加一句「AionUi `NON_ACP_BACKENDS` 现网佐证 ACP vs product-native 分野（含 openclaw-gateway）」 |
| **ADR-031**（档2） | 背景的 delegate 先例加 **AionUi Team Mode**（现网已 ship，降风险）；实现章节加「Team MCP Server / MCP 注入状态机 / Team 数据模型」为参考 |
| **013 §8 / 015 / target-arch §9 竞合** | 加 AionUi + 收紧护城河表述（档1/档2 = 追平，护城河在 ACP 之外） |
| **013 / 015** | 可加 forward-pointer 指向 016 |

## 9. 信息缺口 / 置信度
- ✅ **核心代码级断言已源码核验**（2026-06-10，`gh` + 完整稀疏检出 × `iOfficeAI/AionUi`）：`NON_ACP_BACKENDS`/`resolveConversationType`（`teamMapper.ts:51`）、Team/TeamAgent 数据模型 + `TeamMcpPhase` 状态机 + IPC 事件（`teamTypes.ts`）、SQLite `teams`/`mailbox`/`team_tasks` 表结构（`schema.ts`）——均与本文一致。Team MCP Server **运行期真实存在**（打包件 glob + e2e 套件驱动 Leader 增删成员），但其 **handler 源不在公开 repo**（见下条）。
- ⚠️ **Team MCP Server handler 源不在公开 repo（2026-06-10 完整稀疏检出确认）**：分发/mailbox/任务板的 tool handler 实现体是**预构建件 `team-mcp-stdio.js`**，公开源码树（`packages/*/src`）里无任何文件读写 `mailbox`/`team_tasks`、无第二个 stdio MCP server。→ **「分发/mailbox 逻辑」只能从 DB schema + 类型 + e2e + 打包件推断其存在与数据流，无法从源码逐行坐实**；要看实现需反编译预构建件或等其开源。
- **仍未运行实测**：mailbox 实际行为、共享任务板冲突协调、失败恢复未跑起来观察。
- **SDK 版本差异**：AionUi 用 `@agentclientprotocol/sdk` v0.18.2，我们 [B3](../agent-os-target-architecture.md) 倾向 ≥0.21.x——生态版本区间的数据点，落地前复核。
- **是否有 IM/RAG 演进**：当前判断 AionUi 无 IM 渠道/知识库；其 roadmap 未深查，护城河判断按现状。

---

### 来源
- **AionUi**：[GitHub iOfficeAI/AionUi](https://github.com/iOfficeAI/AionUi) · [Wiki: ACP Setup](https://github.com/iOfficeAI/AionUi/wiki/ACP-Setup) · [Wiki: Getting Started](https://github.com/iOfficeAI/AionUi/wiki/Getting-Started) · [DeepWiki](https://deepwiki.com/iOfficeAI/AionUi) · [官网](https://aionui.site/) · [多-agent setup guide](https://aionui.site/blog/multi-agent-setup-guide/) · [Issue #2384（ACP agents 用 AionUi 配置的 LLM）](https://github.com/iOfficeAI/AionUi/issues/2384)
- **用户调研 doc**：`~/Desktop/AionUi 多agent调研.md`（含仓库代码片段、Team 数据模型、状态机、UI 结构——本文一手依据）
- **内部**：[011](./011-architecture-comparison.md) · [013](./013-agent-os-acp-multi-backend.md) · [015](./015-backend-taxonomy-non-acp.md) · [ADR-027](../decisions/027-acp-multi-agent-backend.md) / [030](../decisions/030-agent-connector-control-layer.md) / [031](../decisions/031-multi-agent-orchestration.md) · [agent-os-target-architecture.md](../agent-os-target-architecture.md)
