# 快速上手

## 前置依赖

| 工具 | 最低版本 | 安装方式 |
|------|----------|----------|
| **Bun** | >= 1.3.10 | `curl -fsSL https://bun.sh/install \| bash` |
| **Rust** | stable | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| **Xcode CLT** | - | macOS: `xcode-select --install` |

> 不需要单独安装 Node.js，全程使用 Bun 作为 JS/TS 运行时。
> 系统 Node.js v14 不支持现代语法（`??=` 等），所有命令必须通过 `bun run --bun` 执行。

## Clone & Setup

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

## 开发服务器

```bash
bun run tauri:dev    # 启动 Tauri 桌面应用（前端 HMR + Rust 热重载）
```

访问前端: http://localhost:1420

## OpenCode Server 配置

### 模型与 API Key

LLM 模型配置位于 `~/.config/opencode/opencode.json`：

```json
{
  "provider": {
    "opencode": {
      "options": {
        "apiKey": "sk-xxx..."
      }
    }
  },
  "model": "opencode/big-pickle"
}
```

| 场景 | 可用模型 | 说明 |
|------|---------|------|
| 无 API key | 3 个免费模型 (big-pickle, gpt-5-nano, minimax-m2.5-free) | 自动使用 `apiKey: "public"` |
| 有 API key | 35+ 个模型 (Claude/GPT/Gemini/GLM/Kimi 全系列) | 付费模型需账户有余额 |

### 手动启动 Server（调试用）

```bash
# 无密码模式
./packages/client/desktop/src-tauri/binaries/opencode-server-aarch64-apple-darwin serve --port 4096

# 带 API key
export OPENCODE_API_KEY="sk-xxx..."
./packages/client/desktop/src-tauri/binaries/opencode-server-aarch64-apple-darwin serve --port 4096
```

## 常用命令速查

```bash
bun run tauri:dev          # 启动开发服务器（前端 HMR + Rust 热重载）
bun run typecheck          # 全量 TypeScript 类型检查 (4 个包)
bun run build:opencode     # 重新编译 OpenCode sidecar
bun run build:gateway      # 重新编译 Channel Gateway sidecar

# Gateway 单元测试 (113 cases)
cd packages/channel/gateway && bun run --bun vitest run

# Desktop 单元测试 (123 cases)
cd packages/client/desktop && bun run --bun vitest run
```

## 端口说明

| 服务 | 端口 | 说明 |
|------|------|------|
| Vite Dev Server | 1420 | 前端开发服务器 |
| OpenCode Server | 4096 | AI Agent 后端 (sidecar) |
| Channel Gateway | 4097 | 渠道网关 (sidecar) |

Vite 开发模式下自动将 API 请求代理到后端端口（配置见 `vite.config.ts`）。

代理路由：`/event`, `/session`, `/health`, `/global`, `/permission`, `/question`, `/config`, `/provider`, `/auth`, `/agent`, `/mcp`, `/skill`, `/command`, `/file`, `/project`, `/experimental`

## 常见问题 FAQ

### Q: `bun run --bun vite dev` 报语法错误？
系统 Node.js v14 不支持现代语法。确保所有命令通过 `bun run --bun` 执行，不要直接用 `npx` 或 `node`。

### Q: MCP 服务器连接失败 `Connection closed`？
Sidecar 运行在 Bun 编译二进制中，`npx` spawn 多层进程导致 stdio pipe 断裂。必须用 `bunx --bun` 替代 `npx`。

### Q: Health check 失败？
健康检查端点是 `/global/health`，不是 `/health` 或 `/api/health`。

### Q: Gateway 修改后不生效？
修改 `packages/channel/gateway/src/` 后需重新编译：
```bash
bun run build:gateway
```
编译后的二进制会复制到 sidecar binaries 目录。

### Q: Vendor 补丁冲突？
更新 submodule 后重新 apply：
```bash
cd vendor/opencode && git apply ../../patches/vendor-opencode-config-fix.patch
```
