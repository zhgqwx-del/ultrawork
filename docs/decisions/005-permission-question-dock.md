# ADR-005: Permission & Question Dock
**状态**: Accepted
**日期**: 2026-03-02
**关联轮次**: Round 3

## 背景
OpenCode Agent 在执行工具时可能需要用户授权（permission）或回答问题（question）。需要设计交互方式。

## 决策
使用底部 Dock 替代弹窗。PermissionDock（琥珀色主题）显示权限请求，QuestionDock（蓝色主题）显示多问题/单选/多选交互。优先级 Question > Permission > ChatInput，条件渲染。

## 考虑过的替代方案
1. **Modal 弹窗** — 打断工作流，多个请求时无法排队。
2. **Toast 通知 + 侧边操作** — 不够醒目，容易错过。
3. **内嵌到消息流中** — 位置不固定，可能被滚动出视野。

## 后果
**正面**：不打断阅读流、优先级明确、可重试（API 失败后恢复 Dock 状态）。

**负面**：底部空间有限、需要轮询兜底防 SSE 丢事件。
