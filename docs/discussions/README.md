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
