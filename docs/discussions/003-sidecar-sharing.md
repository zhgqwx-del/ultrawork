# Discussion 003: OpenCode Sidecar 能力共享 — 多进程复用方案

- **日期**: 2026-05-13
- **状态**: 讨论中
- **参与者**: 用户 + Claude

---

## 背景与需求

OpenCode 作为 Ultrawork 的 sidecar，提供了完整的 AI Agent 能力（会话管理、代码编辑、MCP 工具、文件操作等）。当前架构下它是 Ultrawork 独占的。

**需求**：让其他进程（CLI 工具、自动化脚本、第三方客户端等）也能复用 OpenCode 的 AI 能力，同时不影响 Ultrawork 的正常使用。

---

## 当前架构约束

通过源码调研，确认以下关键事实：

### 端口与启动

| 项目 | 现状 |
|------|------|
| 默认端口 | 4096（hardcoded in `lib.rs:10`） |
| 启动方式 | `opencode-server serve --port 4096`（Tauri sidecar） |
| 端口回退 | `server.ts:289`：`port===0` 时先尝试 4096，再 fallback 到随机端口 |
| 认证 | Basic Auth，密码通过 `OPENCODE_SERVER_PASSWORD` 环境变量设置 |

### `--port` 支持（已确认 ✅）

**OpenCode 原生支持 `--port` 参数**。调研路径：

```
cli/cmd/serve.ts → withNetworkOptions(yargs)
  → cli/network.ts → options.port = { type: "number", default: 0 }
    → resolveNetworkOptions() → 优先 CLI 参数 > config.server.port > default
      → Server.listen({ port, hostname, ... })
```

完整的网络选项：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--port` | 监听端口 | 0（自动：先试 4096，再随机） |
| `--hostname` | 监听地址 | `127.0.0.1` |
| `--mdns` | 启用 mDNS 服务发现 | false |
| `--mdns-domain` | mDNS 域名 | `opencode.local` |
| `--cors` | 额外允许的 CORS 域名 | `[]` |

**也支持 `opencode.json` 配置**（`config.ts:783-791`）：

```json
{
  "server": {
    "port": 5096,
    "hostname": "127.0.0.1",
    "cors": ["http://localhost:3000"]
  }
}
```

优先级：CLI 参数 > opencode.json > 默认值。

### 工作区路由（关键发现 ✅）

**OpenCode 服务端支持动态工作区路由**。`server/router.ts:30` 显示：

```typescript
const raw = c.req.query("directory")
  || c.req.header("x-opencode-directory")
  || process.cwd()
```

每个请求可以通过以下方式指定工作目录：
1. Query 参数：`?directory=/path/to/project`
2. 请求头：`X-OpenCode-Directory: /path/to/project`
3. 默认：服务器启动时的 `process.cwd()`

这意味着**单个 OpenCode 实例理论上可以服务多个工作区**，每个请求独立路由到不同的 Project Instance。

### 隔离边界

| 资源 | 隔离级别 | 说明 |
|------|---------|------|
| Session | ✅ 按工作区隔离 | 不同 directory 各自独立 |
| Config | ⚠️ 全局共享 | `PATCH /config` 写全局磁盘配置 |
| MCP 服务 | ⚠️ 全局共享 | 所有工作区共享同一组 MCP 连接 |
| Provider/Auth | ✅ 全局共享（利好） | API Key 一处配置，处处可用 |
| SSE 事件流 | ⚠️ 部分隔离 | 全局事件（`/global/event`）共享；工作区事件需加 `?directory=` |
| SQLite 数据库 | ⚠️ 共享 | 全局一个 DB，按 project_id 区分 |

---

## 方案评估

### 方案 A：共享现有实例（直接暴露 4096）

```
外部进程 ──(?directory=X)──► OpenCode :4096
Ultrawork ──(?directory=Y)──► OpenCode :4096
```

**做法**：外部进程直接连 Ultrawork 已启动的 OpenCode 实例，通过 `?directory=` 或 `X-OpenCode-Directory` 头指定自己的工作目录。

**优点**：
- 零额外资源——不需要启动新 OpenCode 实例
- Session 通过 directory 天然隔离
- Provider/Auth 配置共享，无需重复配 API Key
- 实现最简单——外部进程只需知道 `localhost:4096` + auth

**缺点**：
- ⚠️ **Config 写冲突**：`PATCH /config` 是全局的，外部进程改 config 影响 Ultrawork
- ⚠️ **MCP 服务冲突**：外部进程注册的 MCP 工具对 Ultrawork 可见
- ⚠️ **Auth 共享**：密码 hardcoded `test123`，等于无认证
- ⚠️ **稳定性耦合**：外部进程的重负载可能拖慢 Ultrawork
- ⚠️ **生命周期依赖**：Ultrawork 关闭时 sidecar 一起关，外部进程断连

**适用场景**：受信任的内部工具、快速原型验证。

**评估**：**短期可用，长期不推荐**。适合"同一个人的另一个脚本"场景，不适合独立产品。

---

### 方案 B：独立实例（Multi-Instance）

```
Ultrawork ──► OpenCode :4096 (cwd=workspace-A)
外部进程  ──► OpenCode :5096 (cwd=workspace-B)
```

**做法**：为外部进程启动独立的 OpenCode 实例，绑定不同端口和工作目录。

**优点**：
- ✅ **完全隔离**：独立的 config、session、MCP、SSE 流
- ✅ **互不干扰**：各实例崩溃不影响其他
- ✅ **已验证可行**：`--port` 参数原生支持
- ✅ **简单直接**：外部进程自己管理自己的 OpenCode 生命周期

**缺点**：
- ⚠️ **资源翻倍**：每个实例一个进程 + SQLite（空闲约 50-80MB）
- ⚠️ **端口管理**：需要端口分配机制避免冲突
- ⚠️ **Provider 配置重复**：除非共享全局 `~/.config/ultrawork/opencode.json`
- ⚠️ **二进制分发**：外部进程需要能找到 OpenCode 二进制文件

**实现要点**：
1. 提供 launcher 脚本：`ultrawork-agent --port 5096 --dir /path/to/project`
2. Provider/Auth 配置共享全局 config（`OPENCODE_CONFIG_DIR` 环境变量指向同一目录）
3. 端口分配：固定端口段（如 5096-5099）或随机端口 + 端口文件发现

**评估**：**最推荐的通用方案**。隔离最干净，实现成本低。

---

### 方案 C：共享实例 + API 网关（命名空间隔离）

```
外部进程 ──► API Gateway :5000 ──► OpenCode :4096
Ultrawork ──────────────────────► OpenCode :4096
```

**做法**：在 OpenCode 前面加一个智能网关层，为不同调用者维护独立的「命名空间」——拦截 config 修改、过滤 SSE 事件、注入 directory 参数。

**优点**：
- 单实例，节省资源
- 可以精细控制权限（只读、禁止 config 修改等）

**缺点**：
- ⚠️ **开发成本高**：需要逐个 API 做命名空间映射
- ⚠️ **维护负担**：OpenCode 每次更新 API 都需要同步网关
- ⚠️ **不完全隔离**：MCP、全局状态仍然共享
- ⚠️ **命名空间泄漏风险**：遗漏的路由穿透隔离

**评估**：**不推荐**。复杂度远高于方案 B，收益不对称。

---

### 方案 D：MCP Server 封装

```
外部 AI 客户端 ──(MCP protocol)──► Ultrawork MCP Adapter ──► OpenCode :4096
```

**做法**：将 OpenCode 的能力封装成一个 MCP Server，外部 AI 客户端（Claude Desktop、Cursor 等）通过标准 MCP 协议调用。

**优点**：
- ✅ **标准协议**：任何支持 MCP 的客户端即插即用
- ✅ **能力裁剪**：只暴露选定工具，不暴露 config/session 管理
- ✅ **认证可控**：MCP 层可以加独立认证

**缺点**：
- ⚠️ **语义转换**：MCP tool-call 模型和 OpenCode session/prompt 模型差异大
- ⚠️ **流式能力受限**：MCP 当前对长 streaming 支持不足
- ⚠️ **不适合完整复用**：只适合暴露部分工具能力

**适用场景**：让其他 AI 客户端调用 Ultrawork 管理的 MCP 工具集。

**评估**：**补充方案**。适合特定场景（tool 共享），不适合完整能力复用。

---

### 方案 E：ACP 协议（Agent Client Protocol）

```
外部进程 ──stdio (ndjson)──► opencode-server acp --cwd /project
                                    │
                                    ├── 内部启动 HTTP Server（自动分配端口）
                                    └── 通过 OpenCode SDK 自调用
```

**做法**：外部进程通过 `opencode-server acp` 启动独立的 OpenCode 实例，通过 stdin/stdout 的 ndjson 流按 ACP 标准协议通信。OpenCode 已内置完整的 ACP 实现（`@agentclientprotocol/sdk` v0.16.1）。

**关键机制**：ACP 模式下 OpenCode 自己启动一个 HTTP server 并通过 SDK 自调用（`acp.ts:26-29`），外部进程不需要知道端口、不需要处理 HTTP/SSE。

**已支持的 ACP 操作**（源码 `acp/agent.ts`）：

| ACP 方法 | 说明 |
|----------|------|
| `initialize` | 协商协议版本、能力声明（loadSession, fork, resume, MCP, image 等） |
| `newSession` | 创建新 session（含 MCP 服务注册） |
| `loadSession` | 加载已有 session + 回放历史消息 |
| `listSessions` | 列出 session（支持分页游标） |
| `forkSession` | Fork session（unstable） |
| `resumeSession` | 恢复 session（unstable） |
| `prompt` | 发送消息（支持 text/image/resource_link/resource + `/command` 路由） |
| `cancel` | 中止正在进行的处理 |
| `setSessionModel` | 切换模型（unstable） |
| `setSessionMode` | 切换 agent 模式 |

ACP 还自动桥接以下交互，外部进程无需手动处理：
- **权限请求** → `connection.requestPermission()` → 客户端回复 → 自动调用 `/permission/reply`
- **流式文本/推理** → `agent_message_chunk` / `agent_thought_chunk` 实时推送
- **Tool call 状态机** → pending → running → completed/error 全生命周期推送
- **文件写入通知** → edit 工具完成时 `connection.writeTextFile()` 通知客户端
- **TODO/Plan 同步** → todowrite 输出自动转为 ACP plan entries
- **Usage 统计** → 每轮 prompt 完成后推送 token/cost 数据

**优点**：
- ✅ **零端口管理** — 内部自动分配端口，外部只管 stdin/stdout
- ✅ **天然安全** — 进程管道通信，无网络端口暴露
- ✅ **完全隔离** — 每个 ACP 连接独立进程 + 独立 HTTP server + 独立 DB
- ✅ **协议已封装复杂逻辑** — 权限、流式、tool call 状态等不需要外部进程自己实现
- ✅ **标准协议** — Zed 等编辑器已原生支持 ACP
- ✅ **已有完整实现** — OpenCode 的 ACP agent 已经实现好了，零开发成本

**缺点**：
- ⚠️ **stdio 绑定** — 外部进程必须能 spawn 子进程并接管 stdin/stdout，不适合 Web 服务/远程调用
- ⚠️ **每次启动完整实例** — 每个 ACP 连接一个进程 + SQLite（资源开销同方案 B）
- ⚠️ **协议成熟度** — 部分方法仍有 `unstable_` 前缀，协议在演进中
- ⚠️ **不复用 Ultrawork 实例** — 启动新进程，不连接 Ultrawork 已有的 sidecar

**ACP vs HTTP API 对比**：

| 维度 | HTTP API（方案 A/B） | ACP |
|------|---------------------|-----|
| 传输层 | HTTP + SSE | stdio ndjson |
| 端口管理 | 需要手动分配/发现 | 不需要 |
| 认证 | Basic Auth（需管理 token） | 不需要（进程级隔离） |
| 实时事件 | 需要订阅 SSE + 解析 | 自动推送 |
| 权限处理 | 轮询 + 手动 reply | SDK 自动桥接 |
| MCP 服务 | 需要手动注册 | newSession 参数声明即可 |
| API 复杂度 | 60+ 个 HTTP 端点 | 7 个 ACP 方法 |
| 适用场景 | 网络服务 / 远程调用 | 本地进程 / IDE 集成 |

**评估**：**本地场景的最优方案**。本质是"方案 B + 标准协议封装"，解决了 launcher 方案中最麻烦的问题（端口、认证、事件流、权限交互），且零开发成本。

---

### 方案 F：Unix Socket + 多租户（长期演进）

```
Ultrawork ──► /tmp/ultrawork-main.sock
外部进程  ──► /tmp/ultrawork-ext.sock
               ↕
           OpenCode (多工作区 + 多租户)
```

**做法**：推动 OpenCode 上游支持原生多租户，通过 Unix Domain Socket 替代 TCP 端口。

**优点**：无端口冲突，文件系统权限天然认证，真正多租户。

**缺点**：依赖 upstream 大改，周期不可控。

**评估**：**理想但不现实**。作为长期方向参考。

---

## 总结对比

| 维度 | A 共享实例 | B 多实例 | C API 网关 | D MCP 封装 | E ACP 协议 | F UDS 多租户 |
|------|-----------|---------|-----------|-----------|-----------|-------------|
| 隔离性 | ⚠️ 弱 | ✅ 完全 | ⚠️ 中等 | ✅ 好 | ✅ 完全 | ✅ 完全 |
| 资源开销 | ✅ 最低 | ⚠️ 线性增长 | ✅ 低 | ✅ 低 | ⚠️ 线性增长 | ✅ 低 |
| 开发成本 | ✅ 极低 | ✅ 低 | ❌ 高 | ⚠️ 中 | ✅ **零** | ❌ 极高 |
| 工作区灵活性 | ✅ 动态路由 | ✅ 任意 | ✅ 动态路由 | ❌ 受限 | ✅ 任意 | ✅ 任意 |
| 维护负担 | ✅ 无 | ✅ 低 | ❌ 高 | ⚠️ 中 | ✅ 无 | ❌ 高 |
| 生命周期独立 | ❌ 依赖 Ultrawork | ✅ 独立 | ❌ 依赖 | ❌ 依赖 | ✅ 独立 | ✅ 独立 |
| 安全性 | ❌ 弱 auth | ⚠️ 需要 token | ⚠️ 需要设计 | ✅ 可控 | ✅ 天然安全 | ✅ 文件权限 |
| 网络服务适用 | ✅ | ✅ | ✅ | ✅ | ❌ 仅本地 | ✅ |
| 落地速度 | 即时 | 1-2 天 | 1-2 周 | 3-5 天 | **即时** | 不可控 |

---

## 外部进程可用 API 完整参考

> 所有请求需携带认证头 `Authorization: Basic b3BlbmNvZGU6dGVzdDEyMw==`（即 `opencode:test123`）。
>
> 工作区路由：每个请求可通过 `?directory=/path/to/project` 或 `X-OpenCode-Directory` 请求头指定工作目录，未指定则使用服务器启动时的 `process.cwd()`。
>
> Base URL: `http://localhost:4096`

### 1. 全局 API（`/global/*`）— 不受 directory 路由影响

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/global/health` | 健康检查 | — | `{ healthy: true, version: string }` |
| `GET` | `/global/event` | 全局 SSE 事件流 | — | SSE stream: `{ directory: string, payload: Event }` |
| `GET` | `/global/sync-event` | 全局同步事件流 | — | SSE stream |
| `GET` | `/global/config` | 获取全局配置 | — | `Config.Info` |
| `PATCH` | `/global/config` | **更新全局配置** | body: `Config.Info` | `Config.Info` |
| `POST` | `/global/dispose` | 释放所有实例 | — | `true` |
| `POST` | `/global/upgrade` | 升级 OpenCode | body: `{ target?: string }` | `{ success: true, version } \| { success: false, error }` |

> **外部进程应避免调用**：`PATCH /global/config`、`POST /global/dispose`、`POST /global/upgrade`

### 2. 认证 API（`/auth/*`）— 全局路由

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `PUT` | `/auth/:providerID` | 设置 Provider 认证凭据 | body: `Auth.Info` | `true` |
| `DELETE` | `/auth/:providerID` | 删除 Provider 认证凭据 | — | `true` |

### 3. Session API（`/session/*`）— 核心对话能力

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/session` | 列出所有 session | query: `directory?`, `roots?` (boolean), `start?` (timestamp ms), `search?`, `limit?` | `Session.Info[]` |
| `GET` | `/session/status` | 所有 session 状态 | — | `Record<string, SessionStatus>` |
| `POST` | `/session` | 创建 session | body: `{ parentID?, title?, permission?, workspaceID? }` (可选) | `Session.Info` |
| `GET` | `/session/:id` | 获取 session 详情 | — | `Session.Info` |
| `PATCH` | `/session/:id` | 更新 session | body: `{ title?, time?: { archived?: number } }` | `Session.Info` |
| `DELETE` | `/session/:id` | 删除 session | — | `true` |
| `GET` | `/session/:id/children` | 获取子 session | — | `Session.Info[]` |
| `GET` | `/session/:id/todo` | 获取 TODO 列表 | — | `Todo.Info[]` |
| `POST` | `/session/:id/init` | 初始化 session（生成 AGENTS.md） | body: `{ ... }` | `true` |
| `POST` | `/session/:id/fork` | Fork session | body: `{ messageID?, ... }` | `Session.Info` |
| `POST` | `/session/:id/abort` | 中止当前处理 | — | `true` |
| `POST` | `/session/:id/share` | 分享 session | — | `Session.Info` |
| `DELETE` | `/session/:id/share` | 取消分享 | — | `Session.Info` |
| `GET` | `/session/:id/diff` | 获取消息的文件变更 | query: `messageID` | `FileDiff[]` |
| `POST` | `/session/:id/revert` | 撤回消息 | body: `{ messageID, ... }` | `Session.Info` |
| `POST` | `/session/:id/unrevert` | 恢复撤回 | — | `Session.Info` |
| `POST` | `/session/:id/summarize` | AI 摘要 | body: `{ providerID, modelID, auto?: boolean }` | `true` |

### 4. 消息 API（`/session/:id/message/*`）— 发送与读取消息

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/session/:id/message` | 获取消息列表 | query: `limit?`, `before?` (cursor) | `Message[]`，分页时响应头 `X-Next-Cursor` |
| `GET` | `/session/:id/message/:msgID` | 获取单条消息 | — | `{ info: Message, parts: Part[] }` |
| `DELETE` | `/session/:id/message/:msgID` | 删除消息 | — | `true` |
| `POST` | `/session/:id/message` | **同步发送消息**（阻塞直到 AI 回复） | body: PromptInput（见下方） | `{ info: Message, parts: Part[] }` |
| `POST` | `/session/:id/prompt_async` | **异步发送消息**（立即返回 204） | body: PromptInput（见下方） | `204 No Content` |
| `POST` | `/session/:id/command` | 发送命令 | body: CommandInput（见下方） | `{ info: Message, parts: Part[] }` |
| `POST` | `/session/:id/shell` | 执行 shell 命令 | body: ShellInput（见下方） | `Message` |

#### PromptInput 结构（`POST /session/:id/message` 和 `prompt_async` 的 body）

```typescript
{
  // model 覆盖（可选，不传则用 session 或 agent 默认模型）
  model?: {
    providerID: string,  // e.g. "anthropic", "openai"
    modelID: string      // e.g. "claude-sonnet-4-20250514"
  },
  agent?: string,         // agent 名称，默认 "general"
  noReply?: boolean,      // true=只创建用户消息，不触发 AI 回复
  variant?: string,       // 模型变体
  system?: string,        // 附加系统提示
  format?: {              // 结构化输出
    type: "json",
    schema: Record<string, any>
  },
  parts: [                // 消息内容（至少一个）
    // 文本消息
    { type: "text", text: string },
    // 文件附件
    { type: "file", mime: string, url: string, filename?: string },
    // Agent 子任务
    { type: "agent", agent: string, text: string },
    // 子任务
    { type: "subtask", text: string }
  ]
}
```

#### CommandInput 结构（`POST /session/:id/command` 的 body）

```typescript
{
  command: string,       // 命令名称
  arguments: string,     // 命令参数（字符串形式）
  agent?: string,
  model?: string,
  variant?: string,
  parts?: [              // 文件附件（可选）
    { type: "file", mime: string, url: string, filename?: string }
  ]
}
```

#### ShellInput 结构（`POST /session/:id/shell` 的 body）

```typescript
{
  agent: string,          // agent 名称（必填）
  command: string,        // shell 命令
  model?: {
    providerID: string,
    modelID: string
  }
}
```

### 5. Part API（`/session/:id/message/:msgID/part/*`）

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `PATCH` | `/session/:id/message/:msgID/part/:partID` | 更新 part | body: `MessageV2.Part`（完整 part 对象） | `Part` |
| `DELETE` | `/session/:id/message/:msgID/part/:partID` | 删除 part | — | `true` |

### 6. Permission API（`/permission/*`）— 处理工具调用权限请求

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/permission` | 列出待处理的权限请求 | — | `Permission.Request[]` |
| `POST` | `/permission/:requestID/reply` | 回复权限请求 | body: `{ reply: "once" \| "always" \| "reject", message?: string }` | `true` |

### 7. Question API（`/question/*`）— 处理 AI 提问

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/question` | 列出待回答的问题 | — | `Question.Request[]` |
| `POST` | `/question/:requestID/reply` | 回答问题 | body: `{ answers: string[][] }` | `true` |
| `POST` | `/question/:requestID/reject` | 拒绝回答 | — | `true` |

### 8. SSE 事件流（`/event`）— 工作区级实时事件

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/event` | 工作区 SSE 事件流 | `?directory=` 指定工作区 | SSE stream |

**关键事件类型**：
- `server.connected` — 连接成功
- `server.heartbeat` — 心跳（每 10s）
- `session.updated` — session 状态变更
- `message.updated` — 消息更新
- `message.part.updated` — part 完整更新
- `message.part.delta` — part 增量更新（streaming 文本）
- `message.part.removed` — part 删除
- `permission.asked` — 权限请求
- `question.asked` — AI 提问
- `session.error` — session 错误
- `server.instance.disposed` — 实例释放

### 9. Provider API（`/provider/*`）— 查询可用模型

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/provider` | 列出所有 provider 和模型 | — | `{ all: Provider[], default: Record<string,string>, connected: string[] }` |
| `GET` | `/provider/auth` | 获取认证方式列表 | — | `Record<string, AuthMethod[]>` |
| `POST` | `/provider/:id/oauth/authorize` | 发起 OAuth | body: `{ method: number, inputs?: Record<string,string> }` | `{ url, method }` |
| `POST` | `/provider/:id/oauth/callback` | OAuth 回调 | body: `{ method: number, code?: string }` | `true` |

### 10. Config API（`/config/*`）— 工作区级配置

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/config` | 获取当前工作区配置 | — | `Config.Info` |
| `PATCH` | `/config` | **更新工作区配置** | body: `Config.Info` | `Config.Info` |
| `GET` | `/config/providers` | 获取已配置的 provider | — | `{ providers: Provider[], default: Record<string,string> }` |

> **外部进程应避免调用**：`PATCH /config`

### 11. MCP API（`/mcp/*`）— MCP 服务管理

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/mcp` | 获取 MCP 状态 | — | `Record<string, MCP.Status>` |
| `POST` | `/mcp` | **添加 MCP 服务** | body: `{ name, config: McpConfig }` | `Record<string, MCP.Status>` |
| `POST` | `/mcp/:name/connect` | 连接 MCP | — | `true` |
| `POST` | `/mcp/:name/disconnect` | 断开 MCP | — | `true` |
| `POST` | `/mcp/:name/auth` | 发起 MCP OAuth | — | `{ authorizationUrl }` |
| `POST` | `/mcp/:name/auth/callback` | MCP OAuth 回调 | body: `{ code }` | `MCP.Status` |
| `POST` | `/mcp/:name/auth/authenticate` | MCP OAuth 完整流程 | — | `MCP.Status` |
| `DELETE` | `/mcp/:name/auth` | 删除 MCP OAuth 凭据 | — | `{ success: true }` |

> **外部进程应避免调用**：`POST /mcp`（添加）、`POST /mcp/:name/connect|disconnect`

### 12. File API（文件操作）

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/file` | 列出目录文件 | query: `path` (相对路径) | `File.Node[]` |
| `GET` | `/file/content` | 读取文件内容 | query: `path` (相对路径) | `File.Content` |
| `GET` | `/file/status` | 获取 git 文件状态 | — | `File.Info[]` |
| `GET` | `/find` | 全文搜索 (ripgrep) | query: `pattern` | `Match[]` |
| `GET` | `/find/file` | 搜索文件名 | query: `query`, `dirs?`, `type?` ("file"\|"directory"), `limit?` (1-200) | `string[]` |
| `GET` | `/find/symbol` | 搜索符号 (LSP) | query: `query` | `Symbol[]`（当前返回空） |

> **注意**：`path` 参数必须使用**相对路径**，绝对路径会导致 join 错误。

### 13. 实例信息 API

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/path` | 获取路径信息 | — | `{ home, state, config, worktree, directory }` |
| `GET` | `/vcs` | 获取 VCS 信息 | — | `{ branch: string }` |
| `GET` | `/agent` | 列出可用 agent | — | `Agent.Info[]` |
| `GET` | `/skill` | 列出可用 skill | — | `Skill.Info[]` |
| `GET` | `/command` | 列出可用命令 | — | `Command.Info[]` |
| `GET` | `/lsp` | LSP 状态 | — | `LSP.Status[]` |
| `GET` | `/formatter` | Formatter 状态 | — | `Format.Status[]` |
| `POST` | `/instance/dispose` | 释放当前实例 | — | `true` |

### 14. Project API（`/project/*`）

| 方法 | 路径 | 说明 | 请求参数 | 响应 |
|------|------|------|---------|------|
| `GET` | `/project` | 列出所有项目 | — | `Project.Info[]` |
| `GET` | `/project/current` | 获取当前项目 | — | `Project.Info` |
| `POST` | `/project/git/init` | 初始化 git 仓库 | — | `Project.Info` |
| `PATCH` | `/project/:projectID` | 更新项目信息 | body: `{ name?, icon?, ... }` | `Project.Info` |

---

### 外部进程典型使用流程

```bash
# 公共变量
BASE="http://localhost:4096"
AUTH="Authorization: Basic b3BlbmNvZGU6dGVzdDEyMw=="
DIR="directory=/path/to/my/project"

# 1. 健康检查
curl -H "$AUTH" "$BASE/global/health"

# 2. 创建 session
SESSION_ID=$(curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/session?$DIR" -d '{}' | jq -r '.id')

# 3. 异步发送消息（推荐，通过 SSE 监听结果）
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/session/$SESSION_ID/prompt_async?$DIR" \
  -d '{"parts":[{"type":"text","text":"请帮我分析这个项目的架构"}]}'

# 4. 监听 SSE 事件流（获取 AI 回复）
curl -N -H "$AUTH" "$BASE/event?$DIR"

# 5. 或者同步发送消息（阻塞等待完整回复）
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/session/$SESSION_ID/message?$DIR" \
  -d '{"parts":[{"type":"text","text":"列出所有文件"}]}'

# 6. 处理权限请求（如果 AI 需要执行工具）
curl -s -H "$AUTH" "$BASE/permission?$DIR"
# → 返回待处理的权限请求列表
curl -s -X POST -H "$AUTH" -H "Content-Type: application/json" \
  "$BASE/permission/$REQUEST_ID/reply?$DIR" \
  -d '{"reply":"once"}'

# 7. 中止正在进行的处理
curl -s -X POST -H "$AUTH" "$BASE/session/$SESSION_ID/abort?$DIR"

# 8. 获取消息历史
curl -s -H "$AUTH" "$BASE/session/$SESSION_ID/message?$DIR&limit=20"
```

---

## 根本性评估：是否应该开放 Sidecar

在讨论"怎么共享"之前，需要先回答"该不该共享"。

### 外部进程真正需要的是哪一层？

OpenCode sidecar 提供的是完整的 AI Agent 能力栈。外部进程未必需要整个栈：

```
┌─────────────────────────────────┐
│  Agent 编排层                    │  ← session 管理、tool-use 循环、
│  （OpenCode 核心价值）            │     权限系统、上下文压缩、revert
├─────────────────────────────────┤
│  MCP 工具层                      │  ← 浏览器、文件编辑、自定义工具
├─────────────────────────────────┤
│  Provider 抽象层                 │  ← Anthropic/OpenAI/... API Key 管理
├─────────────────────────────────┤
│  LLM API                        │  ← 直接调 Claude/GPT API
└─────────────────────────────────┘
```

| 场景 | 真正需要的层 | 用 sidecar 合适吗 |
|------|-------------|------------------|
| "帮我翻译这段文本" | LLM API | **不合适** — 直接调 Provider SDK |
| "帮我自动化 review 这个 PR" | Agent 编排层 | **合适** — 需要 tool-use 循环、文件读写、多轮对话 |
| "帮我跑个数据分析脚本" | Agent + Shell | **合适** — 需要 shell 执行 + AI 判断 |
| "查询一下知识库" | MCP 工具 | **部分合适** — 只需要 MCP 层，不需要 session |

**结论**：只有需要 Agent 编排能力（多轮 tool-use、文件操作、权限管理）的场景才值得走 sidecar，纯 LLM 调用应该直接用 Provider SDK。

### 核心风险分析

#### 风险 1：安全——当前等于「裸奔」

```
密码: test123（hardcoded）
绑定: 127.0.0.1:4096（本机任何进程都能访问）
能力: 执行任意 shell 命令 + 读写任意文件 + 消费 API 额度
```

当前架构下，本机任意进程只要知道端口就能：
- 读取项目里的任何文件
- 以 AI Agent 身份执行 shell 命令
- 消耗 API Key 额度
- 读取其他 session 的对话内容

这不是"要不要开放"的问题——**它已经是开放的**，只是没有人来连而已。

#### 风险 2：职责边界——sidecar 不是通用 AI 网关

OpenCode 的设计意图是**为一个前端服务**（CLI/TUI/Web/Desktop），不是作为通用 AI Agent API Server。表现在：

- 没有多租户隔离（config/MCP 全局共享）
- 没有 API Key / Token 机制（只有 Basic Auth）
- 没有调用量限制 / 配额管理
- 生命周期绑定前端进程（Tauri 关就全关）
- SSE 事件流广播所有工作区的事件

把它当通用网关用，是**让一个单用户工具承担多用户服务的职责**。

#### 风险 3：稳定性——共享即耦合

一个外部进程发了个巨大的 prompt，或者触发了 MCP 工具的无限循环，Ultrawork 的响应速度直接受影响。单进程、单线程（Bun event loop）的架构下没有资源隔离手段。

### 最终结论

**不应该作为"特性"来支持外部进程直接连 sidecar。**

但这并不意味着"禁止"，而是应该**分层处理**：

```
                        外部进程场景
                            │
         ┌──────────────────┼──────────────────┐
         │                  │                  │
   只需要 LLM API     需要 Agent 能力     需要 Agent 能力
         │            （本地进程）         （网络服务）
         │                  │                  │
  直接调 Provider SDK   ACP 协议（方案 E）  独立实例（方案 B）
  （Anthropic/OpenAI）  opencode acp       opencode serve --port
                        stdin/stdout        HTTP API
```

| 策略 | 做法 | 理由 |
|------|------|------|
| **Ultrawork 自身的 sidecar** | 仅限 Ultrawork 使用，不对外暴露 | 保护稳定性和用户数据 |
| **外部需要 LLM 能力** | 提供 provider 配置共享（API Key），外部进程自己调 SDK | 轻量、解耦、无安全风险 |
| **外部本地进程需要 Agent 能力** | **ACP 协议**（spawn `opencode-server acp`） | 零开发成本、天然安全、标准协议 |
| **外部网络服务需要 Agent 能力** | Launcher 启动独立 OpenCode 实例 | 完全隔离，支持远程调用 |

---

## 推荐策略

### 短期：ACP 优先 + 加固安全

1. **本地集成首选 ACP** — 外部进程 spawn `opencode-server acp --cwd /project`，通过 stdin/stdout 通信。零开发成本，OpenCode 已实现全部逻辑
2. **增强认证安全** — 将 `test123` 改为随机生成的 token（每次启动生成，通过 Tauri 内部传递给前端），防止本机其他进程偷连。这无论是否开放都值得做
3. **不开放 Ultrawork sidecar 的 4096 端口给外部** — Ultrawork 专用

### 中期：Launcher 实现方案（方案 B 落地，面向网络服务场景）

> 仅在外部消费者需要通过 HTTP 调用（Web 服务、远程访问）时才需要此方案。本地进程优先使用 ACP。

#### 已具备的能力（零改造即可用）

| 能力 | 现状 | 来源 |
|------|------|------|
| `--port` 指定端口 | ✅ 原生支持 | `cli/network.ts` |
| `--hostname` 绑定地址 | ✅ 原生支持 | `cli/network.ts` |
| `OPENCODE_SERVER_PASSWORD` 设密码 | ✅ 原生支持 | `flag/flag.ts:43` |
| `OPENCODE_CONFIG_DIR` 配置目录隔离 | ✅ 原生支持 | `flag/flag.ts:19` (dynamic getter) |
| `OPENCODE_DB` 数据库路径隔离 | ✅ 原生支持 | `flag/flag.ts:77` |
| `OPENCODE_APP_NAME` 应用名隔离 | ✅ vendor patch 已支持 | ADR-020 |
| 动态工作区路由 | ✅ `?directory=` / `X-OpenCode-Directory` | `server/router.ts:30` |
| 二进制文件 | ✅ 编译产物在 `src-tauri/binaries/opencode-server-*`（~127MB） | `build-opencode.ts` |

**关键结论**：OpenCode 的环境变量和 CLI 参数已经覆盖了多实例隔离的所有需求，**不需要改 vendor 源码**。

#### 需要新建的 4 个模块

##### 模块 1：Launcher CLI 脚本（核心，1 天）

封装 OpenCode 二进制的启动/停止/查询：

```bash
# 用法
ultrawork-agent start --port 5096 --dir /path/to/project --name my-agent
ultrawork-agent stop --name my-agent
ultrawork-agent list
ultrawork-agent status --name my-agent
```

具体工作项：

| 工作项 | 说明 | 复杂度 |
|--------|------|--------|
| 定位二进制 | 从 `~/.ultrawork/bin/opencode-server` 或 Tauri bundle 中找 | 低 |
| 端口分配 | 指定端口 or 自动分配（从 5096 起递增扫描可用端口） | 低 |
| 生成随机 token | `crypto.randomUUID()` 作为 `OPENCODE_SERVER_PASSWORD` | 低 |
| 启动子进程 | `Bun.spawn()` + 环境变量注入 | 低 |
| 健康检查等待 | 轮询 `/global/health` 直到 ready | 低 |
| 实例注册文件 | 写 `~/.ultrawork/instances/<name>.json`（pid, port, token, dir） | 低 |
| stop/list/status | 读注册文件，kill 进程，检查健康 | 低 |

每个实例的环境变量模板：

```typescript
{
  OPENCODE_SERVER_PASSWORD: randomToken,      // 随机密码
  OPENCODE_APP_NAME: "ultrawork",             // 共享配置命名空间
  OPENCODE_CONFIG_DIR: "~/.config/ultrawork", // 共享 provider API Key 配置
  OPENCODE_DB: `~/.ultrawork/instances/${name}/data.db`, // 独立数据库
  OPENCODE_DISABLE_AUTOUPDATE: "true",        // 不自动更新
  OPENCODE_PURE: "true",                      // 跳过项目级 opencode.json
}
```

效果：**Provider API Key 共享**（Ultrawork 里配一次，所有实例都能用），**session/数据库完全隔离**。

##### 模块 2：二进制分发（必须，0.5 天）

当前二进制只存在于 Tauri bundle 内部（`src-tauri/binaries/opencode-server-aarch64-apple-darwin`，~127MB），外部进程无法直接引用。

| 方案 | 做法 | 推荐 |
|------|------|------|
| A. 符号链接 | launcher 直接引用 Tauri bundle 内路径（`/Applications/Ultrawork.app/...`） | ✅ 推荐（零分发成本） |
| B. 安装时复制 | `setup.sh` 额外复制到 `~/.ultrawork/bin/opencode-server` | 备选 |
| C. DMG 安装后 | Tauri setup hook 复制到公共位置 | 正式发布时 |

先用方案 A（符号链接），后续独立安装时再做复制。

##### 模块 3：实例注册与发现（推荐，0.5 天）

外部进程需要知道"有哪些实例在运行、端口多少、token 是什么"。

注册表结构：

```
~/.ultrawork/instances/
├── ultrawork-main.json    # Ultrawork 自身的 sidecar
├── my-agent.json          # 外部实例
└── ci-runner.json         # 另一个外部实例
```

每个文件内容：

```json
{
  "pid": 12345,
  "port": 5096,
  "token": "a1b2c3d4-e5f6-...",
  "directory": "/path/to/project",
  "startedAt": "2026-05-13T10:00:00Z"
}
```

额外改动：Ultrawork 自身启动 sidecar 时也写一份注册文件（改 `lib.rs`），这样 `ultrawork-agent list` 能看到所有实例。

##### 模块 4：Ultrawork 侧安全加固（推荐一起做，0.5 天）

既然要做 launcher，顺便将 Ultrawork 自身的 sidecar 认证从 hardcoded 密码升级为随机 token：

| 工作项 | 说明 | 涉及文件 |
|--------|------|---------|
| 随机 token 生成 | `lib.rs` 启动时 `uuid::Uuid::new_v4()` 生成密码 | `lib.rs` |
| Token 传递给前端 | `app.manage()` 注入，前端 `invoke("get_auth_token")` 获取 | `lib.rs` + 新 Tauri command |
| 前端 API 客户端适配 | `api-client` 从 hardcoded `test123` 改为运行时获取 | `packages/core/api-client/` |
| 注册文件 | 启动时写 `~/.ultrawork/instances/ultrawork-main.json` | `lib.rs` |

#### 工作量总结

| 模块 | 工作量 | 是否必须 | 涉及改动 |
|------|--------|---------|---------|
| 1. Launcher CLI | 1 天 | ✅ 必须 | 新建 `scripts/ultrawork-agent.ts` 或 `packages/tools/launcher/` |
| 2. 二进制分发 | 0.5 天 | ✅ 必须 | `setup.sh` + 符号链接 |
| 3. 实例注册 | 0.5 天 | ⚠️ 推荐 | launcher 内部 + `lib.rs`（写注册文件） |
| 4. 安全加固 | 0.5 天 | ⚠️ 推荐 | `lib.rs` + `api-client` + 前端 |
| **合计** | **2-2.5 天** | | |

#### 不需要改的东西

- **vendor/opencode 源码** — 不需要，现有环境变量已够用
- **Gateway** — 外部实例不需要 Gateway（channel 是 Ultrawork 专属功能）
- **Tauri 配置** — sidecar 命名不变
- **前端 UI** — launcher 是纯 CLI 工具，不需要 UI

#### 风险点

| 风险 | 影响 | 缓解 |
|------|------|------|
| macOS 二进制签名 | 独立运行未签名二进制会被 Gatekeeper 拒绝 | launcher 启动前 `codesign -s -` ad-hoc 签名（已有先例，`build-opencode.ts:121`） |
| 共享 config 写冲突 | 两个实例同时写 `opencode.json` | `OPENCODE_PURE=true` 让外部实例只读 config |
| MCP 子进程泄漏 | 外部实例 crash 后 MCP 子进程残留 | launcher stop 时 kill process group（`kill -TERM -$PID`） |

### ACP 方案落地详情（方案 E 实现指南）

#### Ultrawork 侧改动

**代码改动：零。** ACP 是 OpenCode 原生功能，`opencode-server acp` 命令已在编译产物中。不需要改 `lib.rs`、前端、vendor patch。

**唯一工作：二进制分发**（让外部进程找到 `opencode-server`）

| 方案 | 做法 | 推荐 |
|------|------|------|
| 符号链接 | `setup.sh` 加一行 `ln -sf` 到 `~/.ultrawork/bin/opencode-server` | ✅ 推荐 |
| 文档说明 | 告知 binary 位置：开发环境 `src-tauri/binaries/opencode-server-*`，安装后 `/Applications/Ultrawork.app/Contents/Resources/binaries/` | 备选 |

```bash
# setup.sh 中追加
mkdir -p ~/.ultrawork/bin
ln -sf "$(pwd)/packages/client/desktop/src-tauri/binaries/opencode-server-$(uname -m | sed 's/arm64/aarch64/')-apple-darwin" \
       ~/.ultrawork/bin/opencode-server
```

#### 外部进程侧开发

**依赖**：`npm install @agentclientprotocol/sdk`（同一个 SDK 同时包含 Agent 端和 Client 端）

**需要实现**：ACP `Client` 接口（2 个必须方法 + 3 个可选方法）

```typescript
import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse
} from "@agentclientprotocol/sdk"
import { spawn } from "child_process"

// ── 1. 实现 Client 接口 ──────────────────────────────

class MyClient implements Client {
  // 必须：处理权限请求（AI 要执行 shell/edit 等工具时触发）
  async requestPermission(
    params: RequestPermissionRequest
  ): Promise<RequestPermissionResponse> {
    // 最简版本：自动批准所有请求
    return { outcome: { outcome: "selected", optionId: "once" } }
    // 生产版本：展示 UI 让用户决定
  }

  // 必须：处理实时推送（AI 输出的文本 chunk、tool call 状态等）
  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        // AI 文本输出（流式）
        process.stdout.write(update.content.text)
        break
      case "agent_thought_chunk":
        // AI 推理过程（流式）
        break
      case "tool_call":
        // 工具调用开始
        console.log(`[tool] ${update.title}`)
        break
      case "tool_call_update":
        // 工具调用状态变更 (pending → running → completed/error)
        console.log(`[tool] ${update.title}: ${update.status}`)
        break
      case "plan":
        // TODO/Plan 更新
        break
      case "usage_update":
        // Token 使用统计
        break
    }
  }

  // 可选：文件读取（agent 需要读取客户端文件时）
  // async readTextFile(params) { ... }

  // 可选：文件写入通知（agent 编辑文件后通知客户端）
  // async writeTextFile(params) { ... }

  // 可选：终端创建
  // async createTerminal(params) { ... }
}

// ── 2. 启动 opencode-server acp 子进程 ───────────────

const proc = spawn(
  `${process.env.HOME}/.ultrawork/bin/opencode-server`,
  ["acp", "--cwd", "/path/to/project"],
  {
    stdio: ["pipe", "pipe", "inherit"],
    env: {
      ...process.env,
      OPENCODE_APP_NAME: "ultrawork",  // 共享 Ultrawork 的 provider 配置
    },
  }
)

// ── 3. 建立 ACP 连接 ─────────────────────────────────

const stream = ndJsonStream(proc.stdin, proc.stdout)
const conn = new ClientSideConnection(
  (agent) => new MyClient(),
  stream
)

// ── 4. 使用 ──────────────────────────────────────────

// 初始化
const initResult = await conn.initialize({
  protocolVersion: 1,
  clientCapabilities: {},
})
console.log("Agent:", initResult.agentInfo)

// 创建 session
const session = await conn.newSession({
  cwd: "/path/to/project",
  mcpServers: [],  // 可选：声明需要的 MCP 服务
})

// 发送 prompt（阻塞直到 AI 完成，过程中 sessionUpdate 持续推送）
const result = await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "分析这个项目的架构" }],
})
console.log("Stop reason:", result.stopReason)

// 继续对话
const result2 = await conn.prompt({
  sessionId: session.sessionId,
  prompt: [{ type: "text", text: "重点看 API 设计" }],
})

// 中止正在进行的处理
await conn.cancel({ sessionId: session.sessionId })

// 列出历史 session
const sessions = await conn.listSessions({ cwd: "/path/to/project" })

// 恢复历史 session（会回放消息历史）
const loaded = await conn.loadSession({
  sessionId: sessions.sessions[0].sessionId,
  cwd: "/path/to/project",
  mcpServers: [],
})
```

#### 外部进程需要知道的信息

| 信息 | 内容 | 说明 |
|------|------|------|
| **Binary 路径** | `~/.ultrawork/bin/opencode-server` | Ultrawork 安装后提供 |
| **环境变量** | `OPENCODE_APP_NAME=ultrawork` | 共享 provider API Key 配置 |
| **SDK** | `@agentclientprotocol/sdk` (npm) | Client + Agent 两端都在这个包里 |
| **协议规范** | https://agentclientprotocol.com/ | ACP v1 |

**不需要知道的**：HTTP 端口、认证密码、SSE 事件格式、OpenCode 内部 API——ACP 全部封装掉了。

#### 开发量估算

| 工作项 | Ultrawork 侧 | 外部进程侧 |
|--------|-------------|-----------|
| 二进制分发 | 0.5 天（symlink） | — |
| SDK 接入 | — | `npm install`（5 分钟） |
| Client 接口 | — | 最简 ~30 行 / 完整 ~150 行 |
| 业务流程 | — | ~30 行（init → session → prompt） |
| sessionUpdate UI | — | 取决于展示复杂度（0.5-2 天） |
| **合计** | **0.5 天** | **最简 1-2 小时 / 完整 1-2 天** |

#### 风险点

| 风险 | 影响 | 缓解 |
|------|------|------|
| macOS 二进制签名 | 独立运行 bundle 内 binary 可能被 Gatekeeper 拒绝 | ad-hoc 签名 `codesign -s -`（已有先例） |
| ACP 协议演进 | `unstable_` 方法可能变更 | 核心方法（initialize/newSession/prompt）已稳定 |
| 进程清理 | 外部进程 crash 后 opencode-server 子进程残留 | 外部进程注册 SIGTERM handler；或用 prctl/PR_SET_PDEATHSIG |
| 非 JS 语言客户端 | `@agentclientprotocol/sdk` 仅 TypeScript，Python/Go 等无官方 SDK | ACP 底层是 JSON-RPC over ndjson，协议简单可自行实现；核心工作量在 ndjson 读写 + 4 个 JSON-RPC method 的 request/response 映射 |

#### 快速验证

无需写代码即可验证 ACP 是否可用：

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' \
  | OPENCODE_APP_NAME=ultrawork ~/.ultrawork/bin/opencode-server acp --cwd /tmp
```

正常返回 `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentInfo":{"name":"OpenCode",...},...}}` 即表示 ACP 可用。

---

### 长期加分项：MCP 封装（方案 D）

如果外部消费者主要是 AI 客户端（Claude Desktop、Cursor），在方案 B 基础上加一层 MCP adapter 是自然的集成方式。但考虑到 ACP 已经被 Zed 等编辑器原生支持，MCP 封装的优先级降低。

### 方案选型速查

| 外部进程类型 | 推荐方案 | 理由 |
|-------------|---------|------|
| 本地 CLI 工具 / 自动化脚本 | **ACP**（方案 E） | 零开发、天然安全、标准协议 |
| IDE 集成（Zed 等） | **ACP**（方案 E） | 编辑器原生支持 |
| Web 后端 / 远程 API 调用 | **Launcher**（方案 B） | 需要网络端口 |
| 只需要 LLM 问答 | **直接调 Provider SDK** | 不需要 Agent 编排 |
| 快速原型 / 临时测试 | **共享实例**（方案 A） | 最简单，注意不碰管理面 |

---

## 调研记录

### OpenCode `serve` 命令完整参数

```bash
opencode-server serve \
  --port 5096 \              # 指定端口（默认 0 = 自动）
  --hostname 127.0.0.1 \     # 监听地址
  --mdns \                   # 启用 mDNS 服务发现
  --mdns-domain myapp.local  # mDNS 域名
  --cors http://localhost:3000  # 额外 CORS 域名
```

环境变量（可与 CLI 参数配合）：

| 环境变量 | 用途 |
|---------|------|
| `OPENCODE_SERVER_PASSWORD` | 设置 Basic Auth 密码 |
| `OPENCODE_SERVER_USERNAME` | 设置 Basic Auth 用户名（默认 `opencode`） |
| `OPENCODE_APP_NAME` | 应用名称（影响 config 目录路径） |
| `OPENCODE_CONFIG_DIR` | 配置目录覆盖 |
| `OPENCODE_DB` | 数据库路径覆盖 |
| `OPENCODE_PURE` | 纯净模式（跳过 project config） |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | 禁用项目级配置 |

### 关键源码引用

| 文件 | 行号 | 内容 |
|------|------|------|
| `cli/network.ts:4-6` | port 选项定义 | `default: 0` |
| `cli/network.ts:49` | port 优先级 | CLI > config > default |
| `server/server.ts:289` | 端口回退 | `port===0 ? tryServe(4096) ?? tryServe(0) : tryServe(port)` |
| `server/router.ts:30` | 动态工作区 | `query("directory") \|\| header("x-opencode-directory") \|\| cwd()` |
| `config/config.ts:783-791` | Server 配置 schema | port/hostname/mdns/cors |
| `flag/flag.ts:43-44` | Auth 环境变量 | `OPENCODE_SERVER_PASSWORD/USERNAME` |
| `lib.rs:10` | Ultrawork 默认端口 | `const OPENCODE_PORT: u16 = 4096` |
