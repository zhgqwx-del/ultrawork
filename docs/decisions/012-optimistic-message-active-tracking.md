# ADR-012: 乐观消息 + 活跃状态追踪
**状态**: Accepted
**日期**: 2026-03-07
**关联轮次**: Round 12

## 背景

新建会话时用户发送消息后有明显延迟（创建 session + prompt_async + SSE 回传），体验不好。Sidebar 的会话活跃状态用 30s time.updated 时间启发式判断不准确。

## 决策

1. **乐观消息**: 用 `temp-` ID 前缀立即渲染用户消息，通过 navigate state 传递 messageText。SSE 回传真实消息后 dedup 移除 temp。
2. **活跃追踪**: 用 `activeSessionIds` Set 替代时间启发式，在 send/idle/stop/timeout/error 5 个路径精确管理。

## 考虑过的替代方案

1. **Loading skeleton** — 仍有空白期。
2. **服务端返回 session.created 事件** — OpenCode 无此事件。
3. **前端自行 setTimeout 判断活跃** — 不准确。

## 后果

- **正面**: 消息立即可见、Sidebar 活跃状态精确、getMessages merge 守卫防空响应清除 temp。
- **负面**: 需要 frozenMessageIds 机制处理 stop 场景、temp→stopped 提升逻辑增加复杂度。
