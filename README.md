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

| 命令 | 用途 |
|------|------|
| `./setup.sh --build` | 一键构建（带 sidecar 重编译） |
| `bun run release` | 完整发布流程：双架构 sidecar + Universal DMG + 签名 + Notarization |
| `bun run release -- --unsigned` | 内部测试：ad-hoc 签名，跳过 Notarization |
| `bun run release -- --skip-notarize` | 仅签名不公证（需 `APPLE_SIGNING_IDENTITY`） |

**Universal DMG**（默认）会生成同时支持 Apple Silicon 与 Intel Mac 的单一安装包，构建时间和包体积都是单架构的 ~2 倍。

签名 / 公证所需环境变量：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"     # 见 https://appleid.apple.com
export APPLE_TEAM_ID="TEAMID"
```

未签名 DMG 分发给他人时，对方需要先解除隔离才能打开：

```bash
xattr -dr com.apple.quarantine /Applications/Ultrawork.app
```

产物位于 `packages/client/desktop/src-tauri/target/{aarch64-apple-darwin,universal-apple-darwin}/release/bundle/`。

## 开发指南

### 常用命令

```bash
bun run tauri:dev          # 启动开发服务器（前端 HMR + Rust 热重载）
bun run typecheck          # 全量 TypeScript 类型检查
bun run build:opencode     # 重新编译 OpenCode sidecar
bun run build:gateway      # 重新编译 Channel Gateway sidecar
bun run build:knowledge    # 重新编译 Knowledge sidecar
```

构建脚本支持 `--target` 参数跨编译，例如 `bun run build:gateway -- --target x86_64-apple-darwin`。

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
| Knowledge Sidecar | 4098 | 知识库 RAG (sidecar) |

所有 sidecar 都仅绑定 `127.0.0.1`。Vite 开发模式自动将 API 请求代理到后端端口。

### Sidecar 凭证

应用首次启动时会在 `~/.config/ultrawork/sidecar-auth.json`（Unix 权限 `0600`）生成 32 字节随机密码，OpenCode sidecar 与前端共用。删除该文件可强制重置。

CI / 脚本化测试可用 `ULTRAWORK_SIDECAR_PASSWORD=xxx` 环境变量覆盖（不会持久化）。

### Vendor 补丁

`vendor/opencode` 是上游 OpenCode 的 git submodule。本项目的修改以 patch 文件形式保存在 `patches/` 目录：

- `vendor-opencode-config-fix.patch` — 修复 `Config.update()` 写入文件名为 `opencode.json`（上游错误地写入 `config.json`）

更新 submodule 后需重新 apply：
```bash
cd vendor/opencode && git apply ../../patches/vendor-opencode-config-fix.patch
```

### 故障排查 / 完全重置

如果需要把工作树和运行时数据回退到"初次 clone"的状态（用于重现安装问题、清理坏状态），执行：

```bash
git submodule deinit -f vendor/opencode                      # submodule 回到未初始化
rm -rf node_modules .turbo                                   # JS 依赖与 turbo 缓存
rm -rf packages/client/desktop/src-tauri/binaries/*          # 已编译的 sidecar 二进制
rm -rf ~/.ultrawork ~/.config/ultrawork                      # 运行时数据 + 凭证 + MCP 配置
bun pm cache rm                                              # 可选：碰到 integrity 错误时清 bun cache

./setup.sh --dev                                             # 重新初始化（约 5–10 分钟）
```

> ⚠️ 删除 `~/.ultrawork` 会清掉本地知识库索引、Channel 配置、Browser MCP 下载的 Node.js 和 Playwright 等。仅在确认重置时操作。

如果只是想清依赖重装（保留运行时数据）：

```bash
rm -rf node_modules .turbo packages/client/desktop/src-tauri/binaries/*
./setup.sh --dev
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

- [快速上手](./docs/getting-started.md) — 环境搭建与开发流程
- [架构设计](./docs/architecture-phase1.md) — Phase 1 系统架构
- [构建部署](./docs/build-and-deploy.md) — 打包、签名、跨平台
- [API 参考](./docs/api-reference.md) — OpenCode Server API
- [开发规范](./docs/conventions.md) — 代码约定与模式
- [测试策略](./docs/testing.md) — 测试框架与用例
- [需求文档](./docs/requirements.md) — 产品需求与功能清单
- [架构决策](./docs/decisions/) — ADR 记录
- [变更日志](./CHANGELOG.md) — 版本历史
- [设计资料](./design/) — 产品原型与参考

## 致谢

- [OpenCode](https://github.com/anomalyco/opencode) — AI Agent 引擎
- [WorkAny](https://github.com/workany-ai/workany) — UI/UX 设计参考
