# MCP 技术流程详解

> 本文档详细描述用户在 Ultrawork 中添加、配置、使用 MCP (Model Context Protocol) Server 的完整技术流程，覆盖前端 UI → Tauri 层 → OpenCode Sidecar → MCP Server → AI Agent 工具调用的全链路。

<!-- last-updated: 2026-05-08 -->

---

## 目录

1. [整体架构](#1-整体架构)
2. [添加 MCP Server](#2-添加-mcp-server)
3. [配置持久化](#3-配置持久化)
4. [Sidecar 端 MCP 生命周期](#4-sidecar-端-mcp-生命周期)
5. [MCP 工具注册与收集](#5-mcp-工具注册与收集)
6. [AI Agent 工具调用流程](#6-ai-agent-工具调用流程)
7. [Permission 系统](#7-permission-系统)
8. [OAuth 认证流程](#8-oauth-认证流程)
9. [Browser MCP 特殊流程](#9-browser-mcp-特殊流程)
10. [完整数据流图](#10-完整数据流图)
11. [关键文件索引](#11-关键文件索引)

---

## 1. 整体架构

MCP 系统横跨四个层次：

```
┌────────────────────────────────────────────────────────────────────────┐
│  Layer 1: React UI                                                     │
│  Settings.tsx / mcp-panel.tsx / useMCPServers / useBrowserMCP          │
├────────────────────────────────────────────────────────────────────────┤
│  Layer 2: Tauri (Rust)                                                 │
│  read/write/remove_mcp_config → opencode.json 文件 I/O                 │
├────────────────────────────────────────────────────────────────────────┤
│  Layer 3: OpenCode Sidecar (Go → TypeScript/Effect)                    │
│  HTTP API (/mcp) + MCP Service (连接管理、工具收集、OAuth)              │
├────────────────────────────────────────────────────────────────────────┤
│  Layer 4: MCP Server 进程                                              │
│  本地: stdio 子进程 | 远程: HTTP/SSE 通信                              │
└────────────────────────────────────────────────────────────────────────┘
```

### 关键设计决策

| 决策 | 说明 |
|------|------|
| **双写架构** | Tauri 负责持久化（opencode.json），Sidecar 负责运行时（内存状态）。两者独立，前端负责协调 |
| **Sidecar 不持久化** | `POST /mcp` 只在 Sidecar 内存中注册，**不写入** opencode.json。持久化由前端 Tauri Command 完成 |
| **Config 为主、Status 为辅** | opencode.json 是配置源，Sidecar status 是运行时覆盖层。前端 merge 两者展示 |

---

## 2. 添加 MCP Server

### 2.1 用户入口

用户有 3 种方式添加 MCP Server：

#### (a) Settings → 服务 → 手动添加

**组件**: `ServiceAddForm`（`Settings.tsx:728-887`）

```
用户填写表单：
├─ 名称（必填）
├─ 类型选择：Remote / Local
├─ Remote 时：
│   ├─ URL（必填）
│   └─ Headers（可选，key-value 对）
└─ Local 时：
    ├─ Command（必填，空格分隔，如 "bunx @anthropic/mcp-server"）
    └─ Environment（可选，key-value 对）
```

提交时构造的配置对象：

```typescript
// Remote
{ type: "remote", url: "https://...", headers: { "X-Api-Key": "..." } }

// Local
{ type: "local", command: ["bunx", "@anthropic/mcp-server"], environment: { "API_KEY": "xxx" } }
```

#### (b) Settings → 服务 → JSON 导入

**组件**: `JsonImportForm`（`Settings.tsx:889-1002`）

支持两种 JSON 格式：

```jsonc
// 格式 1: Claude Desktop / Cline 格式
{
  "mcpServers": {
    "my-server": { "command": ["node", "server.js"], "args": ["--port", "3000"] }
  }
}

// 格式 2: 直接格式
{
  "my-server": { "type": "remote", "url": "https://..." }
}
```

导入逻辑（`Settings.tsx:914-940`）：
- 自动检测 `command` → local，`url` → remote
- 合并 `args` 到 `command` 数组
- 支持 `environment` 和 `env` 两种 key
- 跳过已存在的同名 server

#### (c) Sidebar → MCP Panel → 快速添加

**组件**: `AddMCPForm`（`mcp-panel.tsx:258-345`）

简化版表单，只有 name、type、url/command 三个字段。

### 2.2 添加后的执行流程

```
用户点击「添加」
  │
  ▼
useMCPServers.handleAdd(name, config)          [use-mcp-servers.ts:123-142]
  │
  ├─── ① invoke("write_mcp_config", { workspace, name, config })
  │        │
  │        ▼ Tauri Rust 层                     [lib.rs:771-781]
  │        读取 opencode.json → 合并 mcp[name] = config → 写回磁盘
  │        （持久化完成，重启后可恢复）
  │
  └─── ② api.createMCP(name, configWithEnabled)
           │
           ▼ HTTP POST /mcp                    [client.ts:319-324]
           │  Body: { name, config: { ...config, enabled: true } }
           │
           ▼ Sidecar 路由处理                  [routes/mcp.ts:32-61]
           │  调用 MCP.add(name, config)
           │
           ▼ MCP Service                       [mcp/index.ts:439-464]
           │  create(name, config) → 建立连接 → 获取工具列表
           │
           ▼ 返回 MCPStatusMap
              { "my-server": { status: "connected" } }
```

**关键点**: ① 和 ② 是顺序执行的（先持久化，再连接），确保即使连接失败，配置也已保存。

---

## 3. 配置持久化

### 3.1 存储位置

| 存储位置 | 路径 | 用途 | 作用域 |
|----------|------|------|--------|
| 工作区配置 | `{workspace}/opencode.json` → `mcp` 字段 | 普通 MCP Server | 当前工作区 |
| 全局配置 | `~/.config/ultrawork/opencode.json` → `mcp` 字段 | Browser MCP | 跨工作区 |
| Sidecar 内存 | MCP Service 的 InstanceState | 运行时连接状态 + 工具缓存 | 当前进程 |
| OAuth 凭证 | `~/.local/share/ultrawork/mcp-auth.json`（权限 0o600） | OAuth token/client info | 全局 |

### 3.2 opencode.json MCP 配置格式

```jsonc
{
  "mcp": {
    "my-local-server": {
      "type": "local",
      "command": ["bunx", "@anthropic/mcp-server"],
      "environment": { "API_KEY": "xxx" },
      "enabled": true,
      "timeout": 30000
    },
    "my-remote-server": {
      "type": "remote",
      "url": "https://mcp.example.com/sse",
      "headers": { "Authorization": "Bearer xxx" },
      "enabled": true,
      "timeout": 5000,
      "oauth": {
        "clientId": "my-client-id",
        "scope": "read write"
      }
    }
  }
}
```

### 3.3 Tauri Command 实现

**文件**: `src-tauri/src/lib.rs`

| Command | 行号 | 功能 |
|---------|------|------|
| `read_mcp_config(workspace)` | 765-768 | 读取 opencode.json 的 mcp 字段，不存在返回 `{}` |
| `write_mcp_config(workspace, name, config)` | 771-781 | 读取 → 合并 mcp[name] → 写回（upsert 语义） |
| `remove_mcp_config(workspace, name)` | 784-798 | 读取 → 删除 mcp[name] → 清理空 mcp 对象 → 写回 |

### 3.4 前端状态合并逻辑

**文件**: `use-mcp-servers.ts:36-60`（`fetchMCP` 函数）

```
api.getMCP()               → statusMap (Sidecar 运行时状态)
invoke("read_mcp_config")  → configMap (磁盘持久化配置)

合并规则：
├─ 以 configMap 为主遍历
├─ 如果 statusMap 中有该 server → 使用 Sidecar 报告的状态
├─ 如果 statusMap 中没有 → 默认 { status: "disabled" }
└─ 过滤掉内置 server（如 "browser"，由 useBrowserMCP 单独管理）
```

### 3.5 localStorage 迁移

**文件**: `use-mcp-servers.ts:64-86`

早期版本使用 localStorage 存储 MCP 配置，现已迁移到 opencode.json。首次加载时执行一次性迁移：

```
检查 localStorage["ultrawork_mcp_configs"]
  ├─ 有值 → 逐条写入 opencode.json → 删除 localStorage keys
  └─ 无值 → 跳过
```

---

## 4. Sidecar 端 MCP 生命周期

### 4.1 启动时初始化

**文件**: `vendor/opencode/.../mcp/index.ts:480-541`

```
Sidecar 启动
  │
  ├─ InstanceState.make() 创建 MCP 服务状态
  │     state = { clients: {}, status: {}, defs: {} }
  │
  ├─ 读取 Config.Service 获取 mcp 配置
  │
  ├─ 遍历每个配置项（并发: "unbounded"，所有 server 并行连接）
  │     │
  │     ├─ 缺少 type 字段 → 跳过，日志警告
  │     │
  │     ├─ enabled: false → state.status[name] = { status: "disabled" }
  │     │
  │     └─ enabled: true → create(name, config)
  │           │
  │           ├─ type: "local"  → connectLocal()
  │           ├─ type: "remote" → connectRemote()
  │           │
  │           ├─ 连接成功 → client.listTools() → 缓存工具定义
  │           │     state.clients[name] = client
  │           │     state.status[name] = { status: "connected" }
  │           │     state.defs[name] = toolDefinitions
  │           │
  │           └─ watch(name) → 注册 ToolListChanged 通知监听
  │
  └─ 注册 finalizer（进程退出时清理所有子进程）
```

### 4.2 本地 MCP Server 连接

**文件**: `mcp/index.ts:380-410`

```typescript
// StdioClientTransport 配置
{
  command: config.command[0],           // 可执行文件，如 "node", "bunx"
  args: config.command.slice(1),        // 参数列表
  cwd: Instance.directory,              // 当前工作区目录
  env: { ...process.env, ...config.environment },  // 环境变量合并
  stderr: "pipe"                        // stderr 用于日志
}
```

**通信协议**: JSON-RPC over stdio（stdin/stdout）

```
Sidecar ──stdin──→ MCP Server 子进程
Sidecar ←─stdout── MCP Server 子进程
          stderr → 日志输出
```

### 4.3 远程 MCP Server 连接

**文件**: `mcp/index.ts:273-378`

```
connectRemote(name, config)
  │
  ├─ 构建 OAuth Provider（如果 config.oauth 不为 false）
  │     → McpOAuthProvider 实例
  │
  ├─ 尝试连接（降级策略）：
  │     │
  │     ├─ 优先: StreamableHTTPClientTransport
  │     │     → HTTP POST 双向通信（MCP 2025 规范）
  │     │
  │     └─ 降级: SSEClientTransport
  │           → Server-Sent Events 单向推送 + HTTP POST 请求
  │
  ├─ 连接结果：
  │     ├─ 成功 → 返回 { mcpClient, status: "connected" }
  │     │
  │     ├─ UnauthorizedError → 状态 "needs_auth"
  │     │     → 存储 transport 到 pendingOAuthTransports Map（供后续 OAuth 回调使用）
  │     │
  │     ├─ 动态注册失败 → 状态 "needs_client_registration"
  │     │
  │     └─ 其他错误 → 状态 "failed"，携带 error message
  │
  └─ 设置 headers（来自 config.headers）
```

**通信协议**: HTTP/SSE（JSON-RPC over HTTP）

### 4.4 连接状态机

```
                    ┌──────────────┐
        ┌───────────│   未配置      │
        │           └──────────────┘
        │
        ▼
  ┌─────────────┐    enabled: false    ┌─────────────┐
  │  配置加载    │ ──────────────────→ │  disabled    │
  └──────┬──────┘                     └──────┬──────┘
         │ enabled: true                     │ connect()
         ▼                                   ▼
  ┌─────────────┐                     ┌─────────────┐
  │  连接尝试    │ ──── 成功 ────────→ │  connected   │
  └──┬──┬──┬────┘                     └──────┬──────┘
     │  │  │                                 │ disconnect()
     │  │  │    OAuth 需要    ┌────────────┐  │
     │  │  └────────────────→│ needs_auth  │  │
     │  │                    └────────────┘  │
     │  │       注册失败      ┌─────────────────────────────┐
     │  └────────────────────→│ needs_client_registration   │
     │                        └─────────────────────────────┘
     │       其他错误         ┌─────────────┐
     └───────────────────────→│   failed     │
                              │  (+ error)   │
                              └─────────────┘
```

### 4.5 进程清理

**文件**: `mcp/index.ts:517-538`

Sidecar 退出时的 finalizer 逻辑：

```
遍历所有 connected clients
  │
  ├─ 获取 transport 的进程 PID
  ├─ pgrep -P <pid> → 查找所有子进程
  ├─ SIGTERM 逐一终止子进程
  ├─ 关闭 MCP client 连接
  └─ 清空 pendingOAuthTransports Map
```

### 4.6 HTTP API 端点

**文件**: `server/routes/mcp.ts`

| 方法 | 路径 | 行号 | 功能 |
|------|------|------|------|
| GET | `/mcp` | 11-31 | 返回所有 MCP Server 状态 |
| POST | `/mcp` | 32-61 | 动态添加 MCP Server（仅运行时，不持久化） |
| POST | `/mcp/:name/connect` | 179-201 | 连接指定 server |
| POST | `/mcp/:name/disconnect` | 203-224 | 断开指定 server |
| POST | `/mcp/:name/auth` | 63-94 | 启动 OAuth 流程 |
| POST | `/mcp/:name/auth/callback` | 96-126 | OAuth 回调（接收 authorization code） |
| POST | `/mcp/:name/auth/authenticate` | 128-154 | 完整 OAuth 流程（自动打开浏览器） |
| DELETE | `/mcp/:name/auth` | 156-178 | 删除 OAuth 凭证 |

---

## 5. MCP 工具注册与收集

### 5.1 工具获取

连接成功后，Sidecar 通过 MCP 协议获取 Server 提供的工具列表：

**文件**: `mcp/index.ts:163-174`（`defs` 函数）

```
client.listTools()
  │
  ├─ JSON-RPC 请求: { method: "tools/list" }
  │
  ├─ MCP Server 返回:
  │   {
  │     tools: [
  │       {
  │         name: "take_screenshot",
  │         description: "Take a screenshot of the current page",
  │         inputSchema: {
  │           type: "object",
  │           properties: {
  │             url: { type: "string", description: "URL to screenshot" }
  │           },
  │           required: ["url"]
  │         }
  │       },
  │       ...
  │     ]
  │   }
  │
  └─ 缓存到 state.defs[serverName] = tools
```

### 5.2 工具名称规则

**文件**: `mcp/index.ts:130, 638`

最终工具名 = `sanitize(serverName) + "_" + sanitize(toolName)`

sanitize 规则：将所有非 `[a-zA-Z0-9_-]` 字符替换为 `_`

```
示例：
  server="my-server", tool="list_files"    → "my-server_list_files"
  server="browser",   tool="take_screenshot" → "browser_take_screenshot"
  server="@org/mcp",  tool="search"        → "_org_mcp_search"
```

### 5.3 工具转换

**文件**: `mcp/index.ts:133-161`（`convertMcpTool` 函数）

每个 MCP 工具被转换为 AI SDK 的 `Tool` 对象：

```typescript
function convertMcpTool(mcpTool, client, timeout) {
  // 1. 规范化 Schema
  const schema = {
    ...mcpTool.inputSchema,
    type: "object",                    // 强制 object 类型
    properties: mcpTool.inputSchema.properties ?? {},
    additionalProperties: false,       // 禁止额外属性
  }

  // 2. 创建 AI SDK Tool
  return dynamicTool({
    description: mcpTool.description ?? "",
    inputSchema: jsonSchema(schema),

    // 3. 执行函数：调用 MCP Server
    execute: async (args) => {
      return client.callTool(
        { name: mcpTool.name, arguments: args || {} },
        CallToolResultSchema,
        { resetTimeoutOnProgress: true, timeout }  // 有 progress 时重置超时
      )
    },
  })
}
```

### 5.4 工具收集

**文件**: `mcp/index.ts:611-644`（`tools` 函数）

每次 AI 对话轮次开始前调用，收集所有可用 MCP 工具：

```
mcp.tools()
  │
  ├─ 从 state 中筛选 status === "connected" 的 clients
  │
  ├─ 对每个 connected client（并发执行）：
  │     │
  │     ├─ 获取缓存的 defs（tool definitions）
  │     │
  │     ├─ 确定 timeout 优先级：
  │     │     per-server config.timeout > experimental.mcp_timeout > DEFAULT_TIMEOUT (30s)
  │     │
  │     └─ 对每个 tool 调用 convertMcpTool()
  │           → result["serverName_toolName"] = convertedTool
  │
  └─ 返回 Record<string, Tool>
```

### 5.5 工具列表动态更新

**文件**: `mcp/index.ts:466-478`（`watch` 函数）

MCP Server 可以在运行时动态更新工具列表：

```
MCP Server 发送 ToolListChangedNotification
  │
  ▼ Sidecar 收到通知
  │
  ├─ 验证 client 仍在连接状态
  ├─ 重新调用 client.listTools()
  ├─ 更新缓存 state.defs[name]
  └─ 发布 ToolsChanged bus 事件
```

下一轮 AI 对话时，`mcp.tools()` 会自动获取到更新后的工具列表。

---

## 6. AI Agent 工具调用流程

这是整个 MCP 系统的核心——MCP 工具如何被 AI 模型发现、选择、执行。

### 6.1 工具解析与包装

**文件**: `session/prompt.ts:388-551`（`resolveTools` 函数）

每轮 AI 对话前，`resolveTools()` 收集并包装所有工具：

```
resolveTools()
  │
  ├─ 1. 收集内置工具（file, shell, browser 等）       [lines 436-474]
  │     → 从 registry.tools() 获取
  │     → 每个工具包装 plugin hooks + attachment 处理
  │
  ├─ 2. 收集 MCP 工具                                [lines 476-548]
  │     │
  │     ├─ mcp.tools() → 获取所有 connected server 的转换后工具
  │     │
  │     ├─ Schema 转换：ProviderTransform.schema(model, schema)
  │     │     → 针对不同 AI 模型适配 tool schema
  │     │     → 例：某些模型不支持 $ref，需要展开
  │     │
  │     └─ Execute 包装（五层嵌套）：
  │           │
  │           ├─ Layer 1: Plugin trigger "tool.execute.before"
  │           │
  │           ├─ Layer 2: Permission 检查                [line 492]
  │           │     ctx.ask({ permission: key, patterns: ["*"], always: ["*"] })
  │           │     → 首次调用需用户确认
  │           │
  │           ├─ Layer 3: 实际执行                       [lines 493-495]
  │           │     execute(args, opts) → client.callTool()
  │           │     → JSON-RPC via stdio/HTTP
  │           │     → MCP Server 执行工具逻辑
  │           │     → 返回 { content: [...] }
  │           │
  │           ├─ Layer 4: 输出转换                       [lines 502-543]
  │           │     content 数组中每个 item：
  │           │     ├─ type: "text"     → 提取文本，拼接
  │           │     ├─ type: "image"    → base64 → data:mime;base64,xxx
  │           │     └─ type: "resource" → text 提取 + blob → data URL
  │           │     → 文本输出经过 truncate.output() 截断
  │           │
  │           └─ Layer 5: Plugin trigger "tool.execute.after"
  │
  └─ 返回 Record<string, AITool>（内置 + MCP 合并）
```

### 6.2 工具传递给 AI 模型

**文件**: `session/prompt.ts:1460-1520`（`runLoop` 函数）

```
runLoop() — 主对话循环
  │
  ├─ resolveTools({agent, model, session, ...})
  │     → 获取所有可用工具（含 MCP）
  │
  ├─ handle.process({ tools, messages, model, ... })
  │     → 传递工具给 Session Processor
  │
  └─ Processor 调用 llm.stream()
```

**文件**: `session/llm.ts:259-333`（`stream` 函数）

```typescript
// AI SDK streamText 调用
streamText({
  model: wrappedModel,
  messages: formattedMessages,
  tools: filteredTools,                    // ← MCP 工具在此传入
  activeTools: Object.keys(tools).filter(x => x !== "invalid"),
  toolChoice: input.toolChoice,            // "auto" | "required" | "none"
  temperature: params.temperature,
  maxOutputTokens: maxOutputTokens,
  abortSignal: input.abort,

  // 工具名修复：模型可能返回大小写不一致的工具名
  experimental_repairToolCall(failed) {
    const lower = failed.toolCall.toolName.toLowerCase()
    if (lower !== failed.toolCall.toolName && tools[lower]) {
      return { ...failed.toolCall, toolName: lower }  // 修复大小写
    }
    return { ...failed.toolCall, toolName: "invalid" } // 标记为无效
  },
})
```

### 6.3 工具权限过滤

**文件**: `session/llm.ts:336-342`（`resolveTools` helper）

在传给 streamText 之前，还有一层权限过滤：

```typescript
function resolveTools(input) {
  // 获取被禁用的工具
  const disabled = Permission.disabled(
    Object.keys(input.tools),
    Permission.merge(input.agent.permission, input.permission ?? [])
  )
  // 过滤掉用户主动禁用 + 权限配置禁用的工具
  return Record.filter(input.tools, (_, k) =>
    input.user.tools?.[k] !== false && !disabled.has(k)
  )
}
```

### 6.4 工具执行事件流

**文件**: `session/processor.ts:111-365`（`handleEvent` 函数）

AI SDK 产生的 tool 事件通过 Stream 处理，形成完整的状态流转：

```
AI 模型决定调用工具
  │
  ├─ "tool-input-start" 事件                    [lines 153-166]
  │     → 创建 ToolPart，state: { status: "pending" }
  │     → SSE 推送 message.part.updated 到前端
  │     → 前端显示工具调用卡片（pending 状态）
  │
  ├─ "tool-call" 事件                           [lines 174-212]
  │     → 更新 state: { status: "running", input: args, time: { start } }
  │     → SSE 推送到前端
  │     → 前端显示工具正在执行
  │     → 此时 execute() 被调用（触发 Permission + 实际 MCP 调用）
  │     → Doom loop 检测（防止 AI 反复调用同一工具）
  │
  ├─ 执行成功 → "tool-result" 事件              [lines 215-231]
  │     → 更新 state: { status: "completed", output, metadata, time: { start, end } }
  │     → 附件（图片/文件）作为 attachments 存储
  │     → SSE 推送到前端
  │     → 前端显示工具执行结果
  │
  └─ 执行失败 → "tool-error" 事件               [lines 234-250]
        → 更新 state: { status: "error", error: message, time: { start, end } }
        → 如果是 Permission.RejectedError → 标记 blocked，中断循环
        → SSE 推送到前端
        → 前端显示错误信息
```

### 6.5 完整调用示例

以「AI 调用 Playwright MCP 截图」为例的完整链路：

```
用户: "帮我截一下 example.com 的截图"
  │
  ▼ Session.prompt_async 接收消息
  │
  ▼ resolveTools() 收集工具
  │   → 包含 "browser_browser_navigate", "browser_browser_screenshot" 等
  │
  ▼ streamText() 调用 AI 模型（如 Claude）
  │   → 模型分析用户意图
  │   → 模型决定先调用 browser_browser_navigate
  │   → 返回 tool_use: { name: "browser_browser_navigate", input: { url: "..." } }
  │
  ▼ "tool-input-start" → 前端显示 pending 卡片
  │
  ▼ "tool-call" → execute() 被调用
  │   │
  │   ├─ Plugin: tool.execute.before
  │   │
  │   ├─ Permission: ctx.ask(...)
  │   │     → 前端弹出 PermissionDock
  │   │     → 用户点「允许」或「始终允许」
  │   │     → POST /permission/{id}/reply { reply: "once" }
  │   │
  │   ├─ client.callTool("browser_navigate", { url: "..." })
  │   │     → JSON-RPC via stdio → Playwright MCP Server
  │   │     → Playwright 启动 Chromium → 导航到 URL
  │   │     → 返回 { content: [{ type: "text", text: "Navigated to ..." }] }
  │   │
  │   ├─ 输出转换: text → truncated output
  │   │
  │   └─ Plugin: tool.execute.after
  │
  ▼ "tool-result" → 前端显示执行结果
  │
  ▼ 模型继续决定调用 browser_browser_screenshot
  │   → 同样的 permission → execute → 返回图片 base64
  │   → 图片作为 attachment 显示在聊天中
  │
  ▼ 模型生成最终回复: "已截图，如下..."
```

---

## 7. Permission 系统

### 7.1 概述

MCP 工具执行前必须经过 Permission 系统检查。这是一个用户确认机制，防止 AI 未经授权执行敏感操作。

**文件**: `permission/index.ts`

### 7.2 权限动作

```typescript
Action = "allow" | "deny" | "ask"
```

### 7.3 权限评估流程

```
MCP 工具 execute 被调用
  │
  ▼ ctx.ask({ permission: "browser_take_screenshot", patterns: ["*"], always: ["*"] })
  │
  ▼ Permission Service.ask()                    [permission/index.ts:167-202]
  │   │
  │   ├─ 检查 ruleset（agent 默认规则 + session 临时规则）
  │   │     rule = evaluate(permission, pattern, ...rulesets)
  │   │
  │   ├─ 结果为 "allow" → 直接放行
  │   ├─ 结果为 "deny"  → 抛出 DeniedError
  │   └─ 结果为 "ask"   → 暂停执行，等待用户确认
  │         │
  │         ├─ 发布 Permission.Event.Asked
  │         │     → SSE 推送 permission.asked 到前端
  │         │     → 前端显示 PermissionDock
  │         │
  │         ├─ 等待用户回复（通过 Deferred 异步暂停）
  │         │
  │         └─ 用户回复（POST /permission/{id}/reply）
  │               │
  │               ├─ reply: "once"   → 放行本次
  │               ├─ reply: "always" → 放行 + 记录到 approved ruleset（持久化到 DB）
  │               └─ reply: "reject" → 抛出 RejectedError
  │                     → 级联拒绝同 session 的其他 pending 请求
  │                     → processor 标记 blocked，中断对话循环
```

### 7.4 权限配置

默认情况下，`general` agent 的权限规则为 `"*": "allow"`（允许所有工具）。可以在 `opencode.json` 中配置更严格的规则：

```jsonc
{
  "permission": {
    "edit": "ask",           // 文件编辑需确认
    "browser_*": "ask",      // 所有浏览器工具需确认
    "my-server_*": "deny"    // 禁止某个 MCP Server 的所有工具
  }
}
```

---

## 8. OAuth 认证流程

### 8.1 适用场景

远程 MCP Server 可能需要 OAuth 认证。当 Sidecar 连接远程 server 时遇到 `UnauthorizedError`，触发 OAuth 流程。

### 8.2 组件

| 组件 | 文件 | 功能 |
|------|------|------|
| McpOAuthProvider | `mcp/oauth-provider.ts` | 实现 MCP SDK 的 OAuthClientProvider 接口 |
| McpOAuthCallback | `mcp/oauth-callback.ts` | 本地 HTTP 回调服务器（`:19876`） |
| McpAuth | `mcp/auth.ts` | 凭证存储（文件系统，0o600 权限） |

### 8.3 完整 OAuth 流程

```
connectRemote() 遇到 UnauthorizedError
  │
  ▼ 状态设为 "needs_auth"
  │  → 前端显示「需要认证」状态
  │
  ▼ 用户触发认证（前端调用 POST /mcp/:name/auth/authenticate）
  │
  ▼ startAuth(name)                           [mcp/index.ts:713-759]
  │   │
  │   ├─ 确保 OAuth 回调服务器已启动（http://127.0.0.1:19876/mcp/oauth/callback）
  │   │
  │   ├─ 生成随机 32 字节 OAuth state（CSRF 保护）
  │   │
  │   ├─ 创建 McpOAuthProvider 实例
  │   │     clientMetadata:
  │   │       redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"]
  │   │       client_name: "OpenCode"
  │   │       grant_types: ["authorization_code", "refresh_token"]
  │   │       token_endpoint_auth_method: "none" (或 "client_secret_post")
  │   │
  │   ├─ 创建 transport（带 auth provider）
  │   │
  │   ├─ 发起 client.connect() → 触发 SDK 内部 OAuth 流程
  │   │     → SDK 发现需要认证 → 调用 redirectToAuthorization(url)
  │   │     → 捕获 authorization URL
  │   │
  │   └─ 存储 transport 到 pendingOAuthTransports[name]
  │
  ▼ authenticate(name)                        [mcp/index.ts:761-800]
  │   │
  │   ├─ 调用 startAuth() 获取 authorization URL
  │   │
  │   ├─ open(authorizationUrl) → 打开系统浏览器
  │   │     → 用户在浏览器中登录授权
  │   │
  │   ├─ waitForCallback(oauthState)
  │   │     → 等待回调服务器收到 authorization code
  │   │     → 超时: 5 分钟
  │   │     → CSRF: 验证 state 参数匹配
  │   │
  │   └─ finishAuth(name, code)               [mcp/index.ts:802-825]
  │         │
  │         ├─ 取出 pendingOAuthTransports[name]
  │         ├─ transport.finishAuth(code)
  │         │     → SDK 用 code 交换 access_token + refresh_token
  │         │     → 自动存储 token 到 mcp-auth.json
  │         ├─ createAndStore() → 重新连接
  │         └─ 返回 { status: "connected" }
```

### 8.4 凭证存储格式

**文件**: `~/.local/share/ultrawork/mcp-auth.json`

```jsonc
{
  "my-remote-server": {
    "serverUrl": "https://mcp.example.com",
    "tokens": {
      "accessToken": "eyJ...",
      "refreshToken": "eyJ...",
      "expiresAt": 1735689600,
      "scope": "read write"
    },
    "clientInfo": {
      "clientId": "dynamic-client-id",
      "clientSecret": "dynamic-secret",
      "clientIdIssuedAt": 1735600000,
      "clientSecretExpiresAt": 1767136000
    },
    "codeVerifier": "dBjftJeZ4CVP-mB92K27uhbUJU1p1r...",  // PKCE
    "oauthState": "random-32-byte-hex"                      // CSRF
  }
}
```

---

## 9. Browser MCP 特殊流程

Browser MCP 是内置的特殊 MCP Server，有独立的安装、检测、模式切换逻辑。

### 9.1 环境检测

**文件**: `lib.rs:692-723`（`detect_browser_env` Tauri command）

```
检测项：
├─ Node.js
│   ├─ 内嵌 Node: ~/.ultrawork/node/bin/node
│   └─ 系统 Node: which node
│   → 返回 path, version, embedded 标记
│
├─ Chrome
│   → macOS: /Applications/Google Chrome.app/...
│
├─ MCP 安装状态
│   ├─ Playwright: ~/.ultrawork/mcp/playwright/node_modules/@playwright/mcp/cli.js
│   └─ DevTools: ~/.ultrawork/mcp/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js
│
└─ 当前模式: ~/.ultrawork/browser-mode.json
```

### 9.2 安装流程

**文件**: `use-browser-mcp.ts:137-185`（`setup` 函数）

```
用户点击「安装 Browser MCP」
  │
  ├─ Step 1: 下载 Node.js（如果未安装）
  │     invoke("download_node")
  │     → 下载 Node.js v22 到 ~/.ultrawork/node/
  │
  ├─ Step 2: 安装 MCP 包
  │     invoke("install_playwright_mcp") 或 invoke("install_devtools_mcp")
  │     │
  │     └─ npm_install_in()                    [lib.rs:620-652]
  │           ├─ 创建 ~/.ultrawork/mcp/{mode}/ 目录
  │           ├─ 生成 package.json
  │           ├─ 定位 npm-cli.js（从 node binary 相对路径推导）
  │           └─ 执行: node npm-cli.js install @playwright/mcp@latest
  │
  └─ Step 3: 注册到 Sidecar
        registerMcp()                          [use-browser-mcp.ts:101-115]
        │
        ├─ 构建命令: [node_path, entry_point, ...args]
        ├─ 持久化到全局配置: invoke("write_mcp_config", { workspace: globalConfigDir, ... })
        ├─ api.createMCP("browser", config)
        └─ api.connectMCP("browser")
```

### 9.3 模式切换

**文件**: `use-browser-mcp.ts:187-230`（`switchMode` 函数）

两种模式：
- **Playwright**（推荐）: 无头浏览器，截图/交互/表单填写
- **DevTools**: Chrome DevTools Protocol，开发者工具级别的控制

```
用户点击模式切换
  │
  ├─ 持久化偏好: invoke("set_browser_mode", { mode })
  ├─ 杀死现有浏览器进程: invoke("kill_browser_mcp_processes")
  ├─ 断开旧 MCP: api.disconnectMCP("browser")
  ├─ 如果新模式已安装 → registerMcp() 重新连接
  └─ Toast 提示
```

### 9.4 自动恢复

**文件**: `use-browser-mcp.ts:118-135`

App 启动时自动检测并恢复 Browser MCP：

```
useBrowserMCP hook 挂载
  │
  ├─ detect_browser_env() → 检测安装状态
  │
  └─ 如果已安装且 Sidecar 未报告连接状态
        → registerMcp() 重新注册 + 连接
```

---

## 10. 完整数据流图

### 10.1 添加 → 连接 → 使用全流程

```
╔══════════════════════════════════════════════════════════════════════════╗
║                           用户添加 MCP Server                          ║
╚═════════════════════════════════╤════════════════════════════════════════╝
                                  │
              ┌───────────────────▼───────────────────┐
              │        useMCPServers.handleAdd()       │
              └───────┬───────────────────────┬───────┘
                      │                       │
         ┌────────────▼────────────┐  ┌──────▼───────────────────┐
         │  Tauri: write_mcp_config │  │ HTTP: POST /mcp          │
         │  → opencode.json 持久化  │  │ → Sidecar 运行时连接      │
         └────────────┬────────────┘  └──────┬───────────────────┘
                      │                       │
                      │               ┌──────▼───────────────────┐
                      │               │  MCP Service: create()    │
                      │               │  → connectLocal/Remote()  │
                      │               │  → client.listTools()     │
                      │               │  → 缓存 tool definitions  │
                      │               └──────┬───────────────────┘
                      │                       │
              ┌───────▼───────────────────────▼───────┐
              │         前端状态更新                     │
              │   statusMap + configMap → UI 渲染       │
              └───────────────────────────────────────┘

╔══════════════════════════════════════════════════════════════════════════╗
║                           用户发起对话                                 ║
╚═════════════════════════════════╤════════════════════════════════════════╝
                                  │
              ┌───────────────────▼───────────────────┐
              │    POST /session/:id/prompt_async      │
              └───────────────────┬───────────────────┘
                                  │
              ┌───────────────────▼───────────────────┐
              │         resolveTools()                 │
              │   ├─ 内置工具（file, shell...）        │
              │   └─ MCP 工具 ← mcp.tools()           │
              │       → Schema 转换                    │
              │       → Execute 包装（5 层）           │
              └───────────────────┬───────────────────┘
                                  │
              ┌───────────────────▼───────────────────┐
              │         streamText() / AI SDK          │
              │   model + messages + tools → AI 模型   │
              └───────────────────┬───────────────────┘
                                  │
                          AI 模型决定调用工具
                                  │
              ┌───────────────────▼───────────────────┐
              │       Tool Execute Pipeline            │
              │   1. Plugin: before                    │
              │   2. Permission: ask → 用户确认         │
              │   3. client.callTool() → MCP Server    │
              │   4. 输出转换（text/image/resource）    │
              │   5. Plugin: after                     │
              └───────────────────┬───────────────────┘
                                  │
              ┌───────────────────▼───────────────────┐
              │      Processor: handleEvent()          │
              │   pending → running → completed/error  │
              │   → SSE 推送到前端 → UI 更新            │
              └───────────────────┬───────────────────┘
                                  │
                          AI 模型生成最终回复
```

### 10.2 超时机制

```
超时优先级（从高到低）：
1. per-server config.timeout        （单个 server 配置，如 60000）
2. experimental.mcp_timeout          （全局实验性配置）
3. DEFAULT_TIMEOUT = 30000ms         （硬编码默认值）

特殊机制：
- resetTimeoutOnProgress: true
  → MCP Server 发送 progress notification 时重置计时器
  → 适用于长时间执行但持续有输出的工具（如浏览器截图）
```

---

## 11. 关键文件索引

### 前端（React + Tauri）

| 文件 | 路径 | 核心功能 |
|------|------|---------|
| use-mcp-servers.ts | `packages/client/desktop/src/lib/` | MCP 状态管理主 hook（statusMap, configMap, CRUD） |
| use-browser-mcp.ts | `packages/client/desktop/src/lib/` | Browser MCP 安装/检测/模式切换 |
| Settings.tsx | `packages/client/desktop/src/pages/` | ServicesSection + ServiceAddForm + JsonImportForm |
| mcp-panel.tsx | `packages/client/desktop/src/components/session/` | 侧边栏 MCP 面板 |
| client.ts | `packages/core/api-client/src/` | getMCP, createMCP, connectMCP, disconnectMCP |
| types.ts | `packages/core/api-client/src/` | MCPConfig, MCPStatus, MCPStatusMap 类型定义 |
| lib.rs | `packages/client/desktop/src-tauri/src/` | Tauri commands（read/write/remove_mcp_config, browser MCP helpers） |

### 后端（OpenCode Sidecar）

| 文件 | 路径 | 核心功能 |
|------|------|---------|
| mcp/index.ts | `vendor/opencode/.../src/mcp/` | MCP Service 主文件（连接管理、工具收集、工具转换） |
| mcp/auth.ts | `vendor/opencode/.../src/mcp/` | OAuth 凭证存储（mcp-auth.json） |
| mcp/oauth-provider.ts | `vendor/opencode/.../src/mcp/` | OAuth Provider 实现（PKCE, token 管理） |
| mcp/oauth-callback.ts | `vendor/opencode/.../src/mcp/` | OAuth 回调 HTTP 服务器（:19876） |
| server/routes/mcp.ts | `vendor/opencode/.../src/server/routes/` | HTTP API 路由（8 个端点） |
| session/prompt.ts | `vendor/opencode/.../src/session/` | resolveTools()（工具收集 + 包装 + Permission） |
| session/llm.ts | `vendor/opencode/.../src/session/` | streamText()（工具传递给 AI SDK + 模型） |
| session/processor.ts | `vendor/opencode/.../src/session/` | handleEvent()（工具执行状态流转 + SSE 推送） |
| permission/index.ts | `vendor/opencode/.../src/permission/` | Permission 评估 + ask/reply 机制 |
| config/config.ts | `vendor/opencode/.../src/config/` | MCP 配置 Schema（McpLocal, McpRemote, McpOAuth） |
