# 059 — Office 文档技能（PDF / Word / Excel）重做方案

> 状态：**方案讨论中，未动代码**
> 日期：2026-08-01
> 参考副本：`/Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/skill_reference/`（只读，38MB，5 家 App 的内置技能，见其 `MANIFEST.md`）
> 范围（用户 2026-08-01 拍板）：**PDF / Word(docx) / Excel(xlsx) 三块**；PPT 不在本次范围（deckcraft 已覆盖）
> 许可路线（用户拍板）：**Clean-room 自写，只借鉴思路，不取任何文本/代码**

---

## 一、现状：当前项目不是「四件套」，是按职能切的三块

| 格式 | 生成 | 读 / 改 | 强度评估 |
|---|---|---|---|
| **PPTX** | `deckcraft`（自写，25MB，HTML-first，4 道机器门禁，10 套设计风格，可编辑 pptx） | `doc-edit`（加页/替换文字） | **强**，大概率已超过全部 5 家参考 |
| **DOCX** | `markdown-exporter`（md→docx；纯 SKILL.md 无脚本，靠 pip `md-exporter` + pandoc） | `doc-edit/docx_*.py`（**59 + 40 行**） | **弱** |
| **XLSX** | 同上（md→xlsx） | `doc-edit/xlsx_*.py`（**65 + 44 行**） | **弱** |
| **PDF** | `pdf`（OpenAI Apache 版） | 同左 | **最弱** |

### 精确的差距点（实测，非估计）

- `skills/builtin/pdf/` 全部内容 = `SKILL.md`（68 行）+ `LICENSE.txt` + `NOTICE` + `assets/pdf.png`。**`scripts/` 目录根本不存在**，SKILL.md 只是「建议你用 reportlab / pdfplumber / pdftoppm」的纯指导。
- `doc-edit` 六个脚本的**全部**能力面（实测 argparse）：
  ```
  docx_edit.py  --replace  --append-paragraph  --out
  xlsx_edit.py  --set      --append-row        --out
  pptx_edit.py  --replace  --add-slide --layout --title --out
  *_read.py     [--sheet] [--json]
  ```
  没有修订、没有批注、没有模板、没有样式、没有公式、没有图表、没有校验。
- `markdown-exporter` 是**外部 CLI 包装**：要求用户装 pip `md-exporter` + pandoc。这两个在普通用户机器上默认都不存在，属于「装了才有」的能力。

### 顺带发现的既有缺陷（本次可一并修）

**`doc-edit/SKILL.md` 有 3 处指向不存在的技能**：`:3`（description）、`:22`、`:53` 都写「改用 `doc-export` 技能」，但内置技能里没有 `doc-export`——实际叫 `markdown-exporter`。Agent 按指引去找会扑空，静默退化成不用技能硬写。

---

## 二、参考副本的许可实况（本次调查最关键的发现）

做法：不看目录名，**对 Anthropic 母本逐文件 `cmp` 比对**。

| 来源 | docx | pdf | pptx | xlsx |
|---|---|---|---|---|
| claude-desktop（bundled + runtime） | 母本，专有 LICENSE.txt (1467B) | 母本 | 母本 | 母本 |
| qoderwork | **44/60 逐字节相同** | 9 个同名改写 | 自研（4 文件） | **39/52 逐字节相同** |
| mulerun | 改写，frontmatter 留 `license: Proprietary` | **10/11 逐字节相同** + 带专有 LICENSE.txt | 改写，留 `Proprietary` | **40/52 相同** + 带专有 LICENSE.txt |
| jvs-copilot | 自研 `docxkit`（106 文件，无 Anthropic 痕迹） | 8 个同名改写 | **40/55 相同**，带专有 LICENSE.txt | 自研，但 frontmatter 留 `license: Proprietary` |

**结论**：参考目录里的 docx/pdf/pptx/xlsx 绝大多数是 Anthropic 专有技能的复制或改写。这与本仓库 `skills/builtin/README.md` 第 27-29 行已确立的红线一致（Anthropic 官方四件套专有、禁止再分发，故 PDF 走 OpenAI Apache 版、Office 读改自写）。

ultrawork 是**要签名分发的桌面软件**，取材即污染分发链。

### Clean-room 规程（本次执行纪律）

1. **可以取**：能力清单、工程方法、格式规范（ECMA-376 / PDF spec 是公开标准）、第三方 FOSS 库的用法。这些是事实与方法，不受版权保护。
2. **不可取**：任何 SKILL.md 段落、任何 .py 文件、任何 references/*.md 措辞、目录结构的逐一照搬。
3. **执行方式**：从参考里**只提炼出下面第三节的能力矩阵**（已完成，本文档即产物）；实现阶段**关闭参考目录**，仅照能力矩阵 + 公开库文档写。
4. **交付前自查**：新写文件对 5 家参考做 `cmp` + 相似度扫描，任何逐字节相同的非平凡文件都要重写。此项做成脚本，进验收门禁（见第五节 L0）。

> 唯一值得深读思路的是 **jvs-copilot/docx**（自建 `docxkit`：修订跟踪、批注、XSD 校验、ECMA-376 元素序修复、CJK 排版、13 种美化预设、Gate-check、5 个 flow 路由）。它是四家里唯一无 Anthropic 血缘的，工程完成度最高——但它是 jvs 的专有资产，同样只能读思路。

---

## 三、能力矩阵（"更完备"的可判定判据）

这是回答用户第 4/5 点的核心：**没有这张表，"更优更完备"无法验收**。
勾选规则：`✅`=有且可用 · `△`=部分/需外部重依赖 · `❌`=无。「目标」列是本次要达到的。

### 3.1 PDF

| # | 能力 | 当前 | Anthropic | jvs | mulerun | qoder | **目标** |
|---|---|---|---|---|---|---|---|
| P1 | 页面渲染成图（可控 DPI/页范围） | △ 仅指导 | ✅ | ✅ | ✅ | ✅ | ✅ |
| P2 | 文本抽取（含 bbox 坐标） | △ 仅指导 | ✅ | ✅ | ✅ | ✅ | ✅ |
| P3 | 表格抽取 | ❌ | △ | △ | △ | △ | ✅ |
| P4 | 元数据（页数/尺寸/加密态） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P5 | AcroForm 可填字段探测 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P6 | 表单字段信息抽取（类型/选项/坐标） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P7 | AcroForm 填充 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P8 | 无 AcroForm 时叠加/注释填充 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P9 | bbox 越界校验（文字溢出字段框） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| P10 | 填充结果校验图（画框标注） | ❌ | ✅ | ❌ | ✅ | ✅ | ✅ |
| P11 | 合并/拆分/抽页/旋转 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **超越项** |
| P12 | 加密/解密/去口令 | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **超越项** |
| P13 | 从零生成 PDF | △ 仅指导 | △ | △ | △ | △ | ✅ |
| P14 | **CJK 字体嵌入（中文不豆腐块）** | ❌ | ❌ | △ | ❌ | ❌ | ✅ **超越项·差异化** |
| P15 | 扫描件 OCR | ❌ | ❌ | ❌ | ❌ | ❌ | 🔲 不做（重依赖） |

### 3.2 DOCX

| # | 能力 | 当前 | Anthropic | jvs | mulerun | qoder | **目标** |
|---|---|---|---|---|---|---|---|
| W1 | 文本/结构抽取（段落/表格/样式） | ✅ 基础 | ✅ | ✅ | ✅ | ✅ | ✅ |
| W2 | 就地文本替换 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ | ✅ |
| W3 | 追加段落 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W4 | 从 Markdown 生成 | △ 需 pandoc | △ | ✅ | △ | ✅ | ✅ |
| W5 | 模板套用（占位符填充） | ❌ | ❌ | ✅ | ❌ | ✅ | ✅ |
| W6 | 修订跟踪（插入/删除标记） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W7 | 接受/拒绝修订 | ❌ | △ 需 soffice | ✅ 纯 Py | △ | △ | ✅ 纯 Py |
| W8 | 批注（增/删/读） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W9 | 页眉页脚 | ❌ | △ | ✅ | △ | △ | ✅ |
| W10 | 目录 / 多级编号 | ❌ | △ | ✅ | △ | △ | ✅ |
| W11 | 图片插入/替换 | ❌ | △ | ✅ | ✅ | △ | ✅ |
| W12 | 样式管理（styles.xml） | ❌ | △ | ✅ | △ | ✅ | ✅ |
| W13 | OOXML unpack / pack | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W14 | XSD schema 校验 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W15 | ECMA-376 元素序修复 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| W16 | **CJK eastAsia 字体正确设置** | ❌ | ❌ | ✅ | ❌ | △ | ✅ **差异化** |
| W17 | 转 PDF / 转图预览 | ❌ | △ soffice | ✅ | △ | ✅ | ✅ |
| W18 | 文档 diff（改了什么） | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| W19 | 表格/排版美化预设 | ❌ | ❌ | ✅ 13 种 | ❌ | ❌ | ✅ |

### 3.3 XLSX

| # | 能力 | 当前 | Anthropic | jvs | mulerun | qoder | **目标** |
|---|---|---|---|---|---|---|---|
| X1 | 读单元格 / 表 / 区域 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ | ✅ |
| X2 | 写单元格 / 追加行 | ✅ 基础 | ✅ | ✅ | ✅ | ✅ | ✅ |
| X3 | 公式写入 | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| X4 | 公式求值 / 重算 | ❌ | △ soffice | ✅ | △ soffice | △ soffice | ✅ 分层 |
| X5 | 公式错误扫描（#REF!/#DIV/0!…） | ❌ | △ 靠约定 | ✅ | △ | △ | ✅ 脚本化 |
| X6 | 数字格式 / 字体 / 填充 / 边框 | ❌ | △ | ✅ | △ | △ | ✅ |
| X7 | 条件格式 | ❌ | ❌ | △ | ❌ | ❌ | ✅ |
| X8 | 图表 | ❌ | ❌ | △ | ❌ | ❌ | ✅ |
| X9 | 冻结窗格 / 自动筛选 | ❌ | ❌ | △ | ❌ | ❌ | ✅ |
| X10 | 多表 / 跨表引用 | △ 只读 | ✅ | ✅ | ✅ | ✅ | ✅ |
| X11 | CSV / JSON 导入导出 | ❌ | △ | △ | △ | △ | ✅ |
| X12 | 大文件流式读（read_only） | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **超越项** |
| X13 | 转 PDF / 转图预览 | ❌ | △ soffice | ✅ | △ | △ | ✅ |
| X14 | 财务色彩规范（蓝输入/黑公式/绿跨表） | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| X15 | **中文列宽自适应（CJK 宽字符）** | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ **超越项·差异化** |

### 3.4 完备性判据（机器可统计）

> **门禁 C1**：目标列每一格 ≥ 当前列（不允许退化）。
> **门禁 C2**：`✅` 总数 > 任一单家参考的 `✅` 总数。
> **门禁 C3**：至少 4 项标 **超越项**（无一家参考具备）真实可用。
>
> 这三条写成 `scripts/office-skills-capability-check.py`，读本文档的表格 + 探测技能实际脚本的能力面（argparse/子命令），**表与实现不一致即报红**——防止「表上写了、代码没做」。

---

## 四、落地形态：两案对比（待拍板）

三家参考的共同架构（可安全借鉴的**方法**）：**一个共享 `office/` 底座**（unpack / pack / soffice 探测 / validate / validators）+ **每格式一层薄能力**。Anthropic 的 docx 和 xlsx 各自带一份完整底座副本（**冗余但零耦合**）。

⚠️ **硬约束**：`scripts/pack-builtin-skills.ts:53` **拒绝打包 symlink**（发现即抛错）。共享底座不能用软链，只能各技能各带一份副本，或全部塞进同一技能目录。

### 形态 A — 升级 `doc-edit`，加强 `pdf`（少动结构）

```
skills/builtin/
  doc-edit/          ← 升级：docx + xlsx 的生成 / 高保真改 / 修订 / 批注 / 校验
    scripts/office/  ← 共享底座（unpack/pack/soffice/validate）
    scripts/docx_*.py  xlsx_*.py  pptx_*.py
    references/      ← OOXML / CJK / 财务规范
  pdf/               ← 补 scripts/ 全套
  markdown-exporter/ ← 保留（md→X 快速路径）
  deckcraft/         ← 不动
```

| | |
|---|---|
| **优点** | 技能数不变，路由表不用改；`.builtin-version` 变更面小；`doc-edit` 已被现有文档/ADR 引用，无迁移成本 |
| **缺点** | ① 技能名 `doc-edit` 语义变形（"edit" 却要做生成）——**description 是模型路由的唯一依据，名不副实会直接降低命中率**<br>② 一个 SKILL.md 要同时讲 docx + xlsx 两套完整流程，预计 600+ 行，**每次命中都全量进上下文**<br>③ 与 `markdown-exporter` 生成职责重叠，路由二义 |

### 形态 B — 拆成 `docx` / `xlsx` / `pdf` 三技能（与业界对齐）

```
skills/builtin/
  docx/    SKILL.md + scripts/office/(副本) + scripts/*.py + references/
  xlsx/    SKILL.md + scripts/office/(副本) + scripts/*.py + references/
  pdf/     SKILL.md + scripts/*.py + references/
  deckcraft/          ← 不动（pptx 生成）
  doc-edit/           ← 退化成 30 行路由页，或直接删
  markdown-exporter/  ← 保留或删（见下）
```

| | |
|---|---|
| **优点** | ① 每个 SKILL.md 只讲一种格式，**按需加载、上下文省**，路由命中率高<br>② 与 5 家参考同构，用户心智一致<br>③ 能力矩阵与技能一一对应，验收表好写<br>④ 各带底座副本 = 零跨目录依赖，绕开 symlink 禁令 |
| **缺点** | ① `office/` 底座三份副本（纯 Python，估计 +60~100KB，相对 deckcraft 25MB 可忽略）<br>② 删/改 `doc-edit` 需同步 README + ADR + AGENTS.md + 可能的 gotchas 引用<br>③ 技能数 9→11，设置页技能卡片要重排 |

### 定案：**形态 B**（用户 2026-08-01 拍板）

理由按权重：
1. **上下文成本是硬成本**。技能 SKILL.md 命中即全量进上下文。形态 A 的 600 行合并文档，在每次只想改个单元格的场景也要全付。
2. **description 是路由的唯一依据**（这是 opencode/Claude 技能机制的事实）。`doc-edit` 这个名字要同时钓到"生成 Word"和"改 Excel"两类意图，必然稀释。
3. symlink 禁令让"共享底座"方案在两案里成本一样（都得复制），形态 B 不额外吃亏。

### 附带决策：`markdown-exporter` 怎么办

它是唯一的 md→docx/pptx/xlsx/pdf 快速路径，但**依赖 pip `md-exporter` + pandoc**，普通用户机器上大概率没有。新的 `docx`/`xlsx` 若走纯 Python（python-docx/openpyxl），**在依赖上更可达**。

三个选项，建议 **b**：
- a. 删除 —— 但会丢 md→html/ipynb/csv/json 等长尾格式
- b. **保留但降级为"长尾格式转换"**，把 docx/xlsx/pdf 的路由明确指向新技能（改 description 即可）✅
- c. 原样保留 —— 三方路由二义，模型会随机挑

---

---

## 四·补 — deckcraft 边界与既有资产（2026-08-01 调查补记）

### deckcraft 已经在读 PDF/DOCX/XLSX —— 是资产，不是要绕开的东西

`skills/builtin/deckcraft/scripts/source_to_md/` 有 **~174KB 的抽取实现**：

| 文件 | 大小 | 依赖库 | 许可 |
|---|---|---|---|
| `doc_to_md.py` | 56KB | mammoth | BSD-2 |
| `pdf_to_md.py` | 42KB | **PyMuPDF (fitz)** — 字号分析 / 页眉页脚探测 / 图片表格 bbox / 图注识别 | **AGPL-3.0** |
| `excel_to_md.py` | 13.5KB | openpyxl | MIT |
| `ppt_to_md.py` | 31KB | python-pptx | MIT |
| `web_to_md.py` | 33KB | bs4 / curl_cffi | MIT |

其 PDF 读取能力**已明显强于现有 `pdf` 技能**（后者零脚本），也强于 `doc-edit/docx_read.py`（40 行）。这是本仓库自有代码，无许可障碍。

### deckcraft 要动的三处（主体不改）

1. **路由边界（必改，一行）**：deckcraft 的 description 声明可吃 `PDF/DOCX/XLSX/PPTX/URL/Markdown` 源文档。新增三技能后「把这份 PDF 做成 PPT」会双命中。分界写法：
   - **deckcraft** = *产出物是 PPT* 时用（无论源是什么）
   - **docx / xlsx / pdf** = *产出物是同格式文档* 时用
2. **`x-requires` 依赖声明缺口（既有缺陷，顺手修）**：现为 `[python3.10+, python-pptx, chrome-or-edge, node]`，**未声明 PyMuPDF / mammoth / openpyxl**。设置页依赖检测因此检不到它们，用户拿源文档做 PPT 会在运行中途失败。
3. 不做其他改动 —— ADR-061 明确「pack 后禁再动 `skills/builtin/` 树」的血泪教训仍适用。

### 决策记录（用户 2026-08-01 拍板）

| 议题 | 决定 | 备注 |
|---|---|---|
| 落地形态 | **形态 B**：拆 `docx` / `xlsx` / `pdf` 三技能 | |
| 抽取层复用 | **新技能各自拷贝一份，各自演进** | 放弃构建期同步；接受两份实现漂移的代价，换零耦合与零构建脚本改动 |
| PyMuPDF | **全面采用，能力优先** | 记录事实备日后法务复核：PyMuPDF 为 **AGPL-3.0 或商业授权**。本产品**不打包**该库，由用户机器 `pip install` 自装，技能脚本仅 `import fitz`。deckcraft 现状即如此。用户已知悉并拍板。 |
| 可动技能范围 | `doc-edit` / `markdown-exporter` / `pdf` 可改可删；**deckcraft 只改 description + x-requires** | |
| `markdown-exporter` | 保留，降级为「长尾格式转换」（md→html/ipynb/csv/json/xml），docx/xlsx/pdf 路由明确指向新技能 | 改 description 即可 |
| 测试语料 | 我去找**公开语料**（见 §5 L3） | 优先 python-docx / openpyxl / pdfplumber / pypdf 的测试 fixtures——本就是边界用例集，MIT/BSD 可入 git |
| 执行顺序 | **S1 先行**：先写验收脚本 + 跑当前基线，再动实现 | |

---

## 五、验收设计（用户第 7 点：先设计验证，再开发）

分五层，**L0-L2 全自动、可进 CI；L3 半自动；L4 只能人工**。

### L0 — Clean-room 合规门禁 ✅ **已实现（2026-08-01）**

`scripts/check-skill-originality.py` — 四层检测：

| 层 | 抓什么 | 判级 |
|---|---|---|
| 逐字节 sha256 | 直接复制 | violation |
| 专有许可标记 | `license: Proprietary` frontmatter、专有 LICENSE 的**特征条款**（no-extraction / no-derivatives / Anthropic all-rights-reserved） | violation |
| **AST 骨架指纹**（7-gram，对改名/改注释免疫） | 「看着写」 | violation |
| 措辞 5-gram 相似 | 文档抄写 | review（需 `--allow` 白名单 + 书面理由） |

`scripts/test-skill-originality.py` — 阈值标定 + 负向控制。

#### 标定实测（2026-08-01，别凭直觉改阈值）

| 样本 | 分数 | 检出率 |
|---|---|---|
| 自写代码（deckcraft + doc-edit 共 22 个 .py）vs 参考库 | **max 0.165**，中位 0.138 | — |
| L1：改 12 个标识符 + 换注释 | 1.000 | 11/11 |
| L2：+ 重排顶层函数 + 改字符串字面量 | 0.967 | 11/11 |
| L3：+ 控制流手术（for→while、if/else 反转） | **0.736** | 11/11 |

分离带 **0.165 ~ 0.736**，阈值取 **0.55**（带正中）。

#### 重标定 ①：加入 `pdf`（2026-08-01，S2 收尾义务第 1 条）

`pdf` 是第一个**同活儿**负样本 —— 它用和四家参考同一个库读同样的 PDF，骨架天然更像。实测：

| 负样本 | max | 说明 |
|---|---|---|
| deckcraft + doc-edit（不同活儿，22 个 .py） | 0.165 | 旧基线 |
| **+ pdf（同活儿，5 个 .py）** | **0.168**（`pdf_render.py` ← `qa_text.py`） | 新的最高分，中位 0.135 |

同活儿只把地板抬高了 0.003，分离带变成 **0.168 ~ 0.736**，阈值 0.55 仍在带内、余量充足。

#### 重标定 ②：加入表单族（2026-08-01，S2 第二刀）

表单族比读取类脚本更「同活儿」——它填的就是参考技能填的那类表单：

| 负样本 | max | 最高分文件 |
|---|---|---|
| deckcraft + doc-edit（22 个 .py） | 0.165 | `build_deck.py` |
| + pdf 读取三件（27 个） | 0.168 | `pdf_render.py` |
| **+ 表单族四件（31 个）** | **0.188** | `pdf_form_inspect.py` |

**地板在稳定爬升（0.165 → 0.168 → 0.188）**，趋势与「同活儿代码骨架更像」的预测一致。
分离带 0.188 ~ 0.736，阈值 0.55 仍居中；但这条曲线要一直盯着 —— docx/xlsx 落地后再涨，
就该重新论证阈值而不是继续默认它够用。
**这条不是「果然没事」而是「终于量过了」**——在 pdf 落地前，0.165 这个数字对同活儿代码没有任何
证据力。docx/xlsx 落地时必须照做（`OWN_SKILLS` 加进去再跑一遍）。

#### 两条必须记住的实证

1. **word 级相似度对「看着写」完全无效**。初版只有 5-gram 词相似，实测把一份改了 6 个标识符的复制品判为 `clean`（词相似 0.02，AST 相似 1.00）——**如果没做这个负向控制，我会拿"4 个已知抄袭样本全部打红"当作守卫有效的证据**，而它只能抓逐字节复制这种没人会故意犯的错。
2. **许可证文件必须豁免逐字节比对**。初版把 `LICENSE.txt` 判为违规——Apache-2.0 全文本来就该处处逐字相同；且 Apache 正文第 190 行合法写着 `Copyright 2026 Anthropic, PBC.`，按公司名匹配会连合规的 Apache 技能一起误杀。真正该抓的是**专有许可的特征条款**。

#### 适用范围与局限

- ⚠️ 只适用于**声称自写**的技能。`skill-creator` / `skill-installer` 是从 anthropics/openai 仓库按 Apache-2.0 拉取的，与上游逐字节相同是**正确状态**，不该用这把尺子量（实测它们会报 15 条，属预期）。
- ⚠️ **负样本的功能不同**：deckcraft/doc-edit 与参考技能干的活不一样，0.165 是「无关代码」的下限，不是「同活儿独立写」的下限。新 pdf/docx/xlsx 与参考技能填同样的表单、解同样的 OOXML，骨架天然更像。**每个新技能落地后必须重跑标定并把它加进负样本**，否则阈值会开始误杀。
- ⚠️ 依赖 `skill_reference/`（仓库外、不入 git）⇒ **只能本机跑，不进 CI**（无 corpus 时 exit 2 = skip，不判红）。收尾时手动执行并把报告贴进 PR。

#### 当前基线（2026-08-01 实测）

| 技能 | 结果 |
|---|---|
| `deckcraft`（自写） | ✅ 0 violation |
| `doc-edit`（自写） | ✅ 0 violation |
| `pdf` / `markdown-exporter` / `skill-installer`（上游 Apache） | ✅ 0 violation |
| `skill-creator`（上游 Apache，与 Claude Desktop 同源） | 15 violation — **预期**，见适用范围 |

### L1 — 能力矩阵门禁 ✅ **已实现（2026-08-01）**

`scripts/check-office-skill-capabilities.py` — 直接解析本文档 §3 的三张表，跑五条门禁：

| 门禁 | 判据 |
|---|---|
| **C1** 不退化 | 每行「目标」≥「当前」 |
| **C2** 超覆盖 | 目标 ✅ 总数 > 任一单家参考 |
| **C3** 有新意 | 标「超越项」的 ≥ 4 项 |
| **C4** 能跑通 | `capabilities.json` 声明的每个入口都能执行（默认探针 `--help`） |
| **C5** 无空头 | 已迁移的技能必须覆盖其 ID 段内**全部**目标 ✅ 行 |

每个技能用 `<skill>/capabilities.json` 声明实现：
```json
{"skill": "pdf", "capabilities": {"P1": {"entry": "scripts/pdf_render.py", "probe": ["--help"]}}}
```
ID 段：`P*`→pdf · `W*`→docx · `X*`→xlsx。**没有 manifest 的技能算「迁移中」，不判红**（旧技能早于本契约）。

#### C5 存在的理由（初版漏掉了，负向控制才抓出来）

初版只有 C1-C4，实测报 **OK** —— 因为当时没有任何技能声明 `capabilities.json`，48 个目标 ✅ **一个都没被证实**，C4 形同虚设。这正是本门禁要防的「表上写了、代码没做」，**守卫自己没防住**。C5 补上：一旦技能声明了 manifest 就视为接受契约，其 ID 段内所有目标 ✅ 必须有可执行入口。

#### 负向控制（2026-08-01 实测，四条全红、还原后回绿）

| 场景 | 结果 |
|---|---|
| 只声明 1 项（pdf 目标有 14 项 ✅） | C5 红，精确列出缺的 13 项 |
| 声明的入口文件不存在 | C4 红 `declared entry missing` |
| 入口存在但退出码非零 | C4 红 `exited 3` |
| 篡改矩阵令 W2 目标 < 当前 | C1 红 |

#### 当前基线（2026-08-01）

```
matrix: 49 rows across 4 references
target ✅ = 48   references: Anthropic=22, jvs=36, mulerun=23, qoder=26
beyond-reference items (5): P11, P12, P14, X12, X15
not yet declaring capabilities.json: pdf, docx(不存在), xlsx(不存在)
```
即：**目标 48 项 ✅，最强的单家参考（jvs）是 36 项**。C2 有 12 项余量。

### L2 — 产物合法性机器门禁 ✅ **已实现（2026-08-01）**

`scripts/office-skills-selftest.py` — 16 条断言，两种模式：默认跑自检（每条断言正负控制各一遍），`--check FILE --expect JSON` 是 S2-S4 用来卡真实产物的门禁。

| ID | 断言 | 层 |
|---|---|---|
| **D1** | 包完整性：必需 part 齐全、每个 XML 可解析、`r:id` 都能在 rels 里解析到 | core |
| **D2** | ECMA-376 XSD schema 校验 | xsd |
| **D3** | python-docx 回读：可打开、段落/表格数与期望一致、指定文本仍在 | core |
| **D4** | 元素序：`w:pPr`/`w:rPr`/`w:tblPr`/`w:tcPr`/`w:trPr` 必须是首子元素，`w:sectPr` 必须是 body 末元素 | core |
| **D5** | 修订标记：`w:del` 内只能 `w:delText`，`w:ins` 内不能有 `w:delText`，且 `w:id`/`w:author` 必填 | core |
| **D6** | 中文 run 必须同时有 `w:rFonts/@w:ascii` 和 `@w:eastAsia` | core |
| **D7** | soffice 转 PDF → 渲染 → 非空白 + 非豆腐块 | soffice |
| **X1** | openpyxl 回读值/公式与期望一致 | core |
| **X2** | 全表扫 `#REF! #DIV/0! #VALUE! #N/A #NAME? #NULL! #NUM!`（公式文本 + 缓存值两个视图） | core |
| **X3** | soffice 重算后取值与期望比对 | soffice |
| **X4** | 财务色彩规范：硬编码输入蓝、公式黑、跨表引用绿 | core（**opt-in**） |
| **X5** | 含中文的列宽必须按宽字符计（否则渲染出 `####`／截断） | core |
| **P1** | 栅格化成功且无空白页 | core |
| **P2** | 文本回抽 == 写入文本 | core |
| **P3** | 填充值不越出字段框（自然文本宽 + 实际 span bbox 双判） | core |
| **P4** | 中文抽取回来仍是中文，且渲染成字形而非豆腐块 | core |

#### 补丁 ①：旋转页的假阳性（2026-08-01，由 S2 的第一个产物发现）

`cjk_center_ink_fraction` 从 `get_text("rawdict")` 取字符框（**页面坐标系**），却拿
`get_pixmap` 的栅格（**显示坐标系**）去量。页面带 `/Rotate` 时两者不是一个框，每个字都被量到
一片空白纸上。实测 `skills/builtin/pdf/fixtures/report-cjk.pdf`：

| 页 | 旋转 | 修复前 | 乘 `page.rotation_matrix` 后 |
|---|---|---|---|
| 1 / 2 | 0° | 1.00 | 1.00 |
| **3** | **90°** | **0.04（判豆腐块）** | **1.00** |

被判红的是**未经改动的源文件本身**，不是产物 ⇒ 缺陷在门禁，不在被测对象。修复=字符框先乘
`rotation_matrix`。新增一对用例（`rotated` 必须静默 / `rotated-tofu` 必须仍然打红），并跑了
**控制臂**：把修复回退后，`rotated` 用例立刻 FAIL 而 `rotated-tofu` 仍 PASS ——
证明修复真的在起作用，且不是靠把检查变瞎换来的静默。自检 46 → **48 passed / 0 failed / 3 skipped**。

> 这是同一类坐标系错误在本轮的**第二次**出现（第一次在 `pdf_extract.py` 自己的 bbox 输出上）。
> 两处都不是拼写错误，是「PyMuPDF 读用页面系、画用页面系、渲染用显示系」这个非直觉契约。

#### 自检结果（2026-08-01 实测）

```
34 passed, 0 failed, 3 assertion(s) skipped
```
28 条产物用例（3 正向控制 + 25 负向控制）+ 2 条 tier 故障注入。**flaw → 触发 check 的矩阵已逐格核对**：除「包坏了顺带把 D3-D6 一起打红」「空白页顺带没有文本」这类真实级联外，无一条负向控制触发了非目标断言。

#### 三条实证（都是先绿后被自己的审计推翻）

1. **「全绿」第一次出现时是假的**。首轮 28/28 全过，逐 flaw 打印触发矩阵才发现 `X2 err-in-formula` 同时点亮了 X4——因为跨表引用判据写成了 `"!" in formula`，而 `=#REF!*2` 里也有 `!`。改成 `SheetName!A1` 的正则并剔除错误令牌后消失。**「负向控制全部打红」不等于「打红的是对的那条」，必须看触发矩阵。**
2. **阈值在合成样本上标定 = 没标定**（gotchas §10⑭ 的同一个坑，第二次踩）。豆腐块判据初版取「暗像素 < 140」，用一行 16pt china-s 合成文本标定得 1.00/0.79/0.00 三档，看着分离得很干净；一拿仓库里真实的 `deckcraft/examples/.../deck.pdf` 去跑，**第 5 页 0.47 被判豆腐块**——真实排版的笔画细、抗锯齿后灰度根本到不了 140。改成 < 200 后：真实 24 页 min 0.96 / 合成 1.00 / 对抗性空心字（口囗田日）0.79 / 豆腐块 0.00，且在 cut 200/225/240 × DPI 200/300 上是平台而非悬崖。
3. **默认打开的规范 = 对所有人生效的规范**。X4 财务色彩初版默认开启，仓库自带的 `sample.xlsx`（一个普通测试 fixture）立刻两条红。财务蓝/黑/绿是财务建模约定，不是电子表格的普遍属性 ⇒ 改为 **opt-in**（`"finance_colors": true`），由调用方声明意图。

#### 分层与「跳过 ≠ 通过」

| 层 | 依赖 | 本机状态 | 缺失时的残余覆盖 |
|---|---|---|---|
| core | 纯 Python（python-docx / openpyxl / pypdf / PyMuPDF / lxml） | 全部可跑 | — |
| soffice | LibreOffice | **未安装** | 失败路径**已覆盖**（把 `SOFFICE` 指向不存在的二进制，断言 D7/X3 必须报错而不是静默返回干净）；栅格判据与 P1/P4 共用、已被负向控制。**唯独 soffice 转换本身没跑过** |
| xsd | ECMA-376 官方 xsd（不入 git，`$ECMA376_XSD_DIR` 指路） | **未提供** | **无任何残余覆盖**——D2 的通过路径与失败路径都从未执行过 |

报告里逐条列出跳过项 + 残余覆盖，不合并成一句「N skipped」（no silent caps）。
另有 **INERT** 一档：`--check` 时若 expectations 没给对应字段（如 P2/P4 没有 `contains`、X1 没有 `sheets`），该断言其实无事可断，报告显式标出并在汇总行写明「没有期望的产物不算验过的产物」——这正是 L1 C5 补丁要防的同一个洞。

#### 当前基线（2026-08-01 实测）

**假阳性检验**（仓库内三份真实产物，均应全绿）：

| 产物 | 结果 |
|---|---|
| `packages/knowledge/sidecar/src/__fixtures__/sample.docx` | ✅ 0 finding |
| `packages/knowledge/sidecar/src/__fixtures__/sample.xlsx` | ✅ 0 finding |
| `skills/builtin/deckcraft/examples/ai-coding-pilot/export/deck.pdf`（24 页中文） | ✅ 0 finding |

**现有技能基线**（用当前 `doc-edit` 对上面两份 fixture 做一次编辑，再过门禁）：

| 操作 | 结果 |
|---|---|
| `docx_edit.py --append-paragraph "中文…"` | ❌ **D6**：新增 run 完全没有 `w:rFonts` |
| `xlsx_edit.py --set Sheet1!D2 "营业收入合计"` | ❌ **X5**：D 列写入中文后未调列宽，留在 8.43 默认 |
| `pdf` 技能 | 无脚本，产不出任何产物 ⇒ 无基线可测 |

即：**当前技能的编辑路径，恰好在 §3 标为差异化目标的两项（W16 eastAsia / X15 中文列宽）上失败**，且输入文件本身是干净的——缺陷是编辑动作引入的。这是 S2-S4「更优」最直接的对照数字。

#### 已知局限（不要当成已验证）

- D2 完全没跑过（见上表）。**S4 做 docx 之前必须补 XSD**，否则「过 schema 校验」这句话在本仓库没有任何实证支撑。
- D7/X3 的 soffice 转换路径没跑过；本机装 LibreOffice 或在 CI 上装即可闭合。
- 假阳性检验只用了 3 份产物，且 `sample.docx/xlsx` 的生成器未知。**D4/D5 从未跑过真正由 Word 保存的文档**——Word 会写入大量 python-docx 不产生的结构，元素序检查在真实文档上是否有假阳性属于未知。→ 归入 L3 真实语料回归。
- 跨平台：全程 `pathlib` / `platform` 分支 / 无硬编码 `/tmp` / 无 unix-only 命令（soffice 与 pdftoppm 均按平台探测且可缺失），但**只在 macOS 跑过**，Windows/Linux 靠 CI。

### L3 — 真实语料回归

> 教训来源：ADR-070 P2（LaTeX）——**手编用例 100% 通过，两个真缺陷全靠 279 个真实公式抓出来**。想象不出来的缺陷只能靠真实语料。

需要准备（**这一项需要你提供或授权我去找**）：
- 真实 `.docx`：含修订、批注、多级编号、页眉页脚、中文混排、复杂表格 —— 目标 ≥ 20 份
- 真实 `.xlsx`：含跨表公式、合并单元格、条件格式、大表（>10 万行）—— 目标 ≥ 15 份
- 真实 `.pdf`：含 AcroForm 表单、扫描件、中文、加密 —— 目标 ≥ 15 份

跑法：全语料过一遍 read→edit→validate 环，统计崩溃率/损坏率，与当前 `doc-edit` 基线对比。**这是"更优"最有说服力的证据**。

### L4 — 人工主观验收（不可自动化，必须承认）

**机器门禁只能验产物合法性与规范符合，验不了"生成的文档写得好不好"**。以下只能你来判：
- 生成的 Word 报告排版是否专业、层次是否清晰
- Excel 财务表是否符合行业审美
- PDF 版面是否可交付

按既有分工约定：我做定位/方案/机器可测的验证，你做视觉/主观判断。**我不会拿门禁全绿冒充"更优"。**

### 替换判据（用户第 5 点）

> **只有 L0 全绿 + L1 三条门禁全过 + L2 全绿 + L3 崩溃率/损坏率 ≤ 当前基线 + L4 你点头，才替换。**
> 任一不满足 → 新技能以「附加」形式存在，不删旧的。

---

## 五·补 — S2 开工前的联合 review（2026-08-01）

L0/L1/L2 三个门禁齐了之后做的一次回看：**标尺本身够不够、方案有没有靠不住的前提**。以下每条都有实测支撑，不是设想。

### 5·补.1 头号缺口：整个技能族最常见的损坏，方案与门禁都没覆盖

拿仓库里的真实文件做**空操作** round-trip（读进来、一个字节不改、存回去）：

| 文件 | 结果 | 内容核实 | 判定 |
|---|---|---|---|
| `sample.xlsx` | 丢 `xl/metadata.xml` | **904 字节真实 XLDAPR 动态数组元数据** | ⚠️ 真实丢失，L2 却全绿 |
| `sample.docx` | 丢 `word/_rels/document.xml.rels` | **空壳，0 个 Relationship** | ✅ 省略无害，**初判有误** |

xlsx 那半条成立：文件照样能打开、照样过全部 16 条断言。**L2 验的是「产物自身合法」，没有一条验「相对输入的保真度」**——而 docx/xlsx 技能的核心动作是「读和改」，用户最怕的正是「我只改了一个单元格，图表/透视表/宏悄悄没了」。合法 ≠ 没弄丢东西。

docx 那半条**是我判错了**，而这个错误直接改进了断言设计：初稿写的是「输入里的 part 输出里必须都在」，照此 `sample.docx` 会判红，而 python-docx 不写空 rels 是正确行为 ⇒ **数 part 不是保真度测试，得看 part 内容**。这两个文件因此成了一对天然的正负样本（同样是「少了一个 part」，判定相反，只有内容能分开它们），双双固化进 L2 的回归用例。

一条纠偏，免得后面选型时被传闻带偏：**openpyxl 并不会丢图表和条件格式**。实测自建 xlsx 的 chart / conditional formatting / data validation / freeze panes / auto filter 全部原样保住。真正丢的是**它不认识的 part**。所以这不是换个库能解决的问题，必须（a）在实现里显式保留未知 part，（b）加保真度断言把它钉住。

> 连带的方案风险：§3 的 X7/X8（条件格式/图表）标了目标 ✅，但若编辑路径是 `load → save`，保真度得单独设计，不是选个库就白送。

### 5·补.2 L1 与 L2 之间有一条缝

脚本统计（非估计）：

```
目标 ✅ 共 48 项 · L2 有产物断言的 19 项 · 无任何产物断言 29 项（60%）
  pdf  缺 10: P3 P4 P5 P6 P7 P8 P10 P11 P12 P13
  docx 缺 10: W4 W5 W8 W9 W10 W11 W12 W13 W18 W19
  xlsx 缺  9: X3 X6 X7 X8 X9 X10 X11 X12 X13
```

而 L1 的 C4 探针只是跑 `--help` 看退出码。两者合起来：

> 一个能力可以「矩阵打 ✅」+「有脚本」+「`--help` 退出 0」+「L2 不测它」= **三关全过，功能是空壳**。

这正是 C5 要防的「表上写了、代码没做」，只是从「没声明」退化成了「声明了但是空的」。

**解法（不是补 29 条断言）**：把 `capabilities.json` 的探针从 `--help` 升级为「跑一个真实样例产出 artifact」，再把 artifact 喂给 `office-skills-selftest.py --check` + 对应 expectations。L1/L2 打通后 C4 从「能启动」变成「真做了事且产物合法」，断言随能力一起写，覆盖率自然长。

### 5·补.3 「纯 Python 依赖更可达」这个前提不成立

§4 选形态 B 的理由之一是「新的 docx/xlsx 走纯 Python，依赖上比 pandoc 更可达」。实际：

- `python-docx` / `openpyxl` / `PyMuPDF` / `pypdf` 在普通用户机器上**同样不存在**，和 pandoc 一样要装。可达性优势是没有的，真正的优势只剩「装一个 pip 包」比「装 pandoc 二进制」轻。
- 依赖探测的真实 SSOT 是 `packages/client/desktop/src/lib/use-skill-deps.ts` 的 `BUILTIN_DEP_MAP` + `src-tauri/src/lib.rs:4521` 的 `run_python_feature_probe`，**后者硬编码只返回 `(版本OK, python-pptx OK)` 两个布尔** ⇒ 新增 4 个库的探测**要改 Rust**，方案里没算这份工作量。
- `SKILL.md` 的 `x-requires` 只是给人看的镜像，与 `BUILTIN_DEP_MAP` 双写、**无一致性门禁**。

**决策（2026-08-01）**：收进范围，但走**泛化**而非「再加 4 个布尔」，排在 **S5/S6**，不塞进 S2-S4。
- 泛化 = `run_python_feature_probe` 接受模块名列表、返回哪些 import 成功。探测进程数与耗时几乎不变（现在已经在为 deckcraft 起一个 Python 进程），之后每加一个库只是 `BUILTIN_DEP_MAP` 一行数据。继续硬编码则三技能改一次 Rust、将来每个新技能再改一次。
- 顺带修掉 §4·补第 2 点那个既有缺陷（deckcraft 用了 PyMuPDF/mammoth/openpyxl 却没声明），并把 `x-requires` ↔ `BUILTIN_DEP_MAP` 的一致性做进 `check-docs.ts`。
- 排后面是因为它**不阻塞开发**（开发机上库都有），但**必须在发版前完成**，否则用户装了技能却看不到缺什么。

### 5·补.4 C5 契约会逼出「大爆炸式交付」

C5 规定：技能一旦声明 `capabilities.json`，其 ID 段内**全部**目标 ✅ 必须有可执行入口。pdf 有 14 项目标 ✅ ⇒ **S2 得一次做完 14 项才能声明**，做完 8 项就声明会直接判红。这与 §6「S2 先做 pdf、可独立验收」的增量意图冲突。

C5 本身是对的（它抓到过真实的洞），需要的是一个**欠账显式化**的出口。✅ **已实现（2026-08-01）**：

```json
{"skill": "xlsx",
 "capabilities": {"X1": {...}, "X2": {...}},
 "pending": {"X7": "条件格式待 S3", "X8": "图表待 S3"}}
```

`pending` 里的 ID 从 C5 的 unbacked 中扣除，欠账**逐条列进报告**（带理由；写成数组则标注 `no reason given`）。**一个能藏债的出口比没有出口更糟**，所以加了三道校验 + 一个验收档：

| 规则 | 行为 |
|---|---|
| ID 不在本技能的 ID 段内 | 报错（防止拿别家的 ID 洗账） |
| 同一 ID 既 implemented 又 pending | 报错 |
| `pending` 不是 list/object | 报错 |
| **`--no-pending`（验收档）** | 只要还有 pending 一律判红——§5 的替换判据要求交付时门禁全绿 |

`--selftest` 从 6 → **13 条**，其中三条是端到端跑真实门禁：
- A：X 段目标 ✅ 全部覆盖（13 实现 + 2 pending）→ C5 完全不出现
- B：同一份 manifest 加 `--no-pending` → `C5 pending` 判红
- C：**控制臂** —— 把 `pending` 块整个删掉 → `C5 unbacked` 回来

> C 臂是补上去的。初版只有 A/B，而 A 的判据是「没有 `C5 pending` 这条失败」——**即使 `pending` 从未抑制过任何东西，A 也会通过**（unbacked 是另一条消息）。只有 C 能证明抑制是真的发生了。

### 5·补.5 方案里还没写的三处

1. **三份 office 底座副本的漂移无检测**。§4·补决定「各自演进」，但没有任何机制告诉你三份副本何时分叉。至少该有个只报告不阻断的 diff 门禁。
2. **`markdown-exporter` 的分界**：大方向 §4·补 已定（降级为长尾格式 md→html/ipynb/csv/json/xml，**docx/xlsx/pdf 一律指向新技能**），所以这不是待定而是**待执行**——改它的 description。⚠️ 它现在白纸黑字写着 `Convert Markdown text to DOCX, PPTX, XLSX, PDF, ...`，**`pdf` 技能一增强就立刻双命中**，因此这条在 **S2 阶段就要处理，不能拖到 S4**。剩余边缘判据（用户明说「快速转一下」时是否仍走长尾路径）留 S6 定。
3. **回滚策略与 doc-edit 去留互相矛盾**。§5 说「任一不满足 → 新技能以附加形式存在，不删旧的」；§4·补说 doc-edit 可改可删。若 docx 没过验收而 doc-edit 保留，路由二义就回来了 ⇒ 需写清「附加模式」下三方 description 怎么写。

### 5·补.6 门禁各自还欠的

| 门禁 | 欠账 |
|---|---|
| **L0** | ① 「新技能落地后必须重跑标定并加进负样本」没写进 §6 阶段表 ⇒ 会漏。新技能与参考技能填同样的表单、解同样的 OOXML，骨架天然更像，阈值 0.55 迟早误杀。② 只比 `skill_reference/`；新技能一定会照着 PyMuPDF/openpyxl **官方文档示例**写，那些 L0 完全不看（多数 MIT/BSD 可用，但这是已知盲区，不是默认安全） |
| **L1** | C4 探针过弱（5·补.2）；C5 缺 `pending` 出口（5·补.4） |
| **L2** | ~~缺保真度断言~~（5·补.1 已做）；**D2 通过与失败路径都没跑过**，见 5·补.8；D4/D5 从未跑过真正由 Word 保存的文档；soffice 转换成功路径没跑过 |

### 5·补.8 ECMA-376 XSD 的处置（2026-08-01 拍板）

soffice 拍板必装后，`xsd` 也被一并列进 L2 的 `REQUIRED_TIERS`。**但本机与 CI 都没有 schema，也还没写下获取渠道** ⇒ 严格档下任何 docx 产物永远红。两条路选一条：

- **A（已选）**：**S4 开工前搞到 ECMA-376 XSD 并接进 CI**（`$ECMA376_XSD_DIR`），D2 才算真存在。在那之前 `xsd` **保持 REQUIRED**，开发期用 `--allow-missing xsd` 显式放行。
- B（未选）：把 `xsd` 降回可选，承认 D2 短期只是占位。

选 A 的理由：D2 是「产物过 schema 校验」这句话唯一的权威依据，降级等于把它变成永久欠账；保持 REQUIRED 则每次跑严格档都会提醒它还欠着。

⚠️ **未核实项**：ECMA-376 XSD 由 ECMA/ISO 公开发布，但**是否可随本仓库分发尚未查证**。若不可入 git 则走「CI 下载 + 本机 `$ECMA376_XSD_DIR` 指路」，不 vendored。**S4 开工前必须先查许可，再决定放置方式。**

### 执行顺序（2026-08-01 拍板）

1. ✅ **5·补.1 保真度断言 + 5·补.2 L1/L2 打通**（2026-08-01 完成，见 5·补.7）
2. ✅ **§7 第 1 条 LibreOffice 策略定案**（2026-08-01，soffice 列为 docx/xlsx 必需依赖；L2/L1 的 tier 语义已同步翻转）
3. ✅ **5·补.4 给 C5 加 `pending` 出口**（2026-08-01 完成）
4. 然后进 S2

### 5·补.7 第 1 项的落地结果（2026-08-01）

**L2 新增 4 条保真度断言**（`expect["baseline"]` = 编辑前的文件；不给则该条 INERT）：

| ID | 断言 |
|---|---|
| **F1** | docx/xlsx：输入里的每个 part 必须仍在输出里。**内容为空的 part 豁免**（`part_is_inert`，理由见上面那对样本） |
| **F2** | docx：`styles`/`numbering`/`settings`/`header*`/`footer*`/`footnotes`/`endnotes` 仍在，且 `document.xml.rels` 的关系数不减少 |
| **F3** | xlsx：sheet 名、图表数（从包里数，不靠 openpyxl 解析）、条件格式/数据验证/合并区/显式列宽 的条数不减少，冻结窗格与自动筛选不丢 |
| **P5** | pdf：页数不减少；不在 `touched_pages` 里的页，文本必须逐字不变 |

**负向控制不是编造的破坏，就是那个显而易见的写法**：`openpyxl load → save` / `python-docx 读 → 存`。这正是三个技能都会第一时间伸手去拿的实现方式，也正是它悄悄丢掉 `xl/metadata.xml` 的地方。另加两条**真实文件回归**（仓库自带 fixture，缺失时报 SKIP 不判红）：`sample.docx` 必须**保持静默**、`sample.xlsx` 必须**判红**。

自检从 34 → **46 passed / 0 failed / 3 skipped**，断言 16 → 20 条。逐条核过 flaw→check 触发矩阵，交叉触发全部是真实级联（如 `styles.xml` 没了，python-docx 确实打不开 ⇒ D3 也红）。

一条顺带修掉的 fixture 缺陷：为保真度新建的 rich xlsx 里 `汇总` 页中文列没设宽度，**X5 立刻把它抓红了**——门禁先在自己的测试夹具上咬了一口。

**L1 的 C4 从「`--help` 退出 0」升级为「跑样例产出 artifact → 交给 L2 校验」**：

```json
{"skill": "docx", "capabilities": {"W6": {
  "entry": "scripts/docx_revise.py",
  "sample": {"args": ["--in", "{fixtures}/base.docx", "--out", "{out}/o.docx"],
             "produces": ["o.docx"]},
  "expect": {"baseline": "{fixtures}/base.docx", "contains": ["修订"]}}}}
```

判据：退出码 0 · `produces` 的文件存在且非空 · 产物若是 docx/xlsx/pdf 则**必须过 L2** · 期望不能是空的（内容类断言全 INERT ⇒ 判红）。保留只有 `probe` 的退化档（技能在建期需要落脚点），但**报告里单列计数并加 ⚠**，避免大家都写 `--help` 把 C4 打回原形。保真度类断言的 INERT **不判红**（生成型能力本就没有 baseline），改为 NOTE 提示「该产物的保真度没人验过」。

`--selftest` 六条负向控制（`python3 scripts/check-office-skill-capabilities.py --selftest`，6 passed）：

| 场景 | 期望 |
|---|---|
| 样例产出合法 docx + 期望充分 | 接受 |
| **样例产出的 docx 中文 run 缺 `eastAsia`** | 拒绝 `fails L2 — D6` ← **这条正是 `--help` 永远抓不到的** |
| 样例退出码 3 | 拒绝 `sample exited 3` |
| 样例退出 0 但没产出声明的文件 | 拒绝 `missing or empty` |
| 产物合法但 `expect` 为空 | 拒绝 `had nothing to check` |
| 只声明 `probe` | 接受，但标记 `proof=startup-only` 并计数 |

> 剩下 29 项无断言的能力**不打算一次性补齐**：断言随能力一起写，C4 会在每个能力落地时强制它带上样例与期望。

---

## 六、分阶段执行计划（含窗口切换点）

| 阶段 | 内容 | 产出 | 建议窗口 |
|---|---|---|---|
| **S0** | 本方案定稿（形态 A/B 拍板、语料准备、markdown-exporter 去留） | 本文档 + ADR 草案 | **当前窗口** |
| **S1** ✅ | 先写验收骨架：L0/L1/L2 三个脚本 + **对当前技能跑一遍拿到基线数字** | 3 个脚本 + 基线报告（见 §5 L0/L1/L2） | 已完成 2026-08-01 |
| **S2** 🟡 | `pdf` 技能重做 —— **第一刀** P1/P2/P4（`071cd18c`）· **第二刀** 表单族 P5-P10（`513c9a84`）· **第三刀** 生成 P13 + 字体嵌入 P14。**剩 P3/P11/P12** | pdf/ 11 项能力 + L0/L1/L2 全绿 | 进行中 |
| S2 收尾 | ✅ Rust 依赖探测泛化（5·补.3）已完成：`run_python_feature_probe` 接受模块名列表，`PY_MODULES` 数据化 | 探测数据化 | 已完成 |
| **S3** | `xlsx` 技能（含 office 底座首次实现） | xlsx/ + office 底座 | **新窗口** |
| **S4** | `docx` 技能（最复杂：修订/批注/XSD/CJK） | docx/ | **新窗口**（可能需 2 个） |
| **S5** | L3 真实语料回归 + L4 你真机验收 + 决定是否替换 | 验收报告 | 新窗口 |
| **S6** | 收尾：README / AGENTS / gotchas / conventions / ADR / CHANGELOG / `.builtin-version` | 文档同步 | 新窗口 |

> **S1 先于 S2 是刻意的**：先有验收标尺和当前基线，才谈得上"更优"。
> 教训来源：稳定性 review 的六条教训之一——**先自证通过、后被推翻**，就是因为标尺是事后凑的。

### 每个技能阶段（S2/S3/S4）的收尾义务

1. **重跑 L0 标定，并把新技能加进负样本**（§5 L0「适用范围与局限」第二条）。新技能与参考技能填同样的表单、解同样的 OOXML，骨架天然更像，**不重标阈值 0.55 迟早误杀**。写在这里是因为它极容易漏。
2. `capabilities.json` 里当轮没做完的能力**必须进 `pending` 并写理由**，不允许「不声明」。
3. **`skills/builtin/` 树的改动成批做、每阶段只 pack 一次**：`.builtin-version` 是按技能树内容算的 hash（ADR-061 P3 重算过一次）。开发期可以不 pack（直接跑脚本即可），但**每个 S 阶段收尾必须重跑一次 fetch/pack**，否则 zip 与 `.builtin-version` 不一致。
   归批原则 = **谁与本阶段的路由/能力同时生效，就跟谁一批**：
   - **S2**（建 `pdf/` 必然要 pack）：顺带改 `markdown-exporter` 的 description。它现在声明能产 PDF，**与新 pdf 技能是直接冲突，必须同时生效**，不能分两批。
   - **S6**：`doc-export` 断链（`doc-edit/SKILL.md` 三处）+ deckcraft 的路由边界 —— 这两项都与 docx/xlsx 绑定，等三技能齐了再一次改完。

---

## 六·补 — S2 第一刀（薄切片）落地记录（2026-08-01）

目标是**先打通端到端管线**，不是一次铺完 14 项：能力 → 样例 → 产物 → L2 → 报告这条链先跑通，
后面每加一项能力才有地方挂断言。

### 落地内容

`skills/builtin/pdf/` 从「上游 Apache 版 + 零脚本」整体替换为自写：

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 重写。description 明确边界（产物是 PDF→本技能；做 PPT→deckcraft；改 Office→doc-edit），并**白纸黑字列出没实现什么** |
| `scripts/pdfcommon.py` | 开文件（含加密分支）/ 页范围解析 / 错误出口 |
| `scripts/pdf_render.py` | **P1** 渲染成图，可控 DPI 与页范围 |
| `scripts/pdf_extract.py` | **P2** 文字 + bbox 抽取（word/line/block），可选画框校验 PDF |
| `scripts/pdf_info.py` | **P4** 页数 / 逐页尺寸与旋转 / 加密态与权限位 |
| `fixtures/` | `make_fixtures.py` + 两个生成的 PDF（三页中文报告含一页旋转 90°；一个 AES-256 加密件） |
| `capabilities.json` | 3 项 implemented（全部 sample 档）+ **11 项 pending 逐条写理由** |
| 删除 | `LICENSE.txt`（上游 Apache）、`assets/pdf.png`；`NOTICE` 改为自写声明 |

连带（与 pdf 路由**同批生效**，§6 归批原则）：`markdown-exporter` description 降级、
`fetch-builtin-skills.ts` 移除 pdf 源、`BUILTIN_DEP_MAP` + Rust 探测改 PyMuPDF、
`skills/builtin/README.md` 改血缘表。

### 门禁结果（全部本机实测）

| 门禁 | 结果 |
|---|---|
| **L0** clean-room | `pdf` clean（0 violation / 0 review）；重标定后分离带 0.168 ~ 0.736，阈值 0.55 仍居中 |
| **L1** 能力矩阵 | OK。`3/3 pass (3 proved by sample, 1 artifact(s) verified by L2)`，11 项 pending 逐条列出 |
| **L1 `--no-pending`** | **红**（预期）——欠账未清时验收档必须拒绝 |
| **L1 `--selftest`** | 13 passed |
| **L2** 产物合法性 | 48 passed / 0 failed / 3 skipped（新增旋转页正负一对） |
| **pdf 行为测试** | `scripts/test-pdf-skill.py`：14 条断言 + 16 条负向控制，17 passed，flaw→check 矩阵每行只点亮该点亮的那条 |
| typecheck / desktop / Rust | 8 task · 857 · 155，全绿 |

### 本轮抓到的两个真缺陷（都是坐标系，且第二个在门禁自己身上）

1. **`pdf_extract.py` 的 bbox 与渲染图对不上**。PyMuPDF 的非直觉契约：`get_text` 给**页面坐标系**
   （未旋转），`get_pixmap` 渲染**显示坐标系**（旋转后），而 `draw_rect` 又吃页面坐标系。
   实测旋转 90° 的第 3 页：抽出的框 `(60,75,450,93)` 框内只有 36 个暗像素，映射后的
   `(502,60,520,450)` 有 2282 个。解法不是二选一而是**两个框都给**（`bbox` / `bbox_display`），
   因为两个消费场景（写回 PDF / 画到 PNG）真的需要不同的框。
2. **L2 的豆腐块判据在旋转页上假阳性**（详见 §5 L2 补丁①）。**是 L1 把它抓出来的**——我自己的
   E2 断言只验「框落在字上」，用的就是 `bbox_display`，所以永远发现不了 L2 用错框。
   **两层门禁互相咬到了对方漏的那一口**，这是 S1 分层的第一次真实回报。

### 明确没做 / 与原计划的偏差（都是有意的）

- **P1 与 P4 的产物 L2 验不了**：PNG 与 JSON 不在 L2 的 `KIND_BY_SUFFIX` 里，所以「1 artifact
  verified by L2」指的只有 P2 的画框 PDF。C4 对 P1/P4 实际只证到「退出 0 且产出非空文件」。
  这个洞由 `scripts/test-pdf-skill.py` 补（R1-R3/R5、I1-I4 都是它在断言），
  `capabilities.json` 里每项都写了 `verified_by` 指向具体断言号。**不要把 L1 绿当成 P1/P4 验过了。**
- **`markdown-exporter` 只改掉了 PDF/PPTX 的路由，docx/xlsx 暂留**。原计划是三个格式一起指向新技能，
  但 docx/xlsx 技能 S3/S4 才存在 —— 现在就把路由指过去，就是复刻 §1 那个
  `doc-export` 断链缺陷（三处指向不存在的技能）。description 里写明「专用技能建设中，届时接管」。
- **`x-requires` 只声明 `pymupdf`，没声明 `pypdf`**：本轮没有任何脚本 `import pypdf`。声明一个没人调用的
  依赖 = 用户机器上凭空多一个红徽标。P7/P11/P12 落地时如果真用到再加。
- **§3.1 的「当前」列不动**：它记录的是重做**之前**的基线，是「更优」这个说法的对照系。
  跟着实现改它，等于把对照系抹掉。
- **没有重跑 `fetch-builtin-skills.ts`**：它的三个源都 pin 在 `ref: "main"`，重跑会把未经审阅的上游
  变更一起拉进来。收尾义务的实质是「zip 与 `.builtin-version` 一致」，已由重跑 `pack` 达成
  （sentinel `1bfc9f95d92f9b54` → `85b24ce9b4ae3b77`，两处一致）。`markdown-exporter` 的
  description patch 已逐字节核对与提交的文件一致，下次真跑 fetch 不会还原。
- **fixture 的中文没有嵌入字形**（用 PyMuPDF 内置 `china-s`）：本机渲染正常，换台缺中文字体的机器
  可能就是豆腐块。这正是 pending 里的 P14，**因此本轮所有「中文不豆腐」的绿灯只对本机成立**。

### 第二刀：表单族 P5-P10（2026-08-01）

一批做的理由成立：六项共用一条记录，**AcroForm 填的和叠加填的产生同一种「已填字段」记录**
（名字/页码/两套坐标/文本/来源），`pdf_form_check.py` 因此不必关心是哪条路填的。
拆开做的话「值有没有超出框」要写两遍，而且只有一遍会被测到。

| 文件 | 能力 |
|---|---|
| `scripts/pdfform.py` | 字段模型（类型、两套坐标、选项、长度上限、Ff 标志解码、自然宽度） |
| `scripts/pdf_form_inspect.py` | **P5** 有没有 AcroForm · **P6** 逐字段详情 |
| `scripts/pdf_form_fill.py` | **P7** AcroForm 填充 · **P8** 无域时按锚点/坐标叠加 |
| `scripts/pdf_form_check.py` | **P9** 越界校验 · **P10** 逐字段标色的校验图 |
| `fixtures/` | 同一张表的三个版本（有域 / 无域 / 已填）+ 两个 values 输入文件 |

门禁：**L1 9/9 pass（9 proved by sample，L2 验证的产物 1 → 4）**；
`test-pdf-skill.py` 14 → **20 条断言 / 26 条负向控制**，flaw→check 矩阵每行仍是单一归属。
L2 的 **P3（填充值不越出字段框）第一次跑在真实 widget 上**。

#### 三个「先绿后被推翻」的点（全是矩阵和实测抓的）

1. **复选框被判越界**。勾选记号的 span 比自己的框高 0.71pt（字形 ascent），而勾是阅读器画的、
   根本没有「值太长」这回事 ⇒ 改为按类型区分：只有 text/combobox/listbox/overlay 可测，
   复选框记 `not_applicable` **并单独计数**。`checked` 只数真正量过的，
   「一个字段都没量成」不可能显示为 clean。
2. **上下容差不能对称**。实测：正确填充最多超出**上沿** 1.04pt（ascent，人人都会），
   超出**下沿**的只有真正装不下的多行值（+3.65pt）。原来上下都用 0.5pt ⇒ 正确的填充被判红。
   现在上沿给 `0.35×字号`、下沿给 `0.15×字号`，两个方向按各自的物理意义定。
3. **两条负向控制自己是错的，矩阵才看得出来**：
   - `proof-draws-every-box-green` 起初把绿框**画在**正确颜色的框上面，两种框同时存在，
     而 M6 只问「有没有某个框颜色对」⇒ 控制臂通过、缺陷没被发现。**控制臂错 + 断言太松，两个问题。**
     改成在空白表单上重画，并把 M6 改成「该位置的**每一个**框都必须颜色正确」。
   - `check-measures-width-only` 同时点亮了 M5/M6/V0 —— 因为 `proof_of` 与检查报告
     **是同一个 list 对象**，往报告里注入缺陷等于改写「校验图当初是照什么画的」。
     现实里不可能发生（校验图会照着同样的错判来画）。改为存独立副本。

#### 已知边界（写下来，不要以为验过了）

- **不做 radio 组的创建**：PyMuPDF 1.27 给已存在 radio 字段加第二个 widget 抛 `bad xref`。
  读第三方表单的 radio 正常，模型也认这个类型 —— 但**创建路径没有**，也不打算硬造。
- **L2 的 P3 只查水平方向**，看不见多行值从下沿溢出（本技能的 P9 能）。
  这是门禁比技能自检弱的一处，**记账在此**：将来若有别的技能产出表单，这个洞对它是敞开的。
- AcroForm 中文渲染正常（字形中心着墨 1.00 实测），但外观流是 PyMuPDF 生成的；
  **换一个自己重建外观的阅读器行为未验证**。
- P9 的样例跑在「值都放得下」的 fixture 上，只证明「量得动且报干净」；
  **检出能力由 `test-pdf-skill.py` 自己构造溢出用例来证**（故意做坏的 fixture 没法同时交给 L2 当好样例）。

### 第三刀：P13 生成 + P14 字体嵌入（2026-08-01）

#### 拍板前的实测推翻了「必须打包一份 OFL 字体」这个前提

用户指示是「打包 OFL 字体做 P13+P14」。动手前先测了一件事：**PyMuPDF 自带的 CJK 字体能不能
嵌进产物**。结论是能，于是不需要额外打包任何字体文件。

| 写法 | 产物里的字体 | 文件大小 |
|---|---|---|
| `insert_text(fontname="china-s")`（fixture 一直用的） | `ext='n/a'` —— **只写了个名字** | 1,218 B |
| `insert_font(fontbuffer=fitz.Font("china-s").buffer)` | `ext='ttf'` —— **真嵌入** | 3,569,129 B |
| 同上 + `doc.subset_fonts()` | `ext='ttf'`，带子集标记 `XXXXXX+` | **10,675 B** |

即：**嵌入 + 子集化后只有 10.7KB**，字体是 PyMuPDF 随包带的 Droid Sans Fallback
（**Apache-2.0**，而且是用户 pip 装的、本仓库连再分发都谈不上）。

**因此没有打包 OFL 字体**，理由三条：① 目标是「中文到别的机器不豆腐」，嵌入已经完全达成；
② 打包一份 CJK 字体要给技能树加 10~16MB（当前整个内置技能 zip 才 3.1MB）；
③ 许可问题直接消失。`--font 路径.ttf` 留着，想换任何 TTF/OTF（含 OFL 字体或品牌字体）一个参数的事。
**这是与指示的偏差，数据在此，要打包随时可以加。**

#### 落地

| 文件 | 内容 |
|---|---|
| `scripts/pdfwrite.py` | 字体嵌入、字形覆盖检查、中西混排断行、度量 |
| `scripts/pdf_create.py` | **P13** 按 spec 生成（heading/paragraph/bullets/table/spacer/pagebreak，自动分页）· **P14** 嵌入 + 子集化 + 覆盖报告 |
| `fixtures/document.json` | 生成用的 spec（覆盖全部块类型 + 显式分页） |

门禁：**L1 11/11 pass，L2 验证的产物 4 → 6**；`test-pdf-skill.py` 20 → **25 条断言 / 32 条负向控制**。
pending 只剩 **P3 / P11 / P12**。

#### 字形覆盖检查守的不是「豆腐」，是「整页消失」

字体没有的字**不报任何错**，所以覆盖检查放在写之前。为验证它守的是真东西，故意用只有西文的
Arial 强行写中文（`--allow-missing-glyphs`）再交给 L2：

```
P1 page 2 renders blank (ink 0.00000 < 0.0005)
P2 expected text not extractable: '季度经营分析报告'
P4 CJK does not extract back: '季度经营分析报告' (got '')
```

**不是变成豆腐块，是整页空白、文字连抽都抽不出来。** 这条实测同时成了 G5 的负向控制：
如果哪天强行写也能产出 L2 接受的文件，那这个拒绝就是在挡空气，应该删掉而不是留着当仪式。

#### 三个先绿后被推翻的点

1. **G3 在干净产物上就打红** —— 断言写的是「spec 里的字符串必须原样出现在产物里」，
   而排版会在中文串中间插换行、把西文词间空格换成换行 ⇒ **任何长到需要换行的段落都会被判缺失**。
   改成两边都去掉全部空白再比。**这是断言错了，不是产物错了**，但它先表现为一片红。
2. **`create-names-the-font-instead-of-embedding` 顺带点亮 V0** —— 因为我的负向控制造了个
   **1 页**的替身文档，而真产物是 2 页，V0 的「字体条目 ≥ 2」直接不满足。
   **控制臂比被替换的对象更小，就分不清检查到底对哪个差异起的反应**。改成同样 2 页。
3. `create-embeds-without-subsetting` 同时点亮 G1+G2 —— 这条是**真级联**（去掉子集标记正是
   未子集化字体的呈现方式，两条检查读的是同一个 basefont 串），已在矩阵里注明。

#### 已知边界

- 生成的是**结构化文档**（标题/正文/项目符号/表格），不是排版引擎：没有图片块、没有分栏、
  没有页眉页脚页码。要这些先扩 spec，别指望现有块类型凑。
- 覆盖检查基于 `Font.has_glyph`，查的是**字体有没有这个字形**；字形长得对不对不在检查范围。
- 字体来自用户机器上的 PyMuPDF。**换个 PyMuPDF 版本换了内置字体，产物字形会跟着变**（不影响
  嵌入这个性质）。

### 下一刀的建议顺序

1. **P3 表格抽取**（与 xlsx 的表模型一起定，S3）。
2. P11/P12 需要先扩 L2：多输入保真度、加密产物怎么验。
3. 三项清完即可跑 `--no-pending` 验收档，S2 才算真的收尾。

---

## 七、待拍板 / 未决

§4·补的决策表已销掉大部分。**剩余未决**：

1. ~~LibreOffice 依赖策略~~ ✅ **已拍板（2026-08-01）：LibreOffice 是 docx / xlsx 的必需依赖**

   **先厘清事实**：原以为有四项能力依赖 soffice，实测只有一项是真的。

   | 能力 | 纯 Python / Chrome 能否替代 | 结论 |
   |---|---|---|
   | W7 接受/拒绝修订 | 纯 OOXML XML 操作即可（jvs 即纯 Py） | 不需要 soffice |
   | W17 / X13 转 PDF | mammoth/openpyxl → HTML → Chrome `--print-to-pdf`，**已实测跑通**（77KB PDF，中文正确，过 L2 的非空白 + 非豆腐块断言）；`chrome-or-edge` 本就是 deckcraft 声明并被 Rust 探测的依赖 | 可替代，保真度较低 |
   | X4 公式重算 | openpyxl 不产生缓存值；纯 Py 求值器覆盖有限 | **唯一真依赖** |

   还有一条决定权重的事实：**xlsx / docx 在应用内根本不能预览**（`artifact-preview.tsx:147` 只给二进制信息卡），只有 PDF 能（pdf.js）⇒ **转 PDF 是产物在应用内可见的唯一通道**，不是锦上添花。

   **决定**：
   - **`soffice` 进 docx / xlsx 的 `x-requires` 硬依赖**。转 PDF 与公式重算统一走 LibreOffice，取其保真度（分页、页眉页脚、真实求值）。**不做 Chrome 双路径**——两条路径等于两套保真度行为，用户看到的预览会不确定；上面那次实测的价值是证明了备选可行，不是要同时留着。
   - **`pdf` 技能不需要 soffice**（PyMuPDF 全包）。
   - **另做一个纯 Python 轻量公式求值器**（常见算术 + SUM/AVERAGE/IF 等），不支持的函数显示公式原文并在输出里点名，绝不假装算出来了。它有两个用途：① soffice 调用失败/超时时的兜底；② **与 soffice 重算互为交叉验证**——两个独立引擎算同一个公式，不一致即报，比任何单一引擎都可靠。其覆盖边界**必须实测标定并写进门禁**，不能凭直觉声称"常见函数都支持"。
   - **不打包 LibreOffice**（~400MB，MPL-2.0 可分发但体积不可接受），由用户自装，走既有 `x-requires` + 设置页依赖检测。

   **已知代价（拍板时已知悉）**：未装 LibreOffice 的机器上，docx / xlsx 两个技能在设置页显示"未就绪"，且产物无法在应用内预览。

   **对门禁的直接影响（2026-08-01 已实施）**：L2 的 soffice 层语义**从「探测到才跑」翻转为「缺失即判红」**——契约既然是必装，缺失就是失败而非跳过。`xsd` 层同样列为必需（CI 提供）。开发机用 `--allow-missing soffice xsd` 显式放行，报告里点名，永远不会变成静默通过。L1 的 C4 同步支持同一开关（它内部调 L2）。两个 `--selftest` 验的是守卫逻辑而非机器契约，内部恒为宽松。

   **待办**：① CI 三平台装 LibreOffice（会显著拖慢，需评估缓存）② `BUILTIN_DEP_MAP` / Rust 探测加 `soffice`（可复用 L2 `find_soffice()` 的平台分支）③ 本机装 LibreOffice 才能真机验 D7/X3。
2. **`doc-edit` 是删是退化成路由页**（形态 B 下二选一）——删则要清理 `README.md` / `AGENTS.md` / 可能的 ADR 引用。**S4 收尾时决定，不阻塞。**
3. **`doc-export` 断链修复**（§1，实测 `doc-edit/SKILL.md` 的 `:3`/`:22`/`:53` 三处）——**放 S6**，与 deckcraft 的路由边界同批（两者都要等 docx/xlsx 齐了才谈得上指向谁）。改动本身 3 行，但 `skills/builtin/` 一动就要重算 `.builtin-version`；归批原则见 §6「每个技能阶段的收尾义务」第 3 条。

---

## 附：本次调查用到的验证手法（可复用）

- **判定技能是否同源，不能看目录名和文件名**，要逐文件 `cmp`。本次 `docx` 一栏，qoderwork「同名脚本重合度很高」看起来像抄，实测 44/60 逐字节相同——**确实是抄**；而 mulerun `pptx` 同样"同名"，实测 0/55 相同——**是自写**。同名 ≠ 同源，两个方向都会误判。
- frontmatter 里残留的 `license: Proprietary` 是比 LICENSE.txt 更可靠的血缘指纹（改写者常删 LICENSE 文件但忘了改 frontmatter）。
