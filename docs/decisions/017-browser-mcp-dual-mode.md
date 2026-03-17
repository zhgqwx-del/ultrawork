# ADR-017: Browser MCP 双模式 — Playwright 默认 + DevTools 可选

**状态**: Accepted
**日期**: 2026-03-17
**前置**: ADR-016（将被本 ADR 演进替代）

## 背景

ADR-016 选择了 chrome-devtools-mcp 作为浏览器能力的唯一方案，依赖用户系统已有的 Node.js ≥v20。该方案面向开发者用户效果良好，但随着用户群扩展到非开发者：

1. **Node.js 系统依赖是硬门槛** — 非开发者通常没有 Node.js
2. **chrome-devtools-mcp 的 CDP 工具偏向调试** — 普通用户更需要页面浏览、截图、表单交互等高层操作
3. **Puppeteer 的选择器 API 对 AI agent 不够友好** — Playwright 的语义选择器（`text=`, `role=`）更适合 LLM 生成

## 决策

### 按需下载 Node.js runtime

首次启用浏览器功能时，从 nodejs.org 下载 Node.js LTS (v22.x) 到 `~/.ultrawork/node/`。DMG 零增量。

- **触发时机**：用户点击"启用浏览器"时，若 `~/.ultrawork/node/bin/node` 不存在则自动下载
- **下载体积**：~45MB tarball（下载后 strip 调试符号，node binary 从 105MB → 84MB）
- **安装位置**：`~/.ultrawork/node/`（node binary + npm lib）
- **后续使用**：下载一次，永久可用，切换模式/重装 MCP 不需重新下载
- **系统 Node.js 作为 fallback**：如果下载失败但系统有 Node.js ≥v18，回退使用

### 双模式 MCP 架构

同一时间只启用一个浏览器 MCP server，用户可在设置中切换：

| 模式 | MCP 包 | 定位 | 默认 |
|------|--------|------|------|
| **标准** | `@playwright/mcp` (Microsoft 官方) | 页面浏览、截图、表单交互、50+ 工具 | ✅ |
| **高级** | `chrome-devtools-mcp` | 网络分析、性能调试、Console 日志 | |

### Playwright MCP 选型依据

`@playwright/mcp`（Microsoft 官方）：
- 周下载 140 万+，GitHub 29k stars，Apache-2.0
- 50+ 工具，按能力模块化启用（`--caps=vision,devtools,network,storage,pdf,testing`）
- 原生支持系统 Chrome：`--browser chrome` 参数，无需下载 Chromium
- Node.js ≥18，与内嵌版本兼容

### 浏览器选择策略

优先使用用户系统已安装的 Chrome，避免 150MB Chromium 下载：

```
系统有 Chrome → --browser chrome（零额外下载）
系统无 Chrome → playwright install chromium（~150MB，首次下载）
```

检测顺序（macOS）：
1. `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
2. `/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary`
3. `/Applications/Chromium.app/Contents/MacOS/Chromium`
4. 均无 → 回退 Playwright 内置 Chromium 下载

### 启动命令

**标准模式（Playwright）：**
```bash
# 有系统 Chrome 时
~/.ultrawork/node/bin/node node_modules/@playwright/mcp/cli.js --browser chrome --headless

# 无系统 Chrome 时
~/.ultrawork/node/bin/node node_modules/@playwright/mcp/cli.js --headless
```

**高级模式（DevTools）：**
```bash
~/.ultrawork/node/bin/node node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js \
  --user-data-dir ~/.ultrawork/chrome-profile
```

### UI 设计

设置页提供统一的浏览器能力入口：

```
设置 → 浏览器能力
├── [✓] 启用浏览器
├── 模式：[标准（推荐）▾]  /  [高级（开发者）]
├── 状态：已就绪  ·  Node.js v22.x (内嵌)
└── Chrome：已检测 / 使用内置 Chromium
```

切换模式时自动断开当前 MCP → 注册新 MCP → 连接。sidebar MCP 面板同步显示当前模式。

### 安装目录结构

```
~/.ultrawork/
├── node/                       ← 内嵌 Node.js（从 app resources 复制）
│   └── bin/
│       ├── node
│       └── npm
├── mcp/
│   ├── playwright/             ← @playwright/mcp
│   │   ├── package.json
│   │   └── node_modules/
│   └── chrome-devtools/        ← chrome-devtools-mcp（高级模式）
│       ├── package.json
│       └── node_modules/
└── chrome-profile/             ← DevTools 模式的持久化 Chrome 数据
```

## 实现步骤

| 步骤 | 内容 | 改动范围 |
|------|------|---------|
| S1 | 按需下载 Node.js（`download_node` Tauri command） | `lib.rs` |
| S2 | `install_playwright_mcp` Tauri command | `lib.rs` |
| S3 | `use-browser-mcp.ts` 重构支持 mode 切换 | React hook |
| S4 | UI 改造：模式选择 + 状态显示 | Settings + MCP Panel |
| S5 | 系统 Chrome 检测 → 决定 Playwright 启动参数 | `lib.rs` 复用 `detect_chrome` |
| S6 | 清理：`detect_node` / `rich_path` 降级为 fallback | `lib.rs`（内嵌 Node 优先，系统 Node 仅备用） |

## 考虑过的替代方案

1. **只加 Playwright，去掉 DevTools** — 放弃了 CDP 深度调试能力，开发者用户会不满。双模式成本低，保留即可。
2. **两个 MCP 同时注册** — 工具名冲突（都有 screenshot/navigate），agent 会困惑。且无法共享浏览器实例。
3. **Playwright 远程/Docker 模式** — 桌面应用场景不适合。
4. **将 Node.js 打入 DMG** — DMG 增加 84MB（strip 后），浏览器功能非必需，不用的用户不应为此买单。最终选择按需下载。
5. **Bun 运行 Playwright** — Playwright 对 bun runtime 支持不完整，存在兼容风险。

## 后果

### 正面
- **DMG 零增量**：Node.js 按需下载，不用浏览器的用户不受影响
- **渐进式体验**：普通用户用标准模式即满足 90% 场景，开发者可切换高级模式
- **Playwright 生态**：50+ 工具，Microsoft 长期维护，语义选择器对 AI 友好
- **版本更新灵活**：Node.js 版本改配置即可，不需重新打包 DMG
- **系统 Chrome 优先**：有 Chrome 时跳过 ~150MB Chromium 下载

### 负面
- **首次启用需联网**：下载 Node.js ~45MB + npm install MCP 包，约 30-60 秒
- **首次无 Chrome 用户需额外下载 ~150MB Chromium**：提供进度提示和重试
- **维护两套 MCP 的安装/启动逻辑**：复杂度增加，但共享 Node.js runtime 和安装流程

### 对 ADR-016 的影响
ADR-016 不作废弃，其 chrome-devtools-mcp 方案成为本 ADR 的"高级模式"子集。Node.js 检测逻辑从"必须"降为"fallback"（下载失败时的备用路径）。
