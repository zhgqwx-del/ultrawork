# ADR-007: 工作区目录隔离
**状态**: Accepted
**日期**: 2026-03-04
**关联轮次**: Round 5

## 背景

用户可能同时在多个项目目录工作，需要按目录隔离 Session 和文件操作。OpenCode server 以 sidecar 进程运行，原始设计中 cwd 决定工作目录，但单进程只能有一个 cwd。

## 决策

通过 API header `x-opencode-directory` 传递工作目录，不改 sidecar 的 cwd。OpenCode server 的 Instance.provide() 按 directory lazy 初始化+缓存。Session 按目录过滤显示。

- 所有 API 请求通过 api-client 自动附加 `x-opencode-directory` header
- Instance.provide() 根据 directory 参数 lazy 创建并缓存实例，切换目录无需重启
- Session 列表通过 `directory` query param 过滤，客户端额外做精确匹配
- WorkspaceSelector UI 组件提供目录选择和切换入口

## 考虑过的替代方案

1. **每个工作区启动独立 sidecar 进程** — 资源浪费，多进程管理复杂，端口分配困难。
2. **修改 sidecar cwd** — 影响全局，无法多目录并存，切换需要重启进程。
3. **客户端自行管理文件路径前缀** — 不彻底，sidecar 工具执行路径仍混乱，容易出现路径拼接错误。

## 后果

**正面**：
- 单进程支持多目录，资源高效
- 切换工作区无需重启 sidecar
- WorkspaceSelector UI 提供便捷的目录切换体验
- File API 通过 header 自动定位到正确目录

**负面**：
- 上游 Session.list() 只做精确匹配不支持前缀，客户端需自行过滤补偿
- File API 路径必须为相对路径，传绝对路径会 join 出错误结果
- 所有 API 调用都需要确保 header 正确传递，遗漏会导致操作在错误目录执行
