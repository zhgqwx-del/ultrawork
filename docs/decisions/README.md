# Architecture Decision Records (ADR)

本目录记录 Ultrawork 项目中的关键架构决策。每个 ADR 描述一个重要的技术选择、其背景、考虑过的替代方案和后果。

## 格式

每个 ADR 遵循统一模板：

```markdown
# ADR-NNN: 标题

**状态**: Accepted | Superseded | Deprecated
**日期**: YYYY-MM-DD
**关联轮次**: Round N / Phase N

## 背景
为什么需要做这个决策？

## 决策
选择了什么方案？

## 考虑过的替代方案
还考虑过哪些方案？为什么没选？

## 后果
这个决策带来了哪些影响（正面和负面）？
```

## 索引

| # | 标题 | 轮次 | 状态 |
|---|------|------|------|
| [001](./001-tauri-react.md) | Tauri 2 + React 19 技术选型 | Phase 1 | Accepted |
| [002](./002-opencode-sidecar.md) | OpenCode Headless Sidecar | Phase 1 | Accepted |
| [003](./003-shadcn-tailwind.md) | shadcn/ui + Tailwind CSS 4 | Phase 2 | Accepted |
| [004](./004-structured-message-parts.md) | 结构化消息 7 Part Types | Round 2 | Accepted |
| [005](./005-permission-question-dock.md) | Permission & Question Dock | Round 3 | Accepted |
| [006](./006-model-management.md) | 模型管理独立 Dialog | Round 4 | Accepted |
| [007](./007-workspace-isolation.md) | 工作区目录隔离 | Round 5 | Accepted |
| [008](./008-sse-global-polling-fallback.md) | SSE 全局化 + 轮询兜底 | Round 5 | Accepted |
| [009](./009-artifact-preview-split.md) | 产物预览 50/50 分屏 | Round 7 | Accepted |
| [010](./010-shared-hook-pattern.md) | 共享 Hook 提取模式 | Round 10 | Accepted |
| [011](./011-mcp-localstorage-persistence.md) | MCP 状态 localStorage 持久化 | Round 11 | Superseded (→ opencode.json, Issue#18) |
| [012](./012-optimistic-message-active-tracking.md) | 乐观消息 + 活跃状态追踪 | Round 12 | Accepted |
| [013](./013-channel-gateway-sidecar.md) | Channel Gateway 独立 Sidecar | Round 13 | Accepted (✅ 已实现) |
| [014](./014-dingtalk-stream-sdk.md) | DingTalk Stream SDK 选型 | Round 13 | Accepted (✅ 已实现) |
| [015](./015-dark-mode-codemirror.md) | 深色模式 + CodeMirror 6 | Round 15 | Accepted |
| [016](./016-browser-mcp-node-detection.md) | Browser MCP — 检测 Node.js + 按需安装 | 2026-03-15 | Accepted |
| [017](./017-browser-mcp-dual-mode.md) | Browser MCP 双模式 — Playwright 默认 + DevTools 可选 | 2026-03-17 | Accepted |
| [018](./018-wechat-channel-ilink.md) | 微信 Channel — ilink 协议接入 | 2026-03-24 | Accepted (Phase 1+2 实现) |
| [019](./019-knowledge-base-integration.md) | 知识库集成 — IMA 优先 + MCP 架构 | 2026-03-31 | Withdrawn |
| [020](./020-config-isolation.md) | Ultrawork 与 OpenCode 配置隔离 | 2026-04-20 | Accepted (✅ 已实现) |
| [021](./021-long-session-performance.md) | 长对话性能优化 — 渐进式渲染与分页加载 | 2026-04-23 | Accepted (✅ 已实现) |
| [022](./022-model-switch-side-effects.md) | 运行时模型切换的副作用分析与修复 | 2026-04-24 | Accepted |
| [023](./023-titlebar-overlay.md) | macOS 标题栏 Overlay 模式 | 2026-05-08 | Accepted |
| [024](./024-workspace-path-display.md) | 工作目录路径展示优化 | 2026-05-12 | Accepted (✅ 已实现) |
| [025](./025-window-layout-symmetry.md) | 窗口布局对称性修复与平台感知适配 | 2026-05-12 | Accepted |
| [026](./026-knowledge-base-architecture.md) | 知识库能力架构 — 本地 RAG + 第三方平台 + 自定义 API | 2026-05-13 | Accepted (Phase 1-3 + 4a + 4c 实现) |
| [028](./028-release-readiness-hardening.md) | 发布前 readiness 硬化 — sidecar 副本 / 凭证随机化 / 安全收紧 / MCP 启动性能 | 2026-05-28 | Accepted |
| [027](./027-acp-multi-agent-backend.md) | ACP 多 Agent 后端支持 — 经 Agent Client Protocol 统一调度多 agent | 2026-05-25 / 2026-06-08 / 2026-06-10 | Accepted · **阶段0-1 已实现**（`@agent/acp-client` :4099，claude 达标；历史持久化/gemini/qoder 二期） |
| [029](./029-execution-flow-turn-grouping.md) | 主对话「执行流程」收纳 — 回合级消息分组与过程/答案分层 | 2026-06-06 | Accepted (✅ 已实现) |
| [030](./030-agent-connector-control-layer.md) | @agent/connector — 后端无关的控制 + 事件统一层（可插拔 backend：OpenCode REST / ACP / 其它，D-8 分类法） | 2026-06-08 · 06-09 修订 | Accepted（架构决策）· 实现规划中（阶段2，依赖 ADR-027） |
| [031](./031-multi-agent-orchestration.md) | 多 Agent 编排（档2 delegate）— orchestrator + spawn/steer 原语 + 编排模式 | 2026-06-08 | Accepted（架构决策）· 实现规划中（阶段3，依赖 ADR-027/030） |
| [032](./032-builtin-skills.md) | 内置技能打包与分发 — Apache-2.0/自写技能集 + 方案 C（拷贝到 configDir/builtin + sentinel）+ 依赖检测不打包 + 设置页三区 | 2026-06-14 | Accepted · 已实现（端到端为手动验证项） |
| [033](./033-artifact-capture-and-pdf-preview.md) | 产物识别改用文件系统真相（mtime 扫描，捕获 bash 副作用）+ 产物/工作文件分类 + PDF 内嵌预览（pdf.js + scope-free `read_file_bytes`） | 2026-06-16 | Accepted (✅ 已实现) |
| [034](./034-llm-stream-idle-guard.md) | LLM 流式 idle 看门狗（工具感知两级超时，opencode `llm.ts` + ACP `prompt()` 对称）— 根治静默挂死导致的会话死锁 | 2026-06-24 | Accepted (✅ 已实现，两侧 headless 验证) |
| [035](./035-delegate-owner-session-scoping.md) | 委派 owner-session 归属（`DelegateRecord.ownerSessionId`，ACP per-session env / opencode `_meta` vendor patch 双通道）— DelegateDock 按发起会话精确过滤，根治同 workspace 多 Team 委派串显 | 2026-06-25 | Accepted (✅ 已实现，运行时+源码双验证) |
| [036](./036-progressive-tool-disclosure.md) | 渐进式工具披露（搜索-提升为原生，对齐 Anthropic Tool Search）— 折叠低频工具→name-only 名录+`tool_search`、按需提升原生；接缝钩子 `experimental.chat.tools.transform` + internal plugin；EAGER 委派硬约束；默认 ON config flag。根治多 MCP 下工具 schema token 膨胀（hi 19k→11.7k） | 2026-06-26 | Accepted (✅ 已实现，单 agent+team 真机验收) |
| [037](./037-cross-platform-compat.md) | 跨平台兼容（mac/win/linux）作为持续开发约束 — 三类修复（路径/HOME/分隔符机械替换 · 进程/信号/开文件运行时平台分支 · 打包 glue）+ `path-utils` renderer 工具 + `PATH_LIST_SEP`/`pids_on_port` Rust helper + 跨平台 `setup.ts` + `bundle.targets:"all"` + CI 三平台矩阵（typecheck/test/`cargo test`）作强制门禁。Rust 优先运行时 `cfg!()` 分支（本机可编译验证全分支） | 2026-06-27 | Accepted (✅ 代码+CI 已落地，mac 全绿；win/linux 由 CI 验证) |
| [038](./038-plan-progress-panel.md) | 右侧栏「任务规划进度」面板 — 现状=工具调用流水挂规划名（`ProgressPanel`/`extractToolSteps`），改造为方案 B（规划主区 + 工具流水降级「执行活动」次级区）。plan 作**会话级状态**（非 message part）在 connector 归一为统一 `plan.updated`+`getPlan`：OpenCode 映射原生 `todo.updated`/REST `/session/{id}/todo`（数据现成，`/event` 全量转发已在 SSE 线上）；ACP 改 `turn-shaper.onPlan` 停止压成 reasoning 文本、改发独立 plan 事件 + 新增 `GET /acp/session/:id/plan` 快照（两后端对称 live+REST）。整表语义防漏步/幽灵步；切回 `getPlan` 水合（同 022）；忘标完成→复用 022 `sessionBusy` 降级「回合已结束」；Team 仅显当前/主 agent 不聚合子会话 | 2026-06-29 | Accepted (✅ 已实现) |
| [039](./039-global-provider-config.md) | 自定义 Provider / 模型配置全局化 — provider 定义/baseURL/删除从每工作区 `PATCH /config` 改为复用 opencode **原生全局端点 `PATCH /global/config`**（`Config.updateGlobal`：写全局 `~/.config/ultrawork/opencode.json` + `invalidate` 即时生效、不需工作区），与已全局的 MCP/skills/key 心智补齐；零 vendor、零 Rust、零跨平台路径代码。**修订**：初稿设想的"Rust 全局写入器"被否——外部进程写文件运行时不生效（global config 无限缓存 + 无 watcher + dispose 不刷全局）。删除仍走 `disabled_providers`+`whitelist`（放弃物理删除红利换零 Rust）；model 选择保留会话/工作区粘滞；外部 ACP agent 不受益（架构边界）。存量迁移：项目配置优先级高于全局，老工作区残留会覆盖全局，第一步先文档化。**关联但范围外**：knowledge `kb.db` / gateway `channels.json`·`session-map.json` 硬编码 `~/.ultrawork` 不认 XDG（跨平台安全、仅命名不一致，另列任务） | 2026-06-30 | Accepted（✅ 已实现） |
| [040](./040-builtin-ppt-master-skill.md) | 内置 ppt-master PPT 生成技能 — hugohe3/ppt-master（35.9k★/MIT）零改造打包为第 6 个内置技能，pin v2.12.0。路线 A 进安装包（用户网络不可控否决 curated-only；裁 43M 说明图后 gzip 实测 6.6MB）；fetch 脚本增强（sparse clone/LICENSE 补拷/按名过滤/post-patch）；依赖检测升级 python 内探针（`python3.10+` 版本门 + `python-pptx`，async command/5s 超时/CLT shim 守卫/Windows 回退四防御）+「引导安装」handoff（引导词写死收敛标准）；连带 opencode-server 注入 rich PATH（探针与技能运行时同源）+ builtin 落地 staging+rename 原子交换。八项确认刻意不改 question dock。阶段 2（已落地）= curated 自助更新（`method:"git"` 强制 sparse）+ Rust 文件层确定性遮蔽 `reconcile_builtin_shadowing`（用户版永久胜出/移除即恢复；整块镜像 opencode 注册谓词 fail-open + `BUILTIN_SKILLS_LOCK` + `changed` 前端协调契约）+ 遮蔽态 UI/恢复入口 | 2026-07-02 | Accepted (✅ 阶段 1+2 已实现) |
| [041](./041-builtin-skills-zip-distribution.md) | 内置技能 zip 分发 + 首启解压 — bundle 从 1.2 万文件松散树改为构建期单 zip（`pack-builtin-skills.ts` 按内容 hash 惰性，beforeDev/beforeBuild/release 自动跑；产物 gitignore + `.gitkeep` 保 `generate_context!` 编译）。app Resources 53MB/12k 文件 → 10MB/4 文件（mac 签名公证/CI 打包提速，MSI 复活前提成立）。sentinel 外置 + zip 内不含 + 解压后写入（不变式强化为「sentinel 可见⇔整树完整」）；Rust zip crate 直读 central directory 枚举（不引 manifest 防双解析器漂移），遮蔽 restore 改按前缀选择性解压；篡改即拒多重设防（enclosed_name 消毒不够→显式拒绝 + clear_staging 防 symlink 穿透 + pack 期 fail-fast）；hash 算法喂相对路径+`\0`（两脚本同步）。MSI 刻意不加回 targets | 2026-07-03 | Accepted (✅ 已实现) |
| [042](./042-byok-websearch.md) | BYOK 联网搜索 — vendor patch 把名存实亡的原生 `websearch`（registry 门控仅官方托管 provider + disclosure 折叠双层废掉）改造为多 provider BYOK 工具：Tavily / 阿里云 IQS（REST+Bearer，key 借道 auth.json `search-*` id 现读零缓存、`mergeProvider` 早退不产幽灵 provider）+ Exa 显式 opt-in；门控改「enabled≠false 且已配置即注册」（可用性检查 catch 降级不注册——Effect defect 会杀回合）、websearch 移 disclosure EAGER、`GET /global/auth/:id/status` 只读存在性端点；设置页「工具」分区（测试连接走 Rust curl 防 CORS、test-before-save key 不回渲染层、IQS≠DashScope key+5 分钟生效提示）；qwen `enable_search` 零 vendor 双挂点（创建表单+模型行 toggle，DashScope-like 启发式；连带修上游 config 合并丢 `interleaved`/`experimentalOver200K` 两缺陷）。刻意：无失败 failover（计费可预测）、search_info 来源不展示（AI SDK 丢弃）、Team 外部 agent 不覆盖 | 2026-07-04 | Accepted (✅ 已实现，真机真 key 验收通过) |
| [043](./043-office-cli-connectors.md) | 办公 CLI 连接器 — CLI-first 集成范式（Phase 1 飞书 lark-cli）：设置页「连接器」分区（原「MCP 连接器」更名，内分 MCP/办公 CLI 两组）管 检测/安装/鉴权/健康，agent 经 bash 直调，**刻意不是 MCP**（保留 dry-run/schema 自省/`--jq`、零工具表膨胀、凭证 CLI 自管钥匙串）；安装=Rust 直下 Go 二进制（pin+sha256+GitHub→npmmirror 双源，数据驱动 `CliInstallSpec`）；`~/.ultrawork/office-cli/bin` 领跑 rich_path（pin 版压过用户旧装）；鉴权=托管页 config init（免手建 App ID）+ OAuth 设备流 **`--recommend`**（`--domain all` 实测触发开通审核流）；技能=薄路由 feishu-assistant（教 agent 读 CLI 内嵌 27 官方文档，零转译零漂移）+「scope 不足≠未授权」增量授权路由。六个上游真机契约坑 SSOT 在 gotchas §14 | 2026-07-06 | Accepted (✅ Phase 1 已实现+真机验收；Phase 2 钉钉/Phase 3 企微待做) |

> ADR-027 的探索过程见 [discussions/013](../discussions/013-agent-os-acp-multi-backend.md)（架构可行性）与 [discussions/014](../discussions/014-stage1-acp-normalization-plan.md)（阶段1 实现方案）。阶段0-1 已按 B2「参考重写」在 `feat/agent-os-phase0` 分支落地（旧 `feat/acp-support` MVP 弃用）；实测坑点固化在 [gotchas §8](../gotchas.md)。

## 新增 ADR

1. 复制模板到 `NNN-short-name.md`
2. 填写各段落
3. 更新本 README 索引表
