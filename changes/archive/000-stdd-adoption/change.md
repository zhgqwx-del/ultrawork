# STDD/SDD 接入

- 变更 ID `000-stdd-adoption`
- 类型 研发协作与文档检查
- 接入配置 `init-stdd` v1.5.0，`team`，面向 Codex、Claude Code 和 Qoder

## 交付范围

- 建立产品、设计、研发和测试共用的[项目入口](../../../docs/stdd/project.md)，接入仓库现有工程约定、需求文档、讨论与 ADR。
- 安装后续技能、变更与验收模板、Git 差异和规格追踪脚本。现行规格的追踪纳入[文档 CI](../../../.github/workflows/ci.yml)。
- 以已有代码和测试建立[桌面启动规格](../../../specs/desktop-startup/spec.md)。规格记录本次接入前的应用行为。

## 基线与证据

- 合入目标 `origin/main`。收尾时刷新目标，基线为 `ecd452ed3f69e765ec51fa71fa4c4bd3304a7620`。
- 交付分支 `codex/stdd-sdd-integration`。
- 接入前行为检查与收尾证据见[验收记录](verification.md)。后续需求从[首个业务变更草稿](../../001-first-slice/change.md)进入。
