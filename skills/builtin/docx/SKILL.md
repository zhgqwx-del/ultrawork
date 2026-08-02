---
name: docx
description: >
  Use when the deliverable is a Word document itself — 读docx / 提取Word正文表格 /
  就地替换文字 / 追加段落 / Word模板占位符填充 / 查看修订和批注 / Word转PDF预览 /
  Word修订接受拒绝 / 跟踪修改 / Word批注增删 / Word文档拆包重打包 /
  修复Word打不开提示修复 / docx元素顺序错误, or read a .docx
  (paragraphs, tables, styles, list levels, sections, headers, footers, tracked
  revisions and comments), replace text IN PLACE even when Word has split the phrase
  across several runs, fill {{placeholder}} templates including the ones in the
  letterhead, append paragraphs without destroying the section properties, render to
  PDF so the result can be previewed at all, make edits AS TRACKED CHANGES and
  accept or reject existing ones in pure Python, add and remove comments, unpack and
  repack the OOXML package
  byte-for-byte, and repair ECMA-376 element order in a document Word offers to
  "repair". Not for spreadsheets — that is `xlsx`; not for PDFs — that is `pdf`;
  not for turning a document into slides — that is `deckcraft`.
x-requires: [python3, lxml, soffice]
---

# DOCX 技能

由 ultrawork 自写（非 Anthropic 专有文档技能、也非任何参考实现的改写）。

## 依赖

```
python3 -m pip install lxml
```

外加 **LibreOffice**（命令行 `soffice`）。没装的话本技能在设置页显示「未就绪」——
理由和 xlsx 一样：**docx 在应用内无法预览**，转成 PDF 是产物能被看见的唯一通道。

**这里没有 `python-docx`，这是有意的。** 见下面「为什么不用 python-docx」。

## 现在有什么（19 项里的 10 项，其余的没有，别假装有）

| 能力 | 脚本 | 说明 |
|---|---|---|
| 读结构 / 正文 / 表格 | `scripts/docx_read.py` | 段落级文本、表格网格、列表层级、章节、页眉页脚、修订、批注 |
| 就地替换文字 | `scripts/docx_edit.py --replace` | **跨 run 匹配**，见下 |
| 追加段落 | `scripts/docx_edit.py --append-paragraph` | 落在 `<w:sectPr>` **之前** |
| 模板填充 | `scripts/docx_template.py` | `{{占位符}}`，**默认连页眉页脚一起填**，见下 |
| 拆包 / 重打包 | `scripts/docx_package.py --unpack/--pack` | 逐字节、保持 part 顺序 |
| 元素顺序修复 | `scripts/docx_package.py --fix-order` | ECMA-376 子元素序 |
| 写修订（跟踪修改） | `scripts/docx_revise.py --replace/--delete/--insert-paragraph` | 原文留在 `<w:del>` 里，见下 |
| 接受 / 拒绝修订 | `scripts/docx_revise.py --accept-all/--reject-all/…` | **纯 Python**，不需要 Word |
| 批注增 / 删 / 读 | `scripts/docx_comment.py` | 一条批注是**五样东西** |
| 转 PDF / 页面图 | `scripts/docx_pdf.py` | 应用内**唯一**可见通道 |

`capabilities.json` 里另有 **9 项 pending，逐条写了理由** ——
从 Markdown 生成、页眉页脚创建、目录、图片插入、样式管理、XSD 校验、字体巡检、
文档 diff、排版预设。
**pending 写的不是「快好了」，是「还没有断言在证明它」。**

## 用法

```bash
# 结构总览（不含正文，输出很小）
python3 scripts/docx_read.py --in report.docx

# 逐段 + 表格 + 完整正文
python3 scripts/docx_read.py --in report.docx --outline --tables --text --out doc.json

# 就地替换（跨 run），可同时改页眉页脚
python3 scripts/docx_edit.py --in report.docx --out out.docx \
        --replace "第三季度=第四季度" --replace "{{客户名称}}=示例公司" --in-headers

# 追加段落
python3 scripts/docx_edit.py --in report.docx --out out.docx \
        --append-paragraph "结论：维持增长预期。" --style Heading1

# 模板填充（{{占位符}}），--strict = 有一个没填上就拒绝写
python3 scripts/docx_template.py --in contract.docx --list
python3 scripts/docx_template.py --in contract.docx --out filled.docx \
        --set 客户名称=示例科技 --set 日期=2026-08-02 --strict

# 转 PDF（应用内唯一能预览的形式）
python3 scripts/docx_pdf.py --in report.docx --out report.pdf --png ./pages --dpi 150

# 写成跟踪修改（原文保留在 w:del 里），再交给别人接受或拒绝
python3 scripts/docx_revise.py --in a.docx --out b.docx --author 张三 \
        --replace "第三季度=第四季度"
python3 scripts/docx_revise.py --in b.docx --list
python3 scripts/docx_revise.py --in b.docx --out final.docx --accept-all --strict
python3 scripts/docx_revise.py --in b.docx --out clean.docx --reject-author 张三

# 批注
python3 scripts/docx_comment.py --in a.docx --list
python3 scripts/docx_comment.py --in a.docx --out b.docx \
        --add-on "应收账款余额" --text "请与银行流水核对" --author 李复核
python3 scripts/docx_comment.py --in b.docx --out c.docx --delete 1

# 拆开看看 / 打回去 / 体检 / 修顺序
python3 scripts/docx_package.py --in report.docx --unpack ./unpacked
python3 scripts/docx_package.py --pack ./unpacked --out rebuilt.docx
python3 scripts/docx_package.py --in report.docx --check
python3 scripts/docx_package.py --in messy.docx --fix-order --out fixed.docx
```

## 这个技能与「随手用 python-docx」的差别：一句话不是一个 run

Word 会因为**格式变化、拼写检查、每次保存的修订 id** 把一个段落切成多个
`<w:r>`。你眼里的一句话，文件里经常是三段。于是所有人第一反应写的这段代码：

```python
for p in doc.paragraphs:
    for r in p.runs:
        r.text = r.text.replace(old, new)
```

**找不到跨 run 的那一处**。本技能的示例文件里 `第三季度` 出现两次 ——
标题里那次在一个 run 内，正文里那次被切成 `"2026 年第" | "三季度"`。实测：

| 写法 | 找到几处 |
|---|---|
| 逐 run 替换（所有人的第一反应） | **1 / 2** |
| **本技能**（段落字符流） | **2 / 2**，报告里写明 `cross_run: 1` |

**它之所以能活这么久，正是因为它「部分正确」** —— 一个一处都找不到的工具一分钟内就会
被报 bug；一个十处对九处的工具会一直用下去，直到某份合同里那一处没改到。

三条配套规则：

- **替换继承第一个 run 的格式**。另一种做法（把替换文本按原来几个 run 的格式切开）
  会在用户没要求的地方插入一个格式边界。
- **跨换行/制表符的匹配拒绝执行并点名** —— 穿过去等于悄悄把换行删了。
- **一个字都没匹配上时会说明为什么**（`near_misses`）：短语中间有换行，或者文档里的
  空格不是你打的那种空格。「0 处替换」而不说原因，是最浪费时间的那种回答。

## 模板填充：`--replace` 找不到叫「没找到」，模板填不上叫「合同带着窟窿发出去了」

机制上它就是上面那套跨 run 替换，**区别全在契约上**。所以 `docx_template.py` 多回答三件事：

- **还剩哪些占位符没填**（`unfilled`）—— 默认警告，`--strict` 直接拒绝写。
- **你给的哪个值一个占位符都没匹配上**（`unused_values`）—— 基本都是键名打错了，
  而「键名打错」和「这个模板里本来就没这个占位符」在报告里长得一模一样，必须点名。
- **页眉页脚默认一起填**（与 `--replace` 相反，那个要 `--in-headers` 才碰）。
  信笺抬头里的占位符和正文里一样多，模板填充漏掉它就是密级标注还写着 `{{密级}}`。

## 转 PDF：产物在应用内可见的唯一通道

**docx 在 ultrawork 里没法预览** —— 产物面板能渲染 PDF，其余一律只给一张二进制信息卡。

⚠️ **要的是 LibreOffice Writer，不只是 `soffice`。** 只装了 `libreoffice-calc` 的机器上
`soffice` 存在、对 .docx **退出 0 且不产出任何文件** —— 所以这里判成功看的是产物在不在。

三件它拒绝或点名而不糊弄过去的事：**整页没有墨的 PDF**（空预览看起来就像内容没了）·
**文档里还有未处理的修订**（PDF 只是修订的一种解法，不是任何人批准过的那份文档）·
**域是按缓存值渲染的**（LibreOffice 转换时不重算 `{ PAGE }` / 目录，缓存是旧的就渲染旧的）。

## 修订与批注：读得懂，才谈得上不破坏

| 元素 | 本技能怎么算 |
|---|---|
| `<w:ins>` 里的文字 | **是**正文（它在文档里） |
| `<w:del>` 里的 `<w:delText>` | **不是**正文（它已经被删了），单独在 `revisions` 里报 |
| 落在修订区里的替换 | 照做，但报告里 `contexts` 会点名 `ins` |

⚠️ **python-docx 的 `paragraph.text` 只遍历直接的 `<w:r>` 子元素**，所以
**被跟踪插入的文字它读不到**。实测本技能的示例：它给出「本季度同比增长。」，
漏掉了 `净利润`。把删除的文字当正文、或把插入的文字漏掉，都会让文档说出它没说的话。

## 修订：五种形态，只认识前两种会毁掉文档

`--accept-all` / `--reject-all` 是**纯 Python** 的，不需要 Word 也不需要 LibreOffice。
难的不是解开 `<w:ins>`，是下面这五种形态**必须都认得**：

| 形态 | 不认识它会怎样 |
|---|---|
| `<w:ins>` / `<w:del>` 行内修订 | —— |
| `<w:moveFrom>` / `<w:moveTo>` + 区间标记 | 移动只解一半，另一半留在文档里 |
| **段落标记上的修订**（`<w:pPr><w:rPr><w:ins/>`） | 它表示**段落分隔符**被插入/删除，接受或拒绝意味着**合并两个段落**。当成行内修订去解包，文档看起来没变、而编辑其实没生效 |
| `<w:pPrChange>` 等格式修订 | 旧格式**存在它内部**，拒绝时要放回去；直接删掉等于「报告说拒绝了、格式却留着新的」 |
| **`<w:ins>` 里嵌 `<w:del>`** | 「插入的文字后来又被删了」，是最普通的评审流水。本仓库的 L2 门禁一度把它判红，**是 ECMA-376 schema 裁的**，不是谁的意见 |

所以**每次操作结束都会重扫一遍并报告 `remaining`** —— 有一种本代码不认识的形态，
它会出现在那里，而不是被当成成功。`--strict` 把「还有剩」变成拒绝写出。

⚠️ 顺带一条只有实测才知道的事：**python-docx 读不到跟踪插入的文字**，
所以一份带着未处理修订的文档，用它去断言「正文里有没有某句话」会得到错误答案。

## 批注：一条批注是五样东西

`word/comments.xml` · `[Content_Types].xml` 的 Override · document.xml 到它的关系 ·
`<w:commentRangeStart/End>`（批注**针对**哪段话）· 一个装着 `<w:commentReference>` 的 run。
写三样就得到一个 Word 提示修复的文件。**删掉最后一条批注**时那个 part 也要走 ——
而删一个 part 同样是三件事。锚点复用了跟踪修订那套 `isolate_runs`，
所以**被 Word 切开的短语也能被批注**（区间标记不能从 run 中间开始）。

## 追加段落：`body.append(p)` 是错的

`<w:sectPr>` 按 schema 必须是 `<w:body>` 的**最后**一个子元素。直接 append 会把段落放到
它后面 —— Word 会「修复」这个文件，而**它修掉的就是那个 section**：页面尺寸、页边距、
页眉页脚绑定一起没。本技能所有写入都走 `insert_ordered`，这条坑关一次就够了。

同理，本技能写的每个 run 都带 `w:rFonts/@w:eastAsia`（连纯英文的也带）——
不带的话 Word 从主题里挑中文字体，同一个文件换台机器就换个样子。

## 拆包：`unzip` + `zip` 给不了你的两件事

- **part 顺序是文件的一部分。** `[Content_Types].xml` 按惯例排第一，有些读取器比规范更
  较真。`--unpack` 会写一份 `_manifest.json` 记下顺序，`--pack` 按它还原。
  实测：17 个 part 逐字节相同、顺序一致。
- **一个 part 是三样东西**（字节 + content type + 关系）。`rm` 掉一个再 rezip 得到的是
  一个指向空气的包 —— 在某些读取器里能打开，在另一些里提示修复。`--check` 查这三样。

`--unpack` 拒绝任何会跳出目标目录的 part 名（`../…`）：part 名来自别人写的 zip。

## 元素顺序：Word 说「发现无法读取的内容」时

WordprocessingML 的内容模型是 `xsd:sequence`：`<w:pPr>` 的子元素顺序是固定的，
顺序错了文件就是非法的，尽管每个元素本身都拼对了。Word 的反应是弹修复对话框，
**而修复掉的就是它放不下的那部分**。

`--fix-order` **逐个元素报告**它移动了什么，而不是在每次写入时默默排一遍 ——
元素放错位置说明某个写入方有 bug，悄悄排序等于把是谁干的这件事藏起来。

## 为什么不用 python-docx

不是风格偏好，是两条实测：

1. **它自带的 `default.docx` 模板不合规。** 里面是 `<w:zoom w:val="bestFit"/>`，
   而 ECMA-376 Transitional 的 `CT_Zoom` **要求** `w:percent`
   ⇒ **它产出的每一份文档都带这条**。一个自身带已知缺陷的产物，没资格当门禁的正样本。
2. **它的对象模型里没有本技能大部分工作的位置** —— 修订、批注、字段、跨 run 的短语，
   它一个都表达不了。绕开模型直接操作它内部的 lxml 树，等于用一个库来拿另一个库。

也顺带纠正一条容易被 xlsx 那边带偏的印象：**python-docx 的 round-trip 不丢东西**
（实测 17/17 part 逐字节相同），这一点它和 openpyxl 完全不同 ——
它只丢**没有任何关系指向的** part（实测：注入一个孤儿 part，保存后消失）。
所以本技能的「外科式」不是为了补它的窟窿，是为了做它做不到的事。

## 已知边界（写下来，不要以为验过了）

- **19 项能力只做了 10 项**，其余 9 项在 `capabilities.json` 的 pending 里逐条写了理由。
- **替换不认识字段。** `{ PAGE }` 这样的域是五个 run，其中一个存着上次算出来的数字。
  本技能不会去改域的定义，但如果你替换的字符串正好命中缓存值，它就会被当普通文字改掉。
- **`--fix-order` 只排本技能建模过的元素**（pPr / rPr / sectPr / tblPr / tcPr / trPr /
  styles / numbering 等）。不认识的命名空间原样留在原位 —— 移动一个不知道该放哪的元素，
  比留着它更糟。
- **示例文件是逐字节可复现的**（zip 时间戳、压缩级别、日期都已固定），
  但它们进 `skills/builtin/.builtin-version` 这个哈希。**没有要改示例内容时不要跑
  `fixtures/make_fixtures.py`。**

## 底座

`scripts/office/` 是本技能自带的一份 OOXML 底座（`package` 包与关系 /
`document` 段落与跨 run 字符流 / `revision` 修订的五种形态 / `soffice` 探测与转换 / `validate` 一致性 /
`xmlorder` ECMA-376 元素序）。**xlsx / pdf 各自带各自的副本**，不共享 ——
打包脚本拒绝 symlink。

> 本技能的行为测试（46 条断言 + 84 条负向控制）在 **ultrawork 仓库**里，
> **不随技能分发** —— 它需要 fixtures 之外的仓库上下文。装在你机器上的这份目录里
> 没有它，别去找。
