---
name: xlsx
description: >
  Use when the deliverable is an Excel workbook itself — 读Excel / 改单元格 /
  写公式 / 追加行 / 跨表引用 / 检查公式错误 / 循环引用 / Excel列宽自适应 /
  中文列被截断 / 读取xlsx数据, or read cells, sheets and ranges (reporting BOTH
  the stored formula and the cached value), edit cells, write formulas and append
  rows WITHOUT losing charts, pivot caches, macros or custom parts, audit a
  workbook for #REF!/#DIV/0! errors, references to sheets that do not exist and
  circular chains, and set column widths that count Chinese characters as the two
  display units they actually occupy. Not for turning a spreadsheet into slides —
  that is `deckcraft`; not for PDFs — that is `pdf`; not for .docx — that is
  `doc-edit`.
x-requires: [python3, openpyxl, lxml, soffice]
---

# XLSX 技能

由 ultrawork 自写（非 Anthropic 专有文档技能、也非任何参考实现的改写）。

## 依赖

```
python3 -m pip install openpyxl lxml
```

外加 **LibreOffice**（命令行 `soffice`）。它是必需依赖，不是可选项，原因有两条：

1. **公式重算只有它能做。** openpyxl 写公式但从不产生缓存值 —— 一个刚写好的
   workbook 里每个公式都是「没算过」的状态。
2. **xlsx 在应用内无法预览**，转成 PDF 是产物能被看见的唯一通道。

没装的话，本技能在设置页显示「未就绪」。

## 现在有什么（其余的没有，别假装有）

| 能力 | 脚本 | 说明 |
|---|---|---|
| 读单元格 / 表 / 区域 | `scripts/xlsx_read.py` | 同时给**公式**与**缓存值**两个视图 |
| 写单元格 / 写公式 / 追加行 | `scripts/xlsx_write.py` | **外科式编辑**，见下 |
| 跨表引用 | `scripts/xlsx_write.py --set-formula` | 写之前先验目标表在不在 |
| 公式体检 | `scripts/xlsx_audit.py` | 错误值 / 引用了不存在的表 / **循环引用** / 未计算 |
| 中文列宽自适应 | `scripts/xlsx_write.py --autofit` | 按**显示宽度**算，汉字算两格 |

`capabilities.json` 里 **6 项已实现、9 项 pending 并逐条写了理由**。
pending 的不是「快好了」，是**还没有断言在证明它**。

## 用法

```bash
# 表清单 + 每张表的公式数
python3 scripts/xlsx_read.py --in book.xlsx

# 读一个区域（同时拿到公式和值）
python3 scripts/xlsx_read.py --in book.xlsx --sheet 利润表 --range A1:D12 --out cells.json

# 改单元格 / 写公式 / 追加行
python3 scripts/xlsx_write.py --in book.xlsx --out out.xlsx --sheet 利润表 \
        --set B3=1310 --set-formula D5=B5/C5-1 --append-row 其他业务收入,88,74

# 让中文列宽够用
python3 scripts/xlsx_write.py --in book.xlsx --out out.xlsx --autofit
```

`--set` 的值会按字面推断类型；**加引号强制当文本**（`--set A2="007"` 保住前导零）。

## 这个技能与「随手用 openpyxl」的差别：编辑不丢东西

大多数实现是 `openpyxl.load_workbook(f)` → 改 → `save()`。它**能跑**，产物**合法**，
而且**会静默丢东西**。本仓库自带的 `sample.xlsx` 做一次**空操作** round-trip 实测：

| | 丢了什么 |
|---|---|
| `load → save` | `xl/metadata.xml`（904 字节动态数组元数据）、`sheet1.xml` 里的 `<ignoredErrors>` |

丢的不是 openpyxl 不好，是**它只写它认识的东西**。图表、透视缓存、宏、线程批注、
自定义 XML 全在同一个位置上 —— 输入里有，输出里没有，文件照样能打开。

所以本技能的写入路径**根本不把包交给库去重建**：它直接改
`xl/worksheets/sheetN.xml`，其余每个字节原样保留。实测同一次编辑：

| 写法 | 产物 part 数 | 逐字节未变的 part |
|---|---|---|
| `load → save` | 14（丢 3 个） | 10 / 17 |
| **本技能** | **17（一个没丢）** | **16 / 17**（只有被编辑的那张表变了） |

两者的 LibreOffice 重算结果完全一致 —— 也就是说，保真度不是拿正确性换来的。

顺带三条：

- **单元格的样式索引 `s` 保留。** 改一个数不该让整列变成「常规」格式。
- **共享公式的主格不给覆盖，直接拒绝。** `<f t="shared" ref="D3:D5">` 是一份定义
  服务一片区域，覆盖主格会让 D4/D5 指向一个不存在的定义 —— 文件能打开，数字没了。
- **`xl/calcChain.xml` 在公式变化时删掉，值变化时保留。** 它是求值顺序的缓存：
  改了公式还留着旧的，Excel 会报「发现部分内容有问题」；只改了值则依赖关系没变，
  删掉等于白白让人重算一遍。

写完会重新打开产物做一致性检查（part 都能解析、关系都指得到、元素序合规）。
**只有这次编辑「新引入」的问题才拒绝写出**；文件本来就带的毛病照实报告但不拦着 ——
最需要被修的恰恰是已经坏了的文件。

## 列宽：`len()` 是错的，而且错得看不见

Excel 的列宽单位是「默认字体下的字符数」，**一个汉字占两格**。按 `len()` 算出来的
列宽正好差一半：值老老实实在文件里，屏幕上被截断或显示成 `####`。

```
营业收入合计（含其他业务）   len()+2 = 15   显示宽度+2 = 28
```

`--autofit` 默认只管**含中文的列**（`--autofit-scope all` 管全部）。三条规则：

- **公式文本不算宽度** —— `=B2/利润表!B3` 从来不显示，按它算会撑出一列空白。
- **横跨多列的合并标题不算**它第一列的宽度 —— 它本来就显示在整片合并区上。
- **纵向合并（在同一列内）照算** —— 竖着合并不会多出任何横向空间。

## 公式：写之前拦，写之后查

**写之前**（`--set-formula`）拒绝两种一定会坏的写法：

- **引用了这个 workbook 里没有的表** —— 这正是 `#REF!` 的出生方式，而且是**静默**出生的：
  openpyxl 一声不吭地把字符串存下来，等 Excel 打开文件才炸，那时早没人记得是哪一步写的。
- **公式文本里直接含 `#REF!` 这类错误值** —— 那是个错误值，不是表达式。

**写之后**（`xlsx_audit.py`）按代价从高到低报四类：

```bash
python3 scripts/xlsx_audit.py --in book.xlsx --out audit.json \
        --fail-on error,missing,circular      # 退出码 1，可当门禁用
```

| 类 | 含义 |
|---|---|
| `error` | 已经带 `#REF!` / `#DIV/0!` / … —— **同时给出是哪个引用造成的**，不只是个 token |
| `missing` | 指向不存在的表 = **还没发生的 `#REF!`** |
| `circular` | 一串单元格读自己。Excel 显示 0，只在状态栏提示一句，基本没人看见 |
| `uncalc` | 公式没有缓存值 —— 库写出来的文件都这样，**说出来**是因为它意味着现在任何读取方看到的是「空」而不是「0」 |

它是**引用**解析器，不是求值器：只回答「这条公式指向什么」，不算任何数。
守住这条边界是有意的 —— 一旦开始求值，每个算错的地方都会变成一个自信的错数。

两个必须避开的假阳性（都实测踩过）：字符串字面量里的 `"见 预算表!A1"` **不是**引用；
`LOG10(` 里的 `LOG10` 长得和单元格引用一模一样，**不排除它就会凭空造出循环引用**。

## 两个视图：公式 和 值

`xlsx_read.py` 每个单元格都给 `formula` 和 `value` 两个字段，还有一个
`uncalculated` 标志。这不是啰嗦：**任何库写出来的 workbook 都没有缓存值**，
只问 `value` 会得到一片 `null`，然后把「这个表还没算过」读成「这个表是空的」。

要真正的数字，用 LibreOffice 重算（S3 后续切片的 X4 会把它包成一条能力）。

## 已知边界（写下来，不要以为验过了）

- **文本按 inline string 写**（`t="inlineStr"`），不碰 `xl/sharedStrings.xml`。
  合法且通用，但它不复用字符串表 —— 大批量写同一个词时文件会比 Excel 写的大一些。
- **不做**：条件格式 / 图表 / 数字格式 / 冻结窗格的**创建**（读和保留都没问题，
  编辑时它们原样留在包里）· **公式求值**（`xlsx_audit.py` 只看引用不算数）。
  这些在 `capabilities.json` 的 pending 里。
- **循环引用检测有上限**：单条引用超过 20000 格的区域会被截断，且**截断这件事会写进报告**
  （`graph_truncated`）—— 一个悄悄停止生长的依赖图会对着满是循环的 workbook 报「无循环」。
- 外科式路径覆盖的是「写值 / 写公式 / 追加行 / 设列宽」。别的结构性改动要走
  openpyxl 重建 + `scripts/office/package.py` 的 graft，那条路**还没有能力挂上去**。
- `--autofit` 用的是字符计数，不是字体度量。等宽假设在默认字体下够用，
  换成很宽或很窄的字体会偏。

## 底座

`scripts/office/` 是本技能自带的一份 OOXML 底座（`package` 包与关系 /
`sheet` 外科式编辑 / `formula` 引用解析与依赖图 / `soffice` 探测与转换 /
`validate` 一致性 / `xmlorder` ECMA-376 元素序）。**docx / pdf 各自带各自的副本**，不共享 —— 打包脚本拒绝 symlink。

## 自检

```bash
python3 fixtures/make_fixtures.py    # 重建示例；仅在示例内容要改时才跑，见下
```

⚠️ 示例文件是**逐字节可复现**的（zip 时间戳、压缩级别、`dcterms:modified` 都已固定），
但它们进 `skills/builtin/.builtin-version` 这个哈希。**没有要改示例内容时不要跑它。**

> 本技能的行为测试（27 条断言 + 37 条负向控制）在 **ultrawork 仓库**里，
> **不随技能分发** —— 它需要 fixtures 之外的仓库上下文。装在你机器上的这份目录里
> 没有它，别去找。
