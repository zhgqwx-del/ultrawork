# spec_lock.md 格式 + tokens.css 派生规则

spec_lock 是**执行契约**：设计确认后一次写定，之后每批页面生成前重读，所有颜色/字号/风格判断只能来自它——这是长 deck 对抗上下文漂移的核心机制。

## spec_lock.md 模板（逐节填写）

```markdown
# spec_lock — <deck 标题>

## Style
- 风格：<design-styles 里选定的风格 id> · 一句气质定位
- 字体配对：<typography-cjk.md §字体配对 的 id>
- Signature id：`<风格文件 §Signature 声明的 id>`
- **Signature（非可选）**：<从风格文件抄那一句"少了这一笔就不是这套系统">
- 关键纪律：<从风格文件抄 3-5 条本 deck 最相关的>

> Signature 必须在页面上真的出现：至少一页带 `data-signature="<id>"`（validate_deck W4 查存在性；
> 它**读起来**对不对是 visual-review R8 的判断）。**招牌笔触用 `class="bar"` 等结构类承载，
> 不要内联硬编码尺寸**——内联 `width:48px;height:8px` 会绕开 `--bar-w`/`--bar-h`，
> 骨相 token 对那些页就完全失效（ADR-068 实施期在四个 example 里发现 19 处这种手抄版）。

## Canvas
- 1280×720 · 页边距 64px · 8px 间距模数

## Colors（唯一 HEX 来源）
| 变量 | 值 | 用途 |
|---|---|---|
| --c-bg | #XXXXXX | 页面底色 |
| --c-bg2 | #XXXXXX | 次级底/分区底 |
| --c-primary | #XXXXXX | 主色：**深色底与结构元素**（`data-dark` 页背景由它承担） |
| --c-head | #XXXXXX | **标题/栏头墨色**（h3 条目标题、S04 栏头、S10 表头）。浅底风格通常 = `--c-primary`；**深底风格必须是浅色**（否则深字压深底 ≈ 隐形，对比度门禁硬拦） |
| --c-accent | #XXXXXX | 强调：关键数字/强调词，每页 ≤2 处 |
| --c-muted | #XXXXXX | 弱化：辅助线、次级标签 |
| --c-text | #XXXXXX | 正文墨色 |
| --c-on-dark | #XXXXXX | 深色底上的文字 |
- 色彩论证：一句话说明主色/强调色为何是它（品牌/内容/语境来源）。写不出这句 = 在抄配方，重推。

## Typography
- 字体栈：--font-stack（西文在前中文在后；配对表见 typography-cjk.md §字体配对）
- 字号 ramp：--fs-display / --fs-h1 / --fs-h2 / --fs-h3 / --fs-body / --fs-num / --fs-caption
- 字重：从风格文件的字重档取（`--fw-head`/`--fw-sub`/`--fw-body`）；中文强调靠字重 + accent 色，禁斜体

## Structure（骨相 token —— 风格之间真正的结构差异，不写就退回默认值）

> **值从选定风格文件的「骨相 token」表抄，别自创。** 其中四个与字符预算耦合，
> 只能取下面的**标定档位**（`validate_outline` O10 硬拦越界值）：
>
> | 变量 | 合法档位 |
> |---|---|
> | --sl-pad | 48 / 56 / 64 / 72 / 80 px |
> | --fw-body | 300 / 400 / 500 |
> | --lh-body | 1.45 / 1.5 / 1.55 / 1.6 / 1.65 / 1.75 / 1.85 |
> | --measure | 28–44 em（偶数档） |
>
> **规则：几何只会收紧预算，不会放宽**（缩放上限 1.0）。版心变宽/行距变大 ⇒ 字符预算与
> 条目数按比例下调；反之**不会**给你更多字数——上界是审美上界（ADR-066），密度旋钮是
> `delivery_purpose`，不是骨相。写完 tokens.css **必须重跑 `validate_outline`**，它会打印
> 实际生效的几何与预算（`geometry: pad=… → char×0.89 …`）。

| 变量 | 值 | 默认 | 说明 |
|---|---|---|---|
| --sl-pad | | 64px | 页边距（版心）；8px 模数 |
| --bar-w / --bar-h | / | 48px / 8px | accent bar 尺寸——**招牌笔触的形态**，各风格务必区分 |
| --kicker-transform | | uppercase | `uppercase`（西文标签）/ `none`（中文标签或不喊叫的风格） |
| --kicker-spacing | | .25em | kicker 字距；`none` 档配 `normal` |
| --fw-head / --fw-sub / --fw-body | / / | 700 / 500 / 300 | 字重三档——**中文层级主轴**；深底正文不低于 400（见 typography-cjk） |
| --lh-body | | 1.65 | 正文行高（编辑部可 1.8、密集档可 1.5） |
| --measure | | 36em | 正文行长上限 |
| --radius | | 0 | 圆角半径；仅当本风格 Allowances 放开时可 >0 |
| --rule-w | | 1px | 细分隔线宽 |

## Allowances（本风格显式放开的全局默认禁项，ADR-068 D4）
默认全禁。要放开必须在**本节写明理由**，并在 spec_lock 里放一行机器可读标记：

```
<!-- deckcraft:allow gradient,shadow -->
```

- 可放开项仅两个：`gradient`（渐变）· `shadow`（box-shadow）。**白名单式，逐项列举，不支持通配。**
- **放开渐变不等于放开字面色**：渐变色标同样只能用 `var(--c-*)`
  （`linear-gradient(90deg, var(--c-primary), var(--c-bg2))`），字面 `rgb()/#hex` 仍被 E1 硬拦。
  探针会把渐变的**两端各算一次对比度、按更差的那端判**（ADR-068 D6）——
  所以「深色→浅色」的大跨度渐变上放浅字会被拦下，这是对的。
- **永不可放开**：斜体（CJK 无斜体，浏览器机械倾斜——物理正确性问题非审美）· 下划线装饰 · palette 外字面颜色 · ramp 外字号。
- 没有这行标记 = 全禁（validate_deck E4 硬拦）。**不写理由就别放开**——这是"克制本身就是风格"的最后一道自律。

## Page Plan（逐页节奏表，来自 outline.json）
| 页 | rhythm | layout | 一句主旨 |
| ... |

## Forbidden
- 任何 palette 外颜色（字面 hex/rgb/hsl）· ramp 外字号 · 斜体 · emoji
- breathing 页卡片网格 · 标题下划线
- 未在 Allowances 里放开的：渐变 · box-shadow · 圆角
- <可加风格专属禁项>
```

## tokens.css 派生（机械转换，写完 spec_lock 立即做）

把 Colors + Typography 两节转成一个 `:root` 块存 `<project>/tokens.css`，是 deck 里**唯一**允许出现字面 HEX 的地方：

```css
:root{
  --c-bg:#FBF9F4; --c-bg2:#F1EDE3; --c-primary:#14424E; --c-head:#14424E; --c-accent:#C75B12;
  --c-muted:#6E8887; --c-text:#1C1B18; --c-on-dark:#F7F4EC;
  --font-stack:"Helvetica Neue","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  --font-display:"Helvetica Neue","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;
  --fs-display:64px; --fs-h1:44px; --fs-h2:30px; --fs-h3:24px;
  --fs-body:21px; --fs-num:80px; --fs-caption:14px;
  /* 骨相 token（ADR-068 D3）——写全 12 个，别只改颜色 */
  --sl-pad:64px; --bar-w:48px; --bar-h:8px;
  --kicker-transform:uppercase; --kicker-spacing:.25em;
  --fw-head:700; --fw-sub:500; --fw-body:300;
  --lh-body:1.65; --measure:36em; --radius:0; --rule-w:1px;
}
```

规则：
- **八个** `--c-*` 与七个 `--fs-*` + `--font-stack`/`--font-display` 一个不能少（shell.html 结构层依赖它们）
- **深浅两套语义必须自己算清楚**：`--c-bg` 深 ⇒ `--c-text`/`--c-head`/`--c-muted` 全部要浅、
  `--c-primary` 留在底色家族（它只当 `data-dark` 页背景与结构元素，不当墨色）。
  「深色风格把 --c-bg 设为深色即可」是**错的**——那句旧描述在四个浅底 example 下从未被验证过，
  照做会让标题墨色压在同深度底上（ADR-068 实测发现，ADR-067 对比度门禁会拦下来）。
- **十二个骨相 token 也要写全**（`--sl-pad` `--bar-w` `--bar-h` `--kicker-transform` `--kicker-spacing`
  `--fw-head` `--fw-sub` `--fw-body` `--lh-body` `--measure` `--radius` `--rule-w`）。
  shell.html 带兜底值 ⇒ 缺了不会崩，但**缺了就等于这份 deck 只换了颜色**——validate_deck 会
  报 W3 提醒你。**别照抄上面这一行示例值**，那是 swiss-minimal 的骨相；按选定风格文件的
  「骨相 token」表取值。
- 字号 ramp 可按风格微调（±4px 级），但生成开始后**永不再动**

## 色彩推导协议（写 Colors 前走三步）

1. **采样**：主色来自品牌资产 / 内容语境 / 文化色彩记忆，不凭空发明
2. **收敛**：2-3 个有彩色 + 中性明度序列，避开禁用色（见 content-guidelines.md）
3. **论证**：写出「为什么是这个色」一句话进 spec_lock
