# blueprint-tech — 蓝图

**气质**：像一张施工图。每个元素都像被标注过，一切有坐标。

## 用色行为（HEX 在 spec_lock 产出，这里只定行为）
- 底色深蓝（普鲁士蓝/午夜蓝一族），是蓝图纸的反相
- on-dark 文字用冷白，带极轻的蓝调
- 强调色一个：高明度青或黄，只标关键节点与数值
- muted 是冷白的低透明档，用来画网格线与标注线

## 排版纪律
- 标题等宽或黑体，字距略开；正文黑体
- **标注式 kicker**：坐标/编号/版本号写在元素旁，像图纸标注
- 细网格线（1px，低透明）可以露骨——它是本风格的纹理

## Do / Don't
- Do：细网格、标注式小字、等宽数值、坐标感排布
- Don't：暖色、圆角、手绘感、装饰性插图

## CJK 适配
- 深底冷白，中文字重 ≥400
- 标注文字用 caption 字号 + muted；中文标注不加字距

## 骨相 token（写进 tokens.css §Structure；值即本风格的"骨"）

| 变量 | 值 | 为什么是它 |
|---|---|---|
| --sl-pad | 64px |  |
| --bar-w / --bar-h | 16px / 16px | 16×16 正方形节点标记——**招牌**，是图纸上的定位点不是色条 |
| --kicker-transform / --kicker-spacing | uppercase / .25em |  |
| --fw-head / --fw-sub / --fw-body | 700 / 500 / 400 |  |
| --lh-body | 1.6 |  |
| --measure | 34em |  |
| --radius / --rule-w | 0 / 1px |  |

推荐字体配对：`mono-display`（见 typography-cjk.md §字体配对）

> **Allowances**：本风格不放开任何全局禁项。

## Signature（非可选）

`data-signature="grid-mark"` —— **16×16 正方形定位点 + 细网格线纹理**。
把方点改回横条、把网格去掉，就退回普通深色 deck；蓝图的秩序感全在这两处。
