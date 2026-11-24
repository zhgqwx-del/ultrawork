# STDD 研发工作流

产品、设计、研发和测试先从[角色导航](roles.md)打开同一份变更。按当前工具调用技能，也可以让 Agent 直接读取表中链接的 `SKILL.md`。

- Codex 使用 `$stdd-start`，技能位于 [`.agents/skills/`](../../.agents/skills/)。
- Claude Code 使用 `/stdd-start`，技能位于 [`.claude/skills/`](../../.claude/skills/)。
- Qoder 使用 `/stdd-start`，技能位于 [`.qoder/skills/`](../../.qoder/skills/)。

## 使用顺序

从[项目入口](project.md)找到当前变更。先明确规格和验收场景，再在 `tasks.md` 写修改位置、关键取舍和验收方式。方案确认后进入测试与实现。复杂变更可单独写技术设计。

```mermaid
flowchart TD
    Init["项目已初始化<br/>从项目入口找到当前变更"]
    Start["stdd-start<br/>核对基线与分支，起草变更"]
    Diagnose["stdd-diagnose<br/>复现缺陷并形成回归场景"]
    Spec["起草规格、验收场景和简短实施方案"]
    Records["按项目约定记录讨论或 ADR<br/>从 change.md 链接"]
    Confirm{"规格和实施方案已确认？"}
    Delivery["stdd-delivery<br/>先写验收测试，再实现并复跑"]
    Report["stdd-test-report<br/>把实际结果写入 verification.md"]
    Review["stdd-review<br/>核对代码、规格和受测证据"]
    Wrap["stdd-wrap<br/>刷新目标、按策略同步并复测<br/>归档、PR 或交接"]
    Done["按项目流程合入或交接"]
    Release["stdd-release-notes<br/>按版本范围整理发布说明或迭代总结"]

    Init -->|继续已创建的首个变更| Spec
    Init -->|后续开新需求| Start
    Init -->|收到缺陷反馈| Diagnose
    Start --> Spec
    Diagnose -->|决定修复后| Spec
    Spec --> Confirm
    Spec -.->|多轮讨论或长期取舍| Records
    Records --> Confirm
    Confirm -->|已确认| Delivery
    Confirm -->|待确认或需调整| Spec
    Delivery --> Report
    Report -->|关键场景通过| Review
    Report -->|发现实现问题| Delivery
    Review -->|需要修正实现| Delivery
    Review -->|评审通过| Wrap
    Wrap --> Done
    Done -.->|准备发版或总结迭代时| Release
```

团队先开 PR 时，可以先用 `stdd-wrap` 准备草稿，再在 PR 中用 `stdd-review`。

## 技能速查

| 阶段 | 技能 | 工作产物 |
| --- | --- | --- |
| 开工 | [stdd-start](../../.agents/skills/stdd-start/SKILL.md) | 基线 SHA、真实合入目标和同步策略、规格与简短实施方案、相关讨论和 ADR |
| 实现 | [stdd-delivery](../../.agents/skills/stdd-delivery/SKILL.md) | 按已确认方案和场景编写用例、实现并复跑 |
| 排查 | [stdd-diagnose](../../.agents/skills/stdd-diagnose/SKILL.md) | 用[诊断模板](templates/diagnosis.md)记录资料来源、发生时段、复现状态及回归场景 |
| 验收 | [stdd-test-report](../../.agents/skills/stdd-test-report/SKILL.md) | 按场景记录自动、手工、失败和待验结果，核对历史证据版本及用例数量 |
| 审查 | [stdd-review](../../.agents/skills/stdd-review/SKILL.md) | 固定目标与候选 SHA，从实际候选读取代码，给出有定位和触发条件的发现 |
| 收尾 | [stdd-wrap](../../.agents/skills/stdd-wrap/SKILL.md) | 刷新目标、按策略 rebase 或快进、处理冲突并复测，核对归档链接，按 [PR 模板](../../.github/pull_request_template.md)整理交付状态 |
| 版本 | [stdd-release-notes](../../.agents/skills/stdd-release-notes/SKILL.md) | 按[版本说明模板](templates/release.md)整理固定版本快照或明确时间窗内的变化、兼容及验收状态 |

## 脚本

从仓库根目录使用脚本。需要 Python 3.9 或以上版本，Windows 可用 `py -3` 代替 `python3`。

```sh
python3 -B scripts/new_change.py 002-next-change '下一项变更' --roles
python3 -B scripts/check_traceability.py
python3 -B scripts/git_range.py --merge-base main HEAD
```

- `new_change.py` 创建变更、任务与验证文件。加 `--roles` 会同时生成[规格草稿](templates/spec.md)、[体验设计](templates/ux-design.md)和[验收计划](templates/test-plan.md)。复杂变更另加 `--design` 生成[技术设计](templates/design.md)。同名的在途或已归档变更会报错。
- `check_traceability.py` 检查 `specs/` 中的现行规格，拦截空规格、格式错误或重复的 `REQ` 和 `AC` 编号、未知引用和缺少验收场景的需求。文档 CI 运行同一检查。实际测试覆盖和手工验收结果记入 `verification.md`。
- `git_range.py` 读取本地 Git 引用和提交差异。审查分支用 `--merge-base` 查看分叉点到候选的文件变动。比较版本时传两个实际引用，文件差异取两端快照。

## 接入项目的测试与发布流程

按 [Ultrawork 工程约定](../engineering.md)运行规格追踪、文档检查及适用的 Bun 和 Tauri 检查。涉及原生窗口、真实 sidecar 或外部 Agent 的场景，从[测试规划](../testing.md)选对应验收入口，并在变更中记录运行版本和环境。

## 收尾时同步多人改动

准备提交或 PR 时，`stdd-wrap` 默认核对真实合入目标并 fetch，固定本轮目标 SHA，再判断是否需要快进或 rebase。已包含目标时跳过；未发布的本次提交或项目允许改写的个人分支按策略 rebase。冲突按双方意图和已确认规格处理，完成后同步变化的依赖并重跑项目检查。将同步状态、受测内容和实际结果写入 `verification.md`。

工作区中已有的无关改动、共享历史和离线状态按[项目 Git 约定](git-workflow.md#收尾同步)处理。中途交接、无远端或项目要求 merge 时沿用对应范围，注明实际状态。squash、提交、推送和创建 PR 沿用项目策略及已有任务授权。

`git_range.py` 只提供差异查询；Git 同步由 Agent 按技能步骤执行。验收报告也不代替项目 CI 门禁，跳过、零条预期用例和未绑定版本的旧报告不能作为本次场景已通过的依据。

需要单独讨论或记录长期决策时，按[讨论与架构决策](decisions-and-discussions.md)选择位置，在 `change.md` 关联讨论与 ADR，归档时核对双向链接。
