# Ultrawork - AI Quick Reference

## Project Overview

Ultrawork is a desktop-grade AI agent built on OpenCode's server capabilities.
Desktop App connects to OpenCode Server (sidecar), sends messages, and displays AI responses.
Channel Gateway bridges IM platforms (DingTalk, WeChat) to the same Agent backend.
Knowledge Sidecar provides local RAG + third-party (IMA) knowledge sources exposed to the Agent via MCP.
ACP Client Sidecar drives external coding agents (Claude Code, …) via ACP and normalizes their output to the opencode SSE shape (ADR-027 档1, sessions bind one agent each).

## Architecture

- **Monorepo**: Bun workspaces + Turborepo
- **Desktop**: Tauri 2 + React 19 + Tailwind CSS 4
- **Backend**: OpenCode Server (headless, spawned as Tauri sidecar)
- **Gateway**: Channel Gateway (Hono + DingTalk Stream SDK, spawned as Tauri sidecar)
- **AI Provider**: OpenCode Zen (Big Pickle model, free) + 35+ paid models
- **Auth**: Basic Auth — sidecar 凭证首启随机生成（32 字节 hex），持久化 `~/.config/ultrawork/sidecar-auth.json` (0600)；`ULTRAWORK_SIDECAR_PASSWORD` env 可覆盖（CI/测试用）。详见 ADR-028

## Key Packages

| Package | Status | Description |
|---------|--------|-------------|
| `@agent/api-client` | ✅ Done | OpenCode REST/SSE TypeScript client |
| `@agent/server-manager` | ✅ Done | Process lifecycle management (spawn, health check, stop) |
| `@agent/client-desktop` | ✅ Done | Tauri desktop app (React 19 + Vite 7 + Tailwind 4) |
| `@agent/channel-gateway` | ✅ Done | IM channel gateway (DingTalk Stream SDK + WeChat ilink + Hono on Bun.serve, sidecar :4097) |
| `@agent/knowledge-sidecar` | ✅ Done | 本地 RAG 知识库 + 第三方平台 (IMA) adapter + MCP bridge, sidecar :4098 |
| `@agent/acp-client` | 🚧 阶段1（claude 达标） | ACP Client Sidecar：spawn 外部 agent（stdio JSON-RPC）+ turn 整形成 opencode SSE 形状 + 权限回环, sidecar :4099 |

## Project Structure

```
ultrawork/
├── packages/
│   ├── client/desktop/          # Tauri desktop app
│   │   ├── src/                 # React frontend (30+ components)
│   │   └── src-tauri/
│   │       ├── src/lib.rs       # Sidecar startup (OpenCode + Gateway)
│   │       ├── tauri.conf.json  # Tauri config with externalBin
│   │       └── binaries/        # Sidecar binaries (platform-specific)
│   ├── core/
│   │   ├── api-client/src/      # REST client for OpenCode API
│   │   └── server-manager/src/  # Process manager for OpenCode
│   ├── agent/
│   │   └── acp-client/src/      # ACP Client Sidecar (spawn external agents + turn shaping + permissions)
│   ├── channel/
│   │   └── gateway/src/         # Channel Gateway (bridge, DingTalk + WeChat adapters)
│   └── knowledge/
│       └── sidecar/src/         # Knowledge Sidecar (local RAG + IMA adapter + MCP bridge)
├── scripts/                     # Build scripts
├── vendor/opencode/             # OpenCode git submodule
├── docs/                        # Project documentation
│   ├── architecture-phase1.md   # Phase 1 system architecture
│   ├── api-reference.md         # OpenCode API details
│   ├── conventions.md           # Development conventions
│   ├── decisions/               # Architecture Decision Records
│   └── archive/                 # Historical reviews/summaries
└── design/                      # Product design & references
```

## Development Commands

```bash
bun install              # Install dependencies
bun run typecheck        # Type check all packages (6)
bun run build:opencode   # Compile OpenCode sidecar binary
bun run build:gateway    # Compile Gateway sidecar binary
bun run build:knowledge  # Compile Knowledge sidecar binary
bun run build:acp        # Compile ACP Client sidecar binary (kills stale :4099 on rebuild)
bun run tauri:dev        # Start desktop app in dev mode
bun run tauri:build      # Build production desktop app
bun run release          # Build Universal macOS DMG (dual-arch sidecars + lipo)
```

## OpenCode API Reference

```
POST /session              → Create session
GET  /session/:id          → Get session details
POST /session/:id/prompt_async → Send message (returns 204, async)
GET  /event                → SSE event stream (global)
GET  /config               → Get config
PATCH /config              → Update config (disk only, not runtime)
GET  /provider             → List providers + models
GET  /mcp                  → List MCP servers
GET  /file?path=           → File tree (relative paths + x-opencode-directory header)
```

- Auth: `Authorization: Basic base64(opencode:password)`
- Health: `GET /global/health`
- Model override: `prompt_async` `model` field `{ providerID, modelID }`

## Key Files (关键文件地图)

> main 分支文件。（旧 `feat/acp-support` 分支已被 `feat/agent-os-phase0` 的参考重写取代，ADR-027 B2。）

**Desktop — chat / session 组件**
- `src/components/chat/` — reasoning-block, tool-call-block, step-indicator, execution-status, model-selector, permission-dock, question-dock, command-selector, assistant-turn, execution-flow, message-parts
- `src/components/session/` — progress-panel, artifacts-panel, workspace-panel, artifact-preview, mcp-panel, skills-panel
- `src/components/ui/` — file-icon.tsx（彩色扩展名徽章）, logo.tsx（棱镜 SVG + useId 防冲突）
- `src/components/layout/drag-region.tsx` — handleDrag() + DragRegion 透明拖拽条
- `src/components/settings/model-dialog.tsx` — ModelDialog + AddProviderDialog
- `src/components/settings/agents-section.tsx` + `agent-templates.ts` — 外部 Agent CRUD 表单（预置模板 chips + thoughtLevel select）
- `src/components/knowledge/add-source-dialog.tsx` — 添加知识源对话框（类型 → IMA 凭证向导 → 测试 → 选库）

**Desktop — hooks / lib**
- `src/lib/sse-context.tsx` — SSEProvider + useSSESubscribe（全局单连接）
- `src/lib/use-session-messages.ts` — 消息状态 + SSE 处理 + 历史窗口 + 发送/停止（按会话绑定分流 opencode/ACP）
- `src/lib/use-session-permission.ts` — 权限/问题处理 + 轮询 fallback（ACP 走 sidecar 回复端点）
- `src/lib/agent-context.tsx` — AgentProvider：agent 列表 + 会话级绑定（localStorage）
- `src/lib/agent-types.ts` / `agent-router.ts` / `use-acp-sse.ts` — UnifiedAgent 类型 / :4099 HTTP client / 共享 EventSource 订阅
- `src/lib/use-session-scroll.ts` — 滚动管理（markAuto/isAuto + ResizeObserver）
- `src/lib/use-mcp-servers.ts` / `use-browser-mcp.ts` / `use-skills.ts` / `use-channels.ts` / `use-knowledge-base.ts`
- `src/lib/path-utils.ts`（shortenPath/pathBasename）、`src/lib/platform.ts`（isMacOS）

**Tauri 命令（`src-tauri/src/lib.rs`）**
- `open_file_with_system`（`open`）、`reveal_file_in_finder`（`open -R`）、`get_sidecar_credentials`、`rich_path()`（补 PATH）

**Gateway（`packages/channel/gateway/src/`）**
- `bridge.ts`, `channel-manager.ts`, `gateway-server.ts`, `session-store.ts`
- `adapters/wechat/` — ilink-api.ts（HTTP 客户端）, wechat-adapter.ts（ChannelAdapter）, types.ts（ilink 协议类型）

**ACP Client Sidecar（`packages/agent/acp-client/src/`）**
- `turn-shaper.ts` — 核心：ACP `session/update` → opencode N-message/回合整形（纯逻辑，可测）
- `acp-connection.ts` — 子进程 + SDK stdio + 权限挂起回环 + 三阶段关闭 + per-agent 怪癖（`applyGeminiQuirks` env 注入、spawn cwd/PATH、`applyThoughtLevel` → session/set_config_option）
- `permission-label.ts` — 权限标签分层推断（claude 丢 kind 的补救：kind → shaper 查表 → rawInput 形状 → title → 中性 "tool"）
- `acp-manager.ts`（连接/会话注册 + clientSessionId 映射 + SSE 分发 + session/load 懒恢复）, `acp-server.ts`（Hono :4099 REST+SSE）, `agents-config.ts`（`~/.config/ultrawork/agents.json`）
- `session-store.ts` — W4b 会话历史持久化：event-fold reducer（与前端同构）+ 落盘 `~/.local/share/ultrawork/acp-sessions/`
- `packages/agent/acp-client/scripts/mock-acp-agent.ts`（确定性测试 agent）, `packages/agent/acp-client/scripts/spike-claude.ts`（真实 claude → desktop fixture）

**Knowledge Sidecar（`packages/knowledge/sidecar/src/`）**
- `store.ts`（SQLite + FTS5 + 迁移）, `chunker.ts`（Parent-Child 分块）, `indexer.ts`（增量索引）, `retriever.ts`（BM25 + TF-IDF + RRF）
- `doc-parser.ts`（unpdf/mammoth/xlsx/jszip）, `watcher.ts`（fs.watch + debounce）, `mcp-bridge.ts`（knowledge_search/list_sources/save_note）
- `adapters/` — types.ts（KnowledgeAdapter 接口）, registry.ts, ima.ts, local-folder.ts

## Key Documentation

- [docs/architecture-phase1.md](./docs/architecture-phase1.md) — Phase 1 architecture design
- [docs/api-reference.md](./docs/api-reference.md) — OpenCode API findings（端点权威源 / SSOT）
- [docs/conventions.md](./docs/conventions.md) — Development conventions & patterns（正向模式）
- [docs/gotchas.md](./docs/gotchas.md) — 踩坑清单（反向陷阱 + 上游非直觉契约，SSOT）
- [docs/quality-gates.md](./docs/quality-gates.md) — 改动合入前的完成定义 / 质量门禁
- [docs/decisions/](./docs/decisions/) — Architecture Decision Records (31 ADRs, 001–031)
- [docs/requirements.md](./docs/requirements.md) — Product requirements
- [docs/archive/progress-raw.md](./docs/archive/progress-raw.md) — Detailed development history
- [CHANGELOG.md](./CHANGELOG.md) — Version history
