# ADR-022: 运行时模型切换的副作用分析与修复

**状态**: Accepted
**日期**: 2026-04-24
**关联**: ADR-006 (模型管理), ADR-008 (SSE 全局化)

## 背景

用户在 Ultrawork 桌面端使用 AI 回答问题的过程中，通过界面切换模型，会对正在执行的任务产生意外影响。需要完整分析切换模型的数据流和副作用链路，并修复发现的 bug。

## 分析：模型切换的完整链路

### 前端触发

```
UI 点击模型选择器
  → model-context.tsx setModel()
    → api.patchConfig({ model })     // PATCH /config 写磁盘
    → setCurrentModel(model)          // 更新 React 状态
```

### 后端连锁反应

```
PATCH /config
  → Config.update()                   // config.ts:1496 写 opencode.json
  → Instance.dispose()                // config.ts:1503
    → State.dispose(directory)        // 清理 Instance.state 注册的状态
    → disposeInstance(directory)       // 触发所有 registerDisposer 回调
      → ScopedCache.invalidate        // 对每个 InstanceState 缓存
        → Scope.close(entry.scope)    // 关闭 ScopedCache entry 的 scope
```

### 影响 1: 正在执行的任务被中断

`SessionPrompt` 的 `state`（包含 `runners` Map）通过 `InstanceState.make()` 创建（prompt.ts:105-116），其 scope finalizer 会取消所有 runner：

```typescript
yield* Effect.addFinalizer(function* () {
  yield* Effect.forEach(runners.values(), (r) => r.cancel, ...)
  runners.clear()
})
```

`Runner.cancel`（runner.ts:171-202）通过 `Fiber.interrupt` 中断正在运行的 fiber，包括 LLM stream 和工具调用。

### 影响 2: SSE 连接断开

`Instance.dispose()` 发出 `server.instance.disposed` 事件（instance.ts:23-33）。SSE 路由（event.ts:66-68）收到后主动断开连接：

```typescript
Bus.subscribeAll((event) => {
  q.push(JSON.stringify(event))          // 先推送事件
  if (event.type === Bus.InstanceDisposed.type) {
    stop()                                // 再断开连接
  }
})
```

前端 SSE 客户端（sse-client.ts）检测到流结束后自动重连（1s 指数退避，最多 5 次）。

### 影响 3: Provider 缓存重建

Provider 的 `state` 也是 `InstanceState.make()` 创建的（provider.ts:985），dispose 后缓存失效。下次 `getModel()` 调用时会重新读取 config 并初始化 provider 列表，此时使用新的模型配置。

## 模型绑定机制

模型在 **user message 创建时锁定**，整个消息循环使用同一模型：

```
prompt_async 请求携带 model 参数
  → createUserMessage() 解析模型优先级: 请求指定 > agent 默认 > session 历史
  → 模型写入 MessageV2.User.model 字段（不可变）
  → runLoop 每步从 lastUser.model 取模型（prompt.ts:1392）
  → 不从 config 重新读取
```

这意味着：同一 session 中，前一条消息用模型 A，下一条用模型 B，是完全支持的。

## 发现的 Bug

### Bug 1: session.error 事件未处理

后端 API 错误（鉴权失败、额度不足等）通过 `session.error` SSE 事件发出，但前端 `useSessionMessages` 的 SSE handler 没有处理这个事件类型，导致用户看不到任何错误提示，体验为"发了消息但没反应"。

**场景复现**：切换到一个 API key 无效或额度不足的模型（如 opencode 代理的免费模型），发送消息后静默失败。

### Bug 2: Instance.dispose 后 sending 状态卡住

`Instance.dispose()` 的连锁反应中：
1. Runner 被 cancel → 后端发出 `session.status: idle` 事件
2. SSE 连接被断开（`server.instance.disposed` 触发 `stop()`）
3. `session.status: idle` 事件在 SSE 断开**之后**到达 → 前端收不到
4. `sending` 状态保持 `true` → 输入框禁用 → permission 轮询持续运行

**关键时序**：虽然 `server.instance.disposed` 事件在 SSE 断开前被推入队列（event.ts:65 先 push 再 stop），但 `session.status: idle` 是由 runner cancel 的 `onIdle` 回调异步触发的，到达时 SSE 已断开。

## 决策

在 `useSessionMessages` 的 SSE handler 中新增两个 case：

### 1. 处理 `session.error`

```typescript
case "session.error": {
  const { sessionID: errSid, error } = event.properties
  if ((!errSid || errSid === sessionId) && error) {
    toast.error(error.data?.message || error.name || t("error.unknown"))
  }
  break
}
```

- 匹配当前 session 的错误：`errSid === sessionId`
- 全局错误（无 sessionID，如 config 解析失败）：`!errSid`，也展示

### 2. 处理 `server.instance.disposed`

```typescript
case "server.instance.disposed": {
  if (sendingRef.current && sessionId) {
    sendingRef.current = false
    setSending(false)
    setStreamingMessageId(null)
    markSessionIdle(sessionId)
  }
  break
}
```

- `sendingRef.current` 守卫确保只在 sending 状态下触发
- 同时重置 `streamingMessageId` → `isAgentActive` 变 false → permission 轮询自动停止
- `markSessionIdle` 幂等，非 sending 时调用无副作用

## 考虑过的替代方案

1. **在 `server.connected`（SSE 重连后）轮询 session 状态** — 可靠但需要额外 API 调用，且有延迟（重连需 1s+）。
2. **Config.update 不调用 Instance.dispose** — 需要修改 vendor/opencode 上游代码，不可控。
3. **前端 setModel 先 abort 再 patch** — 增加复杂度，且 abort API 不保证同步完成。
4. **给 sending 加安全超时** — 已有 8s 超时用于 Home→Session 导航场景，但通用超时值难以确定（长工具调用可能超过几十秒）。

## 后果

**正面**：
- 模型切换后用户能看到 API 错误提示（之前静默吞掉）
- 模型切换中断任务后，输入框正确恢复可用
- 不涉及后端/vendor 修改，改动局限于一个文件

**负面**：
- `server.instance.disposed` 是全局事件（不区分 session），所有打开的 session 页面都会重置 sending 状态。当前单 session 视图下无影响，多 session 并行时需注意。
- 模型切换仍然会中断正在执行的任务（这是后端 `Instance.dispose()` 的设计行为，非前端能改变）

## 涉及文件

| 文件 | 变更 |
|------|------|
| `packages/client/desktop/src/lib/use-session-messages.ts` | 新增 `session.error` 和 `server.instance.disposed` 两个 SSE event case |
