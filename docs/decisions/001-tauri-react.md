# ADR-001: Tauri 2 + React 19 技术选型
**状态**: Accepted
**日期**: 2026-02-25
**关联轮次**: Phase 1

## 背景
需要构建跨平台桌面 AI Agent 客户端。初期设计考虑 SolidJS 作为 UI 框架。

## 决策
选择 Tauri 2 (Rust) 作为桌面框架，React 19 作为 UI 框架。

## 考虑过的替代方案
1. **Electron** — 更成熟但内存占用大、打包体积大。
2. **SolidJS** — 原始设计方案，性能更好但生态小、团队不熟悉。
3. **Flutter Desktop** — 跨平台但 AI/Web 生态集成弱。

## 后果
**正面**：Tauri 打包体积小（~10MB vs Electron ~150MB）、原生性能、Rust 安全性；React 生态丰富、shadcn/ui 等组件库可用。

**负面**：Tauri 2 相对 Electron 社区资源少；React 19 新特性（Server Components）在桌面场景无直接用处。
