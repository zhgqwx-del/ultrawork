# Ultrawork - AI Agent Desktop App

## 🎉 MVP 完成！

Desktop App 可以连接 OpenCode Server 并发送消息。

## ✅ 已完成的功能

### 核心包
- ✅ **@agent/api-client** - OpenCode REST/SSE 客户端
  - Session 创建和管理
  - 消息发送 (Basic Auth)
  - SSE 事件订阅
- ✅ **@agent/server-manager** - OpenCode 进程管理
  - 启动/停止 OpenCode 服务器
  - 健康检查和就绪等待
- ✅ **@agent/client-desktop** - Tauri 桌面应用
  - 聊天 UI (消息列表 + 输入框)
  - Session 自动创建
  - 消息发送到 OpenCode API
  - 连接状态显示

### 构建工具
- ✅ **scripts/build-opencode.ts** - 编译 OpenCode 到二进制
- ✅ Tauri sidecar 配置 (自动启动 OpenCode)

## 📁 目录结构

```
ultrawork/
├── package.json
├── turbo.json
├── tsconfig.json
├── AGENTS.md
├── .ai/
│   └── session.md
├── docs/
│   ├── architecture-phase1.md
│   └── ai-context/
├── scripts/
│   ├── build-opencode.ts
│   └── dev.ts
├── vendor/
│   └── (待添加 opencode submodule)
└── packages/
    ├── core/
    │   ├── api-client/
    │   └── server-manager/
    └── client/
        └── desktop/
            ├── src/
            ├── src-tauri/
            ├── index.html
            ├── vite.config.ts
            └── tailwind.config.ts
```

## 🎯 下一步工作

### 1. 实现消息接收
- 订阅 SSE 事件流 (`/event`)
- 显示 AI 响应消息
- 处理流式响应

### 2. 增强功能
- 错误处理和重试
- 消息历史持久化
- 多 Session 管理

### 3. 后续扩展
- @agent/connector (统一连接抽象)
- @agent/workspace (用户级工作空间)
- @agent/ui (共享 UI 组件)

## 📝 技术栈

- **Runtime**: Bun 1.3.10
- **Build**: Turborepo 2.8.13
- **UI**: React 19 + Tailwind CSS 4
- **Desktop**: Tauri 2
- **Language**: TypeScript 5.8+
- **Backend**: OpenCode (git submodule)

## 📚 文档

- [PROGRESS.md](./PROGRESS.md) - 详细开发进度
- [OPENCODE-API-FINDINGS.md](./OPENCODE-API-FINDINGS.md) - OpenCode API 调研
- [docs/architecture-phase1.md](./docs/architecture-phase1.md) - 架构设计

---

**最后更新**: 2026-03-05
**当前状态**: ✅ MVP 完成 - 可以发送消息到 OpenCode

## 🚀 测试 MVP

### 前置要求
- Bun 已安装
- Rust 工具链已安装 (用于 Tauri)
- 依赖已安装: `bun install`

### 步骤 1: 编译 OpenCode 二进制
```bash
bun run scripts/build-opencode.ts
```

这会编译 OpenCode 并复制到 `packages/client/desktop/src-tauri/binaries/opencode-server`

### 步骤 2: 启动 Desktop App
```bash
cd packages/client/desktop
bun run tauri dev
```

Desktop App 会自动启动 OpenCode Server 作为 sidecar 进程。

### 步骤 3: 测试聊天功能
1. 等待连接状态显示 "Connected"
2. 在输入框输入消息
3. 点击 Send 或按 Enter 发送
4. 消息会发送到 OpenCode API

### 验证
- ✅ 顶部显示 "Connected" 状态
- ✅ 用户消息显示在右侧（蓝色）
- ✅ 控制台无错误信息

## 📝 开发命令

### 类型检查
```bash
bun run typecheck
```

### 编译 OpenCode
```bash
bun run scripts/build-opencode.ts
```

### 启动 Desktop App
```bash
cd packages/client/desktop
bun run tauri dev
```

### 构建 Desktop App
```bash
cd packages/client/desktop
bun run tauri build
```

