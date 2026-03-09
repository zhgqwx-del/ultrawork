# Desktop Agent - Phase 1 Architecture Design

> **Implementation Status Note (2026-03-09)**
>
> 本文档是 Phase 1 的完整架构设计。截至 Round 12，**Desktop Client** 部分已全面实现（12 轮迭代，30+ 组件），其余模块仍为规划状态。
>
> **已实现 vs 规划对照：**
>
> | 模块 | 状态 | 说明 |
> |------|------|------|
> | Desktop Client (Tauri) | ✅ 已实现 | React 19 + Vite 7 + Tailwind 4（原设计为 SolidJS，实际采用 React） |
> | @agent/api-client | ✅ 已实现 | TypeScript SDK，REST + SSE |
> | @agent/server-manager | ✅ 已实现 | Sidecar spawn + health check |
> | @agent/connector | 🔲 规划中 | Desktop 当前直连 api-client，未经 connector 抽象 |
> | @agent/ui | 🔲 规划中 | 组件直接在 desktop/src/components 中，未抽为独立包 |
> | @agent/workspace | 🔲 规划中 | 工作区切换已用 `x-opencode-directory` header 实现，但 ~/.ultrawork/ 目录管理未实现 |
> | @agent/notifier | 🔲 规划中 | |
> | @agent/channel-gateway | 🔲 规划中 | |
> | @agent/proactive-heartbeat | 🔲 规划中 | |
> | @agent/proactive-cron | 🔲 规划中 | |
>
> **技术栈变更：**
> - UI 框架：SolidJS → **React 19**（文档中提到 SolidJS 的地方均应理解为 React）
> - 样式：TBD → **Tailwind CSS 4 + shadcn/ui (Radix primitives)**
> - 状态管理：SolidJS Context → **React Context** (SidebarProvider, SessionsProvider, ConfigProvider, ThemeProvider, I18nProvider, WorkspaceProvider, SSEProvider, ModelProvider)
> - 路由：**react-router-dom v7**
>
> 已实现功能详见 `REQUIREMENTS.md` 和 `PROGRESS.md`。

## Overview

A desktop-grade AI agent built on top of OpenCode's server capabilities. Phase 1 focuses on:

- **Desktop Client (Tauri)**: ✅ Full-featured desktop application as the primary platform
- **IM Channel Integrations**: 🔲 DingTalk, Feishu, Slack via Channel Gateway
- **Local/Remote Mode Operation**: ✅ (local) / 🔲 (remote) OpenCode running as sidecar (Desktop) or remote server (Channels)
- **Agent Workspace**: 🔲 Persistent identity, personality, and memory across sessions
- **Proactive Services**: 🔲 Background heartbeat monitoring and scheduled LLM tasks

Core strategy: use OpenCode as a **headless server** (compiled binary, spawned as sidecar or deployed remotely), and build the desktop client, channel gateway, and proactive services independently.

**Phase 1 Scope Exclusions:**
- Control Plane (centralized enterprise management)
- Context Awareness (environment sensing, browser extension)
- Web/Mobile clients
- Session Coordination Hub (cross-surface session continuity)

## System Architecture

![Phase 1 Architecture Overview](architecture-phase1.png)

Phase 1 implements a Data Plane instance with Desktop client and IM Channel integrations:

```
+=========================================================================+
|                         DATA PLANE (Phase 1)                            |
|                                                                         |
|  +-------------------------------------------------------------------+ |
|  |                   @agent/server-manager                           | |
|  |  - Spawns OpenCode binary as sidecar (Desktop)                    | |
|  |  - Health monitoring and crash recovery                           | |
|  +----------------------------+--------------------------------------+ |
|                               |                                        |
|  +----------------------------+--------------------------------------+ |
|  |                   OpenCode Server                                  | |
|  |                REST API + SSE Events                               | |
|  +---------+----------------+----------------+-----------------------+ |
|            |                |                |                         |
|  +---------+---------+  +---+------------+  +----------+----------+   |
|  |  Desktop App      |  |  Channel       |  |  Proactive          |   |
|  |  (Tauri + React)  |  |  Gateway       |  |  Services           |   |
|  |                   |  |  (Hono)        |  |  - Heartbeat        |   |
|  |  - Chat UI        |  |                |  |  - Cron             |   |
|  |  - Settings       |  |  - DingTalk    |  +---------------------+   |
|  |  - Workspace Mgr  |  |  - Feishu      |           |                |
|  +-------------------+  |  - Slack       |           |                |
|            |            +----------------+           |                |
|            |                   |                     |                |
|  +---------+-------------------+---------------------+---------+      |
|  |                     @agent/workspace                        |      |
|  |  - ~/.ultrawork/ directory management                       |      |
|  |  - IDENTITY.md, SOUL.md, MEMORY.md                          |      |
|  |  - Session context injection                                |      |
|  +-------------------------------------------------------------+      |
+=========================================================================+
            ^                    ^
            |                    |
     Desktop (local)      IM webhooks (remote)
```

## Integration Strategy

OpenCode is included as a **Git submodule** in `vendor/opencode`, tracking the `dev` branch.

- Each build compiles OpenCode into a standalone binary
- The binary is spawned as a sidecar process by Desktop (Tauri) or deployed as remote server
- Desktop client connects directly via REST + SSE (local mode)
- IM channels connect through the Channel Gateway (remote mode)
- Agent workspace provides persistent context across sessions

## Directory Structure

The monorepo uses a **two-level directory structure** focused on Phase 1 requirements.

### Module Overview

| Layer | Package | Functional Positioning |
|-------|---------|----------------------|
| **Core** | `@agent/api-client` | OpenCode Server SDK - Type-safe REST API calls and SSE event streaming. Foundation for all OpenCode communication. |
| | `@agent/server-manager` | Process Lifecycle Manager - Spawns OpenCode sidecar, monitors health, handles crash recovery with auto-restart. |
| | `@agent/connector` | Connection Abstraction - Unified interface for local/remote OpenCode connections. Handles mode selection, health checking, reconnection. 🔲 规划中，Desktop 当前直连 api-client |
| | `@agent/ui` | UI Component Library - Shared React components (chat, diff, markdown, dialogs) ensuring consistent UX. 🔲 规划中，当前组件在 desktop/src/components 内 |
| | `@agent/workspace` | Runtime Workspace Manager - Manages ~/.ultrawork/ directory in user's home. Handles IDENTITY.md, SOUL.md, MEMORY.md, HISTORY.md read/write and session context injection. Unified user-level storage for agent identity and memory. 🔲 规划中，工作区切换已用 x-opencode-directory header 实现 |
| | `@agent/notifier` | Notification Dispatcher - Outbound notification to multiple targets: desktop (Tauri), IM channels (DingTalk/Feishu/Slack webhooks), and file output. 🔲 规划中 |
| **Client** | `@agent/client-desktop` | ✅ Desktop Application - Full-featured Tauri app with local sidecar, React 19 + Vite 7 + Tailwind 4. |
| **Channel** | `@agent/channel-gateway` | 🔲 Round 13 规划完成 — IM Gateway Service. 独立 sidecar :4097, DingTalk Stream Mode (WebSocket), Bridge 会话桥接, Hono HTTP API. |
| **Proactive** | `@agent/proactive-heartbeat` | 🔲 Heartbeat Service - Independent background service. Periodically reads task/session state, uses LLM to summarize progress, updates HEARTBEAT.md, notifies users. |
| | `@agent/proactive-cron` | 🔲 Cron Service - Independent background service with HTTP API. Receives job definitions from Desktop UI or via IM channels, executes scheduled LLM tasks, delivers results via notifier. |

### Package Naming Convention

| Layer | Directory | Package Name Pattern | Example |
|-------|-----------|---------------------|---------|
| Core (shared) | `packages/core/*` | `@agent/<name>` | `@agent/api-client` |
| Client Apps | `packages/client/*` | `@agent/client-<name>` | `@agent/client-desktop` |
| Channels | `packages/channel/*` | `@agent/channel-<name>` | `@agent/channel-gateway` |
| Proactive | `packages/proactive/*` | `@agent/proactive-<name>` | `@agent/proactive-heartbeat` |

### Full Directory Tree

```
your-agent/
├── package.json                  # Workspace root (Bun workspaces)
├── turbo.json                    # Turborepo pipeline config
├── bun.lock
├── AGENTS.md                     # AI quick reference (onboarding handbook)
│
├── .ai/                          # AI collaboration tooling
│   ├── session.md                # Current session state (committed)
│   ├── handoff/                  # Historical handoff notes
│   ├── commands/                 # Shared custom AI commands
│   └── prompts/                  # Reusable prompt templates
│
├── vendor/
│   └── opencode/                 # Git submodule (tracking dev branch)
│
├── scripts/
│   ├── build-opencode.ts         # Compile vendor/opencode to binary
│   └── dev.ts                    # Local development launcher
│
├── docs/
│   ├── architecture.md           # Full system architecture
│   ├── architecture-phase1.md    # This file - Phase 1 architecture
│   └── ai-context/               # Shared AI knowledge base
│       ├── README.md             # Index and navigation guide
│       ├── team/                 # Team-wide standards
│       ├── project/              # Project-specific knowledge
│       ├── experience/           # Accumulated wisdom
│       └── business/             # Business logic
│
├── packages/
│   │
│   │  =============================================
│   │  core/ - Shared Foundation
│   │  =============================================
│   │
│   ├── core/
│   │   │
│   │   ├── api-client/           # @agent/api-client
│   │   │   │
│   │   │   │  [Functional Positioning]
│   │   │   │  TypeScript SDK for OpenCode Server REST API.
│   │   │   │  Provides type-safe API calls and SSE event streaming.
│   │   │   │  Foundation dependency for all modules communicating
│   │   │   │  with OpenCode. Independently publishable to npm.
│   │   │   │
│   │   │   ├── src/
│   │   │   │   ├── client.ts     #   REST call wrappers (session, message, permission)
│   │   │   │   ├── events.ts     #   SSE event subscription, parsing, reconnection
│   │   │   │   └── types.ts      #   Types auto-generated from OpenAPI spec
│   │   │   └── package.json
│   │   │
│   │   ├── server-manager/       # @agent/server-manager
│   │   │   │
│   │   │   │  [Functional Positioning]
│   │   │   │  OpenCode Server process lifecycle manager.
│   │   │   │  Responsible for spawning sidecar binary, health monitoring,
│   │   │   │  crash recovery with auto-restart.
│   │   │   │  Used internally by @agent/connector for local connections.
│   │   │   │
│   │   │   ├── src/
│   │   │   │   ├── spawn.ts      #   Start binary as child process / connect to existing
│   │   │   │   ├── health.ts     #   Periodic health check, crash detection, auto restart
│   │   │   │   └── config.ts     #   Runtime config: port, password, working directory
│   │   │   └── package.json
│   │   │
│   │   ├── connector/            # @agent/connector
│   │   │   │
│   │   │   │  [Functional Positioning] 🔲 规划中
│   │   │   │  Connection abstraction for OpenCode Server.
│   │   │   │  Supports both local (sidecar) and remote (network) modes:
│   │   │   │  - Local: Uses server-manager to spawn/manage binary
│   │   │   │  - Remote: Direct connection to existing server
│   │   │   │  Provides consistent interface for all clients.
│   │   │   │  Handles health checking and reconnection.
│   │   │   │  Default mode: local for Desktop, remote for Channel Gateway.
│   │   │   │  Integrates @agent/workspace for transparent context injection
│   │   │   │  and post-session fact extraction across all consumers.
│   │   │   │
│   │   │   ├── src/
│   │   │   │   ├── connector.ts  #   Main entry: createConnector(), mode detection
│   │   │   │   ├── local.ts      #   LocalConnection: wraps server-manager + api-client
│   │   │   │   ├── remote.ts     #   RemoteConnection: api-client with auth
│   │   │   │   ├── health.ts     #   Unified health checking for both modes
│   │   │   │   ├── reconnect.ts  #   Reconnection strategy with exponential backoff
│   │   │   │   ├── auth.ts       #   Remote authentication (API key, JWT)
│   │   │   │   ├── context.ts    #   Workspace context injection on session create
│   │   │   │   ├── hooks.ts      #   Session lifecycle hooks: onSessionEnd -> extractFacts
│   │   │   │   └── types.ts      #   ConnectionConfig, ConnectionStatus, Connection interface
│   │   │   └── package.json      #   deps: @agent/api-client, @agent/server-manager,
│   │   │                         #         @agent/workspace
│   │   │
│   │   ├── ui/                   # @agent/ui
│   │   │   │
│   │   │   │  [Functional Positioning] 🔲 规划中（当前组件在 desktop/src/components 内）
│   │   │   │  React UI component library for Desktop client.
│   │   │   │  Handles real-time SSE streaming display, code rendering,
│   │   │   │  and interactive dialogs. Theme-aware and responsive.
│   │   │   │
│   │   │   ├── src/
│   │   │   │   ├── chat/         #   Message list, input box, streaming text renderer
│   │   │   │   ├── diff/         #   File diff display with syntax highlighting
│   │   │   │   ├── permission/   #   Permission request confirmation dialog
│   │   │   │   └── markdown/     #   Markdown renderer with code block support
│   │   │   └── package.json
│   │   │
│   │   ├── workspace/            # @agent/workspace
│   │   │   │
│   │   │   │  [Functional Positioning] 🔲 规划中
│   │   │   │  Runtime workspace manager for ~/.ultrawork/ directory
│   │   │   │  in user's home. Unified user-level storage.
│   │   │   │  Handles:
│   │   │   │  - ~/.ultrawork/ directory creation on first launch
│   │   │   │  - opencode/ config scaffolding from bundled defaults
│   │   │   │  - IDENTITY.md and SOUL.md reading for system prompt
│   │   │   │  - MEMORY.md read/write with fact deduplication
│   │   │   │  - HISTORY.md append with rotation (monthly/weekly/size)
│   │   │   │  - Context bundle assembly for session initialization
│   │   │   │
│   │   │   ├── src/
│   │   │   │   ├── workspace.ts  #   Main entry: init ~/.ultrawork/, Workspace class
│   │   │   │   ├── config.ts     #   ULTRAWORK_DIR constant, WorkspaceConfig
│   │   │   │   └── index.ts      #   Exports
│   │   │   └── package.json
│   │   │
│   │   └── notifier/             # @agent/notifier
│   │       │
│   │       │  [Functional Positioning] 🔲 规划中
│   │       │  Unified outbound notification dispatcher.
│   │       │  Routes notification payloads to configured targets:
│   │       │  - Desktop system notifications (Tauri API)
│   │       │  - IM channels (DingTalk/Feishu/Slack incoming webhooks)
│   │       │  - File output (write to specified path)
│   │       │  Lightweight formatting per target.
│   │       │
│   │       ├── src/
│   │       │   ├── notifier.ts   #   Main entry: dispatch to configured targets
│   │       │   ├── types.ts      #   NotificationPayload, NotifyTarget, NotifyConfig
│   │       │   ├── targets/
│   │       │   │   ├── file.ts   #   Write notification to file
│   │       │   │   ├── session.ts #  Create/append to OpenCode session
│   │       │   │   ├── desktop.ts #  Tauri notification API / system notification
│   │       │   │   ├── dingtalk.ts # DingTalk incoming webhook (HTTP POST)
│   │       │   │   ├── feishu.ts #   Feishu incoming webhook (HTTP POST)
│   │       │   │   └── slack.ts  #   Slack incoming webhook (HTTP POST)
│   │       │   └── formatter.ts  #   Format payload per target (markdown variants)
│   │       └── package.json      #   deps: none (standalone, uses fetch for webhooks)
│   │
│   │  =============================================
│   │  client/ - Desktop Application
│   │  =============================================
│   │
│   ├── client/
│   │   │
│   │   └── desktop/              # @agent/client-desktop
│   │       │
│   │       │  [Functional Positioning] ✅ 已实现
│   │       │  Full-featured desktop application built with Tauri + React 19.
│   │       │  The primary client platform in Phase 1:
│   │       │  - Spawns OpenCode Server as sidecar process
│   │       │  - Native OS integration (opener plugin for external links)
│   │       │  - Workspace directory selection via x-opencode-directory header
│   │       │  - 8 React Contexts for state management
│   │       │
│   │       ├── src/              #   React 19 frontend
│   │       │   ├── App.tsx       #   Application root, routing setup
│   │       │   ├── pages/        #   Home, Session, Settings, WorkspaceSelector
│   │       │   ├── lib/          #   Contexts, hooks, utils (sse-context, config-context, etc.)
│   │       │   └── components/   #   chat/, session/, settings/, layout/, ui/
│   │       ├── src-tauri/        #   Rust backend for native capabilities
│   │       │   └── src/
│   │       │       ├── lib.rs    #     Tauri commands, sidecar spawn, IPC bridge
│   │       │       └── server.rs #     OpenCode health check, connection management
│   │       └── package.json      #   deps: @agent/api-client, @agent/ui,
│   │                             #         @agent/connector, @agent/workspace
│   │
│   │  =============================================
│   │  channel/ - IM Platform Integrations
│   │  =============================================
│   │
│   ├── channel/
│   │   │
│   │   └── gateway/              # @agent/channel-gateway
│   │       │
│   │       │  [Functional Positioning] 🔲 Round 13 规划完成，待实现
│   │       │  IM platform integration gateway service.
│   │       │  Bridges between IM platforms and OpenCode Server.
│   │       │
│   │       │  Round 13 架构决策 (2026-03):
│   │       │  - 独立 sidecar 进程 (bun build --compile, :4097)
│   │       │  - 与桌面端同生同死 (Tauri 托管)
│   │       │  - 钉钉优先: dingtalk-stream v2.1.4 WebSocket Stream Mode
│   │       │  - 无需公网 IP / ngrok
│   │       │
│   │       │  Handles:
│   │       │  - DingTalk Stream Mode WebSocket connection (not webhook)
│   │       │  - User-to-session mapping and lifecycle (Bridge pattern)
│   │       │  - Sequential Promise queue per session
│   │       │  - SSE event subscription for reply aggregation
│   │       │  - Permission auto-response, Question auto-reject
│   │       │  - Message format: Markdown via sessionWebhook
│   │       │
│   │       ├── src/
│   │       │   ├── index.ts      #   导出入口
│   │       │   ├── types.ts      #   ChannelConfig, ChannelStatus, ChannelAdapter 接口
│   │       │   ├── channel-manager.ts # Adapter 注册/生命周期管理
│   │       │   ├── gateway-server.ts  # Hono HTTP API (6 endpoints: CRUD + connect/disconnect)
│   │       │   ├── bridge.ts     #   OpenCode 会话桥接 (chatId→sessionId + Queue + SSE)
│   │       │   ├── adapters/
│   │       │   │   └── dingtalk/
│   │       │   │       ├── index.ts
│   │       │   │       ├── dingtalk-adapter.ts # DWClient 封装
│   │       │   │       ├── dingtalk-types.ts   # 钉钉消息结构
│   │       │   │       └── token-manager.ts    # access_token 缓存+刷新
│   │       │   └── adapters/     #   (预留: feishu/, slack/)
│   │       ├── tests/
│   │       │   └── channel-manager.test.ts
│   │       └── package.json      #   deps: @agent/api-client, dingtalk-stream, hono
│   │
│   │  =============================================
│   │  proactive/ - Background Services
│   │  =============================================
│   │
│   └── proactive/
│       │
│       ├── heartbeat/            # @agent/proactive-heartbeat
│       │   │
│       │   │  [Functional Positioning] 🔲 规划中
│       │   │  Independent background service that periodically
│       │   │  examines task/session state, interacts with OpenCode
│       │   │  using LLM to summarize progress and analyze status,
│       │   │  writes structured output to HEARTBEAT.md, and
│       │   │  notifies users via desktop notifications when notable
│       │   │  events occur (status changes, blockers, completions).
│       │   │  Default interval: 30 minutes. Configurable by user.
│       │   │
│       │   ├── src/
│       │   │   ├── heartbeat.ts  #   Main entry: timer loop, session inspection
│       │   │   ├── collector.ts  #   Gather session state, messages, tool usage from OpenCode
│       │   │   ├── analyzer.ts   #   LLM-powered summarization and status analysis
│       │   │   ├── writer.ts     #   HEARTBEAT.md file writer (atomic write, git-friendly)
│       │   │   └── config.ts     #   Interval, output path, notification targets, LLM model
│       │   └── package.json      #   deps: @agent/connector, @agent/notifier, @agent/workspace
│       │
│       └── cron/                 # @agent/proactive-cron
│           │
│           │  [Functional Positioning] 🔲 规划中
│           │  Independent background service with HTTP API.
│           │  Receives job definitions from Desktop UI (REST API calls).
│           │  Executes LLM-powered tasks on schedule:
│           │  - Fixed time, interval, or cron expressions
│           │  - Each task uses connector -> OpenCode -> LLM
│           │  Delivers results via @agent/notifier to configured targets.
│           │
│           ├── src/
│           │   ├── server.ts     #   HTTP API server: CRUD endpoints for jobs
│           │   ├── scheduler.ts  #   Cron engine, job registry, execution loop
│           │   ├── parser.ts     #   Parse cron expressions, intervals, fixed times
│           │   ├── executor.ts   #   Execute job: create session, send prompt, collect result
│           │   ├── jobs.ts       #   Job definition types, built-in job templates
│           │   ├── store.ts      #   Persist job definitions and execution history
│           │   └── config.ts     #   Max concurrent jobs, retry policy, notification targets
│           └── package.json      #   deps: @agent/connector, @agent/notifier
```

## Package Dependency Graph

```
                           DATA PLANE (Phase 1)

                +-------------------+
                | @agent/api-client |
                +---------+---------+
                          |
          +---------------+---------------+
          |                               |
+---------+---------+           +---------+---------+
|@agent/server-     |           |    @agent/ui      |
|manager            |           |                   |
+---------+---------+           +---------+---------+
          |                               |
          +------+                        |
                 |                        |
   +-------------+--------+              |
   |                       |              |
   |  +-------------------+|              |
   |  |@agent/workspace   ||              |
   |  +---------+---------+|              |
   |            |          |              |
   +------+-----+----+    |              |
          |           |    |              |
+---------+---------+ |    |              |
|@agent/connector   | |    |              |
|(+ context.ts,     | |    |              |
| hooks.ts)         | |    |              |
+--------+----------+ |    |              |
         |             |    |              |
  +------+------+------+---+---+----------+
  |             |              |
+-+--------+ +--+----------+ ++----------+------+
|@agent/   | |@agent/      | |@agent/client-    |
|channel-  | |notifier     | |desktop           |
|gateway   | +--+----------+ +------------------+
+----------+    |
                |
       +--------+-------+
       |                 |
+------+----------+ +---+---------------+
|@agent/proactive- | |@agent/proactive-  |
|heartbeat         | |cron               |
|(+ watchdog)      | |(+ HTTP API)       |
+------------------+ +------------------+

Note: Heartbeat and Cron use @agent/connector for all OpenCode
interactions, gaining automatic workspace context injection.
Heartbeat also directly imports @agent/workspace for HEARTBEAT.md writes.

- - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

                  PROACTIVE SERVICES

                             INBOUND                    OUTBOUND
                          (commands)                 (notifications)

Desktop (UI) ──(REST)───┐                    ┌───> Desktop (Tauri notification)
                        │                    │
Channels ──> Channel ──>│ OpenCode           ├───> Channels (IM webhooks)
(DingTalk,   Gateway    │ (LLM interprets,   │
 Feishu,                │  calls MCP tools)  ├───> Files (HEARTBEAT.md, reports/)
 Slack)        │        │        │           │
               │        v        v           │
               │  +-----+--------+------+    │
               │  |@agent/proactive-    |    │     +-------------------+
               │  |cron (HTTP API)      |────+────>|  @agent/notifier  |
               │  +----------+----------+    │     +-------------------+
               │             |               │
               │  +----------+----------+    │
               │  |@agent/proactive-    |────┘
               │  |heartbeat            |
               │  +----------+----------+
               │             |
               │  +----------+----------+
               └─>|@agent/connector     |  (all services use connector for OpenCode
                  |(workspace context)  |   + automatic workspace context injection)
                  +---------------------+
```

### Package Dependencies Table

| Package | Path | Functional Summary | Internal Dependencies |
|---------|------|-------------------|----------------------|
| `@agent/api-client` | `core/api-client` | ✅ OpenCode REST/SSE SDK, type-safe API calls | none |
| `@agent/server-manager` | `core/server-manager` | ✅ Sidecar lifecycle: spawn, health check, auto-restart (local only) | `@agent/api-client` |
| `@agent/connector` | `core/connector` | 🔲 Unified local/remote connection abstraction + workspace context injection + session lifecycle hooks | `@agent/api-client`, `@agent/server-manager`, `@agent/workspace` |
| `@agent/ui` | `core/ui` | 🔲 React component library: chat, diff, markdown, dialogs (当前在 desktop/src/components) | `@agent/api-client` |
| `@agent/workspace` | `core/workspace` | 🔲 Runtime ~/.ultrawork/ manager: identity, soul, memory, history, context assembly | none |
| `@agent/notifier` | `core/notifier` | 🔲 Outbound notification dispatcher: desktop, IM webhooks, file | none (standalone) |
| `@agent/client-desktop` | `client/desktop` | ✅ Tauri + React 19 app: full-featured, local sidecar | `@agent/api-client`, `@agent/server-manager` |
| `@agent/channel-gateway` | `channel/gateway` | 🔲 Round 13 规划完成: DingTalk Stream Mode + Bridge + Hono API | `@agent/api-client` (直接复用，不依赖 connector) |
| `@agent/proactive-heartbeat` | `proactive/heartbeat` | 🔲 Background service: periodic LLM-powered progress summary + server watchdog | `@agent/connector`, `@agent/notifier`, `@agent/workspace` |
| `@agent/proactive-cron` | `proactive/cron` | 🔲 Background service with HTTP API: scheduled LLM tasks, MCP tools | `@agent/connector`, `@agent/notifier` |

### Workspace Configuration

```jsonc
// package.json (root)
{
  "name": "agent-monorepo",
  "private": true,
  "workspaces": [
    "packages/core/*",
    "packages/client/*",
    "packages/channel/*",
    "packages/proactive/*"
  ]
}
```

## Data Flow

![Phase 1 Data Flow](architecture-phase1-dataflow.png)

### Connection Establishment (via @agent/connector)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Connection Flow (Local Mode)                      │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  createConnector({ mode: "local" })                                     │
│       │                                                                  │
│       ├──► server-manager.spawn()     → Start OpenCode binary           │
│       │         │                                                        │
│       │         └──► health.waitReady()  → Wait for server ready        │
│       │                                                                  │
│       └──► api-client.create(localUrl)  → Create SDK instance           │
│                 │                                                        │
│                 └──► Return Connection { client, status, ... }          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Connector API

```typescript
// @agent/connector/src/types.ts

interface ConnectionConfig {
  mode: "local" | "remote"
  
  // Local mode options (Desktop)
  local?: {
    binary?: string           // Path to opencode binary (default: auto-detect)
    workingDir?: string       // Project directory (default: cwd)
    port?: number             // Server port (default: auto-assign)
    autoRestart?: boolean     // Restart on crash (default: true)
  }
  
  // Remote mode options (Channel Gateway)
  remote?: {
    baseUrl: string           // e.g., "https://agent.company.com"
    apiKey?: string           // API key authentication
    jwt?: string              // JWT token authentication
    timeout?: number          // Connection timeout (default: 30000ms)
  }
  
  // Common options
  healthCheckInterval?: number  // Health check interval (default: 5000ms)
  reconnect?: {
    enabled: boolean          // Auto-reconnect on disconnect (default: true)
    maxRetries?: number       // Max retry attempts (default: Infinity)
    backoff?: "linear" | "exponential"  // Backoff strategy (default: exponential)
  }
}

interface Connection {
  readonly client: ApiClient           // OpenCode API client
  readonly status: ConnectionStatus    // Current connection status
  readonly mode: "local" | "remote"    // Active connection mode
  
  connect(): Promise<void>             // Establish connection
  disconnect(): Promise<void>          // Close connection
  reconnect(): Promise<void>           // Force reconnection
  
  onStatusChange(cb: (status: ConnectionStatus) => void): () => void
  onError(cb: (error: ConnectionError) => void): () => void
}

type ConnectionStatus = 
  | { state: "disconnected" }
  | { state: "connecting" }
  | { state: "connected"; serverVersion: string }
  | { state: "reconnecting"; attempt: number }
  | { state: "error"; error: ConnectionError }
```

### Connection Mode by Client

| Client | Default Mode | Notes |
|--------|-------------|-------|
| Desktop | `local` | Spawns OpenCode as sidecar |
| Channel Gateway | `remote` | Connects to shared/deployed server |

### Connector Usage Example

```typescript
// Desktop App - Local mode
const conn = createConnector({
  mode: "local",
  local: {
    workingDir: "/path/to/project",
    autoRestart: true
  }
})
await conn.connect()

// Use API after connection
const session = await conn.client.sessionCreate()
await conn.client.sessionPrompt(session.id, { ... })
```

### Desktop Client Flow

```
App startup
  -> createConnector({ mode: "local" })
    -> conn.connect()
      -> Connection established
  -> Load workspace context

User input
  -> conn.client.sessionPrompt(sessionId)
    -> OpenCode Server
      -> SSE Stream response
        -> api-client.events.subscribe()
          -> ui renders chunks in real time

If permission requested:
  -> ui/permission dialog
    -> api-client.permissionReply()

Session end
  -> workspace.extractFacts(session.messages)
    -> workspace.appendMemory(newFacts)
    -> workspace.appendHistory(sessionSummary)
```

### IM Channels Flow (DingTalk / Feishu / Slack)

```
Gateway startup
  -> createConnector({ mode: "remote", remote: { baseUrl, apiKey } })
    -> conn.connect()

User sends message in DingTalk (IM)
  -> dingtalk-stream WebSocket (Stream Mode, no public IP needed)
    -> channel-gateway DingTalk adapter receives
      -> bridge: find/create session for chatId (senderId or "group:"+conversationId)
        -> sequential queue: conn.client.promptAsync(sessionId)
          -> stream-buffer collects SSE stream
            -> renderer formats (card / markdown downgrade)
              -> adapter.send()
                -> IM platform API
                  -> User sees response

If permission requested:
  -> renderer creates interactive card
    -> IM platform sends card
      -> User taps approve/deny
        -> gateway receives callback
          -> api-client.permissionReply()
```

## Agent Workspace

The Agent Workspace is a **runtime product feature** -- when the built software runs, it manages a `~/.ultrawork/` directory in the user's home that persists identity, personality, memory, and status across sessions. This is a **unified user-level directory**, not per-project.

### Directory Layout

```
~/.ultrawork/                          # User's home directory
├── config.json                        #   Global settings, version info
├── IDENTITY.md                        #   Who the agent is (factual identity)
├── SOUL.md                            #   How the agent behaves (personality & style)
├── MEMORY.md                          #   Long-term factual memory (with dedup)
├── HISTORY.md                         #   Chronological event log (rotated)
├── credentials/                       #   API keys, tokens (gitignored)
├── cache/                             #   Session cache, history archives
│   └── HISTORY.2026-02-01.md          #   Archived history (rotated)
└── opencode/
    └── config.json                    #   OpenCode configuration
```

### Why Unified User-Level Directory?

The Desktop Agent is a **personal assistant** tied to the user, not to specific projects:

1. **One user = one identity** - The agent's personality doesn't change per project
2. **Unified memory** - Facts learned in project A should be available when working on project B
3. **Simpler UX** - No confusion about "which directory am I reading from"
4. **Works with IM channels** - DingTalk/Feishu messages aren't project-bound

### Workspace Initialization

On first application launch:

```
Desktop app starts
  |
  v
@agent/workspace checks ~/.ultrawork/
  |
  v
Does ~/.ultrawork/ exist?
  |
  ├── No  -> Full initialization:
  │         1. Create ~/.ultrawork/ directory
  │         2. Create config.json with version info
  │         3. Create IDENTITY.md with default template
  │         4. Create SOUL.md with default template
  │         5. Create MEMORY.md and HISTORY.md with headers
  │         6. Create cache/, credentials/, opencode/ subdirectories
  │         7. Create opencode/config.json with defaults
  │
  └── Yes -> Verify structure integrity, create missing files with defaults
  |
  v
Workspace ready. Load context for session.
```

### File Specifications

#### IDENTITY.md -- Agent Identity (Factual)

Defines **who** the agent is -- factual, stable attributes.

```markdown
# Identity

## Profile
- **Name**: Atlas
- **Role**: Senior full-stack engineer
- **Team**: Platform Engineering

## Expertise
- **Primary Languages**: TypeScript, Rust, Go
- **Frameworks**: SolidJS, Hono, Tauri
- **Domains**: Real-time systems, API design, database optimization
```

#### SOUL.md -- Agent Personality & Style

Defines **how** the agent behaves -- personality traits, communication style.

```markdown
# Soul

## Personality
- Concise and direct; avoid unnecessary preamble
- Prefer working code over lengthy explanations
- Challenge assumptions when you spot design flaws

## Communication Style
- Use technical terminology without simplification
- When suggesting changes, show diffs not descriptions
- Ask clarifying questions before making large refactors

## Work Approach
- Read existing code before proposing changes
- Favor minimal, focused changes over sweeping refactors
- Run tests after every modification

## Boundaries
- Never commit directly to main branch
- Always run tests before declaring a task complete
- Flag security-sensitive changes for human review
```

#### HEARTBEAT.md -- Periodic Status Snapshot

Written by `@agent/proactive-heartbeat` on a schedule.

```markdown
# Heartbeat

> Auto-generated by agent. Do not edit manually.
> Last updated: 2026-03-02T14:30:00Z

## Status: In Progress

## Active Sessions

### feature/auth-flow (session-abc123)
- **State**: Working
- **Summary**: Implementing JWT token refresh. Middleware interceptor done.
- **Recent Tools**: Write(src/auth/refresh.ts), Bash(bun test)
- **Test Results**: 42 passed, 2 failing

## Since Last Heartbeat (14:00 -> 14:30)
- Completed: Auth middleware integration
- In Progress: Token storage layer
- Issues: 2 test failures in expiry edge cases
```

#### MEMORY.md -- Long-term Factual Memory

Distilled knowledge the agent has learned across all projects and sessions.

```markdown
# Memory

> Agent-managed long-term memory. Auto-updated at session end.
> Facts are deduplicated and consolidated periodically.

## Project Facts
- Database: PostgreSQL 15 with row-level security enabled
- CI requires Node 20 (not 22); see .github/workflows/ci.yml
- The `utils/` directory is deprecated; use `lib/` for new utilities

## User Preferences
- Prefers functional style over class-based components
- Wants explicit error types, not string error messages

## Codebase Patterns
- All API routes follow the pattern: src/api/v1/<resource>/route.ts
- Database queries use Drizzle ORM; raw SQL only in migrations

## Gotchas & Pitfalls
- The `session` table has a unique constraint on (user_id, slug)
- File watcher in dev mode triggers double rebuilds; debounce with 200ms delay
```

#### HISTORY.md -- Chronological Event Log

A timeline of significant agent actions and discoveries.

```markdown
# History

> Chronological event log. Append-only. Rotated periodically.
> Each entry includes timestamp and summary of actions taken.

## 2026-03-02T14:30:00Z
Auth middleware integration complete
- Implemented JWT refresh token rotation in src/auth/refresh.ts
- 2 tests still failing (edge cases in token expiry)

## 2026-03-02T09:15:00Z
Database migration v4 applied
- Added `refresh_token` column to `sessions` table
```

### Workspace Integration Model

`@agent/workspace` is a **library** (not a service or process). Rather than each consumer independently loading context, workspace context flows through `@agent/connector` as the centralized integration point. All consumers already use `connector` to talk to OpenCode Server, so workspace context injection and fact extraction happen at the connector level.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                  Workspace Context Integration (Option C)                 │
│                                                                           │
│            ┌─────────────┐                                               │
│            │  @agent/     │──── loadContext() ────┐                       │
│            │  workspace   │                       │                       │
│            │  (library)   │◄── appendMemory() ────┤                       │
│            │              │◄── appendHistory() ───┤                       │
│            └──────┬───────┘                       │                       │
│                   │ file I/O (flock)              │                       │
│                   v                               │                       │
│            ~/.ultrawork/                          │                       │
│            ├── IDENTITY.md                        │                       │
│            ├── SOUL.md                  ┌─────────┴──────────┐           │
│            ├── MEMORY.md                │  @agent/connector   │           │
│            └── HISTORY.md               │  (integration hub)  │           │
│                                         │                     │           │
│                                         │  sessionCreate():   │           │
│                                         │   1. loadContext()   │           │
│                                         │   2. inject system   │           │
│                                         │      prompt          │           │
│                                         │                     │           │
│                                         │  onSessionEnd():    │           │
│                                         │   1. extractFacts() │           │
│                                         │   2. appendMemory() │           │
│                                         │   3. appendHistory()│           │
│                                         └──────────┬──────────┘           │
│                                                    │                      │
│                        ┌───────────────────────────┼──────────────┐       │
│                        │                           │              │       │
│                   Desktop App             Channel Gateway   Proactive     │
│                   (local mode)            (remote mode)     Services      │
│                                                                           │
│  Desktop UI also writes directly to workspace files for user settings:   │
│  - Update IDENTITY.md (agent name, role, expertise)                      │
│  - Update SOUL.md (personality, communication style)                     │
│  - Review/edit MEMORY.md (manual curation)                               │
│  These are user-initiated, single-writer, no concurrency concern.        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why this approach works:**

| Consumer | Connector Mode | How it gets workspace context |
|----------|---------------|-------------------------------|
| Desktop App | `local` | Connector calls `workspace.loadContext()` locally, injects into session |
| Channel Gateway | `remote` | Connector on server side injects context; gateway gets it via session |
| Heartbeat | `local` | Same connector; context injected into analysis session |
| Cron | `local` | Same connector; context injected into job session |

**Concurrency model:**

- `loadContext()` is read-only, safe for parallel callers
- `appendMemory()` and `appendHistory()` use advisory file locks (`flock`) to serialize writes
- Desktop UI writes (IDENTITY.md, SOUL.md edits) are user-initiated and single-writer by nature
- Heartbeat writes to HEARTBEAT.md exclusively (no other writer)

### Read/Write Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     Session Lifecycle                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                   │
│  SESSION START (handled by @agent/connector)                     │
│  1. connector intercepts sessionCreate()                         │
│  2. connector calls workspace.loadContext():                     │
│     - Read IDENTITY.md -> agent identity for system prompt       │
│     - Read SOUL.md     -> personality/style for system prompt    │
│     - Read MEMORY.md   -> relevant facts for context             │
│     - Read HISTORY.md  -> recent events for temporal context     │
│  3. connector injects context bundle as system prompt prefix     │
│  4. connector forwards to OpenCode session creation              │
│  5. All consumers (Desktop, Gateway, Proactive) get this         │
│     behavior automatically -- no per-consumer logic needed       │
│                                                                   │
│  DURING SESSION                                                   │
│  6. @agent/proactive-heartbeat may update HEARTBEAT.md           │
│     (independent timer, not tied to session)                     │
│                                                                   │
│  SESSION END (handled by @agent/connector)                       │
│  7. connector detects session completion                         │
│  8. connector calls workspace.extractFacts(session.messages):    │
│     -> LLM extracts new facts, preferences, patterns, gotchas   │
│  9. connector calls workspace.appendMemory(newFacts)             │
│     -> Deduplicates against existing entries (with flock)        │
│  10. connector calls workspace.appendHistory(sessionSummary)     │
│     -> Structured event entry with timestamp (with flock)        │
│                                                                   │
│  PERIODIC (via @agent/proactive-cron)                            │
│  11. Memory consolidation: LLM merges duplicates in MEMORY.md   │
│  12. History rotation: archive on size/date boundary             │
│                                                                   │
│  DESKTOP UI (direct file writes)                                 │
│  13. User edits IDENTITY.md via settings page -> direct write    │
│  14. User edits SOUL.md via settings page -> direct write        │
│  15. User reviews/curates MEMORY.md -> direct write              │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

```typescript
interface WorkspaceConfig {
  root: string                      // ~/.ultrawork/ path (default: os.homedir()/.ultrawork)

  identity: {
    enabled: boolean                // Include identity in sessions (default: true)
  }

  soul: {
    enabled: boolean                // Inject personality into sessions (default: true)
    maxPromptLength: number         // Truncate if too long (default: 2000 chars)
  }

  memory: {
    enabled: boolean                // Enable memory read/write (default: true)
    extractOnSessionEnd: boolean    // Auto-extract facts after session (default: true)
    maxFileSize: number             // Max MEMORY.md size (default: 100KB)
  }

  history: {
    enabled: boolean                // Enable event logging (default: true)
    rotationPolicy: "monthly" | "weekly" | "size"
    maxSizeBytes: number            // Max size before rotation (default: 1MB)
    maxArchives: number             // Keep N archived history files (default: 6)
  }

  opencode: {
    enabled: boolean                // Scaffold opencode/ config (default: true)
  }
}
```

## Proactive Services Layer

Proactive Services are **independent background services** that autonomously initiate LLM interactions on a schedule.

### Design Principles

1. **Independent Services** - Each proactive service runs as its own process
2. **Token-Cost Aware** - Every scheduled LLM call costs tokens; services provide clear cost visibility
3. **Non-Intrusive** - Results are written to files and/or pushed as notifications
4. **Configurable** - Users control intervals, schedules, notification targets
5. **Resilient** - Gracefully handle OpenCode unavailability

### Heartbeat Service

Independent background service that periodically inspects session state, uses LLM to produce a structured progress summary, and writes it to `.agent/HEARTBEAT.md`.

#### Execution Flow

```
Timer fires (every N minutes, default 30)
  |
  v
Collector: query OpenCode API
  - List active sessions
  - Get recent messages per session
  - Get tool execution history
  |
  v
Analyzer: send collected state to LLM
  - Summarize what was accomplished
  - Identify current task status
  - Flag potential issues
  - Determine notification urgency
  |
  v
Writer: update .agent/HEARTBEAT.md
  - Atomic write (write to temp, rename)
  - Git-friendly format
  |
  v
Notifier: push to configured targets (if notable/urgent)
  - Normal: file only
  - Notable: file + desktop notification
  - Urgent: file + desktop notification (high priority)
```

#### Configuration

```typescript
interface HeartbeatConfig {
  enabled: boolean               // Master switch (default: true)
  interval: number               // Minutes between heartbeats (default: 30)
  output: string                 // Output file path (default: ".agent/HEARTBEAT.md")
  model?: string                 // LLM model for analysis
  notify: NotifyConfig           // Notification configuration
}
```

### Cron Service

Independent background service with HTTP API that manages and executes scheduled LLM-powered tasks.

#### HTTP API

```
POST   /api/jobs          Create a new cron job
GET    /api/jobs          List all jobs (with status)
GET    /api/jobs/:id      Get job details
PUT    /api/jobs/:id      Update job definition
DELETE /api/jobs/:id      Delete a job
POST   /api/jobs/:id/run  Trigger immediate execution
GET    /api/history       List execution history
```

#### Schedule Types

| Type | Format | Example |
|------|--------|---------|
| Cron expression | Standard 5-field cron | `0 9 * * 1-5` (weekdays at 9:00) |
| Interval | Duration string | `2h` (every 2 hours) |
| Fixed time | ISO time | `09:00` (daily at 9:00 local time) |

#### Job Definition

```typescript
interface CronJob {
  id: string
  name: string                     // Human-readable name
  schedule: CronSchedule           // When to execute
  prompt: string                   // The prompt to send to OpenCode
  agent?: string                   // Agent to use (default: "build")
  output: JobOutput                // How to deliver results
  notify?: NotifyConfig            // Notification targets
  enabled: boolean                 // Enable/disable toggle
  maxRetries: number               // Retry on failure (default: 1)
  timeout: number                  // Max execution time in ms
}
```

#### Built-in Job Templates

| Template | Purpose | Default Schedule |
|----------|---------|-----------------|
| `dependency-check` | Scan for outdated/vulnerable dependencies | Weekly (Mon 9:00) |
| `code-review` | Review uncommitted changes for issues | Daily (18:00) |
| `test-health` | Run tests and summarize failures | Every 4 hours |
| `progress-report` | Generate progress summary from git log | Weekly (Fri 17:00) |

## Key OpenCode Server APIs

A conversation client needs approximately 8 endpoints:

| Endpoint              | Purpose                          |
|-----------------------|----------------------------------|
| `session.create`      | Create a new session             |
| `session.prompt`      | Send message (returns SSE stream)|
| `session.messages`    | Get message history              |
| `session.list`        | List sessions                    |
| `session.abort`       | Abort current generation         |
| `permission.reply`    | Respond to permission request    |
| `question.reply`      | Answer agent question            |
| `event.subscribe`     | Subscribe to SSE event stream    |

Full API spec available at `http://localhost:4096/doc` when server is running.

## Build Pipeline

```jsonc
// turbo.json
{
  "pipeline": {
    "build:opencode": {},
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "dependsOn": ["build:opencode"],
      "persistent": true
    }
  }
}
```

```jsonc
// package.json (root)
{
  "workspaces": ["packages/*"],
  "scripts": {
    "build:opencode": "bun run scripts/build-opencode.ts",
    "dev:desktop": "turbo run dev --filter=desktop",
    "dev:gateway": "turbo run dev --filter=channel-gateway",
    "build": "bun run build:opencode && turbo run build",
    "update:opencode": "cd vendor/opencode && git pull origin dev && cd ../.. && bun run build:opencode"
  }
}
```

## Updating OpenCode

```bash
# 1. Pull latest
cd vendor/opencode && git fetch origin dev && git checkout dev && git pull

# 2. Rebuild binary
cd ../.. && bun run build:opencode

# 3. Regenerate types if API changed
curl http://localhost:4096/doc > packages/api-client/openapi.json
bunx openapi-typescript packages/api-client/openapi.json -o packages/api-client/src/types.ts

# 4. Verify compatibility
turbo run test
```

## Deployment Topology

### Local Development

```
localhost:4096  ->  OpenCode Server
localhost:4097  ->  Channel Gateway (optional)
Desktop App     ->  Tauri (embedded sidecar on random port)
```

### Production

```
+-------------------------------------------------------------------------+
|  Employee Desktop                        |  Shared Server (Team)        |
|  +-------------------+                   |  +------------------------+  |
|  |  Desktop App      |                   |  |  OpenCode Server       |  |
|  |  +-------------+  |                   |  +------------------------+  |
|  |  |OpenCode     |  |                   |            ^                 |
|  |  |Server       |  |                   |            |                 |
|  |  +-------------+  |                   |  +------------------------+  |
|  +-------------------+                   |  |  Channel Gateway       |  |
|                                          |  +------------------------+  |
|                                          |            ^                 |
|                                          |            | webhooks        |
|                                          |  +--------+--------+         |
|                                          |  | DingTalk/Feishu |         |
|                                          |  +-----------------+         |
+-------------------------------------------------------------------------+
```

## Process Lifecycle Model

### Overview

The system adopts a **detach-on-exit** strategy: the Desktop App spawns OpenCode Server as a sidecar, but **detaches** it on exit instead of killing it. This allows proactive services (heartbeat, cron) and the Channel Gateway to continue operating after the desktop window is closed. On the next launch, the desktop discovers the existing server and reconnects.

### Process Classification

| Process | Lifecycle | Managed By |
|---------|-----------|------------|
| Desktop App (Tauri) | **Ephemeral** -- starts/stops with user interaction | OS / user |
| OpenCode Server | **Resident** -- survives desktop exit, reattached on next launch | `server-manager` + process registry |
| Heartbeat Service | **Resident** -- independent background process | self-managed, reads process registry |
| Cron Service | **Resident** -- independent background process with HTTP API | self-managed, reads process registry |
| Channel Gateway | **Resident** -- standalone service for IM webhooks | deployed independently (production) |

### Process Registry

All managed processes register in `~/.ultrawork/daemon.json`. This is the single source of truth for process discovery.

```jsonc
// ~/.ultrawork/daemon.json
{
  "version": 1,
  "opencode": {
    "pid": 12345,
    "port": 4096,
    "password": "auto-generated-secret",
    "workingDir": "/Users/alice/projects/my-app",
    "startedAt": "2026-03-02T10:00:00Z",
    "startedBy": "desktop"           // "desktop" | "cli" | "proactive"
  },
  "heartbeat": {
    "pid": 12350,
    "startedAt": "2026-03-02T10:00:05Z"
  },
  "cron": {
    "pid": 12355,
    "port": 4097,
    "startedAt": "2026-03-02T10:00:05Z"
  }
}
```

File locking: all writes to `daemon.json` use advisory file lock (`flock`) to prevent race conditions between desktop and proactive services.

### Desktop Startup Flow

```
Desktop app launches
  |
  v
server-manager reads ~/.ultrawork/daemon.json
  |
  ├── Entry exists?
  │     |
  │     ├── Yes --> Health check: GET http://127.0.0.1:{port}/global/health
  │     │     |
  │     │     ├── Healthy --> Reuse (reconnect). Done.
  │     │     |
  │     │     └── Unreachable / wrong PID
  │     │           |
  │     │           v
  │     │         Clean stale entry from daemon.json
  │     │           |
  │     │           v
  │     │         (fall through to spawn)
  │     |
  │     └── No entry
  │           |
  v           v
  Spawn new OpenCode Server
    |
    v
  Write { pid, port, password, workingDir, startedAt } to daemon.json
    |
    v
  Wait for health check pass
    |
    v
  Also start heartbeat + cron if not already running (check their PIDs)
    |
    v
  Connection established. Desktop ready.
```

### Desktop Exit Flow

```
User closes desktop window
  |
  v
Desktop exit handler:
  1. Flush any pending workspace writes (MEMORY.md, HISTORY.md)
  2. Do NOT kill OpenCode Server process
  3. Do NOT kill heartbeat/cron processes
  4. Optionally show system tray icon (user preference)
  5. Exit Tauri process
  |
  v
OpenCode Server continues running (detached)
Heartbeat continues on schedule
Cron continues executing jobs
```

User preference controls exit behavior:

| Setting | Behavior |
|---------|----------|
| `exitMode: "background"` (default) | Close window, server stays alive, tray icon shown |
| `exitMode: "minimize"` | Minimize to tray (desktop process stays alive too) |
| `exitMode: "quit"` | Full shutdown: kill server + proactive services + exit |

### Working Directory Switching

OpenCode Server is project-scoped (bound to a working directory). When the user switches projects in the Desktop UI:

```
User switches to project B (currently on project A)
  |
  v
server-manager checks daemon.json
  |
  ├── workingDir == project B? --> Already correct, no action
  |
  └── workingDir == project A
        |
        v
      Gracefully shutdown current OpenCode Server
      (wait for active sessions to drain, timeout 10s)
        |
        v
      Spawn new OpenCode Server with workingDir = project B
        |
        v
      Update daemon.json with new pid, port, workingDir
        |
        v
      Proactive services automatically pick up new server via registry
```

Note: Phase 1 supports **one active OpenCode Server at a time** per user. Multi-project concurrent servers are deferred to Phase 2.

### Crash Recovery (Resident Processes)

With the desktop potentially closed, a separate crash recovery mechanism is needed for the detached server.

**Primary watchdog: Heartbeat Service**

The heartbeat service already polls OpenCode on its interval (default 30 min). It is extended to act as a lightweight watchdog:

```
Heartbeat timer fires
  |
  v
Read daemon.json for OpenCode connection info
  |
  v
Health check: GET http://127.0.0.1:{port}/global/health
  |
  ├── Healthy --> Proceed with normal heartbeat (collect, analyze, write)
  |
  └── Unreachable
        |
        v
      Verify PID is dead (kill -0 {pid})
        |
        ├── Process alive but unresponsive
        │     |
        │     v
        │   Wait 30s, retry health check
        │     |
        │     ├── Recovered --> Continue
        │     └── Still dead --> Force kill PID, then restart
        |
        └── Process dead
              |
              v
            Restart OpenCode Server:
              1. Read workingDir from daemon.json
              2. Spawn new server (same working dir)
              3. Update daemon.json with new PID/port
              4. Write restart event to HEARTBEAT.md
              5. Notify via @agent/notifier (desktop notification if app running, IM if configured)
              |
              v
            If restart fails after 3 attempts:
              1. Write failure to HEARTBEAT.md
              2. Send urgent notification
              3. Stop retry, wait for next heartbeat cycle or desktop launch
```

**Heartbeat self-recovery**: if the heartbeat service itself crashes, the next desktop launch detects its PID is dead (via daemon.json) and restarts it.

**Cron self-recovery**: same pattern -- desktop launch checks cron PID, restarts if dead.

### Clean Shutdown

Full system shutdown can be triggered from:

1. **Desktop UI**: "Quit Agent" menu action (vs "Close Window")
2. **System tray**: "Quit" option
3. **CLI** (future): `ultrawork stop`

Shutdown sequence:

```
Quit signal received
  |
  v
1. Signal cron service to stop (graceful: finish current job, max 30s)
2. Signal heartbeat to stop (graceful: finish current cycle)
3. Signal OpenCode Server to shutdown (graceful: drain sessions, max 10s)
4. Wait for all processes to exit (timeout 15s, then SIGKILL)
5. Remove daemon.json entries (or clear the file)
6. Exit desktop process
```

### Auto-Idle Shutdown

To prevent indefinite resource consumption when the user is away:

```
OpenCode Server tracks last activity timestamp:
  - Last session.prompt call
  - Last heartbeat inspection
  - Last cron job execution

If no activity for N hours (default: 4, configurable):
  1. Heartbeat writes "idle shutdown" event to HEARTBEAT.md
  2. Heartbeat sends notification: "Agent going to sleep due to inactivity"
  3. Heartbeat triggers clean shutdown of OpenCode Server
  4. Proactive services enter standby (stop polling, keep process alive)
  5. Next desktop launch wakes everything up (normal startup flow)
```

### System Tray Integration

When `exitMode: "background"` (default), the desktop shows a system tray icon:

| Tray State | Icon | Tooltip |
|------------|------|---------|
| Server running, desktop open | Green dot | "Agent active" |
| Server running, desktop closed | Gray dot | "Agent running in background" |
| Server crashed / stopped | Red dot | "Agent stopped" |

Tray menu:

```
- Open Desktop          (show/focus main window)
- Current Project: my-app
- Status: Running (2 sessions)
- ---
- Pause Proactive Services
- ---
- Quit Agent             (full shutdown)
```

### Summary: Process Lifecycle State Machine

```
                    ┌──────────────────────────────────────────┐
                    │         Desktop App Launches              │
                    │  server-manager reads daemon.json         │
                    └─────────────────┬────────────────────────┘
                                      │
                          ┌───────────┴───────────┐
                          │                       │
                    Server found?           Not found
                    Health OK?                    │
                          │                       │
                        Yes                 Spawn server
                          │               Write daemon.json
                          │                Start proactive
                          │                       │
                          └───────────┬───────────┘
                                      │
                                      v
                              ┌───────────────┐
                              │   RUNNING      │
                              │ Desktop + Svr  │
                              │ + Proactive    │
                              └───────┬───────┘
                                      │
                              Desktop closes
                              (exitMode: background)
                                      │
                                      v
                              ┌───────────────┐
                              │  BACKGROUND    │◄── Heartbeat acts as watchdog
                              │  Server alive  │    Cron runs on schedule
                              │  No desktop UI │    Auto-idle shutdown timer
                              └───────┬───────┘
                                      │
                         ┌────────────┼────────────┐
                         │            │            │
                   Desktop      Idle timeout   Crash detected
                   re-opens    (4h default)    (heartbeat)
                         │            │            │
                         v            v            v
                      RUNNING    STANDBY      RECOVERY
                                (proactive    (restart or
                                 paused)      notify failure)
```

## Error Handling & Resilience

### OpenCode Server Crash Recovery

```
server-manager monitors OpenCode Server health:

Normal operation:
  server-manager -> health check every 5s -> OpenCode Server
                                                  |
                                                  v
                                              200 OK

Crash detected:
  server-manager -> health check fails (3 consecutive)
                          |
                          v
                    Log error + emit event
                          |
                          v
                    Restart OpenCode binary
                          |
                          v
                    Wait for health check pass
                          |
                          v
                    Notify UI: "Agent restarted"
```

### LLM Provider Failures

| Failure Type | Handling Strategy |
|--------------|-------------------|
| Rate limiting (429) | Exponential backoff, queue requests |
| Server error (5xx) | Retry with backoff, up to 3 times |
| Timeout | Retry once, then fail with user message |
| Invalid API key | Surface error to UI, prompt for reconfiguration |

### Reconnection Strategy

```typescript
const reconnectConfig = {
  initialDelay: 1000,        // 1 second
  maxDelay: 60000,           // 1 minute max
  multiplier: 2,             // exponential backoff
  jitter: 0.1,               // 10% randomization
}
```

## Configuration Management

### Configuration Hierarchy

```
Priority (highest to lowest):

1. Environment variables         (runtime override)
2. CLI arguments                 (per-invocation)
3. Project config (.agent.json)  (per-project)
4. User config (~/.config/agent) (per-user)
5. System defaults               (built-in)
```

### Environment Variables

```bash
# OpenCode Server
OPENCODE_PORT=4096
OPENCODE_HOST=127.0.0.1
OPENCODE_SERVER_PASSWORD=auto    # "auto" generates random password

# LLM Providers (fallback if not in secure storage)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Feature flags
TELEMETRY_ENABLED=false

# Logging
LOG_LEVEL=info                   # debug, info, warn, error
```

### Desktop Credential Storage

```typescript
// Tauri secure storage (uses OS keychain)
// macOS: Keychain
// Windows: Credential Manager
// Linux: Secret Service API (libsecret)

import { Store } from "tauri-plugin-store-api"

const secureStore = new Store(".credentials.dat")

async function saveLLMApiKey(provider: string, key: string) {
  await secureStore.set(`llm.${provider}.apiKey`, key)
  await secureStore.save()
}
```

## Technology Stack

| Layer               | 设计 | 实际采用 |
|---------------------|------|---------|
| Runtime             | Bun | ✅ Bun |
| Build               | Turborepo | ✅ Turborepo |
| UI Framework        | SolidJS | ✅ **React 19** (变更) |
| Desktop Shell       | Tauri (Rust) | ✅ Tauri 2 (Rust) |
| Gateway Server      | Hono (on Bun) | 🔲 未实现 |
| OpenCode Server     | Bun (compiled binary) | ✅ Go (compiled binary) |
| Styling             | TBD (Tailwind / Vanilla Extract) | ✅ **Tailwind CSS 4 + shadcn/ui** |
| Routing             | - | ✅ react-router-dom v7 |
| Bundler             | - | ✅ Vite 7 |

## Feature Summary (Phase 1)

### Desktop Client Features

| Feature                        | 状态 | Description                                           |
|--------------------------------|------|-------------------------------------------------------|
| Chat UI                        | ✅ | Real-time SSE streaming, markdown rendering, 7 种 Part 类型 |
| Session Management             | ✅ | Create, list, delete sessions, 按日期分组, 活跃状态追踪 |
| Permission Dialogs             | ✅ | Permission Dock + Question Dock (单选/多选) |
| File Diff Viewing              | ✅ | ArtifactPreview 50/50 split-screen (code/md/image/diff) |
| Model Management               | ✅ | ModelDialog + ModelSelector + prompt_async model override |
| MCP Management                 | ✅ | MCP Panel + useMCPServers hook + localStorage 状态持久化 |
| Skills Panel                   | ✅ | 按来源分组 + 点击填入 + 管理入口 |
| Workspace Directory            | ✅ | WorkspaceSelector + x-opencode-directory header |
| Settings                       | ✅ | 通用/模型/远程服务/技能管理/关于/帮助/主题/语言 |
| i18n                           | ✅ | 中英双语 |
| Credential Storage             | 🔲 | Secure OS keychain integration (当前用 OpenCode 内置 auth) |
| Workspace (~/.ultrawork/)      | 🔲 | Project-bound agent workspace configuration |

### Channel Gateway Features 🔲 全部规划中

| Feature                        | Description                                           |
|--------------------------------|-------------------------------------------------------|
| DingTalk Integration           | Bot webhook, outgoing messages, interactive cards     |
| Feishu Integration             | Bot webhook, outgoing messages, interactive cards     |
| Slack Integration              | Bot webhook, outgoing messages, blocks                |
| Session Pool                   | User-to-session mapping and lifecycle management      |
| Stream Buffering               | Collect SSE stream for non-streaming IM APIs          |
| Message Adaptation             | Markdown downgrade, platform-specific formatting      |
| Interactive Cards              | Permission requests, confirmation dialogs             |

### Agent Workspace Features 🔲 全部规划中

| Feature                        | Description                                           |
|--------------------------------|-------------------------------------------------------|
| ~/.ultrawork/ Directory        | Unified user-level workspace for agent state          |
| IDENTITY.md                    | Factual agent identity (name, role, skills)           |
| SOUL.md                        | Agent personality and communication style             |
| MEMORY.md                      | Long-term factual memory with line-level dedup        |
| HISTORY.md                     | Chronological event log with rotation (size/date)     |
| opencode/ Config               | Auto-scaffold OpenCode config on workspace init       |
| Session Context Injection      | Auto-assemble identity + personality + memory         |
| Post-session Fact Extraction   | Extract and deduplicate learnings after each session  |

### Proactive Services Features 🔲 全部规划中

| Feature                        | Description                                           |
|--------------------------------|-------------------------------------------------------|
| Heartbeat Service              | Periodic LLM-powered progress summary                 |
| HEARTBEAT.md Output            | Git-friendly, human-readable status file              |
| Cron Service + HTTP API        | REST API for job CRUD                                 |
| Cron MCP Tools                 | MCP tool definitions enabling cron management via LLM |
| Cron Expression Support        | Standard 5-field cron, interval, and fixed-time       |
| Built-in Job Templates         | Dependency check, code review, test health, reports   |
| Desktop Notifications          | Tauri system notifications for notable events         |
| IM Channel Notifications       | Push to DingTalk/Feishu/Slack via webhooks            |
| Token Budget Control           | Per-day budget cap with pause-on-exceed               |

## Development Priority

### Core Infrastructure (P0)

| Feature                              | Complexity |
|--------------------------------------|------------|
| api-client SDK                       | Low        |
| server-manager + sidecar spawn       | Medium     |
| connector (local + remote mode)      | Medium     |
| ui basic components                  | Medium     |
| Desktop app shell (Tauri)            | Medium     |
| workspace: .agent/ init + SOUL.md    | Low        |

### Agent Workspace (P1)

| Feature                              | Complexity |
|--------------------------------------|------------|
| .agent/ directory init + structure   | Low        |
| .opencode/ config scaffolding        | Low        |
| IDENTITY.md reading + prompt inject  | Low        |
| SOUL.md reading + prompt injection   | Low        |
| MEMORY.md read/write + dedup         | Medium     |
| HISTORY.md append + rotation         | Low        |
| Post-session fact extraction (LLM)   | Medium     |
| Memory consolidation cron job        | Medium     |

### Channel Gateway (P1)

| Feature                              | Complexity |
|--------------------------------------|------------|
| Gateway HTTP server + health check   | Low        |
| DingTalk adapter                     | Medium     |
| Feishu adapter                       | Medium     |
| Slack adapter                        | Medium     |
| Session pool management              | Medium     |
| Stream buffering                     | Medium     |
| Interactive card renderer            | Medium     |
| Markdown format adaptation           | Low        |

### Proactive Services (P2)

| Feature                              | Complexity |
|--------------------------------------|------------|
| Heartbeat Service (core loop + writer)| Low       |
| LLM-powered session analysis         | Medium     |
| Cron scheduler engine                | Medium     |
| Cron HTTP API server                 | Medium     |
| Cron job executor (session + LLM)    | Medium     |
| @agent/notifier core + desktop target| Medium     |
| Built-in job templates               | Low        |
| Token budget management              | Medium     |

## Design Decisions

### Why Server-Only mode?

OpenCode's architecture is client/server by design. The server contains all agent logic, LLM provider abstraction, tool execution, and MCP support. By only consuming the server API, we get:

- Full agent capabilities without reimplementation
- Automatic benefit from OpenCode's ongoing development
- Freedom to build any UI on any framework
- Clean separation of concerns

### Why Git submodule (not fork)?

- Easy to pull upstream updates: `git pull origin dev`
- No merge conflicts with our code (it's in `vendor/`, we never modify it)
- Binary output is the contract boundary, not source code

### Why ~/.ultrawork/ directory (not per-project .agent/)?

The Desktop Agent is a **personal assistant** tied to the user, not to specific projects:

- **One user = one identity** - The agent's personality doesn't change per project
- **Unified memory** - Facts learned in project A should be available when working on project B
- **Simpler UX** - No confusion about "which directory am I reading from"
- **Works with IM channels** - DingTalk/Feishu messages aren't project-bound
- **Single location** - Easy to backup, reset, or migrate agent state

### Why scaffold opencode/ config?

- Out-of-box experience: users get a working agent setup immediately

### Why workspace context injection via @agent/connector (not per-consumer)?

Four options were considered for how workspace context (identity, soul, memory, history) reaches LLM sessions across all consumers:

| Option | Approach | Rejected Because |
|--------|----------|------------------|
| A. Library + per-consumer | Each consumer imports workspace, loads context independently | Duplicated logic; remote consumers (Channel Gateway) can't access local files |
| B. Workspace HTTP service | Workspace becomes a resident process with REST API | Adds process to manage; overkill for file reads |
| C. OpenCode extension | Modify OpenCode to natively load workspace files | Couples to upstream; OpenCode is a vendor dependency |
| **D. Connector integration** | Connector intercepts session lifecycle, injects workspace context transparently | **Chosen** |

Option D (connector integration) was chosen because:

- **Zero per-consumer logic** -- consumers create sessions via connector as before; workspace context is injected transparently
- **Works for remote mode** -- connector on the server side loads workspace locally, remote consumers (Channel Gateway) benefit without file access
- **Workspace stays a library** -- no new process, no new HTTP API, no operational complexity
- **Single integration point** -- context injection and fact extraction logic lives in one place, not scattered across Desktop, Gateway, heartbeat, and cron
- **Post-session hooks are centralized** -- fact extraction and memory/history append happen in connector's `onSessionEnd`, regardless of which consumer triggered the session
- Enables the client UI to manage OpenCode settings by writing to a known location

### Why separate IDENTITY.md and SOUL.md?

- IDENTITY is **factual** (name, role, skills) -- stable, rarely changes
- SOUL is **behavioral** (personality, communication style) -- tunable per-project
- Clean separation allows mixing different identities with different personalities

### Why SolidJS?

- Consistent with OpenCode's existing `packages/app`
- Fine-grained reactivity model suits real-time SSE streaming
- Smaller bundle size than React

## Phase 2 Roadmap (Not in Scope)

The following features are planned for Phase 2:

- **Control Plane**: Centralized enterprise management, policies, metrics
- **Context Awareness**: Environment sensing, browser extension, proactive suggestions
- **Web/Mobile Clients**: Lightweight browser and mobile clients
- **Session Coordination Hub**: Cross-surface session continuity and identity federation
- **Workspace Central Registry**: N:1 workspace-to-project mapping
