# 中文 / CJK 排版规范（一等公民）

## 字体栈

- **西文在前、中文在后**：`"Helvetica Neue","Source Han Sans SC","Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif`。font-family 逐字符匹配——西文字体不含 CJK 码位，汉字自然穿透到中文字体；反过来写，西文字符会被中文字体难看的西文字形吃掉。
- **Windows 无苹方**：栈里必须带 `"Microsoft YaHei"`；Linux 桌面通常有 Noto CJK。
- 衬线风格（学术/编辑部）可换 `"Source Han Serif SC","Noto Serif SC","Songti SC","SimSun"` 一族，同样西前中后。

## 假斜体与强调

- `font-synthesis:none` 已在 shell.html 全局设置——中文没有斜体，浏览器机械倾斜极丑。**禁 `font-style:italic`**（validate 硬拦）。
- 中文强调的正确手段（按序优先）：**字重对比**（700 压 300）→ **accent 色**（每页 ≤2 处）→ 底色块。

## 字号与防溢出

- 中文方块字视觉面积大，不能套英文 hero 字号——display 64px 对中文约 16 字上限，超了就改写文案（见 outline-schema.md 字符预算），**绝不为塞下而缩字号**。
- 数字用半角阿拉伯数字 + `font-variant-numeric:tabular-nums`（表格/对齐数字场景），统计数值不用「一二三」。

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
