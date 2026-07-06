# UltraWork 需求文档

> **本文职能（2026-07-03 重定义）**：产品定位 + 包状态摘要 + 功能需求清单与实现状态 + 复杂行为需求的验收判据。**不是**全量功能细节库——detail 在 ADR（决策）/ CHANGELOG（验证记录）/ discussions（方案），此处只放清单级条目 + 指针。
> **防再滞后机制**：① 收尾流程 Step 4（CLAUDE.md）在里程碑式变更时回填状态；② `scripts/check-docs.ts` 在本文落后最新 ADR 超 45 天时告警（CI docs job 同跑）。
> **验收判据约定**：普通 UI 需求一行描述即可；**状态机类/边界敏感行为**（超时、竞态、遮蔽/恢复、终态判定等）建议用 EARS 句式显式写出触发与响应——`While <前置状态>, When <触发>, the <系统> shall <响应>`（异常路径用 `If <触发>, then ... shall ...`）。例：*While 流式回合进行中且无工具在执行, When 30s 无内容帧, the idleGuard shall abort 请求并把回合落 error 终态（ADR-034）*。这类句式歧义小、AI 可直接转成测试断言；不强制、按需用。

## 产品定位

UltraWork（无影）是一款桌面 AI Agent 应用，基于 OpenCode Server 作为 sidecar 后端，提供智能对话、工具执行、文件操作等能力。

## 参考项目

- [OpenCode](https://github.com/anomalyco/opencode) — 核心依赖，作为 sidecar server 提供 agent 能力（REST API + SSE 事件流）
- [WorkAny](https://github.com/workany-ai/workany) — 交互设计参考
- 交互设计稿：`design/product/` 目录（HTML 原型 `prototype/` + 功能清单 + Figma 原型图）

## 技术栈

| 层级 | 技术 |
|------|------|
| Desktop Shell | Tauri 2 (Rust) |
| 前端框架 | React 19 |
| 构建工具 | Vite 7 |
| 样式 | Tailwind CSS 4 |
| UI 组件 | shadcn/ui (Radix + Tailwind) |
| 包管理 | Bun (monorepo + workspaces) |
| 构建编排 | Turborepo |
| 后端 | OpenCode Server (TypeScript/Bun，`bun build --compile` 编译为 sidecar binary) |
| 状态管理 | React Context |
| 路由 | react-router-dom v7 |
| 国际化 | 自研 i18n (I18nProvider + `t()`) |

## 架构

详见 `docs/architecture-phase1.md`。

Monorepo 结构：

> 包实现状态的 SSOT 是 `docs/architecture-phase1.md` 顶部状态表；下表只列**当前实际存在的包**（与 `packages/` 目录一一对应），远期规划包见文末「未实现功能」。

| 包 | 路径 | 状态 | 说明 |
|----|------|------|------|
| `@agent/api-client` | `packages/core/api-client` | ✅ 已实现 | OpenCode REST/SSE SDK |
| `@agent/server-manager` | `packages/core/server-manager` | ✅ 已实现 | Sidecar 进程管理 |
| `@agent/client-desktop` | `packages/client/desktop` | ✅ 已实现 | Tauri 桌面应用 |
| `@agent/connector` | `packages/core/connector` | ✅ 已实现 | 后端统一抽象层（OpenCode/ACP 双后端派发，ADR-030） |
| `@agent/orchestrator` | `packages/core/orchestrator` | ✅ 已实现 | 多 agent 编排（spawn/delegate/Pipeline/Fan-out，ADR-031） |
| `@agent/acp-client` | `packages/agent/acp-client` | ✅ 已实现 | ACP 外部 agent sidecar（:4099，ADR-027） |
| `@agent/knowledge-sidecar` | `packages/knowledge/sidecar` | ✅ 已实现 | 知识库 RAG sidecar（:4098，ADR-026） |
| `@agent/channel-gateway` | `packages/channel/gateway` | ✅ 已实现 | IM 集成网关（钉钉 Stream Mode，独立 sidecar 进程 :4097，配置持久化 `~/.ultrawork/channels.json`）|

## Phase 1 已实现功能 (Round 0 ~ Issue#18)

### 核心聊天

- [x] SSE 实时流式消息渲染
- [x] 结构化消息渲染（7 种 Part：Text、Reasoning、ToolCall、StepFinish、Patch、File、Image）
- [x] 执行状态显示（working/done/error/stopped）
- [x] 停止执行 + frozen message 保护
- [x] Permission Dock（权限授权）
- [x] Question Dock（agent 提问，单选/多选）
- [x] Slash Commands（/init、/review）
- [x] 乐观消息（新建会话即时显示用户消息）
- [x] 中文输入法 composing 处理

### 模型管理

- [x] 模型管理设置页 section（Provider 列表/添加/API Key 配置；取代旧 ModelDialog）
- [x] 自定义 Provider（清单外，OpenAI 兼容 / Anthropic，自带 Base URL+Key+模型；per-workspace，见 discussions/006）
- [x] ModelSelector（快速切换模型 Popover）
- [x] ModelProvider（全局模型状态 Context）
- [x] prompt_async model override（运行时模型切换）
- [x] Provider 列表 TTL 缓存（5 分钟）

### 会话管理

- [x] 会话列表（按日期分组：今天/昨天/更早）
- [x] 会话创建/删除
- [x] 会话真实活跃状态追踪（activeSessionIds）
- [x] SSE 全局化（SSEProvider app 级单连接）
- [x] SSE 心跳超时自动重连

### 工作区管理

- [x] WorkspaceSelector 选择页面
- [x] `x-opencode-directory` header 传递工作目录
- [x] Session 按目录隔离

### 右侧栏

- [x] Progress Panel（进度面板）
- [x] Artifacts Panel（产物面板，点击预览）
- [x] Workspace Panel（文件树 + Git 状态）
- [x] MCP Panel（MCP 服务器管理 + 连接/断开）
- [x] Skills Panel（按来源分组 + 点击填入 + 管理入口）
- [x] ArtifactPreview（50/50 split-screen 文件预览：代码/MD/图片/Diff）

### 设置

- [x] SettingsPopover 快捷菜单（主题/语言子菜单/帮助/技能/远程服务/关于）
- [x] Settings 完整页面（通用/模型/远程服务/技能管理/关于）
- [x] 主题切换（light/dark/system）
- [x] 语言切换（中/英）
- [x] About 页面（版本信息/官网链接）
- [x] 帮助文档（外部浏览器打开）

### 布局

- [x] 三栏布局：左侧栏(w-72/w-14 双态) + 主内容 + 右侧栏(w-80)
- [x] TopBar（导航/右侧栏切换）
- [x] 品牌设计（Logo/名称/渐变色）
- [x] Error Boundary + Toast 通知

### 基础设施

- [x] Tauri sidecar 自动启动 + Basic Auth
- [x] Vite 代理 15+ 路由到 localhost:4096
- [x] TypeScript 严格类型检查
- [x] 47 项单元测试
- [x] Tauri opener 插件（外部链接）
- [x] MCP 状态持久化（已从 localStorage 迁移到 opencode.json + 全局 `~/.config/ultrawork/opencode.json`）
- [x] vendor opencode.json patch + sidecar 重编译

### Channel Gateway (Issue#13-17)

- [x] 渠道(Channels)配置 — 钉钉企业内部机器人 (dingtalk-stream WebSocket Stream Mode)
- [x] 微信 Channel — ilink 协议 + QR 扫码登录 + 文本收发 + 语音 STT + 断开重连（ADR-018, Phase 1+2）
- [x] IM Channel Gateway — 独立 sidecar 进程 :4097 + Hono on Bun.serve + Bridge 会话桥接
- [x] Desktop Channels 设置页面 — ChannelsSection + use-channels hook
- [x] Sidecar 启动健壮性 — 端口冲突检测 + 残留清理
- [x] Gateway 配置持久化 — `~/.ultrawork/channels.json` + mutex + 重启自动恢复

### Browser MCP (Issue#15-18)

- [x] Browser MCP 双模式 — Playwright MCP 默认 + DevTools 可选
- [x] 内嵌 Node.js v22 按需下载（`~/.ultrawork/node/`）
- [x] MCP 持久化迁移 — localStorage → opencode.json + 全局 `~/.config/ultrawork/opencode.json`
- [x] 浏览器 MCP 跨工作区自动恢复

### 其他 (Issue#16-18)

- [x] 品牌 Logo 设计 + 全平台图标 + in-app Logo 组件
- [x] 隐藏内置开发者命令（/init, /review）

### 知识库能力 (ADR-026)

**Phase 1** ✅ (2026-05-16)
- [x] Knowledge Sidecar (:4098) — 独立 sidecar 进程，bun build --compile
- [x] 本地文件夹 RAG — md/txt/代码 50+ 格式，TF-IDF embedding，FTS5 BM25 全文检索
- [x] 混合检索 — BM25 + 向量语义 + RRF 融合排序 (k=60)
- [x] MCP 对接 AI — knowledge_search + knowledge_list_sources，AI 自主调用
- [x] Settings Knowledge tab — 添加/移除/重建索引

**Phase 2** ✅ (2026-05-20)
- [x] Parent-Child 双层分块 — 父块 ~60 行（LLM 上下文）+ 子块 ~12 行（精确匹配）
- [x] 二进制文档解析 — PDF/docx/xlsx/pptx 文本提取（纯 TS: unpdf/mammoth/xlsx/jszip，零外部依赖）
- [x] SSE 索引进度 — 异步索引 + EventSource 实时进度条 + 当前文件名
- [x] 文件监听 — fs.watch recursive + 双层 debounce → 自动增量重索引
- [x] Schema 迁移系统 — _migrations 版本管理 + Phase 1 数据自动重索引

**Phase 3** ✅ (2026-05-20)
- [x] 第三方平台 Adapter — KnowledgeAdapter 接口 + IMA 适配器（testConnection + search + listBases）
- [x] 凭证配置向导 — AddSourceDialog 两步流程（类型选择 → IMA 凭证 → 测试连接 → 选知识库 → 保存）
- [x] 统一 ID-based API — knowledge_sources 表 + Schema Migration v3 + 向后兼容旧 folderPath 路由
- [x] 跨源搜索 — MCP knowledge_search 同时搜索本地文件夹 + IMA，合并排序返回
- [x] Filter Chips — 知识源按类型筛选（全部/本地文件夹/第三方平台/自定义 API）
- [x] 凭证安全 — API 响应过滤敏感字段 + DB 目录 0700 权限

**Phase 4**（规划中）
- [ ] IMA Notes API 集成 — `search_note_book` 正文全文搜索 + `get_doc_content` 全文读取，解决 Wiki API 只返回片段的限制
- [ ] IMA 知识源模块区分 — 配置中选择"知识库"或"笔记"（复用同一凭证）
- [ ] 检索 top-K 提高到 8-10（无 reranker，需更多候选保证召回率）
- [ ] IMA 笔记写入 — AI 可通过 `import_doc`/`append_doc` 将分析结果保存回 IMA

### 多 Agent 后端 / Agent OS（ADR-027 + agent-os-target-architecture.md）

**阶段0-1 档1：会话级多 agent** ✅ (2026-06-10，首批 claude + opencode)
- [x] ACP Client Sidecar (:4099) — spawn 外部 agent 子进程（ACP stdio JSON-RPC，SDK 0.25）+ agents.json 注册表
- [x] Turn 整形 — ACP `session/update` → opencode SSE 形状（复用 ADR-029 渲染器，前端零渲染改动）
- [x] 会话级 agent 绑定 — 输入区 AgentSelector + localStorage 持久化（一会话一 agent）
- [x] 权限回环 — `request_permission` → permission-dock（once/always/reject），超时/取消/退出默认 deny
- [x] 知识库 MCP opt-in 透传（per-agent 开关，默认关）
- [x] 进程稳定性 — 三阶段优雅关闭 + claude 怪癖超时 + 进程退出恢复
- [x] Settings「外部 Agent」管理（连接/断开/增删改）
- [x] 构建/打包链路 — `build:acp` hash 增量 + 防陈旧 + setup.sh + Universal DMG
- [x] ACP 会话历史持久化（W4b）— sidecar 落盘整形消息 + `session/load` 懒恢复 + replay 抑制（重启后历史可见、上下文连续）✅ 2026-06-11
- [x] 档1 入口收紧 — Home 唯一入口（出生即绑定）+ AgentSelector 会话开始后锁定 + claude thinking 默认开 ✅ 2026-06-11

**阶段1 收尾项（规划中）**
- [x] 权限 kind 映射精修 — `permission-label.ts` 分层推断（0.44 起上游已带 kind，推断层留作兜底）✅ 2026-06-11
- [x] token/cost 页脚 — claude adapter 升级 `@agentclientprotocol/claude-agent-acp` 0.44（发 per-turn usage+cost）+ agents.json 自动迁移 ✅ 2026-06-11
- [x] gemini/qoder 二期接入（branch A 零 bespoke）+ 预置模板库 UX + thoughtLevel 思考力度开关 — per-agent 怪癖固化 gotchas §8（gemini node-pty 挂死/folder trust/relaunch 自动注入修复；qoder 权限内部超时/execute cwd）✅ 2026-06-11
- [x] hermes 接入（NousResearch hermes-agent，branch A 零 bespoke）— 模板 chip `hermes acp --accept-hooks`，协议 v1 协商 + 整形开箱即对，无 sidecar/shaper 改动；gotchas §8 ✅ 2026-06-13
- [ ] 能力条件 UI（image gating）
- [x] 阶段2 @agent/connector（ADR-030）/ 阶段3 编排（ADR-031）— connector 统一层 + orchestrator（spawn/delegate/Pipeline/Fan-out）+ Team UX 主聊天流（017/018）+ 019 流水线 surface 收纳。**已整体合 main**（2026-06-13，merge `232c8fa`）✅

### 2026-06 中旬 ~ 07 月主线 ✅（摘要；detail 是各 ADR + CHANGELOG，此处不复制）

- [x] 内置技能体系 — 5 技能打包+依赖检测（ADR-032）→ ppt-master + curated 自助更新 + 确定性遮蔽（ADR-040）→ zip 分发+首启解压（ADR-041）✅ 2026-06-14 ~ 07-03
- [x] 产物识别改文件系统真相 + PDF 内嵌预览（ADR-033）✅ 2026-06-16
- [x] LLM 流式 idle 看门狗，根治静默挂死（ADR-034）✅ 2026-06-24
- [x] 会话切换一致性 — 切回不丢流式 + 多 Team 委派按发起会话过滤（ADR-035）✅ 2026-06-25
- [x] 渐进式工具披露 — 多 MCP 下工具 schema token 膨胀治理（ADR-036）✅ 2026-06-26
- [x] 跨平台兼容 macOS/Windows/Linux + CI 三平台门禁（ADR-037）✅ 2026-06-27
- [x] 右侧栏任务规划进度面板（ADR-038）✅ 2026-06-29
- [x] Provider 配置全局化 + opencode 软刷新（ADR-039）✅ 2026-06-30
- [x] 知识库 MCP 对 IMA/远程-only 源自动注册修复 ✅ 2026-06-28
- [x] UI/UX 打磨批次 — 设置页折叠+返回来源页、折叠侧栏拖拽把手、「MCP 连接器」更名、Home 工作区路径指示行等（见 CHANGELOG）✅ 2026-07-01 ~ 07-03
- [x] BYOK 联网搜索 — websearch 多 provider 复活（Tavily/阿里云 IQS/Exa opt-in）+ 设置页「工具」分区 + qwen `enable_search`（ADR-042）✅ 2026-07-04（真机真 key 验收通过）
- [x] 办公 CLI 连接器 Phase 1：飞书 lark-cli — 「连接器」分区（MCP/办公 CLI 两组）+ 安装/托管页配置/`--recommend` 设备流授权 + feishu-assistant 薄路由技能（ADR-043）✅ 2026-07-06（真机全流程验收；Phase 2 钉钉 / Phase 3 企微待做）

**后续规划**
- [ ] ONNX 神经 Embedding 升级（bun compile 兼容性待解决，当前 TF-IDF 质量可接受）
- [x] MarkItDown → 纯 TS 文档解析（消除 Python 依赖）✅ 2026-05-20
- [ ] Token-based 分块替代行数分块（parent 512-1024 tokens，等 ONNX 时一起升级）
- [ ] 轻量 Reranker（cross-encoder 精排提升检索精度）
- [ ] @知识库名 显式触发 + 在线文档爬取
- [ ] Sidebar Knowledge Panel + Chat/Strict 双模式

## Phase 1 未实现功能（规划中）

- [ ] 引导流程（首次安装用户名/工作场景/工作目录预设）
- [ ] 文件/图片/音频上传
- [ ] 输入框推荐提示语轮播
- [ ] Plugins 面板
- [ ] 搜索（会话搜索）
- [ ] 定时任务（已隐藏，依赖 Proactive Cron 服务）
- [ ] 定制面板（Personal 个性化/记忆/Agent.md）
- [ ] 收藏/重命名功能
- [ ] Settings 隐私/能力配置页
- [ ] Settings 工作目录管理页
- [ ] Channel Gateway: Feishu/Slack adapter
- [ ] Channel Gateway: Interactive card（权限交互卡片）
- [ ] Channel Gateway: Message adaptation（平台特定格式化）
- [ ] Agent Workspace (~/.ultrawork/ 目录，IDENTITY/SOUL/MEMORY；曾规划 `@agent/workspace` 包)
- [ ] Proactive Services（Heartbeat/Cron；曾规划 `@agent/proactive-*` 包）
- [ ] 共享组件库 `@agent/ui`（当前组件在 desktop 内）
- [ ] 通知分发 `@agent/notifier`
- [ ] System Tray / 后台常驻
- [ ] OS Keychain 凭证存储

## 钉钉 Channel 实现记录 (Issue#13) ✅ 已完成

### 目标

实现钉钉企业内部机器人接入，用户可通过钉钉单聊/群聊与 OpenCode Agent 交互。**已实现。**

### 技术方案

| 项目 | 选型 |
|------|------|
| SDK | `dingtalk-stream` v2.1.4 (WebSocket Stream Mode, 无需公网 IP) |
| Gateway 进程 | 独立 sidecar (bun build --compile, :4097) |
| HTTP 框架 | Hono (轻量 ~14KB) |
| 会话桥接 | Bridge (chatId→sessionId 映射 + Sequential Queue + SSE 订阅) |
| 生命周期 | 与桌面端同生同死 (Tauri 托管)，后续 System Tray 演进为 7×24 |

### 实施步骤 (7 步)

1. **Step 0.5**: Sidecar 启动健壮性 (端口检测 + 残留清理)
2. **Step 1**: `@agent/channel-gateway` 包骨架
3. **Step 2**: 核心类型 + ChannelManager
4. **Step 3**: Bridge 会话桥接层
5. **Step 4**: DingTalk Adapter (dingtalk-stream SDK)
6. **Step 5**: Gateway Server + Sidecar 集成
7. **Step 6**: Desktop UI Channels 页面 (Settings + use-channels hook)

### 参考项目

- [openwork/opencode-router](https://github.com/different-ai/openwork/tree/dev/packages/opencode-router) — Bridge 架构参考
- [nanobot/channels](https://github.com/HKUDS/nanobot/tree/main/nanobot/channels) — DingTalk adapter 参考

详见 `.claude/.../memory/dingtalk-channel-plan.md`。

## 开发进度

详见 `CHANGELOG.md`（当前）与 `docs/archive/progress-raw.md`（2026-06-04 前的原始进度流水）。
