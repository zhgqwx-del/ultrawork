# 中文 / CJK 排版规范（一等公民）

## 字体栈

- **西文在前、中文在后**：`"Helvetica Neue","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif`。font-family 逐字符匹配——西文字体不含 CJK 码位，汉字自然穿透到中文字体；反过来写，西文字符会被中文字体难看的西文字形吃掉。
- **Windows 无苹方**：栈里必须带 `"Microsoft YaHei"`；Linux 桌面通常有 Noto CJK。
- 衬线风格（学术/编辑部）可换 `"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun"` 一族，同样西前中后。

## 字体配对（ADR-068 D1；`pick_variants.py` 解析本表，id 是 SSOT）

`deck.html` 是**单文件自包含**——**没有任何外链字体**（webfont 会让 PDF/截图/离线预览三条路径同时不可靠）。
所以"配对"选的不是买来的字体，是**系统已有字体族的组合**：`--font-display`（标题/大数字）
× `--font-stack`（正文）。两者可同族（`sans-neutral`），也可异族——**异族是风格辨识度最便宜的一档**。

| id | 气质 | --font-display | --font-stack（正文） |
|---|---|---|---|
| `sans-neutral` | 中性黑体，最稳；商务/技术通吃 | 同正文 | `"Helvetica Neue","Segoe UI","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif` |
| `serif-display` | 衬线标题压黑体正文；学术/编辑部的经典配 | `Georgia,Cambria,"Source Han Serif SC","Noto Serif SC","Songti SC",serif` | 同 `sans-neutral` 正文栈 |
| `serif-full` | 全衬线；长文讲义、人文叙事 | 同正文 | `Georgia,Cambria,"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun",serif` |
| `mono-display` | 等宽标题 + 黑体正文；技术分享、终端感 | `ui-monospace,"SF Mono",Menlo,Consolas,"Source Han Sans SC","PingFang SC","Microsoft YaHei",monospace` | 同 `sans-neutral` 正文栈 |
| `humanist-display` | 人文无衬线标题，比中性黑体更有性格 | `"Avenir Next",Optima,"Gill Sans MT","Source Han Sans SC","PingFang SC","Microsoft YaHei",sans-serif` | 同 `sans-neutral` 正文栈 |

**写进 tokens.css 时两个都要给**（`--font-display` 缺省回落到 `--font-stack`，见 shell.html）。

### 跨平台诚实标注（选配对时必须知道）

- **中文衬线在 Windows 会退到 SimSun**（无 Noto/思源宋），显示效果明显弱于 macOS 的 Songti SC；
  `serif-full` 用于中文正文时尤其要留意。Linux 需装 `fonts-noto-cjk`（否则整份 deck 中文变方块，
  各门禁量的是盒子不是字形、拦不住——见 SKILL.md Linux 提示）。
- **`humanist-display` 的西文族基本是 macOS 专有**（Avenir Next / Optima），
  Windows/Linux 会退回中性黑体 ⇒ 风格差异在这两个平台上会**打折**。要跨平台稳定就选前四个。
- **等宽族不含 CJK**：`mono-display` 的汉字必然穿透到黑体，这是预期行为不是缺陷——
  等宽性格由西文与数字承担。
- **`font-synthesis:none` 是全局设置**（shell.html）⇒ 没有合成粗体。选配对时确认该族在目标平台
  **有真实 700 字重**，否则 `--fw-head` 与 `--fw-body` 的层级对比会塌掉。中文族里
  PingFang SC / Microsoft YaHei / Songti SC 都有真粗体，思源系需系统装齐字重。

## 假斜体与强调

- `font-synthesis:none` 已在 shell.html 全局设置——中文没有斜体，浏览器机械倾斜极丑。**禁 `font-style:italic`**（validate 硬拦）。
- 中文强调的正确手段（按序优先）：**字重对比**（700 压 300）→ **accent 色**（每页 ≤2 处）→ 底色块。

## 字号与防溢出

- 中文方块字视觉面积大，不能套英文 hero 字号——display 64px 对中文约 16 字上限，超了就改写文案（见 outline-schema.md 字符预算），**绝不为塞下而缩字号**。
- 数字用半角阿拉伯数字 + `font-variant-numeric:tabular-nums`（表格/对齐数字场景），统计数值不用「一二三」。
  **但见下一节：这一行在 Georgia 打头的两个配对上是空操作。**

## 数字字形（选配对之前必须知道）

**Georgia 只有老式数字（old-style figures），没有等高数字，CSS 换不出来。**
0/1/2 是 x 高、3/4/5/7/9 下伸、6/8 上伸 —— 一串 `53.4% / 94.2% / 283.9万` 排在一起
高低参差，在满屏数字的经营/财务 deck 上非常显眼。

实测（headless Chrome 渲染 `0123456789`，五种写法逐像素比）：

| 写法 | 结果 |
|---|---|
| `font-family:Georgia` | 老式数字 |
| `+ font-variant-numeric:tabular-nums` | **与上一行像素完全相同** |
| `+ font-variant-numeric:lining-nums tabular-nums` | **同上，无变化** |
| `+ font-feature-settings:"lnum" 1,"tnum" 1` | **同上，无变化** |
| `font-family:"Helvetica Neue"` | 等高数字 |

`tnum` 管的是**字宽**不是**字形**，而 Georgia 根本没有 `lnum` 可切换。所以：

- **数字密集的 deck（财报/经营分析/指标墙）不要选 `serif-display` / `serif-full`** ——
  这两个配对的 `--font-display` 都是 Georgia 打头，大数字全落在它身上。
- 一定要衬线气质又要整齐数字：把**数字单独交给另一族**，
  例如 `--font-num:"Helvetica Neue","Segoe UI",sans-serif` 只用在 `.num` / 表格数值上，
  正文标题仍走衬线栈。**这是有意的混排，要写进 spec_lock 的 Typography 段**，
  否则下一轮走查会当成不一致。
- 老式数字本身不是缺陷 —— 长文正文里它更好看。**它只是和"大数字当主角"这件事冲突。**

## 标点与断行

- 直角引号「」『』；省略号……；破折号——。
- 中文行长 ≤36em（28-32 字最舒适）——shell.html 的 `p,li{max-width:36em}` 已兜底。
- 中英混排时英文两侧留一个空格（如 `主流编码 agent 在内部`），品牌名/专名保持原大小写。

## 中西字重映射

| 用途 | 中文 | 西文 |
|---|---|---|
| display/标题 | 700 | 700 |
| 条目标题 | 500-700 | 500-700 |
| 正文 | 300 | 300 |
| kicker/标签 | 500 + letter-spacing | 500 + letter-spacing（全大写仅限西文） |

中文**永不加 letter-spacing 到正文**（方块字自带节奏）；kicker 若是中文，用小字号 + muted 色即可，不加字距。
