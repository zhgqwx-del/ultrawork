# spec_lock — HTTP 缓存机制入门（讲义版）

> 执行契约样例：**每批页面生成前重读本文件**，所有颜色/字号/骨相判断只能来自这里与 tokens.css。
> 格式定义见 `references/spec-lock-format.md`。

## Style
- 风格：`academic-calm`（温度：安静）· 学术沉稳：衬线标题、规矩层级、论证优先
- 字体配对：`serif-display`
- 关键纪律：
  - 标题衬线、正文黑体——层级靠字族对比而非字号轰炸
  - kicker 用中文标签，不全大写、不加字距
  - 分隔线 2px，承担论证段落的结构感
  - 每个断言后紧跟 RFC 出处
- Signature id：`serif-rule`
- **Signature（非可选）**：衬线标题压黑体正文 + 56×4 细杠——学术的克制感来自这条不喊叫的横线

## Canvas
- 1280×720 · 页边距 64px · 8px 间距模数

## Colors（唯一 HEX 来源 = tokens.css，本表是它的可读镜像）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #F6F8FA | 页面底色 |
| --c-bg2 | #E8EDF2 | 次级底/分区底 |
| --c-primary | #1B3A57 | 深色底与结构元素（data-dark 页背景） |
| --c-head | #1B3A57 | 标题/栏头/表头墨色 |
| --c-accent | #0E6E82 | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #556676 | 弱化：辅助线、次级标签 |
| --c-text | #15202B | 正文墨色 |
| --c-on-dark | #F3F8FC | data-dark 页上的文字 |
- 色彩论证：深海军蓝取自技术标准文档的传统色，青绿 accent 标注规范条款编号

## Typography
- `--font-display`：Georgia,Cambria,"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",serif
- `--font-stack`："Helvetica Neue","Segoe UI","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif
- 字号 ramp：display 60px / h1 42px / h2 28px / h3 23px / body 21px / num 76px / caption 14px
- 字重：head 700 / sub 500 / body 300；中文强调靠字重 + accent 色，禁斜体

## Structure（骨相 token）
| 变量 | 值 |
|---|---|
| --sl-pad | 64px |
| --bar-w | 56px |
| --bar-h | 4px |
| --kicker-transform | none |
| --kicker-spacing | normal |
| --fw-head | 700 |
| --fw-sub | 500 |
| --fw-body | 300 |
| --lh-body | 1.75 |
| --measure | 34em |
| --radius | 0 |
| --rule-w | 2px |

## Allowances

本风格不放开任何全局禁项（无 `deckcraft:allow` 标记 ⇒ 渐变/阴影/圆角全禁）。

## Page Plan
| 页 | rhythm | layout | 一句主旨 |
|---|---|---|---|
| 1 | anchor | S01 | HTTP 缓存机制入门 |
| 2 | dense | S03 | 四个关键缓存指令 |
| 3 | dense | S04 | 强缓存 vs 协商缓存 |
| 4 | dense | S10 | 常用缓存头速查表 |
| 5 | dense | S06 | 一次请求的缓存决策 |
| 6 | dense | S03 | 三个常见误区与纠正 |
| 7 | anchor | S08 | 把缓存当契约来设计 |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · 标题下划线
- 未在 Allowances 放开的：渐变 · box-shadow · 圆角
- 风格专属：装饰性图形 · 情绪化措辞
