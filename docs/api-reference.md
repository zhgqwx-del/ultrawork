# OpenCode API 调研结果

**调研时间**: 2026-03-05
**状态**: Milestone 1 完成（早期快照）

> ⚠️ **本文档是 2026-03-05 的早期调研快照，部分内容已过时。** 当前权威的 API 形态以代码为准：
> - **发送消息**：现已统一为 `POST /session/:id/prompt_async`（返回 204，异步）。下文的 `POST /:sessionID/message` 同步端点已不再使用。
> - **运行时模型切换**：用 `prompt_async` 的 `model` 字段 `{ providerID, modelID }`（`PATCH /config` 只写磁盘，不影响运行时）。
> - **消息分页**：`GET /session/:id/message?limit=N&before=CURSOR`，响应头 `X-Next-Cursor`（`getMessagesPaginated()`）。
> - 本文未覆盖的端点（permission / question / provider / mcp / agent / skill / command / file / knowledge）：见 `packages/core/api-client/src/client.ts` 与 AGENTS.md「OpenCode API Reference」段。
> - 认证现为随机生成凭证（ADR-028），非固定 env password。

## 📋 调研目标

理解 OpenCode 的 API 结构，验证 @agent/api-client 的实现是否正确。

## 🔍 关键发现

### 1. 技术栈
- **Web 框架**: Hono (轻量级 Web 框架)
- **认证方式**: HTTP Basic Auth
  - Username: `OPENCODE_SERVER_USERNAME` (默认 "opencode")
  - Password: `OPENCODE_SERVER_PASSWORD` (必需)
- **CORS**: 支持 localhost 和 Tauri 应用 (`tauri://localhost`)

### 2. API 端点结构

#### Session 相关端点 (挂载在 `/session`)

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| POST | `/` | 创建 session | 返回 Session.Info |
| GET | `/:sessionID` | 获取 session 详情 | 返回 Session.Info |
| GET | `/` | 列出所有 sessions | 支持过滤和分页 |
| DELETE | `/:sessionID` | 删除 session | 永久删除 |
| PATCH | `/:sessionID` | 更新 session | 更新 title 等元数据 |
| POST | `/:sessionID/message` | ~~发送消息~~ | ⚠️ 已弃用，改用 `/:sessionID/prompt_async`（204） |
| POST | `/:sessionID/prompt_async` | **发送消息（当前）** | 异步，返回 204；`model` 可覆盖运行时模型；`tools` per-tool 开关（落成 **sticky session permission**，支持通配 key）；`system` 附加 system prompt（**per-message append**，不 sticky）——Team Leader 每轮携带编排指令用 |
| GET | `/:sessionID/message` | 获取消息列表 | 返回所有消息 |
| GET | `/:sessionID/todo` | **任务规划快照** | 返回 `Todo[]`（`{content,status,priority}`，整表）；connector `getPlan` 用于面板水合（ADR-038）。变更时 opencode 发 `todo.updated` SSE，connector 归一为 `plan.updated` |
| POST | `/:sessionID/abort` | 中止 session | 停止 AI 处理 |

#### 全局端点

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| GET | `/event` | **订阅事件流** | ⚠️ SSE 端点 |

### 3. 关键 API 详解

#### 3.1 创建 Session
```http
POST /session
Content-Type: application/json
Authorization: Basic <base64(username:password)>

{
  "agent": "build",  // optional
  "workingDirectory": "/path/to/project"  // optional
}
```

**响应**:
```json
{
  "id": "session-id",
  "title": "Session Title",
  "directory": "/path/to/project",
  ...
}
```

#### 3.2 发送消息 (Prompt)
```http
POST /session/:sessionID/message
Content-Type: application/json
Authorization: Basic <base64(username:password)>

{
  "prompt": "Your message here",
  "agent": "build"  // optional
}
```

**响应**: 流式 JSON
```json
{
  "info": { ... },
  "parts": [ ... ]
}
```

⚠️ **重要**: 这个端点使用 `stream()` 返回流式 JSON，不是标准的 SSE。

#### 3.3 订阅事件流 (SSE)
```http
GET /event
Authorization: Basic <base64(username:password)>
```

**响应**: Server-Sent Events (SSE)
```
data: {"type":"server.connected","properties":{}}

data: {"type":"session.message.created","properties":{...}}

data: {"type":"server.heartbeat","properties":{}}
```

**特点**:
- 全局事件流，不是 per-session 的
- 使用 Hono 的 `streamSSE`
- 每 10 秒发送一次心跳
- 通过 Bus 系统广播所有事件

## ⚠️ 与当前实现的对比

### 当前 @agent/api-client 实现

```typescript
// packages/core/api-client/src/client.ts
async createSession(request: SessionCreateRequest = {}): Promise<SessionCreateResponse> {
  return this.request<SessionCreateResponse>("/api/session", {
    method: "POST",
    body: JSON.stringify(request),
  })
}

async sendPrompt(sessionId: string, prompt: string): Promise<void> {
  await this.request(`/api/session/${sessionId}/prompt`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  })
}

subscribeToEvents(sessionId: string, onEvent: (data: string) => void): () => void {
  const eventSource = new EventSource(`${this.baseUrl}/api/session/${sessionId}/events`)
  // ...
}
```

### 实际 OpenCode API

```typescript
// 正确的端点
POST /session                    // 创建 session (不是 /api/session)
POST /session/:sessionID/message // 发送消息 (不是 /prompt)
GET /event                       // 订阅事件 (不是 per-session)
```

### 发现的问题

| 问题 | 当前实现 | 实际 API | 影响 |
|------|---------|---------|------|
| **路径前缀** | `/api/session` | `/session` | ❌ 所有请求都会 404 |
| **发送消息端点** | `/prompt` | `/message` | ❌ 发送消息失败 |
| **事件订阅** | Per-session `/events` | 全局 `/event` | ❌ 无法订阅事件 |
| **认证方式** | Bearer token | Basic Auth | ⚠️ 需要调整 |

## 🔧 修复建议

### 1. 更新 API 端点路径

```typescript
// packages/core/api-client/src/client.ts

// 修改前
async createSession(request: SessionCreateRequest = {}): Promise<SessionCreateResponse> {
  return this.request<SessionCreateResponse>("/api/session", { ... })
}

// 修改后
async createSession(request: SessionCreateRequest = {}): Promise<SessionCreateResponse> {
  return this.request<SessionCreateResponse>("/session", { ... })
}
```

### 2. 修改发送消息端点

```typescript
// 修改前
async sendPrompt(sessionId: string, prompt: string): Promise<void> {
  await this.request(`/api/session/${sessionId}/prompt`, { ... })
}

// 修改后
async sendMessage(sessionId: string, prompt: string): Promise<void> {
  await this.request(`/session/${sessionId}/message`, { ... })
}
```

### 3. 修改事件订阅

```typescript
// 修改前
subscribeToEvents(sessionId: string, onEvent: (data: string) => void): () => void {
  const eventSource = new EventSource(`${this.baseUrl}/api/session/${sessionId}/events`)
}

// 修改后
subscribeToEvents(onEvent: (data: string) => void): () => void {
  const eventSource = new EventSource(`${this.baseUrl}/event`)
}
```

### 4. 调整认证方式

```typescript
// 当前使用 Bearer token
if (this.password) {
  headers["Authorization"] = `Bearer ${this.password}`
}

// OpenCode 使用 Basic Auth
if (this.password) {
  const username = this.username || "opencode"
  const credentials = btoa(`${username}:${this.password}`)
  headers["Authorization"] = `Basic ${credentials}`
}
```

## 🚀 如何运行 OpenCode Server

### 方法 1: 使用 Bun 开发模式

```bash
cd vendor/opencode
bun install
bun run dev
```

默认端口: `4096`

### 方法 2: 使用已安装的 OpenCode

```bash
# 安装 OpenCode
npm install -g opencode-ai@latest

# 启动 server 模式
opencode serve --port 4096 --password your-password
```

### 测试 API

```bash
# 创建 session
curl -X POST http://localhost:4096/session \
  -H "Content-Type: application/json" \
  -u "opencode:your-password" \
  -d '{"workingDirectory": "/path/to/project"}'

# 订阅事件流
curl -N http://localhost:4096/event \
  -u "opencode:your-password"
```

## 📝 下一步行动

### 立即需要做的

1. **修复 @agent/api-client**
   - 更新所有 API 端点路径
   - 修改认证方式为 Basic Auth
   - 调整事件订阅为全局端点
   - 更新类型定义

2. **测试修复后的实现**
   - 手动启动 OpenCode Server
   - 使用修复后的 api-client 进行测试
   - 验证所有功能正常工作

3. **更新 server-manager**
   - 确认 OpenCode 二进制的启动参数
   - 添加 `--password` 参数生成
   - 验证健康检查端点

### 后续工作 (Milestone 2)

- 编译 OpenCode 到二进制
- 配置 Tauri sidecar
- 集成到 Desktop App

## ACP Client Sidecar 端点（:4099，ADR-027）

**需 Basic 认证**（`ULTRAWORK_SIDECAR_USERNAME` / `ULTRAWORK_SIDECAR_PASSWORD`，ADR-028 起随 sidecar 凭证下发），CORS 白名单同 Gateway。会话 id 一律使用桌面端自己的 session id（`clientSessionId` 直通）。

> ⚠️ 本节与下节曾长期写作「无认证（仅监听 127.0.0.1）」，那是 ADR-028 之前的状态。**认证是无条件的**：`index.ts` 在 `ULTRAWORK_SIDECAR_PASSWORD` 缺失时直接 throw（sidecar 根本起不来），且 `app.use("*")` 一并覆盖 `/orchestration/*`（`acp-server.ts` 注释写明）。不带 `authorization` 头一律 401 —— 2026-07-30 实测踩到：照文档写的探针全线 401。新增调用方一律带头。

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| GET | `/acp/health` | 健康检查 | 含各 agent 连接态 |
| GET | `/acp/agents` | 列出 agent | 含 status / capabilities（loadSession 等） |
| GET/PUT/DELETE | `/acp/agents/:id(/config)` | agent 配置 CRUD | PUT 保存即热生效（断开重连）；body 含 `label/command/args/env/knowledgeMcp/thoughtLevel` |
| POST | `/acp/agents/:id/connect` / `disconnect` | 手动连接/断开 | 平时无需手动——prompt 时懒连接 |
| POST | `/acp/session` | 建会话 | body `{agentId, cwd, clientSessionId?, orchestrate?, systemPrompt?}`——`orchestrate` 注入 delegate MCP（per-session）；`systemPrompt` 经 `_meta.systemPrompt` append（claude ≥0.44）或首条 prompt 前置（其它 adapter），持久化 + 重启重注入 |
| GET | `/acp/sessions` | **全部会话+绑定**（阶段2） | `[{sessionId, agentId, cwd, createdAt}]`——desktop 启动时绑定 hydration 数据源（ADR-030） |
| GET | `/acp/session/:id` | 会话信息 | 持久化映射（重启后仍在） |
| GET | `/acp/session/:id/messages` | **整形历史**（W4b） | 一次性全量 `{messages}`，connector `ACPBackend.fetchHistory` 消费 |
| DELETE | `/acp/session/:id` | 删会话 + 持久化文件 | 前端删会话时 fire-and-forget 调用 |
| POST | `/acp/session/:id/prompt` | 发消息 | **阻塞到 turn 完成**，返回 `{stopReason}` |
| POST | `/acp/session/:id/permission` | 权限回复 | body `{permissionId, reply: once\|always\|reject}` |
| POST | `/acp/session/:id/cancel` | 取消当前 turn | 先以 cancelled 应答挂起权限 |
| GET | `/acp/session/:id/events` | per-session SSE | opencode 形状事件 + 心跳；允许先订阅后建会话 |

持久化：`~/.local/share/ultrawork/acp-sessions/<sid>.json`（env `ACP_DATA_DIR` 可覆盖）。详见 `conventions.md` §11 / `gotchas.md` §8。

## Orchestration 端点（:4099，ADR-031 阶段3）

ACP sidecar 同进程托管 orchestrator（编排跨 WebView reload 存活）。**需 Basic 认证**（同上节，不带头答 401），CORS 同上。

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| POST | `/orchestration/runs` | 创建并启动 run（DAG 调度） | body `{recipe: {name, workspace, steps[]}}`；step `{id, agentId, taskPrompt, inputs?, artifactName?, timeoutMs?, model?, isolation?}`；`inputs` 全 completed 即并行启动（Fan-out）；`isolation:"worktree"` 须 git repo；workspace 服务端 realpath 归一；校验失败 400 |
| GET | `/orchestration/runs` | run 列表 | `{runs}` updatedAt 倒序 |
| GET | `/orchestration/runs/:id` | run 详情 | `{run}` / 404 |
| POST | `/orchestration/runs/:id/cancel` | 取消 run | 中止**全部在途** step + 未达 skipped；404 未知 / 409 已终态 |
| GET | `/orchestration/runs/:id/events` | per-run SSE | **首帧 = run.updated 全量快照**（订阅前事件零丢失）+ `step.updated` / `step.permission`（子会话权限 relay，UI 内联应答走上方 `/acp/session/:id/permission`）+ 心跳 |
| POST | `/orchestration/delegate` | **阻塞式 delegate**（第二批 ②） | body `{agentId, task, workspace, model?, timeoutMs?}`；阻塞至子 turn 终态，返回 D-2 契约 `{result: {status, sessionId, deliverable?, tokens?, cost?, error?, artifacts?}}`（`artifacts`=子会话 write/edit/create/patch 工具写的文件路径，018：供产物区识别委派成员产物）；非成员 agentId → 403（018 成员强制）/ 400 请求错 / 429 治理（深度）/ 500 其它。消费者 = `acp-client delegate-mcp` stdio shim |
| GET | `/orchestration/delegates` | delegate 记录列表 | 活动 + 最近 50 条终态（内存，不持久化） |
| GET | `/orchestration/delegates/events` | 全局 delegate SSE | 首帧 `delegate.snapshot` + `delegate.updated` / `delegate.permission`（DelegateDock 按 workspace 过滤内联应答）+ 心跳 |
| GET | `/orchestration/agents` | delegate 目标列表 | `opencode:default` + 全部 ACP agents（shim `list_agents` 工具消费） |
| POST | `/orchestration/team/sessions` | **创建 Team Leader 会话**（017 立 / 018 改） | body `{workspace, leaderAgentId, members[], systemPrompt?, title?}`；**leader/twin 以 ROOT 创建**（018 A-4：不挂隐藏父、不传 title → 进侧栏混排 + opencode 自动标题）→ ACP leader 额外建绑 twin 的 ACP 会话（orchestrate+systemPrompt，失败回滚 twin）；返回 `{session}` |
| GET | `/orchestration/team/sessions` | Team 会话注册表 | `?workspace=` 过滤，createdAt 倒序；持久化 `team-sessions.json`（重启恢复） |
| DELETE | `/orchestration/team/sessions/:id` | 删除 Team 会话 | 注册表移除 + best-effort 清理 opencode/ACP 双侧会话 |

run 持久化：`~/.local/share/ultrawork/orchestrator-runs/<runId>.json`（env `ORCHESTRATOR_DATA_DIR` 可覆盖）；sidecar 重启 running run → `interrupted`（不自动续跑）；delegate 记录不持久化（重启 = shim 工具错误）。产物文件：`<workspace>/.ultrawork/runs/<runId>/`；worktree：`<xdgData>/ultrawork/worktrees/<runId>/<stepId>`（env `ULTRAWORK_WORKTREES_DIR` 可覆盖，成功即删失败保留）。详见 ADR-031 / `gotchas.md` §9。



## Channel Gateway 端点（:4097，ADR-044）

无认证（仅监听 127.0.0.1 + CORS 白名单）。**响应中的渠道 config 一律掩码 secret 字段**（`clientSecret`/`botToken`/`secret`/`appSecret` 置空）。

| 端点 | 说明 |
|------|------|
| `GET /channel/health` | 健康检查。返回 `{status, idleRotateMs}` —— Tauri 不转发 sidecar 日志，这是唯一能确认运行中的 gateway 实际用哪个轮转阈值的办法（ADR-051） |
| `GET /channel/sessions` | 渠道会话注册表 `{sessions: ChannelSessionEntry[]}`，供桌面端侧边栏渲染渠道徽标（ADR-051）。gateway 不可达时前端降级为空列表、badge-less 继续工作 |
| `GET /channel` | `{channels: ChannelStatus[], configs: ChannelConfig[]}`（configs 掩码） |
| `POST /channel` | 手动添加渠道（`type: dingtalk\|wechat\|wecom\|feishu` + 各自凭证字段；feishu 可带 `domain: "feishu"\|"lark"`）；201 回显掩码 config |
| `DELETE /channel/:id` | 删除渠道 |
| `POST /channel/:id/connect` / `POST /channel/:id/disconnect` | 连接/断开 |
| `POST /channel/:type/qrcode` | 发起扫码会话（body `{name, workspaceDir, autoConnect?}`）→ `{token, qrContent, browserUrl?}`；未注册 QR 的 type 返回 404 |
| `GET /channel/:type/qrcode-status?token=` | 读缓存会话快照 → `{status: pending\|scanned\|authorized\|expired\|denied\|error, channelId?, error?}`（gateway 后台轮询上游，authorized 时渠道已落盘） |
| `DELETE /channel/:type/qrcode/:token` | 取消会话（停后台轮询；**不回滚上游已建应用**） |

上游契约（三家扫码流字段/坑）见 `docs/gotchas.md` §4；接入新渠道的模式见 `docs/conventions.md` §14。
