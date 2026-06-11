# 开发规范

<!-- last-synced: 2026-06-11 -->

项目开发过程中确立的约定与模式，供团队成员参考。

## 1. 代码规范

### 路径与运行时
- 路径别名 `@/` → `packages/client/desktop/src/`
- 所有脚本用 `bun run --bun` 执行（系统 Node.js v14 不兼容）
- MCP 本地服务器必须用 `bunx --bun`（不能用 `npx`，会导致 stdio pipe 断裂）
- Browser MCP 使用内嵌 Node.js（`~/.ultrawork/node/`），npm 安装必须用 `node npm-cli.js install`（不能直接调 `bin/npm`，symlink 相对路径断裂）

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

> 📍 本节是「应该怎么做」。OpenCode API 的**非直觉类型契约与运行时限制**（PartBase/ToolState/PatchPart 结构、PATCH /config 不影响运行时、File API 相对路径、camelCase 等）见 [`gotchas.md`](./gotchas.md) §1-2（权威 SSOT）；端点完整清单见 [`api-reference.md`](./api-reference.md)。

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

### 流式区域内的操作按钮用 `onPointerDown`（2026-06-11 实测事故）
浏览器只在 pointerdown/up 落在**同一元素**时才派发 click。高速流式（如逐行输出）下消息区每秒回流多次 + 自动滚动，跟随内容流的按钮在按下与抬起之间位移 → click 被吞，用户表现为「点击停止无效」。规则：
- 随内容流动的操作按钮（ExecutionStatus 的停止键）→ `onPointerDown` 触发，不用 `onClick`
- 关键操作同时给一个**位置固定**的入口：ChatInput 发送键在 `loading && onStop` 时变为停止键（`chat-input.tsx`），输入框不回流、永远可点

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

### 回合分组渲染（执行流程）
OpenCode 一个 user 回合会产出 **N 条 assistant message**（每个工具循环 step 一条，`finish="tool-calls"` 则继续；详见 [ADR-029](decisions/029-execution-flow-turn-grouping.md)）。主对话**不要按 message 平铺渲染**，而是：
- `message-list.tsx` 的 `groupIntoTurns()` 把「一条 user + 其后连续 assistant」聚成一个回合，渲染 `AssistantTurn`。
- `AssistantTurn` 的 `buildTurnModel()` 把整回合 parts 切成「过程」（收进无卡片包裹的 `ExecutionFlow` 折叠时间线）与「答案」（最后一条**无 tool** message 的输出 part，容器外渲染）；末尾渲染居中带横线的统计页脚。
- **回合是否在生成**：用「末条 `finish` 终态(存在且≠`tool-calls`) + 是否末回合 + 未 stop」判定，**不要**用瞬时 `streamingMessageId`（step 间/工具执行期会置 null → 抖动）。
- **memo**：`groupIntoTurns` 每渲染重建数组，`AssistantTurn` 必须用自定义比较器（按 `messages` 元素引用比较）才能让历史回合在流式中跳过重渲染——历史 message 对象引用稳定（state 只换变化的那条）。
- **实时耗时**：`ExecutionFlow` 的 `useNow(active)`（100ms tick）只在「回合流式中 && 该行进行中」时激活（`live=isStreaming` 下传）——恢复/被 stop 的历史回合里残留的 running/thinking 状态**不得走秒**；滴答重渲染被限制在进行中的行 + 头部，不穿透 memo 屏障。

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

### Production vs Dev URL 差异
Dev 模式下 Vite proxy 将相对路径转发到后端，Production 下没有 proxy。所有 localhost 服务请求必须区分环境：
```ts
// OpenCode API（已有模式）
const baseUrl = import.meta.env.DEV ? "" : "http://localhost:4096"
// Gateway
const GATEWAY_BASE = import.meta.env.DEV ? "/channel" : "http://localhost:4097/channel"
```

### Gateway CORS 白名单
Production 下 Tauri webview origin（`tauri://localhost`）跨域请求 Gateway，必须配置 CORS。仅允许已知 origin，不要用 `origin: "*"`：
```ts
cors({
  origin: ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost", "http://localhost:1420"],
})
```

### Gateway 重编译完整流程
修改 Gateway 代码后，必须重新编译 sidecar 二进制并重新打包 DMG：
```bash
bun run --bun scripts/build-gateway.ts  # 编译并复制到 src-tauri/binaries/
bun run --bun tauri build               # 打包 DMG
```
注意：仅 `turbo run build` 会编译到 `gateway/dist/`，**不会**更新 sidecar binaries 目录。

## 7. MCP 持久化

> 📍 MCP 的**踩坑点**（必须用 `bunx --bun` 不用 `npx`、Browser MCP npm 调用方式、工具名前缀叠加、CONNECT_TIMEOUT）见 [`gotchas.md`](./gotchas.md) §3（SSOT）。本节只讲持久化约定。

### 存储迁移（Issue#18）
MCP 服务配置已从 `localStorage` 迁移到 `opencode.json`（通过 Tauri command 读写工作区配置文件）。浏览器 MCP 全局配置存储在 `~/.config/ultrawork/opencode.json`，跨工作区自动恢复。

### Browser MCP 双模式
- **Playwright MCP**（默认）：`~/.ultrawork/mcp/playwright/`
- **Chrome DevTools MCP**（可选）：`~/.ultrawork/mcp/chrome-devtools/`
- Node.js 运行时：`~/.ultrawork/node/`（按需下载 v22）
- MCP 注册名 `browser` + 工具名 `browser_take_screenshot` → 实际调用名为 `browser_browser_take_screenshot`（前缀叠加）

## 8. 内置命令可见性

面向开发者的内置命令（`/init`, `/review`）通过前端过滤对普通用户隐藏，不在 CommandSelector 和 Skills Panel 中显示。过滤逻辑在 `command-selector.tsx` 和 `use-skills.ts` 中。

## 9. Logo 组件

品牌 Logo 使用 SVG 棱镜设计（`src/components/ui/logo.tsx`）。组件内部使用 `useId()` 为 SVG gradient 生成唯一 ID，防止同页面多实例时 gradient ID 冲突。

## 10. SSE 竞态防护（fire-and-forget 端点）

当后端端点以 fire-and-forget 方式启动异步任务（如索引、重建）时，如果任务完成速度快于 HTTP 响应传递，SSE 事件会在前端状态就绪前到达，导致事件被丢弃（前端 `setSources` 的 map 找不到匹配项）。

**修复模式（双重保障）：**

```typescript
// 后端：延迟启动异步任务，让 POST 响应先到达前端
setTimeout(() => {
  indexer.indexFolder(folderPath).catch(console.error)
}, 50)
return c.json({ status: "indexing" }, 202)

// 前端：乐观更新后 fallback 刷新，兜底 SSE 事件丢失
setSources((prev) => [...prev, { status: "indexing", totalFiles: 0, ... }])
setTimeout(() => fetchSources(), 500)
```

**适用场景**：所有返回 202 并以 fire-and-forget 启动后台任务、依赖 SSE 推送进度的端点（如 `/kb/sources` POST、`/kb/sources/:id/reindex`）。

## 11. ACP 外部 Agent 接入（@agent/acp-client，ADR-027 档1）

新接一个 ACP agent / 修改整形逻辑时遵循以下模式（反向坑点见 [gotchas §8](./gotchas.md)）：

**整形契约（sidecar 输出必须「长得和 opencode 一模一样」）：**

```
一个 prompt 回合 →
  user 回显 message（text part.updated + role:"user" 的 message.updated）
  N 个过程 message（reasoning/tool part；封板时 message.updated finish:"tool-calls"）
  1 个答案 message（仅 text part；endTurn 时 finish:"stop" + tokens/cost + time.completed）
```

- **先 `message.part.updated` 建 part（带正确 type），再 `message.part.delta` 追加**——永远不要让 delta 先到。
- tool_call / tool_call_update **按 toolCallId upsert** 到同一 part（核心逻辑集中在 `turn-shaper.ts`，纯函数可测）。
- 事件 sessionID 用客户端传入的 `clientSessionId` 直通，前端零改写。

**接入新 agent**：在 `~/.config/ultrawork/agents.json`（或 Settings UI）注册 `agent name → command/args/env`，无需新代码；Settings「添加 Agent」表单顶部有**预置模板 chips**（claude/gemini/qoder，`agent-templates.ts`，一键填充 command/args/env，已存在同 id 置灰）。per-agent 怪癖集中在 `acp-connection.ts`：常量区（超时等）+ **spawn 期 env 注入函数**（如 `applyGeminiQuirks`——检测 command/args 识别 agent，注入缺省 env + 托管 settings 文件，**显式 agent env 永远优先**，纯函数可离线测）。per-agent 行为开关走 env（如 claude thinking = `MAX_THINKING_TOKENS`，DEFAULT_AGENTS 默认 8192）或 agents.json 字段（如 `thoughtLevel` → 会话级 `session/set_config_option`，best-effort），`PUT /acp/agents/:id` 保存即热生效（断开重连）。

**会话历史持久化（W4b）**：sidecar 端 `session-store.ts` 维护与前端同构的 event-fold reducer（part.updated 按 id upsert / delta 追加 / message.updated merge info），在 user echo 落定与 assistant 终态封板时整体落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（**数据进 xdgData**，与 opencode 存量同级）。前端打开 ACP 会话从 `GET /acp/session/:id/messages` 取历史（`use-session-messages` 按 isACP 分流，hasMore=false）；agent 上下文在下次 prompt 时经 `session/load` 懒恢复 + replay 全抑制——**历史渲染永远不依赖 agent 存活**。会话删除时前端 fire-and-forget `DELETE /acp/session/:id` 防孤儿文件。

**档1 入口约束（one session, one agent）**：Home 是新会话唯一入口——侧栏「+」只 `navigate("/")`；Home 输入框带 AgentSelector（受控模式，会话尚不存在），发送时 `createSession → bindSessionAgent → 按 agent 分流 prompt`，**出生即绑定**；Session 页的 AgentSelector 在 `loading || sending || allMessages.length > 0` 时锁定（仅空会话可换）——中途切 agent 会让历史显示在 opencode/ACP 两个 store 间二选一。

**测试模式（三层）**：① mock ACP agent（`packages/agent/acp-client/scripts/mock-acp-agent.ts`，stdin JSON-RPC 确定性回放，`bun test src` 离线跑）→ ② 真实 agent spike 脚本落盘 fixture（`packages/agent/acp-client/scripts/spike-claude.ts`）→ ③ desktop vitest 用 fixture 喂真实 `buildTurnModel`/`groupIntoTurns` 断言渲染契约。

**真机 UI 验证（不依赖 Tauri 壳）**：Chrome（playwright-core `channel:"chrome"`）驱动 Vite :1420，`addInitScript` 预埋 localStorage——`ultrawork-config`（凭证取自 `~/.config/ultrawork/sidecar-auth.json`）+ `workspace_path`；WorkspaceSelector 的「继续」按钮纯 JS 可点，之后整个 app 流程可自动化（建会话/选 agent/发消息/断言渲染/截图）。
