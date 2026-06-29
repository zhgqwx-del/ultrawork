# Discussions

技术讨论记录目录。记录尚未进入执行阶段的架构讨论、方案评估和技术探索。

> 与 `decisions/` (ADR) 的区别：ADR 记录已确定的技术决策；discussions 记录探索阶段的讨论，可能演变为 ADR，也可能被否决。

**状态语义**（影响可信度，AI/读者据此判断该不该信赖）：
- **调研记录**：对上游/现状的**事实性调研**（如 OpenCode 内置工具、Permission 机制、Tauri 现状）。结论可作为**权威参考**信赖，不是"待定提案"。
- **讨论中**：尚未定论的**方案提案/评估**，可能被采纳或否决，不应当作既定事实引用。

## Index

| 文件 | 主题 | 日期 | 状态 |
|------|------|------|------|
| [001-mobile-relay.md](./001-mobile-relay.md) | 移动端与桌面端通信 — Relay Server 方案 | 2026-03-18 | 讨论中 |
| [002-commercialization.md](./002-commercialization.md) | 商业化策略 — 分发渠道 / 定价模式 / 待补功能评估 | 2026-03-22 | 讨论中 |
| [003-sidecar-sharing.md](./003-sidecar-sharing.md) | OpenCode Sidecar 能力共享 — 多进程复用方案 | 2026-05-13 | 讨论中 |
| [004-opencode-multi-agent.md](./004-opencode-multi-agent.md) | OpenCode 多 Agent 机制调研 — 默认/自定义/子 Agent 委派 | 2026-06-03 | 调研记录 |
| [005-permission-question-dock.md](./005-permission-question-dock.md) | Permission Dock 与 Question Dock 机制调研 — 挂起式权限/提问端到端实现 | 2026-06-04 | 调研记录 |
| [006-custom-llm-provider.md](./006-custom-llm-provider.md) | 自定义 LLM Provider 机制调研 — 兼容 OpenAI/Anthropic 协议的自带 Key + Base URL 接入 | 2026-06-04 | 调研记录 |
| [007-opencode-builtin-tools.md](./007-opencode-builtin-tools.md) | OpenCode 内置工具全景调研 — 功能/使用场景/实现路径/启用条件 | 2026-06-04 | 调研记录 |
| [008-opencode-builtin-agents-orchestration.md](./008-opencode-builtin-agents-orchestration.md) | OpenCode 内置 Agent 全景、相互调用机制与 runLoop 引擎 — 谁能调用谁/谁来调度/怎么驱动 | 2026-06-04 | 调研记录 |
| [009-tauri-vs-electron.md](./009-tauri-vs-electron.md) | 桌面端框架调研 — Tauri 现状、Electron 对比、能力边界与迁移代价评估 | 2026-06-04 | 调研记录 |
| [010-ai-dev-doc-quality.md](./010-ai-dev-doc-quality.md) | AI 驱动开发的文档质量保障体系 — 现状诊断与优化方案 | 2026-06-06 | 已落地 |
| [011-architecture-comparison.md](./011-architecture-comparison.md) | Ultrawork 架构横向对标 — openclaw / hermes-agent / opencode desktop（多维对比 + 优劣 + 建议） | 2026-06-08 | 调研记录 + 讨论中 |
| [012-p1-execution-plan.md](./012-p1-execution-plan.md) | P1 可执行方案 — IM 流式重构 / 持久记忆注入 / 多 Agent UI 暴露（MVP+Phase2 拆解） | 2026-06-08 | 讨论中 |
| [013-agent-os-acp-multi-backend.md](./013-agent-os-acp-multi-backend.md) | Ultrawork 作为统一交互层 / Agent OS — 经 ACP 调度多 agent 后端（opencode/claude code/qoder…）可行性与路径 | 2026-06-08 | 讨论中 |
| [014-stage1-acp-normalization-plan.md](./014-stage1-acp-normalization-plan.md) | 阶段1 可执行方案 — ACP 单 agent 异构归一化（事件桥/权限/能力/进程，含 re-baseline 与映射对照表） | 2026-06-08 | 已正式化为 ADR-027 实现章节 |
| [015-backend-taxonomy-non-acp.md](./015-backend-taxonomy-non-acp.md) | Backend 接入分类法 —「支持 ACP 非二元」与非-ACP/HTTP 后端（openclaw 薄桥 vs hermes 原生，源级实测 + 传输族×adapter 两轴 + 选型决策树） | 2026-06-09 | 调研记录 + 讨论中 |
| [016-aionui-multi-agent-competitor.md](./016-aionui-multi-agent-competitor.md) | AionUi 多 agent 调研 — 直接竞品（Electron 多-agent 桌面，20+ agent + Team Mode 编排）+ 档1/档2 实现参考 + D-8/ADR-031 现网验证（NON_ACP_BACKENDS 佐证） | 2026-06-10 | 调研记录 + 讨论中 |
| [017-team-page-agent-driven-orchestration.md](./017-team-page-agent-driven-orchestration.md) | Team 页 — agent 驱动编排的独立 surface（Leader 会话 + 委派默认化 + 普通会话物理隔离；阶段3 第三批形态提案，替代「编排模式」开关） | 2026-06-12 | ✅ 已落地（阶段3 第三批） |
| [018-unified-orchestration-ux.md](./018-unified-orchestration-ux.md) | 编排 UX 统一与视觉升级 — 模式=任务出生属性（Home 统一入口 + Team 会话进侧栏 + Session 页合流；视觉参考 AionUi，A 拍板后 B 跟进） | 2026-06-12 | ✅ 已实施（GUI 走查 10/10） |
| [019-pipeline-surface-form.md](./019-pipeline-surface-form.md) | 流水线 UI 收纳与形态 — 编排 surface 的「另一半」（伞名「自动化」+页内「流水线·Fan-out」/ footer 精简：去渠道+WiFi、连接状态迁 AgentSelector chip 按所选后端着色 / agent-avatar 视觉对齐 / 页内自我说明；功能零改动，承接 018 Q2 + 用户 footer 反馈） | 2026-06-13 | ✅ 已拍板待开工 |
| [020-vendor-bump-perf-regression.md](./020-vendor-bump-perf-regression.md) | vendor/opencode v1.15.13 性能回退分析 — 基于 v1.15.13 源码独立核验 fork 项目分析报告（坐实 health/snapshot 两主诉 + 修正 4 条夸大 + 新发现 provider/transform 正则等 3 处）+ 9 类系统性解决策略 + P0/P1/P2 ROI 路线图；本项目 bump 追赶社区前的雷区清单与解法手册，与 vendor-opencode-bump-survey 配套 | 2026-06-16 | 调研记录 + 讨论中 |
| [021-bun-avx2-baseline-sidecar.md](./021-bun-avx2-baseline-sidecar.md) | Bun 无 AVX2 CPU 崩溃 与 sidecar baseline 变体方案 — oven-sh/bun#30613（≥1.3.8 modern 变体在缺 AVX2 的 x64 上启动即崩）核验对本项目成立（构建链路只产 modern 从不产 baseline）+ 为何 `bun --compile` 把运行时打进二进制 + 三候选方案（全员 baseline / 双变体 CPU 探测 / 单独渠道）+ `--baseline` 性能/体积/构建/Tauri externalBin 负面作用清单 + 实施步骤草案 | 2026-06-24 | 调研记录 + 讨论中 |
| [022-session-switch-back-false-completion.md](./022-session-switch-back-false-completion.md) | 会话切走再切回正在运行的回合被误渲染成"已完成" — 根因（`sessionActive` 是本地 state，切换重挂清零且不从后端真相水合 → `isTurnStreaming` 兜底门控失效）多角度交叉确认（同时打坏停止按钮/权限轮询/产物扫描）+ 关键架构不对称（delegate run-state 服务端可快照查询、单会话忙碌态没有：opencode 只流 session.status、ACP 啥也没有）+ 方案 B(全局 session.status 真相)/D(ACP sidecar running 端点) 完备性评估（单 agent vs Team 同构，Leader 后端决定走 B 还是 B+D，delegate 状态充分非必要的交叉校验） | 2026-06-24 | 调研记录 + 讨论中 |
| [024-plan-progress-vs-tool-call-log.md](./024-plan-progress-vs-tool-call-log.md) | 右侧栏「计划执行进度」：工具调用日志 vs 任务规划步骤 — 现状=tool-call 流水挂了规划的名（`ProgressPanel`/`extractToolSteps` 平铺所有 assistant tool parts）；主流（Claude Code TodoWrite 整表替换→Task tools 增量 / Cursor Plan Mode / Codex / Cline）都做任务规划清单非工具流水；上游盘点=OpenCode v1.3.13 已内置完整 todo 子系统（`todowrite` 工具 + SQLite 按 session 持久化 + `todo.updated` SSE + `GET /session/{id}/todo` + `metadata.todos` 冗余 + EAGER 永不折叠）但前端零消费；Q1 推荐方案 B（规划为主 + 工具流水降级为活动兜底简单任务，A 纯替换/C 嵌套活动为备选）；Q2 完整性&对齐靠「后端真相+整表语义」（REST 水合解决切回丢失〔同 022〕+ SSE 订阅 + metadata 兜底=三路一真相；整表替换天然防漏步/幽灵步；模型忘标完成→回合结束判定降级展示不捏造）；已拍板：Q1=方案 B（规划主区+工具流水降级活动区）· Q2=连带 ACP plan 归一（ACP 现把 plan 在 `turn-shaper.onPlan` 压成 reasoning 文本丢了结构，需改回结构化；ACP 无 REST→靠历史 plan part 水合；connector 两后端归一为统一 `plan.updated`+`getPlan`）· Q3=Team 仅显当前/主 agent 会话规划不聚合子会话；下一步正式化 ADR 按 Phase 1→4 开工 | 2026-06-29 | ✅ 已落地（ADR-038） |
| [023-progressive-tool-disclosure.md](./023-progressive-tool-disclosure.md) | 渐进式工具披露 — 工具降 name-only + `tool_search` 按需提升为原生（架构选 A=harness/Anthropic Tool Search，非 JVS 泛型代理 B；取代手动门控）。实测「一句 hi=17.9k 输入 token，工具 schema 占 73%」vs 对照组 JVS 11.3k（MCP 走 3 代理工具）+ 必要性证据链（Anthropic Tool Search 49%→74%、VS Code virtual tools、Cursor 40 上限、MCP 协议层不解决）+ 上游尽调（v1.3.13/anomalyco，零实现，#9461 open 无承诺 → 自建）+ 落点钉死（纯 plugin 不行，需窄接缝钩子 `experimental.chat.tools.transform`：plugin 类型加一行 + `prompt.ts:1460` fire 一次，策略全在 plugin；每 step 重解析 + tools 不进缓存=零惩罚）+ 委派工具不可 defer 硬约束（#3592） | 2026-06-26 | ✅ 已落地（ADR-036） |
