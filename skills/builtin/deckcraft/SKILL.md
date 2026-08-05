---
name: deckcraft
description: >
  HTML-first presentation generator — the default skill for making slide decks.
  Use whenever the user wants to 做PPT / 生成PPT / 制作演示文稿 / 做幻灯片 or create a
  presentation / slides / deck / slideshow, either from a topic or from source
  documents (PDF/DOCX/XLSX/PPTX/URL/Markdown). Produces a styled single-file HTML deck
  plus PDF, an image-type PPTX (with speaker notes) and — optionally — an editable PPTX
  (text/shapes native in PowerPoint). Route by the DELIVERABLE, not by the source: a
  deck coming out means this skill whatever went in, so 「把这份 PDF/Word/Excel 做成 PPT」
  is this skill and not `pdf`/`docx`/`xlsx` — those three are for when the thing being
  delivered is a PDF/Word/Excel file itself. Not for beautifying/templating an EXISTING
  .pptx 1:1 or building reusable template packs — for those, ppt-master can be installed
  from 设置 → 技能; not for changing a few words in an existing deck or appending one
  slide to it — that is `pptx-edit` (see routing table below).
x-requires: [python3.10+, python-pptx, pillow, chrome-or-edge, node, pdfplumber, pypdf, pypdfium2, mammoth, ebooklib, nbconvert, markdownify, beautifulsoup4, requests, openpyxl, curl_cffi]
x-requires-optional: [node, pdfplumber, pypdf, pypdfium2, openpyxl, mammoth, ebooklib, nbconvert, markdownify, beautifulsoup4, requests, curl_cffi]
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
> 8. **开工先建任务清单**：第一步用 `todowrite` 工具把六个 Phase 建成任务清单，每完成一个 Phase 就更新状态——让用户在「任务规划」面板看到进度。这是多阶段流水线，必须显式跟踪。

## 路由边界（先于一切判断）

**按产出物判，不按源判**：用户要拿到的东西是 deck，就是本技能——源是 PDF / Word / Excel /
另一份 PPT / 网页都不影响。反过来，源是 PPT 而产出物是 Word/Excel/PDF，那也不是本技能。

| 用户意图 | 归属 |
|---|---|
| 做PPT / 生成PPT / 演示文稿 / 幻灯片 / slides / deck——从主题或文档生成新 deck（HTML / PDF / 图片型 pptx / 可编辑 pptx 交付） | ✅ 本技能（做 PPT 的默认技能） |
| 「把这份 PDF / Word / Excel 做成 PPT」——源是别的格式，产出物是 deck | ✅ 本技能（用 `source_to_md/` 读源，见 Phase 1） |
| 产出物是 **Word / Excel / PDF 文件本身**（哪怕源是一份 PPT） | ❌ 分别是 `docx` / `xlsx` / `pdf` 技能 |
| 已有 pptx，只是**改几处文字 / 追加一页 / 看看里面写了什么** | ❌ `pptx-edit` 技能（薄工具，不重做版式） |
| 美化已有 pptx（1:1 保页序文字）/ 用品牌 pptx 模板生成 / 建模板包 / 配音·动画增强 | ❌ 非本技能范围：告知用户可在「设置 → 技能」安装 `ppt-master` 处理此类需求（安装后同名遮蔽会让它接管这些意图），并停止本技能 |

**「生成后还想改」有两条路，先讲清再选交付形态**：
- **想让 AI 继续改**（换措辞/调版式/加页/改配色）→ 不需要可编辑 pptx。HTML 是唯一真相源，
  改 `.deckcraft/<name>/pages/page-NN.html`（或 spec_lock/tokens.css）重跑 build+门禁+export 即可。**这是首选**。
- **想脱离本工具、自己在 PowerPoint/WPS 里手改** → 才需要**可编辑 pptx**（`--pptx-editable`）。

**交付形态明示（两种 pptx，按用户选择）**：
- **图片型**（`--pptx`）：每页一张高清截图 + speaker notes，演讲者视图可用；文字**不可**在 PowerPoint 里编辑。
- **可编辑**（`--pptx-editable`）：DOM 元素逐个译成 PowerPoint 原生文本框/形状，**文字/形状可二次编辑**。
  尽力而为：渐变/内联 SVG 图标等无法翻译的元素会**栅格化为图片**（不可编辑），导出会逐页报告
  「第 N 页含 M 个不可编辑元素」——交付时必须如实转达，**绝不宣称全部可编辑**。需要内置 Node 运行时
  （缺失会明确报错引导，不静默失败）。**可编辑输出是排版起点、非像素级复刻**：字体在无对应字库的
  PowerPoint（尤其 Windows）可能回退（单行文字已锁定不重新换行、避免「01」竖排；多行长文本的换行点
  可能与 HTML 略有出入）、复合透明度/旋转变换为近似——细节由用户在 PPT 里微调；追求像素级一致就用
  HTML/PDF 或图片型 pptx。

## 脚本与资源

| 路径 | 用途 |
|---|---|
| `${SKILL_DIR}/scripts/source_to_md/*.py` | PDF/DOCX/XLSX/PPTX/网页 → Markdown |
| `${SKILL_DIR}/scripts/fetch_assets.py logo <name> / image <query>` | 品牌 logo（simpleicons→favicon 链）/ Wikimedia 真图（含许可 manifest） |
| `${SKILL_DIR}/scripts/pick_variants.py <project> [--topic "<主题>"]` | **风格/字体配对候选**（确定性 hash 打乱顺序 + 强制跨温度档，写 `variants.json`；Phase 3 第一步） |
| `${SKILL_DIR}/scripts/validate_outline.py <project>` | **大纲内容门禁**（takeaway/evidence/空话黑名单，exit 0 才可进设计） |
| `${SKILL_DIR}/scripts/build_deck.py <project>` | shell + tokens.css + pages/ → deck.html |
| `${SKILL_DIR}/scripts/validate_deck.py <project> [--single]` | 结构门禁（--single 供首页门） |
| `${SKILL_DIR}/scripts/probe_overflow.py <project> [--page N] [--dump-contrast]` | **物理探针**（Chrome 实测）：裁切/出界 + 文本对比度下界（`--dump-contrast` 逐元素打印，调试用） |
| `${SKILL_DIR}/scripts/export_deck.py <project> [--pdf] [--shots] [--pptx] [--pptx-editable] [--publish <dir>]` | 导出（--pptx=图片型隐含 2x 截图+notes；--pptx-editable=可编辑，见交付形态） |
| `${SKILL_DIR}/scripts/extract_layout.py <project> [--page N]` | （export 内部调用）deck.html → layout.json，供可编辑 pptx 组装 |
| `${SKILL_DIR}/assets/templates/shell.html` | 文档骨架（结构层，**禁止改动**） |
| `${SKILL_DIR}/assets/templates/layouts/_index.md` | **版式选型索引**（先读它）；骨架在同目录 `Sxx.html`，**只读要用的那几个，禁 glob 全目录** |
| `${SKILL_DIR}/assets/icons/tabler-outline/` | 5039 个内联 SVG 图标（用法见 assets/icons/README.md：grep 检索 → 内联 → currentColor） |
| `${SKILL_DIR}/references/` | 按需精读：content-engineering / modes / outline-schema / spec-lock-format / design-styles/ / typography-cjk / content-guidelines / visual-review / checklist |

> [!IMPORTANT]
> **跨平台 python 启动器（Phase 1 开工第一步先确定，之后所有命令照用）**：本文所有命令写作
> `python3 …`，但 **Windows 上只装了 python.org 版 Python 时没有 `python3` 命令（只有 `python`）**。
> 第一步先跑 `python3 --version`；若报「不是内部或外部命令 / command not found」就改用 `python`，
> 并把本文后续**每一条** `python3 …` 一律替换为 `python …`（一次确定、全程沿用）。
> ⚠️ 依赖徽标显示 `python3.10+` 就绪 **不代表** `python3` 这个命令名在 PATH 上存在——徽标是 Rust
> 探针解析到的解释器，命令名可用性要靠上面这步实测。macOS/Linux 用 `python3`。
> Linux：导出中文 deck 需系统装有 CJK 字体（如 `fonts-noto-cjk`），否则 PDF/截图中文渲染为方块（各门禁量的是盒子不是字形，拦不住）——交付前提醒用户。

## 工作流

### Phase 1 — 建项目 + 源材料

🚧 GATE：意图属于本技能（见路由边界）。

**先确定 python 启动器**（见上「跨平台 python 启动器」）：跑 `python3 --version`，Windows 上失败就全程用 `python`。下面这条建目录命令是首个实测点——它失败多半就是命令名问题，换 `python` 重试。

```bash
python3 -c "from pathlib import Path; [Path('.deckcraft/<name>', d).mkdir(parents=True, exist_ok=True) for d in ('pages','research','images','export')]"
```
<!-- 用 python 建目录而非 mkdir -p：Windows 默认 shell 是 PowerShell，mkdir -p 多参数会失败；命令名 python3 vs python 见上方启动器规则 -->

> **所有中间文件必须落在 `.deckcraft/<name>/` 里**（outline.json / spec_lock.md / tokens.css /
> research/ / pages/ / images/ / export/ 无一例外）——产物面板对点目录下的文件全部隐藏，
> 它们才不会淹没用户的产物列表。**工作区根只允许出现 Phase 6 `--publish` 拷出的最终交付物**
> （`<name>.html/.pdf/.pptx`）。绝不要把 spec_lock.md / tokens.css / research.md 等写到工作区根或
> 非点目录——一旦写到点目录外，就会污染产物面板。

有源文档：用 `source_to_md/` 转换，产物放 `.deckcraft/<name>/sources/`。

> **每个转换器有各自的第三方依赖，且都是 OPTIONAL**（缺了不影响「从主题/Markdown 做 deck」，
> 只影响读那一类源文件）。缺哪个就 `pip install` 哪个，**不要让用户为用不到的格式装东西**：
>
> | 源格式 | 脚本 | 依赖 |
> |---|---|---|
> | PDF | `pdf_to_md.py` | `pdfplumber` `pypdf` `pypdfium2` |
> | DOCX / EPUB / .ipynb | `doc_to_md.py` | `mammoth` `ebooklib` `nbconvert` `markdownify` `beautifulsoup4` `requests` |
> | XLSX | `excel_to_md.py` | `openpyxl` |
> | PPTX | `ppt_to_md.py` | `python-pptx`（核心依赖，本来就必需） |
> | 网页 URL | `web_to_md.py` | `curl_cffi` `requests` `beautifulsoup4` |
>
> 三处声明（`x-requires` / `BUILTIN_DEP_MAP` / Rust `PY_MODULES`）必须同步，改一处就要改三处。

**无源文档（只给了主题）→ Research 阶段 MANDATORY**：Read `references/content-engineering.md` §一，
把主题拆 3-6 个检索问题，用联网工具至少 3 轮检索，写 `research/research.md` + `research/facts.json`
（每条事实一个 `fact_id` + 来源 URL）。无联网工具时明确告知用户内容将基于模型知识并建议提供素材。

### Phase 2 — 澄清 + 大纲 IR（内容的主战场）

1. Read `references/outline-schema.md` + `references/modes.md`。
2. **第 1 轮 question（3-5 问，一次调用）**：受众与目的 / 叙事 mode（按 modes.md 推荐表给推荐项）/ **消费距离 `delivery_purpose`**（远观投影→`presentation` / 近读文档讲义→`document` / 缺省 `balanced`——按用户描述的信号推荐，**不由 mode 推定**；详见 outline-schema.md + content-engineering §五）/ 页数档位 / 交付形态（HTML / +PDF / +图片型 pptx / +可编辑 pptx——若选可编辑，提示「用于脱离本工具在 PowerPoint 手改；想让 AI 继续改无需它」）/ 内容侧重。源材料能推断的不问。写入 outline.json 顶层 `delivery_purpose`（缺省 balanced）。
3. 写 `outline.json`：逐页 layout/rhythm + **正文页必填 takeaway（断言句）/ evidence（引用 fact_id 或标 scenario）/ confidence / speaker_notes**。
4. **大纲门禁**：`python3 ${SKILL_DIR}/scripts/validate_outline.py .deckcraft/<name>` —— exit 0 才进 Phase 3；报错按条修大纲（内容不够 → 回 Research 补检索，不是硬编）。

### Phase 3 — 设计锁定

0. **先跑候选脚本**（不可跳过，不可凭印象挑）：
   ```bash
   python3 ${SKILL_DIR}/scripts/pick_variants.py .deckcraft/<name> --topic "<主题>"
   ```
   它按 `项目名|主题` 的确定性 hash 打乱风格/字体配对候选并写 `variants.json`（含 seed，可复现）。
   **模型对"安静极简"有确定性偏好——你自己挑的顺序会把每份 deck 拉回同一个默认。**
1. Read `references/design-styles/_index.md`（选型解释表）；只读 `variants.json` 里被选中那一个风格的明细文件。
2. **第 2 轮 question（2-3 问）**：风格方向（**按 `variants.json` 的 `styles` 顺序原样呈现**，含气质类比）/
   字体配对（按 `font_pairings` 顺序）/ 图片策略（真图检索 fetch_assets / 图标为主 / 不配图）。
   用户明确点名风格时以用户为准。
   > **这一轮是标准路径、正常一律要问**（别拿"我觉得不用问"当借口跳过——设计确认是这轮的职责）。
   > **唯一例外**：question 工具确实不可用时（例如被委派在无法交互的上下文、调用返回不可用），
   > 退到 `variants.json` 的**第一个候选**风格 + 配对（脚本已按 seed 打乱，非固定值），
   > 并在交付报告里注明「风格未经用户确认、按 seed 默认选定」。
3. Read `references/spec-lock-format.md` + `references/typography-cjk.md` + `references/content-engineering.md` §四（Concept 五问），
   写 `spec_lock.md`（含 Concept 段、Structure 骨相表、Allowances、逐页 Page Plan）+ `tokens.css`。
   **tokens.css 必须写全 8 个 `--c-*`、7 个 `--fs-*`、`--font-stack`/`--font-display`、12 个骨相 token**
   ——骨相缺省 = 这份 deck 只换了颜色（validate_deck W3）。填法照 `examples/*/spec_lock.md`（四例覆盖四风格、含唯一深底例）。
4. **写完 tokens.css 立刻重跑一次大纲门禁**：
   ```bash
   python3 ${SKILL_DIR}/scripts/validate_outline.py .deckcraft/<name>
   ```
   Phase 2 那次跑的时候 tokens.css 还不存在，用的是基准几何；骨相定了之后**字符预算与条目上限会随之收紧**
   （版心变宽/行距变大 ⇒ 预算下调，脚本会打印 `geometry: … → char×0.89 …`）。不重跑就会「大纲过了、探针打回」。

### Phase 4 — 资产准备（按图片策略）

- 品牌 logo：`fetch_assets.py logo <name> --out .deckcraft/<name>/images`
- 真图：`fetch_assets.py image "<query>" --out .deckcraft/<name>/images`（credit 见 manifest，许可要求时页脚署名）
- **弱网/无外网环境**（simpleicons/Wikimedia/favicon 均为外网源，超时约 8s/源）：失败即走诚实占位，
  不要反复重试烧墙钟；可提示用户手动放图片进 `images/` 后引用
- 图标：按 assets/icons/README.md 检索并内联（每页 ≤4 个，currentColor）
- 取不到 → 诚实占位块（虚线框 +「图片待补」角标），绝不硬凑

### Phase 5 — 生成（首页门 → 扇出）

**5.1 首页门**：选信息密度最高的正文页，生成 `pages/page-NN.html`（单页）→
`build_deck.py` → `validate_deck.py --single` → `probe_overflow.py --page 1` → 截图看一眼。
全绿才继续；有系统性问题（溢出/风格跑偏）先修 spec_lock/模板理解再扇出。

**5.2 扇出**：其余页按批生成（每批前重读 spec_lock）。**先读 `assets/templates/layouts/_index.md` 选型索引，
再只读本批要用的那几个 `Sxx.html` 骨架——禁 glob 全目录**（版式库会持续扩容，整份读入的上下文成本随之线性增长）。每页一个
`<section class="slide" data-layout="Sxx" data-rhythm="...">` 片段：颜色只用 `var(--c-*)`、
字号只用 `var(--fs-*)`。**墨色三条铁律**（对比度门禁硬拦，见 gotchas / ADR-067·068）：
① 标题/栏头/表头一律 `--c-head`——它跟随风格深浅，**不要自己判断该用 primary 还是浅字**；
② `--c-primary` 只当**背景与结构元素**（`data-dark` 页底、分隔线），深色风格下它压根不是墨色；
③ `--c-on-dark` 是 `data-dark` 页专用浅字，**只能出现在 `data-dark` 页内**，放到浅卡片上近乎隐形。
scenario 数据页页脚必须有可见「示意数据」标注；首次生成前 Read `references/content-guidelines.md`。

**5.3 结构门禁**：`build_deck.py` → `validate_deck.py` → `probe_overflow.py`，全部 exit 0。

### Phase 6 — 视觉审查 + 导出交付

1. `export_deck.py --shots` → Read `references/visual-review.md`，截图交**独立评审**（不带生成上下文的子代理；无子代理则新视角逐页过 rubric R1-R8），结果进 `qa_report.json`；`fix` 页只改定位/间距，回炉 ≤1 轮。
2. 概念终审（换名测试，一票否决——失败回大纲层补内容）。
3. 导出 + 发布：`export_deck.py .deckcraft/<name> --pdf --pptx --publish .`（按用户选的形态；可编辑 pptx 用 `--pptx-editable` 取代 `--pptx`；`--publish .` 把 `<name>.html/.pdf/.pptx` 拷到工作区根——**只有这几个文件应出现在产物面板**）。
4. 交付报告：published 路径 + qa_report 摘要 + low-confidence 页清单 + scenario 页声明 + pptx 形态明示（图片型「文字不可编辑」/ 可编辑型逐页转述「第 N 页含 M 个不可编辑元素」，若为 0 则说明全部可编辑）。

## Progressive disclosure（省上下文）

- 按 Phase 就近加载（各 Phase 已注明 Read 什么）；风格明细/骨架/图标都只读需要的那一份
- 本文件之外不要预读任何 references；`scripts/` 只执行不阅读
