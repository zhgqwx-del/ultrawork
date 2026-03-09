# Ultrawork

AI Agent 桌面客户端，基于 Tauri 2 + React 19 构建，后端集成 [OpenCode](https://github.com/anomalyco/opencode) 作为 AI Agent 引擎。

## 架构概览

```
ultrawork/
├── packages/
│   ├── core/
│   │   ├── api-client/            # OpenCode REST/SSE TypeScript 客户端
│   │   └── server-manager/        # Sidecar 进程管理
│   ├── client/
│   │   └── desktop/               # Tauri 桌面应用 (React + Vite)
│   │       ├── src/               # 前端源码
│   │       └── src-tauri/         # Rust 后端 + sidecar 二进制
│   └── channel/
│       └── gateway/               # 渠道网关 (钉钉等即时通讯集成)
├── vendor/
│   └── opencode/                  # OpenCode 上游 (git submodule)
├── patches/                       # Vendor 补丁文件
├── scripts/                       # 构建脚本
└── setup.sh                       # 一键构建脚本
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Tauri 2 (Rust) |
| 前端 | React 19 + TypeScript 5.8 + Vite 7 |
| 样式 | Tailwind CSS 4 + Radix UI |
| 状态 | React Context + SSE |
| 构建 | Turborepo + Bun |
| AI 后端 | OpenCode Server (Bun 编译二进制，作为 sidecar 运行) |
| 渠道网关 | Hono + DingTalk Stream SDK (Bun 编译二进制) |

## 前置依赖

| 工具 | 最低版本 | 安装方式 |
|------|----------|----------|
| **Bun** | >= 1.3.10 | `curl -fsSL https://bun.sh/install \| bash` |
| **Rust** | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Xcode CLT** | - | macOS: `xcode-select --install` |

> 不需要单独安装 Node.js，全程使用 Bun 作为 JS/TS 运行时。

## 快速开始

### 一键启动（推荐）

```bash
git clone --recurse-submodules https://github.com/zhgqwx-del/ultrawork.git
cd ultrawork
./setup.sh
```

`setup.sh` 会自动完成：初始化 submodule → 应用 vendor 补丁 → 安装依赖 → 编译 sidecar → 启动开发服务器。

### 手动步骤

```bash
# 1. Clone（必须包含 submodule）
git clone --recurse-submodules https://github.com/zhgqwx-del/ultrawork.git
cd ultrawork

# 2. 应用 vendor 补丁
cd vendor/opencode
git apply ../../patches/vendor-opencode-config-fix.patch
cd ../..

# 3. 安装依赖
bun install

# 4. 编译 OpenCode sidecar（约 114MB，首次耗时较长）
bun run build:opencode

# 5. 编译 Channel Gateway sidecar（约 61MB）
bun run build:gateway

# 6. 启动开发服务器
bun run tauri:dev
```

### 构建发布包

```bash
./setup.sh --build
# 或手动：
bun run tauri:build
```

产物位于 `packages/client/desktop/src-tauri/target/release/bundle/`。

## 开发指南

### 常用命令

```bash
bun run tauri:dev          # 启动开发服务器（前端 HMR + Rust 热重载）
bun run typecheck          # 全量 TypeScript 类型检查 (4 个包)
bun run build:opencode     # 重新编译 OpenCode sidecar
bun run build:gateway      # 重新编译 Channel Gateway sidecar
```

### 测试

```bash
# Gateway 单元测试 (113 cases)
cd packages/channel/gateway && bun run --bun vitest run

# Desktop 单元测试 (123 cases)
cd packages/client/desktop && bun run --bun vitest run
```

### 开发端口

| 服务 | 端口 | 说明 |
|------|------|------|
| Vite Dev Server | 1420 | 前端开发服务器 |
| OpenCode Server | 4096 | AI Agent 后端 (sidecar) |
| Channel Gateway | 4097 | 渠道网关 (sidecar) |

Vite 开发模式下自动将 API 请求代理到后端端口。

### Vendor 补丁

`vendor/opencode` 是上游 OpenCode 的 git submodule。本项目的修改以 patch 文件形式保存在 `patches/` 目录：

- `vendor-opencode-config-fix.patch` — 修复 `Config.update()` 写入文件名为 `opencode.json`（上游错误地写入 `config.json`）

更新 submodule 后需重新 apply：
```bash
cd vendor/opencode && git apply ../../patches/vendor-opencode-config-fix.patch
```

## 核心功能

- AI Agent 对话 — 结构化消息渲染（思考过程、工具调用、代码 diff）
- SSE 流式响应 — 全局 SSE 连接，跨页面不丢事件
- 工作区管理 — 多目录隔离，按工作区过滤 Session
- 模型管理 — Provider 配置、模型快速切换
- MCP 集成 — 远程/本地 MCP 服务器管理
- 权限/问答 — Agent 权限授权 Dock、交互式问答 Dock
- 文件预览 — 50/50 分屏预览（代码/Markdown/图片/Diff）
- 渠道网关 — 钉钉等即时通讯接入，通过 Gateway sidecar 桥接
- 国际化 — 中文/英文

## 项目文档

- [PROGRESS.md](./PROGRESS.md) — 详细开发进度记录
- [docs/architecture-phase1.md](./docs/architecture-phase1.md) — 架构设计
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) — 测试指南

## 致谢

- [OpenCode](https://github.com/anomalyco/opencode) — AI Agent 引擎
- [WorkAny](https://github.com/workany-ai/workany) — UI/UX 设计参考
