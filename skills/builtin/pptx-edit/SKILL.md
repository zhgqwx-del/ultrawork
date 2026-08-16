---
name: pptx-edit
description: >
  Use when an EXISTING .pptx must be changed in place — 读pptx / 看幻灯片大纲 /
  替换PPT里的文字 / 给PPT加一页, or dump the slide outline (layout name + the text of
  each top-level shape) and do two edits only: global find-and-replace, and append one
  slide from a layout with a title. That is the whole capability surface — it does NOT
  restyle, reformat, resize, add images/charts/tables, or touch the master. Not for
  MAKING a deck from a topic or a source document — that is `deckcraft`; not for
  beautifying an existing deck, applying a brand template or building template packs —
  install `ppt-master` from 设置 → 技能. For .docx use `docx`, for .xlsx use `xlsx`,
  for PDF use `pdf`, for turning Markdown into HTML/IPYNB/CSV/JSON use `markdown-exporter`.
x-requires: [python3, python-pptx]
---

# PPTX 就地读改 (pptx-edit)

读取与就地修改**已有的** `.pptx`。基于 `python-pptx`（MIT）。本技能由 ultrawork 自写
（非 Anthropic 专有文档技能）。刻意保持「薄」：只覆盖两个高频操作，复杂场景直接写
python-pptx API 代码。

## 路由边界（先于一切判断）

| 用户意图 | 归属 |
|---|---|
| 已有 pptx，改几处文字 / 追加一页 / 看看里面写了什么 | ✅ 本技能 |
| 从主题或源文档**做一份新** deck（PPT / 演示文稿 / 幻灯片） | ❌ `deckcraft` |
| 美化已有 pptx（1:1 保页序文字）/ 套品牌 pptx 模板 / 建模板包 | ❌ `ppt-master`——告知用户可在「设置 → 技能」安装 |
| Word / Excel / PDF | ❌ 分别是 `docx` / `xlsx` / `pdf` |
| Markdown → HTML / IPYNB / CSV / JSON / XML 等长尾格式 | ❌ `markdown-exporter` |

## 依赖（缺失时安装）

```bash
python3 -m pip install python-pptx
# 或 uv pip install python-pptx
```

脚本在依赖缺失时向 stderr 打印缺失库名并以非零码退出——据此提示用户安装。

## 脚本一览（均 argv 驱动，相对本技能 `scripts/` 目录）

```bash
# 读：打印每页的版式名 + 各形状文字；--json 得结构化
python3 scripts/pptx_read.py <file.pptx> [--json]

# 改：全局替换文字 / 按版式索引追加一页并写标题
#     默认就地写回，--out 另存
python3 scripts/pptx_edit.py <file.pptx> --replace "旧" "新" [--replace "旧2" "新2"]
python3 scripts/pptx_edit.py <file.pptx> --add-slide --layout 1 --title "标题" [--out out.pptx]
```

## 工作流建议

1. 先 `pptx_read.py` 看清页序、版式名与文字，再决定改哪里。
2. 重要改动用 `--out` 另存，核对无误再覆盖原文件。
3. 改完再 `pptx_read.py` 复核。
4. **一次都没改到时不会写文件**（2026-08-16 起）：`--replace` 的匹配数为 0 且没有
   `--add-slide` 时，脚本打 `Unchanged <文件> (replacements: 0, …)` 并**不碰原文件**。
   在此之前它照样重写——实测重写会让 zip 条目重排、时间戳全部重置（内容那次没丢，
   但一次没丢不等于不会丢；重写本身没有任何收益）。**给了 `--out` 则仍产出那份副本**，
   哪怕它只是一份原样拷贝。
5. **超出下面「限制」的场景不要硬用本技能**——直接写 python-pptx 代码，或按路由表转交。

## 限制（每条都是在本技能上实测出来的，不是推断）

- **表格单元格里的文字既读不出、也替换不到**。实测：一张 2×2 表格里的
  `营业收入同比增长`，`pptx_read.py` 的输出里完全没有它，`--replace` 也不会改到它。
  组合形状（group）内的文字同理——实测一个只含组合形状的页面，读出来是空的。
  原因是两个脚本都只遍历顶层 shape、且只处理 `has_text_frame` 为真的那些，而表格是
  GraphicFrame、组合是 GroupShape，两者的 `has_text_frame` 都是 `False`。
  **这条限制不变，本技能不打算伸进表格改字**（合并单元格、跨 run、嵌套组合是另一件
  工程）——超出时按下面说的绕开本技能。
- **⚠️ 但漏掉什么会明说（2026-08-16 起）**。两个脚本都不再对看不见的东西沉默：
  - `pptx_read.py` 在有表格/组合的页后面打一行 `[unread] 本页另有本脚本读不到的元素：…`，
    并在末尾汇总。`--json` 里每页多一个 `unread` 字段、顶层多一个 `unread_total`。
    **它只报「有几个」，不报里面的字**——内容仍然读不到。
  - `--replace` 除了 `replacements: N`，还会打 `[!] 另有 N 处「…」在本脚本改不到的位置`。
    `replacements: N` 只能往上数，单看它，「一处都没漏」和「漏了九处」长得一模一样。
  - 没有漏时**不打任何提示**——每次都响的警告等于没有警告。
  改这些位置：用 python-pptx 走 `shape.table.rows[].cells[].text_frame` 与
  `shape.shapes[]`（组合，可嵌套），并**按 run 改**（`run.text = ...`）以保留原格式；
  整格赋值（`cell.text = ...`）会丢掉 run 级格式。
- **跨 run 的短语替换不到**。PowerPoint 会把一句话按格式切成多个 run，而替换以单个 run
  的文本为单位。实测：`毛利率保持稳定` 被切成 `毛利` + `率保持稳定` 两个 run 时，
  `--replace 毛利率 …` 匹配数为 0。（`docx` 技能对 Word 解决了这个问题，本技能没有。）
- **⚠️ 读大 deck 会往 stdout 打很多字节，没有上限**。实测：10 页约 **5.2 KB** · 20 页约
  **10.5 KB** · 60 页（每页 6 段）**87 KB**。在 Team 委派下 stdout 要跨委派边界、逐字节吃
  上下文。**超过 20 页的 deck，先想清楚是不是真的需要全文**；只关心某几页时，直接写
  python-pptx 代码只取那几页，比读回来再筛便宜得多。
- **`--add-slide` 只加一页并写标题**，不填正文、不加图表图片、不管排版。
  文件本身没有母版时（少数生成器产的 pptx）会**明确报错退出**，不会崩。
- 少数文件的幻灯片不带版式引用（不是 PowerPoint 产的时候常见）。这时版式名显示为
  `(no layout)`，**正文照读**——版式名只是装饰，不该让整份文档读不出来。
- 不渲染、不转 PDF、不改样式与母版。
- `.ppt` 旧二进制格式不支持（先另存为 `.pptx`）。
