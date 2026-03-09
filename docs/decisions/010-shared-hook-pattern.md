# ADR-010: 共享 Hook 提取模式
**状态**: Accepted
**日期**: 2026-03-06
**关联轮次**: Round 10

## 背景

MCPPanel 和 ServicesSection 都需要管理 MCP 服务器状态（connect/disconnect/add/remove），代码大量重复。随着功能迭代，Skills 也出现类似的多组件共享逻辑需求。需要一个可复用的模式来消除重复并保持一致性。

## 决策

提取 useMCPServers 独立 hook，暴露数据（statusMap/configMap）+ 操作（toggle/add/remove/refresh）。UI 状态（showAdd 等）留在各组件本地。后续 useSkills 同理。

- Hook 职责：数据获取、状态管理、API 调用、错误处理
- 组件职责：UI 状态（表单显示/隐藏）、渲染、用户交互反馈
- handleAdd 通过 throw 传递错误，让调用方组件决定成功/失败时的 UI 行为
- useRef 同步乐观更新：setState 后必须手动同步 ref.current，确保连续调用不读到旧值
- onRefresh 使用 try/finally 模式：防止异常时 refreshing 按钮卡在旋转状态
- localStorage 持久化（如 `ultrawork_mcp_statuses`）补偿服务端 API 的已知限制

## 考虑过的替代方案

1. **提升到 Context** — 过重，MCP/Skills 状态并非全局需要，只有特定页面的少数组件使用。
2. **复制逻辑到各组件** — 难以维护，修复 bug 需要多处同步更新，容易出现不一致。
3. **HOC（Higher-Order Component）包装** — React 18+ 社区推荐 hooks 模式，HOC 嵌套导致组件层级深、props 透传复杂。

## 后果

**正面**：
- 逻辑复用，MCPPanel 和 ServicesSection 共享同一套状态管理
- 类型安全，hook 返回值有完整 TypeScript 类型
- handleAdd throw 模式让调用者灵活控制 UI 响应（如关闭表单、显示错误提示）
- 模式可复用：useSkills 采用相同架构快速实现

**负面**：
- useRef 同步乐观更新模式增加心智负担——setState(newValue) 后必须手动 `ref.current = newValue`，遗漏会导致连续操作读到旧值
- GET /mcp 只报告 config 文件中的 MCP 服务器，动态添加的不在其中，需要 localStorage 持久化状态补偿
- Hook 内部 try-catch 不会将错误传播到外层 onRefresh，组件侧需防御性 try/finally
