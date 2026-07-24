# spec_lock — 内部平台迁移季度进展通报（Q2）

> 执行契约样例：**每批页面生成前重读本文件**，所有颜色/字号/骨相判断只能来自这里与 tokens.css。
> 格式定义见 `references/spec-lock-format.md`。

## Style
- 风格：`editorial-warm`（温度：安静）· 暖纸编辑部：杂志排版的沉稳与人文感
- 字体配对：`serif-full`
- 关键纪律：
  - 全衬线——标题与正文同族，靠字重与字号分层
  - 暖纸底色，次级底与底色差距小，分区靠留白
  - bar 拉成 88×3 的杂志式长细横线
  - kicker 只留一点字距（.08em），不喊叫
- Signature id：`long-hairline`
- **Signature（非可选）**：88×3 长细横线 + 暖纸底——横线一短、纸一冷，整套气质就散了

## Canvas
- 1280×720 · 页边距 72px · 8px 间距模数

## Colors（唯一 HEX 来源 = tokens.css，本表是它的可读镜像）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #FAF6EF | 页面底色 |
| --c-bg2 | #EFE7D9 | 次级底/分区底 |
| --c-primary | #3B3226 | 深色底与结构元素（data-dark 页背景） |
| --c-head | #3B3226 | 标题/栏头/表头墨色 |
| --c-accent | #94441C | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #6B6152 | 弱化：辅助线、次级标签 |
| --c-text | #241F18 | 正文墨色 |
| --c-on-dark | #F8F3EA | data-dark 页上的文字 |
- 色彩论证：暖纸底与深棕墨取自内部纸质周报的观感，砖红 accent 标风险项

## Typography
- `--font-display`：Georgia,Cambria,"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",serif
- `--font-stack`：Georgia,Cambria,"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",serif
- 字号 ramp：display 60px / h1 42px / h2 28px / h3 23px / body 21px / num 76px / caption 14px
- 字重：head 700 / sub 500 / body 300；中文强调靠字重 + accent 色，禁斜体

## Structure（骨相 token）
| 变量 | 值 |
|---|---|
| --sl-pad | 72px |
| --bar-w | 88px |
| --bar-h | 3px |
| --kicker-transform | none |
| --kicker-spacing | .08em |
| --fw-head | 700 |
| --fw-sub | 500 |
| --fw-body | 300 |
| --lh-body | 1.75 |
| --measure | 34em |
| --radius | 0 |
| --rule-w | 1px |

## Allowances

本风格不放开任何全局禁项（无 `deckcraft:allow` 标记 ⇒ 渐变/阴影/圆角全禁）。

## Page Plan
| 页 | rhythm | layout | 一句主旨 |
|---|---|---|---|
| 1 | anchor | S01 | 平台迁移季度通报 |
| 2 | anchor | S05 | 本季迁移完成六成，进度符合预期 |
| 3 | dense | S10 | 各业务域迁移进度 |
| 4 | dense | S06 | 季度迁移里程碑 |
| 5 | dense | S04 | 已完成 vs 待协调项 |
| 6 | dense | S03 | 三个风险与协调项 |
| 7 | anchor | S08 | 下季目标：完成核心域迁移 |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · 标题下划线
- 未在 Allowances 放开的：渐变 · box-shadow · 圆角
- 风格专属：高饱和色块 · 科技感网格
