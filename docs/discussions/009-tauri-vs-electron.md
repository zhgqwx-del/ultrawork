# 009 — 桌面端框架调研：Tauri 现状、Electron 对比与迁移代价评估

> 状态：调研记录（不修改代码，仅分析）
> 日期：2026-06-04
> 关联：`packages/client/desktop/src-tauri/`、`scripts/build-release.ts`、ADR-028（发布前 readiness）、Discussion 003（Sidecar 复用）

---

## 0. TL;DR（结论先行）

1. **确认：Ultrawork 桌面端用的是 Tauri v2**（Rust 壳 + 系统 WebView + React 前端），不是 Electron。
2. **Tauri 目前服务良好**，且 Ultrawork 的核心算力都在 sidecar（OpenCode/Gateway/Knowledge），桌面壳本身是"瘦壳 + 进程编排器"，这恰好是 Tauri 最擅长、Electron 优势最不明显的形态。
3. **不建议现在切换到 Electron**。当前没有出现"Tauri 做不到"的硬性能力缺口；切换的主要收益（Chromium 渲染一致性、Windows/Linux 稳定性、更成熟的自动更新/深链生态）对一个**当前只发 macOS、且渲染逻辑不复杂**的产品来说，回报有限，而代价不低（Rust 层 ~1500 行命令需用 Node/IPC 重写、构建/签名/公证链路重做、包体从 ~10MB 级跳到 ~100MB 级）。
4. **实测修正了一个常见误判**：Tauri 最大的卖点"包体轻量"在 Ultrawork 场景被**严重稀释**——当前单架构 `.app` 实测 258MB，其中 Tauri 壳本体只有 **12MB（<5%）**，其余 245MB 全是 sidecar。换 Electron 总包体约 +110MB（+43%），仍是同一数量级（详见 §3.2）。所以"包体"不应作为反对迁移的主论据。
5. **值得关注的信号**：上游 OpenCode 仓库**同时维护 Tauri（`packages/desktop`）和 Electron（`packages/desktop-electron`）两套桌面端**。这说明业界对"二选一"本身就有分歧，也给了 Ultrawork 一个现成的 Electron 参考实现——**如果未来真要切，成本会比从零低**。
6. **触发迁移的条件**（满足任一再认真评估）：(a) 要正式支持 Windows/Linux 且 WebView2/WebKitGTK 渲染差异变成持续维护负担；(b) 前端用到 Chromium 独占的浏览器能力（特定 `<video>`/WebGL/WebRTC/扩展行为）；(c) 团队 Rust 维护意愿/能力成为瓶颈。

---

## 1. 背景与调研目标

用户问题：当前 Ultrawork 桌面端是不是用 Tauri？能否对比 Electron，分析优劣与能力边界，后续是否要切换到 Electron，若切代价如何。

本调研基于**源码实证**（不依赖外部记忆）：直接读取了 `packages/client/desktop` 的 `package.json`、`src-tauri/`（`tauri.conf.json`、`Cargo.toml`、`lib.rs`、`capabilities/`）、根 `package.json`、`scripts/build-release.ts`，以及 `vendor/opencode/packages/` 下的两套上游桌面端实现。

---

## 2. 现状确认：Ultrawork 桌面端的 Tauri 架构

### 2.1 技术栈实证

| 层 | 技术 | 证据 |
|----|------|------|
| 桌面壳 | **Tauri v2** | `Cargo.toml`: `tauri = { version = "2" }`；`tauri.conf.json`: `"$schema": ".../config/2"` |
| 壳后端语言 | **Rust** | `src-tauri/src/lib.rs`（1472 行）+ `main.rs` |
| 前端 | React 19 + Vite 7 + Tailwind 4 | `packages/client/desktop/package.json` |
| 前端↔壳桥 | `@tauri-apps/api` + 插件 | `plugin-shell`/`plugin-dialog`/`plugin-fs`/`plugin-opener` |
| 渲染引擎 | **系统 WebView**（macOS=WKWebView，Win=WebView2，Linux=WebKitGTK） | Tauri 架构本质，非打包 Chromium |
| 打包产物 | `dmg` + `app`，Universal（arm64+x64 lipo） | `tauri.conf.json` bundle.targets；`scripts/build-release.ts` |

**结论**：100% 确认是 Tauri v2，不含任何 Electron 代码。

### 2.2 桌面壳到底承担了什么职责

Tauri 壳并非"只是个窗口"。`lib.rs` 暴露了约 20 个 `#[tauri::command]` + 大量内部函数，职责可归纳为五类：

1. **Sidecar 进程编排**（核心）：通过 `tauri-plugin-shell` 的 `externalBin` 拉起三个常驻 sidecar——
   - `opencode-server`（:4096，关键路径，阻塞到 health 通过）
   - `channel-gateway`（:4097，后台线程）
   - `knowledge-sidecar`（:4098，后台线程）
   - 含端口探测/占用清理（`prepare_port`/`kill_port_process`）、健康检查（`check_health`）、退出时统一 `shutdown_sidecars`。
2. **OS 原生集成**：`open_file_with_system`（`open`）、`reveal_file_in_finder`（`open -R`）、Finder PATH 受限的 `rich_path()` 修复、`detect_chrome`。
3. **运行时环境装配**：内嵌 Node 下载/解压/设权（`download_node`/`set_executable`）、Browser MCP（Playwright/DevTools）安装、`detect_browser_env`。
4. **安全/凭证/配置管理**：`load_or_create_sidecar_credentials`（首启随机 32B hex + 0600）、全局 `~/.config/ultrawork/opencode.json` 的原子读写、MCP 配置增删、`migrate_from_opencode` 一次性迁移〔**注：该迁移逻辑已于 2026-06-14 移除，详见 ADR-020 + CHANGELOG；此处保留为当时快照**〕。
5. **发布工程**：Universal 跨编译 + codesign + notarize（`build-release.ts`）、capability 权限模型（`capabilities/default.json`）。

> **关键洞察**：Ultrawork 的"重活"全在 sidecar 里（都是独立可执行文件，与桌面壳框架无关）。桌面壳是一个**瘦渲染层 + 进程编排器 + OS 胶水层**。这个形态决定了 Tauri/Electron 的选择主要影响"壳"这一层，**不影响业务核心**——这也是迁移代价"有界"的根本原因。

---

## 3. Tauri 与 Electron 的原理性差异

| 维度 | Tauri v2 | Electron |
|------|----------|----------|
| 渲染引擎 | **系统 WebView**（随 OS 版本变化） | **自带 Chromium**（版本随 Electron 锁定） |
| 壳后端运行时 | **Rust 原生二进制** | **Node.js**（主进程） |
| 进程模型 | 主进程(Rust) + WebView 进程 | main(Node) + renderer(Chromium) + preload |
| 前端↔后端桥 | `invoke` → Rust command（IPC over IPC） | `ipcRenderer`/`ipcMain` + preload `contextBridge` |
| 包体（典型空壳） | **~3–10 MB 级** | **~80–150 MB 级**（含 Chromium+Node） |
| 内存占用 | 较低（复用系统 WebView） | 较高（每应用一份 Chromium） |
| 渲染一致性 | **跨平台/跨版本有差异**（WebKitGTK 尤其） | **强一致**（同一 Chromium） |
| 生态成熟度 | 年轻，插件在补齐 | **极成熟**（更新/崩溃上报/原生模块） |
| 调试体验 | WebView devtools（平台差异） | Chrome DevTools 全套 |
| 团队技能要求 | 需要 **Rust** | **纯 JS/TS** |

### 3.1 这些差异对 Ultrawork 的实际含义

- **包体/内存**：Tauri 壳本身确实轻（壳二进制仅 12MB），但**对 Ultrawork 的总包体影响有限**——sidecar 才是大头（见 §3.2 实测）。内存上 Tauri 仍占优（复用系统 WebView，省一份 Chromium）。
- **渲染一致性**：这是 Electron 最大的卖点，但**只有在多平台或用到 Chromium 独占特性时才兑现**。Ultrawork 当前**只发 macOS**（`build-release.ts` 的 Universal 链路、`entitlements.plist`、notarize 全是 macOS 专属），WKWebView 单平台下一致性问题被显著弱化。
- **WebKit 怪癖（已知成本）**：MEMORY/代码里记录了两处 WKWebView 特有坑——
  - 输入框 `--` 被 WebKit 智能标点替换为 em dash（`sanitizeCliText()` 兜底）；
  - `titleBarStyle: Overlay` 下 `data-tauri-drag-region` 失效，改用 `startDragging()`（tauri#9503）。
  这类坑在 Electron/Chromium 下通常不存在。属于**Tauri 的隐性持续成本**，但目前已被局部 workaround 消化，未构成阻塞。
- **Rust 维护面**：`lib.rs` 1472 行 Rust 是真实的认知/维护负担（端口、进程、文件权限、跨平台 cfg）。若团队以 JS/TS 为主，这是 Tauri 侧的长期摩擦点；反过来，Electron 的 main 进程用 Node 写，能与现有 bun/TS 工具链统一。

### 3.2 实测包体（推翻"包体轻量"主论据）

对当前已构建产物实测（`src-tauri/target/`）：

| 产物 | 实测大小 | 构成 |
|------|----------|------|
| `.app`（aarch64 单架构） | **258 MB** | Tauri 壳 12MB + opencode-server 122MB + knowledge 64MB + gateway 59MB |
| `.app`（universal 双架构） | **530 MB** | 同上，双架构 lipo |
| DMG（aarch64，压缩后） | **84 MB** | — |
| DMG（universal，压缩后） | **174 MB** | — |

**关键事实**：**Tauri 壳本体只有 12MB，占整个 `.app` 不到 5%**；其余 95%（245MB）全是三个 sidecar（OpenCode/Knowledge/Gateway，均为 `bun build --compile` 自带运行时的独立二进制）。

**对迁移决策的含义**：
- "Tauri 包体小"是针对**空壳**而言（~10MB vs Electron ~120MB）；但 Ultrawork 的 `.app` 早已是几百 MB 量级，**壳框架的差异被 sidecar 稀释**。
- 换 Electron 后，壳从 ~12MB → ~120–150MB，单架构 `.app` 约 258MB → ~370MB（**+110MB，+43%**），DMG 约 84MB → ~130–150MB。**仍是同一数量级**，不存在"轻量级跳到重量级"的质变。
- 结论：**包体不应作为反对迁移的主论据**。Tauri 在本项目的真实存量收益主要是"内存（省一份 Chromium）+ 无需打包 Chromium 安全补丁"，而非安装包大小。

### 3.3 两个易被忽略的对比维度

- **安全模型**：
  - Tauri：前端默认**完全无法触达 Node/系统**，能力必须经 Rust command 显式注册 + `capabilities/*.json` 白名单授权（本项目 `default.json` 仅放开 shell/dialog/opener 等少数权限）。攻击面天然小。
  - Electron：需自行守纪律——`contextIsolation: true` + `nodeIntegration: false` + preload `contextBridge` 白名单，配置不当易把 Node 暴露给渲染层。
  - ⚠️ 注意：当前 `tauri.conf.json` 里 `security.csp = null`（**关闭了 CSP**）。这在 Tauri/Electron 任一框架下都是应收紧的点，与选型无关，但迁移时值得顺手补上。
- **系统 WebView 版本绑定 OS（Tauri 特有风险）**：Tauri 用系统 WebView，**渲染引擎版本 = 用户的 OS 版本**。本项目 `minimumSystemVersion: 10.15`，老 macOS 上 WKWebView 较旧，可能缺新 CSS/JS 特性且**无法单独升级**；Electron 自带 Chromium，渲染版本与 OS 解耦、可随应用升级统一。目前只发新版 macOS、前端用 React/Tailwind 主流特性，此风险尚低，但若要覆盖老系统需留意。

---

## 4. 能力边界：Ultrawork 的具体需求逐项核对

把"是否需要切 Electron"落到 Ultrawork 实际用到的能力上，逐条核对 Tauri 能否覆盖：

| 能力需求 | 当前实现 | Tauri 是否够用 | 备注 |
|----------|----------|----------------|------|
| 拉起/管理多个 sidecar 进程 | `plugin-shell` externalBin | ✅ 已稳定运行 | Electron 用 `child_process.spawn` 同样可做 |
| 端口探测/清理/健康检查 | Rust std::net + 命令 | ✅ | Electron 需用 Node net 重写 |
| 打开文件/Finder 高亮 | `open` / `open -R` | ✅ | Electron 有 `shell.openPath`/`shell.showItemInFolder` 原生支持，**更省事** |
| 凭证文件 0600 + 原子写 | Rust fs | ✅ | Electron 用 Node fs + `electron-store` |
| 全局配置 JSON 原子读写 | Rust + Mutex | ✅ | — |
| 内嵌 Node 下载/解权 | Rust | ✅ | — |
| 自定义标题栏/拖拽 | Overlay + startDragging | ✅（有 WebKit 坑） | Electron `titleBarStyle` + drag region **更顺** |
| SSE/HTTP 调 sidecar | 前端直连 localhost | ✅ 与壳无关 | 两边一致 |
| 自动更新 | 暂未启用 | ✅ `plugin-updater` | Electron `electron-updater` 生态**更成熟** |
| 深链/协议（`opencode://` 类） | 暂未用 | ✅ `plugin-deep-link` | Electron `setAsDefaultProtocolClient` **更成熟** |
| 多平台（Win/Linux） | **未做** | ⚠️ 可做但 WebKitGTK 一致性差 | **Electron 的真实优势区** |

**边界结论**：**目前没有任何一项是"Tauri 做不到"**。差异集中在"做起来顺不顺/生态成不成熟"，而非"能不能做"。Electron 真正占优的（多平台一致性、更新/深链生态）目前都**不是 Ultrawork 的当下刚需**。

---

## 5. 关键外部参照：上游 OpenCode 同时维护两套

调研中发现一个高价值信号——`vendor/opencode/packages/` 下**同时存在**：

- `desktop`：Tauri v2 + SolidJS（`src-tauri/`、`@tauri-apps/*` 全家桶）
- `desktop-electron`：Electron 40 + electron-vite + electron-builder（`src/main`、`src/preload`、`src/renderer` 三段式，`electron-store`/`electron-log`/`electron-updater`/`electron-window-state`）

> 注：`desktop-electron/README.md` 文案仍写着 "built with Tauri v2"，是复制粘贴遗留；其 `package.json`/目录结构是**确凿的 Electron**。

**解读**：
1. 上游自己也没把"Tauri vs Electron"当成已决问题——它**两套都留着**。常见动机是：Tauri 路线吃轻量，Electron 路线吃 Windows/Linux 一致性与生态（`electron-updater`、`deep-link`、context-menu）。
2. 对 Ultrawork 是**利好**：上游的 `desktop-electron` 提供了一个**现成的、把 OpenCode sidecar 跑在 Electron main 进程里**的参考实现（`src/main/cli.ts`/`server.ts` 已处理 spawn、sidecar 路径、health、env 注入）。**真要迁移时，进程编排这块可大量借鉴**，而这恰恰是 Ultrawork Rust 层最重的部分。

---

## 6. 若切换到 Electron：代价评估

假设决定迁移，工作量可分解如下（**这是"为什么暂时不切"的量化依据**，不是迁移指南）：

### 6.1 必须重写的部分（Rust → Node/TS）

`lib.rs` 的 ~20 个 command + 内部函数需要在 Electron main 进程用 Node 重新实现：

| 模块 | 迁移难度 | 说明 |
|------|----------|------|
| sidecar spawn/编排/health/端口清理 | 中 | Node `child_process` + `net`；**可借鉴上游 desktop-electron** |
| 凭证 0600 + 原子写 + 全局配置读写 | 低-中 | Node fs + `electron-store`；注意 Windows 无 0600 语义 |
| open/reveal in Finder | **低（变简单）** | Electron `shell` 原生 API |
| 内嵌 Node 下载/解权、Browser MCP 安装 | 中 | 逻辑照搬，平台 cfg 重做 |
| rich_path / detect_chrome / detect_browser_env | 中 | 重写 PATH 探测；Node 有 `process.env` 但需补 macOS GUI 启动 PATH 问题（`shell-env`，上游已有 `shell-env.ts`） |
| 权限模型（capabilities） | 低 | Electron 用 preload `contextBridge` 白名单替代 |

### 6.2 必须重做的工程链路

| 项 | 影响 |
|----|------|
| 构建系统 | `tauri build` → `electron-vite` + `electron-builder`；`build-release.ts` 整段重写 |
| 签名/公证 | macOS codesign + notarize 流程迁到 electron-builder 配置（`entitlements.plist` 需适配 Electron 的 hardened runtime 要求，比 Tauri 多 entitlement） |
| Universal 二进制 | electron-builder 支持 `universal`，但 sidecar lipo 合并逻辑要重接 |
| 自动更新 | 若启用，迁 `electron-updater` |
| 前端桥接 | 所有 `invoke('cmd')` → `window.api.cmd()`（preload 暴露），需建 preload 层 + 类型 |

### 6.3 不需要改的部分（迁移成本"有界"的原因）

- **三个 sidecar 本身**：独立可执行文件，与壳框架无关，零改动。
- **前端 React/Vite/Tailwind/业务逻辑**：渲染层基本不变（仅 `invoke` 调用点替换为 preload API）。
- **api-client / server-manager / gateway / knowledge**：全部与桌面壳解耦，零改动。

### 6.4 代价量级总结

| 维度 | 量级 |
|------|------|
| 工程工作量 | **2–4 人周**（含重写 Rust 命令、构建/签名链路、preload 桥、回归测试），有上游 electron 参考可压缩 |
| 包体 | 单架构 `.app` 约 258MB → **~370MB（+43%，同数量级）**；壳 12MB→~120-150MB，被 sidecar 稀释（见 §3.2） |
| 运行内存 | 上升（自带一份 Chromium，不再复用系统 WebView） |
| 风险 | 中——核心 sidecar 不变，风险集中在壳层 + 签名/公证 + 跨平台回归 |
| 一次性收益 | 渲染一致性、消除 WebKit 怪癖、Win/Linux 路径打通、统一 JS/TS 技术栈 |
| 持续成本变化 | 维护语言从 Rust 收敛到 TS（+），但需常态升级 Chromium 安全补丁（-） |

---

## 7. 建议与决策触发条件

### 7.1 当前建议：**维持 Tauri，不迁移**

理由：
1. 没有出现"Tauri 做不到"的硬缺口（§4）；现有 WebKit 坑已被局部消化。
2. Ultrawork 当前只发 macOS（WKWebView 单平台，一致性问题弱化），Electron 最大卖点未兑现。
3. 业务核心在 sidecar，桌面壳是瘦壳——切框架收益有限、包体/内存代价确定性变差。
4. 迁移要重写 ~1500 行 Rust + 整条构建/签名链路，2–4 人周投入用在框架平移上，不如投在产品能力。

### 7.2 应当重新评估迁移的触发条件（满足任一）

1. **正式支持 Windows/Linux**，且 WebView2/WebKitGTK 的渲染/行为差异变成**反复出现的维护负担**（这是最强的迁移理由）。
2. 前端需要 **Chromium 独占能力**：特定 `<video>` 编解码、WebGL/WebGPU 行为、WebRTC、扩展/CDP 级控制等，WKWebView 无法满足。
3. **团队 Rust 维护能力/意愿成为瓶颈**，希望桌面壳统一到 JS/TS 技术栈。
4. 需要依赖 **Electron 独有的成熟生态**（如 `electron-updater` 的差量更新、崩溃上报、原生菜单/上下文菜单）且 Tauri 对应能力补齐成本更高。

### 7.3 降低未来迁移成本的"对冲"建议（可选，低成本）

即使不迁，也可以让代码更"框架中立"，把未来潜在迁移成本压低：

- **保持 sidecar 与壳的解耦现状**（已做得很好），不要把业务逻辑往 Rust 里塞。
- **收敛壳能力调用面**：前端对 `invoke(...)` 的调用尽量集中在一个 `src/lib/native.ts` 适配层，将来换 `window.api` 只改一处。
- **关注上游 `desktop-electron` 的演进**：它是现成的迁移蓝本，值得在 sidecar 编排/`shell-env` PATH 处理上持续对照。

---

## 8. 附：源码证据索引

- 框架确认：`packages/client/desktop/src-tauri/Cargo.toml`、`tauri.conf.json`
- 壳职责：`packages/client/desktop/src-tauri/src/lib.rs`（`run()` setup 在文件末尾，sidecar 编排 + 命令注册）
- 权限模型：`packages/client/desktop/src-tauri/capabilities/default.json`
- 发布链路：`scripts/build-release.ts`（Universal 跨编译 + codesign + notarize）
- 上游双实现：`vendor/opencode/packages/desktop`（Tauri）、`vendor/opencode/packages/desktop-electron`（Electron）
- WebKit 坑记录：MEMORY.md「Tauri titleBarStyle Overlay 坑」「macOS 智能标点坑」
- 实测包体（§3.2 数据来源，2026-06-04 实测 `src-tauri/target/`）：
  - `release/bundle/macos/Ultrawork.app` = 258MB（壳 `Contents/MacOS/ultrawork` 12MB + 三 sidecar 245MB）
  - `universal-apple-darwin/.../Ultrawork.app` = 530MB；DMG aarch64=84MB / universal=174MB
  - sidecar 源：`src-tauri/binaries/`（opencode-server / channel-gateway / knowledge-sidecar，均 `bun build --compile`）
- CSP 现状：`tauri.conf.json` → `app.security.csp = null`（已关闭，建议收紧，与选型无关）
