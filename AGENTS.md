# Ultrawork - AI Quick Reference

## Project Overview

Ultrawork is a desktop-grade AI agent built on OpenCode's server capabilities.
Desktop App connects to OpenCode Server (sidecar), sends messages, and displays AI responses.

## Architecture

- **Monorepo**: Bun workspaces + Turborepo
- **Desktop**: Tauri 2 + React 19 + Tailwind CSS 4
- **Backend**: OpenCode Server (headless, spawned as Tauri sidecar)
- **AI Provider**: OpenCode Zen (Big Pickle model, free)
- **Auth**: Basic Auth (username: opencode, password via env var)

## Key Packages

| Package | Status | Description |
|---------|--------|-------------|
| `@agent/api-client` | ✅ Done | OpenCode REST API client (Basic Auth, session/message/events) |
| `@agent/server-manager` | ✅ Done | Process lifecycle management (spawn, health check, stop) |
| `@agent/client-desktop` | ✅ MVP Done | Tauri desktop app with chat UI |

### Packages Not Yet Implemented (Phase 2+)
- `@agent/connector` - Local/remote connection abstraction
- `@agent/workspace` - ~/.ultrawork/ directory management
- `@agent/ui` - Shared UI component library
- `@agent/notifier` - Notification dispatch
- `@agent/channel-gateway` - IM integrations (DingTalk/Feishu/Slack)

## Project Structure

```
ultrawork/
├── packages/
│   ├── client/desktop/          # Tauri desktop app
│   │   ├── src/App.tsx          # Main chat UI (uses @agent/api-client)
│   │   └── src-tauri/
│   │       ├── src/lib.rs       # Sidecar startup (OpenCode Server)
│   │       ├── tauri.conf.json  # Tauri config with externalBin
│   │       └── binaries/        # OpenCode binary (platform-specific)
│   ├── core/
│   │   ├── api-client/src/      # REST client for OpenCode API
│   │   └── server-manager/src/  # Process manager for OpenCode
├── scripts/
│   └── build-opencode.ts        # Compile OpenCode binary
├── vendor/opencode/             # OpenCode git submodule
└── docs/architecture-phase1.md  # Full architecture design
```

## Development Commands

```bash
bun install              # Install dependencies
bun run typecheck        # Type check all packages
bun run build:opencode   # Compile OpenCode binary for current platform
bun run tauri:dev        # Start desktop app in dev mode
bun run tauri:build      # Build production desktop app
```

## OpenCode API Reference

```
POST /session              → Create session (returns { id, slug, title, ... })
GET  /session/:id          → Get session details
POST /session/:id/message  → Send message { parts: [{ type: "text", text: "..." }] }
GET  /event                → SSE event stream (global, not per-session)
```

- Auth: `Authorization: Basic base64(opencode:password)`
- Password: via `OPENCODE_SERVER_PASSWORD` env var (not CLI arg)

## OpenCode Config

Located at `~/.config/opencode/opencode.json`:
```json
{
  "model": "opencode/big-pickle",
  "provider": {
    "opencode": {
      "options": {
        "apiKey": "your-zen-api-key"
      }
    }
  }
}
```

## Current Phase

**Phase 1 - MVP**: ✅ Complete
- Desktop app launches OpenCode Server as sidecar
- Chat UI with session creation, message send/receive
- Auto-scroll, loading states, connection retry

See `docs/architecture-phase1.md` for full architecture details.
See `PROGRESS.md` for detailed development history.
