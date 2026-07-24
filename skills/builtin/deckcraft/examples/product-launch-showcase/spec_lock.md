# spec_lock — Lumo 口袋投影仪发布（虚构产品演示）

> 执行契约样例：**每批页面生成前重读本文件**，所有颜色/字号/骨相判断只能来自这里与 tokens.css。
> 格式定义见 `references/spec-lock-format.md`。

## Style
- 风格：`tech-dark`（温度：中性）· 深色科技：高对比、数据感、克制的锐利。深色是底色不是特效
- 字体配对：`mono-display`
- 关键纪律：
  - **本例是唯一深底样例**：--c-bg 深 ⇒ --c-head/--c-text/--c-muted 全部反转为浅色
  - --c-primary 留在底色家族，只当 data-dark 页底与结构元素，**不当墨色**
  - 等宽标题承担技术性格；汉字必然穿透到黑体（预期行为）
  - 大数字（--fs-num）是本风格的招牌元素，亮橙 accent 只点数字与关键词
- Signature id：`mono-caps`
- **Signature（非可选）**：等宽标题 + 32×6 短促 bar + .3em 开阔 kicker 字距——深底上的锐利来自这三处收紧

## Canvas
- 1280×720 · 页边距 64px · 8px 间距模数

## Colors（唯一 HEX 来源 = tokens.css，本表是它的可读镜像）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #12161C | 页面底色 |
| --c-bg2 | #1C222B | 次级底/分区底 |
| --c-primary | #0C1015 | 深色底与结构元素（data-dark 页背景） |
| --c-head | #EEF3F8 | 标题/栏头/表头墨色 |
| --c-accent | #FF7A18 | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #96A3B2 | 弱化：辅助线、次级标签 |
| --c-text | #EEF3F8 | 正文墨色 |
| --c-on-dark | #EEF3F8 | data-dark 页上的文字 |
- 色彩论证：近黑蓝灰底避开纯黑的死感，亮橙 accent 是发布会的唯一亮点色

## Typography
- `--font-display`：ui-monospace,"SF Mono",Menlo,Consolas,"Source Han Sans SC","PingFang SC","Microsoft YaHei",monospace
- `--font-stack`："Helvetica Neue","Segoe UI","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif
- 字号 ramp：display 68px / h1 44px / h2 30px / h3 24px / body 21px / num 84px / caption 14px
- 字重：head 700 / sub 500 / body 300；中文强调靠字重 + accent 色，禁斜体

## Structure（骨相 token）
| 变量 | 值 |
|---|---|
| --sl-pad | 64px |
| --bar-w | 32px |
| --bar-h | 6px |
| --kicker-transform | uppercase |
| --kicker-spacing | .3em |
| --fw-head | 700 |
| --fw-sub | 500 |
| --fw-body | 400 |
| --lh-body | 1.55 |
| --measure | 32em |
| --radius | 0 |
| --rule-w | 1px |

## Allowances

本风格不放开任何全局禁项（无 `deckcraft:allow` 标记 ⇒ 渐变/阴影/圆角全禁）。

## Page Plan
| 页 | rhythm | layout | 一句主旨 |
|---|---|---|---|
| 1 | anchor | S01 | Lumo 口袋投影仪 |
| 2 | anchor | S05 | 掌心大小，影院尺寸 |
| 3 | dense | S03 | 三个大升级 |
| 4 | breathing | S07 | 早期用户怎么说 |
| 5 | dense | S04 | 告别笨重投影 |
| 6 | dense | S10 | 规格一览 |
| 7 | anchor | S08 | 秋季见 |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · 标题下划线
- 未在 Allowances 放开的：渐变 · box-shadow · 圆角
- 风格专属：霓虹渐变 · 发光效果 · 深底配纯黑文字区块
