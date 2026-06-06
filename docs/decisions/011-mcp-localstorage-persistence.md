# ADR-011: MCP 状态 localStorage 持久化
**状态**: Superseded（→ opencode.json 全局持久化，Issue#18）
**日期**: 2026-03-07
**关联轮次**: Round 11
**被取代**: 本方案（localStorage 持久化）已由 [ADR-020](./020-config-isolation.md)（配置隔离 + MCP 配置统一写全局 `opencode.json`）与 [ADR-026](./026-knowledge-base-architecture.md)（MCP 注册路径收敛）取代。当前 MCP 状态不再依赖 localStorage。

## 背景

GET /mcp 只报告 config 文件中的 MCP 服务器（Config.get().mcp），通过 POST /mcp 动态添加的服务器不在列表中。页面刷新后动态添加的服务器状态丢失。

## 决策

客户端使用 localStorage key `ultrawork_mcp_statuses` 持久化 MCP 服务器状态（statusMap + configMap），补偿服务端 API 的限制。

## 考虑过的替代方案

1. **修改 OpenCode 上游代码让 GET /mcp 返回所有服务器** — 需要 vendor patch，改动大。
2. **不持久化，每次手动重新添加** — 用户体验差。
3. **写入 opencode.json config** — PATCH /config 只写磁盘不影响运行时，且结构不同。

## 后果

- **正面**: 刷新后状态恢复、与 useMCPServers hook 集成自然。
- **负面**: localStorage 是浏览器级存储，不跨设备同步；需要 onRefresh 时与服务端状态对账。
