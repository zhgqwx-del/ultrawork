# 工程约定

## Ultrawork 开发与验收入口

- [开发约定](conventions.md) §13 定义 macOS、Windows 和 Linux 的兼容要求。[跨平台 CI](../.github/workflows/ci.yml)运行三平台类型检查、定向 TypeScript 契约测试和 Rust 测试，macOS 与 Linux 另跑全量 workspace 单测。
- 应用开发和交付使用现有 Bun、Turborepo 与 Tauri 工具链。启动及构建见[快速上手](getting-started.md)和[构建部署](build-and-deploy.md)。定向测试及原生、端到端验证见[测试规划](testing.md)，合入前对照[质量门禁](quality-gates.md)。

在仓库根目录按改动选择适用检查。STDD 脚本使用 Python 3.9 或以上版本，Windows 可将命令中的 `python3` 换为 `py -3`。

```sh
python3 -B scripts/check_traceability.py
bun run --bun scripts/check-docs.ts
bun run --bun turbo run typecheck
bun run --bun turbo run test --continue
```

[文档 CI](../.github/workflows/ci.yml)同时运行仓库文档检查和现行规格追踪。

## 规格与验收

- `specs/<capability>/spec.md` 按能力记录主分支已交付的可观察行为和验收入口。[产品需求](requirements.md)、[API 参考](api-reference.md)与[架构决策](decisions/README.md)各自维护原有内容，规格引用相关出处。将待确认的改动写在 `changes/<id>/`，随规格、实现、测试和证据一起评审。发布环境的行为以实际运行版本为准。
- 需求与验收分别使用 `REQ-<领域>-<序号>`、`AC-<领域>-<序号>`。领域码使用大写英文字母或数字，可用短横线连接。用三级标题记录 ID，并在每个场景下用 `关联` 指向需求。沿用存续规则的 ID，新规则使用未分配的编号，退役编号留在 Git 历史。
- 规格、设计、任务和验收都引用相同的 ID。`test-plan.md` 记录要验证什么，`verification.md` 记录实际观察和受测版本。
- 自动化用例优先从公开入口验证。在可运行的旧实现上先检查新用例能否捕获差异，再实现和复跑。外部依赖按需使用确定性数据或隔离环境。需要手工验收时记录执行人、环境、操作、预期和实际结果。

## 团队交付

- 影响用户结果的取舍写入 `change.md` 并由相应负责人确认。并行变更按最新候选提交重跑受影响的检查。
- 跨角色或多轮讨论按需写到项目讨论目录，长期约定沿用已有 ADR 目录。相关记录链接到 `change.md`。 [讨论与架构决策](stdd/decisions-and-discussions.md)
- 实现前在 `tasks.md` 记录简短实施方案和确认依据。复杂变更可在 `design.md` 展开。在变更记录保留 Git 基线、真实合入目标和同步策略。准备提交或 PR 时默认刷新目标，按项目策略同步并复验，记录最终受测内容；共享历史和提交整理沿用项目约定。 [Git 工作方式](stdd/git-workflow.md)
- 评审时核对主要路径、相关边界、候选提交和实测证据。删减断言、跳过测试或修改检查规则时记录理由。高影响变更可由另一位评审者独立复跑关键场景。
- 从[角色导航](stdd/roles.md)找到交接入口。变更文件的详略随风险调整。完成后更新现行规格和交付记录，并按项目流程移入 `changes/archive/`。
