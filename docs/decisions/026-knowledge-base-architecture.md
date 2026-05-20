# ADR-026: 知识库能力架构 — 本地 RAG + 第三方平台 + 自定义 API

**状态**: Proposed
**日期**: 2026-05-13
**关联**: ADR-019 (Withdrawn), ADR-013 (Gateway Sidecar 模式参考)

## 背景

Ultrawork 作为桌面 AI Agent，用户希望能接入多种知识库让 AI 在对话中按需检索。ADR-019 曾做过 IMA MCP Server 的 POC 并验证可行，但仅覆盖了"第三方云端知识库"单一场景。实际用户需求可归纳为三类：

| 场景 | 典型例子 | 核心技术需求 |
|------|---------|-------------|
| **A. 本地文件/文件夹** | 用户指定 `~/Documents/notes/` 作为知识库 | 文件解析 → 分块 → Embedding → 向量检索 |
| **B. 第三方知识库平台** | IMA、NotebookLM、Obsidian、百炼 | HTTP API 调用（认证 + 搜索/检索） |
| **C. 用户自有 API** | 企业自建知识库 REST/GraphQL 端点 | 通用 HTTP 代理（用户配置 endpoint + auth） |

本 ADR 在 ADR-019 的基础上，设计一个统一架构覆盖全部三类场景。此外，调研补充了第四类场景：

| 场景 | 典型例子 | 核心技术需求 |
|------|---------|-------------|
| **D. 在线文档/网页** | 框架官方文档站、API 参考、Wiki | 网页爬取 → 解析 → 分块 → 索引（类似 Cursor @Docs） |

## 行业调研

在设计方案前，调研了 10 个主流产品的知识库/RAG 实现，提炼出关键模式：

### 产品对比总览

| 产品 | 知识源 | 索引方式 | 向量存储 | 检索策略 | AI 访问方式 |
|------|--------|---------|---------|---------|------------|
| **Cursor** | 代码 + @Docs(URL 爬取) | 云端 embedding + AST 感知分块 | Turbopuffer (云端) | 语义检索 | @codebase/@docs 触发 |
| **Windsurf** | 代码 + .windsurfrules | 本地 embedding + SWE-grep | 本地存储 | LLM-based 搜索 | Flow 自动上下文 |
| **Claude Code** | CLAUDE.md + 文件系统 + MCP | 无 RAG，靠 1M 上下文 + 工具 | 无 | 工具调用 | Read/Grep/MCP |
| **GitHub Copilot** | 代码 + Spaces(文档+工单) | 云端 code search | GitHub 云端 | RAG | @workspace/Spaces |
| **Dify** | 文件/Notion/网页/云盘 | 可选 embedding 模型 | Weaviate/QDrant/PgVector | 混合检索(BM25+向量) | 工作流节点 |
| **Coze 扣子** | 文件/网页/API/飞书/Notion | 云端自动向量化 | 内置向量库 | 混合检索+RRF | 知识库检索节点 |
| **FastGPT** | 文件/手动录入/API | 可选 embedding | PgVector/Milvus | BM25+DPR 混合 | 知识库搜索节点 |
| **RAGFlow** | Word/PPT/Excel/图片/扫描件 | 可配置 embedding | Elasticsearch/Infinity | 多路召回+重排序 | Agent/API |
| **AnythingLLM** | 本地文件/URL | 本地或云端(30+模型) | LanceDB(默认)/多种 | RAG | Workspace 隔离 |
| **Obsidian+AI** | Vault 本地 Markdown | 本地向量 embedding | 本地文件 | 语义检索 | 聊天界面 RAG |

### 关键发现

**1. 检索策略已收敛到混合检索**

Dify / Coze / FastGPT / RAGFlow **全部**采用 BM25 关键词 + 向量语义 + 重排序的混合检索。纯向量检索在精确关键词匹配（函数名、错误码、配置项）上弱于 BM25，混合方案用 RRF (Reciprocal Rank Fusion) 算法融合两路结果，实测召回率高 15-20%。

**2. Parent-Child 双层分块成为最佳实践**

Dify / RAGFlow 推荐的策略：子块（小粒度 ~200 token）精确匹配查询，命中后返回父块（大粒度 ~1000 token）给 LLM 推理。解决"精度 vs 上下文完整性"的根本矛盾。

**3. @Docs 网页文档爬取是开发者高频需求**

Cursor 的 @Docs 功能：粘贴文档站 URL → 自动爬取 + 索引 → 对话中可引用。GitHub Copilot Spaces 也支持混合代码 + 文档。这是我们原方案遗漏的第四类知识源。

**4. Chat/Query 双模式满足不同场景**

AnythingLLM 区分 Chat 模式（AI 综合知识库 + 自身知识）和 Query 模式（AI **仅**基于知识库回答，不编造）。企业用户"只回答知识库里有的"是刚需。

**5. 分块可视化提升用户信任**

RAGFlow 提供分块结果预览 + 人工干预界面。用户能看到"文件被切成多少块、每块什么内容"，增强对 RAG 质量的信心和可控性。

**6. 隐私与离线是桌面应用的核心差异化**

Windsurf / AnythingLLM / Obsidian 都强调本地优先。与云端 SaaS 产品（Dify Cloud / Coze）相比，桌面应用的核心卖点就是数据不出本机。

## 决策

### 1. 整体架构：Knowledge Sidecar + MCP 统一对接

```
┌─────────────────────────────────────────────────────────────┐
│  Desktop App (Tauri + React)                                │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Settings → Knowledge Tab                             │   │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │   │
│  │ │本地文件夹 │ │第三方平台│ │自定义API │ │Embedding │ │   │
│  │ │路径选择   │ │凭证配置  │ │端点配置  │ │模型选择  │ │   │
│  │ │索引管理   │ │连接测试  │ │模板编辑  │ │本地/远程 │ │   │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│  ┌──────────────────┐  ┌────────────────────────────────┐   │
│  │ Sidebar           │  │ Chat                           │   │
│  │ Knowledge Panel   │  │ AI 通过 MCP tools 自主调用     │   │
│  │ · 知识源开关      │  │ · search_local_knowledge       │   │
│  │ · 索引进度        │  │ · search_ima_knowledge         │   │
│  │ · 手动搜索        │  │ · search_custom_api            │   │
│  │ · 最近引用        │  │ · 结果展示在 tool-call-block   │   │
│  └──────────────────┘  └────────────────────────────────┘   │
└─────────────┬───────────────────┬───────────────────────────┘
              │ HTTP + SSE        │ MCP (stdio)
              ▼                   ▼
┌──────────────────────────────────────────────────┐
│  Knowledge Sidecar (:4098)                       │
│  TypeScript + Bun (bun build --compile)          │
│                                                  │
│  ┌─────────────────┐  ┌───────────────────────┐  │
│  │ HTTP API (管理)  │  │ MCP Server (AI 调用)  │  │
│  │ /kb CRUD         │  │ search_knowledge      │  │
│  │ /kb/:id/index    │  │ list_knowledge_bases  │  │
│  │ /kb/:id/progress │  │ get_document          │  │
│  │   (SSE 进度推送) │  │                       │  │
│  └─────────────────┘  └───────────────────────┘  │
│                                                  │
│  内部管线 (本地 RAG + 在线文档):                   │
│  File/URL → doc-parser(纯TS) → Text/Markdown       │
│          → Chunker (General / Parent-Child)        │
│          → Embedder → sqlite-vec + FTS5            │
│                                                  │
│  检索引擎:                                        │
│  ├ BM25 全文检索 (SQLite FTS5)                    │
│  ├ 向量语义检索 (sqlite-vec)                      │
│  └ RRF 融合排序 → top-K 结果                      │
│                                                  │
│  Embedding:                                      │
│  ├ 本地 ONNX (BGE-small, 默认)                   │
│  └ 远程 API (OpenAI 等, 可选)                     │
│                                                  │
│  第三方平台适配器:                                │
│  ├ IMA Adapter (Client ID + API Key)             │
│  ├ Obsidian Adapter (本地 vault 路径)            │
│  ├ 百炼 Adapter (API Key)                        │
│  └ Custom API Adapter (用户配置端点)             │
│                                                  │
│  网页爬虫:                                        │
│  └ fetch + cheerio (同域递归, 深度/页数可配)      │
│                                                  │
│  存储: ~/.ultrawork/knowledge/                    │
│  ├ sources.json (知识源配置)                      │
│  ├ models/ (ONNX 模型文件)                        │
│  └ <workspace-hash>/index.db (向量+FTS5索引)     │
└──────────────────────────────────────────────────┘
```

#### 为什么用单一 Knowledge Sidecar 而非每个知识源一个 MCP Server

ADR-019 的方案是"每个知识源 = 一个 MCP Server 进程"。本次改为单一 Sidecar 统一管理，理由：

| | ADR-019 (N 个 MCP Server) | 本方案 (1 个 Knowledge Sidecar) |
|--|--------------------------|-------------------------------|
| 进程数 | 每加一个源多一个进程 | 始终 1 个进程 |
| 本地 RAG 能力 | 需要额外 sidecar 承载 | 内置，统一管理 |
| 索引+检索+进度 | 跨进程协调复杂 | 同进程，天然集成 |
| AI 调用 | 多个 MCP tool namespace | 统一 namespace，query 可跨源 |
| 知识源管理 | 分散在各进程配置 | 集中在 sources.json |

单一 Sidecar 同时暴露 HTTP API（给前端管理用）和 MCP Server（给 AI 调用用），职责清晰。

### 2. 技术栈：TypeScript + Bun

选择 TypeScript + Bun，与 Gateway Sidecar (ADR-013) 保持一致：

- OpenCode 主体是 TypeScript，Gateway 也是 TypeScript + Bun，技术栈统一
- `bun build --compile` 编译链路已在 Gateway 验证，DMG 分发无需用户安装运行时
- `bun:sqlite` 内置 SQLite 支持，零依赖
- Tauri 生命周期管理模式可复用 Gateway 的实现

### 3. 文件解析：全 TS 原生

> **更新 (2026-05-20)**：富媒体格式已从 MarkItDown (Python) 替换为纯 TS 库，零外部依赖。

本地 RAG 的文件解析采用分层策略：

```
文件输入
  │
  ├── 核心格式 (直接读取, 零依赖)
  │   ├── .md / .mdx        → 直接读取
  │   ├── .txt / .log       → 直接读取
  │   ├── 代码文件 (.ts/.py/.go/...)  → 直接读取 + 语言标注
  │   ├── .html             → 提取正文 (cheerio)
  │   ├── .csv / .json      → 结构化转 Markdown 表格
  │   └── .xml              → 提取文本节点
  │
  └── 富媒体格式 (纯 TS 库, 开箱即用)
      ├── .pdf              → unpdf 文本提取
      ├── .docx             → mammoth 文本提取
      ├── .xlsx             → xlsx (SheetJS) → CSV 文本
      └── .pptx             → jszip 解压 + XML <a:t> 文本节点提取
```

**实现文件**：`packages/knowledge/sidecar/src/doc-parser.ts`，`convertDocument(filePath)` 按扩展名分发，30s per-file timeout + graceful 降级。

**核心格式不走 doc-parser 的理由**：核心格式（md/txt/代码/HTML/CSV/JSON）直接读取更快，覆盖 80%+ 日常场景。doc-parser 专门处理需要结构化解析的二进制格式。

### 4. Embedding：本地模型内置 + 远程 API 可选

```
Embedding 策略
├── 本地模型 (默认, 开箱即用)
│   ├── 中文: BGE-small-zh-v1.5 (~50MB ONNX)
│   ├── 英文: all-MiniLM-L6-v2 (~23MB ONNX)
│   └── 运行: ONNX Runtime WASM (Bun 原生支持)
│
└── 远程 API (可选, 精度更高)
    ├── 复用用户已配置的 LLM Provider
    │   ├── OpenAI text-embedding-3-small
    │   └── 其他 OpenAI-compatible 服务
    └── 用户自定义 embedding endpoint
```

**默认本地模型的理由**：

| | 本地模型 | 远程 API |
|--|---------|---------|
| 隐私 | 数据不出本机 | 上传到云端 |
| 离线 | 可用 | 不可用 |
| 成本 | 免费 | 按 token 计费 |
| 精度 | 足够 (~85-90% 召回) | 更高 (~92-95%) |
| 速度 | CPU ~50 chunks/s | 批量 ~200 chunks/s |
| 包体积 | +50-100MB | 0 |

对桌面 AI Agent 来说，**隐私和离线可用是核心卖点**。本地模型作为默认选项，远程 API 在 Settings 中作为可选高精度模式。

**模型管理**：
- ONNX 模型文件存储在 `~/.ultrawork/knowledge/models/`
- 首次使用时从应用 bundle 中解压（打包时内嵌）
- Settings 中提供选择："Embedding 模型" → 本地 BGE-small (默认) / 远程 OpenAI / 自定义

### 5. 分块策略：General + Parent-Child 双层

基于行业调研，采用两种可选分块策略：

#### General 分块（默认）

固定大小滑动窗口，适合大部分场景：

```
参数:
  chunk_size:  512 tokens (默认)
  overlap:     64 tokens (12.5%)
  separators:  ["\n## ", "\n### ", "\n\n", "\n", ". "]  # 按优先级尝试在分隔符处切分
```

对代码文件，使用语言感知分块（按函数/类/模块边界切分，参考 Cursor 的 AST 感知策略），保持语义完整性。

#### Parent-Child 双层分块（可选，推荐大文档启用）

参考 Dify / RAGFlow 的最佳实践：

```
Parent 块:  ~1000 tokens (上下文完整)
  └─ Child 块: ~200 tokens (精确匹配)

检索时:
  1. Query → 在 Child 块中向量检索 → 找到 top-K 匹配
  2. 每个命中的 Child 块 → 返回其 Parent 块给 LLM
  3. LLM 获得完整上下文，回答更准确
```

数据库 schema 扩展：

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  parent_id TEXT REFERENCES chunks(id),  -- NULL = 顶层 parent 块
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,                          -- JSON: { heading, page, line_range }
  embedding FLOAT32[384]                  -- 仅 child 块有 embedding
);
```

用户在创建知识库时可选择分块策略，默认 General，大文档场景建议 Parent-Child。

### 6. 检索策略：混合检索（BM25 + 向量 + 重排序）

行业调研表明混合检索已成为标准方案。利用 SQLite 的 FTS5 全文检索 + sqlite-vec 向量检索，同库实现：

```
用户查询
  │
  ├── BM25 全文检索 (SQLite FTS5)
  │   └── 擅长：精确关键词、函数名、错误码、配置项
  │
  ├── 向量语义检索 (sqlite-vec)
  │   └── 擅长：语义相似、同义改写、概念匹配
  │
  └── RRF 融合排序 (Reciprocal Rank Fusion)
      └── score = Σ 1/(k + rank_i)，k=60
          → 合并两路结果，去重，返回 top-K
```

数据库增加 FTS5 虚拟表：

```sql
-- 全文检索索引（与 chunks 表同步）
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  content=chunks,
  content_rowid=rowid
);

-- 触发器保持同步
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
END;
```

三种检索模式可通过 MCP tool 参数控制：

| 模式 | 适用场景 | 实现 |
|------|---------|------|
| `hybrid`（默认） | 通用查询 | BM25 + 向量 + RRF |
| `semantic` | 概念性问题 | 仅向量检索 |
| `keyword` | 精确查找 | 仅 BM25 |

### 7. 向量存储：SQLite + sqlite-vec + FTS5

选择 SQLite + [sqlite-vec](https://github.com/asg017/sqlite-vec) 扩展：

- Bun 内置 SQLite（`bun:sqlite`），零额外依赖
- sqlite-vec 是 SQLite 官方认可的向量搜索扩展，支持 HNSW 索引
- 单文件存储，备份/迁移/删除简单
- 对桌面应用足够（百万级 chunk 无压力）
- 不需要额外启动 Chroma / Qdrant 等独立服务

```sql
-- 元数据表
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT NOT NULL,       -- 增量更新用
  file_mtime INTEGER NOT NULL,
  chunk_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- 分块 + 向量表
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id),
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,                  -- JSON: { heading, page, line_range }
  embedding FLOAT32[384]          -- sqlite-vec 向量列
);

CREATE INDEX idx_chunks_doc ON chunks(doc_id);
```

### 6. 知识源作用域

```
知识源类型          作用域         存储位置
──────────────────────────────────────────────────
本地文件夹          工作区级别     ~/.ultrawork/knowledge/<workspace-hash>/index.db
第三方平台 (IMA等)  全局           ~/.ultrawork/knowledge/sources.json
自定义 API          全局           ~/.ultrawork/knowledge/sources.json
```

本地文件夹天然跟工作区关联（不同项目有不同参考文档），云端知识源跨工作区共享。

### 7. 索引构建 UX：异步 + 进度反馈

本地 RAG 索引构建可能耗时数分钟到数十分钟，必须有完善的进度交互：

```
┌─ 索引构建中 ──────────────────────────────────┐
│                                                │
│  📁 项目文档  ~/Documents/project-docs/        │
│                                                │
│  ████████████░░░░░░░░  58%                     │
│  已处理 714 / 1,234 个文件                      │
│  当前: architecture-overview.pdf (解析中...)     │
│  已用时 2:35 · 预计剩余 1:50                    │
│                                                │
│  ⚠️ 跳过 3 个文件 (格式不支持)                   │
│                                                │
│               [后台运行]  [取消]                 │
└────────────────────────────────────────────────┘
```

**设计要点**：

- **异步索引 + SSE 进度推送**：`GET /kb/:id/index/progress` 返回 SSE 流，前端实时渲染进度条
- **后台运行**：用户可关闭对话框继续使用 app，索引在后台进行，完成后 toast 通知
- **增量索引**：首次全量构建后，后续基于文件 mtime + hash 只处理新增/修改文件
- **可中断/恢复**：支持取消索引，已完成的部分保留，下次从断点续建
- **Sidebar 状态指示**：Knowledge Panel 中用动画 icon 表示"索引构建中"

### 8. API 设计

#### HTTP API（前端管理用）

```
POST   /kb                    — 创建知识库（本地文件夹/第三方/自定义 API）
GET    /kb                    — 列出所有知识库
GET    /kb/:id                — 获取知识库详情
PUT    /kb/:id                — 更新知识库配置
DELETE /kb/:id                — 删除知识库（含索引数据）

POST   /kb/:id/index          — 触发索引构建/重建
DELETE /kb/:id/index           — 取消正在进行的索引
GET    /kb/:id/index/progress  — SSE 流，推送索引进度
GET    /kb/:id/index/status    — 索引状态快照（文件数、最后更新时间）

POST   /kb/:id/search         — 手动搜索（sidebar 用，支持 hybrid/semantic/keyword）
POST   /kb/:id/test           — 测试连接（第三方/自定义 API 用）

GET    /kb/:id/chunks          — 分块预览（分页，含文件维度分组）
GET    /kb/:id/chunks/:chunkId — 单个分块详情

POST   /kb/:id/crawl           — 触发网页爬取（在线文档类型）
GET    /kb/:id/crawl/progress   — 爬取进度 SSE 流

GET    /kb/embedding/models    — 列出可用 embedding 模型
PUT    /kb/embedding/config    — 切换 embedding 模型

GET    /kb/health              — 健康检查
```

#### MCP Tools（AI 调用用）

```
search_knowledge(query, options?)
  — 跨知识源检索，返回 ranked 结果 + 来源标注
  — options:
      kb_ids?: string[]          — 限定知识源（默认全部已启用）
      top_k?: number             — 返回条数（默认 5）
      mode?: "augmented"|"strict" — augmented=综合回答, strict=仅知识库内容
      retrieval?: "hybrid"|"semantic"|"keyword" — 检索策略（默认 hybrid）

list_knowledge_bases()
  — 列出用户已配置且已启用的知识源（含类型、状态、文档数）

get_document(doc_id)
  — 获取原文内容（本地 RAG 返回全文/分块，第三方返回 API 结果）
```

### 9. 检索触发时机

#### 可选的四种触发模式

| 模式 | 触发方式 | 噪声风险 | 实现复杂度 |
|------|---------|---------|-----------|
| **A. AI 自主判断** | AI 看到 MCP tool 可用，自行决定是否调用 | 零 | 低 |
| **B. 每次自动检索** | 每条消息自动向量检索，结果注入 prompt | 高 | 中 |
| **C. 用户显式触发** | 用户输入 `@知识库名` 前缀 | 零 | 中 |
| **D. 混合策略** | 自动预检索(阈值过滤) + AI tool call + 显式触发 | 中 | 高 |

#### 选择方案 A（AI 自主 MCP tool call）作为初始实现

**核心决策**：Phase 1 采用最简的方案 A，后续根据实际使用数据渐进演进。

**不采用自动预检索（模式 B/D）的理由**：

自动注入不相关内容会显著降低 AI 回答质量，这是 RAG 领域的已知风险：

| 风险 | 影响 |
|------|------|
| **噪声稀释** | 不相关 chunk 混入 prompt，AI 被干扰偏离正确答案 |
| **Lost in the Middle** | 长上下文中间的信息被 LLM 忽略（已知弱点） |
| **Token 浪费** | 注入内容消耗 context window，挤压有用的对话历史 |
| **阈值陷阱** | 不同知识库/领域的最优阈值不同，没有通用值；调高漏信息，调低引噪声 |
| **延迟增加** | 每条消息多 200-500ms 检索 + embedding 开销 |
| **误导** | 检索到看似相关但过时/不准确的内容，AI 当作事实引用 |

方案 D 的 L2 自动预检索尤其有**阈值调优无底洞**问题——不同知识库内容密度不同，同一阈值不可能适配所有场景。在没有充分的使用数据之前，引入这层复杂度风险大于收益。

**方案 A 的优势**（常被低估）：

1. **零噪声保证**——AI 不调用则零干扰；调用后可以判断结果是否相关再决定是否使用
2. **完全透明**——每次检索都有可见的 tool-call-block，用户能看到搜了什么、返回了什么
3. **AI 可迭代查询**——第一次搜"部署流程"没找到 → 换 query "灰度发布策略"再搜。自动预检索只用用户原话搜一次（通常不是最优检索词）
4. **实现最简**——只需注册 MCP Server，完全复用现有 MCP 基础设施

**方案 A 的核心弱点**是"AI 不知道该搜"。通过以下三个增强手段缓解：

**增强 1：System prompt 注入知识源摘要**

session 有启用的知识源时，在 AI 的 system prompt 中注入可用知识源信息：

```
[可用知识源]
你可以通过 search_knowledge 工具搜索以下知识库：
- 📁 项目文档 (本地, 1,234 文件, 涵盖: 部署流程、架构设计、API 文档)
- 🧠 IMA 知识库 (腾讯 IMA, 3 个子库: 产品手册、技术规范、FAQ)
- 🔗 公司 Wiki (自定义 API, 涵盖: 运维手册、编码规范)

当用户的问题可能与上述知识库内容相关时，请主动搜索后再回答。
```

这样 AI 就知道知识库里**大概有什么**，能做出更好的调用判断。

**增强 2：MCP tool description 包含主题关键词**

创建知识库时用户填写的描述 + 从索引中自动提取的高频主题词，动态注入到 tool description：

```typescript
// MCP tool 注册时动态生成 description
{
  name: "search_knowledge",
  description: `搜索用户知识库。可用知识源：
    - "项目文档": 部署、灰度、监控、告警、回滚、CI/CD
    - "IMA知识库": 产品功能、用户指南、API接口
    用户提问涉及上述主题时，应先搜索再回答。`
}
```

**增强 3：首轮对话引导**

session 首条消息如果有启用的知识源，system prompt 追加引导：

```
本次对话已启用知识库。请在回答用户问题前，优先检索知识库中的相关内容。
如果不确定知识库中是否有相关信息，宁可先搜一下再回答。
```

#### 演进路线

```
Phase 1 (MVP):  方案 A — AI 自主 MCP tool call + 三项增强
                ↓ 收集使用数据：AI 主动搜索率、漏搜率、检索质量
Phase 2:       方案 A+C — 增加 @ 显式触发（输入框 @ 菜单选择知识源）
                ↓ 如果数据显示 AI 漏搜率高于可接受范围
Phase 3:       方案 D — 在 A+C 基础上增加 L2 自动预检索（默认关闭，用户可开启）
```

从 A 到 D 是**增量演进**——A 的 MCP tool 在 D 中仍作为 L3 补充层存在，不浪费任何工作。方案 A 充分验证后，再根据实际数据决定是否需要自动预检索。

### 10. UI 交互位置

#### Settings → Knowledge Tab

新增 tab 与现有 Connection / General / About 并列：

- **知识源列表**：展示已配置的所有知识源（本地/第三方/自定义），含状态（已索引/已连接/未连接）
- **添加知识源**：DropdownMenu 选择类型 → 类型专属配置向导
  - 本地文件夹：选择路径 → 选择分块策略 → 开始索引
  - 在线文档：输入 URL → 配置爬取范围 → 测试抓取 → 开始索引
  - 第三方平台：输入凭证 → 测试连接 → 保存
  - 自定义 API：配置 endpoint + auth + 响应映射 → 测试 → 保存
- **Embedding 设置**：选择默认模型（本地/远程）、管理已下载的本地模型
- ~~**MarkItDown 状态**：显示 Python + markitdown 安装状态，提供安装引导~~ （已替换为纯 TS，不再需要安装状态显示）

#### Sidebar → Knowledge Panel

在现有 MCP / Skills / Workspace / Artifacts Panel 旁边新增 Knowledge tab：

- **知识源开关**：勾选当前 session 启用哪些知识源
- **检索模式切换**：Augmented（默认）/ Strict 模式 toggle
- **索引进度**：正在构建索引的知识源显示进度条
- **手动搜索**：搜索框支持直接检索（不经过 AI），显示结果 + 分数
- **最近引用**：展示 AI 在当前对话中检索过的知识条目
- **管理入口**："管理知识源 →" 跳转到 Settings Knowledge tab

#### Chat 中的展示

AI 调用知识库搜索时，在现有 tool-call-block 中自然展示：

```
🔧 search_knowledge
   query: "部署流程中的灰度策略"
   ▸ 找到 3 个相关文档片段
     1. deploy-guide.md §3.2 灰度发布 (score: 0.92)
     2. RFC-0042.md §2 灰度比例策略 (score: 0.87)
     3. ops-runbook.md §5 回滚流程 (score: 0.81)
```

### 10. 第三方平台适配

每个第三方平台实现为 Knowledge Sidecar 内部的一个 Adapter（非独立进程）：

```typescript
interface KnowledgeAdapter {
  type: string
  testConnection(config: AdapterConfig): Promise<boolean>
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>
  listBases?(config: AdapterConfig): Promise<KnowledgeBase[]>
  getDocument?(docId: string): Promise<Document>
}
```

| 平台 | 认证方式 | 实现优先级 |
|------|---------|-----------|
| 腾讯 IMA | Client ID + API Key | P1 (已有 POC) |
| 百炼知识库 | API Key | P2 |
| Obsidian | 本地 vault 路径 (直接文件读取) | P2 |
| Notion | OAuth 2.0 | P3 |
| NotebookLM | Google OAuth | P3 |

### 11. 在线文档爬取（场景 D）

参考 Cursor @Docs，支持用户粘贴文档站 URL 自动爬取索引：

```
用户输入: https://react.dev/reference/react
          ↓
Knowledge Sidecar:
  1. 爬取: 从入口 URL 递归抓取同域页面（深度/页数可配）
  2. 解析: HTML → Markdown（去导航/footer/广告）
  3. 分块 + Embedding: 同本地文件管线
  4. 存储: 同 index.db
```

**实现要点**：
- 爬虫引擎：轻量 HTTP 抓取（fetch + cheerio），不需要 headless browser
- 作用域控制：仅抓取同域/同路径前缀，防止爬到外部链接
- 更新策略：手动触发重新爬取（文档站通常更新不频繁）
- 去噪：提取 `<main>` / `<article>` 正文区域，过滤导航栏、侧边栏、页脚

**配置界面**：

```
┌─ 添加在线文档 ─────────────────────────┐
│                                        │
│  文档 URL: [https://react.dev/ref...] │
│  名称:     [React Reference]          │
│                                        │
│  爬取设置:                             │
│  最大页数: [100]  最大深度: [3]        │
│  路径前缀: [/reference/]  (可选)      │
│                                        │
│          [测试抓取]  [开始索引]         │
└────────────────────────────────────────┘
```

### 12. 检索模式：Chat / Query 双模式

参考 AnythingLLM，为 AI 调用知识库提供两种模式：

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| **Augmented**（默认） | AI 综合知识库检索结果 + 自身知识回答 | 通用对话、开发协助 |
| **Strict** | AI **仅**基于知识库内容回答，无匹配则明确告知 | 合规问答、企业知识库、避免幻觉 |

通过 MCP tool 参数传递：

```
search_knowledge(query, mode: "augmented" | "strict", ...)
```

Strict 模式下 AI 的 system prompt 附加约束："仅基于检索结果回答，如果知识库中没有相关内容，请明确告知用户。"

用户在 Sidebar Knowledge Panel 中可以切换默认模式。

### 13. 分块预览与质量可视化

参考 RAGFlow 的分块可视化，提供轻量版预览界面，帮助用户理解和验证索引质量：

**Settings → 知识库详情页**：

```
┌─ 项目文档 · 索引详情 ─────────────────────────────┐
│                                                    │
│  📊 索引概览                                        │
│  文件数: 1,234  |  分块数: 8,567  |  存储: 142MB   │
│  分块策略: Parent-Child  |  Embedding: BGE-small   │
│  最后更新: 5 分钟前                                 │
│                                                    │
│  📄 文件列表                          🔍 搜索文件   │
│  ┌──────────────────────────────────────────────┐  │
│  │ deploy-guide.md          23 块  ✅ 已索引     │  │
│  │ ├─ §1 环境准备           [3 块] ▸ 展开预览   │  │
│  │ ├─ §2 部署流程           [5 块] ▸ 展开预览   │  │
│  │ └─ §3 灰度策略           [4 块] ▸ 展开预览   │  │
│  │                                              │  │
│  │ architecture.pdf         45 块  ✅ 已索引     │  │
│  │ config.json              2 块   ✅ 已索引     │  │
│  │ video.mp4                —     ⏭️ 已跳过     │  │
│  └──────────────────────────────────────────────┘  │
│                                                    │
│  🧪 检索测试                                        │
│  [输入测试查询...]              [搜索]              │
│  → 结果预览 + 相似度分数 + 来源定位                  │
│                                                    │
└────────────────────────────────────────────────────┘
```

**设计要点**：
- 文件维度浏览分块结果（不是编辑，是只读预览）
- 展开可查看每个 chunk 的内容摘要
- 内置"检索测试"框：输入查询 → 显示 top-K 结果 + 分数，用于调试检索质量
- 跳过的文件（格式不支持、超大等）明确标注原因

### 14. 自定义 API Connector

用户可配置任意 REST API 作为知识源：

```typescript
interface CustomAPIConfig {
  name: string
  searchEndpoint: string           // https://kb.company.com/api/search
  method: "GET" | "POST"
  headers: Record<string, string>  // Authorization, etc.
  bodyTemplate: object             // { "query": "{{query}}", "top_k": 5 }
  responseMapping: {
    results: string                // JSONPath: "data.items"
    title: string                  // "item.title"
    content: string                // "item.content"
    url?: string                   // "item.source_url"
  }
}
```

Settings 中提供模板编辑器 + 测试按钮，让用户可视化配置请求/响应映射。

## 分阶段实施

| Phase | 内容 | 触发模式 | 复杂度 | 状态 |
|-------|------|---------|--------|------|
| **1** | Knowledge Sidecar 骨架 + 本地 md/txt/代码 RAG + TF-IDF Embedding + 混合检索 (BM25+向量+RRF) + Settings Knowledge tab 基础 UI | 方案 A（AI 自主） | 高 | ✅ 2026-05-16 |
| **2** | Parent-Child 双层分块 + 文档解析 (PDF/docx/xlsx/pptx, 纯 TS) + 索引进度 UI (SSE) + 文件监听 | 方案 A | 中 | ✅ 2026-05-19 |
| **3** | 第三方平台 Adapter (IMA 优先) + 凭证配置向导 + 测试连接 + 统一 ID-based API + 跨源搜索 | 方案 A | 中 | ✅ 2026-05-20 |
| **4** | `@知识库名` 显式触发 + 在线文档爬取索引 + 自定义 API Connector + 远程 Embedding | 方案 A+C | 中 | 🔲 |
| **5** | Sidebar Knowledge Panel + Chat/Strict 双模式 + 分块预览 + 检索测试 + 引用溯源 | 方案 A+C | 中 | 🔲 |
| **6** | 更多第三方平台 (Notion/百炼) + 知识源同步更新 | 方案 A+C | 中 | 🔲 |
| **7** | （条件触发）自动预检索（默认关闭，用户可开启）— 仅当数据显示 AI 漏搜率不可接受时推进 | 方案 D | 中 | 🔲 |

> **Phase 2 调整说明（2026-05-19）**：原 Phase 2 包含 ONNX 神经 Embedding 升级，实施时因 `bun build --compile` 兼容性问题（`@huggingface/transformers` issue #1672 未解决、`onnxruntime-node` 需要子进程隔离增加复杂度）决定延后。ONNX 合并到原 Phase 3（第三方平台）一起实施，避免单独为 embedding 切换做一轮全量重索引。TF-IDF + FTS5 BM25 混合检索质量已可接受。
>
> **Phase 3 调整说明（2026-05-20）**：ONNX 神经 Embedding 升级再次延后（bun compile 兼容性仍未解决），Phase 3 聚焦第三方平台 Adapter + 凭证配置 + 跨源搜索。新增统一 `knowledge_sources` 表（Schema Migration v3）替代旧的 folderPath 标识，API 迁移为 ID-based 路由并保持向后兼容。ONNX 升级移至后续独立 Phase。

Phase 1 的最小目标：用户选一个文件夹 → 自动索引（md/txt/代码文件）→ AI 通过 MCP tool 自主检索 → 对话中能搜到并引用知识库内容。

## Phase 1 实际实现说明

Phase 1 已实现（2026-05-16）。以下记录实际实现与上文设计描述的差异及原因。

### 有意的简化

| 设计描述 | Phase 1 实际实现 | 原因 | 后续状态 |
|---------|---------|------|---------|
| **ONNX BGE-small 本地模型** (§4) | TF-IDF hashing embedder（纯 TS，384 维） | `@huggingface/transformers` 在 `bun build --compile` 下崩溃（[issue #1672](https://github.com/huggingface/transformers.js/issues/1672)）。TF-IDF 零依赖、编译安全，配合 FTS5 BM25 质量可接受 | → Phase 3 升级 |
| **sqlite-vec FLOAT32[384] 向量列** (§7) | 独立 `chunk_embeddings` 表，BLOB 存储 + 内存 cosine 计算 | sqlite-vec 在 macOS 需要 `Database.setCustomSQLite()` 且 pre-v1 API 不稳定。BLOB + 内存 cosine 在 <100K chunks 下性能可接受 | → Phase 3 可引入 |
| **512 tokens 分块** (§5) | Phase 1: 40 行/chunk → **Phase 2: Parent-Child 双层** | Token 计数需要 tokenizer 依赖。行基分块零依赖 | ✅ Phase 2 已升级 |
| **System prompt 知识源摘要注入** (§9) | 在 MCP tool response 中附带知识源信息 | System prompt 注入需要 OpenCode 侧配合（vendor patch），超出 sidecar 独立实现范围 | 待评估 |

### 数据库 Schema（实际，Phase 2 更新）

与上文 §7 的理想化 schema 不同，实际使用更简化的 schema。Phase 2 通过 migration v2 添加了 `parent_id`/`chunk_type` 列：

```sql
-- 知识源（对应设计中的 documents 表）
CREATE TABLE sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_path TEXT NOT NULL,          -- 所属文件夹
  file_path TEXT NOT NULL UNIQUE,     -- 文件绝对路径
  file_hash TEXT NOT NULL,            -- SHA-256，增量索引用
  indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
  chunk_count INTEGER DEFAULT 0
);

-- 分块（Phase 2: 新增 parent_id + chunk_type）
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',  -- { file_path, start_line, end_line }
  parent_id INTEGER REFERENCES chunks(id),   -- Phase 2: 子块指向父块（父块为 NULL）
  chunk_type TEXT NOT NULL DEFAULT 'child'   -- Phase 2: 'parent' | 'child'
);

-- Schema 版本管理（Phase 2 新增）
CREATE TABLE _migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- FTS5 全文检索（自动同步触发器）
CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='id');

-- Embedding 存储（仅 child 块有 embedding）
CREATE TABLE chunk_embeddings (
  chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL  -- Float32Array 序列化
);
```

与设计 schema 的主要差异：INTEGER 自增 ID（非 TEXT UUID）、sources 替代 documents 命名、embedding 在独立表中以 BLOB 存储。Phase 2 添加了 parent-child 关系但未引入设计中的 `FLOAT32[384]` 向量列（仍用 BLOB）。

### HTTP API（实际，Phase 2 更新）

采用文件夹路径标识（而非设计中的 UUID ID），因为当前只有本地文件夹知识源：

```
GET    /kb/health                      — 健康检查
GET    /kb/sources                     — 列出所有知识源
POST   /kb/sources                     — 添加文件夹 { folderPath }（Phase 2: 异步返回 202，?sync=true 走同步）
GET    /kb/sources/events              — Phase 2: SSE 实时索引进度流
GET    /kb/sources/:folderPath         — 知识源状态
DELETE /kb/sources/:folderPath         — 删除知识源
POST   /kb/sources/:folderPath/reindex — 重建索引（Phase 2: 异步 202，?sync=true 走同步）
POST   /kb/search                      — 搜索 { query, limit?, retrieval? }
```

Phase 2 变更：`POST /kb/sources` 和 `/reindex` 改为异步（返回 202），通过 `GET /kb/sources/events` SSE 推送实时进度。`?sync=true` 参数保留同步行为供 MCP bridge 使用。

引入第三方平台后，API 将迁移到统一的 ID-based 路由（`/kb/:id/...`）。

### MCP Tools（实际）

```
knowledge_search(query, limit?)       — 混合检索，response 附带知识源信息
knowledge_list_sources()              — 列出已索引知识源
```

与设计差异：`search_knowledge` 重命名为 `knowledge_search`（MCP 工具名加 namespace 前缀更清晰）、参数简化为 query + limit（`kb_ids`/`mode`/`retrieval` 待 Phase 4-5 添加）、`get_document` 待 Phase 2 添加。

### MCP Bridge 双模式

实现中增加了设计未提及的 **direct 模式**：

- **Direct 模式**（默认 mcp-stdio）：search/indexer 在 MCP bridge 进程内直接运行，不经过 HTTP 代理。更高效，避免 localhost 网络开销。
- **Proxy 模式**（fallback）：通过 HTTP 调用 :4098 API。用于独立调试。

同一二进制的子命令切换：`knowledge-sidecar`（HTTP server）、`knowledge-sidecar mcp-stdio`（MCP stdio bridge, direct 模式）。

### 配置路径

所有 MCP 配置统一使用全局路径 `~/.config/ultrawork/opencode.json`，不使用工作区级别 opencode.json。Tauri command `read_mcp_config`/`write_mcp_config`/`remove_mcp_config` 已移除 workspace 参数。

知识库索引数据存储在 `~/.ultrawork/knowledge/kb.db`（全局单库，非按工作区分库）。

## Phase 2 实际实现说明

Phase 2 已实现（2026-05-19）。以下记录实际实现与上文设计描述的差异。

### 范围调整

| 设计内容 | 实际 | 原因 |
|---------|------|------|
| **ONNX 神经 Embedding 升级** (§4) | 延后到 Phase 3 | `bun build --compile` 兼容性问题未解决，子进程隔离方案增加过多复杂度。TF-IDF + FTS5 BM25 混合检索质量已可接受，不急于升级 |

### Parent-Child 分块参数（实际）

| 参数 | 设计值 (§5) | 实际值 | 说明 |
|------|-----------|--------|------|
| Parent 块大小 | ~1000 tokens | ~60 行 | 行基分块避免 tokenizer 依赖，60 行 ≈ 600-900 tokens |
| Child 块大小 | ~200 tokens | ~12 行 | 12 行 ≈ 120-180 tokens，精确匹配单元 |
| Child overlap | 50 tokens | 2 行 | 少量 overlap 够用，减少冗余 chunk 数量 |

小文件（≤ 12 行）直接作为 parent+child 双重角色，不拆分。

### 新增能力

| 能力 | 说明 |
|------|------|
| **文档解析（PDF/docx/xlsx/pptx）** | 纯 TS 库（unpdf/mammoth/xlsx/jszip）直接提取文本 → 走标准分块管线。零外部依赖，始终可用。~~原为 MarkItDown (Python CLI)，2026-05-20 替换~~ |
| **SSE 索引进度** | `GET /kb/sources/events` 实时推送 per-file 进度。前端通过 `EventSource` 更新进度条和当前文件名 |
| **文件监听** | `fs.watch({ recursive: true })` + 双层 debounce（文件 2s + 文件夹 5s batch）→ 单文件增量重索引 |
| **Schema 迁移** | `_migrations` 表 + 版本化迁移。Phase 1 → Phase 2 自动添加 `parent_id`/`chunk_type` 列并触发全量重索引 |
| **多监听器模式** | `indexer.addProgressListener()` 支持 SSE 广播和文件监听并行订阅进度事件 |

### 检索变更

Phase 2 检索只搜 child 块，命中后查 `parent_id` 返回 parent 块内容。同一 parent 下多个 child 命中只返回一次（去重）。`SearchResult` 新增 `parentContent`/`parentStartLine`/`parentEndLine` 字段，MCP bridge 展示 parent 上下文而非 child 片段。

### ~~后续优化：MarkItDown → 纯 TS 文档解析~~ ✅ 已完成 (2026-05-20)

已用纯 TS 库替换 MarkItDown，消除 Python 外部依赖：

| 格式 | 库 | 说明 |
|------|-----|------|
| PDF | `unpdf`（serverless-friendly PDF 解析） | `extractText(buffer)` 提取文本，`bun build --compile` 兼容 |
| DOCX | `mammoth` | `extractRawText({ buffer })` 提取纯文本 |
| XLSX | `xlsx`（SheetJS） | 按 sheet 输出 CSV 格式文本 |
| PPTX | `jszip` + XML regex | 解压 ZIP → 提取 `<a:t>` 文本节点 |

**实现**：新建 `doc-parser.ts` 替代 `markitdown.ts`，`indexer.ts` 直接 import `convertDocument()`（移除了 `setMarkItDown()` 注入模式）。30s per-file timeout + graceful 降级。
**已知局限**：PDF 复杂排版（扫描件、多栏）的文本提取质量有限，覆盖 80%+ 常见场景。

## Phase 3 实际实现说明

Phase 3 已实现（2026-05-20）。以下记录实际实现与上文设计描述的差异。

### 范围调整

| 设计内容 | 实际 | 原因 |
|---------|------|------|
| **ONNX 神经 Embedding 升级** (§4) | 再次延后 | `bun build --compile` 兼容性问题仍未解决，TF-IDF + FTS5 BM25 质量可接受 |
| **第三方平台 Adapter** (§10) | IMA 已实现 | 百炼/Obsidian/Notion 待后续 Phase |
| **Custom API Connector** (§14) | 类型已定义，UI 显示 Coming soon | 后端 `custom_api` 类型已预留，Phase 4 实现 |

### Schema Migration v3（实际）

新增 `knowledge_sources` 统一注册表，从旧 `sources.folder_path` 自动迁移：

```sql
CREATE TABLE knowledge_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'local_folder',  -- 'local_folder' | 'ima' | 'custom_api'
  name TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',      -- 类型专属配置（含凭证）
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'idle',         -- 'idle'|'indexing'|'complete'|'connected'|'error'
  error_message TEXT,
  created_at TEXT, updated_at TEXT
);
ALTER TABLE sources ADD COLUMN ks_id INTEGER REFERENCES knowledge_sources(id);
```

`sources` 表新增 `ks_id` 外键，`addSource()` 自动查找并设置。

### HTTP API 迁移（实际）

API 从 folderPath-based 迁移为 ID-based，保持向后兼容：

```
GET    /kb/sources                      — 统一列表（合并 indexer 状态给 local_folder）
POST   /kb/sources                      — { type, name, config } 或 legacy { folderPath }
GET    /kb/sources/:id{[0-9]+}          — 按 ID 查询
PUT    /kb/sources/:id{[0-9]+}          — 更新配置
DELETE /kb/sources/:id{[0-9]+}          — 删除
POST   /kb/sources/:id/test-connection  — 测试连接（所有类型）
GET    /kb/sources/:id/bases            — 列出子知识库（IMA）
POST   /kb/sources/:id/reindex          — 重索引（仅 local_folder）
POST   /kb/search                       — 跨源搜索（本地 + 远程合并，返回 results + remoteResults）
```

旧的 `DELETE /kb/sources/:folderPath` 和 `POST /kb/sources/:folderPath/reindex` 路由保留作为兼容。

### IMA Adapter（实际）

IMA API base URL: `https://ima.qq.com`，认证头 `ima-openapi-clientid` + `ima-openapi-apikey`。

| 方法 | 端点 | 用途 |
|------|------|------|
| `testConnection` | `POST /openapi/wiki/v1/get_addable_knowledge_base_list` | 验证凭证 + 列出可用知识库 |
| `search` | `POST /openapi/wiki/v1/search_knowledge` | 搜索知识库内容 |
| `listBases` | 复用 testConnection | 返回知识库列表 |

**已知限制**：IMA `search_knowledge` 只返回 `title` + `highlight_content`（搜索片段），不返回完整文档内容。`highlight_content` 在仅标题匹配时为空字符串。完整内容获取需要额外 API（`get_doc_content` 等），待后续增强。

**IMA API 响应字段兼容**：IMA 实际返回 `code`/`msg`（非文档中的 `retcode`/`errmsg`），adapter 用 `responseCode()` 方法兼容两种格式。

### 凭证安全

- API 响应通过 `sanitizeConfig()` 过滤 `apiKey` 等敏感字段，只返回 `hasApiKey: true`
- 数据库目录 `~/.ultrawork/knowledge/` 使用 `mode: 0o700` 权限
- 凭证存储在 `knowledge_sources.config_json`（SQLite），暂未使用 OS Keychain

### 前端变更

- `AddSourceDialog`：三种类型选择（本地文件夹 / 腾讯 IMA / 自定义 API Coming soon）→ IMA 凭证表单 → 测试连接 → 选知识库 → 保存
- `KnowledgeSection`：filter chips 按类型筛选（全部/本地文件夹/第三方平台/自定义 API）+ 数量徽章
- `KnowledgeSourceCard`：按 type 分支渲染（local_folder 显示进度条+重索引，ima 显示连接状态+测试连接按钮）
- `use-knowledge-base.ts`：`KBSource` 统一模型（id/type/config），方法改为 ID-based（`removeSource(id)`, `reindexSource(id)`, `testConnection(id)`）

### MCP Bridge 变更

- `knowledge_search`：跨源搜索（本地 retriever + 远程 adapter 并行，合并排序）
- `knowledge_list_sources`：显示所有源类型 + ID（`[id=8] **微信用户的知识库** [IMA]`）
- `source_ids` 参数：可选，默认搜全部，引导 AI 省略以获得最佳覆盖

## 考虑过的替代方案

### 1. 每个知识源一个独立 MCP Server (ADR-019 方案)

ADR-019 的原方案。

**未采用原因**：本地 RAG 需要持久化状态（向量库）和重计算（索引构建），无法用轻量 MCP Server 承载。将本地 RAG 放入独立 Sidecar 后，第三方平台也放入同一 Sidecar 作为 Adapter 更自然，避免 N 个进程的管理开销。

### 2. 将 RAG 能力集成到 OpenCode Server

在 OpenCode Server 中增加知识库模块。

**未采用原因**：OpenCode 是 upstream 项目（vendor submodule），不应往里注入 Ultrawork 特有功能。且知识库索引是重计算操作，可能影响 OpenCode 的 AI 对话响应。

### 3. 使用外部向量数据库 (Chroma / Qdrant)

部署独立的向量数据库服务。

**未采用原因**：桌面应用不适合额外启动数据库服务。SQLite + sqlite-vec 单文件方案对桌面场景足够，且 Bun 内置 SQLite 零依赖。

### 4. 仅支持远程 Embedding API

不内置本地模型，全部使用用户配置的 LLM Provider 的 embedding API。

**未采用原因**：隐私和离线可用是桌面 AI Agent 的核心卖点。本地模型增加 ~50-100MB 包体积，换来零成本、零延迟、数据不出本机，值得。

### 5. 每条消息自动预检索（Always-on RAG）

每条用户消息自动执行知识库检索，将 top-K 结果注入 AI prompt。

**暂不采用原因**：噪声风险高——不相关内容注入会稀释 AI 注意力、浪费 context window、可能误导 AI 引用不准确信息。阈值调优是无底洞（不同知识库/领域最优值不同），且增加每条消息 200-500ms 延迟。保留为 Phase 7 条件触发项，仅当方案 A 的 AI 漏搜率不可接受时再推进，届时默认关闭由用户自行开启。

### 6. 用 Go 实现 Knowledge Sidecar

与 OpenCode Server 语言一致。

**未采用原因**：OpenCode 虽然是 Go 写的（更正：实际是 TypeScript + Effect-TS），但 Gateway Sidecar 已验证 TypeScript + Bun 的可行性。团队对 TypeScript 更熟悉，Bun 内置 SQLite 也减少了依赖复杂度。

## 后果

### 正面

- 三类知识库场景统一架构，用户体验一致
- 本地 RAG 开箱即用（本地 Embedding + SQLite），隐私优先
- MCP 协议对接 AI，无需自建调用链路
- 单一 Sidecar 进程管理简单，与 Gateway 复用 Tauri 管理模式
- 增量索引 + 文件监听减少重建开销

### 负面

- Knowledge Sidecar 新增一个进程（目前已有 OpenCode + Gateway）
- 内置 ONNX 模型增加 ~50-100MB 包体积
- ~~MarkItDown 依赖系统 Python，部分用户可能未安装~~ （已消除，2026-05-20 替换为纯 TS）
- 本地 RAG 的索引构建耗时，需要完善的异步 UX
- sqlite-vec 扩展需要在 Bun 中加载原生模块，可能有平台兼容性问题

### 技术风险（调研发现）

| 风险 | 影响 | 缓解方案 |
|------|------|---------|
| sqlite-vec macOS 需要自定义 SQLite 路径 | 打包复杂度增加 | `Database.setCustomSQLite()` 指定 homebrew 路径，或 bundle 自带 libsqlite3 |
| sqlite-vec 无 HNSW/ANN 索引 | >100K 向量时暴力搜索变慢 | 分区键(partition key)按知识库隔离 + 控制每库规模；未来可迁移到 LanceDB |
| transformers.js `bun build --compile` 崩溃 | Knowledge Sidecar 无法编译为单二进制 | 方案 B: onnxruntime-node N-API；方案 C: 独立 Node.js embedding 子进程 |
| sqlite-vec pre-v1 API 不稳定 | 升级可能有 breaking changes | 封装 VectorStore 抽象层，隔离底层 API |
| FTS5 中文分词不佳 | 中文关键词检索召回率低 | 预处理阶段用 jieba 分词，以空格分隔后存入 FTS5 |

## 参考

### 内部文档

- ADR-019: 知识库集成 (Withdrawn) — 之前的 MCP 架构 POC
- ADR-013: Channel Gateway 独立 Sidecar — Sidecar 架构模式参考
- IMA OpenAPI: `research/knowledge-base-research/kb-api.md`

---

### 核心技术组件 — 实现参考

#### sqlite-vec（向量检索）

- **GitHub**: https://github.com/asg017/sqlite-vec
- **文档**: https://alexgarcia.xyz/sqlite-vec/
- **npm**: `sqlite-vec`
- **Bun 官方示例**: https://github.com/asg017/sqlite-vec/blob/main/examples/simple-bun/demo.ts

**平台支持**: Linux/macOS/Windows/WASM/Raspberry Pi 全平台。macOS 内置 SQLite 不允许加载扩展，**需要指定自定义 SQLite 路径**：

```typescript
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

// macOS 必须！否则扩展加载失败
Database.setCustomSQLite("/usr/local/opt/sqlite3/lib/libsqlite3.dylib");

const db = new Database(":memory:");
sqliteVec.load(db);

// 创建向量表（vec0 虚拟表）
db.run("CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[384])");

// 插入
const stmt = db.prepare("INSERT INTO vec_items(rowid, embedding) VALUES (?, vec_f32(?))");
stmt.run(1, new Float32Array([0.1, 0.2, ...]));

// KNN 搜索
const results = db.prepare(
  "SELECT rowid, distance FROM vec_items WHERE embedding MATCH ? ORDER BY distance LIMIT 5"
).all(new Float32Array([0.3, 0.3, ...]));
```

**关键 API**:

| 函数 | 用途 |
|------|------|
| `vec_f32(v)` | 创建 float32 向量 |
| `vec_int8(v)` | 创建 int8 量化向量（省空间） |
| `vec_distance_cosine(a,b)` | 余弦距离 |
| `vec_distance_L2(a,b)` | 欧氏距离 |
| `vec_normalize(v)` | L2 归一化 |
| `vec_quantize_i8(v)` | 标量量化 |

**已知限制**:
- ⚠️ **无 HNSW/ANN 索引**，使用暴力 KNN 搜索。<100K 向量可接受，更大规模需评估
- ⚠️ pre-v1 版本，API 可能有 breaking changes
- ⚠️ Bun 中 rowid 返回 `BigInt` 类型，需注意类型转换
- vec0 支持 **partition key**（按知识库 ID 分区，提高查询效率）和 **auxiliary 列**（存文本等辅助数据）

#### SQLite FTS5（全文检索）

- **文档**: https://www.sqlite.org/fts5.html
- Bun 内置 SQLite 已包含 FTS5，无需额外加载
- 支持中文分词需要 `simple` tokenizer 或自定义分词（中文场景可考虑 jieba 预处理）

#### Embedding 模型运行

**方案 A: @huggingface/transformers（推荐先尝试）**

- **npm**: `@huggingface/transformers`
- **文档**: https://huggingface.co/docs/transformers.js
- 底层用 ONNX Runtime WASM，Bun 支持 WebAssembly
- ⚠️ **已知问题**: `bun build --compile` 单二进制模式会崩溃（[GitHub issue #1672](https://github.com/huggingface/transformers.js/issues/1672)）。普通 `bun run` 可用

```typescript
import { pipeline } from '@huggingface/transformers';

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
const output = await extractor(['Hello world'], { pooling: 'mean', normalize: true });
// output.dims = [1, 384], output.data = Float32Array
```

**方案 B: onnxruntime-node（性能更好）**

- **npm**: `onnxruntime-node`
- 使用 N-API 原生插件，Bun 支持 N-API ~95%（https://bun.sh/docs/runtime/node-api）
- 需实际测试兼容性
- 平台: macOS (x64+arm64), Linux (x64 CPU/CUDA, arm64), Windows (x64/arm64)

**方案 C: 独立 Node.js 子进程（保底）**

- 将 embedding 逻辑放在独立 Node.js 脚本中
- Knowledge Sidecar 通过 IPC/HTTP 调用
- 兼容性最好，但多一层 IPC 开销

**可用 ONNX 嵌入模型**:

| 模型 | 维度 | 语言 | 大小 | npm 下载量 |
|------|------|------|------|-----------|
| `Xenova/all-MiniLM-L6-v2` | 384 | 英文 | ~23MB | 月 370 万+ |
| `Xenova/bge-small-zh-v1.5` | 512 | 中文 | ~50MB | — |
| `BAAI/bge-small-zh-v1.5` | 512 | 中文 | ~90MB | 需自行转 ONNX |

#### ~~MarkItDown（文件转 Markdown）~~ → 已替换为纯 TS 方案 (2026-05-20)

> 原方案使用 [microsoft/markitdown](https://github.com/microsoft/markitdown) (Python 3.10+)，已替换为以下纯 TS 库：

| 库 | 用途 | npm |
|----|------|-----|
| `unpdf` | PDF 文本提取 (serverless-friendly) | `unpdf` |
| `mammoth` | DOCX 文本提取 | `mammoth` |
| `xlsx` (SheetJS) | XLSX → CSV 文本 | `xlsx` |
| `jszip` | PPTX 解压 + XML 文本提取 | `jszip` |

#### Cheerio（网页解析）

- **npm**: `cheerio`（`bun add cheerio`）
- **GitHub**: https://github.com/cheeriojs/cheerio
- TypeScript 原生（65% TS）、Bun 完全兼容、轻量无浏览器依赖
- 用于在线文档爬取中的 HTML → Markdown 转换

```typescript
import * as cheerio from 'cheerio';

const html = await fetch(url).then(r => r.text());
const $ = cheerio.load(html);
const content = $('article, .content, main').text();
const links = $('a[href]').map((_, el) => $(el).attr('href')).get();
```

---

### 算法参考

#### RRF（Reciprocal Rank Fusion）

**权威参考**: https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking

**公式**: `RRF_score(doc) = Σ 1/(rank_i + k)`，标准 **k=60**

```typescript
function reciprocalRankFusion(
  resultSets: { id: string; rank: number }[][],
  k: number = 60
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const results of resultSets) {
    for (const { id, rank } of results) {
      scores.set(id, (scores.get(id) || 0) + 1 / (rank + k));
    }
  }
  return scores;
}

// 使用: 融合向量检索 + BM25 结果
const vectorResults = [{ id: "doc1", rank: 1 }, { id: "doc2", rank: 3 }];
const bm25Results   = [{ id: "doc2", rank: 1 }, { id: "doc3", rank: 2 }];
const fused = reciprocalRankFusion([vectorResults, bm25Results]);
const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]);
```

Azure Search 支持加权 RRF（如向量结果 weight=2.0 更重视语义匹配）。

#### Parent-Child 分块检索流程

```typescript
// 1. 向量搜索匹配 child chunks
const childMatches = db.prepare(`
  SELECT vc.chunk_id, vc.distance, c.parent_id
  FROM vec_chunks vc
  JOIN chunks c ON c.id = vc.chunk_id
  WHERE vc.embedding MATCH ?
  ORDER BY vc.distance LIMIT 10
`).all(queryEmbedding);

// 2. 去重获取 parent chunks
const parentIds = [...new Set(childMatches.map(m => m.parent_id))];
const parents = db.prepare(`
  SELECT * FROM chunks WHERE id IN (${parentIds.map(() => '?').join(',')})
`).all(...parentIds);

// 3. 返回 parent 内容作为 LLM 上下文
```

分块参数参考:

| 参数 | Parent | Child |
|------|--------|-------|
| chunk_size | 1000-2000 tokens | 200-400 tokens |
| overlap | 200 tokens | 50 tokens |

---

### 开源 MCP 知识库服务器（可参考实现）

| 项目 | Stars | 特点 | GitHub |
|------|-------|------|--------|
| **knowledge-mcp** | 48 | LightRAG 引擎，混合向量+知识图谱，多检索策略 | https://github.com/olafgeibig/knowledge-mcp |
| **Axon.MCP.Server** | 164 | 代码库索引，Tree-sitter+pgvector，<500ms p95 | https://github.com/ali-kamali/Axon.MCP.Server |
| **DocSentinel** | 88 | 多格式解析+RAG，安全领域 | https://github.com/arthurpanhku/DocSentinel |
| **knowledgebase-mcp** | 3 | 高精度本地知识库，标准 MCP 实现 | https://github.com/PaulTheSecond/knowledgebase-mcp |
| **ragflow-knowledge-mcp-server** | 5 | RAGFlow 的 MCP 接口包装 | https://github.com/lumerix7/ragflow-knowledge-mcp-server |

**knowledge-mcp 架构**（最值得参考）：
- 三层：CLI 工具 → LightRAG 引擎 → MCP Server (FastMCP)
- 文档流：摄入 → 分块 → LLM 提取实体/关系 → 双存储（向量 + 知识图谱）
- 多检索策略：向量相似度、实体中心、关系中心、混合
- Python 实现，但架构可移植到 TypeScript

---

### 网页爬取工具

| 工具 | 特点 | 适用场景 |
|------|------|---------|
| **Cheerio + fetch** | TS 原生，轻量，零成本 | 静态文档站（推荐默认方案） |
| [Firecrawl](https://docs.firecrawl.dev) | 自动 JS 渲染、反 bot、sitemap、结构化输出，有官方 MCP Server | 复杂 JS 渲染站、大规模爬取 |
| [Jina Reader](https://jina.ai/reader/) | `https://r.jina.ai/` 前缀即可获取 MD，自动图片 caption | 快速单页抓取、免费 20 RPM |

Firecrawl 关键参数：`maxDiscoveryDepth`（爬取深度）、`maxConcurrency`（并发）、sitemap 模式（include/skip/only）。

---

### 行业产品 — 技术实现详情

#### Cursor

- **博客**: https://cursor.com/blog
- **文档**: https://cursor.com/docs/context/codebase-indexing
- **@Docs**: https://docs.cursor.com/context/@-symbols/@-docs
- **深度分析**: [How Cursor Actually Indexes Your Codebase](https://towardsdatascience.com/how-cursor-actually-indexes-your-codebase/) (Towards Data Science)

关键技术：自研 embedding 模型（代码专用）、AST 感知分块（函数/类边界）、Merkle Tree 增量更新（每 5-10 分钟）、Turbopuffer 云端向量库、路径加密（隐私）、索引 80% 即可搜索。

#### Windsurf (Codeium)

- **Memories**: https://docs.windsurf.com/windsurf/cascade/memories
- **Flow 上下文引擎**: https://markaicode.com/windsurf-flow-context-engine/

关键技术：本地 embedding（原始代码不离开本机）、SWE-grep（LLM-based 代码搜索，比传统 embedding 更准）、Flow 实时上下文（保存/测试/导航等操作自动注入）、Memories 按 workspace 隔离存储在 `~/.codeium/windsurf/memories/`。

#### Dify

- **知识库创建**: https://docs.dify.ai/en/use-dify/knowledge/create-knowledge/
- **Knowledge Pipeline**: https://docs.dify.ai/en/use-dify/knowledge/knowledge-pipeline/
- **多模态检索**: https://dify.ai/blog/multimodal-retrieval-is-now-available-in-the-knowledge-base

关键技术：三种分块（General / Parent-Child / Q&A）、三种检索（向量/全文/混合，可调权重）、可选 Reranker 模型重排序、经济模式（无 embedding，仅关键词倒排）、Vision embedding 多模态检索。

**Parent-Child 实现细节**：Parent 可选 Paragraph 模式（按分隔符切）或 Full Doc 模式（整文档限 10K tokens）。Child 在 Parent 内部独立切分。⚠️ 创建后不可更改分块模式。

#### RAGFlow

- **GitHub**: https://github.com/infiniflow/ragflow
- **使用指南**: https://www.knightli.com/en/2026/04/15/ragflow-rag-engine-guide/

关键技术：**DeepDoc 深度文档理解**是最大亮点——布局分析（识别 10 种组件：Text/Title/Table/Figure 等）、OCR 集成、TSR 表格结构识别（行/列/表头/跨单元格）、自动旋转（评估 4 个角度的 OCR 置信度）。支持 PDF/DOCX/Excel/PPT 解析。分块可视化 + 人工干预。

#### AnythingLLM

- **GitHub**: https://github.com/Mintplex-Labs/anything-llm
- **RAG 指南**: https://www.nullzen.dev/blog/anythingllm-rag-guide/
- **文档**: https://docs.anythingllm.com/introduction

关键技术：LanceDB 默认（零配置）、table-per-namespace 隔离、嵌入抽象层（30+ provider 可切换）、Chat/Query 双模式、搜索阈值 0.25（余弦）、批量嵌入（500 条/批）、向量缓存避免重复嵌入。

**LanceDB 表 Schema**:
```
{ id: UUID, vector: float[], metadata: { source, documentId, text }, text: string }
```

#### Coze 扣子

- **知识库指南**: https://zhuanlan.zhihu.com/p/695392042
- **RAG 检索**: https://blog.csdn.net/AT_GCS/article/details/149905112
- **开源**: Coze Studio + Coze Loop (Apache 2.0)，GitHub 48 小时 9000+ stars

关键技术：三种知识库（文本/表格/图片）、三种分段方式（自动/自定义/按层级）、混合向量检索 + RRF 融合、余弦/欧式/IP 三种距离度量。

#### GitHub Copilot Spaces

- **文档**: https://docs.github.com/en/enterprise-cloud@latest/copilot/concepts/context/knowledge-bases
- **Sunset 通知**: https://github.blog/changelog/2025-08-20-sunset-notice-copilot-knowledge-bases/
- 从 Knowledge Bases 迁移到 Spaces：支持代码 + 自由文本 + Issues/PR + 图片混合知识，组织级 admin/editor/viewer 权限，通过 GitHub MCP Server 在 IDE 中访问。

#### Obsidian + AI

- **AI 集成指南**: https://www.nxcode.io/resources/news/obsidian-ai-second-brain-complete-guide-2026
- 方向：从"插件内 AI" 转向 "AI 工具通过 MCP 接入笔记库"（Obsidian CLI v1.12 起 + MCP 集成）
