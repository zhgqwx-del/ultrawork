# Ultrawork 项目 Review

## 📋 原始需求

开发桌面 agent **ultrawork**：
- 架构参考 `architecture-phase1.md`
- UI 参考 WorkAny 项目
- 能力参考 OpenCode Desktop

---

## 🎯 Phase 1 MVP 回顾

### 目标与结果

| 验收标准 | 状态 | 说明 |
|---------|------|------|
| 用户启动 Desktop App | ✅ | `bun run tauri:dev` |
| App 自动启动 OpenCode Server | ✅ | Tauri sidecar 机制 |
| 用户在输入框输入消息 | ✅ | Enter 键或点击发送 |
| 消息发送到 OpenCode Server | ✅ | 通过 `@agent/api-client` |
| 收到 AI 响应 | ✅ | 解析 parts 数组中的 text |
| 响应显示在聊天界面 | ✅ | 自动滚动、loading 状态 |

### 技术选型回顾

| 决策 | 选择 | 评价 |
|------|------|------|
| UI 框架 | React 19 (替代 SolidJS) | ✅ 正确，更好的生态和参考资源 |
| 包管理器 | Bun | ✅ 正确，与 OpenCode 一致 |
| 构建工具 | Turborepo | ✅ 正确，monorepo 编排高效 |
| Desktop | Tauri 2 | ✅ 正确，sidecar 机制支持好 |
| 样式 | Tailwind CSS 4 | ✅ 正确，快速开发 |

---

## 🔍 实际遇到的问题

### 1. OpenCode API 文档不足
**问题**: OpenCode 缺乏完整的 API 文档，初始实现基于猜测，全部猜错
**影响**: api-client 需要完全重写认证和端点
**教训**: 应先调研再实现，不要凭猜测写代码

### 2. 请求体格式
**问题**: 发送消息的格式从 `{ prompt: "..." }` 到 `{ parts: [{ type: "text", text: "..." }] }`
**影响**: 消息发送成功但无响应，排查花费时间
**教训**: 用 curl 手动测试 API 是最快的验证方式

### 3. 密码传递方式
**问题**: OpenCode Server 不接受 `--password` CLI 参数
**影响**: 服务启动成功但无法认证
**教训**: 应查看 `--help` 输出确认支持的参数

### 4. 服务启动延迟
**问题**: OpenCode Server 需要 ~7 秒启动
**影响**: 前端立即连接会失败
**教训**: 需要重试/等待机制

### 5. AI Provider 配置
**问题**: OpenCode 需要配置 AI 模型才能回复
**影响**: 消息发送成功但无 AI 响应
**教训**: OpenCode 是 agent 框架，不自带模型

---

## 📊 工作量对比

| Milestone | 预估 | 实际 | 差异原因 |
|-----------|------|------|---------|
| M1: API 调研 | 2-4h | ~2h | 符合预期 |
| M2: 编译集成 | 4-8h | ~3h | 踩坑较多但单个问题不大 |
| M3: 基础 UI | 4-6h | ~1h | 只做最简 UI，未参考 WorkAny |
| M4: 端到端集成 | 4-8h | ~4h | 多个调试迭代 |
| 代码优化 | 未预估 | ~1h | 对齐类型、重构代码 |
| **总计** | **14-26h** | **~11h** | 简化了 UI 范围 |

---

## ⚠️ 已知不足

### 与需求的差距

1. **UI 与 WorkAny 差距大**: 当前只有最基本的聊天气泡，缺少侧边栏、session 管理、设置面板
2. **非流式响应**: 当前等待完整响应后一次性显示，未实现 SSE 流式逐字显示
3. **无 Markdown 渲染**: AI 响应中的代码块、链接等无法格式化
4. **配置硬编码**: 密码、端口、API 地址都是硬编码
5. **架构文档中的包未全部实现**: connector、workspace、ui、notifier 均未创建

### 与架构设计的差距

| 架构设计要求 | 当前状态 |
|------------|---------|
| @agent/connector | ❌ 未实现，Desktop 直接用 api-client |
| @agent/workspace | ❌ 未实现 |
| @agent/ui | ❌ 未实现，组件写在 App.tsx 内 |
| @agent/notifier | ❌ 未实现 |
| Channel Gateway | ❌ Phase 2+ |
| Proactive Services | ❌ Phase 3+ |
| Detach-on-exit | ❌ 未实现，sidecar 随 App 退出 |

---

## ✅ MVP 总结

**Phase 1 MVP 核心目标已完成**: 桌面应用能启动 OpenCode Server，发送消息并收到 AI 回复。

代码质量经过优化：
- api-client 类型与真实 API 对齐
- App.tsx 使用 api-client 包而非直接 fetch
- server-manager 密码传递方式已修正
- TypeScript 类型检查全部通过

---

## 🎯 Phase 2 规划建议

### 优先级排序

1. **SSE 流式响应** - 最影响用户体验
2. **Markdown 渲染** - AI 响应可读性
3. **多 Session + 侧边栏** - 参考 WorkAny 布局
4. **@agent/connector** - 为远程模式做准备
5. **@agent/workspace** - 持久化 agent 状态
6. **配置管理** - 从硬编码改为配置文件

---

**文档创建时间**: 2026-03-05
**最后更新**: 2026-03-05
**状态**: Phase 1 MVP ✅ 完成，准备进入 Phase 2
