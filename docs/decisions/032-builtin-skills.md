# ADR-032: 内置技能（built-in skills）打包与分发

- 状态：Accepted（分发形态已被 ADR-041 修订：松散树拷贝 → 构建期 zip + 首启解压；注入位置/sentinel 升级语义不变）
- 日期：2026-06-14
- 关联：ADR-020（配置隔离 / `OPENCODE_APP_NAME`）、ADR-026（知识库）、gotchas §10

## 背景

希望 ultrawork 随安装包内置一批高质量 Agent Skill（文档处理 docx/pptx/xlsx/pdf、技能创建 skill-creator、以及一个「从互联网查找/安装技能」的 find 技能），安装后开箱可用，并重构「设置-技能」页以承载「已内置内容」的形态。

OpenCode sidecar 已支持 skill 发现（`vendor/.../skill/index.ts`）：扫描 `~/.claude/skills`、`.claude/skills`、`config.directories()` 下的 `{skill,skills}/**/SKILL.md`，以及 `skills.paths` / `skills.urls`。skill 以 frontmatter `name` 索引（非目录名）。

## 关键约束（两个硬约束）

1. **许可证**：Anthropic 官方文档技能 docx/pdf/pptx/xlsx 是**专有许可，明确禁止再分发/打包进第三方应用、禁止改作**（`anthropics/skills` 各目录 `LICENSE.txt`，1467B=专有 / 11345B=Apache-2.0）。**不能内置**。
2. **运行依赖**：技能本质是让 agent 跑 bash 调脚本，依赖用户机器上的 Python/Node/Pandoc/LibreOffice/Poppler 等。即便文件就位，缺工具也不可用。

## 决策

### D1 — 技能集（全部 Apache-2.0 或自写）
| 技能 (name) | 来源 | 能力 |
|---|---|---|
| `skill-creator` | anthropics/skills（Apache-2.0，Claude 风味） | 创建/优化/评测 skill |
| `skill-installer`（= find） | openai/skills `.system/skill-installer`（Apache-2.0，改安装目标） | 从 GitHub 列出/安装技能到本机 |
| `pdf` | openai/skills `.curated/pdf`（Apache-2.0） | 读/建/审 PDF |
| `markdown-exporter` | bowenliang123/md_exporter（Apache-2.0，pip 模式） | Markdown→DOCX/PPTX/XLSX/PDF 等 |
| `doc-edit` | **ultrawork 自写** | 读/改现有 docx/xlsx/pptx（**已于 059 S6 瘦身改名为 `pptx-edit`**：docx/xlsx 由 059 S3/S4 的专用技能取代，只留 .pptx 就地读改） |

文档读改自写 `doc-edit`（python-docx/openpyxl/python-pptx），规避专有许可同时补 OpenAI/md_exporter 不覆盖的「就地编辑」能力。（2026-08-04 更新：059 S3/S4 落地专用 `xlsx`/`docx` 技能后，`doc-edit` 于 S6 瘦身改名 `pptx-edit`，只保留 .pptx 就地读改。）

### D2 — 注入方案 C（拷贝到 configDir/skills/builtin）
内置技能源码在仓库 `skills/builtin/`，经 Tauri `bundle.resources` 打包；首启时 `src-tauri` 幂等拷贝到 `~/.config/ultrawork/skills/builtin/`（被 sidecar 自动扫描）。
- **vendor 零改、不动 opencode.json**（区别于注入 `skills.paths`）；
- sentinel `.builtin-version`（内容 hash）控制 app 升级刷新；**刷新只 wipe `builtin/`**，绝不碰同级用户安装技能；
- 资源定位用**有界递归查找 `.builtin-version` 锚点**，兼容 Tauri map / glob / `_up_` 三种布局（`find_builtin_source`）。

### D3 — 运行依赖：检测 + 引导（不打包运行时）
新增 Tauri command `check_skill_dependencies`（复用 `rich_path()` 探测 python3/node/pandoc/soffice/pdftoppm/git/markdown-exporter）；前端 `BUILTIN_DEP_MAP`（技能→依赖 SSOT）+ `DepBadge` 显示就绪/缺失 + 安装指引。**不打包 Python/LibreOffice 等运行时**（体积、系统工具仍需另装）。

### D4 — 设置页三区
内置（只读 + 依赖徽标）／可安装（curated，点击交给内置 skill-installer 在新对话完成）／自定义（现有 paths/urls + 发现到的非内置技能）。以 `skill.location` 含 `/skills/builtin/` 区分内置。

## 备选与放弃
- **内置 Anthropic 文档技能** → 许可证禁止，放弃。
- **注入 `skills.paths` 指向 bundle 内路径** → 需改 opencode.json + 路径随 app 迁移失效，放弃，改方案 C。
- **打包 Python 运行时** → 体积大且系统工具仍缺，放弃，改检测+引导。
- **vendor md_exporter 整个 Python 包** → 用户仍需装其依赖，不如 `pip install md-exporter` 简洁，故只内置 SKILL.md（pip 模式）。

## 影响
- 新目录 `skills/builtin/` + `scripts/fetch-builtin-skills.ts`（上游同步 + 打补丁 + 刷新 sentinel）。
- `src-tauri/src/lib.rs`：`ensure_builtin_skills` / `find_builtin_source` / `builtin_needs_refresh` / `check_skill_dependencies`（+ setup 接线 + invoke_handler 注册）。
- 前端：`use-skill-deps.ts`（+ `BUILTIN_DEP_MAP`）、`use-skills.ts`（`builtin` 分类）、`Settings.tsx`（三区 + DepBadge）、`Home.tsx`（`initialInput` 预填）、i18n。
- 测试：Rust 5 单测 + desktop vitest 6。端到端（tauri dev 资源落地 + `GET /skill` 发现 + UI 三区）为手动验证项。
