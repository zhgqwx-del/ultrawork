# outline.json — 内容 IR 契约

大纲是「最终形态无关」的中间表示：校验、防溢出、版式指派全部在这一层前移完成。写完 outline.json 才允许进入设计锁定。

## 顶层字段

```json
{
  "title": "deck 标题",
  "audience": "受众与他们关心什么（一句话）",
  "goal": "这份 deck 要促成什么（一句话）",
  "mode": "pyramid | narrative | instructional | showcase | briefing",
  "delivery_purpose": "presentation | balanced | document",
  "language": "zh",
  "note": "虚构数据须声明 scenario；事实主张引用 facts.json",
  "slides": [ /* SlideSpec[] */ ]
}
```

> **`delivery_purpose`（消费距离，与 `mode` 正交）**：观众是**远观投影**还是**近读文档**——**任何 deck 都有的属性、与题材无关**。`mode` 只管叙事/页序/语气，**不碰密度**；密度只由 `delivery_purpose` 驱动。
> - `presentation` — 投影/大屏远观：正文最短、每页要点最少、留白最多（airy 是*主动追求*，非内容被砍）。
> - `balanced` —（缺省）近似今日观感，通用默认。
> - `document` — 当讲义/白皮书近读：正文最长、承载最密（讲义版该密、投影版该通风，由消费距离而非题材决定）。
>
> 缺省 `balanced`。第 1 轮 question 按用户描述的消费距离信号推荐（投影演讲→`presentation`；发出去自己读→`document`），**不由 mode 推定**。

## SlideSpec（每页一条）

| 字段 | 必填 | 说明 |
|---|---|---|
| `index` | ✅ | 1 起連续整数，与 `pages/page-NN.html` 对应 |
| `layout` | ✅ | `S01`–`S10`（见 assets/templates/layouts.html 登记表） |
| `rhythm` | ✅ | `anchor`（结论/主张页）/ `dense`（信息密集页）/ `breathing`（留白页，禁卡片网格） |
| `title` | ✅ | 页标题（正文页 = takeaway 断言句的短版；收尾/封面页为主张句） |
| `content` | ✅ | 版式对应的结构化内容（见下表） |
| `takeaway` | 正文页✅ | 本页一句话结论（断言句，含数字或明确谓语）——见 content-engineering.md §二 |
| `evidence` | 正文页✅ | ≥2 条支撑，每条 `{"fact_id":"F1"}` 或 `{"source":"user-doc"}` 或 `{"scenario":true}` |
| `confidence` | 正文页✅ | `high`/`medium`/`low`（自报；low 页在交付摘要列给用户） |
| `speaker_notes` | ✅ | 讲稿（说页面上没有的话；随 pptx notes 与 speaker-notes.md 交付） |

> 正文页 = 非 S01 封面 / S02 章节 / S07 引言 / S08 收尾 的页。`validate_outline.py` 硬校验以上契约。

### content 结构按版式

| layout | content 结构 |
|---|---|
| S01 封面 | `{kicker, subtitle, meta}` |
| S02 章节 | `{section_no}` |
| S03 要点 | `{points:[{h,p}]}`，条数见字符预算表（随档位 4–5） |
| S04 两栏 | `{col_a:{h,points[]}, col_b:{h,points[]}}`，每栏要点见字符预算表（随档位 4–5） |
| S05 数据带 | `{stats:[{n,p}], footnote}`，2-4 个；虚构数据 footnote 必须带 scenario 标注 |
| S06 时间线 | `{nodes:[{h,p}]}`，3-5 个 |
| S07 引言 | `{quote, attribution}` |
| S08 收尾 | `{statement_prefix, statement_accent, cta, sign}` |
| S09 议程 | `{items:[标题]}`，≤6 条 |
| S10 简表 | `{headers:[], rows:[[]]}`，行数见字符预算表（随档位 5–8）、≤4 列 |

## 字符预算（防溢出在 IR 层硬拦，validate_outline O8 按此表执行；按视觉宽度：全角记 1、半角记 0.5）

预算是**双边带**：**上界**锚定"槽位在 1280×720 里物理能装多少"（probe 校准，非审美常数），随 `delivery_purpose` 取档；**下界**由结构（条目数）与 O9 dense 下界承担，不设逐字符下限（逐字符下限会误杀合理短句）。真正的溢出仍由物理探针 `probe_overflow.py` 二次兜底。

**距离无关（固定）：**

| 槽位 | 预算 |
|---|---|
| 封面主标题（S01 页的 title；顶层 title 只进 HTML `<title>` 不上画布、不占预算） | ≤ 16 |
| 页标题 title | ≤ 18 |
| 条目标题 h / 栏头 / 节点题 | ≤ 12 |
| 副题 / CTA / 引言 attribution | ≤ 30 |
| 引言 quote | ≤ 40 |
| 大数字 n | ≤ 6（含符号） |
| S09 议程项 items / S10 表头单元格 headers | ≤ 18 / ≤ 12 |

**随 `delivery_purpose` 取档（视觉宽度上界 / 条目数上界）：**

| 槽位 | presentation | balanced（缺省） | document |
|---|---|---|---|
| 条目说明 `p` / 节点释义（S03·S06） | ≤ 26 | ≤ 32 | ≤ 42 |
| S04 栏内要点文字 `points`（此前**无预算=洞**，已补） | ≤ 30 | ≤ 35 | ≤ 42 |
| S03 要点条数 | ≤ 4 | ≤ 4 | ≤ 5 |
| S04 每栏要点条数（骨架已 `height`→`min-height`，放开到 5 点 0 溢出） | ≤ 4 | ≤ 4 | ≤ 5 |
| S06 时间线节点数 | 3–5 | 3–5 | 3–5 |
| S10 表格行数 | ≤ 5 | ≤ 6 | ≤ 8 |
| S10 表格列数 | ≤ 4 | ≤ 4 | ≤ 4 |

> 上界均带 ~20% 头寸以吸收 Linux CJK 字体差异（门禁量盒不量字形）。数值 probe 校准记录见 `docs/discussions/051 §4.1.1`。

超预算的处理：**改写内容压进预算**（拆页/删枝/换更短说法）或**换更密版式**，不是缩字号。**内容过稀**（dense 页留半空）反向由 O9 提示"densify / 换更密版式"（见 content-engineering §五）。

## 节奏与版式编排规则

- 首页 `anchor`(S01)、末页 `anchor`(S08)；每 3-5 页安排一个 `breathing`（S02/S07）
- ≥8 页的 deck 至少用 6 种版式；同版式不许连续 3 页
- 数据/证据放 `anchor`(S05) 承载核心结论，`dense` 页承载支撑细节
- 每页只承载一个主要信息角色；一页塞不下 = 拆两页，不是挤排版
