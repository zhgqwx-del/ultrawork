# ADR-008: SSE 全局化 + 轮询兜底
**状态**: Accepted
**日期**: 2026-03-04
**关联轮次**: Round 5

## 背景

SSE 连接最初在 Session 组件内管理，导致切换页面时断开、丢失事件。Permission/Question 的 SSE 事件存在竞态风险——如果 SSE 事件在组件卸载和重挂载之间到达，事件会永久丢失，用户无法响应 Agent 的权限请求或问题。

## 决策

SSEProvider 在 app 级别维护单一 SSE 连接，跨页面不丢事件。useSSESubscribe 使用 ref 模式订阅。同时在 Agent 活跃时每 3s 轮询 permission/question API 作为兜底。

- SSEProvider 作为顶层 Context，在整个应用生命周期内维持一条 SSE 连接
- useSSESubscribe 依赖 `[subscribe]` 避免 heartbeat 导致的重订阅
- 30s 心跳超时自动触发 forceReconnect，最多重试 3 次
- forceReconnect 使用局部 controller 变量 + 身份校验，防止旧连接 finally 覆盖新连接
- Agent 活跃（sending || streamingMessageId !== null）时每 3s 轮询 GET /permission 和 GET /question

## 考虑过的替代方案

1. **每页面独立 SSE 连接** — 浪费连接资源，页面切换时丢失事件，Permission/Question 无法可靠送达。
2. **WebSocket 替代 SSE** — 需要修改 OpenCode server 协议，上游不受控，改动成本极高。
3. **纯轮询方案** — 延迟高（至少秒级），服务器负载大，流式文本体验差。

## 后果

**正面**：
- SSE 事件不因页面切换而丢失
- 连接复用减少服务器负担
- 30s 心跳超时 + 自动重连保证连接可靠性
- 轮询兜底确保 Permission/Question 事件不被遗漏

**负面**：
- 全局 SSE 增加了 forceReconnect 身份校验的复杂度
- 需要 controller 局部变量模式防止并发连接覆盖
- 轮询与 SSE 并存增加了重复事件的去重逻辑
- 收到事件需重置重连计数器，状态管理更复杂
