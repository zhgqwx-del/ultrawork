# ADR-013: Channel Gateway 独立 Sidecar
**状态**: Accepted
**日期**: 2026-03-08
**关联轮次**: Round 13

## 背景

需要支持钉钉等 IM 渠道接入 AI Agent，但不想将 IM 逻辑耦合到桌面客户端或 OpenCode Server 中。

## 决策

Channel Gateway 作为独立 sidecar 进程运行在 :4097 端口（Bun compile 二进制），由 Tauri 通过 `std::thread::spawn` 在后台线程启动和托管。Hono REST API 提供 6 个端点管理 channel CRUD + connect/disconnect。

## 考虑过的替代方案

1. **嵌入桌面进程** — 耦合度高，IM SDK 问题影响桌面稳定性。
2. **嵌入 OpenCode Server** — 需要大量 vendor patch。
3. **云端 Gateway 服务** — 需要公网部署，增加运维复杂度。

## 后果

- **正面**: 进程隔离（Gateway 崩溃不影响桌面）、可独立编译部署、Hono 轻量。
- **负面**: 新增 sidecar 二进制 ~61MB、Tauri 需管理两个 sidecar 生命周期、配置持久化需自建（~/.ultrawork/channels.json + mutex）。
