---
name: pdf
description: >
  Use when the deliverable is a PDF itself — 读PDF / 提取PDF文字 / PDF转图片 /
  查看PDF页数与加密状态, or extract text with coordinates, render pages to images,
  and report page geometry / encryption state. Scripted today: page rendering,
  text-with-bounding-box extraction, and document metadata; other PDF work is done
  by driving PyMuPDF directly (see the capability table below, which says plainly
  what does not exist yet). Not for making slide decks from a PDF — that is
  `deckcraft`; not for .docx/.xlsx editing — that is `doc-edit`.
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

**尚未实现**：表格抽取、AcroForm 表单（探测/抽取/填充/越界校验/校验图）、合并拆分抽页旋转、
加密解密、从零生成 PDF、CJK 字体嵌入。清单与欠账理由见同目录 `capabilities.json` 的
`pending` 段；需要这些能力时**直接写 PyMuPDF 代码**，不要假装调用不存在的脚本。

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

加密文件加 `--password`。三个脚本的失败都是 **退出码 2 + 一行人话**，不会静默产出空结果。

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

## 中文

`fixtures/` 里的示例用 PyMuPDF 内置的 `china-s` 写中文，**字形并未嵌入文件**：本机能正常
渲染，换一台缺中文字体的机器就可能是豆腐块。真正的字体嵌入是尚未实现的 P14，生成中文 PDF
之前先确认这一点。

## 自检

```bash
python3 scripts/test-pdf-skill.py            # 仓库根目录下运行；14 条断言 + 逐条负向控制
python3 fixtures/make_fixtures.py            # 仅在示例本身要改时才跑，见下
```

⚠️ `report-cjk.pdf` 是逐字节可复现的（`no_new_id=True` + 固定日期），但 **`locked.pdf` 不是**
（AES 密钥每次不同）。重跑生成脚本会改动它的字节 ⇒ `skills/builtin/.builtin-version` 跟着变 ⇒
所有桌面端重装内置技能。**没有要改示例内容时不要跑它。**
