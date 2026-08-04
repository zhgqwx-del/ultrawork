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
  `docx`.
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
| 数字格式/字体/填充/边框 | `scripts/xlsx_format.py --range` | 走重建+graft，见下 |
| 条件格式 | `scripts/xlsx_format.py --rules` | cellIs / expression / colorScale / dataBar |
| 冻结窗格 / 自动筛选 | `scripts/xlsx_format.py --freeze --filter` | |
| 图表 | `scripts/xlsx_chart.py` | 柱/条/折线/饼/散点/面积，系列名取自表头 |
| 公式重算 | `scripts/xlsx_recalc.py` | **双引擎互相校验**，见下 |
| CSV / JSON 进出 | `scripts/xlsx_convert.py` | 双向；读**永远**走 read_only |
| 大文件流式读 | `scripts/xlsx_convert.py --stats` | 内存**不随行数增长**，见下 |
| 转 PDF / 页面图 | `scripts/xlsx_pdf.py` | 应用内**唯一**可见通道 |
| 财务色彩规范 | `scripts/xlsx_finance.py` | opt-in，`--check` / `--apply` |

`capabilities.json` 里 **15 项全部实现，零 pending**。

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

要真正的数字，用 `xlsx_recalc.py`（下一节）。

## 重算：两个引擎，互相校验

`openpyxl` **从不写缓存值**。所以任何库产出的 workbook，公式格里存的是 `<f>` 而没有
`<v>` —— 凡是读「值」而不是读「公式」的消费者（包括本技能自己的 reader），看到的都是空格。
重算并把结果写回，才让这种文件对非表格软件可读。

```bash
python3 scripts/xlsx_recalc.py --in book.xlsx --out calculated.xlsx --report r.json
python3 scripts/xlsx_recalc.py --in book.xlsx --engine python        # 没装 LO 时
python3 scripts/xlsx_recalc.py --in book.xlsx --fail-on disagreement,unsupported
```

| 引擎 | 是什么 |
|---|---|
| `soffice` | LibreOffice，权威。转成 xlsx 会强制全量重算并给**每一张表**写缓存值（转 CSV 只覆盖第一张） |
| `python` | `office/evaluate.py`，小而且**故意不完整** |

`--engine both`（默认）两个都跑，**逐条报告分歧，且不裁定谁对** —— 两个独立引擎算出不同的数，
说明其中一个错了，而这个脚本无从知道是哪个。

**它算不了的公式，输出的是公式原文，不是数字。** 这是这条能力唯一不能丢的性质：
一个看起来算出来了的错数，比一个诚实的空缺糟得多。

### 覆盖边界是量出来的，不是声称的

覆盖边界由 ultrawork 仓库里的一份标定表钉住（**不随技能分发**，装在你机器上的这份目录里
没有它）：**55 个取自 LibreOffice 的值** + **9 个必须被拒绝的构造**。第一版实现有 **6 条与 LibreOffice 不符**，
每一条都会作为自信的错数发出去：

| 构造 | LibreOffice | 第一版实现 |
|---|---|---|
| `-2^2` | **4**（一元负号比 `^` 结合更紧） | -4 |
| `2^3^2` | **64**（`^` 左结合） | 512 |
| `MOD(-7,3)` | **2**（取除数的符号） | -1（用了 `fmod`） |
| `IF(TRUE,,5)` | **0**（空参数=空白） | 解析失败 |
| `SUM()` | **0** | 解析失败 |
| `AVERAGE(1,"x",2)` | **#VALUE!**（直接传的文本 ≠ 区域里的文本） | 1.5 |

还有一条**两个权威互相矛盾**：`SQRT(-1)` Excel 说 `#NUM!`、LibreOffice 说 `#VALUE!` ⇒
引擎**拒绝**，不选边。

明确不做：数组公式 · 易变函数（TODAY/NOW/RAND —— 拿会动的值做交叉校验没有意义）·
日期运算 · 查找族（VLOOKUP/INDEX/MATCH）· 条件里的通配符 · 定义名称 · 外部链接。

## 大文件：read_only 不是优化开关

用 `tracemalloc` 实测读同一张三列表：

| 行数 | 普通模式 | read_only | 比值 |
|---|---|---|---|
| 10,000 | 12.9 MB | 1.7 MB | 7.5× |
| 50,000 | 62.3 MB | 5.1 MB | 12.2× |
| 250,000 | 326.6 MB | 22.0 MB | 14.9× |

普通模式每行约 **1.3 KB 且不随规模改善** —— 它给每个单元格建一个 Python 对象并全部留着。
一个磁盘上 8 MB 的 50 万行文件，光读进来就要接近 1 GB。
**所以本技能的读取路径永远用 read_only**，这不是调优，是「能用」和「吃掉机器」的差别。

```bash
python3 scripts/xlsx_convert.py --in big.xlsx --to jsonl --out rows.jsonl --sheet 明细
python3 scripts/xlsx_convert.py --in big.xlsx --stats --sheet 明细
python3 scripts/xlsx_convert.py --from data.csv --out new.xlsx --autofit
```

- **CSV 用 `utf-8-sig` 写**（带 BOM）：不带 BOM 的中文 CSV 在 Excel 里就是乱码，而 CSV 导出
  的去处基本都是 Excel。
- **`--header-row N`**：真实表格常在表头之上还有一行合并标题。默认取第 1 行当表头，会把标题
  变成列名。
- **导出的是「值」不是公式**。没算过的文件根本没有值，所以这种情况会**明确警告**，
  而不是导出一片空白（先跑 `xlsx_recalc.py`）。

## 转 PDF：产物在应用内可见的唯一通道

**xlsx 在 ultrawork 里没法预览** —— 产物面板能渲染 PDF，其余一律只给一张二进制信息卡。

```bash
python3 scripts/xlsx_pdf.py --in book.xlsx --out book.pdf --png ./pages --dpi 150
```

两件事它拒绝而不是糊弄过去:**整页没有墨的 PDF**（LibreOffice 对空表照样退出 0 并产出
白页，把它当预览交回去比报错更糟——那看起来就像数据没了）· **没算过的 workbook**
（公式格渲染成**空**，图片本身没法告诉你哪里不对，所以先警告）。

`--png` 需要 pypdfium2（Apache-2.0，pdf 技能的依赖）。它**不是**本技能声明的依赖（为几个
预览附加功能给整个技能挂红徽标不合理），所以缺它时：PDF 照出，空白页检查降级为**明说的
缺口**，而 `--png` **直接报错** —— 你明确要了图，不产图却安静退出才是这份文件最该避免的失败。

## 财务色彩规范（opt-in）

蓝＝手输的数 · 黑＝本表算的 · 绿＝引用了别的表。价值在于一眼可审计：该是公式的格子是蓝的，
就说明有人硬改过。

```bash
python3 scripts/xlsx_finance.py --in model.xlsx --check
python3 scripts/xlsx_finance.py --in model.xlsx --out coloured.xlsx --apply
```

**它是 opt-in 且会一直是。** 这是财务建模的约定，不是电子表格的普遍属性——本仓库的 L2 门禁
为此付过学费：默认打开会立刻把一个什么也没做错的普通夹具判红。`--apply` **只改字体颜色**，
字号字形粗细一概带过去。

## 已知边界（写下来，不要以为验过了）

- **文本按 inline string 写**（`t="inlineStr"`），不碰 `xl/sharedStrings.xml`。
  合法且通用，但它不复用字符串表 —— 大批量写同一个词时文件会比 Excel 写的大一些。
- **不做**：条件格式 / 图表 / 数字格式 / 冻结窗格的**创建**（读和保留都没问题，
  编辑时它们原样留在包里）· **公式求值**（`xlsx_audit.py` 只看引用不算数）。
  这些在 `capabilities.json` 的 pending 里。
- **循环引用检测有上限**：单条引用超过 20000 格的区域会被截断，且**截断这件事会写进报告**
  （`graph_truncated`）—— 一个悄悄停止生长的依赖图会对着满是循环的 workbook 报「无循环」。
- **两条写入路径，分工是量出来的不是拍的**：写值/写公式/追加行/设列宽走**外科式**
  （一个 part 不丢、16/17 逐字节未变）；创建格式/条件格式/图表/冻结筛选走
  **openpyxl 重建 + graft**（`scripts/office/rebuild.py`）—— 因为这些是 styles.xml +
  sheet + drawing + rels 图交织的结构，手写就是进 Excel 修复对话框。
  重建路径实测：openpyxl 每次 save 都丢 3 个 customXml part，graft 后 0 丢、包校验干净。
- **graft 是 part 级的，修不了「存活 part 内部」的丢失**（如 sheet1.xml 里的
  `<ignoredErrors>`）。这条边界写在 `rebuild.py` 里，且报告永远带 `still_missing` 字段 ——
  **一个只在有损失时才提损失的报告，和没人写的报告分不出来**。
- `--autofit` 用的是字符计数，不是字体度量。等宽假设在默认字体下够用，
  换成很宽或很窄的字体会偏。

## 底座

`scripts/office/` 是本技能自带的一份 OOXML 底座（`package` 包与关系 /
`sheet` 外科式编辑 / `rebuild` 重建+graft / `formula` 引用解析与依赖图 /
`evaluate` 纯 Python 求值器 /
`soffice` 探测与转换 /
`validate` 一致性 / `xmlorder` ECMA-376 元素序）。**docx / pdf 各自带各自的副本**，不共享 —— 打包脚本拒绝 symlink。

## 自检

```bash
python3 fixtures/make_fixtures.py    # 重建示例；仅在示例内容要改时才跑，见下
```

⚠️ 示例文件是**逐字节可复现**的（zip 时间戳、压缩级别、`dcterms:modified` 都已固定），
但它们进 `skills/builtin/.builtin-version` 这个哈希。**没有要改示例内容时不要跑它。**

> 本技能的行为测试（50 条断言 + 70 条负向控制）在 **ultrawork 仓库**里，
> **不随技能分发** —— 它需要 fixtures 之外的仓库上下文。装在你机器上的这份目录里
> 没有它，别去找。
