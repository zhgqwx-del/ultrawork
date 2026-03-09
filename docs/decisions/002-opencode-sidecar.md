# ADR-002: OpenCode Headless Sidecar
**状态**: Accepted
**日期**: 2026-02-25
**关联轮次**: Phase 1

## 背景
需要一个 AI Agent 引擎处理 LLM 调用、工具执行、会话管理。OpenCode 是一个成熟的开源 Agent Server。

## 决策
将 OpenCode 编译为二进制（Bun compile），作为 Tauri externalBin sidecar 运行。不 fork 不嵌入，通过 REST/SSE API 通信。

## 考虑过的替代方案
1. **Fork OpenCode 嵌入到 Tauri Rust 后端** — 维护成本高，难以跟进上游。
2. **直接调用 LLM API** — 需自建 Agent 逻辑、工具系统、会话管理。
3. **使用 OpenCode CLI 进程** — 无 headless API，只有 TUI。

## 后果
**正面**：复用成熟的 Agent 能力、可独立升级、API 边界清晰。

**负面**：sidecar 二进制 ~114MB、需要 vendor patch 机制处理上游 bug、进程间通信增加延迟。
