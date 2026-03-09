# 开发规范

<!-- last-synced: round-16 -->

项目开发过程中确立的约定与模式，供团队成员参考。

## 1. 代码规范

### 路径与运行时
- 路径别名 `@/` → `packages/client/desktop/src/`
- 所有脚本用 `bun run --bun` 执行（系统 Node.js v14 不兼容）
- MCP 本地服务器必须用 `bunx --bun`（不能用 `npx`，会导致 stdio pipe 断裂）

### UI 组件
- 遵循 shadcn/ui 模式：Radix 无样式原语 + Tailwind CSS 4
- CSS 变量 token 体系（见 `index.css`）
- 只在用户要求时使用 emoji

### TypeScript
- 构建顺序：修改 `api-client` 类型后，必须先 `tsc --build` 再检查 client
- 工具参数统一 camelCase（`filePath`，非 `file_path`）

## 2. 状态管理

### React Context 分层
7 个 Provider：`SidebarProvider`, `SessionsProvider`, `ConfigProvider`, `ThemeProvider`, `I18nProvider`, `WorkspaceProvider`, `SSEProvider`, `ModelProvider`

### 共享 Hook 提取模式
多组件共用逻辑时提取为独立 hook（如 `useMCPServers`, `useSkills`）：
- Hook 暴露数据 + 操作
- UI 状态（showAdd 等）留在各组件本地
- `handleAdd` throw 让调用者控制成功/失败 UI

### useRef 同步乐观更新
`setConfig(newConfig)` 后必须 `configRef.current = newConfig`，否则 React 批量更新期间连续调用读到旧 ref。

### sendingRef 互斥锁
`sendingRef.current` 同步锁防 React 批量更新间双发；`session.status:idle` 和 catch 中重置。

### idRef 跨 Session 异步安全
```ts
const idRef = useRef(id);
idRef.current = id;
// 异步回调中用 idRef.current !== id 检查是否仍在同一 session
```

### setTimeout cleanup 模式
```ts
const timerRef = useRef<ReturnType<typeof setTimeout>>();
useEffect(() => () => clearTimeout(timerRef.current), []);
```

## 3. SSE 事件处理

### 全局单连接
`SSEProvider` 在 app 级维护单一 SSE 连接，跨页面不丢事件。

### useSSESubscribe
使用 ref 模式，依赖 `[subscribe]` 避免 heartbeat 重订阅。

### 核心事件
| 事件 | 作用 |
|------|------|
| `message.part.updated` | 完整 part upsert |
| `message.part.delta` | 按 partID+field 增量 append |
| `message.updated` | 消息元数据更新 |
| `message.part.removed` | 移除 part |
| `session.status:idle` | Agent 完成，清除 sending 状态 |
| `permission.asked` | 弹出权限授权 Dock |
| `question.asked` | 弹出问答 Dock |

### 轮询兜底
Agent 活跃时（`sending || streamingMessageId !== null`）每 3s 轮询 permission/question API，防 SSE 竞态丢事件。

### SSE 重连
30s 心跳超时 → `forceReconnect()`，最多 3 次；收到事件重置计数。`connect()` 用局部 `controller` 变量防旧连接 finally 覆盖新连接。

## 4. OpenCode API 约定

### 消息发送
`POST /session/:id/prompt_async` 是唯一发送方式，返回 204。

### Model 参数
```ts
// prompt_async model 格式
{ providerID: string, modelID: string }
// 客户端从 "provider/model" 格式字符串解析
```

### Config 限制
`PATCH /config` 只写磁盘 `opencode.json`，**不影响运行时**。运行时模型切换须用 `prompt_async` 的 `model` 参数。

### File API
路径必须为相对路径 + `x-opencode-directory` header。绝对路径会 join 出错误路径。

### request\<T\> void 处理
检查 204/empty body 后才调 `.json()`，用于 replyPermission/replyQuestion/abortSession。

## 5. 组件模式

### 乐观消息
- 用户消息使用 `temp-` ID 前缀
- `message.part.updated` 过滤所有 `temp-` 消息创建真实消息
- Home→Session 传递：`navigate(url, { state: { sending: true, messageText: text } })`

### Dock 优先级
条件渲染顺序：Question > Permission > ChatInput

### Stop 执行（frozenMessageIds）
- `handleStop` 冻结所有当前消息 ID
- SSE handler 屏蔽冻结 ID 的事件
- Temp 消息提升为 `stopped-*` ID
- `session.status:idle` 不清除 `stopped`（在 `handleSend` 中清除）
- `handleSend` 清除 stopped 时同时清空 `frozenMessageIdsRef`

### React key
优先使用 `part.id`：`('id' in part && part.id) ? part.id : \`part-${i}\``

### Escape 键防冲突
ArtifactPreview 使用 `!e.defaultPrevented` 检查，避免与 CommandSelector 等 capture 阶段 handler 冲突。

### ModelSelector TTL 缓存
模块级 `cachedModels` + `cacheTimestamp`，5 分钟 TTL；有缓存时后台静默刷新。

### Session 状态重置
`useEffect([id])` 重置 messages/pending*/streamingId/sending/selectedArtifact/stopped/frozenIds。`setMessages([])` 必须在 reset 中清空。

### getMessages merge
`prev.length === 0 ? msgs : [...msgs, ...sseOnly]` — 必须配合 session 切换时 `setMessages([])`。

## 6. 构建与部署

### Gateway 重编译
修改 `packages/channel/gateway/src/` 后需：
```bash
bun run build:gateway
```

### Vendor Patch
Apply 后需重编译 sidecar。

### Tauri Sidecar 并行启动
Gateway 非关键，用 `std::thread::spawn` + `app.handle().clone()` 在后台启动。

### 外部链接
Tauri WebView 中 `window.open` 无法打开系统浏览器，必须用 `@tauri-apps/plugin-opener` 的 `openUrl()`。
