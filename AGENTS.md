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
| `@agent/acp-client` | ✅ 阶段1（claude/gemini/qoder 达标） | ACP Client Sidecar：spawn 外部 agent（stdio JSON-RPC）+ turn 整形成 opencode SSE 形状 + 权限回环 + 历史持久化, sidecar :4099 |
| `@agent/connector` | ✅ 阶段2（ADR-030） | 控制+事件统一层：可插拔 backend adapter（OpenCodeBackend/ACPBackend）+ 统一 SSE transport + 会话绑定（sidecar 持久化 hydration）+ capabilities 门控 |
| `@agent/orchestrator` | ✅ 阶段3 全量（ADR-031 + 017 Team 页） | 编排层：spawn/await/steer/cancel 原语 + 治理护栏 + DAG 调度（Pipeline/Fan-out 同一执行器）+ worktree 隔离 + agent 驱动 delegate（阻塞 D-2 契约）+ QueueOwner；宿主 = ACP sidecar :4099（`/orchestration/*` + team 注册表 + delegate-mcp stdio shim）；产品面 = `/orchestration` 两 tab（Team 协作 = Leader 会话委派默认化 / 流水线 recipe） |

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
│   │   ├── connector/src/       # Control+event unification layer (backends/, sse-transport, binding-store)
│   │   ├── orchestrator/src/    # Orchestration layer (primitives, pipeline, run-store; hosted by acp-client)
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
- `src/lib/sse-context.tsx` — ConnectorProvider（导出名仍 SSEProvider）：持有 Connector + useConnector/useSSESubscribe/useSessionSubscribe/useSSEConnected
- `src/lib/use-api.ts` — backend-specific REST 面：返回 connector 持有的 ApiClient（签名不变）
- `src/lib/use-session-messages.ts` — 消息状态 + SSE 处理 + 历史窗口 + 发送/停止（全部经 connector 按绑定派发，无 isACP 分流）
- `src/lib/use-session-permission.ts` — 权限/问题处理 + 轮询 fallback（capabilities.questions 门控）
- `src/lib/agent-context.tsx` — AgentProvider：agent 列表 + 绑定委托 connector.bindings + sidecar hydration
- `src/lib/use-session-scroll.ts` — 滚动管理（markAuto/isAuto + ResizeObserver）
- `src/lib/use-mcp-servers.ts` / `use-browser-mcp.ts` / `use-skills.ts` / `use-channels.ts` / `use-knowledge-base.ts`
- `src/lib/path-utils.ts`（shortenPath/pathBasename）、`src/lib/platform.ts`（isMacOS）

**Tauri 命令（`src-tauri/src/lib.rs`）**
- `open_file_with_system`（`open`）、`reveal_file_in_finder`（`open -R`）、`get_sidecar_credentials`、`rich_path()`（补 PATH）

**Gateway（`packages/channel/gateway/src/`）**
- `bridge.ts`, `channel-manager.ts`, `gateway-server.ts`, `session-store.ts`
- `adapters/wechat/` — ilink-api.ts（HTTP 客户端）, wechat-adapter.ts（ChannelAdapter）, types.ts（ilink 协议类型）

**Connector（`packages/core/connector/src/`，ADR-030）**
- `connector.ts` — 注册表 + 按会话绑定派发 + 双形态 subscribe（global / per-session 双流合并）+ deleteSession 三清
- `sse-transport.ts` — 参数化 fetch-reader（退避三策略 / 心跳看门狗 / gave-up 状态）——三套 SSE 收敛于此
- `binding-store.ts` — 会话↔agent 绑定：BindingCache 注入（desktop=localStorage）+ hydrate 合并（sidecar 优先 + dirty set 防竞态）
- `backends/opencode.ts` — 包装 createApiClient（⚠️ 必须工厂，bridge.test mock 依赖）+ 全局 /event 流；`.api` 暴露 backend-specific 面
- `backends/acp.ts` + `acp-http.ts` — acp-stdio 族通用 adapter：per-session SSE 引用计数池 + :4099 REST（原 desktop agent-router）

**Orchestrator（`packages/core/orchestrator/src/`，ADR-031 阶段3 全量）**
- `orchestrator.ts` — 原语（spawn/awaitTask/steer/cancelTask）+ recipe 层（createRun/cancelRun 中止全部在途）+ 治理（含 opencode 子会话 `orchestrator_*` tools deny）+ loadPersisted（重启标 interrupted）
- `turn.ts` — `runTurn` 双语义终态检测（opencode fire-and-forget 等 idle+finish 双信号；ACP 阻塞 prompt 即终态；超时/abort 先 cancel）⚠️ 编排新代码勿直接 await prompt 当完成
- `pipeline.ts` — DAG 执行器（inputs 满足即并行 = Pipeline/Fan-out 同一实现；失败跳传递性下游 + step.permission relay + 隐藏父会话 run 启动时建）；`artifacts.ts` — 产物路径约定 + prompt 契约
- `delegate.ts` — DelegateManager（阻塞 delegate → D-2 契约 `{deliverable,sessionId,tokens,cost}`；长驻隐藏父 `[delegates]`；ring buffer 50）
- `worktree.ts` — Fan-out worktree 隔离（create/remove/stageInputs/collectArtifact；`<xdgData>/ultrawork/worktrees/`）
- `session-queue.ts`（QueueOwner 实现）, `task-registry.ts`（Semaphore 排队语义 + 任务跟踪）, `run-store.ts`（JSON 落盘 `~/.local/share/ultrawork/orchestrator-runs/`）
- 宿主接线在 acp-client：`orchestration.ts`（组合根，per-workspace Connector + releaseConnector）, `orchestration-routes.ts`（9 端点）, `team-routes.ts`+`team-store.ts`（017 Team 会话注册表：隐藏 `[team]` 父懒建 + leader/twin 创建 + ACP leader 注入回滚 + `team-sessions.json` 持久化）, `delegate-mcp.ts`（stdio shim：delegate/list_agents + progress keepalive）, `inproc-acp-backend.ts`（直连 ACPManager，子会话恒 orchestrate:false）, `opencode-credentials.ts`
- Desktop：`pages/Orchestration.tsx`（两 tab 宿主：Team 协作 / 流水线，017）+ `components/orchestration/team-tab.tsx`（Leader 会话聊天面 + 创建卡 + 历史列表）+ `pipeline-tab.tsx`（Pipeline|Fan-out 模板 + 步骤级 model，原页面平移）+ `pages/OrchestrationRun.tsx`（依赖深度分层）+ `lib/orchestration-client.ts`（含 team sessions API）+ `lib/team-leader-prompt.ts`（Leader system 提示模板，017 §2.4）+ `lib/orchestrator-mcp.ts`（全局 MCP 静默 ensure，取代「编排模式」开关）+ `lib/use-child-session-history.ts`（懒加载语义共用）+ `components/chat/delegate-row.tsx`（delegate 卡片）+ `delegate-dock.tsx`（阻塞期权限）

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
