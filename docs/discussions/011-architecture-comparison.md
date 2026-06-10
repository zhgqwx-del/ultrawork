# 011 · Ultrawork 架构横向对标 — openclaw / hermes-agent / opencode desktop

> **状态**：调研记录（外部项目事实部分）+ 讨论中（第 4/5 节的优劣判断与建议为提案，未定论）
> **日期**：2026-06-08
> **范围**：纯调研 / 分析 / 文档，**不修改任何代码**。
> **对标对象**：
> - [openclaw/openclaw](https://github.com/openclaw/openclaw) — 自托管个人多渠道 AI 助理
> - [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) — 自我进化的通用个人 agent
> - [anomalyco/opencode](https://github.com/anomalyco/opencode) `packages/desktop` — opencode 官方桌面客户端

---

## TL;DR

1. **战略验证**：Ultrawork 的核心架构思路——「**headless agent runtime + 多渠道接入 + 客户端薄壳**」——被三个对标项目全部独立采用，是一条被反复验证的成熟路径。Ultrawork「包装 opencode 而非自研 agent loop」的取舍，被 opencode 官方桌面版（同一形态：复用 opencode server）直接背书。

2. **最大的战略发现**：`anomalyco/opencode` 就是 `sst/opencode` 的官方改组仓库，并且**已经有了官方桌面版 `packages/desktop`（Electron + Solid.js，beta）**。这意味着 Ultrawork 在「opencode 桌面化」这件事上**不再有先发独占空间**——Ultrawork 的真正护城河应明确转向官方版**不做**的部分：**国内 IM 生态（钉钉/微信/IMA）+ 本地 RAG 知识库**，而非通用编码体验本身。

3. **三个能力短板（对标项目已验证其价值，Ultrawork 规划中或缺失）**：
   - **持久记忆 / Agent 身份**（SOUL/MEMORY/USER）：openclaw 与 hermes 都重投入；Ultrawork 仅 Part II 规划。
   - **IM 渠道的「块流式」输出**：openclaw 的 block/preview 两层流式，正好解决 Ultrawork Gateway 当前「累积全文 + 20KB 截断 + 3min 空闲超时」的体验断裂。
   - **主动服务 / 定时任务（cron/heartbeat）**：openclaw、hermes 均内置；Ultrawork 仅规划。

4. **Ultrawork 的独特优势**：本地 RAG 知识库（SQLite+FTS5+向量+RRF，父子分块）是三个对标项目里**最完整的本地检索实现**——其余项目主要靠「记忆 + 工具」而非工程化 RAG。这是值得继续强化的差异点。

---

## 1. Ultrawork 现状架构速览（以代码为准）

> 详见 [architecture-phase1.md](../architecture-phase1.md) Part I 与 [AGENTS.md](../../AGENTS.md)。本节只提炼对比所需骨架。

**形态**：Tauri 2 桌面壳，启动时 spawn 三个独立 OS 进程 sidecar：

| 进程 | 端口 | 来源 | 职责 |
|------|------|------|------|
| OpenCode Server | 4096 | `vendor/opencode` 编译二进制 | **agent loop / session / 工具编排 / provider / MCP**（全部复用上游） |
| Channel Gateway | 4097 | Ultrawork 自研（Hono on Bun） | 钉钉 / 微信 桥接到同一 agent 后端 |
| Knowledge Sidecar | 4098 | Ultrawork 自研 | 本地 RAG + IMA 知识库，经 MCP 暴露给 agent |

**关键边界**：Ultrawork **不实现 agent 核心**，只在 opencode 之上加：① Tauri 壳与进程生命周期（`src-tauri/src/lib.rs`，端口复用 + 健康检查 + 二阶段关闭）；② IM Gateway；③ Knowledge RAG；④ React 前端（全局 SSE 单连接分发，虚拟窗口 + 分页）；⑤ 对 opencode 的 5 个 patch（app 名隔离 `OPENCODE_APP_NAME`、跳过 `~/.opencode` 搜索、MCP 连接超时 5s、跨编译 `--target`、PINNED_PLUGIN_VERSION）。

**数据流**：前端 `POST /session/:id/prompt_async`（204 异步）→ opencode Bus 发布事件 → `GET /event`（SSE）→ 前端 `use-session-messages` 累积渲染。Gateway 复用同一 SSE + prompt_async 链路，把 IM 消息映射成 session。

**对 opencode 的定制极克制**：patch 只动隔离与性能，不碰 agent 逻辑——保留了跟随上游升级的能力（代价见 §4 升级债）。

---

## 2. 三个对标项目架构提炼

### 2.1 openclaw — 个人多渠道 AI 助理（TS / Node）

- **定位**：自托管、跑在自己设备上、接入「你已经在用的 IM」（WhatsApp/Telegram/Slack/Discord/Signal/iMessage/飞书/微信/QQ… 20+）。config-first：写一个 `SOUL.md` + 一条命令即上线。
- **架构**：单一长驻 **Gateway daemon（control plane）** 拥有所有渠道/会话/工具，对外暴露 **typed WebSocket API**（默认 `127.0.0.1:18789`，JSON Schema 校验，设备 keypair 身份 + pairing 审批）。CLI / WebChat / macOS 菜单栏 app / 移动端 node 全用同一 WS 协议接入（role: operator / node）。
- **agent loop**：`intake → context assembly → inference → tool execution → streaming → persistence`。`agent` RPC 立即返回 `{runId}`（异步），`agent.wait` 等结束。按 session key 串行化（session lane）。
- **多 agent**：单进程内多个隔离 agent（独立 workspace/状态目录/认证 profile），入站消息按 **bindings**（channel+account+peer specificity 分级）路由。**Sub-agent**：`sessions_spawn` 非阻塞派生，`maxConcurrent=8`，可给子 agent 配更便宜模型，`sessions_yield` 等待。
- **流式（关键借鉴点）**：**两层**——① Block streaming（发到渠道）：不是 token-delta，而是 `EmbeddedBlockChunker` 按 minChars/maxChars 在段落/句子边界切块、**绝不在代码 fence 内截断**；② Preview streaming（Telegram/Discord/Slack）：send-and-edit 更新临时预览消息，工具进度实时写入。
- **MCP**：原生，**既是 client 也是 server**（`openclaw mcp serve` 把渠道会话作为 MCP 暴露）。三传输 stdio/SSE/Streamable HTTP + OAuth。
- **存储**：**SQLite only**（Kysely），禁止运行时 JSON/JSONL。
- **provider**：`llm-core`/`model-catalog`，80+ provider，内置 failover。

### 2.2 hermes-agent — 自我进化通用个人 agent（Python）

> 纠偏：这是**完整 agent 应用**，不是 Hermes 模型的 function-calling 格式库；**不绑定 Hermes 模型**，支持 200+ 模型。

- **定位**：「the only agent with a built-in learning loop」——从经验自动创建 skill、跨会话搜索历史、构建用户画像。通用个人助理（coding 只是它众多工具之一），强调「跑在任意基础设施」（VPS/Docker/SSH/Modal/Daytona serverless）+ 多 IM 接入。
- **入口**：CLI（prompt_toolkit）/ Gateway（多平台适配）/ TUI（Ink/React，与 Python 后端走 stdio 上的换行分隔 JSON-RPC）。
- **agent loop**：经典同步 while（`conversation_loop.py`）：构建 messages → 注入 ephemeral 记忆 → token 估算/压缩 → 流式调模型 → 有 tool_calls 则逐个执行回填，否则结束。`IterationBudget` + 宽限收尾调用。
- **工具协议**：用各 provider **原生结构化 tool-calling**（非 Hermes XML），`api_mode` 适配 chat_completions/anthropic_messages/bedrock_converse/codex_responses。**双层门控**：schema 注册 ≠ 暴露，只有进 `toolsets.py` 的工具才对 agent 可见。~99 个工具。
- **多 agent**：`delegate_tool.py`，子 agent = ThreadPoolExecutor 里的子 `AIAgent`（默认 3 并发），全新对话、收窄 toolset、可换便宜模型、`max_spawn_depth` 默认 1。
- **记忆（关键借鉴点）**：多层持久文件 **SOUL.md（人格）/ MEMORY.md（结构化记忆）/ USER.md（用户画像）** + skills（程序性记忆）+ SQLite FTS5 会话搜索。回合前 `prefetch_all()` 召回并包进 `<memory-context>` fenced block 标注「这是回忆非新输入」，回合后 `sync_all()` 写回。
- **设计纪律（关键借鉴点）**：**prompt cache 不可侵犯**——system prompt 三层（stable/context/volatile），时间戳故意只到「日期」不到「时分」以稳定缓存；回合中途换 toolset/重载记忆会击穿缓存 → slash 命令默认把状态变更推迟到下个会话。
- **provider**：声明式 `ProviderProfile` 单一数据源；以插件形式发现，用户插件可覆盖内置。

### 2.3 opencode desktop — opencode 官方桌面客户端（TS / Bun）

> `anomalyco/opencode` = `sst/opencode` 官方改组后仓库（**非 fork**，同一团队）。`packages/desktop` 是其官方桌面版（beta）。

- **定位**：与 Ultrawork **形态最接近的对标**——同一个 opencode headless server，配 TUI / Desktop / IDE 三种 client。桌面端 = **Electron 41 + Solid.js**（复用 monorepo `@opencode-ai/app`+`@opencode-ai/ui`，与 web 端共享组件）。
- **后端集成（最关键的对比差异）**：桌面端**不 spawn 独立编译二进制**，而是用 Electron `utilityProcess.fork` 跑 `sidecar.js`，内部 `import("virtual:opencode-server")` —— 把 opencode server 作为 **electron-vite 虚拟模块打包进 app，in-process 启动**（`Server.listen({port, username:"opencode", password, cors:["oc://renderer"]})`）。健康检查每 100ms 轮询 `/global/health`（3s 超时），停止 6s 超时后强杀。
- **agent / 多 agent**：全在 server 端。主 agent **Build / Plan**（Tab 切换）+ 内置 subagent **General / Explore / Scout**（跑在 child session，`@mention` 或自动委派）。细粒度权限（file/bash/webfetch/lsp/MCP 可 allow/ask/deny + glob）。
- **MCP**：原生，本地 + 远程，远程 **OAuth 全自动含 RFC 7591 动态注册**。
- **provider**：Vercel AI SDK + Models.dev，75+ provider，本地 Ollama/LM Studio/llama.cpp，任意 OpenAI 兼容 baseURL。
- **持久化 / 流式**：server 端 SQLite（Drizzle + Effect），桌面本地配置 `electron-store`；流式 **SSE**（`/event` + `/global/event`），与 Ultrawork 同源。

### 2.4 AionUi — 开源多-agent 桌面 Cowork（TS / Electron）｜**形态最贴「Agent OS」愿景的竞品**
> 详见 [discussions/016](./016-aionui-multi-agent-competitor.md)（源级调研 + 实现参考 + 对我们决策的验证）。本节只提炼对比骨架。

- **定位**：开源跨平台桌面（**Electron + React19 + Bun**），「把 20+ CLI agent 统一到一界面协作」。经 **ACP**（`@agentclientprotocol/sdk` 0.18.2）接 Claude/Codex/Qwen/Goose/OpenClaw/Hermes/OpenCode/Gemini/Qoder… + 自带内置 agent（Aion CLI/aionrs）。
- **后端模型**：PATH 自动检测；`NON_ACP_BACKENDS={aionrs,openclaw-gateway,nanobot,remote}` 走原生协议、其余走 ACP——**与我们 ADR-030 D-8 的「ACP vs product-native」一字不差**。
- **多 agent**：一会话绑一 agent（不支持会话内切换）+ Parallel Sessions（档1）；**Team Mode = Leader-Teammate 编排**（经内置 Team MCP Server 分派 + 异步 mailbox 回卷 + shared/isolated 工作区）——**已 ship 的档2**，与我们 ADR-031 同构。
- **空白**：**无国内 IM 渠道、无知识库/RAG**——纯编码 cowork。→ 它印证「档1/档2 是追平项」，**护城河仍在 ACP 之外**（与本文 §5 P0 一致）。

---

## 3. 多维横向对比

| 维度 | **Ultrawork** | openclaw | hermes-agent | opencode desktop |
|------|---------------|----------|--------------|------------------|
| **核心定位** | 桌面编码 agent + 国内 IM/知识库 | 个人多渠道 IM 助理 | 自进化通用个人 agent | 官方编码 agent 桌面版 |
| **语言/运行时** | TS + Rust(Tauri) / Bun | TS / Node 24 | Python 3.11+ / uv | TS / Bun |
| **桌面框架** | **Tauri 2 + React 19** | 无单体桌面（daemon + 可选 companion app） | 无（CLI/TUI/Gateway） | **Electron 41 + Solid.js** |
| **agent loop 归属** | **复用 opencode（不自研）** | 自研嵌入式 runtime | 自研同步循环 | opencode server（自研） |
| **后端进程模型** | 独立编译二进制 sidecar（OS 进程） | 单一长驻 daemon | 单进程多入口 | Electron utilityProcess 内打包 server JS |
| **控制面协议** | HTTP + SSE | **WebSocket**（typed + pairing） | JSON-RPC over stdio（TUI） | HTTP + SSE |
| **多 agent / subagent** | 继承 opencode（Build/Plan + General/Explore/Scout），**UI 未充分暴露** | bindings 路由 + sessions_spawn | delegate_tool（线程池） | Build/Plan + 3 subagent，UI 已暴露 |
| **持久记忆 / agent 身份** | 🔲 仅 Part II 规划 | ✅ SOUL.md + SQLite | ✅ **SOUL/MEMORY/USER + FTS5** | ❌（编码 agent，靠项目 AGENTS.md） |
| **多渠道 IM** | ✅ 钉钉 / 微信（自研 Gateway） | ✅ **20+ 平台** | ✅ Telegram/Discord/Slack/微信/钉钉/飞书 | ❌ |
| **IM 流式策略** | ⚠️ 累积全文 + 20KB 截断 + 3min 空闲超时 | ✅ **block + preview 两层** | 流式 + 平台适配 | N/A |
| **本地 RAG 知识库** | ✅ **SQLite+FTS5+向量+RRF+父子分块**（最完整） | 靠 memory + 工具 | 靠 memory + session FTS5 | ❌ |
| **MCP** | 继承 opencode（client） | **client + server 双向** | client（OAuth/sampling/熔断） | client（OAuth + RFC 7591） |
| **provider 抽象** | 继承 opencode + 自定义 provider | 80+ / failover | 声明式 profile / 200+ | AI SDK / 75+ |
| **主动服务 / cron** | 🔲 规划 | ✅ cron + standing orders | ✅ cron | ❌ |
| **持久化真相源** | opencode SQLite + `~/.ultrawork/*.json` | SQLite only | SQLite + Markdown 记忆文件 | SQLite(Drizzle) + electron-store |
| **安全模型** | sidecar 随机 32B Basic Auth | 设备 keypair + pairing 审批 | env 过滤/凭证脱敏/OSV 扫描 | Basic Auth + oc:// 协议隔离 |
| **包体** | 壳 ~12MB + sidecar ~245MB | daemon（无桌面体积） | Python 依赖 | Electron runtime（大） |

---

## 4. 优劣分析

### 4.1 Ultrawork 的优势（被对比凸显）

1. **「包装 opencode」是正确取舍，且被官方背书**。opencode desktop 同样复用 opencode server，证明「不自研 agent loop」是主流做法。Ultrawork 由此免费获得：持续跟随上游的工具/provider/多 agent 能力，团队精力可集中在差异化层（IM + 知识库 + 桌面体验）。
2. **本地 RAG 是三者中最工程化的**。BM25 + 向量 + RRF 融合 + 父子分块 + 增量索引 + 多源适配（IMA），是一套完整检索系统；其余项目的「知识」主要是记忆/会话搜索，没有这种文档级 RAG。
3. **Tauri 轻壳**带来极小的壳体积（12MB vs Electron runtime）与更低内存占用——对桌面分发是真实优势（见 [009-tauri-vs-electron](./009-tauri-vs-electron.md)）。
4. **国内 IM 生态**（钉钉 Stream / 微信 ilink / IMA 知识库）是英文圈三个项目都不覆盖的市场，是天然护城河。
5. **patch 克制 + 单累积 patch 管理**，保留了上游升级路径（架构纪律好）。

### 4.2 Ultrawork 的劣势 / 风险（被对比暴露）

1. **战略风险：官方桌面版已存在**。opencode 官方 `packages/desktop` 出现后，「opencode 桌面化」本身不再是独占卖点。若 Ultrawork 的叙事仍停留在「桌面编码 agent」，会直面官方竞争且落后于上游迭代速度。**应明确把叙事重心移到 IM + 知识库 + 国内场景。**
2. **缺持久记忆 / agent 身份**。openclaw 和 hermes 都把 SOUL/MEMORY/USER 当一等公民——这正是「个人助理」与「一次性会话工具」的分水岭。Ultrawork 的 Agent Workspace 还停留在 Part II 草案，`~/.ultrawork/` 仅做目录与配置，无跨会话人格/记忆注入。
3. **IM 流式体验断裂**。Gateway 当前是「等 `message.updated(finish=true)` 或 3min 空闲超时才回复 + 20KB 硬截断」。openclaw 的 block/preview 两层流式是针对 IM 平台特性的成熟解法，Ultrawork 这块明显落后（且 3min 超时兜底在 SSE 漏事件时体验很差）。
4. **多 agent / subagent 能力未在 UI 暴露**。opencode 本身已有 Build/Plan + General/Explore/Scout，opencode desktop 已把它做进 UI（Tab 切换 + @mention + child session 导航）。Ultrawork 复用了同一 server 却未充分把这套编排能力呈现给用户——能力被「藏」住了。（ACP 多 agent 在 `feat/acp-support` 分支，见 [acp-branch]。）
5. **重二进制 sidecar 的升级债**。245MB sidecar + 跨编译 `--target` patch + PINNED_PLUGIN_VERSION，意味着每次升级 opencode 都要重编译、重打 patch、验证跨架构。对比 opencode desktop 的「虚拟模块 in-process 打包」省掉了交叉编译——但那是 Electron 路线的副产品，Ultrawork 选 Tauri 就必须承担这块（取舍本身合理，但升级摩擦真实，见 Pending Issues 中「vendor 升级调研」5 文件 patch 全 apply 失败）。
6. **缺主动服务（cron/heartbeat）**。openclaw 的 standing orders、hermes 的 cron 让 agent 能「主动做事」——这是「助理」属性的关键，Ultrawork 仅规划。
7. **安全模型相对单薄**。仅 Basic Auth（loopback）。openclaw 的设备配对、hermes 的凭证脱敏/OSV/注入扫描更体系化——若未来 Gateway 暴露到 LAN 或多设备，需要补强。

---

## 5. 建议（多维，按优先级）

> 均为提案（讨论中），不含代码改动。建议落地前各自评估，可能演化为独立 ADR。

### P0 — 战略定位（先想清楚再投入）

- **明确差异化叙事**：把产品故事从「opencode 桌面化」转为「**接入国内 IM + 本地知识库的个人/团队 AI 助理**」。官方桌面版的存在使前者失去独占性；后者是英文圈三项目均未覆盖、且与 opencode 互补的空间。建议据此重排 roadmap 优先级。

### P1 — 补齐已被验证价值的能力

1. **IM 流式输出重构（借鉴 openclaw block/preview）**：Gateway 用「按段落/句子边界的块流式 + 代码块不截断 + 平台 send-and-edit 预览」替代当前「累积全文 + 20KB 硬截断 + 3min 兜底」。这是低风险、高体验回报、且有现成参考实现的改造。**最该先做。**
2. **落地 Agent Workspace 持久记忆（借鉴 hermes SOUL/MEMORY/USER）**：把 Part II 的 IDENTITY/SOUL/MEMORY 从草案推进到实现。可直接采用 hermes 的「回合前 `prefetch` 召回 → 包 `<memory-context>` fenced block 标注是回忆 → 回合后 `sync` 写回」模式。注意：注入记忆会击穿 prompt cache——参考 hermes「volatile 层 + 时间戳只到日期 + 状态变更默认延迟到下回合」的缓存纪律。
3. **在 UI 暴露 opencode 已有的多 agent 能力**：Build/Plan 切换 + General/Explore/Scout subagent（child session）已在 server 端就绪，opencode desktop 已有 UI 范式可直接借鉴。这是「用已付出的复用红利」，性价比高。

### P2 — 中期补强

4. **主动服务（cron/heartbeat）**：参考 openclaw standing orders / hermes cron，让 agent 能定时/被动触发任务（与 IM 渠道天然契合：定时推送、监控告警）。
5. **subagent 预算/并发治理**：若推进多 agent，借鉴 hermes（`maxConcurrent`、子 agent 用便宜模型、`max_spawn_depth`）与 openclaw（queue lane）的成本/并发护栏。
6. **知识库作为差异化继续加深**：这是 Ultrawork 唯一「比所有对标都强」的点。可投入：检索质量（reranker，已在 ADR-026 Phase 4b 规划）、Wiki 管理、把知识库与持久记忆打通（RAG 召回喂给记忆层）。

### P3 — 长期 / 按需

7. **安全模型**：若 Gateway 走向多设备/LAN，引入类 openclaw 的设备配对与 scope 授权；引入 hermes 的凭证脱敏 / 依赖扫描。
8. **控制面协议**：当前 HTTP+SSE 够用。若未来多端协同（见 [001-mobile-relay](./001-mobile-relay.md)、architecture-full），可评估 openclaw 的 typed WebSocket + pairing 作为统一控制面参考——但这是大投入，非当前阶段。
9. **vendor 升级策略**：结合 Pending Issues 的升级调研，评估是否 pin 到 opencode release tag 而非 dev commit，降低 patch 漂移与重编译摩擦。

---

## 6. 信息缺口与可信度说明

- **外部项目**均基于真实 README / 源码 / 官方 docs 抓取（带来源链接，见各子调研）。但深层实现细节（openclaw compaction 算法、hermes token 估算阈值、opencode desktop renderer 具体面板组件）未逐行核实，属推断。
- openclaw README 的 star/fork 数（疑似 377k）抓取概括失真，**未采信**。
- opencode desktop 的 `virtual:opencode-server` 最终打包进哪种 runtime、`effect-drizzle-sqlite` 是否就是会话后端，为命名强推断，未逐行确认。
- 本文第 4/5 节的优劣判断与建议是**分析提案**，非既定结论，落地前需各自评估。

### 主要来源

- **Ultrawork 现状**：本仓库代码（`src-tauri/src/lib.rs`、`packages/core/api-client`、`packages/channel/gateway`、`packages/knowledge/sidecar`、`patches/`）+ [architecture-phase1.md](../architecture-phase1.md) + [AGENTS.md](../../AGENTS.md)
- **openclaw**：[README](https://github.com/openclaw/openclaw) · [docs/concepts/architecture](https://github.com/openclaw/openclaw/blob/main/docs/concepts/architecture.md) · [agent-loop](https://github.com/openclaw/openclaw/blob/main/docs/concepts/agent-loop.md) · [multi-agent](https://github.com/openclaw/openclaw/blob/main/docs/concepts/multi-agent.md) · [streaming](https://github.com/openclaw/openclaw/blob/main/docs/concepts/streaming.md) · [gateway/protocol](https://github.com/openclaw/openclaw/blob/main/docs/gateway/protocol.md) · [tools/subagents](https://github.com/openclaw/openclaw/blob/main/docs/tools/subagents.md)
- **hermes-agent**：[README](https://github.com/NousResearch/hermes-agent) · [AGENTS.md](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/AGENTS.md) · [conversation_loop.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/conversation_loop.py) · [memory_manager.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py) · [providers/base.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/providers/base.py) · [mcp_tool.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/mcp_tool.py) · [delegate_tool.py](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py)
- **opencode desktop**：[anomalyco/opencode](https://github.com/anomalyco/opencode/) · [desktop package.json](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/package.json) · [main/sidecar.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/src/main/sidecar.ts) · [main/server.ts](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/desktop/src/main/server.ts) · [docs/server](https://opencode.ai/docs/server/) · [docs/agents](https://opencode.ai/docs/agents/)
