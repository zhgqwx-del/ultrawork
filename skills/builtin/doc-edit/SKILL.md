---
name: doc-edit
description: Use when the user wants to READ or MODIFY existing Microsoft Office files (.docx Word, .xlsx Excel, .pptx PowerPoint) in place — extract text/tables, find-and-replace, set cell values, append rows/paragraphs/slides. For generating new documents from Markdown use the `doc-export` skill; for PDF use the `pdf` skill.
x-requires: [python3]
---

# Office 文档读改 (doc-edit)

读取与就地修改已有的 `.docx` / `.xlsx` / `.pptx` 文件。基于成熟 FOSS 库：
`python-docx`、`openpyxl`、`python-pptx`（MIT/BSD）。本技能由 ultrawork 自写（非 Anthropic 专有文档技能）。

## 依赖（缺失时安装）
```bash
python3 -m pip install python-docx openpyxl python-pptx
# 或 uv pip install python-docx openpyxl python-pptx
```
脚本在依赖缺失时会向 stderr 打印缺失库名并以非零码退出——据此提示用户安装。

## 何时用本技能
- 已有 Office 文件，需**抽取内容**（段落/表格/单元格/幻灯片大纲）→ 用 `*_read.py`
- 已有 Office 文件，需**就地改动**（替换文本/写单元格/加行/加段/加页）→ 用 `*_edit.py`
- 需要**从零按 Markdown 生成**文档 → 改用 `doc-export` 技能（本技能不做生成）

## 脚本一览（均 argv 驱动，相对本技能 scripts/ 目录）
读取（输出到 stdout，`--json` 可得结构化）：
```bash
python3 scripts/docx_read.py <file.docx> [--json]
python3 scripts/xlsx_read.py <file.xlsx> [--sheet NAME] [--json]
python3 scripts/pptx_read.py <file.pptx> [--json]
```
修改（默认就地写回；`--out NEW` 另存）：
```bash
# Word：全局替换 / 末尾追加段落
python3 scripts/docx_edit.py <file.docx> --replace "旧" "新"
python3 scripts/docx_edit.py <file.docx> --append-paragraph "新段落文本" [--out out.docx]

# Excel：按 A1 引用写单元格 / 追加一行
python3 scripts/xlsx_edit.py <file.xlsx> --set Sheet1!B2 "值" [--set Sheet1!C2 123]
python3 scripts/xlsx_edit.py <file.xlsx> --append-row Sheet1 a b c [--out out.xlsx]

# PowerPoint：替换全文中文本 / 在某版式后加一页含标题
python3 scripts/pptx_edit.py <file.pptx> --replace "旧" "新"
python3 scripts/pptx_edit.py <file.pptx> --add-slide --layout 1 --title "标题" [--out out.pptx]
```

## 工作流建议
1. 先 `*_read.py` 看清结构（标题、表格、单元格、幻灯片索引），再决定改动。
2. 重要改动用 `--out` 另存，核对无误再覆盖原文件。
3. 改完用对应 `*_read.py` 复核结果。
4. 复杂排版/图片/样式超出脚本能力时，python-docx/openpyxl/python-pptx 的完整 API 仍可直接编写代码完成——脚本只覆盖高频操作。

## 限制
- 不渲染、不转 PDF（需要 PDF 用 `pdf` 技能，需要从 Markdown 生成用 `doc-export`）。
- `.doc`/`.xls`/`.ppt` 旧二进制格式不支持（先转 `.docx`/`.xlsx`/`.pptx`）。
- find-and-replace 以 run/段落文本为单位，跨 run 的富文本替换可能漏匹配——必要时改用完整 API。
