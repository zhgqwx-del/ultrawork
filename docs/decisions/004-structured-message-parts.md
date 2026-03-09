# ADR-004: 结构化消息 7 Part Types
**状态**: Accepted
**日期**: 2026-03-01
**关联轮次**: Round 2

## 背景
OpenCode 返回的 assistant 消息包含多种 part 类型（思考过程、工具调用、代码补丁等），需要分别渲染。

## 决策
定义 7 种 Part type 分离渲染：Text, Reasoning, ToolCall, StepFinish, Patch, File, Image。每个 Part 有独立组件，通过 PartBase（id, sessionID, messageID）统一管理。

## 考虑过的替代方案
1. **统一为纯文本 Markdown** — 丢失结构信息，无法渲染工具调用状态。
2. **按 OpenCode TUI 方式渲染** — 与桌面 UI 交互模式不匹配。

## 后果
**正面**：每种 part 有专属 UI（推理折叠、工具调用状态卡片、代码 diff 高亮）、SSE delta 可精确更新。

**负面**：增加渲染复杂度、需要处理 ToolState 嵌套 discriminated union。
