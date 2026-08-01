---
name: pdf
description: >
  Use when the deliverable is a PDF itself — 读PDF / 提取PDF文字 / PDF转图片 /
  查看PDF页数与加密状态 / 填PDF表单, or extract text with coordinates, render pages
  to images, report page geometry and encryption state, and fill forms (AcroForm
  fields when the file has them, anchored text overlay when it does not) with an
  overflow check and a colour-coded proof sheet. Scripted today: rendering, text +
  bbox extraction, metadata, and the form family; anything else is done by driving
  PyMuPDF directly (the capability table below says plainly what does not exist
  yet). Not for making slide decks from a PDF — that is `deckcraft`; not for
  .docx/.xlsx editing — that is `doc-edit`.
x-requires: [python3, pymupdf]
---

# PDF 技能

由 ultrawork 自写（非 Anthropic 专有文档技能、也非 OpenAI 版的改写）。所有脚本基于
**PyMuPDF**（`import fitz`）。

## 依赖

```
python3 -m pip install pymupdf
```

PyMuPDF 是 **AGPL-3.0 或商业授权**。ultrawork **不打包**它，由用户机器自行安装，技能脚本
只是 `import fitz`（与 deckcraft 的既有做法一致）。

## 现在有什么（其余的没有，别假装有）

| 能力 | 脚本 | 说明 |
|---|---|---|
| 页面渲染成图 | `scripts/pdf_render.py` | 可控 DPI 与页范围，输出 PNG/JPG |
| 文字 + 坐标抽取 | `scripts/pdf_extract.py` | word / line / block 三种粒度，可选画框校验 PDF |
| 元数据 | `scripts/pdf_info.py` | 页数、逐页尺寸与旋转、加密态与权限位 |
| 表单探测与字段抽取 | `scripts/pdf_form_inspect.py` | 有没有 AcroForm；字段类型/选项/长度上限/标志/坐标 |
| 表单填充 | `scripts/pdf_form_fill.py` | 有域走 AcroForm，无域按锚点或坐标叠加 |
| 越界校验与校验图 | `scripts/pdf_form_check.py` | 值有没有超出字段框；产出逐字段标色的 PDF |

**尚未实现**：表格抽取、合并拆分抽页旋转、加密解密、从零生成 PDF、CJK 字体嵌入。
清单与欠账理由见同目录 `capabilities.json` 的 `pending` 段；需要这些能力时
**直接写 PyMuPDF 代码**，不要假装调用不存在的脚本。

## 用法

```bash
# 渲染第 1 和第 3 页，220 DPI
python3 scripts/pdf_render.py --in report.pdf --out ./png --pages 1,3 --dpi 220

# 按行抽取文字与坐标，并产出画框副本用于肉眼核对
python3 scripts/pdf_extract.py --in report.pdf --out text.json \
        --granularity line --overlay boxes.pdf

# 页数 / 尺寸 / 加密态
python3 scripts/pdf_info.py --in report.pdf --out info.json
```

### 填表

```bash
# 1. 先问这份 PDF 有没有可填域 —— 决定走哪条路，不要猜
python3 scripts/pdf_form_inspect.py --in form.pdf --summary

# 2a. 有 AcroForm：按字段名填
python3 scripts/pdf_form_fill.py --in form.pdf --out filled.pdf \
        --values values.json --report fill.json

# 2b. 没有 AcroForm：按锚点文字或显式坐标叠加
python3 scripts/pdf_form_fill.py --in flat.pdf --out filled.pdf \
        --values placements.json --mode overlay --report fill.json

# 3. 校验：值有没有被框裁掉，并出一张标色的校验图
python3 scripts/pdf_form_check.py --in filled.pdf --report fill.json \
        --out overflow.json --proof proof.pdf
```

`--mode auto`（默认）按有没有 AcroForm 自动选路，并在报告里写明选了哪条。
**它不会在 AcroForm 填充失败后偷偷改走叠加** —— 有域却对不上字段名，那是 values 文件写错了，
把字迹画在上面只会把错误藏起来。

`--report` 写出的填充记录是这一族的中枢：**AcroForm 填的和叠加填的产生同一种记录**
（名字/页码/两套坐标/文本），所以 `pdf_form_check.py` 不必关心是哪条路填的。叠加出来的字
在文件里不是「域」，没有这份记录就无从校验。

拒绝写入的几种情况（都是退出码 2，宁可报错也不产出「看着填好了」的文件）：
字段名不存在 · 值不在下拉选项里 · 超过 `/MaxLen` · 锚点找不到或出现多次 · 叠加文字放不进给定的框。

### 越界校验量了两件事

- **自然宽度**：这串字在这个字号下**需要**多宽。抓的是阅读器直接裁掉、光看渲染图完全正常、
  值其实已经不见了的情况。
- **实际落点**：字形**真正**画在哪。抓的是文字被画到框外，宽度计算看不见的情况。

上下方向的容差**不对称**，因为两个方向不是一回事（实测：正确填充的字最多会超出**上沿** 1.04pt，
那是字形 ascent；而超出**下沿**的只有真正装不下的多行值，实测 +3.65pt）。
复选框这类没有文本长度可言的域记为 `not_applicable` 并单独计数 —— **「量不了」绝不能混进「没问题」**。

加密文件加 `--password`。所有脚本的失败都是 **退出码 2 + 一行人话**，不会静默产出空结果。

## 两个坐标系（用错就是把框画在白纸上）

`pdf_extract.py` 每个条目给**两个**框，单位都是 point、原点左上、y 向下：

- `bbox` —— **页面坐标系**（未旋转）。往 PDF 里写东西（`draw_rect`、加注释）用它。
- `bbox_display` —— **显示坐标系**（旋转后）。和 `pdf_render.py` 出的图一致，乘 `dpi/72`
  即可落到像素上。

只有 `/Rotate ≠ 0` 的页两者才不同。实测 `fixtures/report-cjk.pdf` 第 3 页（旋转 90°）：
抽出的框是 `(60, 75, 450, 93)`，而文字实际渲染在 `(502, 60, 520, 450)` —— 前者框内只有
36 个暗像素，后者 2282 个。**只给一个框并含糊说「就是那个坐标」，就是叠加图画到空白处的
由来。**

## 页码约定

`pdf_render.py` 的输出按**源页号**命名（`page-003.png` 永远是第 3 页），不是按输出顺序
1..n 编号 —— 否则 `--pages 1,3` 之后「第二张图」和「第 2 页」是两回事。

## 表单的已知边界

- **不做单选按钮组的创建**：PyMuPDF 1.27 给已存在的 radio 字段加第二个 widget 会抛
  `bad xref`。**读**第三方表单里的 radio 正常，字段模型也认这个类型。
- AcroForm 里的中文能正常渲染（实测字形中心着墨 1.00），但外观流是 PyMuPDF 生成的；
  换一个会自己重建外观的阅读器行为未验证。

## 中文

`fixtures/` 里的示例用 PyMuPDF 内置的 `china-s` 写中文，**字形并未嵌入文件**：本机能正常
渲染，换一台缺中文字体的机器就可能是豆腐块。真正的字体嵌入是尚未实现的 P14，生成中文 PDF
之前先确认这一点。

## 自检

```bash
python3 scripts/test-pdf-skill.py            # 仓库根目录下运行；20 条断言 + 逐条负向控制
python3 fixtures/make_fixtures.py            # 仅在示例本身要改时才跑，见下
```

⚠️ `report-cjk.pdf` 是逐字节可复现的（`no_new_id=True` + 固定日期），但 **`locked.pdf` 不是**
（AES 密钥每次不同）。重跑生成脚本会改动它的字节 ⇒ `skills/builtin/.builtin-version` 跟着变 ⇒
所有桌面端重装内置技能。**没有要改示例内容时不要跑它。**
