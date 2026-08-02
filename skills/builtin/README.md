# 内置技能 (built-in skills)

本目录是**打包源**（git 松散树）：构建期由 `scripts/pack-builtin-skills.ts` 按内容 hash 惰性打成
`skills-builtin.zip`（+ 外置 `.builtin-version` sentinel）进 Tauri `bundle.resources`
（beforeDevCommand/beforeBuildCommand 自动跑）；首启由 `src-tauri` 解压到
`~/.config/ultrawork/skills/builtin/`（staging+rename 原子落地），被 OpenCode sidecar
自动发现（`{skill,skills}/**/SKILL.md`）。详见 ADR-041 / docs/gotchas.md §10。

**不要手改本目录**——`skill-creator/skill-installer/markdown-exporter` 由
`scripts/fetch-builtin-skills.ts` 从上游拉取并打补丁；重跑该脚本会覆盖（fetchSubdir 先 rmSync 落地目录）。
`deckcraft` / `doc-edit` / `pdf` 为自写，**不在 SOURCES 里**，可直接改。
改动后 `.builtin-version` 哈希会变，构建期重打 zip、桌面端据此触发升级重装。

## 技能与许可证

| 技能 (frontmatter name) | 来源 | 许可证 | 运行依赖 |
|---|---|---|---|
| `skill-creator` | anthropics/skills `skills/skill-creator` | Apache-2.0 | python3 |
| `skill-installer` | openai/skills `.system/skill-installer`（改安装目标） | Apache-2.0 | python3, git |
| `pdf` | **ultrawork 自写**（PyMuPDF；原 openai/skills `.curated/pdf` 已整体替换，discussions/059 S2） | 同仓库 | python3 + pymupdf（AGPL-3.0/商业，用户自装不打包） |
| `xlsx` | **ultrawork 自写**（openpyxl 读 + 自建 OOXML 底座外科式写，discussions/059 S3） | 同仓库 | python3 + openpyxl/lxml + **soffice（必需，非可选）** |
| `markdown-exporter` | bowenliang123/md_exporter（仅 SKILL.md，按 pip 模式） | Apache-2.0 | markdown-exporter(pip), pandoc |
| `deckcraft` | **ultrawork 自写**（HTML-first PPT，做 PPT 的默认技能，ADR-061） | 同仓库；vendored pptxgenjs MIT | python3.10+, python-pptx, chrome-or-edge（可编辑 pptx 另需 Node，OPTIONAL） |
| `doc-edit` | **ultrawork 自写** | 同仓库 | python3 + python-docx/openpyxl/python-pptx |
| `feishu-assistant` | **ultrawork 自写**（薄路由到 lark-cli 内嵌官方技能） | 同仓库 | lark-cli（设置→连接器→办公 CLI 安装） |
| `dingtalk-assistant` | **ultrawork 自写**（薄路由到连接器 materialize 的 dws 官方 mono 技能） | 同仓库 | dws（设置→连接器→办公 CLI 安装） |
| `wecom-assistant` | **ultrawork 自写**（薄路由）+ `references/official/` vendored 自 WecomTeam/wecom-cli `skills/`（整树单一 commit 快照；SKILL.md→INDEX.md 防嵌套技能扫描，commit 与取舍详见其 `_ORIGIN.md`） | 同仓库；vendored 部分 MIT | wecom-cli（设置→连接器→办公 CLI 安装） |

> ⚠️ Anthropic 官方 `docx/pdf/pptx/xlsx` 文档技能是**专有许可、禁止再分发**（`LICENSE.txt` 1467B
> 即专有，11345B 即 Apache-2.0），**不可内置**。PDF 曾用 OpenAI 的 Apache 版，059 S2 起改为
> clean-room 自写；xlsx 自 059 S3 起是自写专用技能（`doc-edit` 暂留，S4 齐活后再定去留），
> 长尾格式转换用 `markdown-exporter`。
> 自写技能的合规由 `scripts/check-skill-originality.py` 把关（逐字节 + 专有许可特征 + AST 骨架），
> 详见 `docs/discussions/059-office-skills-revamp.md` §5 L0。

## 运行依赖

技能本身只是指令 + 脚本，真正执行靠用户机器上的 Python/Node/Pandoc/Poppler 等。ultrawork **不打包**
这些运行时，而是在「设置-技能」页**检测并引导安装**（每张卡显示依赖就绪/缺失徽标）。

## 更新

```bash
bun run --bun scripts/fetch-builtin-skills.ts   # 重新拉取上游 + 打补丁 + 刷新 .builtin-version
git add skills/builtin && git commit            # 提交（bundle.resources 从仓库打包）
```
