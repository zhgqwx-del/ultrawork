# 知识库能力复制实现指南（Replication Guide）

> **目的**：供其他桌面 Agent 项目参考 Ultrawork 的设计与实现，"复制"一套知识库能力。
> **配套阅读**：`docs/decisions/026-knowledge-base-architecture.md`（ADR-026，完整设计 + 行业调研 + 算法/库参考）、源码 `packages/knowledge/sidecar/`。
> **本指南聚焦**：落地路径、触发策略、**噪音控制**、启动方式、给目标 Agent 的 prompt。不重复 ADR-026 的算法细节。
> **最后更新**：2026-06-02

---

## 0. 一句话定性（必读，避免被 ADR-026 §9 误导）

当前 Ultrawork 的知识库是 **纯 MCP 工具调用模式（ADR-026 §9「方案 A」的最朴素形态）**：

- ❌ **不**向 system prompt 注入任何知识库内容；
- ✅ 只暴露 **3 个 MCP 工具**，工具描述是**静态通用字符串**（不含任何具体知识源名 / 主题词）；
- ✅ 知识库内容**仅在 LLM 主动调用 `knowledge_search` 后**作为该次 tool-call 返回值进入上下文；
- ❌ ADR-026 §9 设计的"增强 1/2/3"（system prompt 摘要 / 动态主题词 / 首轮引导）与 `@知识库` 显式触发**均未实现**。

> 复制时以本指南 + ADR-026 的「2026-06-02 更新」节为准，**不要**照 §9 的理想叙述去实现增强项。

---

## 1. 对每轮聊天上下文的影响（事实）

| 项目 | 影响 |
|------|------|
| 被动注入（system prompt） | **0**。prompt 只含 env + skills + instructions（CLAUDE.md/AGENTS.md） |
| 常驻开销（每个请求的工具列表） | 固定 **3 个工具 schema**（百来 token 级），不随对话轮次或知识库内容增长 |
| 知识库内容进入上下文 | **仅当 LLM 主动调用 `knowledge_search` 之后**，以 tool-call 返回值形式（`### Result N — 文件:行号 (score) [来源]` + parent 块正文 + 一段"已搜索的知识源"摘要） |
| 自动预检索 / 阈值注入 | **无**（ADR-026 明确否决） |

**3 个 MCP 工具**（`mcp-bridge.ts`）：

| 工具 | 触发语义（LLM 看到的静态描述要点） |
|------|------|
| `knowledge_search` | "搜索用户知识库……当用户的问题可能由其已索引文件/文档/已连接知识库回答时使用" |
| `knowledge_list_sources` | "列出所有已配置知识源及其状态" |
| `knowledge_save_note` | "把内容保存为 IMA 笔记……当用户要求'帮我记一下'/'保存为笔记'/'save this to my notes'时使用" |

---

## 2. 触发策略光谱与噪音控制（本项目取舍 + 你该怎么选）

### 立场（2026-06-02 决策）

**优先"不需要知识库时零噪音 / 零误触发"。当前方案 A 的噪音已经很低、可接受**（不调用即零干扰，误触发代价有界）。推荐的复制演进是 **A → A+@ 共存 → 收尾清理** 的三步**加法**，而非用 `@` 替换方案 A。本阶段**不实现**任何常驻的"提高主动检索率"手段（增强 1/2/3、自动预检索）——它们与"零噪音优先"方向相反；`@` 共存以"逐条消息 opt-in"达到"需要时找得到"，却不抬高常驻噪音。

### 触发光谱

| 形态 | 机制 | ambient 噪音 | 漏搜风险 | 本项目状态 |
|------|------|:---:|:---:|:---:|
| **always-on 预检索** | 每条消息自动检索并注入 prompt | 高 | 低 | ❌ 已否决（ADR §替代方案5 / Phase 7） |
| **方案 A（ambient tool）** | 注册 MCP，3 个工具常驻；LLM 自主判断是否调用 | **低（有界）** | 中高 | ✅ **当前实现** |
| **`@` 共存（推荐目标）** | 保留方案 A 常驻工具；**叠加** `@源` 显式触发，把检索结果当轮注入 prompt | **零增量**（仅 @ 消息有，且只活一轮） | 由用户控制 | 🔲 ADR Phase 4，未实现（接线见 §8） |

### 噪音控制的关键事实（务必理解）

- **MCP 是否注册 = 工具是否常驻**。`ensureMCPRegistered`（`use-knowledge-base.ts:163`）在 `addFolder` 时把 `knowledge-base` 写进全局 `opencode.json`，之后 3 个工具常驻 LLM 工具列表。**要做到"零 ambient footprint"，杠杆就是不注册常驻 MCP**，改为显式触发时才检索。
- **知识源的 `enabled` 只过滤"搜哪些源"，不影响"工具是否出现"**（`mcp-bridge.ts:50`）。即使禁用全部源，工具仍在列表里。
- **方案 A 的误触发代价有界**：即使 AI 多搜一次，最坏返回 `"No relevant results found"`（`mcp-bridge.ts:160`），**不污染后续上下文、不会把错误内容当事实**，且 tool-call-block 全程对用户可见（完全透明）。
- **已知小坑**：`removeSource`（`use-knowledge-base.ts:237`）删源时**不注销 MCP**——删到 0 个知识源后工具仍挂着。噪音优先的复制应在删到 0 源时一并 `remove_mcp_config`。

### 推荐落地：A → A+@ 共存 → 清理（三步加法）

1. **先复制方案 A**（常驻 MCP 工具，AI 自主调用）——最快跑通整条 RAG 栈，拿到"开箱低噪音"基线。直接照搬 `ensureMCPRegistered` + `mcp-bridge` 即可。
2. **叠加 `@` 显式触发，与方案 A 共存**（接线草图见 §8）：用户 `@源名` 时把检索结果作为**独立 text part 当轮注入**（不进 system prompt、下轮自动消失）。不打 `@` 的消息脚印与第 1 步完全一致——噪音不升；打 `@` 的消息获得用户掌控的精确检索。后端零新增（复用 `/kb/search`）。
3. **删源即注销 MCP**：在 `removeSource` 删到 0 个知识源时一并 `remove_mcp_config`，消除"零源仍挂工具"残留。
4. **不要**做 always-on 自动预检索（ADR §替代方案 5 的全部风险：噪声稀释 / Lost-in-the-Middle / 阈值无底洞 / 延迟 / 误导）。

---

## 3. 要复制的组件清单（文件路径 + 职责）

### Knowledge Sidecar（独立进程，TypeScript + Bun，`packages/knowledge/sidecar/src/`）

| 文件 | 职责 |
|------|------|
| `index.ts` | 入口；子命令分发：无参 = HTTP server（:4098），`mcp-stdio` = MCP stdio bridge（direct 模式，同进程检索） |
| `store.ts` | `bun:sqlite` 封装：sources / chunks / chunk_embeddings / FTS5 / `_migrations` / `knowledge_sources` 注册表 |
| `chunker.ts` | Parent-Child 双层分块（parent ~60 行 / child ~12 行） |
| `embedder.ts` | TF-IDF hashing embedder（384 维，纯 TS；ONNX 因 `bun build --compile` 兼容性延后） |
| `doc-parser.ts` | PDF/docx/xlsx/pptx → 文本（unpdf/mammoth/xlsx/jszip，纯 TS，30s/文件 超时降级） |
| `indexer.ts` | 索引管线 + 增量（mtime/hash）+ 进度事件广播 + schema 自动迁移 |
| `retriever.ts` | 混合检索：FTS5 BM25 + 向量 cosine + RRF（k=60）融合 → top-K |
| `watcher.ts` | `fs.watch({recursive:true})` + 双层 debounce → 自动重索引 |
| `kb-server.ts` | HTTP API（Hono）：`/kb/sources` CRUD、`/kb/search`、SSE `/kb/sources/events`、`/kb/notes/*` |
| `mcp-bridge.ts` | **MCP Server（AI 调用入口）**：注册 3 个工具；direct（注入 deps）/ proxy（HTTP 回 :4098）双模式 |
| `adapters/` | `local-folder`（包装 retriever）+ `ima`（第三方平台 HTTP adapter）+ `registry` |

### 前端（`packages/client/desktop/src/`）

| 文件 | 职责 |
|------|------|
| `lib/use-knowledge-base.ts` | KB 源 CRUD hook + `ensureMCPRegistered`（写 opencode.json + 运行时 `POST /mcp`）+ SSE 进度订阅 |
| `components/settings/...AddSourceDialog` | 添加知识源向导（本地文件夹 / IMA 凭证 + 模块选择 / 自定义 API Coming soon） |
| `components/settings/...KnowledgeSection` | 知识源列表 + filter chips + 状态卡片 |

### Tauri（`packages/client/desktop/src-tauri/`）

- sidecar 进程托管（启动/退出清理，复用 Gateway 的生命周期模式 ADR-013）；
- commands：`read_mcp_config` / `write_mcp_config` / `remove_mcp_config`（全局 `opencode.json`）、`get_sidecar_path`。

### 配置与数据落点

| 路径 | 内容 |
|------|------|
| `~/.config/ultrawork/opencode.json` → `mcp.knowledge-base` | MCP 注册（全局，ADR-020 隔离） |
| `~/.ultrawork/knowledge/kb.db` | SQLite（WAL + FTS5 + `_migrations` + `knowledge_sources`），全局单库，mode 0o700 |

---

## 4. 如何启动 / 构建 / 接线（最小落地路径）

```bash
# 开发期：HTTP server 模式（:4098，管理 + proxy 检索）
cd packages/knowledge/sidecar && bun run --bun src/index.ts

# 开发期：MCP stdio direct 模式（OpenCode 实际拉起的就是这个子命令）
bun run --bun src/index.ts mcp-stdio

# 编译为单二进制 sidecar
bun build --compile src/index.ts --outfile dist/knowledge-sidecar
# 或项目级（含签名/落点处理）
bun run scripts/build-knowledge.ts
```

**MCP 注册**（让 LLM 看到工具）——写入全局 `opencode.json`：

```jsonc
{
  "mcp": {
    "knowledge-base": {
      "type": "local",
      "command": ["<sidecar 绝对路径>", "mcp-stdio"],  // 必须绝对路径
      "enabled": true
    }
  }
}
```

> 坑：MCP local 进程命令必须用 `bunx`/绝对路径，避免 `npx` 多层 spawn 导致 stdio pipe 断裂（见 MEMORY「OpenCode Server Known Limitations」）。

**检索栈**：TF-IDF embedding + SQLite FTS5(BM25) + 内存 cosine + RRF(k=60)。算法与可替换的 ONNX/sqlite-vec 方案见 ADR-026 §6/§7 与文末「核心技术组件 — 实现参考」。

---

## 5. 复制的启动方法（给"你"——发起复制的人）

1. 把目标 Agent 指向本项目两份文档：本指南 + `docs/decisions/026-knowledge-base-architecture.md`，以及源码目录 `packages/knowledge/sidecar/`。
2. **三步加法**（见 §2 推荐落地）：① 先复制方案 A 跑通基线 → ② 叠加 `@` 共存触发（§8）→ ③ 删源即注销 MCP。
3. 单步内复制顺序：`store` → `chunker`/`embedder` → `indexer` → `retriever` → `kb-server`(HTTP) → `mcp-bridge` → 前端 hook/UI → Tauri 托管；`@` 层在基线跑通后再加（§8）。
4. 用 §6 的 prompt 驱动目标 Agent 分阶段实现，每阶段跑通再进下一阶段。

---

## 6. 给目标 Agent 的 Prompt（可直接粘贴）

```text
我要在本项目里实现"知识库（RAG）"能力，参考另一个项目 Ultrawork 的设计与实现来复制。
参考资料（按此优先级阅读，不要凭训练知识臆测）：
  1. docs/knowledge-base-replication-guide.md（复制指南，含组件清单/启动/触发策略）
  2. docs/decisions/026-knowledge-base-architecture.md（完整设计 + 调研，注意「2026-06-02 更新」节才是实现真相）
  3. 源码 packages/knowledge/sidecar/

【硬性约束 — 触发策略】优先"不需要知识库时零噪音/零误触发"。按三步加法推进，不要一步到位：
  Step 1 先复制"方案 A"：注册 knowledge-base MCP 常驻工具，LLM 自主调用 knowledge_search。
         这是低噪音基线，先把检索/索引整条栈跑通。
  Step 2 叠加 @ 显式触发（与方案 A 共存，不替换）：用户在输入框 @某知识源 时，
         把检索结果作为"独立 text part"注入【当轮】prompt（绝不进 system prompt，下轮自动消失）；
         后端复用 /kb/search，不新增端点。没打 @ 的消息保持与 Step 1 完全一致。
  Step 3 删源即注销：当知识源删到 0 个时，一并移除 MCP 注册，消除"零源仍挂工具"残留。
  全程禁止：向 system prompt 注入知识库摘要；"每条消息自动预检索"。

【架构】单一 Knowledge Sidecar（TypeScript + Bun）同时提供：HTTP 管理 API + 检索入口。
检索栈：分块(Parent-Child) → TF-IDF embedding → SQLite FTS5(BM25) + 向量 cosine → RRF(k=60) 融合 top-K。
数据落本地 SQLite 单库（隐私优先，离线可用）。

【交付方式】先给我一份分阶段实现计划（Phase 1 本地文件夹 RAG 跑通 → 后续第三方 adapter），
每阶段列出要新建的文件与职责，等我确认后再写代码。先不要直接改代码。
```

---

## 7. 已知坑点速查（复制时容易踩）

- **MCP local 命令必须绝对路径 / `bunx`**，不能 `npx`（stdio pipe 断裂）。
- **删源不注销 MCP**：噪音优先场景需自行补 `remove_mcp_config`（本项目未做）。
- **`enabled` 只过滤搜哪些源，不控制工具是否出现**：靠它做"关闭知识库"达不到零噪音。
- **`bun build --compile` 与 ONNX/transformers.js 不兼容**（issue #1672）→ 本项目用 TF-IDF 兜底；要上神经 embedding 需子进程隔离或 N-API。
- **sqlite-vec 在 macOS 需自定义 SQLite 路径**（`Database.setCustomSQLite`）→ 本项目暂用 BLOB + 内存 cosine 规避。
- **FTS5 中文分词弱**：必要时 jieba 预处理后空格分隔再入库。
- **IMA `search_knowledge` 只回 highlight 片段**、无跨 KB 端点（需客户端 fan-out）、静默 100 结果截断（详见 ADR-026 §Phase 4）。

---

## 8. `@` 显式触发层 — 接线草图（增量层，与方案 A 共存）

在方案 A 基线跑通后叠加。**后端零新增**（复用 `/kb/search`），全部新增在前端。

```
                       ┌──────────────────────── Chat 输入框 ────────────────────────┐
 用户键入 "@" ───────▶ │ ① 监听 "@" → 弹知识源菜单                                     │
                       │    数据源: useKnowledgeBase().sources（只列 enabled + "全部"）│
 选中"项目文档" ─────▶ │ ② 插入 chip token「@项目文档」并记下 source_id              │
                       │ ③ 用户继续打字: "灰度比例怎么定的？"                          │
                       └───────────────────────────────┬──────────────────────────────┘
                                                        │ 点发送
                                                        ▼
                       ┌─────────────── 发送前置 hook（send 拦截）────────────────────┐
                       │ ④ 解析输入中的 @token → 收集 source_ids；剥 token 得纯 query  │
                       │ ⑤ 有 @token 才检索:                                          │
                       │      POST /kb/search { query, source_ids, limit }  ───────┐  │
                       │    （复用现有 sidecar 端点，后端零新增）                    │  │
                       └────────────────────────────────────────────────────────────│──┘
                                                                                      ▼
                                                       ┌──── Knowledge Sidecar :4098 ────┐
                                                       │ /kb/search → retriever(本地)     │
                                                       │              + adapter(IMA)       │
                                                       │ → RRF top-K → results[]          │
                                                       └──────────────────┬───────────────┘
                                                                          │ results
                       ┌───────────────────────────────────────────────────▼────────────┐
                       │ ⑥ 把 results 拼成「参考资料块」，作为【独立 text part】          │
                       │    放在用户文本之前（不是 system prompt → 只影响当轮，下轮自动消失）│
                       │    parts = [                                                     │
                       │      { type:"text", text:"<参考资料 source=项目文档>…</参考资料>" },│
                       │      { type:"text", text: query }                               │
                       │    ]                                                            │
                       │ ⑦ POST /session/:id/prompt_async { parts, … }                   │
                       └───────────────────────────────────────────────────┬────────────┘
                                                                            ▼
                                                                  OpenCode → LLM
                       ⑧ UI: 该用户气泡标「📎 引用 3 条 · 项目文档」(可展开看片段 + score)

  ── 共存关系（不冲突）──
  · 普通消息(无@): 走原路，LLM 仍可自主调 MCP knowledge_search —— 方案 A 完全不动
  · @ 消息: 检索结果已在 prompt 里，LLM 通常不必再调工具（天然去重）
```

### 设计要点（草图里几个刻意的选择）

1. **后端零新增**：@ 路径直接复用 `POST /kb/search`（`kb-server.ts`）与整条 retriever/adapter 栈。
2. **注入成"独立 text part"而非 system prompt**：保证"零残留噪音"的关键——检索内容只活在**当轮**，下条消息不再 @ 就消失。绝不要塞进 system prompt（会变成跨轮常驻噪音，退回被否决的 always-on）。
3. **`@源名` 限定 `source_ids`；裸 `@`/`@全部` = 所有 enabled 源**（对应 `mcp-bridge.ts:38` 同款 `source_ids` 语义）。
4. **query 用剥掉 @token 后的纯文本**，避免把 "@项目文档" 当检索词。
5. **可选 Strict 模式**：参考资料块头部加一句"仅依据以下资料回答，无则明示"即得（ADR §12），同样当轮注入、零常驻成本。

### 目标项目里的落点（3 个触点）

| 触点 | 参考本项目的同类实现 |
|------|------|
| 输入框 `@` 菜单 + chip token | `src/components/chat/command-selector`（`/` 命令选择器）是现成同构 UI，照抄改 `@` 触发 |
| 发送前置 hook（解析 @ → 检索 → 拼 parts） | 组装 `prompt_async` parts 的发送路径（`useSessionMessages`） |
| 知识源菜单数据 | `useKnowledgeBase().sources` |
