# Iteration 2.4: SSE 流式响应 - Code Review

**审查时间**: 2026-03-06
**审查范围**: SSE 客户端、React Hook、Session.tsx 集成

---

## ✅ 通过的检查项

### 1. 类型安全
- ✅ SSEEvent 和 EventPayload 类型定义完整
- ✅ TypeScript 类型检查全部通过
- ✅ 事件处理器类型正确

### 2. SSE 客户端质量
- ✅ EventSource 生命周期管理正确
- ✅ 自动重连逻辑 (指数退避)
- ✅ 事件处理器订阅/取消订阅
- ✅ Basic Auth 支持

### 3. React Hook 质量
- ✅ useEffect cleanup 防止内存泄漏
- ✅ handlerRef 保持回调最新
- ✅ SSE 连接自动管理

### 4. Session.tsx 集成
- ✅ useCallback 防止重复订阅
- ✅ 流式消息追加逻辑正确
- ✅ 乐观 UI 实现
- ✅ 错误处理

### 5. 用户体验
- ✅ 流式指示器动画
- ✅ 乐观 UI 立即反馈
- ✅ 自动滚动到底部

---

## ⚠️ 发现的问题

### **Critical** - 必须修复

#### 1. SSEClient: EventSource 不支持 Basic Auth via URL
**问题描述**:
`EventSource` API **不支持**通过 URL 传递 Basic Auth 凭据。浏览器的 EventSource 实现不会发送 `Authorization` header，即使 URL 包含 `username:password@host`。

**影响范围**: SSEClient.connect()
**当前代码**:
```typescript
const url = new URL("/event", this.config.baseUrl)
if (this.config.username && this.config.password) {
  url.username = this.config.username  // ❌ 不会工作
  url.password = this.config.password  // ❌ 不会工作
}
this.eventSource = new EventSource(url.toString())
```

**问题**:
- EventSource 不支持自定义 headers
- URL 中的 username/password 会被浏览器忽略
- 连接会因为 401 Unauthorized 失败

**解决方案**:
有两种方案：

**方案 A: 使用 fetch + ReadableStream (推荐)**
```typescript
async connect(): void {
  const url = new URL("/event", this.config.baseUrl)
  const headers: Record<string, string> = {}

  if (this.config.password) {
    const username = this.config.username || "opencode"
    const credentials = btoa(`${username}:${this.config.password}`)
    headers["Authorization"] = `Basic ${credentials}`
  }

  const response = await fetch(url.toString(), { headers })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    const chunk = decoder.decode(value)
    // Parse SSE format: "data: {...}\n\n"
    const lines = chunk.split('\n')
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6))
        this.handlers.forEach(h => h(data))
      }
    }
  }
}
```

**方案 B: 在服务端添加 token 查询参数支持**
修改 OpenCode 服务端支持 `?token=xxx`，然后：
```typescript
const url = new URL("/event", this.config.baseUrl)
if (this.config.password) {
  url.searchParams.set("token", btoa(`${username}:${password}`))
}
```

**是否应该在 2.4 中修复**: ✅ 是 (Critical)

---

#### 2. Session.tsx: 消息状态直接修改 (违反不可变性)
**问题描述**:
在 `message.delta` 处理中，直接修改了 `textPart.text`，违反了 React 状态不可变性原则。虽然当前可以工作，但可能导致未来的 bug。

**影响范围**: handleSSEEvent
**当前代码**:
```typescript
if (textPart) {
  textPart.text = (textPart.text || "") + delta  // ❌ 直接修改
} else {
  existing.parts.push({ type: "text", text: delta })  // ❌ 直接修改
}
```

**建议修复**:
```typescript
if (textPart) {
  // ✅ 创建新对象
  const updatedPart = { ...textPart, text: (textPart.text || "") + delta }
  existing.parts = existing.parts.map(p => p === textPart ? updatedPart : p)
} else {
  // ✅ 创建新数组
  existing.parts = [...existing.parts, { type: "text", text: delta }]
}
```

**是否应该在 2.4 中修复**: ✅ 是

---

### **Important** - 应该修复

#### 3. SSEClient: 重连时没有重置 reconnectDelay
**问题描述**:
`onopen` 中重置了 `reconnectAttempts` 但没有重置 `reconnectDelay`。虽然当前实现中 `reconnectDelay` 是基于 `reconnectAttempts` 计算的，但这个赋值是多余的且容易引起混淆。

**建议**: 移除 `reconnectDelay = 1000` 赋值，或者改为注释说明

**是否应该在 2.4 中修复**: ⚠️ 可选 (代码清晰度)

---

#### 4. Session.tsx: 缺少用户消息的真实 ID 替换
**问题描述**:
乐观添加的用户消息使用临时 ID (`temp-${Date.now()}`)，但发送成功后没有用真实 ID 替换。这可能导致：
- 消息列表中有重复消息 (临时 + 真实)
- React key 警告

**当前行为**:
1. 添加临时用户消息 (id: `temp-123`)
2. 发送成功
3. SSE 可能会推送真实用户消息 (id: `msg-456`)
4. 列表中有两条相同的用户消息

**建议修复**:
```typescript
const handleSend = async () => {
  // ... 添加临时消息
  try {
    const response = await api.sendMessage(id, userMessage)
    // ✅ 替换临时消息的 ID
    setMessages(prev => prev.map(m =>
      m.info.id === tempUserMessage.info.id
        ? { ...m, info: { ...m.info, id: response.info.id } }
        : m
    ))
  } catch (err) {
    // ... 错误处理
  }
}
```

**是否应该在 2.4 中修复**: ✅ 是

---

#### 5. SSEClient: 缺少连接状态回调
**问题描述**:
SSE 连接状态变化 (连接中、已连接、断开、重连中) 没有通知给 UI，用户无法知道当前连接状态。

**建议**: 添加状态回调
```typescript
export type SSEStateHandler = (state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting') => void

class SSEClient {
  private stateHandlers: Set<SSEStateHandler> = new Set()

  onStateChange(handler: SSEStateHandler): () => void {
    this.stateHandlers.add(handler)
    return () => this.stateHandlers.delete(handler)
  }
}
```

**是否应该在 2.4 中修复**: ❌ 否，属于 2.6 (设置面板 + 连接状态指示)

---

### **Nice-to-have** - 可选改进

#### 6. SSEClient: 缺少心跳超时检测
**问题描述**:
OpenCode 每 10s 发送 `server.heartbeat`，但客户端没有检测心跳超时。如果网络异常但 TCP 连接未断开，客户端可能长时间处于"假连接"状态。

**建议**: 添加心跳超时检测 (30s 无心跳则重连)

**是否应该在 2.4 中修复**: ❌ 否，后续优化

---

#### 7. Session.tsx: 缺少消息去重逻辑
**问题描述**:
如果 SSE 重连后重新推送已存在的消息，会导致消息重复。

**建议**: 在添加消息前检查 ID 是否已存在

**是否应该在 2.4 中修复**: ❌ 否，OpenCode 应该保证不重复推送

---

#### 8. useSSE: api 依赖可能导致不必要的重连
**问题描述**:
`useEffect` 依赖 `api` 对象，如果 `api` 引用变化，会断开并重新连接 SSE。

**建议**: 使用 `api.getBaseUrl()` 和 `api.getCredentials()` 作为依赖
```typescript
const baseUrl = api.getBaseUrl()
const credentials = api.getCredentials()

useEffect(() => {
  // ...
}, [baseUrl, credentials.username, credentials.password])
```

**是否应该在 2.4 中修复**: ❌ 否，当前实现可接受

---

### **Deferred** - 延后到后续迭代

#### 9. 缺少工具调用事件处理
**问题描述**: EventPayload 只定义了 3 种事件，缺少工具调用相关事件
**归属迭代**: Phase 3

#### 10. 缺少错误事件处理
**问题描述**: 没有处理 `error` 类型的 SSE 事件
**归属迭代**: 后续优化

---

## 📊 总结

### 必须修复 (2.4 中)
1. ✅ **SSEClient: EventSource Basic Auth 不工作** - 改用 fetch + ReadableStream
2. ✅ **Session.tsx: 消息状态直接修改** - 使用不可变更新
3. ✅ **Session.tsx: 缺少用户消息 ID 替换** - 发送成功后替换临时 ID

### 可选改进 (延后)
- SSEClient reconnectDelay 赋值
- 连接状态回调 (2.6)
- 心跳超时检测
- 消息去重
- useSSE 依赖优化
- 工具调用事件
- 错误事件处理

### 整体评价
**代码质量**: ⭐⭐⭐⭐☆ (4/5) - EventSource Auth 问题严重
**功能完整性**: ⭐⭐⭐⭐☆ (4/5) - 缺少用户消息 ID 替换
**架构设计**: ⭐⭐⭐⭐⭐ (5/5) - SSEClient + useSSE 分离良好

2.4 的架构设计很好，但有 3 个关键问题需要修复。修复后即可认为 2.4 完全完成。

---

## 🔍 额外发现

### 性能考虑
- ✅ useCallback 防止重复订阅
- ✅ handlerRef 避免闭包陷阱
- ⚠️ 每次 delta 都触发 setMessages，可能需要节流 (但当前可接受)

### 可访问性
- ⚠️ 流式指示器没有 aria-live 属性
- ⚠️ 连接状态没有屏幕阅读器提示

### 代码组织
- ✅ SSEClient 职责清晰
- ✅ useSSE Hook 封装良好
- ✅ 事件类型定义完整
