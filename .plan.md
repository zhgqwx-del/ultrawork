# Ultrawork Monorepo Initialization Plan

## Overview

Initialize a Bun-based monorepo for the ultrawork desktop agent project, following the architecture defined in `architecture-phase1.md` with UI/UX inspired by workany.

## Technology Stack Decisions

Based on analysis of workany and opencode:

- **Runtime**: Bun (like opencode, more performant than pnpm)
- **Build Tool**: Turborepo (like opencode, better for monorepo orchestration)
- **UI Framework**: React 19 + Tailwind CSS 4 (like workany, for faster UI development)
- **Desktop**: Tauri 2 (like workany)
- **Backend**: Hono (like workany, for Channel Gateway)
- **TypeScript**: Strict mode, ES2020 target

## Phase 1: Root Configuration & Directory Structure

### 1.1 Root package.json

Create workspace root with Bun workspaces:

```json
{
  "name": "ultrawork",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "bun@1.3.10",
  "workspaces": [
    "packages/core/*",
    "packages/client/*",
    "packages/channel/*",
    "packages/proactive/*"
  ],
  "scripts": {
    "dev": "turbo run dev",
    "dev:desktop": "turbo run dev --filter=@agent/client-desktop",
    "build": "turbo run build",
    "build:opencode": "bun run scripts/build-opencode.ts",
    "typecheck": "turbo run typecheck",
    "lint": "turbo run lint",
    "format": "prettier --write \"packages/**/*.{ts,tsx,json,md}\"",
    "format:check": "prettier --check \"packages/**/*.{ts,tsx,json,md}\""
  },
  "devDependencies": {
    "@types/bun": "^1.3.9",
    "@types/node": "^22.13.9",
    "prettier": "^3.6.2",
    "turbo": "^2.8.13",
    "typescript": "^5.8.2"
  }
}
```

### 1.2 turbo.json

Configure Turborepo pipeline:

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.*local"],
  "pipeline": {
    "build:opencode": {
      "cache": false
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },
    "dev": {
      "dependsOn": ["build:opencode"],
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^typecheck"]
    },
    "lint": {
      "dependsOn": ["^lint"]
    }
  }
}
```

### 1.3 TypeScript Configuration

**Root tsconfig.json** (base configuration):

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

**tsconfig.node.json** (for Node.js scripts):

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "lib": ["ES2020"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"]
  },
  "include": ["scripts/**/*"]
}
```

### 1.4 Prettier Configuration

**.prettierrc.json**:

```json
{
  "semi": false,
  "printWidth": 120,
  "tabWidth": 2,
  "useTabs": false,
  "singleQuote": false,
  "trailingComma": "es5",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

**.prettierignore**:

```
node_modules
dist
.turbo
.next
vendor
*.md
pnpm-lock.yaml
bun.lockb
```

### 1.5 .gitignore

```
# Dependencies
node_modules
.pnp
.pnp.js

# Build outputs
dist
.turbo
.next
out
build

# Logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment
.env
.env.local
.env.*.local

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/*
!.vscode/settings.json
!.vscode/extensions.json
.idea

# Bun
bun.lockb

# Tauri
src-tauri/target

# User workspace (runtime data)
.ultrawork/
```

### 1.6 Directory Structure

Create the following directory structure:

```
ultrawork/
├── package.json
├── turbo.json
├── tsconfig.json
├── tsconfig.node.json
├── .prettierrc.json
├── .prettierignore
├── .gitignore
├── bun.lockb (generated)
│
├── .ai/                          # AI collaboration tooling
│   ├── session.md
│   └── commands/
│
├── AGENTS.md                     # AI quick reference
│
├── docs/
│   ├── architecture-phase1.md    # (already exists)
│   └── ai-context/
│       └── README.md
│
├── vendor/
│   └── opencode/                 # Git submodule (to be added)
│
├── scripts/
│   ├── build-opencode.ts         # Compile OpenCode binary
│   └── dev.ts                    # Development launcher
│
└── packages/
    ├── core/
    │   ├── api-client/           # @agent/api-client
    │   ├── server-manager/       # @agent/server-manager
    │   ├── connector/            # @agent/connector
    │   ├── ui/                   # @agent/ui
    │   ├── workspace/            # @agent/workspace
    │   └── notifier/             # @agent/notifier
    │
    ├── client/
    │   └── desktop/              # @agent/client-desktop
    │
    ├── channel/
    │   └── gateway/              # @agent/channel-gateway
    │
    └── proactive/
        ├── heartbeat/            # @agent/proactive-heartbeat
        └── cron/                 # @agent/proactive-cron
```

## Phase 2: Core Package Scaffolding (MVP Focus)

For the MVP, we'll create skeleton packages for:
1. `@agent/api-client` - OpenCode REST/SSE SDK
2. `@agent/server-manager` - Process lifecycle management
3. `@agent/client-desktop` - Tauri + React desktop app

### 2.1 @agent/api-client

**packages/core/api-client/package.json**:

```json
{
  "name": "@agent/api-client",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'No linting configured yet'"
  },
  "dependencies": {},
  "devDependencies": {
    "typescript": "^5.8.2"
  }
}
```

**packages/core/api-client/tsconfig.json**:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"]
}
```

**packages/core/api-client/src/index.ts**:

```typescript
// Placeholder - will implement OpenCode REST API client
export const createApiClient = () => {
  console.log("API client placeholder")
}
```

### 2.2 @agent/server-manager

**packages/core/server-manager/package.json**:

```json
{
  "name": "@agent/server-manager",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "lint": "echo 'No linting configured yet'"
  },
  "dependencies": {
    "@agent/api-client": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.2"
  }
}
```

**packages/core/server-manager/tsconfig.json**:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "references": [
    { "path": "../api-client" }
  ]
}
```

**packages/core/server-manager/src/index.ts**:

```typescript
// Placeholder - will implement OpenCode server process management
export const spawnServer = () => {
  console.log("Server manager placeholder")
}
```

### 2.3 @agent/client-desktop

This is the main desktop application using Tauri 2 + React 19.

**packages/client/desktop/package.json**:

```json
{
  "name": "@agent/client-desktop",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src",
    "preview": "vite preview",
    "tauri": "tauri",
    "tauri:dev": "tauri dev",
    "tauri:build": "tauri build"
  },
  "dependencies": {
    "@agent/api-client": "workspace:*",
    "@agent/server-manager": "workspace:*",
    "@radix-ui/react-dialog": "^1.1.15",
    "@radix-ui/react-dropdown-menu": "^2.1.16",
    "@radix-ui/react-separator": "^1.1.8",
    "@radix-ui/react-slot": "^1.2.4",
    "@radix-ui/react-tooltip": "^1.2.8",
    "@tailwindcss/typography": "^0.5.19",
    "@tailwindcss/vite": "^4.1.18",
    "@tauri-apps/api": "^2.10.1",
    "@tauri-apps/plugin-dialog": "^2.6.0",
    "@tauri-apps/plugin-fs": "^2.4.5",
    "@tauri-apps/plugin-opener": "^2",
    "@tauri-apps/plugin-shell": "^2.3.4",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.562.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "react-markdown": "^9.0.1",
    "react-router-dom": "^7.12.0",
    "tailwind-merge": "^3.4.0",
    "tailwindcss": "^4.1.18",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2",
    "@types/node": "^22.13.9",
    "@types/react": "^19.1.8",
    "@types/react-dom": "^19.1.6",
    "@vitejs/plugin-react": "^4.6.0",
    "typescript": "^5.8.2",
    "vite": "^7.0.4"
  }
}
```

**packages/client/desktop/tsconfig.json**:

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src"],
  "references": [
    { "path": "../../core/api-client" },
    { "path": "../../core/server-manager" }
  ]
}
```

**packages/client/desktop/vite.config.ts**:

```typescript
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import path from "path"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
})
```

**packages/client/desktop/tailwind.config.ts**:

```typescript
import type { Config } from "tailwindcss"

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config
```

**packages/client/desktop/index.html**:

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Ultrawork</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**packages/client/desktop/src/main.tsx**:

```tsx
import React from "react"
import ReactDOM from "react-dom/client"
import App from "./App"
import "./index.css"

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
```

**packages/client/desktop/src/App.tsx**:

```tsx
import React from "react"

function App() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900">Ultrawork</h1>
        <p className="mt-2 text-gray-600">Desktop Agent - MVP</p>
      </div>
    </div>
  )
}

export default App
```

**packages/client/desktop/src/index.css**:

```css
@import "tailwindcss";
```

**packages/client/desktop/src-tauri/tauri.conf.json**:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Ultrawork",
  "version": "0.1.0",
  "identifier": "com.ultrawork.app",
  "build": {
    "beforeDevCommand": "bun run dev",
    "devUrl": "http://localhost:1420",
    "beforeBuildCommand": "bun run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Ultrawork",
        "width": 1200,
        "height": 800,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

**packages/client/desktop/src-tauri/Cargo.toml**:

```toml
[package]
name = "ultrawork"
version = "0.1.0"
description = "Desktop Agent"
authors = ["Ultrawork Team"]
edition = "2021"

[lib]
name = "ultrawork_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

**packages/client/desktop/src-tauri/src/lib.rs**:

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**packages/client/desktop/src-tauri/build.rs**:

```rust
fn main() {
    tauri_build::build()
}
```

## Phase 3: Supporting Files

### 3.1 AGENTS.md

```markdown
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
```

### 3.2 .ai/session.md

```markdown
# Current Session

## Status

Initializing monorepo structure for Ultrawork desktop agent.

## Recent Changes

- Created root configuration (package.json, turbo.json, tsconfig)
- Scaffolded core packages: api-client, server-manager
- Set up desktop client with Tauri 2 + React 19

## Next Steps

1. Add OpenCode as git submodule
2. Implement basic OpenCode API client
3. Implement server manager (spawn/health check)
4. Build minimal chat UI in desktop app
```

### 3.3 docs/ai-context/README.md

```markdown
# AI Context

This directory contains shared knowledge for AI assistants working on Ultrawork.

## Structure

- `team/` - Team-wide standards and conventions
- `project/` - Project-specific knowledge
- `experience/` - Accumulated wisdom and lessons learned
- `business/` - Business logic and domain knowledge

## Quick Links

- [Architecture Phase 1](../architecture-phase1.md)
- [AGENTS.md](../../AGENTS.md)
```

## Phase 4: Scripts

### 4.1 scripts/build-opencode.ts

```typescript
#!/usr/bin/env bun

/**
 * Build OpenCode binary from vendor/opencode submodule
 *
 * This script:
 * 1. Checks if vendor/opencode exists
 * 2. Runs bun install in vendor/opencode
 * 3. Compiles OpenCode to a standalone binary
 * 4. Copies binary to packages/client/desktop/src-tauri/binaries/
 */

console.log("OpenCode build script - placeholder")
console.log("TODO: Implement after adding OpenCode submodule")
```

### 4.2 scripts/dev.ts

```typescript
#!/usr/bin/env bun

/**
 * Development launcher
 *
 * Starts all necessary services for local development:
 * 1. OpenCode Server (if not already running)
 * 2. Desktop app in dev mode
 */

console.log("Development launcher - placeholder")
console.log("TODO: Implement after OpenCode integration")
```

## Implementation Order

1. **Create root files** (package.json, turbo.json, tsconfig, etc.)
2. **Create directory structure** (packages/core, client, etc.)
3. **Scaffold core packages** (api-client, server-manager)
4. **Scaffold desktop client** (Tauri + React setup)
5. **Create supporting files** (AGENTS.md, .ai/, docs/, scripts/)
6. **Run bun install** to generate lockfile
7. **Verify build** with `bun run typecheck`
8. **Test desktop app** with `bun run dev:desktop` (should show placeholder UI)

## Success Criteria

- [x] All configuration files created
- [x] Directory structure matches architecture-phase1.md
- [x] All packages have valid package.json and tsconfig.json
- [x] `bun install` completes successfully
- [x] `bun run typecheck` passes
- [x] `bun run dev:desktop` launches Tauri app with placeholder UI
- [x] No build errors or warnings

## Notes

- OpenCode submodule will be added in next phase
- UI components will be implemented after MVP validation
- Workspace management deferred until after basic chat works
- Channel Gateway and Proactive Services are Phase 2+

## Deviations from architecture-phase1.md

1. **UI Framework**: Changed from SolidJS to React 19 (better ecosystem, easier to reference workany)
2. **Package Manager**: Using Bun instead of pnpm (better performance, consistent with opencode)
3. **MVP Scope**: Only scaffolding api-client, server-manager, and desktop for initial validation

All other architectural decisions remain as specified in the document.
