# 历史归档索引

> 本目录只追加不修改（归档时可在文件顶部加 FROZEN 说明头）。内容反映**归档当时**的状态，不要当现状引用；活文档见 [`docs/document-map.md`](../document-map.md)。

| 文件 | 归档时间 | 归档原因 | 何时值得回看 |
|------|---------|---------|-------------|
| `progress-raw.md` | 2026-06-04 | 原始进度流水（Phase 1 → Round 15），已被 CHANGELOG 取代 | 考古某个早期改动的来龙去脉 |
| `initial-monorepo-plan.md` | 2026-06-04 | 项目初始化计划（原根目录 `.plan.md`） | 回顾最初的包规划与取舍 |
| `architecture-full.md` | 2026-07-03 | 远期愿景架构（Phase 2+），2026-06-06 后未再维护；文中 `ai-context/` 等目录是设想、不存在 | 重启多端/企业版/Control Plane 规划时作素材 |
| `mcp-technical-flow.md` | 2026-07-03 | MCP 端到端链路长文，内容已被 `gotchas.md` §3/§11 + `conventions.md` §7 + ADR-011/016/017 取代 | 需要 MCP 全链路叙述性讲解时 |
| `knowledge-base-replication-guide.md` | 2026-07-03 | 「把知识库能力复制到其它 agent」的可移植指南；KB 已落地，ADR-026 为权威 | 向另一个项目移植知识库能力时 |
| `agent-os-kickoff.md` | 2026-07-03 | Agent OS 换机/换窗口启动 prompt；阶段 0-3 已于 2026-06-13 全部落地 | 参考「可移植启动 prompt」的写法 |
| `reviews/` | 2026-06-04 | Phase 1~2.5 代码审查记录 | 追溯早期实现的审查结论 |
| `summaries/` | 2026-06-04 | Phase 2 迭代总结 | 同上 |
| `test-reports/` | 2026-06-04 | 2026-03-06 测试报告快照 | 同上 |

归档规则（同 `document-map.md` 维护规则）：

1. 归档判据：**无活文档引用 + 内容已被 SSOT 取代/使命完成**（调研盘点确认后移入）。
2. 移入时更新 `document-map.md` 目录树与计数，并在本表加一行（文件、时间、原因、回看场景）。
3. 活文档引用它的地方改为指向 archive 路径或删除引用（`scripts/check-docs.ts` 会校验断链）。
