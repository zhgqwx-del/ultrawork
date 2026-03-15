# ADR-016: Browser MCP — 检测系统 Node.js + 按需安装 chrome-devtools-mcp
**状态**: Accepted
**日期**: 2026-03-15

## 背景

Ultrawork 需要浏览器能力（截图、页面交互、DOM 检查），让 AI Agent 能操作网页。chrome-devtools-mcp 是成熟的开源 MCP server，基于 Puppeteer 实现完整的 Chrome DevTools Protocol 支持。

## 决策

检测用户系统中的 Node.js (>=v20)，首次使用时自动安装 chrome-devtools-mcp 到 `~/.ultrawork/mcp/`，通过 `node script.js` 直接启动 MCP server。DMG 零增量。

关键设计点：
1. **Tauri 侧检测**：`rich_path()` 扫描 nvm/fnm/volta/homebrew 等路径，解决 Finder 启动 PATH 受限问题
2. **Rust 侧安装**：`install_browser_mcp` command 在 Rust 中执行 npm install，避免前端 shell scope 配置复杂性
3. **直接 `node script.js` 启动**：不经过 npx/bunx，避免已知的 stdio 管道断裂问题
4. **`~/.ultrawork/chrome-profile`** 持久化 Chrome 用户数据目录

## 考虑过的替代方案

1. **bun build --compile 内嵌 chrome-devtools-mcp** — Puppeteer 原生依赖与 bun compile 不兼容，无法打包。
2. **内嵌 Node.js runtime (+104MB)** — DMG 体积增加过大，目标用户是开发者，大多已有 Node.js。
3. **自研 CDP MCP server** — 开发量大，功能受限，chrome-devtools-mcp 已有 20+ 工具覆盖截图/导航/DOM/网络/性能等。
4. **npx/bunx 启动** — 多层进程导致 stdio pipe 断裂，已在其他 MCP 场景验证此问题。

## 后果

- **正面**：DMG 零增量；利用成熟开源工具；首次安装仅 ~13MB；支持所有主流 Node 版本管理器。
- **负面**：依赖用户系统有 Node.js v20+；首次使用需联网下载；npm install 可能因网络问题失败（已提供重试机制）。
- **UI 入口**：sidebar MCP 面板 + 设置页远程服务，双入口管理。
