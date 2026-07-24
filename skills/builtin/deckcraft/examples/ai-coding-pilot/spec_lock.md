# spec_lock — AI 编程助手落地实践——从试点到规模化

> 执行契约样例：**每批页面生成前重读本文件**，所有颜色/字号/骨相判断只能来自这里与 tokens.css。
> 格式定义见 `references/spec-lock-format.md`。

## Style
- 风格：`swiss-minimal`（温度：中性）· 冷静克制的瑞士网格——层级靠字号/字重/留白，不靠装饰
- 字体配对：`sans-neutral`
- 关键纪律：
  - 左对齐为主，禁全页居中（封面/章节/收尾除外）
  - accent bar 是招牌笔触：每页标题区一条 48×8px
  - 总有彩色数 ≤2，accent 每页 ≤2 处
  - 所有元素贴 8px 模数
- Signature id：`accent-bar`
- **Signature（非可选）**：48×8px accent bar + 全大写拉字距 kicker——少了这两笔就不是这套系统

## Canvas
- 1280×720 · 页边距 64px · 8px 间距模数

## Colors（唯一 HEX 来源 = tokens.css，本表是它的可读镜像）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #FAFAFA | 页面底色 |
| --c-bg2 | #EFEFF1 | 次级底/分区底 |
| --c-primary | #1F2933 | 深色底与结构元素（data-dark 页背景） |
| --c-head | #1F2933 | 标题/栏头/表头墨色 |
| --c-accent | #B23F0B | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #5C6773 | 弱化：辅助线、次级标签 |
| --c-text | #111820 | 正文墨色 |
| --c-on-dark | #F7F7F8 | data-dark 页上的文字 |
- 色彩论证：石墨蓝主色取自工程语境的冷静基调，暖橙 accent 只点关键增幅数字——全 deck 唯一的「响」处

## Typography
- `--font-display`："Helvetica Neue","Segoe UI","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif
- `--font-stack`："Helvetica Neue","Segoe UI","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif
- 字号 ramp：display 64px / h1 44px / h2 30px / h3 24px / body 21px / num 80px / caption 14px
- 字重：head 700 / sub 500 / body 300；中文强调靠字重 + accent 色，禁斜体

## Structure（骨相 token）
| 变量 | 值 |
|---|---|
| --sl-pad | 64px |
| --bar-w | 48px |
| --bar-h | 8px |
| --kicker-transform | uppercase |
| --kicker-spacing | .25em |
| --fw-head | 700 |
| --fw-sub | 500 |
| --fw-body | 300 |
| --lh-body | 1.65 |
| --measure | 36em |
| --radius | 0 |
| --rule-w | 1px |

## Allowances

本风格不放开任何全局禁项（无 `deckcraft:allow` 标记 ⇒ 渐变/阴影/圆角全禁）。

## Page Plan
| 页 | rhythm | layout | 一句主旨 |
|---|---|---|---|
| 1 | anchor | S01 | AI 编程助手落地实践 |
| 2 | dense | S03 | 为什么是现在 |
| 3 | breathing | S02 | 试点怎么做的 |
| 4 | dense | S04 | 试点设计：两组对照，真实需求 |
| 5 | dense | S06 | 八周试点节奏 |
| 6 | anchor | S05 | 试点组交付效率显著领先对照组 |
| 7 | dense | S04 | 规模化两条路线的取舍 |
| 8 | dense | S03 | 三个已识别的风险与对策 |
| 9 | breathing | S07 | 试点成员引言 |
| 10 | anchor | S08 | 收尾 |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · 标题下划线
- 未在 Allowances 放开的：渐变 · box-shadow · 圆角
- 风格专属：圆角卡片 · 色块堆叠 · 图标装饰
