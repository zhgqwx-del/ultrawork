# Ultrawork - AI Quick Reference

> **跨平台是硬约束**：所有新代码默认须 macOS / Windows / Linux 三平台兼容（规则见 `CLAUDE.md` §通用约定 + `docs/conventions.md §13`，门禁 = `.github/workflows/ci.yml`，背景 ADR-037）。

## Project Overview

Ultrawork is a desktop-grade AI agent built on OpenCode's server capabilities.
Desktop App connects to OpenCode Server (sidecar), sends messages, and displays AI responses.
Channel Gateway bridges IM platforms (DingTalk, WeChat, WeCom, Feishu) to the same Agent backend.
Knowledge Sidecar provides local RAG + third-party (IMA) knowledge sources exposed to the Agent via MCP.
ACP Client Sidecar drives external coding agents (Claude Code, …) via ACP and normalizes their output to the opencode SSE shape (ADR-027 档1, sessions bind one agent each).

## Architecture

- **Monorepo**: Bun workspaces + Turborepo
- **Desktop**: Tauri 2 + React 19 + Tailwind CSS 4
- **Backend**: OpenCode Server (headless, spawned as Tauri sidecar)
- **Gateway**: Channel Gateway (Hono + DingTalk Stream SDK, spawned as Tauri sidecar)
- **AI Provider**: OpenCode Zen (Big Pickle model, free) + 35+ paid models
- **Auth**: Basic Auth — sidecar 凭证首启随机生成（32 字节 hex），持久化 `~/.config/ultrawork/sidecar-auth.json` (0600)；`ULTRAWORK_SIDECAR_PASSWORD` env 可覆盖（CI/测试用）。详见 ADR-028

## Key Packages

| Package | Status | Description |
|---------|--------|-------------|
| `@agent/api-client` | ✅ Done | OpenCode REST/SSE TypeScript client |
| `@agent/server-manager` | ✅ Done | Process lifecycle management (spawn, health check, stop) |
| `@agent/client-desktop` | ✅ Done | Tauri desktop app (React 19 + Vite 7 + Tailwind 4) |
| `@agent/channel-gateway` | ✅ Done | IM channel gateway (DingTalk Stream SDK + WeChat ilink + Hono on Bun.serve, sidecar :4097) |
| `@agent/knowledge-sidecar` | ✅ Done | 本地 RAG 知识库 + 第三方平台 (IMA) adapter + MCP bridge, sidecar :4098 |
| `@agent/acp-client` | ✅ 阶段1（claude/gemini/qoder/hermes/codex 达标） | ACP Client Sidecar：spawn 外部 agent（stdio JSON-RPC）+ turn 整形成 opencode SSE 形状 + 权限回环 + 历史持久化, sidecar :4099 |
| `@agent/connector` | ✅ 阶段2（ADR-030） | 控制+事件统一层：可插拔 backend adapter（OpenCodeBackend/ACPBackend）+ 统一 SSE transport + 会话绑定（sidecar 持久化 hydration）+ capabilities 门控 |
| `@agent/orchestrator` | ✅ 阶段3 全量（ADR-031 + 017 Team 页） | 编排层：spawn/await/steer/cancel 原语 + 治理护栏 + DAG 调度（Pipeline/Fan-out 同一执行器）+ worktree 隔离 + agent 驱动 delegate（阻塞 D-2 契约）+ QueueOwner；宿主 = ACP sidecar :4099（`/orchestration/*` + team 注册表 + delegate-mcp stdio shim）；产品面 = 主聊天流统一入口（018：Home segmented + 侧栏混排徽标 + Session 页合流；Leader=ROOT 会话）+ `/orchestration` 纯流水线页 |

## Project Structure

```
ultrawork/
├── packages/
│   ├── client/desktop/          # Tauri desktop app
│   │   ├── src/                 # React frontend (30+ components)
│   │   └── src-tauri/
│   │       ├── src/lib.rs       # Sidecar startup (OpenCode + Gateway)
│   │       ├── tauri.conf.json  # Tauri config with externalBin
│   │       └── binaries/        # Sidecar binaries (platform-specific)
│   ├── core/
│   │   ├── api-client/src/      # REST client for OpenCode API
│   │   ├── connector/src/       # Control+event unification layer (backends/, sse-transport, binding-store)
│   │   ├── orchestrator/src/    # Orchestration layer (primitives, pipeline, run-store; hosted by acp-client)
│   │   └── server-manager/src/  # Process manager for OpenCode
│   ├── agent/
│   │   └── acp-client/src/      # ACP Client Sidecar (spawn external agents + turn shaping + permissions)
│   ├── channel/
│   │   └── gateway/src/         # Channel Gateway (bridge, DingTalk/WeChat/WeCom/Feishu adapters + qr-registry)
│   └── knowledge/
│       └── sidecar/src/         # Knowledge Sidecar (local RAG + IMA adapter + MCP bridge)
├── scripts/                     # Build scripts
├── vendor/opencode/             # OpenCode git submodule
├── docs/                        # Project documentation
│   ├── architecture-phase1.md   # Phase 1 system architecture
│   ├── api-reference.md         # OpenCode API details
│   ├── conventions.md           # Development conventions
│   ├── decisions/               # Architecture Decision Records
│   └── archive/                 # Historical reviews/summaries
└── design/                      # Product design & references
```

## Development Commands

```bash
bun install              # Install dependencies
bun run typecheck        # Type check all packages (6)
bun run build:opencode   # Compile OpenCode sidecar binary
bun run build:gateway    # Compile Gateway sidecar binary
bun run build:knowledge  # Compile Knowledge sidecar binary
bun run build:acp        # Compile ACP Client sidecar binary (kills stale :4099 on rebuild)
bun run tauri:dev        # Start desktop app in dev mode
bun run tauri:build      # Build production desktop app
bun run release          # Build Universal macOS DMG (dual-arch sidecars + lipo)
```

## OpenCode API Reference

```
POST /session              → Create session
GET  /session/:id          → Get session details
POST /session/:id/prompt_async → Send message (returns 204, async)
GET  /event                → SSE event stream (global)
GET  /config               → Get config
PATCH /config              → Update config (disk only, not runtime)
GET  /provider             → List providers + models
GET  /mcp                  → List MCP servers
GET  /file?path=           → File tree (relative paths + x-opencode-directory header)
```

- Auth: `Authorization: Basic base64(opencode:password)`
- Health: `GET /global/health`
- Model override: `prompt_async` `model` field `{ providerID, modelID }`

## Key Files (关键文件地图)

> main 分支文件。（旧 `feat/acp-support` 分支已被 `feat/agent-os-phase0` 的参考重写取代，ADR-027 B2。）

**Desktop — chat / session 组件**
- `src/components/chat/` — reasoning-block, tool-call-block, step-indicator, execution-status, model-selector, permission-dock, question-dock, command-selector, assistant-turn, execution-flow, message-parts（markdown 渲染管线：gfm + **math/KaTeX**，ADR-070）, **turn-artifacts**（每轮回复下方的产物卡片，ADR-052）
- `src/components/session/` — plan-panel（**任务规划**主区：渲 `PlanStep[]`，ADR-038）, artifacts-panel（产物识别=工具意图+`scan_workspace_changes` 文件系统真相；`classifyArtifacts` 分产物/工作文件，ADR-033）, workspace-panel, artifact-preview（pdf 走 `pdf-view.tsx`/pdf.js）, pdf-view.tsx（pdfjs-dist 渲 canvas，字节经 `read_file_bytes`）（右栏「执行活动/连接器/技能」三段已于 ADR-059 移除，对应 progress-panel/mcp-panel/skills-panel 组件已删）
- `src/components/ui/` — file-icon.tsx（彩色扩展名徽章）, logo.tsx（棱镜 SVG + useId 防冲突）, select.tsx（shadcn 风格 `@radix-ui/react-select`，取代原生 `<select>`；坑：禁空串 value，见 conventions §5）, toggle.tsx（`role=switch` 受控开关，即时生效布尔项用，ADR-058 D1）
- `src/lib/i18n-context.tsx` + `i18n-translations.ts` + `i18n-zh-hant.generated.ts` — i18n（ADR-058）：`i18n-translations.ts` 是**唯一手写源**（`en` + `zh-Hans`，纯数据无 React/tauri 依赖 → 供构建期生成器 import）；`zh-Hant` 由 `scripts/gen-zh-hant.ts`（opencc-js `s2twp`）从 `zh-Hans` **构建期生成**（devDep，不进 bundle），`t()` 三语同构无特殊路径；`config.ts` 存 `Language = "en"|"zh-Hans"|"zh-Hant"`（旧 `"zh"`→`"zh-Hans"` 迁移、detect 台港 locale→Hant）。改简体后须 `bun run --bun scripts/gen-zh-hant.ts` 重生成，check-docs §9 兜底防漂移
- `src/components/layout/drag-region.tsx` — handleDrag() + DragRegion 透明拖拽条
- `src/components/brand-icons.tsx` — 微信/企微/钉钉/飞书品牌圆形徽章（CC0/MIT/Apache 素材构建期内联；负形 glyph 结构化白底盘，ADR-044）
- `src/components/settings/section-tabs.tsx` — 设置页 section 子 tab 共享组件（技能/连接器/知识库同款 Radix 段控；数据驱动注册表 `{id, labelKey, icon?, count?}`，count=**条目数**非连接数）。**只包 `TabsList`，`TabsContent` 由调用方写**——`forceMount` 是逐面板决定（重叠子集 tab 禁 forceMount，conventions §5）
- `src/components/settings/channels-section.tsx` — 消息渠道设置页 section（ChannelQRLogin 泛化扫码流 + type 驱动手动表单，从 Settings.tsx 拆出）
- `src/components/settings/models-section.tsx` — 模型管理设置页 section（provider 卡片列表 + 配置流程 + **自定义 provider 表单/删除**；取代旧的全局 ModelDialog，由 Settings 页 `models` section 渲染，Home/Session「管理模型」深链至此；含 DashScope 模型行「联网搜索」`enable_search` toggle，ADR-042）
- `src/components/settings/search-tools-section.tsx` — 设置页「工具」分区（BYOK 联网搜索：Tavily/IQS key 卡 + 测试连接〔Rust `test_search_provider`〕+ 默认服务商 + Exa 高级开关，ADR-042）；外链常量在 `src/lib/external-links.ts`
- `src/components/settings/agents-section.tsx` + `agent-templates.ts` — 外部 Agent CRUD 表单（预置模板 chips：claude/gemini/qoder/hermes/codex + thoughtLevel select）
- `src/components/knowledge/add-source-dialog.tsx` — 添加知识源对话框（类型 → IMA 凭证向导 → 测试 → 选库）
- `src/components/settings/about-legal.tsx` — 关于页三合规子视图（ADR-063）：`OssLicensesView`（第三方开源软件表格：来源筛选 chips + 搜索 + 经典翻页每页 50 + 行内展开许可全文；数据 dynamic import `@/generated/licenses.json`+`license-texts.json` 不进启动包）· `LegalDocView`（渲 `@/generated/legal.json` 的 EULA/隐私草稿，含 `【】` 占位符自动显草稿横幅）· `LegalEntryButton`。`AboutSection`（`Settings.tsx`）底部一行 5 入口切 sub-view
- `src/generated/{licenses,license-texts,legal}.json` — **构建期生成产物**（ADR-063，`scripts/gen-notices.ts` 产），提交快照；依赖 bump 后须 `bun run gen:notices` 重生成。同时产根 `NOTICES.txt`（合规全量）
- `scripts/gen-notices.ts` — 第三方 NOTICES 生成器：聚合 npm(`node_modules/.bun`) + opencode 内嵌(`vendor/opencode/bun.lock`) + cargo(`cargo metadata`) + 捆绑/vendored 四类来源。坑：bun.lock 是 JSONC（仅尾逗号，`//` 剥离会误伤 `https://`）
- `docs/legal/{user-service-agreement,privacy-policy,README}.md` — EULA/隐私政策草稿 SSOT（ADR-063 / discussions/047），含占位符替换清单；`gen-notices` 剥 HTML 注释后打进 `legal.json`。**商用前须法务定稿 + 填占位符 + 真实注册主体**

**Desktop — hooks / lib**
- `src/lib/sse-context.tsx` — ConnectorProvider（导出名仍 SSEProvider）：持有 Connector + useConnector/useSSESubscribe/useSessionSubscribe/useSSEConnected
- `src/lib/use-api.ts` — backend-specific REST 面：返回 connector 持有的 ApiClient（签名不变）
- `src/lib/use-session-messages.ts` — 消息状态 + SSE 处理 + 历史窗口 + 发送/停止（全部经 connector 按绑定派发，无 isACP 分流）；`session.error` 兼理**免费试用透明回退**（ADR-057 P4：auth 错换候选、延迟到 idle 重发；quota 明确提示）
- `src/lib/model-context.tsx` — ModelProvider：当前模型 + **免费试用同意门**（ADR-057）：`maybeOfferFreeTrial`（发送前拦截，无可用模型且未同意时弹卡片）· `enableFreeTrial`（乐观 seed）· `advanceFreeTrialModel`（回退换候选）· `revokeFreeTrial`（带保护清除）；`useModelOptional()` 供隔离单测
- `src/lib/free-model.ts` — 免费 Zen 选型纯函数（ADR-057 P1）：`orderedFreeCandidates`/`shouldOfferFreeTrial`/`nextFreeCandidate`/`classifyZenError`/`isFreeZenModel`；`FREE_MODEL_PREFERENCE` 偏好序（discussions/040 实测）
- `src/lib/free-trial.ts` + `free-trial-store.ts` — 同意状态机（`enableFreeTrial`/`revokeFreeTrial`，注入式可测）+ Tauri/api 适配器；Rust 侧 `get/set/clear_free_trial_consent`（`lib.rs`，独立 `free-trial-consent.json`）
- `src/lib/use-attachments.ts` + `attachments.ts` + `use-screenshot.ts` + `model-capabilities.ts` — 输入框多模态附件（discussions/039，P0+P1 + P2 截图 ADR-056）：三入口（➕/拖拽/粘贴）+ 剪刀截图按钮 → `add(File[])`/`addPaths` 管道；**按成本分流**（图片降采样内联 · 文本 `file://` 走服务端 Read 截断 · PDF 按页数分流〔>8MB 或 >20 页降级 document〕· Office 拷进 `.ultrawork/attachments/`）+ 模型能力门控（读 `capabilities.input.image`，gotchas §1）+ 单轮内联预算。截图产出走 Rust `capture_screenshot`（mac `screencapture -i -x` + TCC 门控 · win `ms-screenclip` 剪贴板轮询 · linux 探测），字节复用 `add()` 管道
- `src/lib/use-session-plan.ts` — 任务规划会话级状态（ADR-038）：`connector.getPlan` 水合 + 订阅 `plan.updated` 整表替换，按 sessionID；两竞态防护见 conventions §3（`liveArrivedRef` live-wins + binding 纳入依赖）
- `src/lib/use-session-permission.ts` — 权限/问题处理 + 轮询 fallback（capabilities.questions 门控）
- `src/lib/agent-context.tsx` — AgentProvider：agent 列表 + 绑定委托 connector.bindings + sidecar hydration
- `src/lib/use-session-scroll.ts` — 贴底滚动（`use-stick-to-bottom`，ADR-047）+ **观察滚动容器的 RO**（ADR-048：库只观察内容层，容器变矮时不补正，gotchas §15）
- `src/lib/use-session-artifacts.ts` — 产物派生（工具提取 + 空闲 fs 扫描 + 回合窗归属 + deliverable/working 分类），Session 级常驻；`settled` 为**渲染期派生**（conventions §16）；`byTurn` 为**派生表**（流式期间不重算、按 sessionID 分键，ADR-052）
- `src/lib/turn-artifacts.ts` — **产物→轮次归属表**（last-wins；窗口带 `anchorId` = `groupIntoTurns` 的 `turnKey`，幽灵窗丢弃；**SSOT `extractArtifacts` 一个字不改**，conventions §17，ADR-052）
- `src/lib/external-url.ts` + `src/components/ui/markdown-link.tsx` — **所有外链的唯一出口**（协议白名单 + 全 app 唯一的 markdown `<a>` 渲染器）；Rust 侧 `navigation_guard` 兜底（`lib.rs`）。gotchas §6，ADR-052
- `src/lib/use-artifact-unread.ts` — 未读徽标：按**产物路径集合**判定（非计数）+ 按会话记忆、跨切换存活（ADR-048 D1）
- `src/lib/use-delegate-rows.ts` — delegate SSE 订阅 + 待答子权限，**Session 级**（ADR-048：dock 会被 re-parent，SSE 不重放 pending permission，conventions §15 / gotchas §9）
- `src/lib/command-menu.ts` — `/` 命令菜单的纯逻辑 SSOT（`HIDDEN_BUILTIN_COMMANDS` / `normalizeSource` / `groupBySource` / `rankEntries` / `commandsAvailableFor`），`command-selector` 与 `use-skills` 共用，discussions/056
- `src/lib/use-mcp-servers.ts` / `use-browser-mcp.ts` / `use-skills.ts`（含 `builtin` 分类 + `isBuiltinLocation`）/ `use-skill-deps.ts`（`check_skill_dependencies` invoke + `BUILTIN_DEP_MAP` 依赖 SSOT + `missingDeps`） / `use-builtin-shadow.ts`（`refresh_builtin_skills`/`remove_user_skill_override` invoke，内置遮蔽 fs 真相 + `changed` 协调契约）/ `use-channels.ts` / `use-knowledge-base.ts`
- `src/lib/use-cli-connectors.ts` — 办公 CLI 连接器状态机（ADR-043）：五命令 invoke + generation 守卫 + 配置轮询（容忍瞬时 error/10min 超时显式报错）+ `refresh(id)` 按 id 清错；卡片 `CliConnectorCard`（connector prop 泛化）+ `OFFICE_CLI_CONNECTORS` 注册表在 Settings.tsx ServicesSection（「连接器」分区 MCP/办公 CLI 两组）
- `src/lib/kb-client.ts` — **knowledge sidecar 的唯一 HTTP client**（ADR-045）：`kbFetch` / `kbEventsUrl`，自带 `knowledgeBaseUrl()` + `sidecarAuthHeaders()`。`add-source-dialog.tsx` 曾私藏第二份（硬编码 `:4098` + 无鉴权）导致加鉴权后添加知识源全线 401 —— **新增调用方一律复用它，不要另起 `fetch`**
- `src/lib/sidecar-ports.ts` / `src/lib/sidecar-auth.ts` — **sidecar 端口与凭证的运行时解析（ADR-045）**：`main.tsx` 的启动 gate 在 `createRoot` 前一并 await，下游 `opencodeBaseUrl()`/`gatewayBaseUrl()`/`knowledgeBaseUrl()`/`acpBaseUrl()`/`sidecarAuthHeaders()` 全同步；两个 loader 永不 reject（校验返回值形状而非只 catch）。端口变更走 `sidecar-ports-changed` 事件 → `subscribeSidecarPorts` → SSEProvider 重建 connector
- `src/lib/path-utils.ts`（**跨平台路径工具，renderer 无 `node:path`**：`shortenPath`/`pathBasename`/`isAbsolutePath`，同吃 `/` 和 `\`；ADR-037）、`src/lib/platform.ts`（isMacOS）

**Tauri 命令（`src-tauri/src/lib.rs`）**
- **WebView2 首启自检（ADR-046，`src-tauri/src/webview_runtime.rs`）**：`ensure_webview_runtime()` 在 `main.rs` 里、`run()` 之前调用；`runtime_missing()` = `cfg!(target_os="windows") && tauri::webview_version().is_err()`（免 winreg），缺失弹 `rfd` 引导框到微软下载页再 `exit(1)`。Windows 装机走 `embedBootstrapper`（消除默认 `downloadBootstrapper` 的安装期明文 HTTP 下载执行）；`build-release.ts` 的 `buildWindowsInstallers()` 出双包（embed `-setup.exe` + `-offline-setup.exe`）+ MSI（embed 一种）。
- `open_file_with_system` / `reveal_file_in_finder`（**走 `tauri-plugin-opener`**：内部 ShellExecute/open/xdg-open，跨平台且无 cmd 注入面，ADR-037）、`detect_chrome`（三平台分支 + Windows %LOCALAPPDATA%）、`get_sidecar_credentials`、`get_sidecar_ports`（运行时端口注册表，ADR-045）、`rich_path()`（补 PATH，用 `PATH_LIST_SEP`）
- **跨平台 helper（ADR-037）**：`PATH_LIST_SEP`（`;`win/`:`unix 常量）、`pids_on_port`（lsof/netstat）+`kill_pid`（kill/taskkill）、`install_signal_handlers` `#[cfg(unix)]`+no-op；进程/端口/信号清理在 Windows 走等价命令或安全短路
- **端口生命周期（ADR-045，`lib.rs`）**：`SidecarPorts` 运行时注册表（唯一事实源）+ `~/.ultrawork/run/ports.json`（0600，孙进程读它）；`plan_port`（dev 冲突报错 / prod `bind(0)` 回退，**绝不 kill**）→ `spawn_sidecar`（`watch_sidecar_exit` 专用线程 drain rx 拿 `Terminated`）→ `await_sidecar_ready` → 最多 3 次换端口重试；`strip_persisted_sidecar_ports` 开机剥除 `opencode.json` 里的 stale 端口；`tauri-plugin-single-instance` 顶替「固定端口=事实上的单实例锁」
- `scan_workspace_changes(dir, sinceMs)`（walk 目录取 mtime≥基线的文件，产物识别用，ADR-033）、`read_file_bytes(path)`（scope-free `std::fs::read`+`ipc::Response`，PDF 预览取字节用）
- `check_skill_dependencies`（async；PATH 探测 + `run_python_feature_probe` python 内探针〔python3.10+ 版本门/python-pptx，四防御见 gotchas §10〕+ `detect_export_browser` 导出浏览器探针〔Chrome→Edge，deckcraft `chrome-or-edge` 徽标；与 find_chrome.py 双清单同步义务见 gotchas §10〕，复用 rich_path）；`ensure_builtin_skills`/`find_builtin_source`/`builtin_needs_refresh`/`install_builtin_tree`/`extract_builtin_zip`/`open_builtin_zip`/`clear_staging`/`reconcile_builtin_shadowing`（首启解压 bundle 内 `skills-builtin.zip` → `~/.config/ultrawork/skills/builtin`，解压到 staging+后置写 sentinel+rename 原子交换；zip-slip/symlink/篡改名多重设防；同名用户技能确定性遮蔽 prune / 按前缀选择性解压 restore + `BUILTIN_SKILLS_LOCK`，命令 `refresh_builtin_skills`/`remove_user_skill_override`，ADR-032/040/041）
- **办公 CLI 连接器五命令（ADR-043，「Office CLI connectors」代码段，Phase 3 起注册表驱动）**：`CLI_CONNECTORS` 注册表（lark/dingtalk/wecom 一行一家：probe/install/start_config/start_auth/complete_auth，`connector_def(id)` 统一分发 + 接线测试）；探针骨架 `CliProbeSpec`+`probe_office_cli`（各家 classifier：`classify_lark_auth_status`/`classify_dws_auth_status`/`classify_wecom_auth_show`，`cli_json_output` stderr 回落，版本按路径缓存）；安装 `CliInstallSpec`（+`bin_subdir`）+`install_pinned_cli`（lark/wecom）与 `install_dingtalk_cli`（双工件专属）；阻塞子进程流骨架 `start_parked_device_flow`（`ParkedFlowSpec`，dws 设备流/wecom QR init）+`complete_parked_cli_auth`（`ParkedCompleteSpec`）；`office_cli_bin_dir` 领跑 `compute_rich_path`；上游契约坑 SSOT gotchas §14（三家三套勿互推）

**内置技能（`skills/builtin/`，ADR-032 / ADR-040 / ADR-041 / ADR-061）**
- `skill-creator`/`skill-installer`/`pdf`/`markdown-exporter`（上游 Apache-2.0）——由 `scripts/fetch-builtin-skills.ts` 同步+打补丁（支持按名过滤/post-patch），勿手改；`doc-edit`（自写，Office 读改脚本）、**`deckcraft`**（自写，HTML-first PPT，**做 PPT 的默认技能**：Research→大纲 evidence 门禁→spec_lock→并行 HTML→溢出探针→HTML/PDF/图片型 pptx/可编辑 pptx；P3 起放宽接管「做PPT/生成PPT/演示文稿/幻灯片/slides/deck」全触发面，ADR-061 / discussions/043 §18.5；**ADR-068 形式丰富度轴**：风格库 `references/design-styles/` **10 套**〔`_index.md` 带温度列，pick_variants 解析〕· 版式库 `assets/templates/layouts/` **20 个**〔一版式一 `Sxx.html` + `_index.md` 选型索引，**registry SSOT = 目录内容，新增即生效零改码**〕· `scripts/pick_variants.py` 确定性候选打乱 · 12 个骨相 token + `--c-head`/`--font-display` · 门禁 O10/O11/W3/W4/W5 · E4 风格级白名单〔shadow+gradient〕）、`feishu-assistant`（自写，飞书 lark-cli 薄路由，ADR-043）、`dingtalk-assistant`（自写，钉钉 dws 薄路由——路由到连接器 materialize 的官方 mono 文档，ADR-043）、`wecom-assistant`（自写薄路由 + `references/official/` vendored 官方 9 技能单一 commit 快照〔SKILL.md→INDEX.md 防嵌套误扫，见 `_ORIGIN.md`〕，ADR-043）可直接编辑（改完重打 zip）。**`ppt-master`（上游 MIT，ADR-040）P3 起不再内置**——整树已删，仅作 `INSTALLABLE_SKILLS` curated 长尾退路（美化已有 pptx/模板包场景，用户按需从设置安装）
- 设置-技能页三区在 `src/pages/Settings.tsx`（SkillsSection/DepBadge〔含「引导安装」handoff〕/INSTALLABLE_SKILLS/平台化 DEP_HINTS）；安装/依赖引导都走 Home `initialInput` 预填

**Gateway（`packages/channel/gateway/src/`）**
- `bridge.ts`, `channel-manager.ts`, `gateway-server.ts`, `session-store.ts`
- `session-store.ts` — chatId→session 绑定的持久化（`~/.ultrawork/session-map.json`，v2 schema：channelType/senderName/lastActiveAt/prevSessionId，key 带渠道命名空间）。**路径可注入**（测试绝不碰真实 home，ADR-051）；原子写=唯一临时名 + 串行化
- `bridge.ts` 的 idle 轮转（ADR-051）：`getIdleRotateMs()`（env `ULTRAWORK_CHANNEL_IDLE_ROTATE_MS`，默认 60min）· `shouldRotate()`（in-flight 护栏）· `touchSession()`（活动时钟，只有真正处理了的消息才刷新）· `/resume`
- `math-unicode.ts` — IM 出站 LaTeX→Unicode 降级（ADR-070 D5）：`degradeMathToUnicode()` 由 `bridge.ts` 的 `send()` **一处**调用（所有出站消息的唯一漏斗，四个 adapter 不改）；转换走 KaTeX `__renderToDomTree(output:"mathml")` 的**树对象**+ 规则处理（朴素取文本会把 `\frac{1}{M}` 拍平成 `1M`），解析失败保留原文；扫描器跳 fenced/inline code + 链接目标 + 裸 URL。`MATH_SPAN` 由本文件导出、`wechat-adapter.ts` 的 `stripMarkdown` 共用（定界符判据 SSOT）
- `qr-registry.ts` — 扫码建渠道骨架（后台轮询 + 凭证到达即落盘 + 统一状态枚举 + 并发去重，ADR-044；接入模式 conventions §14）
- `adapters/wechat/` — ilink-api.ts（HTTP 客户端）, wechat-adapter.ts（ChannelAdapter）, qr-provider.ts（ilink 扫码）
- `adapters/dingtalk/` — dingtalk-adapter.ts（Stream 模式）, token-manager.ts, qr-provider.ts（registration 设备流）
- `adapters/wecom/` — wecom-adapter.ts（`@wecom/aibot-node-sdk` 智能机器人长连接）, qr-provider.ts（ai/qc 扫码流）
- `adapters/feishu/` — feishu-adapter.ts（`@larksuiteoapi/node-sdk` WSClient 事件长连接，onReady/onError 语义）, qr-provider.ts（PersonalAgent 注册流，飞书/Lark 双域）

**Connector（`packages/core/connector/src/`，ADR-030）**
- `connector.ts` — 注册表 + 按会话绑定派发 + 双形态 subscribe（global / per-session 双流合并）+ deleteSession 三清
- `sse-transport.ts` — 参数化 fetch-reader（退避三策略 / 心跳看门狗 / gave-up 状态）——三套 SSE 收敛于此
- `binding-store.ts` — 会话↔agent 绑定：BindingCache 注入（desktop=localStorage）+ hydrate 合并（sidecar 优先 + dirty set 防竞态）
- `backends/opencode.ts` — 包装 createApiClient（⚠️ 必须工厂，bridge.test mock 依赖）+ 全局 /event 流（`normalizeOpenCodeEvent` 把 `todo.updated`→统一 `plan.updated`，ADR-038）；`.api` 暴露 backend-specific 面；`getPlan`=REST `/session/{id}/todo`
- `backends/acp.ts` + `acp-http.ts` — acp-stdio 族通用 adapter：per-session SSE 引用计数池 + :4099 REST（原 desktop agent-router）；`getPlan`=`fetchPlan` → `GET /acp/session/:id/plan`（ADR-038）
- `events.ts` — `ConnectorEvent` 统一事件模型；`plan.updated{sessionID,entries}`（ADR-038）+ `PlanStep` 经 `@agent/api-client`；`Connector.getPlan(sessionId)` 按 `capabilities.plan` 门控派发

**Orchestrator（`packages/core/orchestrator/src/`，ADR-031 阶段3 全量）**
- `orchestrator.ts` — 原语（spawn/awaitTask/steer/cancelTask）+ recipe 层（createRun/cancelRun 中止全部在途）+ 治理（含 opencode 子会话 `orchestrator_*` tools deny）+ loadPersisted（重启标 interrupted）
- `turn.ts` — `runTurn` 双语义终态检测（opencode fire-and-forget 等 idle+finish 双信号；ACP 阻塞 prompt 即终态；超时/abort 先 cancel）⚠️ 编排新代码勿直接 await prompt 当完成
- `pipeline.ts` — DAG 执行器（inputs 满足即并行 = Pipeline/Fan-out 同一实现；失败跳传递性下游 + step.permission relay + 隐藏父会话 run 启动时建）；`artifacts.ts` — 产物路径约定 + prompt 契约
- `delegate.ts` — DelegateManager（阻塞 delegate → D-2 契约 `{deliverable,sessionId,tokens,cost}`；长驻隐藏父 `[delegates]`；ring buffer 50）
- `worktree.ts` — Fan-out worktree 隔离（create/remove/stageInputs/collectArtifact；`<xdgData>/ultrawork/worktrees/`）
- `session-queue.ts`（QueueOwner 实现）, `task-registry.ts`（Semaphore 排队语义 + 任务跟踪）, `run-store.ts`（JSON 落盘 `~/.local/share/ultrawork/orchestrator-runs/`）
- 宿主接线在 acp-client：`orchestration.ts`（组合根，per-workspace Connector + releaseConnector）, `orchestration-routes.ts`（9 端点）, `team-routes.ts`+`team-store.ts`（Team 会话注册表：leader/twin 以 ROOT 创建〔018 A-4〕+ ACP leader 注入回滚 + `team-sessions.json` 持久化）, `delegate-mcp.ts`（stdio shim：delegate/list_agents + progress keepalive）, `inproc-acp-backend.ts`（直连 ACPManager，子会话恒 orchestrate:false）, `opencode-credentials.ts`
- Desktop：`pages/Orchestration.tsx`（纯流水线页，018 A-3）+ `components/orchestration/pipeline-tab.tsx`（Pipeline|Fan-out 模板 + 步骤级 model）+ `lib/team-sessions-context.tsx`（018：per-workspace Team 注册表 context，徽标/补显/注入数据源 + ACP leader 加载即绑定）+ `lib/channel-sessions-context.tsx`（ADR-051：渠道会话注册表，喂侧边栏渠道徽标；gateway 不可达降级为空、badge-less 继续工作）+ `lib/use-unread.ts`（ADR-051：未读派生 + 冷启动地板 seedAt，模块级 store 而非 Provider）+ `components/session/team-header.tsx`（Team 成员条：头像组 + delegate SSE 实时活动环）+ `components/chat/team-member-select.tsx`/`agent-avatar.tsx`（成员卡片多选 / 首字母头像）+ `pages/OrchestrationRun.tsx`（依赖深度分层）+ `lib/orchestration-client.ts`（含 team sessions API）+ `lib/team-leader-prompt.ts`（Leader system 提示模板，017 §2.4）+ `lib/orchestrator-mcp.ts`（全局 MCP 静默 ensure，取代「编排模式」开关）+ `lib/use-child-session-history.ts`（懒加载语义共用）+ `components/chat/delegate-row.tsx`（delegate 卡片）+ `delegate-dock.tsx`（阻塞期权限）

**ACP Client Sidecar（`packages/agent/acp-client/src/`）**
- `turn-shaper.ts` — 核心：ACP `session/update` → opencode N-message/回合整形（纯逻辑，可测）
- `acp-connection.ts` — 子进程 + SDK stdio + 权限挂起回环 + 三阶段关闭 + per-agent 怪癖（`applyGeminiQuirks` env 注入、spawn cwd/PATH、`applyThoughtLevel` → session/set_config_option）
- `permission-label.ts` — 权限标签分层推断（claude 丢 kind 的补救：kind → shaper 查表 → rawInput 形状 → title → 中性 "tool"）
- `acp-manager.ts`（连接/会话注册 + clientSessionId 映射 + SSE 分发 + session/load 懒恢复）, `acp-server.ts`（Hono :4099 REST+SSE）, `agents-config.ts`（agents.json 读写）
- `config-paths.ts` — **sidecar config 目录 SSOT**：`resolveConfigDir`/`configFile` 镜像 Rust `global_config_dir()`（XDG_CONFIG_HOME 隔离）；agents.json / gemini-acp-settings.json（`acp-connection.ts`）/ sidecar-auth.json（`opencode-credentials.ts`）全经此解析（gotchas §8/§11）
- `session-store.ts` — W4b 会话历史持久化：event-fold reducer（与前端同构）+ 落盘 `~/.local/share/ultrawork/acp-sessions/`
- `packages/agent/acp-client/scripts/mock-acp-agent.ts`（确定性测试 agent）, `packages/agent/acp-client/scripts/spike-claude.ts`（真实 claude → desktop fixture）, `spike-hermes.ts` / `spike-codex.ts`（codex 经 `@agentclientprotocol/codex-acp` 桥；tool/escape/perm 三模式，ADR-060）

**Knowledge Sidecar（`packages/knowledge/sidecar/src/`）**
- `store.ts`（SQLite + FTS5 + 迁移）, `chunker.ts`（Parent-Child 分块）, `indexer.ts`（增量索引）, `retriever.ts`（BM25 + TF-IDF + RRF）
- `doc-parser.ts`（unpdf/mammoth/xlsx/jszip）, `watcher.ts`（fs.watch + debounce）, `mcp-bridge.ts`（knowledge_search/list_sources/save_note）
- `adapters/` — types.ts（KnowledgeAdapter 接口）, registry.ts, ima.ts, local-folder.ts

**构建 / 打包 / CI（跨平台 mac/win/linux，ADR-037）**
- `scripts/build-{opencode,gateway,knowledge,acp}.ts` — sidecar 编译（已支持全 target triple；产物 `<name>-<triple>[.exe]`，Tauri externalBin 自动解析；codesign/chmod 仅 darwin 守卫）
- `scripts/build-release.ts` — 发布：macOS 走签名/公证/lipo；**非 macOS 走「构建 sidecar + `tauri build`」分支**出平台安装包；开头显式跑 pack-builtin-skills（双保险）
- `scripts/verify-dmg-layout.ts` — 发布守卫：断言 DMG 安装窗口里 app 图标在 Applications 左边（解析 `.DS_Store` 的 Iloc 记录）；公证前跑；`--self-test` 版本跨平台、进 CI 合并门禁（gotchas §7）
- `scripts/pack-builtin-skills.ts` — **内置技能构建期打包**（松散树→`skills-builtin.zip`+外置 sentinel，按内容 hash 惰性；fflate 保 unix exec bit；产物在 `src-tauri/resources/builtin-skills/`，gitignore、`.gitkeep` 保 `generate_context!` 编译；beforeDevCommand/beforeBuildCommand 自动跑，ADR-041）；e2e 侧共享 helper `packages/client/desktop/e2e/builtin-zip-helper.ts`
- `scripts/setup.ts` — **跨平台一键 setup**（Bun API，替代只能 Unix 跑的 `setup.sh`）；`bun run setup`
- `.github/workflows/ci.yml` — **跨平台强制门禁**：push/PR 三平台矩阵跑 `turbo typecheck`+`turbo test`+`cargo test`（rust job 在 windows-latest 上首次真编 `#[cfg(windows)]` 分支）
- `.github/workflows/release.yml` — tag `v*` 触发三平台出安装包（dmg/msi/nsis/deb/rpm）+ 自动建 Release 页；**macOS 签名+公证已打通**（ADR-069：`Import Apple Developer ID certificate` 步骤把 `APPLE_CERTIFICATE` base64 .p12 导入一次性 keychain；6 个 `APPLE_*` secret；缺失则退回 unsigned）；guard job 校验 tag==tauri.conf 版本
- `packages/client/desktop/src-tauri/tauri.conf.json` — `bundle.targets:"all"`（Tauri 按平台产对应安装包）

## Key Documentation

- [docs/architecture-phase1.md](./docs/architecture-phase1.md) — Phase 1 architecture design
- [docs/api-reference.md](./docs/api-reference.md) — OpenCode API findings（端点权威源 / SSOT）
- [docs/conventions.md](./docs/conventions.md) — Development conventions & patterns（正向模式）
- [docs/gotchas.md](./docs/gotchas.md) — 踩坑清单（反向陷阱 + 上游非直觉契约，SSOT）
- [docs/quality-gates.md](./docs/quality-gates.md) — 改动合入前的完成定义 / 质量门禁
- [docs/decisions/](./docs/decisions/) — Architecture Decision Records (70 ADRs, 001–070)
- [docs/requirements.md](./docs/requirements.md) — Product requirements
- [docs/archive/progress-raw.md](./docs/archive/progress-raw.md) — Detailed development history
- [CHANGELOG.md](./CHANGELOG.md) — Version history
