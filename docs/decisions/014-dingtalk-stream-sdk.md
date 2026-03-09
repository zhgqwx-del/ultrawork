# ADR-014: DingTalk Stream SDK 选型
**状态**: Accepted
**日期**: 2026-03-08
**关联轮次**: Round 13

## 背景

钉钉机器人需要接收群消息并回复。传统 webhook 方式需要公网 IP 和 HTTPS 证书。

## 决策

使用 dingtalk-stream v2.1.4 SDK 的 WebSocket Stream Mode，无需公网 IP。Bridge 模块实现 chatId→sessionId 映射 + Sequential Queue + SSE 订阅实时转发回复。

## 考虑过的替代方案

1. **钉钉 webhook 回调** — 需要公网 IP、HTTPS 证书、内网穿透。
2. **轮询钉钉消息 API** — 延迟高、API 限流。
3. **自建 WebSocket Server** — 需要实现钉钉协议，工作量大。

## 后果

- **正面**: 零公网依赖、SDK 处理连接管理和心跳、桌面端即可运行。
- **负面**: dingtalk-stream SDK 的 DWClient 和 TokenManager 需要特殊 mock 方式（class 而非 vi.fn）、webhook 过期需 fallback 到 REST API。
