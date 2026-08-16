---
name: pdf
description: >
  Use when the deliverable is a PDF itself — 读PDF / 提取PDF文字 / PDF转图片 /
  查看PDF页数与加密状态 / 填PDF表单 / 生成PDF / 合并拆分PDF /
  PDF加密解密 / 给PDF设置或去掉打开口令密码 / 改PDF权限（只允许打印、禁止复制修改）/
  提取PDF表格, or extract text with coordinates,
  render pages to images, report page geometry and encryption state, fill forms
  (AcroForm fields when the file has them, anchored text overlay when it does not)
  with an overflow check and a colour-coded proof sheet, BUILD a PDF from a
  document spec with the font genuinely embedded so Chinese survives on machines
  that have no CJK font installed, and
  merge/split/extract/rotate pages, set/change/remove the open password and set the
  permission bits (print-only, no-copy, no-modify), and pull tables out to CSV.
  Not for making slide decks from a PDF — that is `deckcraft`; not for .docx — that
  is `docx`; not for .xlsx — that is `xlsx`; not for .pptx — that is `pptx-edit`.
x-requires: [python3, pypdfium2, pypdf, pdfplumber, reportlab]
---

# PDF 技能

由 ultrawork 自写（非 Anthropic 专有文档技能、也非 OpenAI 版的改写）。四个宽松许可的库
各答一类问题，谁也替不了谁。

## 依赖

```
python3 -m pip install pypdfium2 pypdf pdfplumber reportlab
```

| 库 | 许可 | 在这里干什么 |
|---|---|---|
| `pypdfium2` | Apache-2.0 / BSD-3（内含 PDFium，BSD-3） | 光栅化：页面渲染成图 |
| `pypdf` | BSD-3 | 对象模型：页树、表单域、权限位、加解密 |
| `pdfplumber` | MIT（带 pdfminer.six + Pillow） | 文字几何与表格 |
| `reportlab` | BSD-3 | 写：生成 PDF、外观流、叠加层 |

**为什么不是 PyMuPDF**：它是 **AGPL-3.0 或商业授权**（权利人 Artifex，同时是 Ghostscript
权利人，有 *Artifex v. Hancom* 判例），而 `skills/builtin/` 随产品分发 —— 商业分发扛不住
AGPL。本技能已**整体**移出，没有任何一个文件 `import fitz`（059 §5·补.8c）。

## 现在有什么（其余的没有，别假装有）

| 能力 | 脚本 | 说明 |
|---|---|---|
| 页面渲染成图 | `scripts/pdf_render.py` | 可控 DPI 与页范围，输出 PNG/JPG |
| 文字 + 坐标抽取 | `scripts/pdf_extract.py` | word / line / block 三种粒度，可选画框校验 PDF |
| 元数据 | `scripts/pdf_info.py` | 页数、逐页尺寸与旋转、加密态与权限位 |
| 表单探测与字段抽取 | `scripts/pdf_form_inspect.py` | 有没有 AcroForm；字段类型/选项/长度上限/标志/坐标 |
| 表单填充 | `scripts/pdf_form_fill.py` | 有域走 AcroForm，无域按锚点或坐标叠加 |
| 越界校验与校验图 | `scripts/pdf_form_check.py` | 值有没有超出字段框；产出逐字段标色的 PDF |
| 从零生成 PDF | `scripts/pdf_create.py` | 标题/正文/项目符号/表格/分页；**字体真嵌入并子集化** |
| 表格抽取 | `scripts/pdf_tables.py` | JSON + CSV；**逐表标注是「读出来的」还是「猜出来的」** |
| 页面操作 | `scripts/pdf_pages.py` | 合并 / 拆分 / 抽页 / 删页 / 旋转 / **压平表单** |
| 加密解密 | `scripts/pdf_encrypt.py` | AES-256 设/改/去口令，权限位 |

`capabilities.json` 里 **15 项能力全部已实现，无 pending**。

## 产物写在哪：工作区内，相对路径

**要交给用户的产物（PDF / PNG / CSV / 报告 JSON）一律写进当前工作目录或它的子目录**
（`--out 输出/page-001.png`），回复里也用同一条相对路径引用（`![预览](输出/page-001.png)`）。

**纯中间文件**（下一条命令马上吃掉的临时 JSON）不受这条约束 —— 别拿它堆满用户的工作区。
但**也别写死 `/tmp`**：Windows 上它落到系统盘根目录 `C:\tmp`，而 `--out` **会替你把父目录
建出来** —— 所以它不会报错，只是在别人的 C 盘根上留垃圾，同名文件还会被并发会话互相覆盖。
用 `tempfile`。（2026-08-16 实测更正：此前这里写「目录不存在就直接失败」是错的。）

⚠️ **写到 `/tmp`、`~/…` 或任何工作区外的绝对路径 = 用户永远看不到它。** 产物面板只扫工作区，
回复里的内联图只走一个「读工作区内文件」的端点 —— 工作区外的图会退化成一张灰色兜底卡片。
**文件真的在、内容也对，UI 上就是显示不出来**（2026-08-15 实测：一次表单预览渲染到
`/tmp/filled_preview/`，三张图一张都没显示出来）。

渲染出来只为了「给人看一眼」的图最容易犯这个错，因为它感觉像个中间产物 ——
**而它恰恰是用户唯一会看的那个。**

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

### 生成文档

```bash
python3 scripts/pdf_create.py --in doc.json --out report.pdf \
        --font-report fonts.json
```

`doc.json` 的 `blocks` 支持 `heading`(1-3 级) / `paragraph` / `bullets` / `ordered` /
`table` / `spacer` / `pagebreak`，**超出下边距自动分页**。换行同时处理两套规则：中文任意字之间可断，
西文只在空格处断 —— 只按空格断的话，一整段中文会变成一行不可断的长文本，直接溢出页面。

**并且遵守行首/行尾禁则**：`，。、；：？！` 和右括号右引号不会被顶到行首，左括号左引号不会留在行尾
（做法是「押出」——标点跟着它所属的那个字一起挪到下一行，不是悬挂到版心外）。
⚠️ **唯一的例外是宽度**：如果焊在一起的那一串本身就比栏宽还宽（窄表格单元格里成串的标点），
**宁可断开也不捅出版心** —— 那种情况下标点会重新出现在行首，这是明写的让步，不是漏掉了。

**列表可嵌套**：`items` 的元素可以是字符串，也可以是 `{"text": …, "items": […]}`；
子列表默认继承父列表的类型，写 `"type"` 可以改。有序项**按路径编号**（`1.` / `1.1` / `1.1.1`），
换行后的续行**悬挂对齐在文字下方**而不是标记下方。

```json
{"type": "ordered", "items": [
  {"text": "订阅制转型", "items": ["续费率 94.2%", "NDR 111%"]},
  "应收账款：账龄 90 天以上占比 11.3%"]}
```

> ⚠️ 把嵌套的有序列表压平成一层，**编号和层级会同时丢掉，而且从 PDF 里找不回来** ——
> 这正是这个技能出厂时的行为（那时只有 `bullets`，`1./2./3.` 全变成匿名圆点）。

**字体是真嵌进去的，并做子集化。** 这是这条能力最要紧的一点：

| 写法 | 产物里的字体 | 换台机器 |
|---|---|---|
| 只**写了个名字**（无 `/FontFile*`） | 字典里只有 BaseFont | 缺中文字体就是空白/豆腐 |
| 注册 TrueType → reportlab 自动子集嵌入 | `/FontFile2` + `AAAAAA+` 子集标记 | 自带字形，到哪都一样 |

实测：Songti.ttc 磁盘上 66,933,080 字节 → 产物 **32KB（两页含表格）**，仍然是嵌入的、
文字仍可抽取。**本仓库不打包字体**：默认在**生成端**的机器上探测一个 CJK 字体并嵌入子集，
产物照样可移植；`--font 路径.ttf` 可换成任意 TrueType，找不到就明确报错而不是画空白。

> ⚠️ macOS 上第一个能找到的候选恰恰嵌不了：`Hiragino Sans GB.ttc` 是 PostScript(CFF)
> 轮廓，reportlab 直接拒绝。所以字体是**逐个试注册**而不是「找到路径就用」。
> 标准 14 号字（`--font helv` 等）是唯一不嵌入也可移植的例外——任何阅读器都必须自带。

> ⚠️ **能注册 ≠ 适合拿来排整份文档。** 这里出过一次真事故：macOS 上第一个能注册的是
> `Songti.ttc` 的第 0 面 = **STSongti-SC-Black**（该文件最重的字重），而一个 face 要画完整份
> 文档 ⇒ **正文也变成了展示字重**，报告里全是黑粗字。更糟的是那一面是该文件八个面里
> **唯一没有 U+2022 的**，于是每个圆点都画成 .notdef —— 纸上空白、文本层 `\x00`、
> 没有任何报错。现在按**字体自述的字重**排序（`.ttc` 里的面序跨系统版本会变，不能按位置认），
> 并在同一个文件里找**配套的 Bold** 给标题用；报告里 `typeface_name` / `typeface_bold` /
> `heavy_weight_only` 三个字段把结果说出来，只剩展示字重时会明说而不是闷着。

**覆盖检查要连「代码自己加的字符」一起查。** 这条检查出厂时只喂了调用方写的文字，
而列表标记（`•`）是**排版自己补上去的**，谁都不会在 spec 里声明它 ⇒ 它从来没被查过，
画成空白而报告写着 `missing_glyphs: []`。现在两头都堵：标记先过一遍能不能画，
画不了就**降级成 ASCII 替身**并在 `marker_substitutions` 里说出换了什么（标记是装饰，
为一个圆点让整份文档失败不划算）；换完的标记再并进覆盖检查，
让「凡是要画的字符都被查过」这句话字面成立。

**写之前先查字形覆盖**：字体没有的字会画成空白且**不报任何错**，所以缺字直接拒绝生成并列出
缺哪些（`--allow-missing-glyphs` 可强行写并在报告里点名）。实测 `--font helv
--allow-missing-glyphs` 强行拿 Helvetica 写中文：reportlab **不报错**，静默掉进
ZapfDingbats，中文全变成一排黑方块（抽出来是 `nnnnnnnn`）—— 这就是那道拒绝挡住的东西。

### 表格抽取：读出来的 vs 猜出来的

```bash
python3 scripts/pdf_tables.py --in report.pdf --out tables.json \
        --csv-dir ./csv --overlay boxes.pdf
```

每张表都带 `strategy`、`reliable` 和 `evidence`（哪一半是读的、哪一半是推的）：

| strategy | reliable | evidence | 什么情况 |
|---|---|---|---|
| `lines` | true | 行/列都 `drawn` | 格线画在页面里，单元格边界是文件里的事实 |
| **`rules`** | false | 行 `drawn` / 列 `inferred` | **只有横线没有竖线 —— 中文商务文档最常见的样式** |
| `text` | false | 行/列都 `inferred` | 完全没有可用的线，行列都靠文字对齐猜 |

`auto` 按 **lines → rules → text** 依次试：画出来的胜过画一半的，画一半的胜过猜的。

> ⚠️ **`rules` 这条是补出来的，因为缺了它整条路是断的。** 实测一份真实季度报告：每行下面一条横线、
> 没有竖线 ⇒ `lines` 需要两者、什么也找不到；退回 `text` 就在**整页**上找列，
> 而一页散文没有竖直间隙 ⇒ **整页被塞进 65×1 的「表」，第一格是文档标题，还导出成了 CSV**。
> 现在改成：**横线负责说表在哪、行怎么分，列只在表格区域内部推断**（散文被排除在外）。
> 表头单独认 —— 横线在每行**下面**，所以最上面那行表头没有线兜着，光按线取区域必然丢表头。

> ⚠️ **一列的「表」不是表，直接不算**（那正是把整页散文导成 CSV 的原因），
> 但**扔掉多少会记在 `rejected_single_column` 里** —— 「这页没有表」和「这页找到的全是段落」
> 是两个不同的答案，要不要人工去看取决于是哪一个。

**猜不一定看得出来，这才是必须报的理由**：实测 `fixtures/table-grid.pdf` 同一张表
（第 1 页有格线、第 2 页没有），两页现在都读出 4×3 且**单元格逐字相同** ——
数据里没有任何东西说明其中一页是推出来的，**只有那个标志能说**。

CSV 用 `utf-8-sig` 写（带 BOM）：不带 BOM 的中文 CSV 在 Excel 里就是乱码，而 CSV 导出的
去处基本都是 Excel。

### 页面操作

```bash
python3 scripts/pdf_pages.py --op merge   --in a.pdf b.pdf --out merged.pdf --report m.json
python3 scripts/pdf_pages.py --op extract --in a.pdf --pages 1,3-4 --out sub.pdf
python3 scripts/pdf_pages.py --op delete  --in a.pdf --pages 2 --out fewer.pdf
python3 scripts/pdf_pages.py --op rotate  --in a.pdf --pages 1 --degrees 90 --out r.pdf
python3 scripts/pdf_pages.py --op split   --in a.pdf --out ./parts --every 2
python3 scripts/pdf_pages.py --op flatten --in filled.pdf --out flat.pdf --report f.json
```

- **旋转是相对的**（`--degrees 90` 加在现有 `/Rotate` 上），存的是 `/Rotate` 元数据，
  不重写内容 —— 所以文字坐标不变、操作可逆。写成绝对角度的话，对一张已经转过 90° 的页
  再转 90° 就成了空操作，而页数完全正常。
- **拆分产物按源页号命名**（`pages-001-002.pdf`），与 `pdf_render.py` 同一约定。
- **表单文档过一遍页面操作之后还是表单**。`add_page` 会把 widget 连同 `/V` 和 `/AP` 带过去，
  但**不带 catalog 里的 `/AcroForm`** —— 每个值都还在文件里，而这份文档已经不是表单了：
  直接画 `/AP` 的阅读器（预览、Acrobat）照样显示，走表单模块的（PDFium ⇒ Chrome，以及本技能
  自己的 `pdf_render.py`）显示成一张空表。**你先打开哪个阅读器，决定你会不会发现。**
  所以 `/AcroForm` 的搬运装在五个操作**共同的那个出口**上，`/Fields` 从**产出的页面**重建
  （抽页或拆分出来的部分只列它真正带着的域），报告里的 `acroform` 字段无论有没有表单都说一句。
- **两份都带表单的文件不给合并，直接拒绝**（退出码 2 并点名冲突的域）。同名的两个域在阅读器
  眼里**就是同一个域**（在一个里打字另一个跟着变），两份 `/DR` 里同名的字体也可能不是一回事 ——
  这种对账本技能不做，宁可拒绝，也不产出一份「两个不相干的域悄悄共用一个值」的文件。
  **出路就在下面的 `--op flatten`**：把两份各自压平再合并。
- **`--op flatten` 把域的外观画进页面，然后这份文件不再是表单**（`/AcroForm` 与 widget 一起摘掉，
  链接、批注这类**不是** widget 的注释原样保留）。压平之后值会**进入文本层**，可搜索、可复制 ——
  在此之前它们活在注释里，`pdfplumber`/`pdfminer` 一个字都抽不到。
  ⚠️ **一个域有值、而它的外观流是空的，直接拒绝**（退出码 2 并点名是哪个域、值是什么），
  因为把它画下去等于**无声地删掉这个值**。这不是假想：2026-08-15 一次真机验收里，
  模型被上面那句「先把表单压平」推着自己手搓了一个压平，产出的五个 XObject 全是
  **没有流体的裸字典** —— 每个 `Do` 都是空操作、两页渲染得一模一样，而它的总结说「已渲染验证」。
  所以本实现在报告成功之前会**重新打开产物**核三件事：没有 widget 残留 · 每个登记的外观都真的有字节 ·
  画的次数等于压平的域数。
- 合并会把每个输入贡献了几页写进报告：**丢掉第二个输入产出的仍是一个完全合法的 PDF**，
  光看页数看不出来，所以把输入清单交给 `office-skills-selftest.py --check` 的 `baseline`
  才验得住。
- 删光所有页 / 合并只给一个文件 / `--degrees 45` 都是退出码 2。

### 加密

```bash
python3 scripts/pdf_encrypt.py --in report.pdf --out locked.pdf \
        --set-password s3cret --owner-password admin --allow print,copy
python3 scripts/pdf_encrypt.py --in locked.pdf --out plain.pdf \
        --password s3cret --remove-password
```

⚠️ **owner 口令和 user 口令相同时，权限位形同虚设** —— 能打开文件的人就是 owner，
而 owner 不受任何限制（PDF 32000 §7.6.3）。所以 `--allow` 一旦是限制性的而
`--owner-password` 没给（或与 user 口令相同），本脚本**在写之前就拒绝**，不产出那种
「限制其实不生效」的文件。

> ⚠️ 这条**不是**用「打开看看」验出来的，别照着写验证代码：pypdf 无论用哪个口令打开都
> 返回文件里存的那一份 `/P`（实测 user / owner 都读到 20），它证明的是位写进去了，
> **证明不了 owner 不受限**。防线在写入前的拒绝，不在事后的复读。

去口令**必须提供当前口令**（没有绕过路径）。写完会重新打开验证：加密参数对不上时可能静默
产出**未加密**文件，而「所有人都以为受保护、其实没有」是这个脚本能犯的最坏的错。

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

- **不做单选按钮组的创建**：radio 需要多个 widget 共享一个父字段，夹具里手搓一个只会
  测到夹具自己。**读**第三方表单里的 radio 正常，字段模型也认这个类型。
- **AcroForm 的外观流由本技能自己画**（reportlab 嵌入 CJK 子集），并把 `/NeedAppearances`
  写成 false —— 否则会自己重建外观的阅读器会拿它手上的字体重画中文，正是要避的豆腐。
- **越界检查先把 widget 外观压平到页面内容再量**：pdfplumber / pdfminer / PDFium 都只读
  页面内容流，域里的值对三者都是不可见的。压平副本只在临时目录里，不会交给调用方。

## 中文

- **生成走 `pdf_create.py` 的，字形已嵌入**，到别的机器上不会变豆腐。
- **表单填充（`pdf_form_fill.py`）的中文同样嵌入**：四个域共用一份子集，实测 23KB。
- 自己直接调 reportlab 写中文时，**先 `registerFont(TTFont(...))` 再 `setFont`** ——
  用标准 14 号字画中文不会报错，会掉进 ZapfDingbats 画成一排黑方块（实测）。

## 自检

```bash
python3 fixtures/make_fixtures.py            # 重建示例文件；仅在示例本身要改时才跑，见下
```

> 本技能的行为测试（38 条断言 + 53 条负向控制）在 **ultrawork 仓库**里
> （scripts 目录下的 `test-pdf-skill.py`），**不随技能分发** —— 它需要 fixtures 之外的
> 仓库上下文。装在你机器上的这份目录里没有它，别去找。

⚠️ 六个示例里**五个逐字节可复现**（reportlab `invariant=1` + 固定 `/ID` 与日期），
**`locked.pdf` 不是**（AES-256 每次换盐，实测两次运行只有它不同）。另外：git 里那批是
PyMuPDF 时代写的，**重跑得到的不是同一批字节**（`--out-dir` 可以旁路生成来对比）。
重跑会改 `skills/builtin/.builtin-version` ⇒ 所有桌面端重装内置技能。
**没有要改示例内容时不要跑它。**
