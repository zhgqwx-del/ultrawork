# 内置技能 (built-in skills)

本目录随 ultrawork 打包（Tauri `bundle.resources`），首启时由 `src-tauri` 幂等拷贝到
`~/.config/ultrawork/skills/builtin/`，被 OpenCode sidecar 自动发现（`{skill,skills}/**/SKILL.md`）。

**不要手改本目录**——`skill-creator/skill-installer/pdf/markdown-exporter` 由
`scripts/fetch-builtin-skills.ts` 从上游拉取并打补丁；重跑该脚本会覆盖。`doc-edit` 为自写，可直接改。
改动后 `.builtin-version` 哈希会变，桌面端据此触发刷新。

## 技能与许可证

| 技能 (frontmatter name) | 来源 | 许可证 | 运行依赖 |
|---|---|---|---|
| `skill-creator` | anthropics/skills `skills/skill-creator` | Apache-2.0 | python3 |
| `skill-installer` | openai/skills `.system/skill-installer`（改安装目标） | Apache-2.0 | python3, git |
| `pdf` | openai/skills `.curated/pdf` | Apache-2.0 | python3, pdftoppm(poppler) |
| `markdown-exporter` | bowenliang123/md_exporter（仅 SKILL.md，按 pip 模式） | Apache-2.0 | markdown-exporter(pip), pandoc |
| `doc-edit` | **ultrawork 自写** | 同仓库 | python3 + python-docx/openpyxl/python-pptx |

> ⚠️ Anthropic 官方 `docx/pdf/pptx/xlsx` 文档技能是**专有许可、禁止再分发**（`LICENSE.txt` 1467B
> 即专有，11345B 即 Apache-2.0），**不可内置**。故 PDF 采用 OpenAI 的 Apache 版，Office 读改自写
> `doc-edit`、生成用 `markdown-exporter`。详见 `docs/gotchas.md` 与 ADR。

## 运行依赖

技能本身只是指令 + 脚本，真正执行靠用户机器上的 Python/Node/Pandoc/Poppler 等。ultrawork **不打包**
这些运行时，而是在「设置-技能」页**检测并引导安装**（每张卡显示依赖就绪/缺失徽标）。

## 更新

```bash
bun run --bun scripts/fetch-builtin-skills.ts   # 重新拉取上游 + 打补丁 + 刷新 .builtin-version
git add skills/builtin && git commit            # 提交（bundle.resources 从仓库打包）
```
