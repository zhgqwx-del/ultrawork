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
| POST | `/:sessionID/prompt_async` | **发送消息（当前）** | 异步，返回 204；`model` 字段可覆盖运行时模型 |
| GET | `/:sessionID/message` | 获取消息列表 | 返回所有消息 |
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

无认证（仅监听 127.0.0.1），CORS 白名单同 Gateway。会话 id 一律使用桌面端自己的 session id（`clientSessionId` 直通）。

| 方法 | 路径 | 功能 | 说明 |
|------|------|------|------|
| GET | `/acp/health` | 健康检查 | 含各 agent 连接态 |
| GET | `/acp/agents` | 列出 agent | 含 status / capabilities（loadSession 等） |
| GET/PUT/DELETE | `/acp/agents/:id(/config)` | agent 配置 CRUD | PUT 保存即热生效（断开重连）；body 含 `label/command/args/env/knowledgeMcp/thoughtLevel` |
| POST | `/acp/agents/:id/connect` / `disconnect` | 手动连接/断开 | 平时无需手动——prompt 时懒连接 |
| POST | `/acp/session` | 建会话 | body `{agentId, cwd, clientSessionId}` |
| GET | `/acp/sessions` | **全部会话+绑定**（阶段2） | `[{sessionId, agentId, cwd, createdAt}]`——desktop 启动时绑定 hydration 数据源（ADR-030） |
| GET | `/acp/session/:id` | 会话信息 | 持久化映射（重启后仍在） |
| GET | `/acp/session/:id/messages` | **整形历史**（W4b） | 一次性全量 `{messages}`，connector `ACPBackend.fetchHistory` 消费 |
| DELETE | `/acp/session/:id` | 删会话 + 持久化文件 | 前端删会话时 fire-and-forget 调用 |
| POST | `/acp/session/:id/prompt` | 发消息 | **阻塞到 turn 完成**，返回 `{stopReason}` |
| POST | `/acp/session/:id/permission` | 权限回复 | body `{permissionId, reply: once\|always\|reject}` |
| POST | `/acp/session/:id/cancel` | 取消当前 turn | 先以 cancelled 应答挂起权限 |
| GET | `/acp/session/:id/events` | per-session SSE | opencode 形状事件 + 心跳；允许先订阅后建会话 |

持久化：`~/.local/share/ultrawork/acp-sessions/<sid>.json`（env `ACP_DATA_DIR` 可覆盖）。详见 `conventions.md` §11 / `gotchas.md` §8。

## ✅ Milestone 1 总结

**完成内容**:
- ✅ 调研 OpenCode 项目结构
- ✅ 理解 API 端点和认证方式
- ✅ 识别当前实现的问题
- ✅ 提供详细的修复建议

**关键发现**:
- OpenCode 使用 Hono 框架和 Basic Auth
- API 路径不包含 `/api` 前缀
- 事件订阅是全局的，不是 per-session
- 需要修复 4 个主要问题

**下一步**: 修复 @agent/api-client 实现，然后进行手动测试验证。

