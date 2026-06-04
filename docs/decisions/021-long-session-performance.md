# ADR-021: 长对话性能优化 — 渐进式渲染与分页加载
**状态**: Accepted (✅ 已实现)
**日期**: 2026-04-23
**关联**: ADR-004 (Structured Message Parts), ADR-008 (SSE Global + Polling Fallback), ADR-012 (Optimistic Message + Active Tracking)

---

## 背景

### 问题描述

当一个聊天 session 的对话轮次较多（100+ 轮，200+ 条消息）时，前端会出现明显的卡顿。每条助手消息可包含多个 MessagePart（文本、代码块、工具调用、推理块等），200 轮对话意味着 400+ 条消息 × N 个 Part 的 DOM 节点。

问题覆盖 4 个层面：API 加载、状态更新、渲染、滚动。

### 当前实现分析

#### 1. 渲染层 — 全量 DOM 渲染，无优化

**`message-list.tsx`** 用 `messages.map()` 把所有消息平铺渲染到 DOM：

```tsx
// message-list.tsx
{messages.map((message, index) => {
  const isStreaming = message.info.id === streamingMessageId
  // ... 渲染 UserMessage 或 AssistantMessage
})}
```

- 没有虚拟列表（无 react-window / @tanstack/virtual）
- 没有 `content-visibility` CSS 优化
- 所有消息节点同时存在于 DOM 中

**组件 Memoization 缺失**：

| 组件 | 文件 | React.memo | 影响 |
|------|------|-----------|------|
| `MessageList` | `message-list.tsx` (69行) | 无 | 每次 messages 变化都重渲染 |
| `AssistantMessage` | `assistant-message.tsx` (206行) | 无 | 每条助手消息都重新执行 render 函数 |
| `UserMessage` | `user-message.tsx` (15行) | 无 | 纯展示但无 memo |
| `ToolCallBlock` | `tool-call-block.tsx` (101行) | 无 | 内含 useState，StatusIcon 嵌套函数每次重建 |
| `CodeBlock` | `code-block.tsx` (73行) | 无 | handleCopy 未 useCallback |
| `ReasoningBlock` | `reasoning-block.tsx` (32行) | 无 | setOpen 未 useCallback |
| `StepIndicator` | `step-indicator.tsx` (42行) | 无 | 轻量但未 memo |
| `ExecutionStatus` | `execution-status.tsx` (54行) | 无 | 轻量但未 memo |

**`assistant-message.tsx` 隐藏性能热点**：

```tsx
// assistant-message.tsx 内部 MarkdownContent 函数
function MarkdownContent({ text }: { text: string }) {
  // 每次 render 都重建这个 components 对象（12+ 个内联组件函数）
  const components = {
    p: ({ children }) => <p>...</p>,
    ul: ({ children }) => <ul>...</ul>,
    code: ({ children, className }) => <CodeBlock>...</CodeBlock>,
    // ... 12+ 个组件
  }
  return <ReactMarkdown components={components}>{text}</ReactMarkdown>
}
```

`ReactMarkdown` 收到新的 `components` 引用后会重新解析和渲染整个 markdown 树。200 轮对话中，每条助手消息的 markdown 都会被反复重渲染。

此外，`FileBlock` 和 `PatchBlock` 是 `AssistantMessage` 内部的嵌套函数，每次 render 重建。`ToolCallBlock` 内部的 `StatusIcon` 同理。

#### 2. 状态层 — 单一数组，O(n) 更新

**`Session.tsx`** (755 行) 将所有消息存储在单一 `useState` 数组中：

```tsx
// Session.tsx:32
const [messages, setMessages] = useState<SendMessageResponse[]>([])
```

每次 SSE `message.part.delta` 事件（即每个 token）都会：

```tsx
// Session.tsx:189-223 (message.part.delta case)
setMessages((prev) => {
  const msgIndex = prev.findIndex((m) => m.info.id === messageID)  // O(n)
  if (msgIndex >= 0) {
    const updated = [...prev]  // 浅拷贝整个数组
    const msg = { ...updated[msgIndex] }  // 拷贝消息对象
    const pIndex = msg.parts.findIndex(...)  // 查找 part
    // 重建 parts 数组
    msg.parts = [...msg.parts.slice(0, pIndex), updatedPart, ...msg.parts.slice(pIndex + 1)]
    updated[msgIndex] = msg
    return updated
  }
  // ...
})
```

以 10 tokens/秒计算，每秒 10 次：
- `findIndex` 遍历 200+ 条消息
- 浅拷贝整个消息数组
- 重建 parts 数组
- 触发 React 整棵消息树的 reconciliation

**`workspaceRefreshKey` 的 O(n×m) 计算**：

```tsx
// Session.tsx:590-598
const workspaceRefreshKey = useMemo(() => {
  return messages.reduce((count, msg) => {
    return count + msg.parts.filter(
      p => p.type === "tool" && p.state?.status === "completed"
    ).length
  }, 0)
}, [messages])
```

每次 `messages` 变化，遍历所有消息的所有 parts 统计已完成工具数。

#### 3. 数据层 — 一次全量加载，无分页

**`api-client/src/client.ts:119-121`**：

```typescript
async getMessages(sessionId: string): Promise<SendMessageResponse[]> {
  return this.request<SendMessageResponse[]>(`/session/${sessionId}/message`)
}
```

- 一次拉取整个 session 的所有消息
- 没有传 `limit` 或 `before` 参数
- 200 轮对话的初始加载预计 2-5 秒

**但 OpenCode 服务端已支持游标分页**（`vendor/opencode/.../routes/session.ts:548-634`）：

| 参数 | 类型 | 说明 |
|------|------|------|
| `limit` | number (≥0, optional) | 最大返回条数 |
| `before` | string (optional) | 游标（base64url 编码的 `{id, time}`） |
| **约束** | | `before` 存在时 `limit` 必须也存在 |

响应头 `X-Next-Cursor` 包含下一页游标，`Link` 头包含完整的下一页 URL。

游标实现（`vendor/opencode/.../session/message-v2.ts:822-857`）基于 keyset pagination：
```typescript
// 服务端 page() 函数
const rows = db.select().from(MessageTable)
  .where(where)
  .orderBy(desc(time_created), desc(id))
  .limit(input.limit + 1)  // limit+1 检测是否有更多
  .all()

return {
  items,
  more: rows.length > input.limit,
  cursor: more && tail ? cursor.encode({ id: tail.id, time: tail.time_created }) : undefined,
}
```

#### 4. 滚动层 — 无区分，布局抖动

**`Session.tsx:429-441`**：

```tsx
// 每次 messages 变化 + isAtBottom 时都触发
useEffect(() => {
  if (isAtBottom) {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }
}, [messages, isAtBottom])

// scroll 事件监听（无 passive，无防抖）
useEffect(() => {
  const handleScroll = () => checkIfAtBottom()
  container.addEventListener("scroll", handleScroll)
  // ...
}, [checkIfAtBottom])
```

- 无法区分用户主动滚动 vs 程序触发的滚动
- `smooth` 动画在高频 SSE 更新下产生"追赶"效果
- scroll 事件未设 `passive: true`
- 依赖 `messages` state 触发滚动，而非内容区域高度变化

### 预估体感

| 消息轮次 | 体感 |
|---------|------|
| < 30 轮 | 流畅 |
| 30-80 轮 | 开始有轻微卡顿（SSE delta 期间） |
| 80-150 轮 | 明显掉帧，流式输出有延迟感 |
| 200+ 轮 | 严重卡顿，CPU 持续高占用 |

---

## 参考实现：vendor/opencode 桌面端

OpenCode 的桌面端（SolidJS）对长对话场景做了完整的渐进式优化，以下是关键机制：

### R1. 分批挂载（Staged Mounting）

`message-timeline.tsx` 中的 `createTimelineStaging()` 实现分阶段渲染：

```typescript
// message-timeline.tsx:298
const stageCfg = { init: 1, batch: 3 }
```

- 首屏只渲染 **1 条消息**（`init: 1`）
- 后续每帧通过 `requestAnimationFrame` 追加 **3 条**（`batch: 3`）
- 把 200 条消息的渲染分摊到 60+ 帧，不阻塞首屏
- 一旦某个 session 完成 staging，切回来不会重新 stage

### R2. CSS content-visibility

```typescript
// message-timeline.tsx:946-949
style={{
  "content-visibility": active() ? undefined : "auto",
  "contain-intrinsic-size": active() ? undefined : "auto 500px",
}}
```

- 非活跃消息被浏览器完全跳过绘制和合成
- `500px` 估算高度防止滚动条跳动
- "活跃" = 正在流式输出的消息（通过 `activeMessageID()` memo 判断）

### R3. 历史窗口 + 分页加载

```typescript
// session.tsx:90-95
const turnInit = 10           // 初始展示 10 轮
const turnBatch = 8           // 向上滚动每次追加 8 轮
const turnScrollThreshold = 200  // 距顶 200px 触发
const turnPrefetchBuffer = 16    // 距窗口顶部 16 轮时预取
const prefetchCooldownMs = 400   // 预取冷却
const prefetchNoGrowthLimit = 2  // 连续无增长停止预取
```

窗口计算：

```typescript
// session.tsx:126-137
const renderedUserMessages = createMemo(() => {
  const msgs = input.visibleUserMessages()
  const start = turnStart()
  if (start <= 0) return msgs
  return msgs.slice(start)  // 从 turnStart 到末尾
})
```

服务端分页：初始 80 条 (`initialMessagePageSize`)，历史 200 条/页 (`historyMessagePageSize`)，使用 `before` 游标。

### R4. 滚动位置保持

```typescript
// session.tsx:139-153
const preserveScroll = (fn: () => void) => {
  const el = input.scroller()
  const beforeTop = el.scrollTop
  const beforeHeight = el.scrollHeight
  fn()  // 执行状态变更
  requestAnimationFrame(() => {
    const delta = el.scrollHeight - beforeHeight
    if (delta) el.scrollTop = beforeTop + delta
  })
}
```

### R5. 智能自动滚动

```typescript
// create-auto-scroll.tsx
// markAuto/isAuto 机制区分程序滚动 vs 用户滚动
const markAuto = (el) => {
  auto = { top: Math.max(0, el.scrollHeight - el.clientHeight), time: Date.now() }
}
const isAuto = (el) => {
  return auto && Date.now() - auto.time <= 1500 && Math.abs(el.scrollTop - auto.top) < 2
}
```

- `overflow-anchor` 动态切换：用户回看时 `auto`（锚定），自动跟随时 `none`
- ResizeObserver 在 layout 后 paint 前触发滚动，同帧完成
- 只有向上滚动（`deltaY < 0`）才暂停自动跟随
- 嵌套可滚动区域（代码块）有边界检测，到达边界才触发主时间线滚动

### R6. LRU 会话缓存

```typescript
// sync.tsx:189
// 内存中最多保留 30 个会话的消息缓存
// 切换会话时无需重新拉取
```

### 对比总结

| 维度 | Ultrawork (React) | OpenCode Desktop (SolidJS) |
|------|-------------------|---------------------------|
| **渲染策略** | 全量 DOM 渲染 | 分批挂载 + content-visibility |
| **消息加载** | 一次全量 | 游标分页 + 10 轮初始窗口 |
| **向上回溯** | 无 | 8 轮/批 + 预取 |
| **SSE 更新代价** | O(n) 数组拷贝 + 全树 diff | SolidJS 细粒度响应式，只更新变化节点 |
| **组件缓存** | 无 memo | SolidJS 天然不重渲染未变化的组件 |
| **滚动优化** | 每次 messages 变化 scrollIntoView | ResizeObserver + overflow-anchor + markAuto/isAuto |
| **200 轮体验** | 预计严重卡顿 | 预计流畅 |

---

## 考虑过的替代方案

### A1. 虚拟列表（react-window / @tanstack/virtual）

**描述**：只渲染视口内的消息节点，滚动时动态回收和创建。

**不采用的理由**：
- 聊天消息高度不固定（含代码块、工具调用、推理块），需要动态高度测量，实现复杂度高
- OpenCode 桌面端也**没有使用虚拟列表**，而是用 `content-visibility` + 历史窗口达到了相当的效果
- `content-visibility: auto` 是浏览器原生的"虚拟化"，不需要计算高度、不需要绝对定位，兼容性好（Chrome 85+, Safari 15.4+, Tauri WebView 完全支持）
- 虚拟列表会破坏浏览器原生搜索（Cmd+F）、无障碍功能等
- 配合历史窗口（DOM 中最多 ~50 轮消息），`content-visibility` 足以覆盖所有场景

### A2. 引入 zustand / jotai 原子化状态

**描述**：用原子化状态库替代 `useState<SendMessageResponse[]>`，让每条消息的状态独立更新。

**不采用的理由**：
- 引入新状态库的迁移成本高（所有 Context 消费者都要改）
- 通过 "streaming 消息分离" + `React.memo` 可以在不引入新库的前提下达到类似效果
- 项目现有的 Context + hooks 模式一致性好，不宜为单一优化引入新范式

### A3. Web Worker 处理 SSE 事件

**描述**：在 Web Worker 中处理 SSE 事件的解析和状态构建，主线程只接收最终结果。

**不采用的理由**：
- SSE 事件处理本身不是 CPU 密集型（JSON.parse + 对象构建）
- 瓶颈在 React 渲染而非 JS 计算
- Worker 与主线程的序列化/反序列化开销可能抵消收益
- 增加了调试复杂度

### A4. 消息内容合并/压缩

**描述**：对历史消息做客户端侧的裁剪（如只保留摘要、折叠工具调用详情）。

**不采用的理由**：
- 破坏数据完整性，用户无法回看完整的工具执行过程
- 合并策略难以定义，不同用户对"重要信息"的判断不同
- 通过分页 + 窗口化可以在不丢失数据的前提下解决性能问题

---

## 决策与实施结果

> **注意**：以下内容反映最终实施结果，部分设计在实施中根据实测调整。

采用四阶段渐进式优化方案，覆盖渲染、状态、数据、滚动四个层面。每个 Phase 独立交付和验证。

### Phase 1：渲染层优化（止血，不改数据流）

#### 1.1 组件 Memoization

对所有消息相关的子组件添加 `React.memo()`，全部使用默认浅比较（实测足够，无需自定义 comparator）：
`UserMessage`、`AssistantMessage`、`ToolCallBlock`、`CodeBlock`、`ReasoningBlock`、`StepIndicator`、`ExecutionStatus`、`MarkdownContent`、`FileBlock`、`PatchBlock`。

`MessageList` 本身不需要 memo — 它是 Session.tsx 的直接子组件，`messages` 引用每次 SSE 都会变。需要 memo 的是 `.map()` 出来的每一项。

#### 1.2 MarkdownContent components 对象提取

将 `assistant-message.tsx` 中的 markdown `components` 对象和 `remarkPlugins` 数组提取到模块顶层常量（`MARKDOWN_COMPONENTS`、`REMARK_PLUGINS`），避免每次 render 重建导致 ReactMarkdown 重新解析。

`FileBlock` 和 `PatchBlock` 拆成独立 memo 组件，直接接收 `onArtifactClick` 引用（不再由父组件创建内联 onClick 闭包），避免穿透 memo。

#### 1.3 内嵌函数提取

- `StatusIcon` 已在 `ToolCallBlock` 外部定义，无需提取
- `CodeBlock` 的 `handleCopy` 添加 `useCallback([children])`

#### 1.4 CSS content-visibility

`message-list.tsx` 中提取模块级稳定常量：

```tsx
const CONTENT_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 500px',
}
```

每条消息容器使用 `style={isStreaming ? undefined : CONTENT_VISIBILITY_STYLE}`。streaming 消息正常渲染，非活跃消息由浏览器跳过绘制。

#### 1.5 workspaceRefreshKey 优化

将 O(n×m) 的 `useMemo` 改为增量计数器 `toolCompletionCount`：
- SSE `message.part.updated` 中检测 tool completed 时 `+1`
- 初始加载消息时扫描已完成 tool 数量作为种子值
- session 切换时重置为 0

### Phase 2：状态层重构（Hook 提取）

#### 2.1 Session.tsx 拆分

将 763 行的巨型组件拆分为 2 个 hook + 组装层（滚动 hook 在 Phase 4 提取）：

```
Session.tsx (763行)
  → lib/use-session-messages.ts  (消息状态 + SSE 处理，568行)
  → lib/use-session-permission.ts (权限/问题处理，130行)
  → pages/Session.tsx            (组装 + 渲染，252行)
```

`useSessionMessages` hook API：

```typescript
function useSessionMessages(
  sessionId: string | undefined,
  options?: { initialSending?: boolean; initialMessageText?: string }
) {
  return {
    messages: SendMessageResponse[],       // 窗口化后的消息（给 MessageList 渲染）
    allMessages: SendMessageResponse[],    // 全量消息（给侧边栏使用）
    sending, loading, streamingMessageId,
    stopped, stoppedAtMessageId, toolCompletionCount,
    turnStart, hasMore, historyLoading,    // 历史窗口状态
    sendMessage, stopGeneration,           // 操作
    backfillTurns, loadEarlierMessages, onScrollNearTop, // 历史加载
  }
}
```

关键实现细节：
- `options` 通过 `optionsRef` 在 session-reset effect 中安全读取，避免闭包过期
- 所有 ref（`sendingRef`, `stoppedRef`, `messagesRef`, `idRef`, `frozenMessageIdsRef`）封装在 hook 内部
- cleanup effect 仅在 `sendingRef.current === true` 时调用 `markSessionIdle`，避免非必要的 `time.updated` 写入
- 8 秒安全超时保留在 hook 中

#### 2.2 关于 Streaming 消息分离

> **设计调整**：原方案中的 `historyMessages` + `streamingMessage` 双 state 分离**未在本轮实施**。实际保持了单一 `messages` 数组。
>
> 理由：Phase 1 的 memo + content-visibility 已显著降低了 SSE 更新的渲染开销，Phase 3 的历史窗口进一步减少了 DOM 中的消息数量。实测中未观察到明显的流式输出卡顿，streaming 分离的收益不足以证明其引入的复杂度（需要 streamingMessageRef 分流路由、双 state 同步、stop/freeze 逻辑适配等）。
>
> 如果未来在 200+ 轮对话中观察到流式输出掉帧，可作为后续优化引入。相关设计方案保留在本文档的"考虑过的替代方案"中供参考。

#### 2.3 useDeferredValue

**未实施**。streaming 分离未做的情况下，`useDeferredValue` 的价值更低。保留为未来可选优化。

### Phase 3：数据层改造

#### 3.1 api-client 增加分页接口

**前提改动**：当前 `ApiClient.request<T>()` (`client.ts:64-89`) 只返回 JSON body，丢弃 `Response` 对象，无法读取 `X-Next-Cursor` 响应头。需要先新增一个保留响应头的基础方法。

```typescript
// packages/core/api-client/src/client.ts

// 新增：保留 Response 对象的请求方法
private async requestWithResponse<T>(
  path: string, options?: RequestInit
): Promise<{ data: T; response: Response }> {
  const url = `${this.baseUrl}${path}`
  const response = await fetch(url, {
    headers: this.buildHeaders(),
    ...options,
  })
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  const data = await response.json()
  return { data, response }
}

// 新增：分页消息接口
async getMessagesPaginated(
  sessionId: string,
  options: { limit: number; before?: string }
): Promise<PaginatedMessagesResponse> {
  const params = new URLSearchParams({ limit: String(options.limit) })
  if (options.before) params.set('before', options.before)
  const { data, response } = await this.requestWithResponse<SendMessageResponse[]>(
    `/session/${sessionId}/message?${params}`
  )
  const cursor = response.headers.get('X-Next-Cursor') || undefined
  return { messages: data, cursor, hasMore: !!cursor }
}
```

**注意**：服务端要求 `before` 存在时 `limit` 也必须存在（`session.ts:586-596` 的 refine 校验），`getMessagesPaginated` 的接口设计中 `limit` 为必填参数以匹配此约束。

服务端响应格式确认：
- 响应体是 **纯数组** `SendMessageResponse[]`（非包装对象）
- 分页信息通过响应头传递：`X-Next-Cursor`（游标）、`Link`（下一页 URL）
- 需要 `Access-Control-Expose-Headers: Link, X-Next-Cursor`（服务端已设置）

```typescript
// packages/core/api-client/src/types.ts 新增

export interface PaginatedMessagesResponse {
  messages: SendMessageResponse[]
  cursor: string | undefined
  hasMore: boolean
}

export interface MessageLoadOptions {
  limit: number
  before?: string
}
```

保留原有 `getMessages()` 不变（向后兼容）。`requestWithResponse()` 也可用于未来其他需要读取响应头的 API。

#### 3.2 历史窗口机制

在 `useSessionMessages` 中实现，参考 OpenCode `session.tsx:89-314`：

配置常量：

| 常量 | 值 | 含义 |
|------|---|------|
| `TURN_INIT` | 15 | 进入 session 加载最近 15 轮 |
| `TURN_BATCH` | 8 | 向上滚动追加 8 轮 |
| `INITIAL_PAGE_SIZE` | 80 | 首次 API 请求 limit |
| `HISTORY_PAGE_SIZE` | 200 | 历史回溯 limit |
| `PREFETCH_BUFFER` | 16 | 距窗口顶部 16 轮时预取 |
| `PREFETCH_COOLDOWN` | 400 | 预取冷却 ms |

窗口状态：

```typescript
interface HistoryWindowState {
  allCachedMessages: SendMessageResponse[]  // 已从服务端拉取的全部消息
  turnStart: number                         // 渲染窗口起始索引
  cursor: string | undefined               // 服务端分页游标
  hasMore: boolean                          // 服务端是否还有更多
  historyLoading: boolean                   // 是否正在加载历史
}
```

消息加载流程：

```
进入 session
  → getMessagesPaginated(id, { limit: 80 })
  → 缓存全部 80 条到 allCachedMessages
  → turnStart = max(0, userMessageCount - 15)
  → 只渲染 allCachedMessages.slice(turnStart) 的消息

用户向上滚动（距顶 < 200px）
  → turnStart -= TURN_BATCH (从缓存中追加 8 轮，无网络)
  → 如果 turnStart ≤ PREFETCH_BUFFER 且 hasMore
    → getMessagesPaginated(id, { limit: 200, before: cursor })
    → prepend 到 allCachedMessages
    → 调整 turnStart 保持当前阅读位置

到达缓存顶部 (turnStart === 0) 且 hasMore
  → 显示 "加载更早消息" 按钮
  → 点击 → loadAndReveal() 拉取 + 展示
```

渲染窗口计算：

```typescript
const renderedMessages = useMemo(() => {
  if (turnStart <= 0) return allCachedMessages
  return allCachedMessages.slice(turnStart)
}, [allCachedMessages, turnStart])

const displayMessages = useMemo(() => {
  if (!streamingMessage) return renderedMessages
  return [...renderedMessages, streamingMessage]
}, [renderedMessages, streamingMessage])
```

#### 3.3 "加载更早消息" UI

在 `message-list.tsx` 顶部：

```tsx
{(turnStart > 0 || hasMore) && (
  <div className="flex justify-center py-3">
    <button
      onClick={onLoadEarlier}
      disabled={historyLoading}
      className="text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
    >
      {historyLoading ? '加载中...' : '加载更早消息'}
    </button>
  </div>
)}
```

#### 3.4 滚动位置保持

> **设计调整**：原方案中的 `preserveScroll` + `flushSync` 独立函数**未在本轮实施**。滚动位置保持由 Phase 4 的 `useSessionScroll` hook 统一处理：向上加载历史时，`turnStart` 变化触发 `displayMessages` 重新计算，`useSessionScroll` 的 `messages` 依赖触发 `doScrollToBottom`，由 `userScrolledRef` 控制是否执行。
>
> 如果未来出现向上 backfill 时滚动跳动，可引入 `flushSync` 版本的 `preserveScroll`。

### Phase 4：滚动层升级

提取 `lib/use-session-scroll.ts` hook，统一管理所有滚动逻辑。

#### 4.1 区分用户滚动 vs 程序滚动

参考 OpenCode `create-auto-scroll.tsx`，实现 `markAuto`/`isAuto` 机制。关键实现细节：

- **`userScrolledRef`**：`userScrolled` state 的同步镜像 ref，解决 effect/callback 闭包过期问题。`setUserScrolledBoth()` 同时更新 state（触发渲染）和 ref（同步可读）
- **`doScrollToBottom`**：纯 DOM 操作（`el.scrollTop = el.scrollHeight`），不依赖任何 state，引用稳定
- **`scrollToBottom(force?)`**：公开 API，`force=true` 时无条件滚动并重置 `userScrolled`
- `handleWheel`：仅 `deltaY < 0`（向上滚）时标记 `userScrolled = true`
- `handleScroll`：距底 `< 100px` 时恢复自动跟随；通过 `isAutoScroll` 过滤程序触发的滚动事件
- 所有事件监听使用 `{ passive: true }`

#### 4.2 自动滚动触发机制

采用 **messages 引用 + ResizeObserver 双重触发**（非 ResizeObserver 独占）：

```typescript
// 主触发：messages 引用变化（覆盖新消息、初始加载、session 切换、SSE 部分更新）
useEffect(() => {
  if (userScrolledRef.current) return
  requestAnimationFrame(() => {
    if (!userScrolledRef.current) doScrollToBottom()
  })
}, [messages, doScrollToBottom])

// 补充触发：content-visibility 元素延迟布局导致 scrollHeight 漂移
useEffect(() => {
  if (!sessionId) return
  const timers = [
    setTimeout(() => { if (!userScrolledRef.current) doScrollToBottom() }, 100),
    setTimeout(() => { if (!userScrolledRef.current) doScrollToBottom() }, 300),
  ]
  return () => timers.forEach(clearTimeout)
}, [sessionId])

// ResizeObserver：streaming 文本增长（单条消息内容变化但 messages 数组引用可能不变）
const observer = new ResizeObserver(() => {
  if (!userScrolledRef.current) doScrollToBottom()
})
observer.observe(contentRef.current)
```

> **设计调整**：最初设计为 ResizeObserver 独占替代 messages 依赖。实测发现 ResizeObserver 在 Tauri WebView 中不一定可靠触发（content-visibility 影响），改为 messages 引用作为主触发 + ResizeObserver + settle 延迟三重保障。

#### 4.3 overflow-anchor 动态切换

```typescript
el.style.overflowAnchor = userScrolled ? "auto" : "none"
```

- 用户回看时 `auto`：浏览器锚定当前内容位置
- 自动跟随时 `none`：允许程序控制滚动位置
- Safari/Linux WebKit 不支持时安全降级（等同 `none`）

---

## 改动文件清单（实际）

| Phase | 文件 | 改动类型 | 改动内容 |
|-------|------|---------|---------|
| **1** | `components/chat/user-message.tsx` | 修改 | 添加 `React.memo` |
| **1** | `components/chat/assistant-message.tsx` | 重构 | 提取 `MARKDOWN_COMPONENTS`/`REMARK_PLUGINS` 到模块顶层；`FileBlock`/`PatchBlock` 拆为独立 memo 组件（接收 `onArtifactClick`）；`MarkdownContent`/`AssistantMessage` 添加 `React.memo` |
| **1** | `components/chat/tool-call-block.tsx` | 修改 | 添加 `React.memo`（`StatusIcon` 已在外部） |
| **1** | `components/chat/code-block.tsx` | 修改 | `handleCopy` 添加 `useCallback`；添加 `React.memo` |
| **1** | `components/chat/reasoning-block.tsx` | 修改 | 添加 `React.memo` |
| **1** | `components/chat/step-indicator.tsx` | 修改 | 添加 `React.memo` |
| **1** | `components/chat/execution-status.tsx` | 修改 | 添加 `React.memo` |
| **1** | `components/chat/message-list.tsx` | 修改 | `CONTENT_VISIBILITY_STYLE` 模块常量 + `content-visibility` CSS |
| **2** | `lib/use-session-messages.ts` | **新建** | 从 Session.tsx 提取消息状态 + SSE 处理 hook |
| **2** | `lib/use-session-permission.ts` | **新建** | 从 Session.tsx 提取权限/问题处理 hook |
| **2** | `pages/Session.tsx` | 重构 | 瘦身为组装层 |
| **3** | `core/api-client/src/client.ts` | 修改 | 新增 `requestWithResponse()` + `getMessagesPaginated()` |
| **3** | `core/api-client/src/types.ts` | 修改 | 新增 `PaginatedMessagesResponse` |
| **3** | `core/api-client/src/index.ts` | 修改 | 导出新类型 |
| **3** | `lib/use-session-messages.ts` | 修改 | 历史窗口机制（`turnStart`/`displayMessages`/`backfill`/`prefetch`） |
| **3** | `components/chat/message-list.tsx` | 修改 | 增加"加载更早消息"按钮（`showLoadEarlier`/`onLoadEarlier`） |
| **3** | `lib/i18n-context.tsx` | 修改 | 新增 `message.loadEarlier` 翻译 |
| **3** | `pages/Session.tsx` | 修改 | 集成历史窗口 props + 近顶滚动触发 |
| **4** | `lib/use-session-scroll.ts` | **新建** | 完整滚动管理 hook |
| **4** | `pages/Session.tsx` | 修改 | 使用 `useSessionScroll`，移除内联滚动逻辑 |
| — | `scripts/test-long-session.ts` | **新建** | 长对话生成测试脚本 |

---

## 兼容性与风险

### 深入验证结论

以下风险点经过对 SSE 事件流、Session 生命周期、API 响应格式、content-visibility 兼容性的深入代码验证得出。

### 风险 1：历史消息并非完全不可变（中高风险 → 已降级）

**发现**：三种 SSE 事件可能修改已完成的历史消息（`message.part.updated`、`message.part.removed`、`message.updated`）。

**实际处置**：由于 streaming/history 分离未实施，当前保持单一 `messages` 数组，所有 SSE 事件统一处理，此风险不再适用。如果未来实施 streaming 分离，需参考此风险的分流路由设计。

### 风险 2：api-client 的 `request()` 方法不返回响应头（高风险，阻塞 Phase 3）

**发现**：当前 `ApiClient.request<T>()` 方法 (`client.ts:64-89`) 只返回 JSON body (`T`)，丢弃了 `Response` 对象。分页需要读取 `X-Next-Cursor` 响应头。

```typescript
// 当前实现
private async request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(...)
  return response.json()  // Response 对象在这里被丢弃
}
```

**影响**：`getMessagesPaginated()` 不能复用现有 `request()` 方法，需要独立实现或扩展基础方法。

**应对方案**：新增 `requestWithResponse<T>()` 变体：
```typescript
private async requestWithResponse<T>(
  path: string, options?: RequestInit
): Promise<{ data: T; response: Response }> {
  const response = await fetch(url, { headers: this.buildHeaders(), ...options })
  if (!response.ok) throw new Error(...)
  const data = await response.json()
  return { data, response }
}
```

此方法也可用于未来其他需要读取响应头的 API（如 session 列表分页）。原有 `request()` 保持不变。

### 风险 3：Session 切换时 activeSessionIds 可能残留（低风险）

**发现**：当用户在 `markSessionActive()` 之后、`markSessionIdle()` 之前快速切换 session，`activeSessionIds` Set 中会残留旧 session ID。表现为左侧边栏该 session 的 StatusIcon 持续显示旋转动画。

**现有保护层**（按优先级）：
1. SSE `session.status:idle` 事件 → 清除（但需要 SSE 正常工作）
2. Session.tsx useEffect cleanup → 但在 hook 拆分后需要确保保留
3. 8 秒安全超时 → 最后兜底

**应对方案**：`useSessionMessages` hook 必须在 cleanup（unmount 或 sessionId 变化）时调用 `markSessionIdle()`：
```typescript
useEffect(() => {
  return () => {
    if (sessionId) markSessionIdle(sessionId)
  }
}, [sessionId])
```

### 风险 4：Hook 拆分时必须保留的状态同步机制（中风险）

**发现**：Session.tsx 使用了 4 个 `useRef` 作为"同步状态镜像"，用于在 SSE 回调闭包中读取最新值。这些 ref 与 state 的同步关系在 hook 拆分时容易遗漏。

| Ref | 对应 State | 用途 | 遗漏后果 |
|-----|-----------|------|---------|
| `sendingRef` | `sending` | handleSend 的同步互斥锁 | 双重发送 |
| `stoppedRef` | `stopped` | SSE handler 中立即阻断消息事件 | stop 后残留消息闪烁 |
| `messagesRef` | `messages` | handleStop 中读取当前消息列表做 freeze | freeze 漏消息 |
| `idRef` | `id` (from useParams) | error handler 中检查是否仍在同一 session | 跨 session 状态污染 |
| `frozenMessageIdsRef` | 无对应 state | 永久阻断已停止交互的消息 ID | 旧消息事件泄漏 |

**应对方案**：所有 ref 必须封装在 `useSessionMessages` hook 内部。hook 返回的 `stopGeneration` 和 `sendMessage` 方法内部使用 ref，外部消费者不直接接触 ref。

### 风险 5：8 秒安全超时的保留（低风险）

**发现**：当用户从 Home 页面发送消息并导航到 Session 页面时，如果 SSE 未能在 8 秒内送达任何消息事件，会触发一个安全超时来清除 `sending` 状态。这个超时的 cleanup 在 session id 变化时触发。

**应对方案**：此超时逻辑应保留在 `useSessionMessages` hook 中，并且：
- 超时仅在 `isSendingFromNav && sessionId` 都为真时激活
- cleanup 函数在 sessionId 变化或 unmount 时清除 timer
- 超时触发时检查 `sendingRef.current && !stoppedRef.current`

### 风险 6a：跨平台 WebView 兼容性（低风险）

**验证结果**：方案中所有技术在三个目标平台上均兼容。

| 技术 | macOS (WKWebView) | Windows (WebView2/Chromium) | Linux (WebKitGTK) |
|------|-------------------|---------------------------|-------------------|
| `content-visibility: auto` | Safari 15.4+ (2022) | Chrome 85+ (2020) | WebKitGTK 2.38+ (2022) |
| `ResizeObserver` | Safari 13.1+ (2020) | Chrome 64+ (2018) | WebKitGTK 2.28+ (2020) |
| `overflow-anchor` | **不支持** | 支持 | **不支持** |
| `contain-intrinsic-size` | Safari 15.4+ | Chrome 83+ | WebKitGTK 2.38+ |
| `flushSync` / React API | 平台无关 | 平台无关 | 平台无关 |

**唯一差异**：`overflow-anchor`（Phase 4.3）在 Safari/WebKit 内核上不支持。不支持时浏览器默认行为等同于 `overflow-anchor: none`，我们的 `preserveScroll` + `flushSync` 是主要的滚动位置保持方案，不依赖 `overflow-anchor`。Phase 4.3 作为渐进增强（progressive enhancement），支持时生效、不支持时安全降级。

### 风险 6b：content-visibility 与 Cmd+F 搜索的交互（低风险）

**发现**：`content-visibility: auto` 在 Tauri 2 WebView (WKWebView, Safari 15.4+) 上完全支持。vendor/opencode 代码中已在生产使用（`message-part.css`、`basic-tool.css`、`file.css` 均有）。

但 `content-visibility: auto` 下的浏览器原生搜索 (Cmd+F) 存在边缘行为：
- 搜索**能找到**隐藏消息中的文本（正确）
- 但跳转到匹配项时，部分 WebKit 版本可能不会完全展开隐藏元素，导致文字选中但显示不完整

**影响**：不阻塞实施。当前应用没有自定义搜索功能，原生 Cmd+F 的这个边缘情况对实际使用影响极小。

### 风险 7：分页后初始加载与 SSE 的合并竞态（中风险）

**发现**：当前的合并逻辑 (`Session.tsx:404-414`) 假设 `getMessages()` 返回全量数据。分页后只返回最近 80 条，如果在 API 响应到达前 SSE 已经送达了新消息，合并逻辑需要调整：

```
当前合并策略:
  serverIds = Set(api返回的消息IDs)
  sseOnly = prev.filter(m => !temp && !serverIds.has(m.id))
  result = [...api返回, ...sseOnly]
```

分页后的问题：API 只返回最近 80 条，SSE 可能送达的消息（如果用户发送了新消息）不在这 80 条中（因为是新产生的），合并后应该追加在末尾。

**应对方案**：合并逻辑改为"API 返回作为 cache 基础，SSE-only 消息追加到末尾"。由于 SSE 消息只可能是比 API 返回更新的（时间上更晚），直接追加是安全的。

### 风险 8：Legacy SSE 事件未纳入 streaming 分离设计（中风险）

**发现**：当前 `Session.tsx:254-302` 处理两个 legacy SSE 事件类型：

| 事件 | 行为 |
|------|------|
| `message.delta` | 等同于 `message.part.delta`，但直接追加 delta 到第一个 text part |
| `message.completed` | 等同于 `message.updated` + finish，清除 `streamingMessageId` |

Phase 2 的 SSE handler 分流设计只展示了现代事件（`message.part.delta`、`message.part.updated` 等），未覆盖 legacy 事件。

**影响**：如果后端发送 legacy 事件格式（兼容旧版客户端），streaming 分离逻辑不会处理，导致消息丢失。

**应对方案**：在 `useSessionMessages` hook 中保留 legacy 事件处理，路由到相同的分流逻辑：
```
message.delta → 等同于 message.part.delta 的 streaming 路径
message.completed → 等同于 message.updated(finish) 的 streaming→history 转移路径
```

### 风险 9：`preserveScroll` 与 React 18 批量更新的冲突（中风险）

**发现**：Phase 3.4 的 `preserveScroll` 模式依赖"调用 `action()` 后 DOM 立即更新"：

```typescript
const beforeScrollHeight = scrollContainer.scrollHeight
action()  // setState → 期望 DOM 立即变化
requestAnimationFrame(() => {
  const delta = scrollContainer.scrollHeight - beforeScrollHeight
  scrollContainer.scrollTop = beforeScrollTop + delta
})
```

但 React 18 默认对所有 state 更新做批量处理（automatic batching）。`action()` 中的 `setState` 不会立即触发 DOM 更新，可能要等到下一个微任务。`requestAnimationFrame` 回调可能在 React 完成 DOM 更新之前执行。

OpenCode 桌面端用的是 SolidJS，状态更新是同步的，不存在此问题。

**影响**：向上加载历史消息时，滚动位置可能跳动。

**应对方案**：在 `preserveScroll` 中使用 `flushSync` 强制同步更新：
```typescript
import { flushSync } from 'react-dom'

function preserveScroll(scrollContainer, action) {
  const beforeScrollTop = scrollContainer.scrollTop
  const beforeScrollHeight = scrollContainer.scrollHeight
  flushSync(() => { action() })  // 同步刷新 DOM
  const delta = scrollContainer.scrollHeight - beforeScrollHeight
  if (delta) scrollContainer.scrollTop = beforeScrollTop + delta
}
```

`flushSync` 会绕过批量更新，确保 `action()` 中的 state 变化立即反映到 DOM。这是 React 官方推荐的滚动位置保持方案。仅在 `preserveScroll` 中使用，不影响其他更新的性能。

### 风险 10：`useDeferredValue` 与 streaming 分离的冲突（低风险，需重新评估）

**发现**：Phase 2.3 建议对 `allMessages` 使用 `useDeferredValue`。但 streaming 分离后：

```typescript
const allMessages = useMemo(() => {
  if (!streamingMessage) return historyMessages
  return [...historyMessages, streamingMessage]
}, [historyMessages, streamingMessage])

const deferredMessages = useDeferredValue(allMessages)
```

`streamingMessage` 每个 token 都变化 → `allMessages` 每个 token 都重建 → `deferredMessages` 持续滞后于实际值。这意味着 MessageList 渲染的是**过时的** streaming 内容，与"让流式输出实时显示"的目标矛盾。

**影响**：流式输出可能出现视觉延迟或闪烁。

**应对方案**：streaming 分离本身已经解决了核心性能问题（delta 事件只触发 1 个组件重渲染）。`useDeferredValue` 的价值在分离后大幅降低。建议：
- **Phase 2.3 降级为可选优化**：仅在实测发现用户输入仍有延迟时才启用
- 如果启用，应该只对 `historyMessages` 使用 `useDeferredValue`（它们变化频率低），`streamingMessage` 不应该 defer
- 或者考虑用 `useTransition` 包裹"加载更早消息"的 state 更新，而非全量 defer

### 风险 11：`workspaceRefreshKey` 增量计数器在 backfill 时的遗漏（低风险）

**发现**：Phase 1.5 将 workspaceRefreshKey 从 O(n×m) 的 `useMemo` 改为增量计数器。但 Phase 3 引入历史消息分页加载后，用户向上滚动触发 backfill 时，新加载的历史消息中可能包含已完成的 tool parts。

增量计数器只在 SSE `message.part.updated` 中 `+1`，不会扫描 backfill 加载的历史消息。

**影响**：backfill 加载的消息中的 tool 完成状态不会触发 workspace 面板刷新。但这实际上是合理的 — backfill 的是历史消息，其 tool 执行结果早已反映在文件系统中，无需刷新。

**应对方案**：这不是 bug，保持现有设计即可。只需确保：
- 切换 session 时，初始加载的 80 条消息中扫描已完成 tool 数量作为初始值
- 此后增量 `+1` 只跟踪新的 tool 完成事件

### 风险 12：Home→Session 导航的 location.state 跨 hook 传递（低风险）

**发现**：当前 Session.tsx 在 navigation reset useEffect (`Session.tsx:64-106`) 中读取 `location.state.sending` 和 `location.state.messageText`，用于乐观 UI + 8 秒安全超时。

Hook 拆分后，`location.state` 由路由层提供（`useLocation()`），而消息状态在 `useSessionMessages` 中管理。需要在拆分时明确 `isSendingFromNav` 和 `messageText` 的传递方式。

**应对方案**：`useSessionMessages` hook 接受可选的初始参数：
```typescript
function useSessionMessages(
  sessionId: string | undefined,
  options?: { initialSending?: boolean; initialMessageText?: string }
)
```
由 Session.tsx 从 `location.state` 读取后传入。hook 内部处理乐观消息创建和 8 秒超时。

---

### 已保留的现有逻辑（已迁移到 hooks）

1. **frozenMessageIds 机制** → `use-session-messages.ts` `stopGeneration()` 中完整保留
2. **temp- 消息去重** → `use-session-messages.ts` SSE `message.part.updated` handler 中保留
3. **初始加载与 SSE 合并** → `use-session-messages.ts` 初始加载 effect 中保留（已适配分页）
4. **workspaceRefreshKey 增量计数** → `use-session-messages.ts` SSE handler + 初始扫描 + session 重置
5. **Permission/Question 轮询** → `use-session-permission.ts` 中独立管理，`isAgentActive` 由 Session.tsx 传入

### 不做的事

- **不引入虚拟列表**：`content-visibility` + 历史窗口足够
- **不引入新状态库**（zustand/jotai）：现有 Context + hooks 模式够用
- **不改 SSE 协议**：服务端事件格式不需要改
- **不做消息内容合并/压缩**：保持数据完整性

---

## 验收标准

| 场景 | 指标 |
|------|------|
| 200 轮对话，流式输出中 | FPS >= 55，无感知卡顿 |
| 200 轮对话，初始加载 | <= 500ms 可交互（只加载最近 15 轮） |
| 200 轮对话，快速向上滚动 | 平滑无跳动，历史消息按批出现 |
| 1000 轮对话，进入 session | <= 1s 可交互，不 OOM |
| 流式输出中用户打字 | 输入框无延迟 |

---

## 实施结果

```
Phase 1 — 渲染层优化 ✅ (eb1a823)
├── 1.1 React.memo 包裹所有消息子组件（默认浅比较）
├── 1.2 提取 MARKDOWN_COMPONENTS/REMARK_PLUGINS + FileBlock/PatchBlock 接收 onArtifactClick
├── 1.3 CodeBlock handleCopy 加 useCallback（StatusIcon 已在外部）
├── 1.4 CSS content-visibility（CONTENT_VISIBILITY_STYLE 模块常量）
└── 1.5 workspaceRefreshKey 增量计数器

Phase 2 — 状态层重构 ✅ (e927252)
├── 2.1 Session.tsx → useSessionMessages + useSessionPermission（含 optionsRef、sendingRef 守卫）
├── 2.2 streaming/history 分离 → 暂缓（实测无明显卡顿，留为后续优化）
└── 2.3 useDeferredValue → 暂缓

Phase 3 — 数据层改造 ✅ (272ed6c)
├── 3.1 api-client: requestWithResponse + getMessagesPaginated
├── 3.2 历史窗口: turnStart + displayMessages + backfill + prefetch
├── 3.3 "加载更早消息" 按钮 + i18n
└── 3.4 滚动位置保持 → 由 Phase 4 useSessionScroll 统一处理

Phase 4 — 滚动层升级 ✅ (ac9f7e4)
├── 4.1 useSessionScroll hook: markAuto/isAuto + userScrolledRef 镜像
├── 4.2 messages 引用 + ResizeObserver + settle 延迟三重触发
└── 4.3 overflow-anchor 动态切换 + passive 事件
```

### 未实施的设计（留为后续优化）

| 设计项 | 原计划 | 未实施原因 | 触发条件 |
|--------|--------|-----------|---------|
| streaming/history 消息分离 | Phase 2.2 | Phase 1 memo + Phase 3 窗口化已充分降低开销 | 200+ 轮对话流式输出出现掉帧 |
| useDeferredValue | Phase 2.3 | 与 streaming 分离耦合，单独使用价值低 | 用户输入延迟 |
| preserveScroll + flushSync | Phase 3.4 | useSessionScroll 的 doScrollToBottom 兜底足够 | 向上 backfill 时滚动跳动 |
