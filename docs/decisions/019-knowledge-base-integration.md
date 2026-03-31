# ADR-019: 知识库集成 — IMA 优先 + MCP 架构

**状态**: Proposed
**日期**: 2026-03-31
**关联**: 知识库调研 `research/knowledge-base-research/`

## 背景

Ultrawork 作为桌面 AI Agent，用户希望能接入自己的知识库，让 AI 在对话中按需搜索个人知识回答问题。

调研覆盖了 NotebookLM、IMA、Notion、Obsidian、Perplexity、Coze、通义千问等产品（详见 `research/knowledge-base-research/knowledge-base-research-report.md`）。其中**腾讯 IMA** OpenAPI 已实测验证全部 15 个端点可用，认证方式为 Client ID + API Key（无需 OAuth），是最适合首批集成的云端知识库。

## 决策

### 架构：每个知识源 = 一个 MCP Server

不自建 adapter 抽象层，直接利用 MCP 协议作为统一接口。每个知识源实现为独立 MCP Server，opencode AI 通过 MCP tool 自主调用。

选择 MCP 而非其他方案的理由：

| 方案 | 优点 | 缺点 |
|------|------|------|
| **MCP Server** ✅ | AI 天然可调用；复用已有 MCP 基础设施；每个知识源独立，架构干净 | 多一个进程 |
| Tauri command | 最轻量 | 每加一个源要写 Rust；AI 无法直接调用 |
| Gateway 扩展 | 复用已有进程 | Gateway 职责膨胀（channel + knowledge 混杂） |
| 前端直接 HTTP | 简单 | CORS 受限；AI 无法自主使用 |

### UI：Settings 配置 + 右侧 Sidebar 展示

- **Settings → Knowledge tab**（新增）：配置知识源连接、管理凭证。底层自动注册/注销对应的 MCP Server
- **右侧 Sidebar → Knowledge panel**（Phase 2）：对话中浏览/搜索知识库，紧凑展示

这与现有 MCP 模式一致——Settings 有完整的 Services tab，右侧 Sidebar 有精简的 MCP Panel。Knowledge tab 是面向知识源的配置向导，对用户隐藏 MCP 细节。

### IMA 授权流程

IMA 使用 Client ID + API Key 认证（非 OAuth）：

1. 用户点击「+ 添加知识库」→ 选择「腾讯 IMA」
2. 引导用户用系统浏览器打开 `ima.qq.com/agent-interface`，微信扫码生成凭证
3. 用户回到 app 粘贴 Client ID + API Key
4. 点击「测试连接」→ 调 `get_addable_knowledge_base_list` 验证 → 成功显示知识库列表
5. 保存后自动注册 IMA MCP Server

不嵌入 webview，因为微信扫码登录在嵌入 webview 中大概率被风控拦截。

### 打包方式

IMA MCP Server 使用 `bun build --compile` 编译为独立二进制，与 gateway sidecar 保持一致：
- DMG 分发无需依赖用户机器 bun 运行时
- opencode 通过二进制路径 spawn 子进程

### 数据模型

```typescript
// ~/.ultrawork/knowledge-sources.json
interface KnowledgeSource {
  id: string
  type: "ima" | "notion" | "obsidian"  // 后续扩展
  name: string
  enabled: boolean
  config: IMAConfig | NotionConfig | ObsidianConfig  // 联合类型
  connectedAt: string
}

interface IMAConfig {
  clientId: string
  apiKey: string
}
```

凭证存储在 `~/.ultrawork/knowledge-sources.json`。后续可考虑迁移到 OS Keychain。

### 不提前做 adapter 抽象层

MCP 协议本身就是 adapter 层。加 Notion 时写 `notion-mcp-server`，加 Obsidian 时写 `obsidian-mcp-server`，彼此独立。只需保证 `knowledge-sources.json` 的 schema 用 `type` 字段可扩展。

## 分阶段实施

### Phase 1 — MVP：打通链路

1. **POC**：最小 IMA MCP Server（bun，实现 `search_knowledge` + `search_notes` + `list_knowledge_bases`）→ 手动注册到 opencode → 验证 AI 能调用
2. **IMA MCP Server 完整实现**：封装 P0 API（list_kbs、search_knowledge、search_notes）+ `bun build --compile`
3. **Settings → Knowledge tab**：IMA 凭证配置向导 + 测试连接 + 自动注册 MCP Server
4. **凭证持久化**：`~/.ultrawork/knowledge-sources.json`

### Phase 2 — 体验增强

- 右侧 Sidebar Knowledge panel（浏览知识库、手动搜索、结果来源标注）
- 更多 IMA API（读取笔记内容 `get_doc_content`、浏览文件夹 `get_knowledge_list`）

### Phase 3 — 多源扩展

- 加 Notion MCP Server（OAuth 2.0）
- 加 Obsidian MCP Server（本地文件访问）
- Settings Knowledge tab 支持多源添加

## 考虑过的替代方案

### 1. 自建统一 adapter 层

在 gateway 或新包中实现 `KnowledgeAdapter` 接口，每个知识源实现一个 adapter。

**未采用原因**：MCP 协议已经是标准化的 adapter 层，自建等于重新发明轮子。且 MCP 的优势是 AI 可通过 tool 自主调用，自建 adapter 还需要额外对接 AI 调用链路。

### 2. 前端直接调用 IMA API

从 Tauri webview 或通过 Tauri command 代理调用。

**未采用原因**：AI 在对话中无法自主使用；每次搜索需要前端中转，不如 MCP 直接。

### 3. 集成到现有 Services (MCP) tab

让用户在 Services tab 手动添加知识库 MCP Server。

**未采用原因**：对普通用户来说「连接 IMA 知识库」比「添加 MCP Server」更直觉。Knowledge tab 提供友好向导，底层仍走 MCP。

## 后果

### 正面

- AI 能自主搜索用户知识库，对话质量显著提升
- MCP 架构天然支持多知识源扩展，无需重构
- 与现有基础设施（MCP client、Settings UI、Sidebar）完全复用
- IMA 认证简单（API Key），用户配置成本低

### 负面

- 每个知识源多一个 MCP Server 进程（资源开销）
- IMA 凭证需要用户手动去网页生成（UX 摩擦，但无法绕过）
- MCP Server 编译打包增加构建复杂度

## 参考

- IMA OpenAPI 文档：`research/knowledge-base-research/kb-api.md`、`notes-api.md`
- 集成可行性分析：`research/knowledge-base-research/kb-api-sdk-integration-analysis.md`
- 全景调研报告：`research/knowledge-base-research/knowledge-base-research-report.md`
- IMA 凭证获取：`https://ima.qq.com/agent-interface`
