# Ultrawork - AI Quick Reference

## Project Overview

Ultrawork is a desktop-grade AI agent built on OpenCode's server capabilities.

## Architecture

- **Monorepo**: Bun workspaces + Turborepo
- **Desktop**: Tauri 2 + React 19 + Tailwind CSS 4
- **Backend**: OpenCode Server (headless, spawned as sidecar)
- **Workspace**: ~/.ultrawork/ (user-level agent state)

## Key Packages

- `@agent/api-client` - OpenCode REST/SSE SDK
- `@agent/server-manager` - Process lifecycle management
- `@agent/connector` - Local/remote connection abstraction
- `@agent/workspace` - ~/.ultrawork/ directory management
- `@agent/client-desktop` - Tauri desktop application

## Development Commands

```bash
bun install              # Install dependencies
bun run dev:desktop      # Start desktop app in dev mode
bun run build            # Build all packages
bun run typecheck        # Type check all packages
```

## Current Phase

**Phase 1 - MVP**: Basic desktop app that can connect to OpenCode Server and chat.

See `docs/architecture-phase1.md` for full architecture details.
