---
name: deckcraft
description: >
  Fast HTML-first presentation generator (validation period — explicit triggers only).
  Use ONLY when the user explicitly says "deckcraft" / "快速PPT" / "快速幻灯片" /
  "用 deckcraft 做PPT". Produces a styled single-file HTML deck plus PDF and
  image-type PPTX (with speaker notes) from a topic or source documents
  (PDF/DOCX/XLSX/PPTX/URL/Markdown). Do NOT trigger on generic "做PPT/create
  presentation" requests while ppt-master is installed — those route to
  ppt-master until deckcraft graduates.
x-requires: [python3.10+, python-pptx, chrome-or-edge]
---

# deckcraft — HTML-first 快速演示文稿

单文件 HTML 是唯一真相源（1280×720 固定舞台），PDF / 图片型 PPTX 是派生物。管线：

`源材料/Research → 大纲 IR（含 evidence）→ 大纲门禁 → 设计锁定(spec_lock) → 首页门 → 并行生成 → 结构门禁+溢出探针 → 视觉审查 → 导出`

> [!CAUTION]
> ## 全局纪律（MANDATORY）
>
> 1. **事实验证先于假设**：涉及具体产品/版本/数字/时间线，能查证必须先查证（Research 阶段）；**诚实占位 > 编造**——没有事实支撑的数据用占位标注，绝不编数。
> 2. **禁止启动任何本地 web 服务**。所有用户交互只走原生 `question` 工具。
> 3. **两轮提问封顶**：Phase 2 澄清一轮 + Phase 3 设计确认一轮，每轮一次 question 调用（可含多问）。其余决策自决，交付时说明。
> 4. **spec_lock 重读**：每批页面生成前 Read `<project>/spec_lock.md`；颜色/字号/风格判断只能来自它与 tokens.css。
> 5. **首页门后再扇出**：并行生成放大系统性错误——先过首页门（Phase 5.1）再批量。每批 3-4 页；运行环境有并行子任务工具可整批并行。
> 6. **门禁按序全过**：validate_outline → validate_deck → probe_overflow → 视觉审查，任一非零必须修复后重跑；视觉回炉 ≤1 轮、结构返工 ≤2 轮，超限如实报告。
> 7. **产物纯净**：调试标记/生成器署名/占位残留禁止进产物（门禁硬拦）。

## 路由边界（先于一切判断）

| 用户意图 | 归属 |
|---|---|
| 从主题/文档生成新 deck（HTML / PDF / 图片型 pptx 交付） | ✅ 本技能 |
| 美化已有 pptx（1:1 保页序文字）/ 用品牌 pptx 模板生成 / 建模板包 / 配音·动画增强 / 必须交**可编辑** .pptx | ❌ 非本技能范围：`ppt-master` 已安装则交给它；未安装则告知用户可在「设置 → 技能」安装 ppt-master 处理此类需求，并停止本技能 |

**交付形态明示**：本技能的 pptx 是**图片型**（每页一张高清截图 + speaker notes，演讲者视图可用），文字在 PowerPoint 里不可二次编辑——交付时必须向用户说明这一点。

## 脚本与资源

| 路径 | 用途 |
|---|---|
| `${SKILL_DIR}/scripts/source_to_md/*.py` | PDF/DOCX/XLSX/PPTX/网页 → Markdown |
| `${SKILL_DIR}/scripts/fetch_assets.py logo <name> / image <query>` | 品牌 logo（simpleicons→favicon 链）/ Wikimedia 真图（含许可 manifest） |
| `${SKILL_DIR}/scripts/validate_outline.py <project>` | **大纲内容门禁**（takeaway/evidence/空话黑名单，exit 0 才可进设计） |
| `${SKILL_DIR}/scripts/build_deck.py <project>` | shell + tokens.css + pages/ → deck.html |
| `${SKILL_DIR}/scripts/validate_deck.py <project> [--single]` | 结构门禁（--single 供首页门） |
| `${SKILL_DIR}/scripts/probe_overflow.py <project> [--page N]` | **物理溢出探针**（Chrome 实测裁切/出界） |
| `${SKILL_DIR}/scripts/export_deck.py <project> [--pdf] [--shots] [--pptx]` | 导出（--pptx 隐含 2x 截图 + notes 写入） |
| `${SKILL_DIR}/assets/templates/shell.html` | 文档骨架（结构层，**禁止改动**） |
| `${SKILL_DIR}/assets/templates/layouts.html` | S01–S10 版式骨架登记表 |
| `${SKILL_DIR}/assets/icons/tabler-outline/` | 5039 个内联 SVG 图标（用法见 assets/icons/README.md：grep 检索 → 内联 → currentColor） |
| `${SKILL_DIR}/references/` | 按需精读：content-engineering / modes / outline-schema / spec-lock-format / design-styles/ / typography-cjk / content-guidelines / visual-review / checklist |

> Windows：`python3` 失败时改用 `python` 重试。

## 工作流

### Phase 1 — 建项目 + 源材料

🚧 GATE：意图属于本技能（见路由边界）。

```bash
mkdir -p .deckcraft/<name>/pages .deckcraft/<name>/research .deckcraft/<name>/images .deckcraft/<name>/export
```

> **工作目录必须是点目录**（`.deckcraft/`）：产物面板的文件扫描会整体跳过点目录，
> 中间产物（页面片段/截图/qa_report 等几十个文件）才不会淹没用户的产物列表；
> 最终交付物由 Phase 6 的 `--publish` 拷到工作区可见位置。

有源文档：用 `source_to_md/` 转换，产物放 `sources/`。

**无源文档（只给了主题）→ Research 阶段 MANDATORY**：Read `references/content-engineering.md` §一，
把主题拆 3-6 个检索问题，用联网工具至少 3 轮检索，写 `research/research.md` + `research/facts.json`
（每条事实一个 `fact_id` + 来源 URL）。无联网工具时明确告知用户内容将基于模型知识并建议提供素材。

### Phase 2 — 澄清 + 大纲 IR（内容的主战场）

1. Read `references/outline-schema.md` + `references/modes.md`。
2. **第 1 轮 question（3-5 问，一次调用）**：受众与目的 / 叙事 mode（按 modes.md 推荐表给推荐项）/ 页数档位 / 交付形态（HTML / +PDF / +图片型 pptx）/ 内容侧重。源材料能推断的不问。
3. 写 `outline.json`：逐页 layout/rhythm + **正文页必填 takeaway（断言句）/ evidence（引用 fact_id 或标 scenario）/ confidence / speaker_notes**。
4. **大纲门禁**：`python3 ${SKILL_DIR}/scripts/validate_outline.py deck_projects/<name>` —— exit 0 才进 Phase 3；报错按条修大纲（内容不够 → 回 Research 补检索，不是硬编）。

### Phase 3 — 设计锁定

1. Read `references/design-styles/_index.md` 选风格候选；只读选定风格的明细文件。
2. **第 2 轮 question（2-3 问）**：风格方向（3-4 个文字候选含类比）/ 配色气质 / 图片策略（真图检索 fetch_assets / 图标为主 / 不配图）。
3. Read `references/spec-lock-format.md` + `references/typography-cjk.md` + `references/content-engineering.md` §四（Concept 五问），写 `spec_lock.md`（含 Concept 段与逐页 Page Plan）+ `tokens.css`。

### Phase 4 — 资产准备（按图片策略）

- 品牌 logo：`fetch_assets.py logo <name> --out deck_projects/<name>/images`
- 真图：`fetch_assets.py image "<query>" --out deck_projects/<name>/images`（credit 见 manifest，许可要求时页脚署名）
- 图标：按 assets/icons/README.md 检索并内联（每页 ≤4 个，currentColor）
- 取不到 → 诚实占位块（虚线框 +「图片待补」角标），绝不硬凑

### Phase 5 — 生成（首页门 → 扇出）

**5.1 首页门**：选信息密度最高的正文页，生成 `pages/page-NN.html`（单页）→
`build_deck.py` → `validate_deck.py --single` → `probe_overflow.py --page 1` → 截图看一眼。
全绿才继续；有系统性问题（溢出/风格跑偏）先修 spec_lock/模板理解再扇出。

**5.2 扇出**：其余页按批生成（每批前重读 spec_lock）。每页一个
`<section class="slide" data-layout="Sxx" data-rhythm="...">` 片段：颜色只用 `var(--c-*)`、
字号只用 `var(--fs-*)`；scenario 数据页页脚必须有可见「示意数据」标注；
首次生成前 Read `references/content-guidelines.md`。

**5.3 结构门禁**：`build_deck.py` → `validate_deck.py` → `probe_overflow.py`，全部 exit 0。

### Phase 6 — 视觉审查 + 导出交付

1. `export_deck.py --shots` → Read `references/visual-review.md`，截图交**独立评审**（不带生成上下文的子代理；无子代理则新视角逐页过 rubric R1-R8），结果进 `qa_report.json`；`fix` 页只改定位/间距，回炉 ≤1 轮。
2. 概念终审（换名测试，一票否决——失败回大纲层补内容）。
3. 导出 + 发布：`export_deck.py .deckcraft/<name> --pdf --pptx --publish .`（按用户选的形态；`--publish .` 把 `<name>.html/.pdf/.pptx` 拷到工作区根——**只有这几个文件应出现在产物面板**）。
4. 交付报告：published 路径 + qa_report 摘要 + low-confidence 页清单 + scenario 页声明 + 「pptx 为图片型」明示。

## Progressive disclosure（省上下文）

- 按 Phase 就近加载（各 Phase 已注明 Read 什么）；风格明细/骨架/图标都只读需要的那一份
- 本文件之外不要预读任何 references；`scripts/` 只执行不阅读
