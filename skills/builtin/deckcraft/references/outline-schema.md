# outline.json — 内容 IR 契约

大纲是「最终形态无关」的中间表示：校验、防溢出、版式指派全部在这一层前移完成。写完 outline.json 才允许进入设计锁定。

## 顶层字段

```json
{
  "title": "deck 标题",
  "audience": "受众与他们关心什么（一句话）",
  "goal": "这份 deck 要促成什么（一句话）",
  "mode": "pyramid | narrative | instructional | showcase | briefing",
  "language": "zh",
  "note": "虚构数据须声明 scenario；事实主张引用 facts.json",
  "slides": [ /* SlideSpec[] */ ]
}
```

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
| S03 要点 | `{points:[{h,p}]}`，≤4 条 |
| S04 两栏 | `{col_a:{h,points[]}, col_b:{h,points[]}}` |
| S05 数据带 | `{stats:[{n,p}], footnote}`，2-4 个；虚构数据 footnote 必须带 scenario 标注 |
| S06 时间线 | `{nodes:[{h,p}]}`，3-5 个 |
| S07 引言 | `{quote, attribution}` |
| S08 收尾 | `{statement_prefix, statement_accent, cta, sign}` |
| S09 议程 | `{items:[标题]}`，≤6 条 |
| S10 简表 | `{headers:[], rows:[[]]}`，≤5 行 ≤4 列 |

## 字符预算（防溢出在 IR 层硬拦；按视觉宽度：全角记 1、半角记 0.5）

| 槽位 | 预算 |
|---|---|
| deck/封面主标题 | ≤ 16 |
| 页标题 title | ≤ 18 |
| 条目标题 h / 栏头 / 节点题 | ≤ 12 |
| 条目说明 p / 释义 | ≤ 26 |
| 副题 / CTA / 引言 attribution | ≤ 30 |
| 引言 quote | ≤ 40 |
| 大数字 n | ≤ 6（含符号） |

超预算的处理：**改写内容压进预算**（拆页/删枝/换更短说法），不是缩字号。

## 节奏与版式编排规则

- 首页 `anchor`(S01)、末页 `anchor`(S08)；每 3-5 页安排一个 `breathing`（S02/S07）
- ≥8 页的 deck 至少用 6 种版式；同版式不许连续 3 页
- 数据/证据放 `anchor`(S05) 承载核心结论，`dense` 页承载支撑细节
- 每页只承载一个主要信息角色；一页塞不下 = 拆两页，不是挤排版
