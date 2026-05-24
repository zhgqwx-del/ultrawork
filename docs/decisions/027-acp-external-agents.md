# ADR-027: 多 Agent 架构 — ACP 协议集成与统一 Agent 抽象

**状态**: Accepted (Phase 1-3 实现)
**日期**: 2026-05-24
**关联**: ADR-013 (Gateway Sidecar 模式参考), ADR-020 (Config 隔离)

## 背景

Ultrawork 当前以 OpenCode 作为唯一的 Agent Loop 后端，通过 HTTP REST + SSE 与 OpenCode Sidecar 通信。随着 Agent Client Protocol (ACP) 成为编码 Agent 生态的事实标准，Ultrawork 需要从"OpenCode 的前端"演进为**独立的桌面 Agent 客户端**——所有 Agent（OpenCode 内置的 Build/Plan、外部的 Qoder/Claude Code/Gemini CLI 等）都是平等的一等公民，用户在统一的界面中自由选择和切换。

### 核心目标

1. **统一 Agent 抽象** — 无论底层是 OpenCode HTTP+SSE 还是 ACP stdio JSON-RPC，前端看到的是同一个 Agent 接口
2. **ACP Client 能力** — Ultrawork 作为 ACP Client，spawn 并管理外部 ACP Agent 子进程
3. **OpenCode Agent 暴露** — 将 OpenCode 已有的 Build/Plan 等 agent 暴露到 UI，与外部 Agent 平级展示
4. **用户自由选择** — 聊天界面中可以选择不同的 Agent 来完成任务

### ACP 协议简述

Agent Client Protocol (Zed ACP) 是由 Zed Industries 联合 Google 推出的开放协议：

- **传输层**: JSON-RPC 2.0 over stdio（Client spawn Agent 子进程）
- **核心方法**: `initialize` → `session/new` → `session/prompt` → `session/update`(通知)
- **已支持的 Agent**: Claude Code、OpenCode、Codex CLI、Gemini CLI、Qoder、Hermes Agent、Auggie、Goose
- **已支持的 Client**: Zed、JetBrains 全家桶、VS Code (社区扩展)、Neovim
- **协议定位**: 三层协议栈中的中间层

```
用户/Client ──[ACP]──▶ Agent ──[A2A]──▶ Agent ──[MCP]──▶ Tool
```

### OpenCode Desktop 参考

OpenCode Desktop 客户端在输入框底部有 Agent 选择器（Build / Plan 下拉），这两个是 OpenCode 内置的独立 Agent：
- **Build**: 默认 agent，可执行所有工具（编辑、bash 等）
- **Plan**: 只读模式，禁止编辑/执行，只能分析和制定计划

Ultrawork 的目标是将 OpenCode 内置 Agent 和外部 ACP Agent **统一为平等的一等公民**，用户无需关心底层通信差异。

## 行业调研

### 主流工具 ACP 支持现状

| 工具 | 身份 | ACP 启动方式 | 认证方式 |
|------|------|-------------|---------|
| OpenCode | Agent (Server) | `opencode acp` | `opencode auth login` |
| Qoder | Agent (Server) | `qodercli --acp` | `QODER_PERSONAL_ACCESS_TOKEN` env |
| Claude Code | Agent (Server) | `claude-agent-acp` 适配器 | `ANTHROPIC_API_KEY` env |
| Codex CLI | Agent (Server) | 原生支持 | `OPENAI_API_KEY` env |
| Gemini CLI | Agent (Server) | 原生支持（参考实现） | `GOOGLE_API_KEY` env |
| Hermes Agent | Agent (Server) | `hermes acp` | 内置 auth |
| Zed | Client | 原生 | — |
| JetBrains | Client | 2025.3+ Beta | — |
| OpenClaw | Client (编排器) | acpx 插件 | — |

### ACP 协议核心 API

```
┌─────────────────────────────────────────────────────────┐
│                    ACP 协议方法                          │
├─────────────────────────────────────────────────────────┤
│ initialize          → 协议版本协商 + 能力声明            │
│ session/new         → 创建新会话（带 cwd 等上下文）       │
│ session/load        → 恢复历史会话                       │
│ session/prompt      → 发送用户消息                       │
│ session/update      → Agent→Client 流式通知（单向）       │
│ listSessions        → 列举历史会话                       │
│ setSessionMode      → 切换 Agent 模式                    │
│ cancel              → 取消当前 prompt                    │
│ fs/read_text_file   → Agent 反向读文件（Client 提供）     │
│ fs/write_text_file  → Agent 反向写文件（Client 提供）     │
├─────────────────────────────────────────────────────────┤
│ session/update 通知类型:                                 │
│   agent_message_chunk  — 文本/图片流式输出                │
│   agent_thought_chunk  — 思考/推理内容                    │
│   tool_call            — 工具调用开始                     │
│   tool_call_update     — 工具执行进度                     │
│   plan                 — 执行计划更新                     │
│   usage_update         — token 用量                      │
│   current_mode_update  — 模式切换                        │
└─────────────────────────────────────────────────────────┘
```

### Zed 编辑器 Agent 配置格式（参考）

```json
{
  "agent_servers": {
    "OpenCode": {
      "command": "opencode",
      "args": ["acp"]
    },
    "Qoder": {
      "command": "qodercli",
      "args": ["--acp"],
      "env": {
        "QODER_PERSONAL_ACCESS_TOKEN": "..."
      }
    }
  }
}
```

## 方案设计

### 设计原则

**Agent 平等原则**: Ultrawork 是一个**独立的桌面 Agent 客户端**。所有 Agent——无论是 OpenCode 内置的 Build/Plan，还是通过 ACP 接入的 Qoder/Claude Code——都是平等的一等公民。前端通过统一的 Agent 抽象层与它们交互，用户无需关心底层通信差异。

### 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                        Desktop UI (React)                        │
│                                                                  │
│  ┌────────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  Agent 选择器    │  │  聊天界面     │  │  Agent 管理设置       │ │
│  │  (底部下拉)     │  │  (统一消息渲染)│  │  (添加/配置/认证)     │ │
│  └──────┬─────────┘  └──────┬───────┘  └────────┬─────────────┘ │
│         │                   │                    │               │
│  ───────┴───────────────────┴────────────────────┴───────────    │
│                      统一 Agent 抽象层                            │
│                   useAgents() + AgentRouter                      │
│                                                                  │
│    ┌────────────────────────────┐  ┌──────────────────────────┐  │
│    │     OpenCode Adapter       │  │      ACP Adapter          │  │
│    │  (现有 HTTP+SSE 通信)       │  │  (通过 ACP Sidecar)       │  │
│    │                            │  │                           │  │
│    │  ┌──────┐  ┌──────┐       │  │  ┌──────┐  ┌──────┐      │  │
│    │  │Build │  │Plan  │  ...  │  │  │Qoder │  │Claude│  ... │  │
│    │  │Agent │  │Agent │       │  │  │      │  │ Code │      │  │
│    │  └──────┘  └──────┘       │  │  └──────┘  └──────┘      │  │
│    └────────────┬───────────────┘  └───────────┬──────────────┘  │
└─────────────────┼─────────────────────────────┼─────────────────┘
                  ▼                             ▼
           ┌──────────────┐              ┌──────────────┐
           │ OpenCode     │              │ ACP Sidecar  │
           │ Sidecar :4096│              │ :4099        │
           │ (现有 HTTP)   │              │ (新建，管理   │
           │              │              │  ACP 子进程)  │
           └──────────────┘              └──────┬───────┘
                                                │ spawn (stdio JSON-RPC)
                                         ┌──────┴───────┐
                                         ▼              ▼
                                  ┌────────────┐ ┌────────────┐
                                  │qodercli    │ │opencode acp│
                                  │--acp       │ │claude agent│
                                  └────────────┘ └────────────┘
```

### 核心设计决策

#### 决策 1: 统一 Agent 抽象模型

前端定义一个统一的 `Agent` 接口，屏蔽底层通信差异：

```typescript
// src/lib/agent-types.ts
interface UnifiedAgent {
  id: string                    // 唯一标识: "opencode:build" | "acp:qoder"
  name: string                  // 显示名: "Build" | "Qoder"
  description?: string
  icon?: string
  source: "opencode" | "acp"    // 来源类型
  status: "available" | "connecting" | "connected" | "error" | "not-installed"
  capabilities?: {
    loadSession?: boolean       // 是否支持 session 恢复
    plan?: boolean              // 是否支持 plan 模式
    image?: boolean             // 是否支持图片输入
  }
}

// Agent Router 根据 source 字段决定路由
interface AgentRouter {
  sendMessage(agentId: string, sessionId: string, text: string): Promise<void>
  cancelMessage(agentId: string, sessionId: string): Promise<void>
  createSession(agentId: string, cwd: string): Promise<string>
  // ... 统一接口
}
```

OpenCode Agent 和 ACP Agent 都实现同一接口，前端只和 `AgentRouter` 交互。

#### 决策 2: Agent Router 实现位置

| 选项 | 描述 | 优劣 |
|------|------|------|
| A. 前端 React 层 | 前端直接管 ACP 进程 | ❌ 浏览器环境无法 spawn 进程 |
| B. Tauri Rust 主进程 | Rust 管 ACP 子进程 + JSON-RPC | ⚠️ 可行但 Rust JSON-RPC 实现成本高 |
| **C. 独立 TS Sidecar** | **类似 Gateway/Knowledge，bun build --compile** | **✅ 推荐：与现有 sidecar 模式一致，可复用 @agentclientprotocol/sdk (TypeScript)** |
| D. 集成到 Gateway | 在 Gateway sidecar 中扩展 ACP Client | ⚠️ 职责混杂，Gateway 是 channel 层 |

**选择: C — 独立 ACP Sidecar**

理由：
- ACP 官方提供 TypeScript SDK (`@agentclientprotocol/sdk`)，直接可用
- 与 Gateway (:4097) 和 Knowledge (:4098) 一致的 sidecar 模式
- Tauri 主进程统一管理所有 sidecar 生命周期（已有成熟模式）
- 前端通过 HTTP 与 ACP Sidecar 通信，SSE 推送事件（与现有模式统一）

#### 决策 3: 消息模型统一

两种来源的事件需要映射到统一格式：

**OpenCode Agent（现有，无需改动）**:
- 前端已有完整的 SSE 事件处理（`message.part.delta`、`message.part.updated` 等）
- `promptAsync { agent: "build" | "plan" }` 直接传参

**ACP Agent（新增，通过 ACP Sidecar 转换）**:

| ACP session/update | ACP Sidecar 转换为 → | 前端处理 |
|---|---|---|
| `agent_message_chunk` (text) | `message.part.delta` | 复用现有流式文本渲染 |
| `agent_message_chunk` (image) | `message.part.updated` | 复用现有图片渲染 |
| `agent_thought_chunk` | `message.part.updated` (reasoning) | 复用 reasoning-block |
| `tool_call` | `message.part.updated` (tool-call) | 复用 tool-call-block |
| `tool_call_update` | `message.part.updated` (tool-call) | 复用 tool-call-block |
| `plan` | `message.part.updated` (custom) | 新增 plan-block |
| `usage_update` | `message.updated` | 复用 token 统计 |
| prompt 完成 | `session.status: idle` | 复用现有状态处理 |

**关键**: ACP Sidecar 负责协议转换，前端**完全复用现有消息渲染组件**，无需区分消息来源。

**ACP 消息持久化**: ACP 对话消息不存入 OpenCode 后端数据库（两套独立 session 体系），采用**前端内存缓存**（模块级 Map，keyed by OpenCode sessionId）。用户切换 session 再切回时从缓存恢复。缓存不跨应用重启——后续可升级为 IndexedDB 持久化。

#### 决策 4: Agent 配置与注册

```jsonc
// ~/.config/ultrawork/agents.json
{
  "agents": {
    // 外部 ACP Agent — 用户按需配置
    "qoder": {
      "type": "acp",
      "label": "Qoder",
      "description": "Qoder 编码 Agent",
      "command": "qodercli",
      "args": ["--acp"],
      "env": {
        "QODER_PERSONAL_ACCESS_TOKEN": "${secret:qoder_token}"
      }
    },
    "opencode-acp": {
      "type": "acp",
      "label": "OpenCode (ACP)",
      "description": "通过 ACP 协议接入独立 OpenCode 实例",
      "command": "opencode",
      "args": ["acp"]
    },
    "claude-code": {
      "type": "acp",
      "label": "Claude Code",
      "description": "Anthropic Claude Code Agent",
      "command": "claude",
      "args": ["agent", "acp"],
      "env": {
        "ANTHROPIC_API_KEY": "${secret:anthropic_key}"
      }
    }
  },
  "default": "opencode:build"
}
```

> **OpenCode 内置 Agent（Build/Plan）不在此文件中配置**——它们通过 `GET /agent` 从 OpenCode Sidecar 动态获取，与外部 Agent 合并后统一展示。

#### 决策 5: UI 交互方式

**输入框底部 Agent 选择器**（参考 OpenCode Desktop）：

```
┌─────────────────────────────────────────────────────────┐
│  随便问点什么... "这个错误是什么意思？"                    │
│                                                    [↑]  │
├─────────────────────────────────────────────────────────┤
│  Build ▾           ≡ Claude Sonnet 4 ▾                  │
│  ┌───────────────────────────────┐                      │
│  │ OpenCode                      │                      │
│  │   ✓ Build    执行模式（默认）  │                      │
│  │     Plan     只读规划模式      │                      │
│  │ ────────────────────────────  │                      │
│  │ 外部 Agent                    │                      │
│  │     Qoder     ● 已连接        │                      │
│  │     Claude Code  ○ 未连接     │                      │
│  └───────────────────────────────┘                      │
└─────────────────────────────────────────────────────────┘
```

特点：
- OpenCode 内置 Agent 和外部 ACP Agent 在同一个下拉中，按分组展示
- 外部 Agent 显示连接状态（`●` 已连接 / `○` 未连接 / `⚠` 错误）
- 选中外部 Agent 时，如未连接则自动触发 connect（spawn 子进程 + initialize）
- 模型选择器保持独立——OpenCode Agent 使用 OpenCode 的模型体系，外部 ACP Agent 使用自带的模型

## 实施计划

### Phase 1: 统一 Agent 抽象 + OpenCode Agent 暴露

**目标**: 建立 Agent 抽象层，先将 OpenCode 内置 Agent（Build/Plan）暴露到 UI，打通选择→发送→切换的完整流程。这一步不引入外部 ACP 依赖，仅利用现有 `GET /agent` + `promptAsync { agent }` 能力。

#### 1a. Agent 抽象层

- 新建 `src/lib/agent-types.ts` — `UnifiedAgent` 接口定义
- 新建 `src/lib/use-agents.ts` — Agent 状态管理 hook，从 `GET /agent` 获取 OpenCode Agent 列表
- 新建 `src/lib/agent-context.tsx` — `AgentProvider` 全局上下文（当前选中 Agent、可用列表）

#### 1b. Agent 选择器 UI

- 新建 `src/components/chat/agent-selector.tsx` — 下拉选择器组件
- 修改 `Home.tsx` / `Session.tsx` — 输入框底部增加 Agent 选择器（与 Model 选择器并排）
- 修改 `use-session-messages.ts` — `sendMessage()` 传入当前选中的 `agent` 参数

#### 1c. Plan↔Build 切换处理

- OpenCode 的 `plan_exit` / `plan_enter` 工具调用会触发 Agent 自动切换
- 在 SSE 事件中检测 agent 切换信号，自动更新 Agent 选择器状态

### Phase 2: ACP Client 基础设施

**目标**: 新建 ACP Sidecar，能 spawn 外部 ACP Agent 子进程并完成一次完整对话。

#### 2a. ACP Sidecar 搭建

- **新建包**: `packages/agent/acp-client/`
- **技术栈**: TypeScript + `@agentclientprotocol/sdk` + bun build --compile
- **端口**: :4099
- **核心模块**:
  - `acp-manager.ts` — 管理多个 ACP Agent 子进程的 spawn/kill/重启
  - `acp-connection.ts` — 单个 Agent 的 JSON-RPC 连接（initialize → session 生命周期）
  - `event-bridge.ts` — ACP `session/update` → Ultrawork 统一 SSE 事件转换
  - `server.ts` — HTTP 端点供前端调用

#### 2b. ACP Sidecar HTTP API

```
GET  /acp/agents              → 已注册的外部 Agent 列表（含连接状态）
POST /acp/agents/:id/connect  → 启动 Agent 子进程 + initialize 握手
POST /acp/agents/:id/disconnect → 关闭 Agent 子进程

POST /acp/session              → 创建 ACP session (session/new)
POST /acp/session/:id/prompt   → 发送消息 (session/prompt)
POST /acp/session/:id/cancel   → 取消生成 (cancel)
GET  /acp/session/:id/events   → SSE 事件流（session/update 转换后）
DELETE /acp/session/:id        → 关闭 session

GET  /acp/health               → 健康检查
```

#### 2c. 前端 Agent Router 集成

- 新建 `src/lib/agent-router.ts` — 根据 `agent.source` 路由到 OpenCode API 或 ACP Sidecar API
- 修改 `use-agents.ts` — 合并 OpenCode Agent + ACP Agent 为统一列表
- 修改 `agent-selector.tsx` — 分组展示（OpenCode / 外部 Agent）+ 连接状态

#### 2d. Tauri 进程管理

- 在 `lib.rs` 中注册 ACP Sidecar 启动/停止
- 复用现有 sidecar 管理模式（类似 Gateway、Knowledge）
- 退出时统一清理 ACP Sidecar + 所有 ACP Agent 子进程

### Phase 3: ACP 消息流打通 + Agent 管理 UX

**目标 A — ACP 消息流打通**: 当用户选择 ACP Agent 时，消息发送和接收走 ACP Sidecar 而非 OpenCode。

- `use-session-messages.ts` 中 `sendMessage` 根据 agent source 分流
- ACP Agent: 调用 `createACPSession()` → `promptACPSession()` → SSE 订阅 `/acp/session/:id/events`
- ACP SSE 事件注入到现有的消息状态管理（复用 `setMessages` / `setSending`）
- OpenCode Agent: 保持现有 `promptAsync` 流程不变

**目标 B — Agent 管理 UX**: 完善配置、认证、状态指示。✅ 已实现

- Settings 页面新增 "外部 Agent" Tab（Bot 图标）：Agent 列表 + 连接状态图标 + 连接/编辑/删除操作
- AddAgentDialog 完整配置表单：ID / 显示名称 / 描述 / 启动命令 / 参数 / 环境变量（认证 Token 通过 env 配置）
- Agent 连接测试：卡片上 Connect 按钮（spawn → initialize），成功/失败 toast 反馈
- Agent 状态指示器：Agent 选择器（绿/黄/红/灰点）+ Settings 卡片（CheckCircle/XCircle/AlertCircle 图标 + 状态文字 + 错误信息）
- ACP Sidecar API 扩展：PUT /acp/agents/:id（保存）+ DELETE /acp/agents/:id（删除）+ GET /acp/agents/:id/config（编辑）+ POST /acp/config/reload（热加载）
- 配置持久化：保存后自动写入 `~/.config/ultrawork/agents.json` + 自动 connect

### Phase 总览

| Phase | 内容 | 工作量 | 前置依赖 |
|-------|------|--------|---------|
| **1a** | Agent 抽象层 (types + hook + context) | ~1 天 | 无 |
| **1b** | Agent 选择器 UI + promptAsync 集成 | ~2 天 | 1a |
| **1c** | Plan↔Build 切换处理 | ~1 天 | 1b |
| **2a** | ACP Sidecar 搭建 (spawn + JSON-RPC + event bridge) | ~3 天 | 无 (可与 1 并行) |
| **2b** | ACP Sidecar HTTP API | ~1 天 | 2a |
| **2c** | 前端 Agent Router 集成 | ~2 天 | 1b + 2b |
| **2d** | Tauri 进程管理集成 | ~1 天 | 2a |
| **3a** | ACP 消息流打通 (sendMessage 分流 + ACP SSE 订阅) | ~2 天 | 2 |
| **3b** | Agent 管理 Settings + 认证 + 状态 | ~3 天 | 3a |

## ACP Client 实现参考：acpx

调研了 [openclaw/acpx](https://github.com/openclaw/acpx)（v0.8.0, 2026-05）——目前最成熟的 ACP Client 开源实现。核心发现：

### 关键实现模式（已对齐到 Ultrawork ACP Client）

| 模式 | acpx 实现 | Ultrawork 对齐状态 |
|------|----------|-------------------|
| **进程退出监听** | error/exit/close 事件 + lastAgentExit 记录 + rejectPendingRequests | ✅ `proc.exited` promise + status 更新 + SSE error 通知 |
| **事件串行排序** | sessionUpdateChain promise chain + 序列号 + drain 检测 | ✅ promise chain 串行 |
| **Pending request 追踪** | runConnectionRequest 包装 + pending set + 批量 reject | ✅ runRequest 包装 + PendingRequest set |
| **Cancel 纪律** | cancellingSessionIds set + permission abort signal | ⏳ 基础 cancel 已实现，abort signal Phase 3 补 |
| **Session 恢复** | loadSession + suppressReplayUpdates + drain wait | ⏳ Phase 3 补 |
| **权限策略** | --approve-all / --approve-reads / --deny-all + 策略模式 | ⏳ 当前 auto-approve，Phase 3 补 UI |
| **Terminal 操作** | 完整 terminal-manager (spawn/output/kill/cleanup) | ⏳ 未实现，后续按需补 |
| **CWD 沙箱** | readTextFile/writeTextFile 路径校验限制在 cwd 内 | ✅ validatePath 校验 resolved path 在 session CWD 内 |
| **Stream tapping** | 可观测性回调（onAcpMessage/onAcpOutputMessage） | ⏳ 后续按需补 |

### 未纳入的 acpx 能力（不影响 MVP）

- **Session 持久化**: acpx 在 `~/.acpx/sessions/` 持久化会话状态。Ultrawork 的 session 由 OpenCode 管理，ACP session 暂无需持久化。
- **Flow 编排**: acpx 支持 TypeScript workflow modules（多步 prompt 流程）。超出 Ultrawork 当前范围。
- **Queue ownership**: acpx 的 idle TTL + queue IPC 模型用于 CLI 多进程共享。Ultrawork 单进程不需要。

## 已知限制（待后续迭代）

1. **ACP 消息不跨应用重启** — ACP 对话历史仅存前端内存缓存（模块级 Map），应用重启后丢失。后续可升级为 IndexedDB 持久化。
2. **不支持同一 session 混合 Agent** — 每个 session 要么走 OpenCode 要么走 ACP，不支持在同一会话中切换 Agent。原因：两者 session 体系独立（OpenCode 消息在后端 DB，ACP 消息在前端内存），混合会导致消息来源不一致。后续可通过 UI 限制（选定 Agent 后锁定当前 session）或消息归一化（ACP 消息回写 OpenCode DB）来解决。
3. **ACP Sidecar 不运行时无友好提示** — 用户选择 ACP Agent 发送消息，如果 Sidecar 未启动，只显示通用错误 toast。后续应在 Agent 选择器上显示 Sidecar 连接状态，不可用时禁用 ACP Agent。
4. **权限自动批准** — ACP Agent 的文件读写权限请求当前自动选择 allow_once/allow_always，无用户确认 UI。后续应集成到前端 PermissionDock 组件。
5. **ACP SSE 事件类型不完整** — 仅映射了 agent_message_chunk / agent_thought_chunk / tool_call / tool_call_update / usage_update，其他类型（error 等）静默忽略。

## 后续迭代方向

| 方向 | 内容 | 优先级 | 触发时机 |
|------|------|--------|---------|
| **消息持久化** | ACP 对话历史从内存缓存升级为 IndexedDB，支持跨应用重启 | 高 | 用户反馈对话丢失时 |
| **Session Agent 锁定** | 选定 Agent 后锁定当前 session，防止混合消息；或 UI 提示切换 Agent 会新建 session | 高 | 用户误操作导致混合 |
| **权限确认 UI** | ACP Agent 的文件读写权限请求集成到前端 PermissionDock，用户可逐条审批 | 中 | 安全需求提升时 |
| **Sidecar 健康状态** | Agent 选择器显示 Sidecar 连接状态，不可用时禁用 ACP Agent + 友好错误提示 | 中 | 分发给其他用户时 |
| **更多 Agent 接入** | Claude Code (`claude agent acp`)、Gemini CLI、OpenCode ACP 等预置配置模板 | 低 | 有具体 Agent 需求时 |
| **SSE 事件完整映射** | 补齐 plan、error、config_option_update 等 ACP 事件类型的前端渲染 | 低 | Agent 使用 plan 模式时 |
| **凭证安全** | Agent 环境变量中的 Token 从明文 JSON 迁移到 Tauri keychain / 系统密钥链 | 低 | 安全审计时 |

## 风险与注意事项

1. **ACP 协议版本演进** — 当前 v1，仍在活跃迭代。通过 `initialize` 做版本协商，避免硬编码
2. **stdout 纯净性** — ACP Agent 的非 JSON-RPC 输出会污染通信。stderr 已重定向到 console.error 日志
3. **外部 Agent 可用性** — 用户机器上不一定安装了 qodercli/opencode 等，需要友好的提示和安装引导
4. **安全** — Agent 凭证（API Key/Token）需安全存储，考虑复用 Knowledge Sidecar 的 `sanitizeConfig` 模式或 Tauri keychain
5. **消息模型差异** — ACP 的 `ContentBlock` 类型（text/image/resource/diff/terminal）与 OpenCode 的 `MessagePart` 类型有差异，event-bridge 映射层需覆盖全部类型
6. **文件操作权限** — ACP Agent 通过 `fs/read_text_file` / `fs/write_text_file` 反向请求读写文件。当前已实现基础 fs 操作，CWD 沙箱校验待 Phase 3 补齐
7. **进程生命周期** — 已实现进程退出监听 + pending request 批量 reject + Tauri RunEvent::Exit 统一清理

## 参考资料

- [ACP 协议官网](https://agentclientprotocol.com/)
- [ACP 协议规范 (Overview)](https://agentclientprotocol.com/protocol/overview)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) — `@agentclientprotocol/sdk` v0.21.1
- [openclaw/acpx](https://github.com/openclaw/acpx) — 生产级 ACP Client 参考实现（v0.8.0, TypeScript）
- [ACPX ACP Coverage Roadmap](https://github.com/openclaw/acpx/blob/main/docs/2026-02-19-acp-coverage-roadmap.md)
- [OpenClaw ACP Agents 文档](https://docs.openclaw.ai/tools/acp-agents)
- [OpenCode ACP 文档](https://opencode.ai/docs/zh-cn/acp/)
- [OpenCode ACP 源码](https://github.com/sst/opencode) — `packages/opencode/src/acp/`（Agent Side 参考）
- [Qoder ACP 文档](https://docs.qoder.com/en/cli/acp)
- [Zed agent_servers 配置](https://zed.dev/docs/agent/acp)
- 桌面文件: `~/Desktop/ACP技术调研/ACP协议技术调研报告.docx` — 完整的 ACP vs A2A 调研
