# Ultrawork - AI Quick Reference

## Project Overview

Ultrawork is a desktop-grade AI agent built on OpenCode's server capabilities.
Desktop App connects to OpenCode Server (sidecar), sends messages, and displays AI responses.
Channel Gateway bridges IM platforms (DingTalk, WeChat) to the same Agent backend.
Knowledge Sidecar provides local RAG + third-party (IMA) knowledge sources exposed to the Agent via MCP.

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
bun run typecheck        # Type check all packages (5)
bun run build:opencode   # Compile OpenCode sidecar binary
bun run build:gateway    # Compile Gateway sidecar binary
bun run build:knowledge  # Compile Knowledge sidecar binary
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

## Key Documentation

- [docs/architecture-phase1.md](./docs/architecture-phase1.md) — Phase 1 architecture design
- [docs/api-reference.md](./docs/api-reference.md) — OpenCode API findings
- [docs/conventions.md](./docs/conventions.md) — Development conventions & patterns
- [docs/decisions/](./docs/decisions/) — Architecture Decision Records (27 ADRs, 001–028 除 027)
- [docs/requirements.md](./docs/requirements.md) — Product requirements
- [docs/archive/progress-raw.md](./docs/archive/progress-raw.md) — Detailed development history
- [CHANGELOG.md](./CHANGELOG.md) — Version history
