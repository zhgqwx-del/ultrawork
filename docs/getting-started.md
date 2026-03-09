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

---

## AI 协作工作流 (Claude Code)

本项目使用 Claude Code 作为 AI 编程助手。以下说明如何充分利用项目中积累的文档和上下文。

### 自动加载的上下文

每次启动 Claude Code session 时，以下三个文件**自动注入**，不需要手动操作：

| 文件 | 内容 | 作用 |
|------|------|------|
| `CLAUDE.md` | 工作流程指令 | 告诉 Claude 按任务类型加载文档、轮次收尾步骤 |
| `AGENTS.md` | 项目概览 | 包结构、技术栈、API 摘要、关键文件路径 |
| `.claude/memory/MEMORY.md` | 工作记忆 | 环境变量、API 类型细节、已知坑点、当前状态 |

### 开始一个开发任务

**直接描述你要做的事即可**，Claude 会根据任务类型自动加载需要的深层文档：

```
你：帮我在 Session 页面加一个导出按钮

Claude 自动执行：
  1. 已有 CLAUDE.md + AGENTS.md + MEMORY.md ✓
  2. 判断：新 UI 组件 → 读取 docs/conventions.md
  3. 判断：涉及 Session API → 读取 docs/api-reference.md
  4. 开始开发...
```

不同任务会触发不同文档加载：

| 任务类型 | Claude 会额外读取 |
|----------|-------------------|
| 新建/修改 UI 组件 | `docs/conventions.md`（状态管理、组件模式） |
| SSE / 消息流相关 | `docs/conventions.md` §3 SSE + §5 组件模式 |
| 调用 OpenCode API | `docs/api-reference.md` |
| 架构层变更 | `docs/architecture.md` + 相关 ADR |
| 修复 Bug | 按涉及模块选读 |
| 跨模块功能 | `docs/conventions.md` + `docs/architecture.md` |

**如果 Claude 没有主动加载上下文**，可以提示一句：
```
你：先读一下 docs/conventions.md 再开始
```

### 轮次结束时更新文档

一轮开发完成后，用以下任意说法触发文档更新：

```
你：这轮结束
你：收尾
你：wrap up
```

Claude 会自动执行 5 步收尾流程（定义在 `CLAUDE.md` 中）：

| 步骤 | 动作 | 涉及文件 |
|------|------|---------|
| 1 | 将开发中发现的新模式从暂存区整理到团队规范 | `MEMORY.md` → `docs/conventions.md` |
| 2 | 追加本轮变更摘要 | `CHANGELOG.md` |
| 3 | 更新当前状态 | `MEMORY.md` |
| 4 | 如有架构决策，新建 ADR | `docs/decisions/NNN-*.md` |
| 5 | 输出收尾摘要 | 告诉你更新了什么 |

**开发过程中不需要手动维护文档**——Claude 发现新模式时会自动暂存到 `MEMORY.md` 的 staging 区，收尾时一次性格式化写入 `docs/conventions.md`。

### 数据流

```
开发过程中                              轮次结束时
┌──────────┐                          ┌─────────────────┐
│ 发现新模式 │ ── 一行摘要 ──→         │ MEMORY.md       │
│ (坑点/模式)│                         │ New Patterns 区  │
└──────────┘                          └────────┬────────┘
                                               │ "收尾"
                                               ▼
                                      ┌─────────────────┐
                                      │ conventions.md  │
                                      │ + CHANGELOG.md  │
                                      │ + ADR (如有)     │
                                      └─────────────────┘
```
