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

### L3 — 真实语料回归 ✅ **已实现（2026-08-04，S5）**

> 教训来源：ADR-070 P2（LaTeX）——**手编用例 100% 通过，两个真缺陷全靠 279 个真实公式抓出来**。想象不出来的缺陷只能靠真实语料。

**落地 = `scripts/fetch-l3-corpus.py`（取语料）+ `scripts/test-office-l3-corpus.py`（跑环）**，
两条都进 CI（`office-skills-l3` job，三平台）。详细结果与教训见 **§六·补九（SSOT）**。
下面这三行是当时写的需求，保留原文以便对照实际拿到了什么 —— **实际语料在修订/批注/中文
这三格上是薄的，见 §六·补九的刻画表，别把「45 份 docx」读成「45 份带修订的中文 Word」。**

需要准备（**这一项需要你提供或授权我去找**）：
- 真实 `.docx`：含修订、批注、多级编号、页眉页脚、中文混排、复杂表格 —— 目标 ≥ 20 份
- 真实 `.xlsx`：含跨表公式、合并单元格、条件格式、大表（>10 万行）—— 目标 ≥ 15 份
- 真实 `.pdf`：含 AcroForm 表单、扫描件、中文、加密 —— 目标 ≥ 15 份

跑法：全语料过一遍 read→edit→validate 环，统计崩溃率/损坏率，与当前 `doc-edit` 基线对比。**这是"更优"最有说服力的证据**。

**实测结果（2026-08-04，231 份，两条臂，4 分 18 秒）**：xlsx **损坏率 新 0% vs 旧 66.7%**、
崩溃率 1.0% vs 4.0%；docx 两臂皆 0/0；pdf 无前身故无基线。**并且这一跑抓到三个真缺陷**
（两个 pdf、一个 xlsx），全部当刀修掉并配了控制臂。全文见 §六·补九。

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

### 5·补.8b — 许可与可行性调查结果（2026-08-02，实测 + 一手来源）

#### 结论先行

**许可上可以 vendored，且有强先例；但差点 vendored 错东西 —— 而那个错误不会报错，只会让
D2 对每一份真实文档判红。**

#### 一、许可（一手来源，非二手转述）

| 事实 | 来源 |
|---|---|
| ECMA-376 各 Part 可从 ECMA 免费下载，XSD 就在标准的 zip 里 | ecma-international.org 标准页 |
| **XSD 包里没有任何许可文件，26 个 schema 也都没有版权头** | 实测解包：非 `.xsd` 条目 = 0 |
| **ECMA-376 的 PDF 没有版权页** —— 第 2 页实测 ink=0.00000、0 张图，确实是空白 | 用 PyMuPDF 渲染实测 |
| ECMA 的通用文本版权政策**只适用于「带该声明」的文档**（2009 年起加入，未回溯补进旧标准） | ECMA text copyright policy FAQ |
| ⇒ 实际起作用的是 **ECMA 章程 §9.4**：*"All documents when approved shall be made available to all interested parties without restriction."* | ECMA by-laws 页，逐字核对 |
| **Apache POI 的 NOTICE 正是引用这条 §9.4 + 微软/Adobe 的专利声明**，作为它在 Apache-2.0 产品里分发「由 ECMA 提供的 XSD 生成的 XmlBeans」的依据 | poi-ooxml-full 5.2.5 NOTICE 全文 |

**判断（不是法律意见）**：ASF 法务审过的同型先例 + 章程明文「without restriction」，
把 XSD 随仓库分发是站得住的。**最终定性请你或法务确认** —— 我能给的是证据，不是结论。

#### 二、差点拿错的东西（比许可更容易出事）

**ECMA-376 Part 1 带的是 Strict schema，我们需要的是 Part 4 的 Transitional。**

| | targetNamespace |
|---|---|
| Part 1 `OfficeOpenXML-XMLSchema-Strict.zip`（21 个） | `purl.oclc.org/ooxml/...` |
| Part 4 `OfficeOpenXML-XMLSchema-Transitional.zip`（26 个） | `schemas.openxmlformats.org/...` |
| **本仓库的 `book.xlsx` / `sample.docx` 实测** | `schemas.openxmlformats.org/...` |

Part 1 是「那本标准」，取它是最自然的动作 —— 而**用 Strict 去校验真实文档，会在命名空间这一层
就全部判红**，看起来像「我们的产物不合规」。这与 S2 的旋转页、S3 的合并列宽同一形状：
**判红的不是被测对象。**

#### 三、ECMA 发的包对 docx 是坏的（实测）

`wml.xsd` 与 `shared-math.xsd` 里写着

```xml
<xsd:import namespace="http://www.w3.org/XML/1998/namespace"/>
```

**没有 `schemaLocation`，包里也没有 `xml.xsd`** ⇒ schema 连**加载**都失败：
`The QName value '{http://www.w3.org/XML/1998/namespace}space' does not resolve`。
补上 `schemaLocation="xml.xsd"` 并放入 W3C 的 `xml.xsd`（8,836 字节）后，
**`sample.docx` 的 `word/document.xml` 校验 `valid=True`**。

⚠️ 这引入**第二个许可问题**：W3C 的 `xml.xsd` 自身不带版权串，适用 W3C Software Notice
and License（BSD 型）。**同样未经法务确认**，但体量是一个 8KB 文件。

#### 四、xlsx 今天就能开 D2（无需等 S4）

实测**未打任何补丁**，直接用 Transitional 的 `sml.xsd`：

```
book.xlsx  xl/workbook.xml           valid=True
book.xlsx  xl/worksheets/sheet1.xml  valid=True
```

⇒ **D2 这条「从未跑过通过路径也从未跑过失败路径」的断言，可以先在 xlsx 上闭合**，
不必等 docx。这是本次调查最有价值的副产品。

#### 五、体量与放置方式

Transitional 包解开 **920 KB / 26 个文件**（压缩后约 105 KB）+ W3C `xml.xsd` 8.6 KB。
放 `scripts/schemas/ecma376/`（`find_xsd_dir()` 已经在找这个路径）完全可接受 ——
对比：整个内置技能 zip 3.2 MB。

**建议**：vendored 进仓库（附 `NOTICE` 写明来源、ECMA §9.4、POI 先例、以及为 `xml:space`
所做的 `schemaLocation` 修改），而不是「CI 下载」—— 下载会让 D2 在离线/断网时静默变成
SKIP，而 SKIP 与通过长得一模一样，这正是 X3 躺了一个月的机制。

#### 六、定案（用户 2026-08-02 告知「后续作为商业软件使用，需要去掉法务风险」）

**ECMA XSD：vendored 进仓库。** 用户 2026-08-02 判断该项无实质法务风险，我同意 ——
我先前把它估高了。支撑：章程 §9.4 明文 "without restriction" · **Oracle 在多个商业产品里
分发由这批 XSD 生成的 Apache POI `poi-ooxml-full`**（ASF 法务审过，十余年商业分发实践，
不是理论）· 微软 OSP + 微软/Adobe 向 ECMA 的专利声明 · ISO/IEC 29500 同一内容 ·
XSD 本质是形式文法，可版权表达极薄。

法务顾虑去掉后，**vendored 在工程上明显优于 fetch**：确定性、离线可构建、CI 零网络、
且不会出现「下载失败 ⇒ D2 静默变 SKIP」那个洞（SKIP 与通过长得一模一样，正是 X3 躺一个月
的机制）。放 `scripts/schemas/ecma376/`（`find_xsd_dir()` 已在找该路径），附 NOTICE 记明
来源、§9.4、POI 先例、以及为 `xml:space` 所做的 `schemaLocation` 修改。

### 5·补.8c — ⚠️ 商业化下真正的头号法务风险不是 XSD，是 PyMuPDF（2026-08-02）

**实测清点：13 个随产品分发的文件 `import fitz`** ——
整个 `pdf` 技能（11 个脚本 + fixtures 生成器）· `deckcraft/scripts/source_to_md/pdf_to_md.py` ·
`xlsx/scripts/xlsx_pdf.py`（**可选**，仅空白页检查与 `--png`）。
另有 3 个仓库内门禁脚本用它，那些不分发、不构成问题。

**PyMuPDF = AGPL-3.0 或商业授权**，权利人 Artifex —— 同时也是 Ghostscript 的权利人，
且有 *Artifex v. Hancom* 判例确立 GPL 可作为合同强制执行。

§4·补 的决策表里记着「**本产品不打包该库，由用户 `pip install` 自装，技能脚本仅
`import fitz`**」，并注明「用户已知悉并拍板」。⚠️ **那是在本项目尚未定位为商业软件的前提下
拍的。** AGPL 管的是「分发基于该程序的作品」；随商业产品分发一批**唯一用途就是驱动 fitz
的源码**，正是 Artifex 出售商业授权所针对的场景。**这块在法律上有争议 —— 而「有争议」恰恰
是「去掉法务风险」不接受的状态。**

各依赖的位置（`import` 型的才有传染性问题；外部进程调用没有）：

| 依赖 | 许可 | 用法 | 商业风险 |
|---|---|---|---|
| **PyMuPDF / fitz** | **AGPL-3.0 或商业** | **`import`** | **⚠️ 高，需处置** |
| LibreOffice | MPL-2.0 | **外部进程**调用，不打包 | 低 |
| openpyxl / python-docx | MIT | import | 无 |
| lxml | BSD-3 | import | 无 |
| pypdf / reportlab | BSD | import | 无 |
| ECMA-376 XSD | 见上 | 不再分发 | 已归零 |

**三条路**：① 向 Artifex 购买商业授权 ② 换成宽松许可的实现 ——
`pypdfium2`（**Apache-2.0 / BSD-3**，底层 PDFium 为 BSD 系）覆盖渲染 + 文本 + bbox，
`pypdf`（BSD-3）覆盖合并/拆分/旋转/加密/表单，`pdfminer.six`（MIT）、`reportlab`（BSD）
覆盖其余；代价是**重写 pdf 技能（S2 全部产出）+ deckcraft 的 `pdf_to_md.py`**
③ 砍掉 PDF 相关能力。

**可以立刻做的一小步**：`xlsx` 技能对 fitz 只是**可选**依赖（空白页检查 + `--png`），
换掉或去掉即可让 **S3 的产出今天就是 AGPL-free**。pdf 技能那一大块需要单独决定。

（以上是证据与工程判断，**不是法律意见**。）

#### 去 AGPL 的可行性实测（2026-08-02，用 pdf 技能自己的夹具跑，不是查文档）

| 能力 | 宽松许可替代 | 实测结果 |
|---|---|---|
| P1 渲染 | pypdfium2（Apache-2.0/BSD-3） | ✅ 220dpi → 1819×2573，页数正确 |
| P2 文字 + 逐字 bbox | pypdfium2 | ✅ 123 字符、首字框、中文正确 |
| P3 表格 | pdfplumber（MIT） | ✅ 有格线页 **4×3，与 fitz 一致**；无格线页返回 0 张（比 fitz 的 `text` 猜测**更保守**） |
| P4 元数据/旋转/加密态 | pypdf（BSD-3） | ✅ 含 `rotation=90` |
| P5/P6 表单探测与字段 | pypdf | ✅ 5 个字段、类型齐全 |
| P7 AcroForm 填充 | pypdf | ⚠️ **值写入正确，但外观流用 Helvetica 渲染中文会乱码**（pypdf 自己会警告）—— 需要给 AcroForm 的 `/DR` 装 CJK 字体，或置 `/NeedAppearances` 交给阅读器重建 |
| P11 合并/拆分/旋转 | pypdf | ✅ |
| P12 AES-256 | pypdf | ✅ 加解密往返正常 |
| P13 从零生成 | reportlab（BSD） | ✅ 西文开箱即用 |
| **P14 CJK 字体嵌入** | — | ❌ **没有免费的 CJK 字体来源了** |

**P14 是唯一的硬伤，而且它推翻 S2 的一个决定。** S2 明确「**不打包 OFL 字体**」，三条理由
之一是「嵌入已由 PyMuPDF 自带的 Droid Sans Fallback 达成」——实测那是一个 **3.4 MB 可嵌入
buffer**。去掉 PyMuPDF，这条理由随之消失：

- reportlab 的 CID 字体（STSong-Light 等）**不嵌入**，靠阅读器有字库 —— 那正是 P14 要避免的
- 已装的其他 pip 包都不带可嵌入 CJK 字体

**实测的中间路线：用系统 CJK 字体，嵌进产物。** 产物仍然可移植（消费端不需要字体），
只有**生成端**需要一份。macOS 实测：

| 候选 | 结果 |
|---|---|
| `Hiragino Sans GB.ttc` | ❌ **PostScript 轮廓,reportlab 嵌不了** |
| `Arial Unicode.ttf` | ✅ 产物 34 KB，`FontFile2` 在，文字可抽回 |
| `Songti.ttc`(subfontIndex=0) | ✅ 产物 **16 KB**（源字体 63.8 MB ⇒ 子集化正常） |

⇒ **可行，但必须按平台探测且要挑对候选**（macOS 上第一个能找到的偏偏是嵌不了的那个）。
Windows(`msyh.ttc`/`simsun.ttc`)与 Linux(Noto CJK)是 TrueType 轮廓，预期可行，
**本机无法验证，靠三平台 CI**。

**代价总结**：9 项能力可直接平移；P7 的中文外观流要补；**P14 从「零成本」变成
「生成端需要一份 CJK 字体」**——若 CI 显示某平台没有，退路是打包一份 OFL 字体
（约 10 MB，S2 当初算过这笔账）。

### 5·补.8d — D2 落地：从「两条路径都没跑过」到零跳过（2026-08-02）

schema vendored 到 `scripts/schemas/ecma376/`（27 个文件 984 KB，附 NOTICE 记明来源、
§9.4、POI 先例、两处上游缺陷补丁）。**L2 首次在不带任何 `--allow-missing` 的情况下
62 passed / 0 failed / 零跳过。**

#### D2 第一次真跑就抓到两类东西

**① 不是缺陷的：MCE。** 裸 XSD 校验真实 Office 文档会在 `mc:Ignorable` 和
`w14:docId` 上全线判红 —— 而 `mc:Ignorable` 的**存在意义**就是声明那些厂商扩展命名空间
可忽略。ECMA-376 **Part 3** 规定合规消费者**先做 MCE 预处理再校验**。
不做这一步，等于因为文档照标准行事而判它不合标准。已实现 `apply_mce()`
（解析 `mc:Ignorable` 的前缀→命名空间、剥掉这些命名空间的元素与属性、
`mc:AlternateContent` 取 `mc:Fallback`）。

**② 是缺陷的：`python-docx` 自带的 `default.docx` 模板不合规。**
它写 `<w:zoom w:val="bestFit"/>`，而 Transitional 的 `CT_Zoom` **要求** `w:percent`。
⇒ **python-docx 产出的每一份文档都带这条不合规。** 实测确认在模板里，不是我们的代码。
Word 能正常打开，所以它一直没人发现 —— 这正是 D2 该抓的那类东西。

处置：**修夹具，不是教检查别看** —— 正向控制必须是一份合规文档，所以 L2 的
`build_docx` 与 L1 的 docx stub 都补上 `w:percent`。**这条发现本身归 S4**：
docx 技能必须写这个属性（或不写 `w:zoom`），否则它产出的每个文件都带着它。

#### D2 的负向控制，其中一条是野外真实存在的缺陷

D2 此前**从没有负向控制** —— 一条没人看着它失败过的检查不构成证据。补两条：

| 控制 | 说明 |
|---|---|
| docx 缺必需属性 | **就是 python-docx 模板的那个 `w:zoom` 缺陷**，不是编造的破坏 |
| xlsx 多一个 schema 不允许的属性 | `<sheetData notAThing="1">` |

#### 覆盖面与 CI

D2 现在校验 `xl/workbook.xml` · `xl/styles.xml` · `xl/sharedStrings.xml` ·
`xl/worksheets/sheetN.xml` · `word/{document,styles,numbering,settings,footnotes,endnotes}.xml` ·
`word/header*|footer*.xml`；其余 part（theme/drawing/chart/rels/docProps）不在这套 schema
覆盖范围内，**且「一个 part 都没匹配上」会判红**，避免静默通过。
schema 编译结果缓存（`sml.xsd` 连带导入近 900 KB，逐次编译会主导自检耗时）。

CI 的 `ALLOW_MISSING_FLAG` 现在 ubuntu 为空、mac/Windows 仅 `--allow-missing soffice`；
**整个 flag 放进变量**是因为空的 `--allow-missing` 是 argparse 错误而非空操作。

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
| **S2** ✅ | `pdf` 技能重做 —— 四刀：P1/P2/P4（`071cd18c`）· 表单族 P5-P10（`513c9a84`）· 生成 P13 + 字体嵌入 P14（`69f7ac18`）· P3/P11/P12。**14/14 无 pending，`--no-pending` 验收档绿**。⚠️ **实现已在 S3.5 整体重写**（去 PyMuPDF/AGPL），能力表与标尺不变，见 §六·补三 | pdf/ 全套 + L0/L1/L2 全绿 | 已完成 2026-08-01 |
| S2 收尾 | ✅ Rust 依赖探测泛化（5·补.3）已完成：`run_python_feature_probe` 接受模块名列表，`PY_MODULES` 数据化 | 探测数据化 | 已完成 |
| **S3** ✅ | `xlsx` 技能（含 office 底座首次实现）。**五刀**：office 底座 + X1/X2/X15 · 公式族 X3/X5/X10 · 结构性写入 X6-X9 · 双引擎重算 X4 · 收官 X11-X14。**15/15 无 pending，`--no-pending` 全技能绿**（见 §六·补二） | xlsx/ + office 底座 | 已完成 2026-08-02 |
| **S3.5** ✅ | **去 PyMuPDF / 去 AGPL**（§5·补.8c 的路 ②）。`pdf` 技能 14 个文件 + `xlsx_pdf.py` 可选依赖（§六·补三）· `deckcraft/scripts/source_to_md/pdf_to_md.py`（§六·补四，新建读取层 `pdfsource.py` + **新建标尺 25 断言/28 控制**）。**`skills/builtin/` 下没有任何一个文件 `import fitz`**；`scripts/` 下三个门禁脚本仍用（不分发，单独一刀） | 商业分发无 AGPL 暴露 | 已完成 2026-08-02 |
| **S4** ✅ | `docx` 技能（最复杂：修订/批注/XSD/CJK）。**六刀落地 19/19，`pending` 清空**（见 §六·补五、补六、补七）。纯 lxml，**刻意不依赖 python-docx**。判据 = CI 的 `--no-pending pdf xlsx docx` | docx/ | 已完成 |
| **S5** | L3 真实语料回归（**已完成 2026-08-04**，见 §六·补九）+ L4 人工验收（**未做**，只能用户判） | `fetch-l3-corpus.py` + `test-office-l3-corpus.py` + CI `office-skills-l3` job；**231 份语料抓到 3 个真缺陷** | L3 ✅ / L4 待用户 |
| **S6** ✅ | 收尾：路由收敛（markdown-exporter 的 DOCX 路由 → `docx` · `doc-edit` 瘦身改名 **`pptx-edit`** · `doc-export` 断链 · deckcraft 路由边界）+ **断链扫描进 CI**（check-docs §11 + `--selftest` 10 条控制）+ README / AGENTS / gotchas / conventions / ADR / CHANGELOG / `.builtin-version`（见 §六·补八） | 文档同步 | 已完成 2026-08-04 |

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

### 第四刀：P3 / P11 / P12 —— pdf 技能欠账清零（2026-08-01）

**`--no-pending` 验收档首次转绿**：14 项能力全部实现、0 pending、14/14 proved by sample、
**9 个产物经 L2 验证**。

| 文件 | 能力 |
|---|---|
| `scripts/pdf_tables.py` | **P3** 表格抽取（JSON + CSV + 画框副本） |
| `scripts/pdf_pages.py` | **P11** 合并 / 拆分 / 抽页 / 删页 / 旋转 |
| `scripts/pdf_encrypt.py` | **P12** AES-256 设/改/去口令 + 权限位 |
| `fixtures/table-grid.pdf` | 同一张表两页：**有格线 / 无格线** |

#### 先还清了 pending 里记的两笔门禁欠账

两条欠账当初就是这么写的，现在按原样兑现（不是绕过）：

1. **L2 的 `baseline` 现在接受列表**（P11 需要）。合并有多个输入，而丢掉第二个输入产出的
   是一个**完全合法**的 PDF —— 页数、文字抽取、栅格全都满意。P5 改为按顺序走每个输入的页。
   配了三条控制：保序合并静默 / 丢输入判红 / **页全在但顺序反了也判红**（页数看不出来）。
2. **L2 现在能读加密产物**（P12 需要）。此前给它一个加密 PDF 会从第一次访问页面抛
   **未捕获的 `ValueError`** —— **门禁崩溃比门禁报错更糟，它什么都不报**。
   现在 `expect` 里给 `password` 就解密后照常跑全部断言；不给就报 `A0`（前置失败的统一 id），
   而不是崩。两条控制：给对口令全部断言正常跑 / 不给口令报错且不崩。

L2 自检 48 → **53 passed**。

#### 顺带修的两个真缺陷

- **`find_tables` 把广告打在 stdout 上**（"Consider using the pymupdf_layout package…"），
  正好插在脚本的 JSON 前面 ⇒ `pdf_tables.py | jq` 直接坏掉。没有开关可关
  （`mupdf_display_errors/warnings` 管的是另一条通道），只能围住调用把它转到 stderr。
  顺手把**十个脚本的 stdout 逐一过了一遍 JSON 解析**，全部干净。
- **L1 的占位符不进列表**。`{fixtures}` 只在字符串值上替换，而 `baseline` 现在是列表 ⇒
  报出来是 `baseline not found: {fixtures}/…`，读着像文件缺失，其实是替换没发生。改成递归替换。

#### 表格：读出来的 vs 猜出来的

同一张表、同样的数据，画格线与不画格线的两页：

| 页 | 策略 | reliable | 结果 |
|---|---|---|---|
| 1（有格线） | `lines` | ✅ | **4×3，完全正确** |
| 2（无格线） | `text` | ❌ | **7×3**，中间插了三行空行 |

**光看单元格内容分不出哪个是猜的** —— 所以每张表都带 `strategy` 与 `reliable`，
汇总里单独数 `unreliable_count`。原先的 `report-cjk.pdf`（只有横线）也在此列：
`lines` 一张都找不到，`text` 把上方标题一起吞进去凑成 7×3。

#### 加密：owner 口令等于 user 口令时，权限位形同虚设

**这是本轮抓到的最实的一个缺陷**，而且是我自己先写错的：`--owner-password` 默认取 user
口令，于是**能打开文件的人就是 owner，而 owner 不受任何限制**。实测同一个文件：

```
以 user 身份打开 : permissions=-3884  print=True copy=True modify=False annotate=False
以 owner 身份打开: permissions=-4     全部 True
```

第一版报告里 `--allow print,copy` 却打印 `permissions=-4`（全部允许）——**限制根本没生效**。
现在：`--allow` 有限制而 owner 口令没给或与 user 相同 ⇒ **直接拒绝**；
写完重新打开、**以 user 身份**核对权限位是否真的落地（以 owner 身份核对会看到全部允许，
等于确认一个不存在的限制）。

#### 断言与负向控制

`test-pdf-skill.py` 25 → **36 条断言 / 48 条负向控制，49 passed**。新增
T1-T3（表格）· N1-N4（页面操作）· K1-K4（加密）。矩阵里唯一的多点亮是
`split-loses-a-page → N4 + V0`，已注明是诚实级联（只剩一个分片时，覆盖检查确实没东西可查）。

#### 已知边界

- **表格检测的 `text` 策略是启发式**，本技能不改进它，只**标注**它。要可靠就得有格线。
- **权限位是约定不是强制**：阅读器选择遵守它们。脚本设置它们，不假装那是保护。
- 旋转存 `/Rotate`，**不重写内容**；这也意味着它对「把页面真正转正」这类需求不适用。

### S2 收工前的复审（2026-08-01）—— 抓到 5 个缺陷

四刀跑完后按「跨平台 / 打包安装 / 单 agent 与 Team / 通用性与副作用」四个角度重查了一遍。
**结论不是「都没问题」，是抓到 5 个真缺陷**，其中两个只在别人的机器上才会犯。

| # | 缺陷 | 影响 | 怎么发现的 |
|---|---|---|---|
| 1 | `test-pdf-skill.py` 硬编码 `/System/Library/Fonts/…/Arial.ttf`，且把 SKIPPED 写进了 findings | **非 macOS 机器上整个测试套件红**（"必须静默"那条直接失败并波及全部行） | 把该路径改成不存在的值模拟 Linux/Windows，实测 EXIT=1 |
| 2 | `SKILL.md` 让用户跑 `scripts/test-pdf-skill.py`，而它**不随技能分发** | 用户装完照着做必然扑空 —— 与 §1 记的 `doc-export` 断链**同一类** | 逐条比对 SKILL.md 引用 vs 发布树 |
| 3 | `pdf_info.py` 在 300 页文档上往 **stdout 打 82KB**（split 打 18KB） | 直接进 agent 上下文；Team 模式下还要再跨一次委派边界 | 造 300 页文档实测各脚本 stdout 字节数 |
| 4 | `--in` 与 `--out` 同一个文件时抛**裸 traceback** | 违反本技能"退出码 2 + 一行人话"的契约，agent 拿到一堵 Python | 就地覆盖实测 |
| 5 | `find_tables` 把广告打在 **stdout** 上 | `pdf_tables.py \| jq` 直接坏掉 | 分离 stdout/stderr 精确测量 |

修法与新增守卫：

- **①** 改用 PyMuPDF 自带的 `helv`（到处都有、有真字节、无 CJK 字形），顺带让 `--font` 接受内置
  字体名 —— **纯西文文档因此只嵌 33KB 而不是 3.5MB**。skip 改走独立通道，报告里单列且不计入 passed。
- **②** 改措辞并**加了永久守卫**：`check-docs.ts` 新增第 10 条 —— 所有内置技能 SKILL.md 里
  形如技能内相对路径的引用必须真的在发布树里（连接器运行时 materialize 的目录显式豁免）。带负向控制。
- **③** `pdfcommon.compact()`：列表超过 20 条时 stdout 只留计数 + 指向 `--out` 的指针。
  **82KB → 808 字节**，小文档仍给全量，完整数据仍在文件里。
- **④** `ensure_distinct()` 覆盖全部六个写出口，并给 `run()` 加了兜底：任何意外异常也先给一行人话。
- **⑤** 围住 `find_tables` 把它的输出转到 stderr。

新增断言 **O1（stdout 预算）/ O2（就地覆盖契约）**，`test-pdf-skill.py` 36 → **38 条断言 /
53 passed**。

#### 最重要的一条：把门禁接进了 CI

复审前 **S1/S2 的门禁一条都没进 CI**，全部只在一台 macOS 上跑过 —— 缺陷 ① 正是这么来的。
新增 `office-skills` job（**macOS / Windows / Ubuntu 三平台**）跑：L2 自检 · L1 自检 ·
**L1 验收档 `--no-pending`** · pdf 行为测试。L0 不进（依赖仓库外语料，缺失时 exit 2 = skip）。

> 在此之前，「跨平台兼容」这句话在本项目里对这批代码**没有任何机器证据**，只有人工审计。

#### 复审确认没问题的部分（附证据）

- **技能脚本零硬编码**：无绝对路径 / 无 `HOME` / 无 `/tmp` / 无 unix-only 命令 / 全部走 `pathlib`；
  **除 `fitz` 外不 import 任何东西，完全不外调进程**。
- **安装后可用**：把技能树整体拷到**带空格的**陌生路径、从无关 cwd 运行，十个脚本全部正常
  （模块互相 import 靠 `Path(__file__).resolve().parent`）。
- **单 agent 与 Team 都可用**：脚本**没有任何交互式输入**（无 `input()`/`getpass`/读 stdin），
  也就不碰 gotchas §10⑪ 那个「Team 委派不中继 question 会阻塞到超时」的坑；
  失败一律退出码 + stderr 一行。缺陷 ③ 修掉后，Team 下的输出规模也可控了。
- **Windows 文件名合法**：拆分产物只有 `pages-001-002.pdf` 这种形态，无 `: \ * ? " < > |`
  （pack 脚本本身也会拒绝含 `:` / `\` 的文件名）。
- **句柄不泄漏**：L2 的 pdf 系断言全部 `with` 保护 —— 这条要紧，因为我新加的解密路径会把
  产物解到临时目录，**Windows 上留着打开的句柄会让临时目录清理直接抛异常**。

#### 已知副作用（有意接受）

- `.builtin-version` 变了 ⇒ **所有存量桌面端下次启动会重装内置技能**（机制如此）。
- pdf 的依赖从 `pdftoppm` 换成 `pymupdf` ⇒ **只装了 Poppler 的用户会看到「未就绪」**，
  需要 `pip install pymupdf`。这是真实需求，不是回退。
- L1 的 `render()` 改成递归替换后，`contains` 里若真出现 `{out}` / `{fixtures}` 字面量也会被替换。
  实际内容里不会有，但这是一处行为变化，记在此。

### 装上 LibreOffice 后的第一次真跑（2026-08-01）—— 抓到一个躺了一个月的错

`brew install --cask libreoffice` 之后，**D7 / X3 的成功路径第一次真正执行**（此前只跑过
失败路径，见 §5 L2「分层与跳过 ≠ 通过」）。结果：

```
FAIL  [must stay silent] xlsx clean artifact stays silent
      X3 recalculated D4 = '100', expected 300
```

**LibreOffice 算对了，是 fixture 自己的期望值写错了。** 独立复算：
`B4 = B2-B3 = 400`、`C4 = C2-C3 = 500` ⇒ 文件里写的 `D4 = C4-B4` 就是 **100**；
而 `300` 是 `D2+D3` 的值 —— 一个和文件里的公式无关的算法。

**这个错从 S1 一直躺到今天，因为唯一能证伪它的机器上没装 LibreOffice** ⇒ 该断言一直是
SKIPPED，而**跳过在扫一眼时和通过长得一模一样**。这份脚本自己打印的那句
「Skipped is not green」，原来是字面意思。

顺带补上 X3 缺的那半边控制：此前 X3 唯一的负向控制是「soffice 坏掉要报错」——
它**完全不能说明 X3 能不能看出一个错的数**。新增 `recalc-drift`：改 `B4` 的公式
（它喂给 `D4`，但不在 `expect["sheets"]` 里）⇒ 所有存下来的公式仍然读得对，只有重算的
数变了，**只有 X3 能看见**。L2 自检 53 → **54 passed，跳过 3 → 1**（只剩 D2/xsd）。

> CI 的 `office-skills` job 仍带 `--allow-missing soffice xsd`：三平台装 LibreOffice 会
> 显著拖慢，§7 待办①标着「需评估缓存」，本轮不擅自决定。**本机从此应当用
> `--allow-missing xsd`（不再放行 soffice）**。

### 下一刀

pdf 技能已清零，**S2 完成**。接下来是 §6 的 **S3（xlsx）**，其前置在 §7：
① 本机装 LibreOffice 才能闭合 D7/X3 的成功路径 ② ECMA-376 XSD 要在 S4 前搞到。

---

## 六·补二 — S3 第一刀（薄切片）落地记录（2026-08-02）

沿用 S2 的做法：**先打通端到端管线**，不是一次铺完 15 项。本刀选 **X1（读）/ X2（写）/
X15（中文列宽）** 加 **office 底座首次实现**，选择理由只有一条 ——
**保真度是全部 15 项共用的地基**，它错了后面每一项都建在流沙上。

### 落地内容

`skills/builtin/xlsx/`（新建）：

| 文件 | 作用 |
|---|---|
| `scripts/office/package.py` | 包=parts+content types+relationships；**graft**（把库丢掉的 part 连同 CT 与 rel 一起放回）；`drop` 是它的镜像（删 part 也要删这三样） |
| `scripts/office/sheet.py` | **外科式编辑**：直接改 `sheetN.xml`，其余字节不动 |
| `scripts/office/soffice.py` | 三平台探测 + 转换（`-env:UserInstallation` 隔离 profile） |
| `scripts/office/validate.py` | 包一致性（part 可解析 / 关系指得到 / 元素序） |
| `scripts/office/xmlorder.py` | ECMA-376 CT_Worksheet / CT_Workbook 子元素序 |
| `scripts/xlsxcommon.py` | 错误契约（退出码 2 + 一行人话）/ stdout 预算 / 显示宽度 |
| `scripts/xlsx_read.py` | **X1** 读，**同时给公式与缓存值两个视图** |
| `scripts/xlsx_write.py` | **X2** 写单元格/公式/追加行 · **X15** `--autofit` |
| `fixtures/` | `book.xlsx`（双表 + 跨表公式 + 图表 + 条件格式 + 冻结 + 筛选 + 合并 + **customXml**）· `narrow.xlsx`（同内容剥掉全部列宽）· `make_fixtures.py` |
| `capabilities.json` | 3 项 implemented + **12 项 pending 逐条写理由** |

连带：`BUILTIN_DEP_MAP` + Rust `PY_MODULES` 加 openpyxl/lxml（**soffice 是第一个真正声明它的
技能** —— 它此前一直被 `SKILL_DEP_BINS` 探测却无人要求）、`markdown-exporter` 的 XLSX 路由
指向新技能（DOCX 仍写「建设中」，因为 `docx` 还不存在 —— 指向不存在的技能就是 §1 那个
`doc-export` 断链）、CI 加 xlsx 行为测试。

### 门禁结果（全部本机实测）

| 门禁 | 结果 |
|---|---|
| **L0** clean-room | `xlsx` clean（0 violation / 0 review） |
| **L0 重标定** | 见下「地板没有涨」 |
| **L1** 能力矩阵 | OK。`17/17 pass（17 proved by sample，11 artifact(s) verified by L2）`，12 项 pending 逐条列出 |
| **L1 `--selftest`** | 13 → **16 passed** |
| **L2** 产物合法性 | 54 → **60 passed / 0 failed / 1 skipped**（只剩 D2/xsd） |
| **xlsx 行为测试** | `scripts/test-xlsx-skill.py`：**18 条断言 / 25 条负向控制，26 passed**，flaw→check 矩阵只剩两条注明的诚实级联 |
| typecheck / desktop / Rust | 8 task · **858** · 155，全绿 |

### 核心主张是量出来的，不是声称的

「编辑不丢东西」这句话必须有对照数字，否则它只是一句形容词。同一次编辑、同一个文件：

| 写法 | 产物 part 数 | 逐字节未变的 part | LibreOffice 重算 |
|---|---|---|---|
| `openpyxl load → save`（**所有人第一反应的写法**） | 14（丢 3 个 customXml） | 10 / 17 | 一致 |
| **外科式（本技能）** | **17（一个没丢）** | **16 / 17** | 一致 |

两条都跑通了 LibreOffice 重算并得到相同的数 ⇒ **保真度不是拿正确性换来的**。
`W1` 里还有一条反向守卫：**如果哪天 `load→save` 也不丢东西了，这条断言会主动报「这个夹具
证明不了差别」** —— 免得守卫在一个不存在的问题上继续站岗。

### 本轮抓到的四个真缺陷（两个在门禁自己身上）

1. **L2 的 X5 在跨列合并标题上假阳性。** 合并到 A1:F1 的标题是**显示在六列上的**，
   要求 A 列独自装下它，会把一份渲染完全正常的 workbook 判红 —— 转成 PDF 读回**全部 20 个字
   都在**。是**我给技能写 autofit 时与门禁意见不合**才暴露的。
   修法=跳过**横跨多列**的合并单元格，并配一对用例（跨列必须静默 / **同列内的纵向合并必须
   照样打红**）。跑了控制臂：把修复回退 ⇒ 前者立刻 FAIL 而后者仍 PASS，
   证明修复不是靠把检查变瞎换来的。**这是「门禁自己有缺陷」在本任务里的第二次**（第一次是
   S2 的旋转页豆腐块）。
2. **L2 没有办法说「这份表不是财务模型」。** X4 是 opt-in，但 `inert_reason` 用真值判断 ⇒
   `finance_colors: false` 与「根本没写」无法区分，都算 INERT，而 L1 把非保真度的 INERT 判红
   ⇒ **一份普通表格永远无法成为「验过的产物」，唯一出路是谎称它是财务模型** ——
   默认打开的问题从另一扇门绕回来了。修法=`false` 是答案而不是缺席，
   配四条用例，其中**第三条是控制臂**：同一份文件 `finance_colors: true` 必须打红，
   否则「opt-out 让它闭嘴」和「它本来就没牙」分不出来。
3. **删 part 只删了字节。** `calcChain` 被丢掉后，它的 relationship 和 content-type Override
   还在 ⇒ 产出一个指向空气的包。**是我自己写的 validate 层咬出来的**（技能内部的分层）。
   修法=`Package.drop` 与 `graft` 对称，都是三件事。
4. **夹具不是逐字节可复现的。** openpyxl 除了 zip 条目时间戳，还会把保存时刻盖进
   `docProps/core.xml` 的 `dcterms:modified`，**覆盖掉你设的 `wb.properties.modified`** ⇒
   重跑一次 `make_fixtures.py` 就换 `.builtin-version`，全体桌面端重装。
   **是跑两遍 diff 出来的，不是想出来的。**

### 负向控制自己错了两次（矩阵才看得出来）

- **合并探针的两个标签一样长** ⇒「算合并标题」和「不算」得出同一个宽度，
  `width-counts-a-title-merged-across-columns` 这条控制**根本点不亮**。
  改成三个不同长度（42 / 18 / 6），三种实现各落在一个数上。
  **控制臂分不出两种实现，就不是控制臂。**
- **四条控制同时点亮了别人的断言**：`append-overwrites-the-last-row` 顺带点 W3（因为 W3 也在
  看 A6）· `trimming-drops-the-data` 顺带点 V0（因为 V0 在数脚本行为而不是夹具形状）·
  `read-returns-values-only` 与 `inventory-forgets-a-sheet` 点 V0（**这两条是真级联，已注明**）。
  前两条是**断言归属划错了**，改断言；后两条是真的，写进矩阵注释。
  另外原来的 V0 控制臂与 `inventory-forgets-a-sheet` **是同一个破坏**，等于没测 V0，换成只有
  V0 会注意到的那种。

### L0 重标定：地板**没有**涨（与预测相反）

S2 的曲线是 0.165 → 0.168 → 0.188，写着「docx/xlsx 落地后再涨就该重新论证阈值」。实测：

| 负样本 | max | 最高分文件 |
|---|---|---|
| + pdf 表单族（31 个 .py） | 0.188 | `pdf_form_inspect.py` |
| **+ xlsx（45 个 .py）** | **0.187** | 仍是 `pdf_form_inspect.py` |

**xlsx 自己最高只有 0.128**（`xlsx_write.py` ← `fix_deck.py`，一个毫不相干的文件）。
原因是结构性的，不是「我写得更干净」：**参考实现全都在驱动 openpyxl 的对象模型，而这份实现
直接改 zip 与 sheet XML**，AST 骨架天生对不上。
⚠️ **这不等于阈值安全了** —— 真正的考验是 `docx`，它会像参考实现一样用 python-docx。
分离带 0.187 ~ 0.736，阈值 0.55 仍居中。

### 明确没做 / 与原计划的偏差（都是有意的）

- **15 项只做了 3 项**，12 项进 pending 并逐条写了理由。**pending 写的不是「快好了」，
  是「还没有断言在证明它」。**
- **X4（公式求值）整项未动**，因此 §7 要求的「纯 Python 求值器 × soffice 交叉验证」
  **一行没写**，其覆盖边界当然也没标定。它是 pending 里最大的一块。
- **X13（转 PDF）没有能力入口**，尽管 `office/soffice.py` 已经写好并被门禁在用 ——
  **写好了不等于声明了**，没有 sample 和断言就不进 `capabilities`。
- **openpyxl 重建 + graft 这条路径没有能力挂上去。** `graft_missing_parts` 有实现、有
  round-trip 实测，但本刀所有写入都走外科式 ⇒ **graft 在产品路径上一次都没被执行过**，
  只在实验里验过。X6-X9 落地时才会真正启用它。这是本刀最大的一块「写了但没验」。
- **文本按 inline string 写**，不复用 `sharedStrings`。合法、通用，但大批量重复词会比 Excel
  自己写的大一些。
- **`--autofit` 是字符计数，不是字体度量**：默认字体下够用，换很宽/很窄的字体会偏。
- **§3.3 的「当前」列不动**：它是「更优」这个说法的对照系，跟着实现改等于把对照系抹掉。
- **没有重跑 `fetch-builtin-skills.ts`**（同 S2 理由：三个源都 pin 在 `main`）。
  `.builtin-version` 用**独立复算 fetch 的 walk 算法**核对后手写为 `fa387f174e41b0eb`，
  与 `pack` 的输出一致。`markdown-exporter` 的 description patch 已与提交文件逐字节比对。

### 顺带把两个 CI 定时炸弹拆了（都不是本刀引入的，但本刀让它们必然爆）

1. **上一个 commit `acff11d7` 让 office-skills job 必红，而分支没 push 所以没人看见。**
   它加的 `recalc-drift` 是一条**需要 LibreOffice 才能点亮**的负向控制，而
   `selftest()` 内部恒用 `allow_missing=ALL_TIERS` ⇒ 在没有 LO 的 runner 上该条被跳过 ⇒
   「必须打红」的用例没打红 ⇒ **FAIL**。本机把 `SOFFICE` 置空复现：
   `59 passed, 1 failed`。**这正是「跳过 ≠ 通过」的第二种形态** —— 上次是跳过冒充通过，
   这次是跳过让一条控制失效。处置见 §7 待办①，**未擅自决定**。
2. **`--no-pending` 是全局的**，xlsx 一进 pending 这条验收档就红，而 §6 的计划本来就是
   一次做一个技能 ⇒ **一个按设计长红的 job 等于没有 job**。改成可按技能限定
   （`--no-pending pdf`），裸用仍是「全部技能」。加了三条用例，
   **第三条是控制臂**（某技能清零后该档必须转绿），另有一条守住
   「限定到一个没有 manifest 的技能=什么也没断言」。

### 第二刀：X3 / X5 / X10 —— 公式族（2026-08-02）

一批做的理由成立：**同一个引用解析器同时服务两个方向** —— 写的时候拦住会变成 `#REF!` 的
公式，审计的时候找出已经是 `#REF!` 的。拆开做会写两遍引用解析，而且只有一遍会被测到
（与 S2 表单族「同一条填充记录」的理由同构）。

| 文件 | 能力 |
|---|---|
| `scripts/office/formula.py` | 引用解析（含带空格/CJK 的引号表名）· 依赖图 · 循环检测（**迭代式，不递归**：真实 workbook 的长依赖链会爆栈，而「审计器崩了」比它能报的任何结论都糟） |
| `scripts/xlsx_audit.py` | **X5** 四类发现：`error` / `missing` / `circular` / `uncalc` |
| `scripts/xlsx_write.py`（扩展） | **X3** 写公式 · **X10** 跨表引用，**写之前先验目标表存在** |

**它是引用解析器，不是求值器** —— 只回答「这条公式指向什么」，不算任何数。
守这条边界是有意的：一旦开始求值，每个算错的地方都会变成一个自信的错数。求值是 X4，
仍在 pending，且按 §7 必须做成「纯 Python 求值器 × soffice 交叉验证」。

#### 四类发现里，两类是别处没有的

- **`missing`（引用了不存在的表）= 还没发生的 `#REF!`**。openpyxl 一声不吭地把
  `=预算表!A1` 存下来，等 Excel 打开才炸，那时早没人记得是哪一步写的。所以这条同时做成了
  **写入期拒绝**（Q1）：拦在源头比事后审计有用。
- **`circular`**：Excel 显示 0、只在状态栏提示一句，基本没人看见。实测两种形状都要能抓：
  两格互引（D1↔E1）**和一格自引（`=F1`）** —— 后者是「不重访起点」的图遍历会漏掉的那种。

#### 门禁结果

| 门禁 | 结果 |
|---|---|
| **L1** | **20/20 pass（20 proved by sample，13 artifact(s) verified by L2）**，pending 12 → **9** |
| **L2** | 60 passed / 1 skipped（不变） |
| **xlsx 行为测试** | 18 → **27 条断言 / 37 条负向控制，38 passed** |
| **L0** | xlsx clean；**加入 formula.py 后地板仍是 0.187**，xlsx 自己 max 0.134 |

X3/X10 的证明落在 **L2 的 X3（LibreOffice 重算）**上，这是本刀最实的一条：
X3 样例 `B7==B3*2` 重算得 **2480**；X10 样例 `C7==汇总!B2` 重算得 **471** ——
471 只可能来自 `利润表!C7 → 汇总!B2 → 利润表!B5 → B3-B4` 这条链走通，
也就是**跨表引用在两个方向上都真的解析了**，而不只是把字符串存进去了。

#### 引用解析器踩到的两个假阳性（都实测，不是设想）

1. **字符串字面量里的引用不是引用**。`="见 预算表!A1 的说明"` 会被报成「指向不存在的表」。
   解法=解析前先剥掉字符串字面量与错误 token（后者自带 `!`，`=#REF!*2` 否则读作「表名 #REF」）。
2. **`LOG10(` 会被解析成单元格 `LOG10`**（1-3 个字母 + 数字，形状完全一致）。
   它会进依赖图；**在一个恰好用了 LOG10 这格的 workbook 里可以凭空造出一个循环引用**。
   解法=紧跟 `(` 的匹配是函数不是引用。**这两条都写成了断言（A6），不是注释。**

#### 又一次「V0 抢了别人的活」

给 V0 加的新项写成「broken workbook 里有 ≥3 类缺陷」，结果 `audit-only-scans-for-existing-tokens`
和 `audit-does-not-look-for-cycles` 两条控制**顺带点亮 V0** —— 因为那个数是**从 findings 算的**，
而 findings 正是 A2/A3 在管的东西。改成数**输入里的公式条数**（夹具属性，任何检测缺陷都不改变它）。
**这是同一轮里第二次犯**（第一次是 `file_cells`）：**V0 只能量夹具，不能量被测行为。**

### 第三刀：X6 / X7 / X8 / X9 —— graft 第一次进产品路径（2026-08-02）

四项一批，因为它们**共用同一条写入路径**：创建条件格式 / 图表 / 边框意味着把
styles.xml、sheet、drawing 和 rels 图一致地写出来，手写就是进 Excel 的修复对话框。
所以这条路**接受 openpyxl 重建，然后修补它造成的损伤**（`scripts/office/rebuild.py`）：

    load → 对象模型改 → save → graft 回丢掉的 part → 校验

| 文件 | 能力 |
|---|---|
| `scripts/office/rebuild.py` | 重建+graft+校验的统一出口；`.xlsm` 自动 `keep_vba` |
| `scripts/xlsx_format.py` | **X6** 数字格式/字体/填充/边框 · **X7** 条件格式（4 种规则）· **X9** 冻结/筛选 |
| `scripts/xlsx_chart.py` | **X8** 柱/条/折线/饼/散点/面积 |
| `fixtures/rules.json` | 条件格式 spec（三种规则各一条） |

**这是本任务里第一次真正执行 graft**（前两刀它只在实验里验过，S3 第一刀的「已知边界」
就是这么记的）。实测在真实夹具上：openpyxl 每次 save 丢 3 个 customXml part，
graft 后 **0 丢、包校验干净、openpyxl 能重开**，而图表/条件格式/冻结/筛选/数据验证
全部原样存活。

#### 两条写入路径的分工，是量出来的不是拍的

| | 路径 | 保真度 |
|---|---|---|
| 写值 / 写公式 / 追加行 / 设列宽 | 外科式（`sheet.py`） | 一个 part 不丢，**16/17 逐字节未变** |
| 创建格式 / 条件格式 / 图表 / 冻结筛选 | 重建 + graft（`rebuild.py`） | 一个 part 不丢，但**被重建的 part 逐字节全变** |

**graft 是 part 级的，修不了「存活 part 内部」的丢失**（如 sheet1.xml 里的
`<ignoredErrors>`）。这条边界写进了 `rebuild.py` 的 docstring，且报告**永远**带
`still_missing` 字段 —— 一个只在有损失时才提损失的报告，和没人写的报告分不出来。

#### 门禁结果

| 门禁 | 结果 |
|---|---|
| **L1** | **24/24 pass（24 proved by sample，17 artifact(s) verified by L2）**，pending 9 → **5** |
| **L2** | 60 passed / 1 skipped（不变） |
| **xlsx 行为测试** | 27 → **34 条断言 / 48 条负向控制，49 passed** |
| **L0** | xlsx clean，地板仍 0.187 |

新增 **G2 故障注入**：把 graft 换成「什么都不复原」，`rebuild()` 必须**拒绝并且不写文件**。
形状与 L2 的 broken-soffice 用例同构 —— **一条没人看着它失败过的修复路径，
不构成「它真的在修」的证据**。

#### 「控制臂分不出两种实现」第三次出现

`font-assigned-wholesale-resets-size-and-face` 这条控制**点不亮**：它模拟的缺陷是
「`cell.font = Font(color=...)` 把字号和字体重置成默认」，而夹具的 B3 用的**就是**
默认 Calibri 11 ⇒ 重置前后一模一样。修法=给夹具的数字单元格显式设 **宋体 12**，
并加一条 **V0** 守住这个夹具属性（`B3` 的字体不能是 openpyxl 默认值），
免得将来有人「顺手统一一下字体」把这条控制悄悄变回空转。

> 本轮同一个教训第三次：S3 第一刀是合并探针两个标签一样长，第二刀是 V0 去量被测行为，
> 这次是夹具属性恰好等于缺陷的目标值。**三次的共同形状：控制臂与被测实现在某个维度上
> 恰好重合，于是它无法把两种实现分开，而报告显示 PASS。**

### 第四刀：X4 —— 双引擎公式重算（2026-08-02）

§7 的三条硬要求全部兑现：纯 Python 求值器与 soffice **互为交叉验证** · 不支持的构造
**显示公式原文并点名** · **覆盖边界实测标定后写进门禁**。

| 文件 | 内容 |
|---|---|
| `scripts/office/evaluate.py` | 纯 Python 求值器：tokenizer + 递归下降 + 函数表，**故意不完整** |
| `scripts/xlsx_recalc.py` | **X4** 双引擎重算 + 把缓存值写回（`--engine both\|soffice\|python`） |
| `scripts/xlsx-evaluator-calibration.py` | 标定表：**55 个取自 LibreOffice 的值 + 9 个必须被拒绝的构造** |
| `office/sheet.py` `set_cached()` | 只写 `<v>`、保留 `<f>` —— 重算不能把模型换成一个数 |

**为什么需要它**：openpyxl **从不写缓存值**，所以任何库产出的 workbook，读「值」的
消费者看到的都是空格。重算并写回，才让这种文件对非表格软件可读。

**soffice 的路子换了**：`--convert-to csv` 只导第一张表，`--convert-to xlsx` 会强制全量
重算并给**每一张表**写缓存值。L2 的 X3 仍用 csv（它只需要第一张表），X4 用 xlsx。

#### 交叉验证第一次跑就抓到 6 个真差异

每一条我本来都会当成自信的正确数字发出去：

| 构造 | LibreOffice | 第一版实现 | 根因 |
|---|---|---|---|
| `-2^2` | **4** | -4 | 一元负号比 `^` 结合更紧（与几乎所有语言相反） |
| `2^3^2` | **64** | 512 | `^` 是**左结合** |
| `MOD(-7,3)` | **2** | -1 | 取**除数**的符号（即 Python `%`），不是 `math.fmod` |
| `IF(TRUE,,5)` | **0** | 解析失败 | 空参数 = 空白 |
| `SUM()` | **0** | 解析失败 | 零参数调用 |
| `AVERAGE(1,"x",2)` | **#VALUE!** | 1.5 | **直接传的文本 ≠ 区域里的文本** |

最后一条的处置值得单记：Excel 对「直接参数」和「区域内容」的强制转换规则不同
（`COUNT(1,"2","x")` = 2，因为直接传的数字串算数）。**与其凭记忆复刻这套规则，不如拒绝** ——
直接传文本给聚合函数一律 `Unsupported`。

还有一条**两个权威互相矛盾**：`SQRT(-1)` Excel 说 `#NUM!`、LibreOffice 说 `#VALUE!`。
没有可依循的权威 ⇒ **引擎拒绝，不选边**。一个可恢复的 Unsupported 好过一个半个世界认为
错的错误码。

#### 覆盖边界怎么「写进门禁」

标定表的每个值都是**跑 LibreOffice 量出来的**（`--emit` 可重新量并打印）。门禁四条：

| | 断言 | 在 CI 跑？ |
|---|---|---|
| **K1** | python 引擎匹配每一个固化值 | ✅ 到处跑 |
| **K2** | 边界外的构造被**拒绝**，不是悄悄算出个数 | ✅ |
| **K3** | `SUPPORTED` 里每个名字都被语料真的跑到 | ✅ |
| **K4** | **LibreOffice 仍与每个固化值一致**（查的是「固化值本身对不对」） | ❌ 无 LO 时 SKIP |

K4 是防 X3 那个洞的：K1 拿引擎对固化值，**只有 K4 拿固化值对权威**。无 LibreOffice 时它
走**独立的 skip 通道**、报告里单列、不计入 passed，并写明残余覆盖 ——
实测在模拟无 LO 的主机上：`58 passed, 0 failed, 41 assertions, 1 skipped`。

K3 是 L1 的 C5 降一层：没有它，`SUPPORTED` 就是个愿望清单（实测塞两个假名字
`MEDIAN`/`XLOOKUP` 进去，K3 立刻点名）。

#### 门禁结果

| 门禁 | 结果 |
|---|---|
| **L1** | **25/25 pass（25 proved by sample，18 artifact(s) verified by L2）**，pending 5 → **4** |
| **标定** | **64 passed（55 固化值 + 9 必拒构造），LibreOffice 与每个固化值一致** |
| **xlsx 行为测试** | 34 → **41 条断言 / 57 条负向控制，58 passed** |
| **L2 / L0** | 60 passed / 1 skipped · clean，地板仍 0.187 |

一个**测试自身的缺陷**：K5 首轮在正确产物上打红 —— harness 的 `cells_of` 用
`data_only=False` 读，拿回的是公式而不是缓存值。**断言错了，不是产物错了**
（与 S2 的 G3 同一形状）。

### 第五刀：X11 / X12 / X13 / X14 —— 收官（2026-08-02）

**`--no-pending` 全技能转绿 —— S3 完成的判据满足**（不是「我觉得做完了」）。
15 项能力全部实现、零 pending、29/29 proved by sample、**20 个产物经 L2 验证**。

| 文件 | 能力 |
|---|---|
| `scripts/xlsx_convert.py` | **X11** CSV/JSON 双向 · **X12** 流式读（`--stats`） |
| `scripts/xlsx_pdf.py` | **X13** 转 PDF + 页面图 |
| `scripts/xlsx_finance.py` | **X14** 财务色彩规范（opt-in，`--check`/`--apply`） |

#### X12 的「有界内存」是量出来的，而且量的是脚本自己

「超越项」声称的是有界内存,所以必须有数。用 `tracemalloc` 实测读同一张三列表：

| 行数 | 普通模式 | read_only | 比值 | 每千行 |
|---|---|---|---|---|
| 10,000 | 12.9 MB | 1.7 MB | 7.5× | 0.252 MB |
| 50,000 | 62.3 MB | 5.1 MB | 12.2× | 0.118 MB |
| 250,000 | 326.6 MB | 22.0 MB | 14.9× | — |

普通模式每行约 **1.3 KB 且不随规模改善**；read_only 的**每行成本随规模下降**。

**关键一点：门禁量的不是 openpyxl，是脚本本身。** 量 openpyxl 两种模式只能证明
openpyxl 有这个能力，证明不了**我的脚本用了它**。所以 N3 用 `runpy` 跑真脚本、
对照臂是**同一个脚本把 `read_only` 强制关掉**（那正是少写一个参数的样子）：
50k 行 **5.91 MB vs 63.15 MB（10.7×）**。N3 还有第三条断言：**对照臂必须是线性的**，
否则两条臂分不开、这个测量什么也不说明。

大夹具**刻意不入库** —— 5 万行的 xlsx 会主导 `.builtin-version`。

#### X13 是产物可见的唯一通道

xlsx 在应用内无法预览（产物面板只给二进制信息卡）。两件事它拒绝而不是糊弄：
**整页没墨的 PDF**（LibreOffice 对空表照样退出 0 并产出白页，把它当预览交回去比报错更糟）·
**没算过的 workbook**（公式格渲染成空，图片本身没法告诉你哪里不对）。

`--png` 需要 PyMuPDF，而它**不是**本技能声明的依赖（为预览附加功能给整个技能挂红徽标
不合理）。缺它时：PDF 照出、空白页检查降级为**明说的缺口**、`--png` **直接报错** ——
用户明确要了图，不产图却安静退出才是最该避免的失败。实测两条路径都验过。

#### X14 保持 opt-in

L2 为此付过学费（默认打开会把普通夹具判红）。所以它是一条**不会被误触发的独立命令**，
且 `--apply` 只改颜色、字号字形粗细一概带过去。
**`finance_colors: true` 只出现在 X14 这一个样例上** —— 其余样例一律声明 `false`，
那是「这是普通表格」的明确表态，不是没写。

#### 门禁结果

| 门禁 | 结果 |
|---|---|
| **L1** | **29/29 pass，20 artifact(s) verified by L2，pending 0** |
| **`--no-pending`（全技能）** | ✅ **绿** —— S3 判据满足 |
| **xlsx 行为测试** | 41 → **50 条断言 / 70 条负向控制，71 passed**，矩阵只剩 3 条注明的诚实级联 |
| **L2 / L0 / 标定** | 60 passed/1 skipped · clean 地板仍 0.187 · 64 passed |

### S3 完成

| 刀 | 内容 |
|---|---|
| 1 | office 底座 + X1/X2/X15 |
| 2 | X3/X5/X10 公式族 |
| 3 | X6-X9 结构性写入（graft 首次进产品路径） |
| 4 | X4 双引擎重算 |
| 5 | X11/X12/X13/X14 收官 |

**下一步是 S4（docx）**，其前置在 §5·补.8：**ECMA-376 XSD 能否随仓库分发尚未查证** ——
不查清楚，D2 会一直是唯一的永久 SKIP。另：CI 的 ubuntu 届时要补 `libreoffice-writer`
（D7 是 docx→PDF）。

---

## 六·补三 — `pdf` 技能整体去 PyMuPDF / 去 AGPL（2026-08-02）

**为什么**：用户告知后续作为商业软件分发。PyMuPDF 是 **AGPL-3.0 或商业授权**（权利人
Artifex，同时是 Ghostscript 权利人，有 *Artifex v. Hancom* 判例），而 `skills/builtin/`
随产品走 —— 这是整套东西里唯一的高风险项（§5·补.8c）。**换库不换标尺**：
`scripts/test-pdf-skill.py`（38 条断言 / 53 条负向控制）原样全绿是判据。

### 换成什么

| 库 | 许可 | 答哪类问题 |
|---|---|---|
| `pypdfium2` | Apache-2.0 / BSD-3（内含 PDFium） | 光栅化 |
| `pypdf` | BSD-3 | 对象模型：页树 / 表单 / 权限位 / 加解密 |
| `pdfplumber` | MIT（带 pdfminer.six + Pillow） | 文字几何 + 表格 |
| `reportlab` | BSD-3 | 写：生成 / 外观流 / 叠加层 |

14 个文件全换完（前一窗口 9 个，本窗口 5 个：`pdf_form_inspect` · `pdf_form_fill` ·
`pdf_form_check` · `pdfwrite`+`pdf_create` · `fixtures/make_fixtures.py`）。
`skills/builtin/pdf/` 下**没有任何一个文件 `import fitz`**。

### 门禁结果（全部本机实测）

| 门 | 结果 |
|---|---|
| `test-pdf-skill.py` | **53 passed / 0 failed**，38 条断言；矩阵每行只点亮该点亮的那条（仅两条本就记过档的级联） |
| `check-office-skill-capabilities.py --no-pending pdf xlsx` | **OK**，29/29 declared entry points pass，20 个产物过 L2 |
| `office-skills-selftest.py`（L2） | 62 passed / 0 failed，零跳过 |
| `check-skill-originality.py --target skills/builtin/pdf` | clean，0 violation / 0 review |
| `test-skill-originality.py`（L0 重标定） | 分离带 **0.191 ~ 0.736**，阈值 0.55 仍居中 |

### 三件量出来的事（别再猜）

1. **坐标系两个方向相反**，搞错是静默的、只在旋转页现形：`pdfplumber` 给**显示系**
   （旋转已应用）⇒ `to_page_space()` 逆转回页面系；widget `/Rect` 给**页面系且左下原点**
   ⇒ `pdf_rect_to_top_left()` 再 `to_display_space()`。对照值（`report-cjk.pdf` 第 3 页，
   旋转 90°）：显示 `(502,60,517,450)` ↔ 页面 `(60,78,450,93)`。fitz 当年记
   `(60,75,450,93)`，**差的 3pt 是两库对字框上沿的差异，不是坐标系错误**。
2. **macOS 上第一个能找到的 CJK 字体恰恰嵌不了**：`Hiragino Sans GB.ttc` 是 PostScript(CFF)
   轮廓，reportlab 报 `postscript outlines are not supported`。所以 `pdffont.py` 是
   **逐个试注册**而非「找到路径就用」。实测可用 `Songti.ttc`(subfontIndex=0) /
   `Arial Unicode.ttf`。Songti.ttc 磁盘 66,933,080 字节 → 产物 **32KB**（两页含表格），
   仍是嵌入的、文字仍可抽取。
3. **AcroForm 的值对三个文字读取器都是不可见的**：pdfplumber / pdfminer / PDFium 都只读
   页面内容流，域里的值活在 widget 的 `/AP` 流里。所以 `pdf_form_check.py` 先把外观**压平**
   到临时副本的页面内容再量 —— 这既是唯一可行的办法，也比原来更诚实：量的是阅读器真会画
   出来的东西。压平遵循 PDF 32000 §12.5.5（`/BBox` 过 `/Matrix` 再贴 `/Rect`）。

### 本轮抓到的两个真缺陷（两个都是门禁咬出来的，不是我预料到的）

1. **`pdf_info.py` 对加密文件报 `page_count: null`（I3 判红）。** 上一窗口把这一项记成
   「已完成并实测通过」，但那时树是坏的、整套标尺一次都没跑起来 —— **「我实测过」和
   「门禁跑过」是两件事**。真相：加密只覆盖**字符串和流**，对象图是明文，页树的 `/Count`
   本来就答得出来；是 pypdf 的守卫按对象一刀切才读不到。修法是只为这一个数字掀开守卫
   （`locked_page_count()`），并写清「目录在压缩对象流里时真的读不到，那时返回 null」。
2. **`draw_boxes_overlay` 会把第二页的内容整页抹掉（capabilities C4 判红）。**
   根因在 pypdf：`replace_contents()` 会把它替换掉的那批 `/Contents` 对象**全部置 Null**，
   而**两个页面可以共享内容对象** —— `table-grid.pdf` 的两页只差格线，MuPDF `garbage=4`
   把前 13 个对象去重合并了。于是给第 1 页画框顺手清空了第 2 页（实测 66 字符 → 0，
   渲染全白）。修法 `detach_contents()`：合并前先把该页内容拼成一份**私有**流。
   ⚠️ **`test-pdf-skill.py` 的 E4 覆盖不到这个** —— 它的被测对象 `report-cjk.pdf`
   三页之间不共享对象，这条缺口只有 capability 门（P3 的 L2 fidelity）表达得出来。
   **两个门禁量的不是同一件事，这次是后者救了场。**

### 明确的能力降级（都写进代码注释了，别改回去）

- **`pdf_encrypt.verify()` 证不了 owner 不受限**：pypdf 无论用哪个口令打开都返回文件里
  存的那一份 `/P`（实测 user / owner 都读到 20），而 PyMuPDF 会施加 owner 语义。
  真正的防线是**写入前**就拒绝「限制性 `--allow` + 没给 owner 口令」，不是事后复读。
  SKILL.md 里那句「实测以 owner 身份打开是全部允许」已改写 —— 那是规范事实，不是本工具链
  量得出来的事实。
- **`pdf_tables.py` 的 `header_external` 恒为 null**：pdfplumber 没有表头检测。
- **`make_fixtures.py` 重跑不再字节复现**：git 里那批是 PyMuPDF 写的。新脚本自身
  **六个示例里五个逐字节可复现**（`invariant=1` + 固定 `/ID`），`locked.pdf` 不可复现
  （AES-256 每次换盐）。新增 `--out-dir` 用于旁路生成对比。
  **本轮没有重新生成提交的夹具**（重跑会改 `.builtin-version` ⇒ 存量桌面端重装）；
  验证办法是把旁路生成的那批临时换进去跑全套 —— 实测 **53 passed / 0 failed**，跑完换回。

### ⚠️ 剩下的 AGPL 暴露面（本刀没做，需要单独决定）

1. **`skills/builtin/deckcraft/scripts/source_to_md/pdf_to_md.py`（1178 行）仍
   `import fitz`** —— 它**随产品分发**，和 pdf 技能是同一类风险。
   ⚠️ **更正一句我一开始写错的话**：这不是「新发现的」——**§5·补.8c 的路 ② 从一开始就写着
   「代价是重写 pdf 技能（S2 全部产出）+ deckcraft 的 `pdf_to_md.py`」**，13 个文件的清点里
   也点了它的名。本轮的会话任务书只圈了 pdf 技能，所以它被留下了；**它是已知欠账，不是遗漏**。
   附带问题：`BUILTIN_DEP_MAP.deckcraft` **从来没有声明过 pymupdf**，所以这条依赖在 UI 上
   一直是隐形的（§4·补 第 2 点记的既有缺陷，至今没修）。
   **规模与 pdf 技能的一刀相当，且 `pdf_to_md.py` 没有自己的行为门禁** —— 换实现的风险比
   pdf 技能那一刀高，因为没有标尺接着。
2. **`scripts/` 下三个门禁脚本仍 import fitz**（`office-skills-selftest.py` /
   `test-pdf-skill.py` / `test-xlsx-skill.py`）—— 它们不进产品包，风险低得多。
   `test-pdf-skill.py` 尤其要小心：它是标尺，**在它刚刚变绿的这一刀里换掉它的测量手段，
   等于让「绿」这件事失去意义**。留作单独一刀。

---

## 六·补四 — `deckcraft/pdf_to_md.py` 去 PyMuPDF（2026-08-02，S3.5 收官）

§六·补三 结尾点名的欠账。这是全仓库**最后一处「分发中的 AGPL 暴露」**：1178 行、随产品走、
**一条测试都没有**（`scripts/` · `packages/**/__tests__/` · `.github/workflows/` 全 grep 零命中）。

### 顺序：先立标尺，后换实现

新增 `scripts/test-deckcraft-pdf-md.py`（**25 条断言 / 28 条负向控制**），**在动实现之前写完**。
这是 S1 立的规矩，也是 §六·补三 能安全换掉 14 个文件的唯一原因。夹具在临时目录现生成
（reportlab 画 styles/table/card/headfoot/figure，pypdf 造 rotated），**不入 git ⇒ 不动
`.builtin-version`**；真实语料用仓库里的 `examples/ai-coding-pilot/export/deck.pdf`。

实现拆成两层：新增 `source_to_md/pdfsource.py` 作为**读取层**（pdfplumber/pypdf/pypdfium2），
`pdf_to_md.py` 的 1100 行转换逻辑**逐字未动**（只换 import、`fitz.Rect`→`Rect`、
`get_pixmap`→`render_clip`）。这样任何 Markdown 差异都只有一个可能的来源。

### 判据：合成夹具逐字节相同，真实语料四处差异全部有据

| 夹具 | 与 PyMuPDF 基线 |
|---|---|
| styles / table / headfoot / figure | **逐字节相同** |
| rotated（styles + `/Rotate 90`） | 与 styles 逐字节相同（除标题行） |
| deck.pdf（真实语料） | 四处差异，见下 |

1. **`E N G I N E E R I N G` → `ENGINEERING`** —— PyMuPDF 把 CSS letter-spacing 当成词间空格，
   逐字母拆开。**新实现更对。**
2. **CJK 加粗标记** —— Chrome 把中文导成 **Type3 字体**，无 descriptor ⇒ PyMuPDF 对
   **deck 里每一个中文字**都报 `flags=0`（粗细信息整体丢失）；pdfminer 能解析出
   `PingFangSC-Semibold` / `-Thin`。⇒ 新实现给 semibold 加 `**`。**这是本刀唯一一处
   刻意的行为改变**，写进断言 B5，并配了「按 PyMuPDF 那样不算粗体」的负向控制。
3. **页内阅读顺序**（`01 交付压力持续上升` vs `交付压力持续上升 01`）—— 两者都是把一页幻灯片
   拍平成一行，谁也不比谁「对」。新实现按视觉从上到下、从左到右。
4. **不再出现幽灵表格**（见下第 3 条）。

### 五件量出来的事（都不是查文档得来的）

1. **pdfminer 会把中文读成「康熙部首」。** `力`(U+529B) 到手是 `⼒`(U+2F12)，`同比`→`同⽐`、
   `人力`→`⼈⼒`、`工具`→`⼯具`、`行动`→`⾏动`、`时长`→`时⻓`。**长得一模一样，比较不相等**
   —— 搜索、diff、喂给模型全部受影响。PyMuPDF 静默折叠了这一层，迁过来才冒出来。
   修法有两半：**康熙部首块(U+2F00–2FD5) 每个码位都有 NFKC 分解**，逐字符折叠即可；
   ⚠️ **CJK 部首补充块(U+2E80–2EF3) 的 113 个码位一个 NFKC 分解都没有**，同样的招数对它无效
   （`⻅⻓⻛` 就是这么漏进第一版产物的），只能查表。**表只收「本身就是独立汉字」的 20 个
   简化部首**（⻅见 ⻓长 ⻛风 ⻢马 …）；`⺅`(人字旁) `⻌`(走之) `讠` `纟` 这类**部件**故意不折 ——
   它们不是字，折了等于替文档说它没说的话。**整串 NFKC 是错的**：会把 `①`→`1`、`％`→`%`、
   `Ａ`→`A`、`ﬁ`→`fi` 一起改掉（K2 断言守的就是这条）。
2. **PDF 里没有「空格」，只有距离 —— 阈值必须实测标定。** 同一基线上的两段文字（幻灯片上三个
   分开的数字、两张卡片的标题）之间没有空格字符。deck.pdf 的 1044 对相邻字符实测：

   | 间距 / 字号 | 对数 | 是什么 |
   |---|---|---|
   | 0.0180 ~ **0.2500** | 225 | CSS letter-spacing —— **不能**变成空格 |
   | （空带，宽 **5.17 倍**） | **0** | |
   | **1.2934** ~ 39.46 | 34 | 真的是两段（`路线B` \| `推荐`）—— **必须**变成空格 |

   取 **0.9**。**两边都配了负向控制，而且是真的把常量改掉重跑**：调到 0.2 ⇒ kicker 又碎成
   单字母（正是 PyMuPDF 的老毛病）；调到 3.0 ⇒ `+31% -24% 83%` 粘成 `+31%-24%83%`。
3. **pdfplumber 把「有边框的方块」报成 1×1 的表格。** 幻灯片就是由这种卡片组成的，deck 的
   第 4、7 页各中一枪：产出 `||` / `|---|` 这种废话 Markdown，**并且顺手吞掉卡片里的正文**
   （调用方会丢弃与表格区域重叠的文本块）。修法是**要求 ≥2 行且 ≥2 列** —— 网格才是表格，
   边框不是。配了专门的 `card.pdf` 夹具与 T2 断言。
4. **「显示坐标系」和「阅读坐标系」不是一回事，只有旋转页现形 —— 而且这次是标尺先抓到的。**
   pdfplumber 给的框是 /Rotate 之后的（观众看到的），但上面 1100 行逻辑通篇假设「文字向右走、
   行往下叠」：它按 `y0` 排序、把页面上方 15% 当页眉带。第一版只改了行聚类的轴，结果 X1 判红：
   旋转页的产物是**倒序的行 + 粘成一坨的词 + 全错的字号**。修法是引入 `_Frame`：
   **交给上层的每一个几何量（文字/图片/表格/矢量图/页面本身）统一换算到阅读系**，
   `render_clip` 再换回去。⚠️ 附带一条独立的坑：**页面文字不横向走时，pdfplumber 的
   `size` 报的是字的「前进宽度」而不是字号**（实测 24pt 标题报成 18.67，连带整个正文/标题
   排序全错）—— 字号改从阅读系框高取。
5. **裁剪框翻转了 y 之后，「有墨」这个判据会给它发通行证。** 实测本刀自己的夹具：正确裁剪
   墨占比 **0.399**，上下翻转的错误裁剪 **0.587 —— 更高**（因为翻过去正好落在那张噪声图上）。
   ⇒ R1 断言量的不是墨，而是**把产出的 PNG 与「整页渲染后按同一个框裁下来的那块」逐像素比**
   （参考路径完全不做 PDF 坐标换算，所以它独立）：正确 **0.00**，翻转 **66.13**。
   这条负向控制是**真渲染**出来的，不是往 ctx 里填的数。

### 标尺自己有三个缺陷，全是被它自己跑出来的

1. **`deck.pdf` 是 10 页，不是 24 页。** 本刀的任务书写的是「24 页中文」，文件和它自己的
   `N / 10` 页脚都说 10。P1 断言把它照抄进来就会永远判红 —— **抄来的数字要验**。
2. **A1「树里还有没有 `import fitz`」被自己的注释骗了。** 用 grep 就会数到 `pdfsource.py`
   docstring 里那句「本文件是为了取代 `import fitz`」和标尺自己的说明文字，**把干净的树判成脏的**。
   改成 `ast` 解析真实 import 语句。
3. **V0 的非空性下限写错两处**（表格行数 4 行 + 表头线 = 5 而不是 6）。

另有 5 条负向控制会**连带**点亮 V0 —— 这是诚实的级联（把标题全删了，H1 确实就没有被测对象了），
按 §六·补三 的做法写进矩阵注释而不是把哪一边调松。

### 顺带修掉 §4·补 第 2 点的依赖声明缺口（比记录的更大）

实测清点五个转换器的真实 import，**比 059 原先记的多出三项**：

| 脚本 | 实际依赖 | 原声明 |
|---|---|---|
| （核心）`export_deck.py` | **`PIL`** | ❌ **核心路径依赖却完全没声明** |
| `pdf_to_md.py` | pdfplumber · pypdf · pypdfium2 | ❌ |
| `doc_to_md.py` | mammoth · ebooklib · nbconvert · markdownify · **bs4** · requests · PIL | ❌ |
| `excel_to_md.py` | openpyxl | ❌ |
| `ppt_to_md.py` | python-pptx · PIL | ✅（PIL 除外） |
| `web_to_md.py` | curl_cffi · requests · **bs4** · **urllib3** · PIL | ❌ |

处置：**`pillow` 进必需**（核心导出路径真的要它）；**十一个「源读取器」进 optional** ——
只在用户喂那种格式时才 import，只做 Markdown→deck 的人没有 nbconvert 不该看到「未就绪」。
三处同步：`x-requires`（新增 `x-requires-optional`）· `BUILTIN_DEP_MAP` · Rust `PY_MODULES`。

⚠️ **这里差点引入一个新缺陷**：`OPTIONAL_DEPS` 原本是**按依赖名全局生效**的，
把 `pdfplumber` 标成 optional 会**让 `pdf` 技能在一个 PDF 库都没有的情况下显示「就绪」**。
改成支持 `技能名:依赖名` 作用域，并补了「对 deckcraft 可选的东西，对以它为地基的技能仍然必需」
这条回归断言（`openpyxl` 同理：xlsx 必需、deckcraft 可选）。

### 收工复审又抓到两个真缺陷（S4 开工前的系统 review，2026-08-02）

**都不是标尺抓的，是「换个角度提问」抓的** —— 一个来自「team 协作模式下兼容吗」，
一个来自「打包到客户机器上能正常工作吗」。

1. **⚠️ pdfminer 把 168 行警告打进 stdout，而 stdout 在 team 模式下跨委派边界。**
   转一份 10 页的示例 deck，`Could not get FontBBox from font descriptor because None
   cannot be parsed as 4 floats` 打了 **168 次** —— **172 行 / 14,775 字节**，而 PyMuPDF
   时代是 **4 行 / 328 字节**。根因：Chrome 的 print-to-PDF 写的 Type3 字体没有 FontBBox，
   于是每个嵌入字体触发一次，**而它说的每一句话的意思都是「这个 PDF 很正常」**。
   ⚠️ **我此前所有门禁运行都用 `2>/dev/null` 把输出丢掉了，所以一次都没看见它** ——
   「我的验证方式让我看不见缺陷」的又一例。
   修法 `_quiet_pdfminer()`：只把 `pdfminer` 这一个 logger 抬到 ERROR（不是 disable，
   真错误仍然说话），且**在 `Document.__init__` 里调用而非 import 时** —— 一个模块仅仅
   因为被 import 就重配日志系统，对 import 它的人是意外。
   实测 **172 行 → 4 行**，产物逐字节相同。已写成断言 **O1**（预算 4096 字节，取 pdf 技能
   同一个数）+ **两条负向控制**：一条灌 168 行真实噪声（不是编造的破坏），
   一条把 stdout 清空 —— 因为**「消掉噪声」的过度修正就是把进度报告一起消掉**。

2. **依赖徽标里所有 Python 库都是裸名字，没有任何安装提示。** `DEP_HINTS` 三个平台分支里
   只有 `python-pptx` 一个 pip 包，于是 pdf 技能的四个必需依赖、xlsx 的两个、加上本刀新增的
   `pillow` 全部走 `DEP_HINTS[m] ?? m` 兜底 —— 用户看到「缺少: pypdfium2, pypdf, pdfplumber,
   reportlab」，点「引导安装」按钮时**递给助手的也是同样的裸名字**。
   这是 **S2/S3 就有的既有缺陷，本刀又扩大了它**。处置：抽出 `PIP_HINTS`（三平台命令相同，
   放一份而不是抄三份等着漂移）移到 `use-skill-deps.ts` 与 `BUILTIN_DEP_MAP` 同处，
   并加断言「`BUILTIN_DEP_MAP` 里每个依赖要么在 `PIP_HINTS`、要么在显式的非 pip 白名单里」
   —— 负向控制实测：删掉 `pillow` 一行即精确判红 `["pillow"]`，还原转绿。

3. **⚠️⚠️ CI 装的库还停在换库之前，而且新标尺根本没进 CI。** `office-skills` job 的
   `pip install` 是 `pymupdf pypdf python-docx openpyxl lxml` —— **`pypdfium2` /
   `pdfplumber` / `reportlab` 一个都没有**，而 pdf 技能整体换库后就靠这三个。
   **一 push 就 ImportError 直接红。** 之所以至今没响，是**分支从未 push** ——
   与 §7 里 `recalc-drift` 那颗雷**完全同一个形状**，而且本机装了全部库、看不见。
   同时发现 `scripts/test-deckcraft-pdf-md.py` 建好之后**没有加进 CI** ——
   §六·补 的教训「收工复审抓到 5 个缺陷，2 个只在别人机器上犯，根因是门禁一条都没进 CI」
   **本轮原样重犯了一次**。
   处置：pip 列表补齐并逐项注明用途（含**为什么还留着 `pymupdf`** —— 不是给技能用的，
   是 `scripts/` 下那三个未换的门禁脚本要，它们不分发）· 新标尺加进 job。
   验证手段是**静态求 import 闭包再对照 pip 列表**（⚠️ 这个检查脚本自己错了三次：
   本地模块白名单手写漏了 `pdfwrite`、漏了包目录 `office`、没映射 `pdfminer` 是
   `pdfplumber` 的传递依赖 —— 改成从目录现扫本地模块名之后才准）。

**同时验证为「没问题」的**：打包链路（从 zip 解压到 `/var/folders/...` 的陌生路径跑真实转换，
产物正确）· 徽标不会因 deckcraft 从 4 个依赖变 16 个而爆炸（UI 只渲染 missing，optional 不进）·
Rust 的 badge 名与 TS 查的名字一致（`("pillow","PIL")` 的左值才是 `DepStatus.name`）·
新代码零平台调用、路径全走 pathlib（`pdf_to_md.py` 里那两处 `/` 是 Markdown 图片链接，
**正斜杠才是对的**，换成 `os.sep` 反而会在 Windows 上生成坏链接）。

### 明确没做 / 已知边界（写下来，不要以为验过了）

- **代码块围栏一直是坏的，本刀没修。** 段落合并那一步重建元素时把 `is_code` 丢了
  （`pdf_to_md.py` 的 `merged_elements` 分支），所以等宽字体的行永远拿不到 ```` ``` ````。
  **这是换库之前就存在的缺陷**，在一刀换库里顺手改行为会让「差异只有一个来源」这个判据失效。
  已由 B4 断言把**当前行为**钉住（等宽行不被加粗斜体标记污染），修它归下一刀。
- **CJK 部首补充块只折了 20 个独立汉字**，其余 93 个部件形态原样保留（K2 守着这条）。
- **一页里混排多个文字方向**时，`_Frame` 取字符数占多数的那个方向，少数派的顺序会错。
- **旋转页只有合成夹具**（pypdf 给 styles.pdf 加 `/Rotate 90`）。真实世界的横排扫描件
  是「文字本身也旋转过」的另一种形态，`_Frame` 按字符矩阵判方向所以应当覆盖，**但没有真样本**。
- **图片字节不再逐字节等同**：pypdf 会重新编码（实测同一张图 fitz 360,494 字节 / pypdf 360,763），
  所以 R3 断言比的是**像素**而不是字节。`should_keep_image` 里那几个按字节数标定的阈值
  （`MIN_IMAGE_BYTES` / bpp）因此有轻微漂移，量级 0.07%，未重新标定。
- **`scripts/` 下三个门禁脚本仍 `import fitz`**（不分发）—— 与 §六·补三 的结论一致，留作单独一刀。

### 门禁结果（全部本机实测，退出码直读不经管道）

| 门 | 结果 |
|---|---|
| `test-deckcraft-pdf-md.py`（**新**） | **30 passed / 0 failed**，26 条断言，矩阵每行只点亮该点亮的那条 |
| `test-pdf-skill.py` | 53 passed / 0 failed（38 断言）—— 未受影响 |
| `test-xlsx-skill.py` | 71 passed / 0 failed |
| `office-skills-selftest.py`（L2） | 62 passed / 0 failed |
| `check-office-skill-capabilities.py --selftest` | 16 passed / 0 failed |
| `--no-pending pdf xlsx` | OK，29/29 declared entry points，20 产物过 L2 |
| `xlsx-evaluator-calibration.py` | 64 passed / 0 failed |
| `check-skill-originality.py --target deckcraft` | clean，0 violation / 0 review |
| `test-skill-originality.py`（L0） | 分离带 **0.191 ~ 0.736**，阈值 0.55 仍居中 |
| `check-docs.ts` · `turbo typecheck` | 绿 · **8/8** |
| desktop `skills-builtin.test.ts` | **15/15**（原 12） |
| `cargo test` | **155** |

`.builtin-version`: `55843f24e06ee965` → **`6bae0dae40aa68c5`**（两处已对齐）。

---

## 六·补五 — S4 第一/第二刀：`docx` 技能落地（2026-08-02）

19 项能力里落地 **7 项（W1/W2/W3/W5/W13/W15/W17），12 项 pending 逐条写理由**。
沿用 S2/S3 的规矩：**先立标尺，后写实现** —— `capabilities.json` 与
`scripts/test-docx-skill.py` 先于每一项能力，且新标尺**在同一刀里进 CI**。

### 开工前两个实测，直接改掉了原计划

| 原设想（照搬 xlsx） | 实测 | 后果 |
|---|---|---|
| 「库的 round-trip 是有损的，所以要外科式 + graft」 | **python-docx round-trip 一个字节不丢**：17/17 part 逐字节相同。它只丢**没有任何关系指向的** part（注入一个孤儿 part，保存后消失） | xlsx 那套「load→save 丢 part」的叙事**对 docx 不成立**，照抄就是一句没有数据的形容词。graft 保留了，但理由换成「让 drop/restore 对称」，不是「每次写入的绷带」 |
| 「docx 的头号缺陷和 xlsx 类似」 | **一句话不是一个 run**：`第三季度` 在示例里出现两次，标题里那次在一个 run 内、正文里那次被切成 `"2026 年第"` + `"三季度"`。逐 run 替换实测 **1/2** | 这才是 docx 的头号缺陷，整个技能围绕它建 |

⚠️ **「1/2」这个数字本身是被标尺纠正的。** 开工前我在一个只含拆分短语的段落上量到
**0**，写进了三处文档；标尺跑起来第一件事就是 V0 判红 —— 真实夹具里标题那次是能匹配到的。
**"我在别的场景里量过" ≠ "在这个夹具上量过"**，三处文案已全部改成实测值。
而且 1/2 比 0/2 更能说明问题：**一处都找不到的工具一分钟内会被报 bug，十处对九处的工具会一直用下去**。

### 落地内容

`skills/builtin/docx/`（新建，**纯 lxml，刻意不依赖 python-docx**）：

| 文件 | 作用 |
|---|---|
| `scripts/office/package.py` | 包=parts+content types+relationships；graft / drop 对称 |
| `scripts/office/document.py` | **段落字符流**：`<w:t>` 节点 ↔ 偏移的映射，跨 run 匹配与替换；`near_miss` |
| `scripts/office/xmlorder.py` | WordprocessingML 三种序规则：SEQUENCES（pPr/rPr/sectPr/tblPr/tcPr/trPr/styles/numbering）· LEADING（p 的 pPr、r 的 rPr、tbl 的 tblPr+tblGrid）· **TRAILING（body 的 sectPr）** |
| `scripts/office/validate.py` | 包一致性 + **每个 `r:id` 都有 Relationship** + 元素序 |
| `scripts/office/soffice.py` | 三平台探测 + 转换（隔离 profile） |
| `scripts/docxcommon.py` | 错误契约 / stdout 预算 / `open_document` 按名字拒绝非 Word 包 |
| `scripts/docx_read.py` | **W1** 段落级文本、表格网格、列表层级、章节、页眉页脚（含域计数）、修订、批注 |
| `scripts/docx_edit.py` | **W2** 跨 run 替换（`--in-headers` opt-in）· **W3** 追加段落 |
| `scripts/docx_template.py` | **W5** `{{占位符}}` 填充，**页眉页脚默认一起填**，`--strict` |
| `scripts/docx_package.py` | **W13** unpack/pack（保序、防路径穿越）· **W15** `--fix-order` |
| `scripts/docx_pdf.py` | **W17** 转 PDF / 页面图 |
| `fixtures/` | `report.docx`（17 part：CJK 标题、拆分 run、占位符、编号列表、`w:ins`+`w:del`、批注、超链接、3×3 表格、图片、页眉、带 PAGE 域的页脚、**customXml**）· `unordered.docx`（同一份文档、只差三处元素序）· `make_fixtures.py` |

**夹具是手写的，不是 python-docx 产的**，三条理由：① python-docx 自带模板的
`<w:zoom>` 缺 `w:percent`（§5·补.8d 记录的那条），**一个自身带已知缺陷的产物没资格当正样本**；
② 它的模板 ~800 KB，会主导内置技能体积；③ 修订/批注/域/customXml 它一个都表达不了。
手写 17 个 part 共 **8.3 KB**，**逐字节可复现**（固定 zip 时间戳 + 压缩级别 + 字面日期），
且一次就通过了 L2 的 D1–D7（含 **D2 XSD** 与 **D7 LibreOffice 渲染**）零 finding。

### 三个「先绿后被推翻」的点（全是标尺自己抓的）

1. **V0 又一次去量了别人的活。** 初版 V0 读的是「脚本报告里 cross_run 是不是 ≥1」——
   于是逐 run 替换那条负向控制一点亮就顺带点亮 V0，**而 V0 该说的是「夹具还在不在考这件事」**。
   改成 `fixture_facts()`：**只走夹具的 XML，一个脚本报告都不读**。
   （这是本任务里同一个错误的第**四**次，前三次记在 §六·补二。）
2. **夹具里被删的文字与正文撞了。** `REVISION_DELETED` 原本是 `毛利`，而正文有
   `毛利率保持稳定。` ⇒ 「被删的文字不得当正文报告」这条**在正确实现上就判红**，
   而且**在错误实现上也无法失败** —— 它测的是子串巧合。改成 `扣非净利`（全文唯一）。
3. **「空白文档」并不空白。** Y2 的负向输入是「body 只剩一个空段落」，
   但它**保留了页眉页脚引用** ⇒ LibreOffice 渲出来的页面上有信笺抬头和页码，**有墨**。
   同样是断言在正确实现上判红，才发现夹具不是它名字说的那个东西。

### 顺带拆掉的 CI 雷（不是 S4 引入的）

⚠️ **`office-skills` job 在 ubuntu 上本来就是红的，而且与 S4 无关。**
`ci.yml` 只装 `libreoffice-calc`，而 **L2 的 D7 对每一个 docx 用例都要把 .docx 转成 PDF**，
且它在「探测到 soffice」时就会跑 —— 只有 Calc 的机器上 `soffice` 存在、
**对 .docx 退出 0 且不产出任何文件**，于是 L2 自检的所有 docx 用例全红。
之所以没响，还是那句：**分支从未 push**。这是本任务里同一形状的第三次
（`recalc-drift` · 换库后 pip 列表 · 本条）。处置：装 `libreoffice-writer`，
并在注释里写明它不是 S4 的新需求、是一直欠着的。

同一刀里 `test-docx-skill.py` **也进了 CI**（§六·补四 的教训「新标尺建好没进 CI」不再重犯）。

### 跳过必须被点名：Y1-Y3 与它们的负向控制一起跳

W17 的三条断言需要 LibreOffice。没装的机器上：**断言跳过、并且它们的负向控制也跳过并逐条点名**
（`negative control 'blank-render-handed-back-as-a-preview': needs LibreOffice`）。
只跳断言不跳控制 = 「必须打红的没打红」= FAIL；两个都静默跳过 = 把控制关掉。
这是 §7 那颗雷的正确处置方式，在新技能上第一次就照做。

### 收工复审：「换个角度提问」又抓到一个门禁抓不到的缺陷

沿用 §六·补四 的两个问题。**「打包到客户机器能工作吗」这次是干净的**（zip 里 18 个 docx 文件、
`scripts/office/` 齐全、无 `__pycache__` 泄漏；解压到陌生路径、cwd 设在 home 跑三个入口点全 exit 0；
`lxml` 有 pip 提示、`soffice` 在非 pip 白名单里）。

**「team 协作模式下兼容吗」抓到一个真缺陷。** 九个入口点的 stdout 都在 400~4,549 字节、
**stderr 全为 0**，看起来没问题 —— 直到换一种文档形状：

| 形状 | 报告列表长度 | stdout |
|---|---|---|
| 2000 个段落 | 2000（**超过条数上限，裁剪触发**） | 合规 |
| **1 张 800 行的表格** | **1**（条数上限**看不见它**） | **130,602 字节** |

`compact()` 按**列表长度**裁，而 `table_contents` 是「条数少、每条巨大」。
⇒ 补一道**字节预算**（裁完 130,602 → **1,577**，且 `--out` 里数据一条不少）。
**过度修正是另一个缺陷**：裁完必须仍说得出「这里有一张多大的表被省略了」，
所以断言 C3 配两条控制 —— 一条是缺陷本身（130,602），一条是裁过头（报告里连表都不提了）。
⚠️ **C1 只喂过「很多段落」，从没喂过「一张很大的表」** —— 门禁只看它被设计去看的那一面。

### L0 重标定：地板**又**没有涨，而且原因与预测的不同

§六·补二 写过「真正的考验是 `docx`，它会像参考实现一样用 python-docx」。实测：

| 负样本 | max | 最高分文件 |
|---|---|---|
| + xlsx（45 个 .py） | 0.187 | `pdf_form_inspect.py` |
| **+ docx（67 个 .py）** | **0.191** | 仍是 `pdf_form_inspect.py` |

**docx 自己最高 0.152**（`xmlorder.py` ← 参考实现的 `element_order.py` —— 主题最接近的那一个，
说明打分器行为合理）。**但这不是「阈值经受住了考验」** ——
那个预测的前提（同库）**没有成立**，因为这份实现没有用 python-docx。
参考语料里确实有 `accept_changes.py`（W7）和 `element_order.py`（W15），
**W6/W7 落地时这条对照才真正到来**。分离带 0.191 ~ 0.736，阈值 0.55 仍居中。

### 明确没做 / 已知边界

- **19 项只做了 7 项**，12 项 pending。**W14（XSD 校验）的 pending 理由里写着一个真问题**：
  schema 984 KB 在仓库里、不随技能分发，「shipping / `$ECMA376_XSD_DIR` / 大声降级」三选一未定，
  **唯一不可接受的是静默降级**。
- **`--fix-order` 只排建模过的元素**，不认识的命名空间原样留在原位。
- **替换不认识域**：`{ PAGE }` 是五个 run，其中一个存着缓存值；替换串正好命中缓存值就会被当普通文字改掉。
- **`markdown-exporter` 的 DOCX 路由仍写「建设中」，故意的** —— 那条路由指的是
  「从 Markdown 生成 Word」= **W4，仍在 pending**。指向一个做不到这件事的技能，就是 §1 那个 `doc-export` 断链。
- ~~**`doc-edit` 去留仍未决**~~ —— 2026-08-04 S6 已决：瘦身改名 `pptx-edit`（§六·补八）。
- **CI 的 `--no-pending` 仍只列 `pdf xlsx`**，docx 清完 12 项欠债才加进去。

### 门禁结果（全部本机实测，退出码直读不经管道）

| 门 | 结果 |
|---|---|
| `test-docx-skill.py`（**新**） | **60 passed / 0 failed**，35 条断言 / 59 条负向控制，矩阵每行只点亮该点亮的那条 |
| `test-pdf-skill.py` | 53 passed / 0 failed |
| `test-xlsx-skill.py` | 71 passed / 0 failed |
| `test-deckcraft-pdf-md.py` | 30 passed / 0 failed |
| `office-skills-selftest.py`（L2） | 62 passed / 0 failed，零跳过 |
| `check-office-skill-capabilities.py --selftest` | 16 passed / 0 failed |
| `--no-pending pdf xlsx` | OK，**36/36** declared entry points（原 29），**26** 个产物过 L2（原 20） |
| `xlsx-evaluator-calibration.py` | 64 passed / 0 failed |
| `check-skill-originality.py --target docx` | clean，0 violation / 0 review |
| `test-skill-originality.py`（L0） | 分离带 **0.191 ~ 0.736**，阈值 0.55 仍居中 |
| `check-docs.ts` · `turbo typecheck` | 绿 · **8/8** |
| desktop `skills-builtin.test.ts` | **16/16**（原 15） |
| `cargo test` | **155** |

`.builtin-version`: `6bae0dae40aa68c5` → `273f1b925a460d55` →（第三刀后）**`ea934ed9347ea5bd`**（两处已对齐）。

### 下一刀

**修订批注族 W6/W7/W8**（059 标注最难的一族，且参考语料里有 `accept_changes.py`，
是 L0 那条「同库同活」对照真正到来的时候）· 版式族 W9/W10/W11/W16 ·
生成族 W4/W12/W19 · W14/W18。

---

### 第三刀：W6 / W7 / W8 —— 修订批注族（2026-08-02）

19 项里再落地 3 项，**共 10/19，9 项 pending**。这一族 059 自己标注「最难」，难点不在
解开 `<w:ins>`，在于**形态有五种，只认识前两种会毁掉文档**。

| 形态 | 只认识前两种会怎样 |
|---|---|
| `<w:ins>` / `<w:del>` 行内 | —— |
| `<w:moveFrom>` / `<w:moveTo>` + 区间标记 | 移动只解一半 |
| **段落标记上的修订** | 它表示**段落分隔符**被插入/删除，解析它意味着**合并两个段落**；当成行内修订解包，文档看起来没变而编辑其实没生效 |
| `<w:pPrChange>` 等格式修订 | 旧属性存在**它内部**，拒绝时要放回去；直接删掉 = 「报告说拒绝了、格式却留着新的」 |
| **`<w:ins>` 里嵌 `<w:del>`** | 「插入的文字后来又被删了」，最普通的评审流水 |

处置是**契约而不是声称**：每次操作结束重扫一遍并报告 `remaining`，
`--strict` 把「还有剩」变成拒绝写出。一种本代码不认识的形态会出现在那里，
而不是被当成成功 —— L1 的 W7 sample 就跑在 `--strict` 下，所以「悄悄跳过一种形态」在门禁层判红。

#### 开工第一件事就是修门禁，而裁决来自 schema 不是我

`<w:ins><w:del>` 会被 **L2 的 D5 判红** —— 它用 `.iter()` 做后代遍历，
把「插入后又删除」当成「删除的文字混进了插入里」。
**用 vendored 的 ECMA-376 XSD 裁决**（独立权威，与手写规则不同源）：

| | 结论 |
|---|---|
| **D2**（XSD） | **VALID** —— `CT_RunTrackChange` 的内容模型含 `EG_ContentRunContent`，其中就有 `w:ins`/`w:del` |
| **D5**（本仓库手写规则） | 判红 |

⇒ **D5 错了**。修法是跳过「属于嵌套修订的」文本，**牙齿一颗没松**：三条「必须打红」
（`w:t` 在 `w:del` 里 · `delText` 直接在 `w:ins` 里 · 修订缺 author）全部照旧，
另加一条**正样本**用例钉住这次的放宽。⚠️ **这是在写实现之前发现的** ——
不是我的代码被它判红才去改它。

#### F2 也有同一个形状的缺口：无法表达「这个 part 是有意删掉的」

删掉最后一条批注**必须**连 `word/comments.xml` 和它的关系一起删 —— 而 F2 对
关系数下降一律判红，没有出口。这与 §六·补二 记的 `finance_colors` 是同一个病：
**门禁没法说「这不是缺陷」，唯一的出路是谎报产物**。
修法 = 让 `may_drop`（F1 已有）也对 F2 的两条规则生效，**并配控制臂**：
同一个删除**不声明** `may_drop` 时必须照样打红，否则「放行」和「F2 不再数关系了」分不出来。
L2：62 → **65 passed**。

#### 两个在正确实现上判红、从而暴露我自己错了的点

1. **段落标记必须最后处理。** 段落标记在文档序里是段落的**第一个**元素（`w:pPr` 打头），
   按文档序扫描会在段落**还装着即将被删掉的内容时**就去问「这个段落空了吗」⇒
   拒绝一个被插入的段落会**留下一个空段落**。实测到了才改成「内容优先、段落标记最后」。
2. **lxml 元素的真值判断**：`target = target or mark_target` 对**没有子元素的元素**会
   静默选错分支，并且往 stderr 打 `FutureWarning` —— 而 stderr 在 team 委派下是要付钱的输出。

#### 一条断言写错了才发现的语义

「reject-all 应该等于原文」是**错的**：夹具**自己就带着一条修订**（`净利润` 插入 /
`扣非净利` 删除），reject-all 把它也拒绝掉是**正确行为**。所以断言改成两条更准的：
被我改动的那段落**逐字回到原样**，而夹具自己那条修订按方向解析（accept→`净利润`、
reject→`扣非净利`）。

#### 顺带量到一条 python-docx 的边界，直接改了 L1 sample

**跟踪插入的文字 python-docx 读不到**（它的 `paragraph.text` 只遍历直接 `w:r` 子元素），
所以 W6 的 sample 里 `contains` **必须点名修订之外的文字** —— 第一版写了文档标题，
而标题里也含 `第三季度`、同样被跟踪了，于是 L1 判红。**没有去改 D3**：
D3 的价值正在于它是一个**独立的第三方读取器**，让它改用本技能自己的抽取逻辑就变成自证。

#### L0：预测了两轮的「同库同活」对照终于到来

参考语料里确实有 `accept_changes.py`（W7）、`comments.py`（W8）、`element_order.py`（W15）。实测：

| 本技能文件 | 分数 | 最近邻 |
|---|---|---|
| `office/revision.py`（与 `accept_changes.py` **同一件事**） | **0.097** | `attendance_vacation_balance.py`（毫不相干） |
| `docx_comment.py` | 0.130 | `comment.py` |
| `office/xmlorder.py` | 0.152 | `element_order.py` |

72 个自写脚本 max 仍是 **0.191**（`pdf_form_inspect.py`），分离带 0.191 ~ 0.736，阈值 0.55 仍居中。
**做同一件事并没有把分数推上去**，这条对照到此销账。

#### 门禁结果

`test-docx-skill.py` **85 passed / 0 failed**（46 断言 / 84 控制）· L2 **65/0** ·
capabilities 16/0 + `--no-pending pdf xlsx` **39/39**（29 产物过 L2）· pdf 53/0 · xlsx 71/0 ·
deckcraft 30/0 · 求值器 64/0 · L0 0.191~0.736 · check-docs 绿 · typecheck 8/8 · Rust 155 ·
desktop skills-builtin 16/16。`.builtin-version` → **`ea934ed9347ea5bd`**（两处对齐）。

#### 下一刀

版式族 **W9/W10/W11/W16**（页眉页脚创建 · 目录与多级编号 · 图片插入 · 字体巡检）·
生成族 **W4/W12/W19** · **W14/W18**。

---

### 第四刀：W9 / W10 / W11 / W16 —— 版式族（2026-08-03）

19 项里再落地 4 项，**共 14/19，5 项 pending**。这一族的共同形状是
**「写对了看起来该写的，产物照样不对，而且没有任何东西报错」**。

| 能力 | 脚本 | 那个不报错的坑 |
|---|---|---|
| W9 页眉页脚 | `docx_header.py` | 四样写全了，首页/奇偶页变体**还差第五样开关**，而 `even` 的开关不在 section 里、在 `settings.xml` |
| W10 目录 + 多级编号 | `docx_toc.py` | 目录是**域**，结果是缓存；编号有**两半**；两半都对之后**目录页自己占掉第 1 号** |
| W11 插图 / 换图 | `docx_image.py` | 尺寸是 **EMU**，一张图要写**两个**必须一致的尺寸，填错了不报错只是画错 |
| W16 CJK 字体巡检 | `docx_fonts.py` | 没有 `w:rFonts` **不等于**没有字体；覆盖已声明的值**一样过 D6** |

契约与实测数字 → gotchas §21.2 **㉝-㊲**。

#### 两个新夹具，以及它们靠「没有什么」来工作

`report.docx` 当不了这一族的输入：它**已经有**页眉、页脚、一张图和 `png` 的 Default，
拿它测「创建」会全程走「替换」，四样包裹工作一样都不会跑。所以新建：

- **`outline.docx`**（10 段，H1/H2/H3 层级）—— 关键在于它**没有**页眉页脚、
  **没有** `<Default Extension="png">`、**没有** `word/media/`。V0 为这三个「没有」各配了控制臂。
- **`fontless.docx`** —— `outline.docx` 去掉字体绑定，**三种形态且三种答案不同**：
  ① 完全没有 `w:rPr`，且样式和 `docDefaults` 都不说 → **只有这里** fallback 才诚实；
  ② 没有 `w:rPr`，但 `Heading2` 样式已经说了 `黑体` → 必须写**那个**值；
  ③ 有 `w:rFonts` 但只有 `@w:ascii`（`Times New Roman`）→ 只补缺的那一半。
  它是**输入**不是产物：D6 对它打红 **3 条**，一条一形态，而修复后的产物必须全绿 ——
  与 W15 的 `unordered.docx` 是同一个配对（**只验产物的修复，分不出「修好了」和「没牙了」**）。
- **`chart.png`**（240×120，`pHYs` 声明 150 dpi）—— 不是正方形（否则交换宽高看不出来），
  且声明的密度不是 96（否则「读文件」和「假设 96」给同一个答案）。

三个夹具都由 `make_fixtures.py` 逐字节可复现地生成，且**`report.docx` / `unordered.docx`
的字节一个都没变**（git 直接确认：两个文件未出现在 diff 里）。

#### 收工前抓到的那个缺陷，是渲染出来才看见的

W10 写完，结构检查全绿、XSD 全绿、L2 零 finding。**把产物转成 PDF 一看**：

```
1. 目录          <- 目录页拿走了第 1 号
2. 经营概况
2.1 收入分析
3. 风险提示
```

`TOCHeading` 按 Word 自己的惯例 `basedOn="Heading1"`，于是**继承**了刚给标题样式挂上的
多级编号。包里没有一处非法，D1–D7 一条都不会响。修法是 `<w:numId w:val="0"/>`
（ECMA-376 §17.9.18 留给「取消编号」的值）。**断言 G6 走结构**（basedOn 链能走到一个被编号
的样式、而自己没有取消），因为渲染断言要 LibreOffice、会被跳过 ——
但**那个数字是渲染量出来的，不是推出来的**。

⚠️ 同一次渲染还落实了另一件事：**LibreOffice 转 PDF 时不更新域**，缓存里写的 `—`
原样进了 PDF。这正是「页码不写」这个产品决定的依据 —— 如果当初缓存了编出来的页码，
它会一路进到用户看到的 PDF 里。

#### 门禁自己错了两次，都是我写的新断言

1. **G2 的 `--no-cache` 期望值本来就是错的。** 我写「cached entries 应为 0」，
   而 `--no-cache` 要写**一个** TOC 样式的段落来装域标记 ⇒ 在正确实现上判红。
   真正的判据是「没有一条条目带书签超链接」，不是「没有 TOC 样式的段落」。
   （**断言在正确实现上判红 = 我对被测对象的描述错了**，本任务第五次。）
2. **G4 在量 G1 的活。** 我给 G4 写了「超链接条数 == 标题数」，于是
   `toc-lists-only-the-top-level` 这条控制同时点亮 G1 和 G4 ——
   **完整性是 G1 的事，G4 只该管「链接指向的书签存不存在」**。删掉那条子断言后各归各位。
   （V0 那个「去量别人的活」的形状，这次出现在两条普通断言之间。）

另有一个**同名函数覆盖**：我把新控制命名为 `flaw_strict_writes_anyway`，
而 W5 的模板控制**已经叫这个名字** —— Python 静默重绑定，于是 T4 那一行跑的是我的 mutation、
点亮了 N5。矩阵里「T4 期望 T4、实际 N5」当场把它抓出来。
**这正是 flaw→fired 矩阵存在的理由：只看「控制都红了」是发现不了的。**

#### 「换角度提问」这次的三个问题

沿用前两刀的两个，再加一个新的。

| 问题 | 结果 |
|---|---|
| **team 协作模式下兼容吗** | **干净**。四个入口点在对抗形状下（400 个标题 / 400 个未绑定 run）stdout 152~2739 字节、**stderr 全 0**。㉙ 那道字节预算这次挡住了 |
| **打包到客户机器能工作吗** | **干净**。zip 里 docx 30 个文件、无 `__pycache__` 泄漏；解压到 `customer machine/未命名 目录/`（空格 + 中文）、cwd 设在 home，四个入口点全 exit 0 |
| **换成别人产的文档呢**（新） | **干净，但过程里我自己的检查方法错了一次** |

第三个问题值得单独记：这四个能力**只见过我自己手写的夹具**。拿 python-docx 产的文档跑，
方法是「对输入和产物各跑一遍 L2，差集就是我引入的」。结果 `t.docx` 报出 6 条「新」finding ——
**而总数与输入相同（7 条）**。真相是 D6 的消息里带着 **run 序号**，目录在它们前面插入了内容，
于是**同样的 6 条缺陷被重新编号，字符串比对就当成了新的**。
⇒ 按「消息文本」做 finding 差集是错的，要按**规则 + 主体**比。
（`docx_fonts.py --fix` 在这份外来文档上把 6 条 D6 全修掉，只剩 python-docx 自带的 `w:zoom` 那条。）

#### L0：又一次「同库同活」对照，结论和上一刀一致

参考语料里有 `styles_manager.py` 和 `numbering_manager.py`（与 `office/styles.py`、
`docx_toc.py` 的编号部分同一件事）。实测新增六个文件：

| 文件 | 文本 | AST | 最近邻 |
|---|---|---|---|
| `office/styles.py` | 0.004 | 0.104 | `styles_manager.py` / `optimize_images.py` |
| `docx_toc.py` | 0.004 | 0.147 | `qa_text.py` / `comment.py` |
| `docx_header.py` · `docx_image.py` · `docx_fonts.py` · `office/media.py` | 0.004~0.008 | 0.074~0.143 | 均不相干 |

78 个自写脚本 max 仍是 **0.191**（`pdf_form_inspect.py`），分离带 0.191 ~ 0.736，阈值 0.55 居中。

#### 门禁结果

`test-docx-skill.py` **131 passed / 0 failed**（**67 断言 / 130 控制**，原 46/84）·
L2 **65/0 零跳过** · capabilities 16/0 + `--no-pending pdf xlsx` OK、
**declared entry points 43/43**（原 39/39）、**33 个产物过 L2**（原 29）· pdf 53/0 · xlsx 71/0 ·
deckcraft 30/0 · 求值器 64/0 · L0 0.191~0.736 · check-docs 绿 · typecheck 8/8 · Rust 155 ·
desktop skills-builtin 16/16。`.builtin-version` → **`8223bdbd2bb8459a`**（两处对齐）。

**没有新建门禁脚本**，所以 CI 无需改动（`test-docx-skill.py` 第一刀就已进 CI）。
`--no-pending` **仍只列 `pdf xlsx`** —— docx 还有 5 项欠债。

#### 下一刀

生成族 **W4（Markdown → Word）/ W12（样式管理）/ W19（排版预设）** ·
**W14**（需先拍板 XSD 的分发方式）· **W18**（需先定义「什么算一处差异」）。

---

### 六·补六 — 第五刀：W12 + W4，以及这个分支第一次跑 CI 的六个发现（2026-08-03）

19 项里再落地 2 项，**共 16/19，3 项 pending（W14 / W18 / W19）**。
但这一刀真正的收获不在能力上 —— 在于**这个分支从来没有跑过 CI**，
开一个 draft PR 之后连跑六轮，抓到六个**本机一个都不可能发现**的缺陷。

#### CI 的触发条件本身是第一个发现

`ci.yml` 是 `push: [main]` + `pull_request: [main]`。**推一个特性分支不触发任何东西。**
所以「分支没 push 所以雷没响」这个本任务里已出现三次的形状，还有第四种变体：
**推了也没用**。要在不合入的前提下跑 CI，只能开 PR —— 草稿即可，
`pull_request` 触发器照样生效，而 GitHub 禁止合并 draft。

#### 六轮抓到的东西

| # | 现象 | 根因 | 本机为什么看不见 |
|---|---|---|---|
| 1 | Windows 上**每个技能入口点**都 exit 2 | 报告打中文到 stdout，而 Windows 捕获管道用 ANSI 代码页；Python 要 3.15 才默认 UTF-8（PEP 686），CI 用 3.11 | macOS/Linux 默认 UTF-8 |
| 2 | 同一个缺陷**在门禁脚本上还有第二个家** | 第一次只修了 `skills/`，`scripts/` 下九个门禁同样打 `✅` | 同上 |
| 3 | ubuntu 装了 **61 MB** Noto CJK 仍报「找不到字体」 | Noto Sans CJK 是 **CFF/PostScript 轮廓，reportlab 只能嵌 TrueType**（§21.1 ⑯ 早写着） | 本机有 Songti（TrueType） |
| 4 | 夹具在 Windows 上**不是同样的字节** | `ZipInfo.__init__` 在 Windows 设 `create_system=0`、Unix 设 `3`，该字节进 zip 中央目录 | 单平台跑永远一致 |
| 5 | deckcraft 门禁在 CI 上**从来跑不起来** | 真实语料 610 KB 被 `.gitignore` 排除 | 本机有那个文件 |
| 6 | desktop 测试套件**坏了两刀** | `vi.mock` 没导出 S3.5 新增的 `PIP_HINTS` | **门禁清单只让我跑一个文件** |

第 6 条的教训独立于内容：**门禁清单本身可以是盲区**。我照着任务书列的
`vitest run src/__tests__/lib/skills-builtin.test.ts` 跑了四刀，而 MEMORY 记的基线是
`desktop 858` —— 两个数字从来没对上过，也从来没人去对。

#### 修法里两条值得单独记

- **③ 的修法不是「再装一个字体」**，是先承认错误信息在说谎：装着 61 MB 中文字体的机器
  被告知「本机找不到中文字体」，会把人打发去装自己已经有的东西。新增
  `rejected_candidates()`，错误里点名「**找到了但用不了**（这些是 CFF 轮廓）」。
- **④ 顺带暴露 `xlsx` 夹具生成器有完全相同的缺口**（`date_time` / `compress_type` /
  `external_attr` 都设了，就是没设 `create_system`），而**它没有 F0 那样的断言，
  所以永远不会响** —— 比会响的那个危险。

#### 三平台都装 LibreOffice：原因不是求全，是方案 B 结构性做不到

§7 选的方案 B 是「只在 ubuntu 装」。CI 一跑就暴露它有个**结构性的洞**：
`--allow-missing soffice` 只放宽 **L2 的 tier 判定**，管不到 **L1 验收档会真跑每个能力的
sample** —— W17/X13 自己调 `soffice`，没有就 exit 2，于是 mac/Windows 必红。
升级为三平台都装之后，§7 那条「`find_soffice()` 的 macOS 与 Windows 分支至今没有任何
地方执行过」的欠账**当场销掉**（见 §7 该条的销账批注）。

#### 落地的两项能力

| 能力 | 脚本 | 契约（都在合法文档里看不见） |
|---|---|---|
| **W12 样式管理** | `docx_style.py` | 改一个样式**重绘用它的每一段**（要 `--overwrite`，并报出几段）· 删还在用的要 `--reassign`（否则 Word 静默退回 Normal）· `basedOn` 成环拒绝（Word 在环处停止解析、静默变 Normal）· 删除时子样式**重指向祖父** |
| **W4 从 Markdown 生成** | `docx_from_md.py` + `office/markdown.py` | **映射不了的构造带行号点名，绝不丢弃**（`--strict` 变拒绝）· `w:pStyle` 指向不存在的样式是**合法 XML 且静默按 Normal 排版**，所以用到的样式一律创建 · `--template` 保留样式/编号/页眉，只换正文 |

`office/markdown.py` 是自写解析器（技能只有 python3 + lxml + soffice，不引入新依赖）。
夹具 `sample.md` **刻意带三个映射不了的构造**（脚注 + 两处裸 HTML）——
一个只含受支持语法的夹具，会让「悄悄丢掉脚注」的生成器通过所有检查。

#### 这一刀自己踩的三个坑

1. **又一次写出 `el.find(a) or el.find(b)`** —— 第三刀记过的 lxml 真值陷阱，当场改掉。
2. **报告说 `properties_set: []` 而实际设了六个属性** —— `insert_ordered` 会把子元素
   REPARENT 走，统计放在合并之后就统计了个空壳。**文件是对的、报告是错的**，
   现在由 S3 钉住。
3. **`MD_PARAGRAPHS` 第一版取自错误的尺子** —— 我用 python-docx 量得 15，而门禁的
   `paragraph_texts()` 数所有 `<w:p>`（24，多出表格单元格里的 9 个）。
   **两个计数器都对，数的不是同一件事**；断言在正确产物上判红才发现。

#### C4 连着两次抓到新入口点没有探针

上一刀新加的编码断言写着「新入口点会免费继承这个缺陷」，这一刀它先后抓到
`docx_style.py` 和 `docx_from_md.py`。**这句话不是修辞。**

#### 门禁结果

CI **10/10 全绿**（run `30788968430`，含 Windows：`find_soffice()` 解析成功 ·
L2 65/0 · caps 16/0 · pdf 53/0 · xlsx 71/0 · docx 145/0 · deckcraft 22/0+9skip）。
本机：docx **155/0（79 断言 / 154 控制）** · L1 全量 `[capabilities] OK` · L2 65/0 ·
pdf 53/0 · xlsx 71/0 · deckcraft 30/0 · L0 0.191~0.736 · check-docs · desktop **862/102**。

#### 下一刀

**W19**（现已解锁 —— 它的 pending 理由原本写「等 W4」，已如实改写；缺的是「怎么判定
一个预设比另一个好」这个**可测量属性**）· **W14**（体量已量清：docx 闭包压缩后 55 KB、
+1.5%，许可见 §5·补.8b；等用户拍板）· **W18**（等「什么算一处差异」的定义）。

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

   **待办**：① **CI 装 LibreOffice —— 已升级为「必须现在决定」，方案与代价见下** ② ~~`BUILTIN_DEP_MAP` / Rust 探测加 `soffice`~~ ✅ **已做（2026-08-02，S3）**：`xlsx` 是第一个声明 soffice 的技能 ③ ~~本机装 LibreOffice~~ ✅ 已装（26.2.5.2）。

   #### ①的现状：不是「要不要更严」，是「CI 现在就是红的」（2026-08-02 实测）

   `acff11d7` 加的 `recalc-drift` 是一条**需要 LibreOffice 才点得亮**的负向控制。
   `selftest()` 内部恒用 `allow_missing=ALL_TIERS`，所以在没有 LO 的 runner 上它被**跳过**，
   而「必须打红」的用例没打红就是 **FAIL**。本机把 `SOFFICE` 置空复现：`59 passed, 1 failed`。
   分支没 push，所以这颗雷至今没响。

   **实测代价**（本机 macOS，LibreOffice 26.2.5.2）：

   | 项 | 数字 |
   |---|---|
   | L2 自检 **有** soffice | **116.2s** |
   | L2 自检 **无** soffice | **1.5s** |
   | ⇒ soffice 净成本 | **≈114s**（约 33 次转换 × 3.5s，每次都起独立 profile） |
   | L1 全跑（含 soffice） | 9.2s |
   | 当前 job 超时 | 15 min ×3 平台 |

   安装体积/耗时**未实测**（本机已装、CI 无法在此验证），按发行版包大小属数百 MB 量级。

   **三个选项**：

   | | 做法 | 得到 | 代价 |
   |---|---|---|---|
   | **A** | 三平台都装 LO | D7/X3 的成功路径与 `recalc-drift` 在三平台都真跑 | 每平台 +≈2min 运行 + 安装耗时；`apt`/`brew`/`choco` 三套安装步骤各自会坏 |
   | **B（推荐）** | **只在 ubuntu 装 `libreoffice-calc`**，mac/Windows 继续 `--allow-missing soffice` | `recalc-drift` 有一个平台真跑 ⇒ 雷拆了、控制有效；ubuntu 装 LO 最便宜 | **mac/Windows 上 soffice 路径仍未跑过**（`find_soffice()` 的这两条平台分支尤其）。必须在报告里点名，不能当成「三平台都验了」 |
   | **C** | 让缺 tier 时负向控制记 SKIP 而非 FAIL | CI 立刻绿，零成本 | **等于把 X3 的控制关掉** —— 而 X3 的期望值错了一个月，正是因为它一直是 SKIPPED。**这条是在重犯已经付过学费的错误，不建议** |

   ⚠️ **B 有一个诚实的洞**：S4 的 D7 是 docx→PDF，需要 Writer 而不只是 Calc；选 B 时
   ubuntu 要装 `libreoffice-calc` + `libreoffice-writer`（或整包），S4 开工前确认。

   **✅ 已实施 B（2026-08-02，用户拍板）**：ubuntu 装 `libreoffice-calc`，mac/Windows 继续
   `--allow-missing soffice xsd`（用 job 级 `ALLOW_MISSING` 按 `matrix.os` 计算）。

   **B 单独不够，必须配第二件事。** 实施后 mac/Windows 仍然红 —— `selftest()` 内部恒用
   宽松档，`recalc-drift` 这条**需要 LibreOffice 才点得亮**的负向控制在没装的机器上根本
   不可能 fire，于是「必须打红」失败。补法：**tier 不可用时该用例记 SKIP 并单列**，
   不计入 passed。这**不是**当初否掉的 C —— C 是所有平台都不跑，控制等于关掉；
   现在 ubuntu 在真跑它，另外两个平台只是诚实地说自己跑不了。

   双向实测：

   | 主机形态 | 结果 |
   |---|---|
   | 装了 LibreOffice（ubuntu） | `60 passed, 0 failed` · **0 条 SKIP** · X3 用例 **PASS（真的 fire 了）** |
   | 没装（mac/Windows） | `59 passed, 0 failed, 1 case skipped` · exit **0** · SKIP 行点名 tier 与原因 |

   **实测耗时**（本机，LibreOffice 在场）：六个步骤合计 **195s**，其中 L2 自检 116s ·
   L1 验收档 39s · L1 自检 12s · xlsx 行为测试 14s · pdf 行为测试 10s · 求值器标定 4s。
   加 apt 安装仍远在 15 分钟超时内。

   ⚠️ ~~**写下来的已知缺口**：`find_soffice()` 的 **macOS 与 Windows 分支至今没有任何地方
   执行过** —— 「三平台都绿」**不等于** soffice 路径在三平台可用。~~
   ✅ **已销账（2026-08-03，§六·补六）**：方案 B 升级为三平台都装 LibreOffice 之后，
   CI 上 Windows 报 `find_soffice() -> 'C:\Program Files\LibreOffice\program\soffice.exe'`、
   macOS 同样解析成功，两条分支第一次真的执行过。升级的**原因不是求全**，是方案 B
   结构性地做不到：`--allow-missing soffice` 只放宽 L2 的 tier 判定，管不到 **L1 验收档
   会真跑每个能力的 sample** —— W17/X13 自己调 `soffice`，没有就 exit 2。
   ⚠️ **S4 欠账**：D7 是 docx→PDF，需要 Writer，届时 ubuntu 要装
   `libreoffice-calc + libreoffice-writer`。
   ⚠️ **Windows 上必须 `shell: bash`**：默认 pwsh 下 `$ALLOW_MISSING` 会静默展开成空，
   等于把严格档偷偷打开、为一个不相干的原因判红。
2. ~~**`doc-edit` 是删是退化成路由页**~~ —— **2026-08-04 已决**：瘦身 + 改名 `pptx-edit`，只留 .pptx 就地读改（见 §六·补八 ②）。
3. ~~**`doc-export` 断链修复**~~ —— **2026-08-04 已修**（随 `doc-edit` 重写消失），并**顺带发现另外两处同类断链**（`pdf`/`xlsx` 的 description 都指着 `doc-edit`）。同刀把「断链扫描」做成常驻门禁 `check-docs.ts §11`，见 §六·补八。

---

## 附：本次调查用到的验证手法（可复用）

- **判定技能是否同源，不能看目录名和文件名**，要逐文件 `cmp`。本次 `docx` 一栏，qoderwork「同名脚本重合度很高」看起来像抄，实测 44/60 逐字节相同——**确实是抄**；而 mulerun `pptx` 同样"同名"，实测 0/55 相同——**是自写**。同名 ≠ 同源，两个方向都会误判。
- frontmatter 里残留的 `license: Proprietary` 是比 LICENSE.txt 更可靠的血缘指纹（改写者常删 LICENSE 文件但忘了改 frontmatter）。

---

## 六·补七 — S4 收官：W18 文档 diff + W19 表格预设（2026-08-03）

19 项里的最后 2 项。两项都不是「代码难」，是**判据难**——这也正是它们被排到最后的原因。
`capabilities.json` 的 `pending` 从此为空，CI 的 `--no-pending` 加上 `docx`，
**S4 完成的判据是那一行，不是「我觉得做完了」**。

### W19：先找到可测量属性，再写实现

pending 理由原文写的是「『表格更好看』不是门禁能检查的断言」。所以开工第一件事不是写代码，
是**实测标定**三件事：

| 属性 | 实测结果 | 用途 |
|---|---|---|
| `w:tblHeader` 跨页重复表头 | 带它 → 表头在第 1/2/3 页；不带 → 只在第 1 页 | **二值、渲染层可断言**（Q3） |
| 一个显示宽度单位需要多少 dxa | **中日韩字符正好 105**，拉丁 94~122 | 列宽常数取 **130**（实测最大值圆一档）（Q4/Q5） |
| `finance` 的竖线 | 渲染后竖线数 grid=5 / finance=1 | 证明显式 `none` 真的压住了 `w:tblStyle` 的边框 |

**刻意只做 3 种，不是 13 种。** 门禁 Q2 把三个预设的指纹**从产出的文件里读回来**逐对比较、
要求两两不同 —— 加第 4 种可以，但得先说出**什么能把它和这三种区分开**。
标定办法值得记：把每个字符串**单独成段**渲染（那样不可能折行）再从 PDF 量回 x 跨度，
而不是凭字号推算。

⚠️ **`header_bold` 本来在指纹里，被实测赶了出去**：`grid` 不动粗体，产出的表却报
`header_bold: true` —— 因为**夹具表头本来就是粗的**。
**预设决定不了的属性不能用来标识预设**，留着它会让两个预设因为谁都没造成的原因看起来不同。

### W18：难的是「什么才算一处差异」

两份 .docx 的 XML diff 一跑几百行且全是噪声（Word 每次保存重写 `w:rsid*`、重跑拼写检查、
重切 run）。定案：

- **一处差异 = 一个段落的可见文字变了**，外加白名单：段落增删移动 · 表格单元格文字 ·
  `pStyle` · 页眉页脚文字 · 图片增删换。
- `w:rsid*` · `proofErr` · `bookmarkStart/End` · `lang` · 空 run · 属性序 · zip 序
  **不算差异，但逐类报出计数**。门禁 U3 直接钉这一条：只差这些的 B **必须得出 0 处差异**，
  同时四类计数都得对得上 —— 「我看了并判断它不重要」和「我没看」是两回事，
  而只有前者可以被检查。
- 产物两个、**出自同一次比对**：JSON 摘要 + **redline docx**（复用 W6 的 `office/revision.py`）。

**闭环判据**：接受本次新加的修订 ⇒ 逐字等于 B；拒绝 ⇒ 逐字等于 A。
脚本写文件前先自验（`--strict` 不过就拒绝写出），**门禁 U2 在脚本之外再验一遍** ——
用出厂的 `docx_revise.py` 按报告给出的 `revision_ids` 解析，再用门禁自己的签名读取器读结果。
**只由作者自己验证的结论不算验证过。**

⚠️ **闭环必须限定在本次新加的修订 id 上**：`report.docx` 自带一条别人的修订，
`--reject-all` 把那条也拒掉是 W7 的正确行为、却不是这里要问的问题。第一版没做这个区分，
判红，**判得对**（这条 MEMORY 里早有记录，仍然又踩了一次）。

**`not_redlined` 是诚实出口**：找到了但表达不成跟踪修订的（表格增删行 · 图片增删换 ·
改动跨了 tab/换行）逐条点名并把 `exact` 置否。
**五处差异标了四处，比一处都不标更糟 —— 剩下那处看起来已经审过了。**

### 这一刀最值钱的产出：W18 的独立校验抓到一个出厂已久的真缺陷

`docx_revise.py` **只处理 `word/document.xml`**。页眉里的跟踪修订 `--accept-all` 会
**静默留下**，而 `remaining` 也只扫正文 ⇒ 它一边留着修订、一边报告「没有剩余」。

**发现它的不是任何针对 W7 的断言**，是 W18 的闭环校验在**别的能力**上跑出来的：
`docx_diff.py` 自己的检查走全部 text part，而门禁用出厂的 `docx_revise.py` 复验，
两者对不上 —— 而对不上的那一方是出厂代码。
修法：`docxcommon.text_parts()` 统一「哪些 part 有正文」，**读与解析覆盖全部、写仍 opt-in**。
契约 → gotchas §21.2 ㊳。

### 本轮自己踩的六个坑（全部由门禁抓出）

1. **负向控制只改了「门禁读到的文件事实」而没改「脚本报告的事实」** ⇒ 凭空制造出一个真实缺陷
   不会产生的「报告与文件不一致」，Q2 为了与被测缺陷无关的理由变红。
   **控制臂必须复刻那个真实的错误实现**，不是随便一种破坏。
2. **非空的 cascade 注释会屏蔽掉全部意外触发的检查，不只是它提到的那个。**
   `two-presets-are-the-same-table` 声明 `{Q2,Q7}`、实际点亮 `Q1,Q2,Q4,Q7`，运行结果照样 PASS。
   ⇒ 如实声明四条，不要靠注释兜。**这是门禁自身的一个通用陷阱，不限于本刀。**
3. **探针字符串是文档标题的子串**：第一版用 `二零二六年第三季度经营分析`，
   它是标题 `…分析报告` 的前缀 ⇒「单元格文字在一行内完整」这条**在两种实现下都成立**。
   现由 V0 断言每个探针在被渲染的文档里**恰好出现一次**。（同一形状的第三次：`毛利` / `+1.2pt`。）
4. **V0 用集合差判断「段落被删除」** —— 集合差把「文字被改过的段落」同时算进「删掉的」
   和「新增的」，**分不出编辑和删除**。改成成员判定。
5. **V0 第一版拿 `report.docx` 的段落去查探针唯一性，而 Q5 渲染的是改过表格的那份文档** ——
   量错了文档；`+1.2pt` 在原表里有、在被测文档里没有。
6. `header_bold` 进指纹（见上）。

### 门禁基线（2026-08-03 本机实测）

docx **203/0（98 断言 / 202 控制）** · pdf 53/0 · xlsx 71/0 · deckcraft 30/0 ·
L2 **65/0** 零跳过 · caps selftest 16/0 · L1 全量 **48/48 entry points** ·
**`--no-pending pdf xlsx docx` OK** · 求值器 64/0 · L0 **0.191~0.736**（阈值 0.55，
provenance 6 条豁免逐条打印）· check-docs · typecheck 8/8 · Rust 155 ·
desktop **862 / 102 files** · `.builtin-version` → `5354efd710bcd307`。

### 六·补七之后的收工复审（2026-08-03，用户五问）

**又抓到一个门禁没抓到的真回归，而且是我这一刀自己引入的。**
`docx_revise.py` 的 `report["resolved"]` 有了**两种形状**：只有正文带修订时是 `rev.apply()`
的结果（`mode`/`applied`/`remaining`/…），正文+页眉都带时变成 `{parts, count}` ——
后者把 `mode`/`applied`/`remaining` 全丢了。**形状取决于「页眉里碰巧有没有修订」**，
读 `resolved.applied` 的调用方会在某些文档上 KeyError，而且是在最不常见的文档上、不在测试里。

K1-K6 没抓到，因为它们用的 `report.docx` 只有正文修订；W18 的 U2 只看解析后的文档、不看报告形状。
⇒ 修法是**永远一种形状**（原字段全保留 + 增 `parts` + 每条 `applied` 带 `part`，对老调用方是超集），
补断言 **K7**（一种形状 + 多 part 情形必须真的被覆盖）+ 两条控制。

**这条的通用形状值得记：一个字段的形状由数据决定，就是一个迟早所有调用方都会踩的坑。**

复审其余各项实测结论（均无缺陷）：

| 问 | 办法 | 结论 |
|---|---|---|
| 跨平台 | 扫 `os.environ['HOME']`/`/tmp`/unix-only 命令/PATH 分隔符 | 零命中；`soffice` 走 `shutil.which` + `platform.system()` 三分支 + `Path.home()` |
| 打包到客户机 | 扫硬编码绝对路径；解压到含空格/中文的陌生路径 + cwd 设在别处跑 | 零命中；schema 走 `Path(__file__).resolve().parent.parent`，可用 |
| Team 模式 | 18 个入口点跑一份 600 段 + 400 行表的大文档，量 stdout 字节 | 最大 **2,435** 字节（预算 6,000），stderr 全 0 |
| 对抗性输入 | 空 body / 无 sectPr / 无 styles.xml / 非法 XML / 非 zip / 0 字节 / 目录 | **无一处 traceback**，一律 exit 2 给一句话 |
| 别扭路径 | 中文 + 空格 + 深层目录 | 全通 |
| W15 回归面（新加三张元素序表） | LibreOffice 产的文档 `--check`；打乱 `tblBorders` 后 XSD/`--check`/`--fix-order` | 0 误报；打乱后 XSD 判非法且 `--check` 点名到具体路径；`--fix-order` 修回 XSD valid |

⚠️ 复审过程中我自己的探针错了两次（读 `out_of_order` 而字段叫 `findings`；拿被 LibreOffice
同名覆写的文件当原件）——**两次都是「判红的是我的描述，不是被测对象」**。

---

## 六·补八 — S6 收官：路由收敛 + 断链扫描进门禁（2026-08-04）

S5（L3 真实语料回归 + L4 人工验收）需要用户提供语料，用户选择先做 S6。本节是 S6 的落地记录。

### 做了什么

| # | 项 | 落地 |
|---|---|---|
| ① | `markdown-exporter` 的 DOCX 路由 | 指向 `docx` 技能。**这一格等到现在才翻是对的**——W4（`docx_from_md.py`）落地前指过去就是「指向一个做不到这件事的技能」，与 §1 的 `doc-export` 断链同一类。改 `fetch-builtin-skills.ts` 的 `EXPORTER_DESCRIPTION` patch 常量**和**落地文件两处（只改文件的话下次 fetch 静默还原），并写了脚本核对两者逐字节相同 |
| ② | `doc-edit` 去留 | **瘦身 + 改名 `pptx-edit`**（用户 2026-08-04 拍板）。六个脚本里 `docx_*`/`xlsx_*` 四个已被 059 S3/S4 的专用技能整体超越，删除；`pptx_read/pptx_edit` **没有任何替代**（deckcraft 只做「生成新 deck」，`ppt-master` 自 ADR-061 起不再内置）故保留。SKILL.md 重写 |
| ③ | `doc-export` 断链 | 随 ② 消失（三处都在被重写的 `doc-edit/SKILL.md` 里）。**顺带发现另外两处同类断链**：`pdf/SKILL.md` 与 `xlsx/SKILL.md` 的 description 都写着「that is `doc-edit`」，改名后会当场变断链，且它们本来就该指 `docx`/`xlsx` |
| ④ | deckcraft 路由边界 | 只改 description + 路由表（ADR-061 血泪教训：主体不动）。分界写成一句可执行的话：**按产出物判，不按源判**，并把三条新边界进表 |
| ⑤ | 依赖声明三处同步 | `x-requires` / `BUILTIN_DEP_MAP` / `PY_MODULES` + 测试断言。`pptx-edit` 现在声明 `python-pptx`——见下 |
| ⑥ | **断链扫描进门禁** | `check-docs.ts` §11 + `--selftest`（11 条正负控制），CI docs job 两条都跑 |

### 一个必须点名的诚实边界

**改的是 description，而 description 是模型路由的唯一依据——没有任何门禁能验「模型会不会选对技能」。**
那是 L4 类的主观验收，本刀不声称做到了。能机器验的只有三件，也只验了这三件：
断链不再指向不存在的技能（新门禁）· 依赖三处声明一致（测试）· 打包 hash 对齐。

### 断链扫描：设计与它自己踩的坑

任务书原话是「扫所有 SKILL.md 里形如 `xxx` 技能 的引用」。实现时发现要认四种写法才够用——
`doc-export` 那次是「改用 \`doc-export\` 技能」和 "use the \`doc-export\` skill"，
而本刀这次是 "that is \`doc-edit\`"（description 里的句式，不带「技能」二字）。

**第一版就误报了一次，而且误报的形状值得记下来**：中文引导词「改用」单独用不成立——
deckcraft 的跨平台启动器说明写着「就改用 \`python\`」，指的是命令名。修法不是加黑名单，
是**给中文引导词加一道闸：同一行必须出现「技能」二字**。这不会漏掉真缺陷，因为
`doc-export` 那三处原文本来就带「技能」。英文的 `that is` / `use the` / `install` 句式
不需要这道闸（实测全树零误报），token 再收紧成 `^[a-z][a-z0-9-]*$` 就挡掉了
skill-creator 里的 `package_skill.py` / `eval_metadata.json` / `present_files`。

**合法目标有两类**：`skills/builtin/` 下真实存在的目录，**加上**设置页 `INSTALLABLE_SKILLS`
里的 curated 技能——`ppt-master` 不内置但路由到它是对的。这份名单从 `Settings.tsx` 现读，
不在门禁里另抄一份。

**负向控制的两个层次**（缺一不可，本刀两个都做了）：
- `--selftest`（常驻，11 条）：六条负向**复刻的是真实出过的错误写法**，不是随便一种破坏；
  四条正向复刻的是**已经误报过一次的那些行**。
- 端到端注入（一次性）：往真 `pdf/SKILL.md` 里加一句「改用 \`doc-export\` 技能」，
  全量扫描必须打红并点名 —— **这一步不能省**，`--selftest` 只证明匹配器对，
  证明不了「全量扫描真的遍历到了文件」（空遍历长得和通过一模一样，S3.5 栽过一次）。
  改完逐字节还原并复验 sha256。

⚠️ **第二个控制臂第一版是假的**：我把 `const INSTALLABLE_SKILLS` 改名成 `..._RENAMED`
想制造「解析失败」，结果门禁照样绿——因为正则是**前缀匹配**，改名后仍然命中。
换成真实会发生的漂移（条目字段引号风格变化）才打红。**顺带把正则加了 `\b`**，
否则「名单被改名成了别的东西」这种漂移会被静默当成解析成功。
——又一次印证：**控制臂分不出两种实现，就不是控制臂**。

### `pptx-edit` 的限制是实测出来的，不是抄的

写 SKILL.md 的「限制」一节前，先拿它自己的两个脚本量了一遍（合成夹具：文本框 + 表格 +
被切成两个 run 的短语）。三条实测结果，全部写进 SKILL.md 与脚本 docstring：

| 现象 | 实测 |
|---|---|
| 表格单元格里的文字 | `pptx_read.py` **读不出**，`--replace` **也改不到**（两个脚本都只遍历顶层 shape 且只处理 `has_text_frame`，而表格是 GraphicFrame、组合是 GroupShape） |
| 组合形状里的文字 | 同上，一个只含组合形状的页面读出来是空的 |
| 跨 run 的短语 | `毛利率保持稳定` 被切成 `毛利` + `率保持稳定` 时，`--replace 毛利率` 匹配数 **0** |
| ⚠️ 漏替换的可见性 | 它打印 `replacements: 1` 而文件里另有一处同样的文字原样留着——**漏替换是静默的** |

**这四条都是既有行为，本刀有意不修**（S6 是收尾，不是新实现）。但它们从「没人说过」变成
「写在 SKILL.md 里、模型看得见」。⚠️ 最后一条是真缺陷，已进 Pending Issues：
`replacements: N` 只数改掉的，不报「还有几处我看不见」。

顺带：`pptx-edit` 的 `BUILTIN_DEP_MAP` 从 `["python3"]` 改成 `["python3","python-pptx"]`。
作为 `doc-edit` 时只声明 python3 是**当时说得通的**——六个脚本里四个跑在 python-docx/
openpyxl 上，缺 python-pptx 仍能用四个。那四个走了之后这个前提就没了：
一台没有 python-pptx 的机器**一个脚本都跑不了**，却会显示「就绪」。

### 门禁（全部本机实测，2026-08-04）

docx **205/0**（99 断言）· pdf **53/0** · xlsx **71/0** · deckcraft **30/0** ·
L2 **65/0 零跳过** · capabilities selftest **16/0** · L1 全量 **48/48**（37 产物过 L2）·
`--no-pending pdf xlsx docx` OK · 求值器 **64/0** · L0 分离带 **0.191~0.736**（阈值 0.55，
负样本从 84 个 .py 变 80 个但最大值与最近邻文件对**未变**）· provenance 6 条豁免逐条打印 ·
check-docs 绿 + **§11 自检 10/10** · typecheck **8/8** · Rust **155** ·
desktop **863 / 102 files**（+1 = 新增的 pptx-edit 依赖断言）。

### 明确没做

- **S5 未做**：L3 真实语料回归需要用户提供语料（docx ≥20 / xlsx ≥15 / pdf ≥15），L4 是人工验收。
- **`command-menu.test.ts` / `command-selector.test.tsx` 里的 `doc-edit` 字样保留**：那是菜单渲染逻辑的
  合成夹具（任意命令名 + 任意描述），不是技能注册表的断言。改它会动到一个已知间歇性红的文件的
  排序期望，收益为零。
- **`xlsx_write.py` / `make_fixtures.py` 注释里的「the old doc-edit skill」保留**：那是历史陈述，仍然成立。

### 收工复审：三问抓到两个门禁抓不到的真崩溃（2026-08-04）

按既定的三个提问角度做，**每一问都问出了东西**：

| 问 | 办法 | 结果 |
|---|---|---|
| **打包到客户机器能工作吗** | 从真 zip 解压到 `…/客户机 测试/`（含中文+空格），cwd 设在 `$HOME` 跑读与改 | ✅ 全过；零硬编码路径；缺 python-pptx 时 stderr 一句话 + exit 1 |
| **team 协作模式下兼容吗** | 量 `pptx_read.py` 的 stdout 字节 | ⚠️ **没有上限**：10 页 5.2 KB · 20 页 10.5 KB · **60 页 87,227 字节**（其它三个技能的预算是 6,000） |
| **换成别人产的文档呢** | deckcraft 的可编辑 pptx（pptxgenjs）· 图片型 pptx · LibreOffice 重存 · 一份最小化生成器产的 pptx | ❌ **最后一种让两个脚本都抛裸 traceback** |

**两个真崩溃（都已修，都进了新门禁）**：一份没有 `slideLayout` 关系、也没有 `slideMaster`
的 `.pptx`（最小化 OOXML 生成器会产，PowerPoint 不会）——
`pptx_read.py` 在 `slide.slide_layout.name` 抛 **KeyError**；
`pptx_edit.py --add-slide` 更讽刺，**是它自己的边界检查崩的**：`len(prs.slide_layouts)`
要穿过 `slide_masters[0]`，于是 `IndexError`。修法：版式名读不到就记 `(no layout)`
**正文照读**（版式名是装饰，不该让整份文档读不出来）· 加母版失败给一句话 exit 1。

**stdout 那条有意不修**：加上限需要设计一套与另外三个技能一致的裁剪契约（S4 的 C3 是
按字节裁的），那是实现工作不是收尾工作。**已写进 SKILL.md 的「限制」并进 Pending Issues** ——
写下来的、模型看得见的限制，和没人说过的缺陷，是两回事。

### 新门禁 `scripts/test-pptx-edit-skill.py`（9/0，10 断言，同刀进 CI）

**为什么非要有**：S6 把四条限制当作实测事实写进了 SKILL.md。**一条没人检查的 SKILL.md
声明是会腐烂的声明** —— 哪天有人教会 `pptx_read.py` 走表格，SKILL.md 就开始往反方向撒谎。
所以四条限制在这里是**双向断言**：现在成立要绿，将来不成立也要红（红了就得去改 SKILL.md，
而不是让它默默失真）。另一半守两个崩溃修复。

**四条 LIVE 控制不是编造的输出，是把修复原样撤回** —— 即复刻 2026-08-04 之前真正发货的那个
实现。`patched()` 在锚点命中次数不等于 1 时**直接 SystemExit**：一个没贴上去的控制臂，
和一个贴上去但什么都没测出来的控制臂，从外面看一模一样。

⚠️ **两条控制的 cascade 我第一版声明少了，harness 当场判红**（这正是「非空 cascade 注释会
屏蔽掉全部意外触发的检查」那条教训要防的形状）：`--out 被忽略` 还会点亮 L4/W1（产物压根没写出来，
凡是读那个产物的断言都没得读）· `无版式夹具其实有版式` 还会点亮 X2（有母版时 `--add-slide`
**理应成功**，而那正是 X2 盯的分支）。**如实声明，不靠注释兜。**
顺带修掉一处顺序耦合：每次编辑改用**各自独立的输入副本**，否则「忽略 --out」的控制臂会就地
改坏共享夹具，让后面每条断言都在读被上一条改过的文档。

⚠️ **测量过程中我自己错了一次，第三次犯同一个错**：对抗性输入矩阵里 `pptx_edit` 那一列
全是 `unrecognized arguments`，我差点当成被测对象的属性 —— 真因是 **zsh 不对未加引号的变量分词**，
`$args` 被当成一个参数整体传了进去。**判红的是我的测量，不是被测对象。**

### CI 第一跑就抓到第三个真缺陷：Windows 上这个技能根本没法用（2026-08-04）

`0a5b0987` push 后 CI **10 个 job 里 9 绿 1 红**，红的是 `office skills (windows-latest)`
的 `pptx-edit skill behaviour tests` —— **新门禁上 CI 的第一次运行就判红，判得对**。

症状：干净臂里 V0 报「读正常 deck 读出来是空的」+ X1 报「裸 traceback」。
根因**不是测试问题，是产品缺陷**：`pptx_read.py` / `pptx_edit.py` **一处 UTF-8
reconfigure 都没有**。Windows 把**被捕获的** stdout 按机器的 ANSI 代码页编码，
而 Python 要到 3.15（PEP 686）才默认 UTF-8、CI 钉的是 3.11 ⇒
**打印第一个中文字就 `UnicodeEncodeError` 退出 1**。而 agent 调脚本**总是捕获 stdout**，
所以在 Windows 上「读一份有中文的 PPT」这件事**从来就没成功过**。

本机用 `PYTHONIOENCODING=cp1252` 精确复现（不是照 CI 日志猜）：
`pptx_read.py` exit=1 / stdout 29 字节 / `UnicodeEncodeError: 'charmap' codec can't
encode character '第'`；同条件下有防线的 `docx` 技能 exit=0 / stdout 4170 字节。

**为什么它能活这么久**：`docx`/`xlsx`/`pdf`/`deckcraft` 各在**共享模块**里放了这两行，
而 `pptx-edit` 没有共享模块（就两个脚本）；更关键的是**它从 `doc-edit` 时代起就没有任何
门禁覆盖过** —— 这个洞不是本刀引入的，是本刀第一次让它可见。

修法：两个入口点各自带上那两行。断言 **C1** 钉住，配 LIVE 控制
「把 reconfigure 撤掉」（= 2026-08-04 前真正发货的实现）。
⚠️ **这条控制是「控制臂必须分得出两种实现」的最锋利例子**：在一台 UTF-8 机器上，
带防线和不带防线的脚本**行为逐字节相同** —— 只有强制 ANSI 代码页那一下能把它们分开。
用 `PYTHONIOENCODING` 复现，也让这条断言在 macOS/Linux 上**同样能红**，
而不是继续只有 Windows CI 才看得见。

**这一条给「门禁全绿 ≠ 没缺陷」补了个新形状**：前面记的三问是「换角度提问」，
这条是**换机器**。本机三平台兼容性扫描（零 `HOME`/`/tmp`/unix-only 命令）**全过**，
因为它扫的是路径与命令，而这个缺陷在**编码**上。标尺 → **10/0（11 断言）**。

**修完之后 CI 又红了一次，这次红的是我的控制臂而不是产品**：`bc5f17e7` 上 Windows 后，
干净臂通过了（产品修复生效），但 `LIVE: 撤掉 UTF-8 防线` 那条**多点亮了 V0 和 X1**。
原因是**这条控制的正确 cascade 依赖平台**：在 UTF-8 宿主上，带不带防线行为完全相同，
只有强制 ANSI 那一下（C1）分得出；而在**默认捕获编码就是 ANSI 的宿主（Windows）上，
撤掉防线会让脚本的每一次运行都崩**，所以 V0/X1 本来就该跟着亮 —— 那是真实的 Windows
缺陷，不是需要被注释解释掉的 cascade。

修法不是放宽期望集，是**把它从实测量出来**：`default_captured_encoding()` 起一个子进程
问 `sys.stdout.encoding`，据此选 `{C1}` 还是 `{C1,V0,X1}`，并把量到的编码**打印在结果行里**。
⚠️ **然后我把两个分支都在本机跑过了**（`PYTHONIOENCODING=cp1252` 让整套门禁进入 Windows
那个条件）：utf-8 宿主 10/0，cp1252 宿主 10/0 —— **不留「从未执行过的平台分支」**，
那是这个仓库反复付过学费的形状。

**同一跑里 `node (ubuntu-latest)` 也红了，但那是已知 flake，不是本刀**：
失败的是 `command-selector.test.tsx > D: Enter still picks the highlighted command`。
证据不是记忆：本刀两个 commit **一个相关文件都没碰**（`git show --name-only` 核对），
而上一跑同一 job 同样的代码是绿的。

**第三跑全绿（run 30883555929，sha `7db1c1da`，10/10）**。并且核实了「绿」不是沉默：
三平台各自打印出自己量到的编码 —— **Windows `cp1252` / ubuntu `utf-8` / macOS `utf-8`**，
即那条平台相关的 cascade 在 CI 上**两个分支都真的执行过**，不是有一条被跳过。
第二跑里那条 `node (ubuntu-latest)` 的 flake 这一跑**没有复现**（与记录的间歇性一致）。

---

## 六·补九 — S5 收官：L3 真实语料回归（2026-08-04）

**这一刀的判据是它抓到了什么，不是它跑绿了。** 231 份别人产的文档过一遍
read → edit → validate 环，抓到**三个真缺陷**，一个都不是手编夹具能碰到的。

### 语料怎么来的：清单进 git，字节不进 git（用户 2026-08-04 拍板）

`scripts/l3-corpus-manifest.json` 记 repo + 钉死的 commit + 相对路径 + sha256 + 许可；
`scripts/fetch-l3-corpus.py` 按清单 blobless sparse clone 到缓存目录
（`~/.cache/ultrawork/l3-corpus/`，`ULTRAWORK_L3_CORPUS` 可覆盖），逐件校 sha256。
两条理由：① 用户手上真实的中文办公文档多半是业务文件，而这棵树会被构建、签名、分发出去、
git 历史永久，机制必须**从第一天**就支持「本地语料，永不入 git」（`<缓存根>/local/{docx,xlsx,pdf}/`，
门禁单列统计并标明「这部分不进 CI」）；② 第三方 PDF 的单件出处不因仓库 LICENSE 是 MIT
就自动干净，**不进源码树 = 这个问题不存在**；③ 20MB 与构建无关的二进制不该进版本库。
⚠️ **纠正**：我最初把第一条理由写成「本仓库是 public」，写的时候**实测是 private**
（2026-08-04 用户随后改成了 public，所以这条理由**现在成立、当时不成立**）。
决定从头到尾不变 —— 它站在上面那三条上，不站在可见性上。这个错在 commit `5ca3d38d`
的 message 里也在，无法追改，记在这里。代价是网络依赖 ⇒ CI 传 `--require-corpus`
把「语料缺失」从跳过变成红。

| 源 | 许可（**读正文核过**） | 取用 | 为什么是它 |
|---|---|---|---|
| `python-openxml/python-docx` `tests/test_files` + `features/steps/test_files` | MIT | 45 份 docx | 大多带 Word 的 `docProps`，是 §5「D4/D5 从未跑过真正由 Word 保存的文档」点名的空白 |
| `tafia/calamine` `tests` | MIT | 65 份 xlsx | 用户报 bug 时贴上来的野生文件，边界最脏 |
| `jmcnamara/XlsxWriter` `.../comparison/xlsx_files` | BSD-2 | 40 份（1000 份按 stride 25 确定性抽样） | Excel 存的对照件 |
| `jsvine/pdfplumber` `tests/pdfs` | MIT | 81 份 pdf | 真实抓来的版面 + ClusterFuzz 畸形样本 |

**明确不收**（写下来免得下次又查一遍）：`py-pdf/sample-files`（**CC-BY-SA-4.0**，share-alike，
与「签名分发的商业软件」这个前提不该沾）· `py-pdf/pypdf` 的 `resources/`（仓库 NOASSERTION、
目录内无 LICENSE，单件出处不明）· `openpyxl`（**不在 GitHub**，在 heptapod；且 sdist 186 KB
**不含测试数据** —— 原计划里的两个源实测都得换掉）。

⚠️ 许可判定**读的是 LICENSE 正文**，不是 gotchas §10 那个字节数捷径：XlsxWriter 的
`LICENSE.txt` 是 **1349 B**，离「1467 B ≈ Anthropic 专有」很近，只看大小会吓一跳。

### 语料刻画（下任何结论之前先看这张表）

| docx 45 份 | | xlsx 105 份 | | pdf 81 份 | |
|---|---|---|---|---|---|
| 表格 | 13 (29%) | `<Application>` 声明 Excel | 84 (80%) | 含旋转页 | 30 (37%) |
| 页眉/页脚 | 6 (13%) | 图表 | 19 (18%) | 无文字层(≈扫描件) | 18 (22%) |
| 多级编号 | 3 (7%) | 合并单元格 | 6 (6%) | 含 CJK | 8 (10%) |
| 超链接 | 3 (7%) | 跨表公式 | 2 (2%) | AcroForm 表单 | 4 (5%) |
| 批注 | **1 (2%)** | 正文含 CJK | **1 (1%)** | 加密 | 2 (2%) |
| **跟踪修订** | **0** | 条件格式 / 透视表 | 各 1 | 文件头不是 %PDF | 5 (6%) |
| **正文含 CJK** | **0** | >1 万行 | 1 | | |

**这张表的用处是划清没验到什么**：公开 fixtures 在**修订 / 批注 / 中文混排**三格上基本是空的。
「45 份 docx 全过」**不等于**「45 份带修订的中文 Word 全过」。这三格只能等用户给真实文档。

⚠️ 顺带纠正一句我自己差点写进结论的话：**`docProps/app.xml` 的 `<Application>` 只说明
原始文档是谁存的，不证明这份 XML 没被手工改过**。三份被判 schema 违规的 docx 都写着
`Microsoft Word`，而它们的 `<w:tbl>` 缺必需的 `<w:tblPr>` —— Word 不会那么写，是 fixture
被裁过。所以表里那格写的是「`<Application>` 声明 Excel」，不是「Excel 亲手存的」。

### 判据怎么量（三个数分开记，不合并成一个「通过率」）

- **崩溃** = stderr 出现**裸 traceback**，或被信号打死 / 超时。**与退出码约定无关。**
- **拒绝** = 非 0 退出但没有裸 traceback。加密件 / 损坏件 / 不支持格式的**正确行为**。
- **损坏** = 输入过了合法性检查、环跑完（每步 rc=0），但输出没过。「没过」的定义直接
  **import L2** 复用（`office-skills-selftest.py` 的 D1/D4/D5 · X1/X2 · F1/F2/F3/P5），
  不是第二套标准 —— 否则 L2 绿而 L3 红时没人说得清哪个对。
- **输入门控只做结构性判断**（能否当 zip 打开 / 必需 part 在不在 / XML 良构；pdf 用
  **pdfminer** 判），**刻意不用被测技能站着的那个库**。输入自带的 L2 违规不扣分母，
  只屏蔽那一条检查对输出的判定。

**基线**：docx/xlsx 从 git 取 `0a5b0987^` 的旧 `doc-edit` 脚本到临时目录（**绝不落回工作树**），
跑同一份语料同一个环，两臂完整命令行逐条打印。**pdf 没有前身**（S2 之前是零脚本的上游
Apache 版）⇒ 它没有基线，判据只能是绝对值。这一点不编。

### 结果（本机实测，231 份，4 分 18 秒，8 并行）

| 臂 | 类型 | 总数 | 输入坏 | 可用 | 崩溃 | 拒绝 | 损坏 | 崩溃率 | 损坏率 |
|---|---|---|---|---|---|---|---|---|---|
| new | docx | 45 | 0 | 45 | 0 | 0 | 0 | 0.0% | 0.0% |
| new | xlsx | 105 | 4 | 101 | 1 | 4 | 0 | 1.0% | 0.0% |
| new | pdf | 81 | 8 | 73 | **1**（已具名认领） | 14 | 0 | 1.4% | 0.0% |
| baseline | docx | 45 | 0 | 45 | 0 | 0 | 0 | 0.0% | 0.0% |
| baseline | xlsx | 105 | 4 | 101 | 4 | 4 | **62** | 4.0% | **66.7%** |
| baseline | pdf | — | — | — | — | — | — | 无前身 | 无前身 |

**xlsx 那一行就是「更优」的全部证据，而且是数字不是形容词**：旧的 `load→save` 在真实文件上
丢 `sharedStrings` / `calcChain` / `media/image1.jpg`(20 KB) / `printerSettings*.bin` /
`richData` 的 rels —— 93 份里 62 份丢东西。外科式写入 0 份。
**docx 两臂都是 0/0**：这批公开夹具对 python-docx 太温和，L3 在 docx 上**没有区分力**，
不要拿它当「docx 也更优」的证据。

### 抓到的三个真缺陷（全部当刀修掉 + 配控制臂）

**① `pdf_info.py`：`/Producer` 是间接引用时整个入口崩掉。** 真实 PDF 可以把元数据值存成
`12 0 R`，pypdf 返回 `IndirectObject`，`json.dumps` 抛 `TypeError: Object of type
IndirectObject is not JSON serializable` —— **裸 traceback，而且是 agent 对一份文档跑的
第一条命令**。命中 3 份真实文档（两份美国 NICS 背景调查统计、一份学区预算）。
本仓库所有手编夹具都把元数据写成字面量，所以一次都没碰到。修法 = `_json_safe()`
（有界地解引用 + 非 JSON 原生类型转字符串）。

**② `pdfcommon.run()`：护栏装错了位置 —— pypdf 是惰性解析的。**
`open_reader()` 只在 `PdfReader(...)` **构造时**兜 `PdfReadError`，而 pypdf 对一份页面树是
瓦砾的文件**构造照样成功**，真正的异常等走 `reader.pages` / 对象树时才炸。9 份真实/畸形
PDF 因此以一墙 Python 落地。修法 = `run()` 增加 `_is_pypdf_error(e)` 分支，把 pypdf 自己的
异常族（`PyPdfError` + `DependencyError` + `DeprecationError`）落成一句话 + exit 2。
**这个文件自己的 docstring 早就预言了它**（"a library that raises where we did not expect
it … otherwise reaches the caller as a wall of Python"）—— 语料做的事是把预言变成计数。
⇒ pdf 崩溃 **12 → 1**。

**③ `xlsx_read.py`：145 KB 的文件跑十分钟不返回，而且把 2 行的表报成 1048576 行。**
`MAX_SCAN_CELLS` 这个护栏只装在 `read_range()` 上，**默认路径 `sheet_inventory()` 完全无界**，
而且它把整表**走两遍**。calamine issue 语料里有一份 workbook 在**最大行号上真的有一个
单元格**（`<row r="1048576">`），openpyxl 于是给出 max_row = 1048576，乘以列数就是千万级。
修法 = 单遍 + 独立的 `MAX_INVENTORY_CELLS = 2_000_000` 预算 + **超预算必须打印
`scan_truncated`**（一个看起来像完整结果的截断结果是这里最不能有的），并且
`rows`/`columns` 改成**从实际有值的单元格数出来**。实测 >10 min → **3.2s**，报 2 行。
**同一个形状第二次**：①③ 都是「护栏存在，但装在没人走的那条路上」。

**残余 1 份崩溃，具名认领而不是豁免**（`KNOWN_CRASHES`，每次运行都打印，名单变长会在 diff 里
显形）：`5317294594523136.pdf` 的 `/Root` 指向一个 `NumberObject`，**pypdf 上游**在
`_reader.py:229` 抛 `AttributeError` 而不是它自己的 `PdfReadError`，落不进②那条分支。
把 catch-all 放宽到 `AttributeError` 会把我们自己未来的 bug 一起藏起来，不划算。
该文件是 ClusterFuzz 生成的畸形样本。

### 门禁自己的 25 条正负控制（`--selftest`）

C1 正样本 · C2 崩溃探测器真会响 · C3 exit 2 不算崩溃 · C4 输入门 · C5 丢一个非惰性 part →
F1 打红 · C6 元素序违规 → D 系打红 · C7 空语料判红 · C8 语料量不足判红 · C9 基线臂与新臂
可区分（旧的用 python-docx、新的不用）· C10 崩溃规则与退出码约定无关 · C11 契约违规单记 ·
C12 两臂写同一张表 · C13/C14 xlsx/pdf 环真的能跑 · C15 CJK 只数正文 · C16 探针含中文 ·
C17 超时被抓成崩溃 · C18 「门禁判不了」≠「技能弄坏了」· C19 输入门与被测实现无关 ·
C20 输入自带违规被屏蔽 · C21/C22 本刀两个 pdf 缺陷 · C23 每步允许的退出码 ·
C24 输入不合 schema 时输出同样不算拒绝 · C25 最大行号语料。

### 六条这一刀独有的教训

**① 门禁自己打印了「绿」而崩溃率 16.4%。** 第一版判据在「没有基线可比」时只打印绝对值就
`continue` 了 —— 于是 pdf 12/73 崩溃照样 exit 0。**沉默与通过长得一样，这次是门禁自己犯的。**
修法：没有基线 ⇒ 判据无法求值 ⇒ 任何**未具名认领**的崩溃一律判红。

**② 崩溃的定义第一版按退出码写，那会让比较变成我造的。** 新技能的契约是
`docxcommon.run()` 写的「exit 2 = 可操作的错误，exit 1 留给真崩溃」，**旧 doc-edit 没有这个
约定** —— 它对打不开的文件是 `print('Error opening …'); return 1`，一行干净的话。按退出码判，
旧臂会因为**用了另一套约定**被整片记成崩溃。改成只看「有没有一墙 Python」，两条臂才是同一把尺；
退出码另记一笔「契约违规」，且**只对声明过它的那一方有意义**。

**③ 输入门控第一版是循环论证。** 它用 L2 的 X1（`openpyxl.load_workbook`）判输入好坏，而
`xlsx_read.py` 自己就站在 openpyxl 上 ⇒ 凡是 openpyxl 读不了的都被划进「输入本来就坏」，
**被测技能的崩溃率是它自己划的分母**。改成只做结构性判断（zip + 必需 part + XML 良构），
pdf 换成 **pdfminer**（独立实现）。

**④ 断言在正确实现上判红，三次都是我对被测对象的描述错了。**
(a) `docx_validate.py` 的 `rc=1` 是**它写下的约定**（有 schema 违规，明细走 stdout），
我贴的「契约违规」标签是错的 ⇒ 加每步允许退出码表。
(b) 那 3 份被判违规的 docx **输入本来就不合规**（缺 `w:tblPr`），不是编辑造成的 ⇒
技能自己的 schema 校验也要做输入门控。顺带答了 §5 留的未知项：**XSD 在这批文档上没有假阳性**。
(c) C25 的夹具第一版只改 `<dimension>` 字符串，控制臂当场判绿 —— **非 read_only 的
Worksheet 根本不看 dimension**，真实文件里是确实存在一个 `r="1048576"` 的 row。

**⑤ 门禁被真实语料当场打脸：in-process 跑 L2 既没有超时也没有内存边界。** 那份最大行号的
workbook 让 L2 的 X1 吃到 **4.7 GB RSS 且不收敛**，一份病态文件挂死整轮，CI 上会 OOM。
改成**子进程 + 超时**，顺带守住第二件事：lxml / pypdfium 这类 C 扩展在畸形输入上会段错误，
in-process 的话整个门禁跟着死，而且死状看起来像「跑完了」。
判不了的那一份记 `gate_limit`（**我的局限，不是技能的缺陷**），不进任何率的分子。

**⑥ 原计划里的两个语料源实测都不成立。** 用户授权时点名「优先 python-docx / openpyxl /
pdfplumber / pypdf」，实测：**openpyxl 不在 GitHub**（heptapod）且 sdist 不含测试数据、
**pypdf 的 resources 许可核不干净**。换成 calamine + XlsxWriter。**抄来的清单也要验**，
包括用户给的和我自己列的。

### 明确没做 / 不属于本刀

- **L4 人工主观验收**：排版专不专业、财务表符不符合行业审美、PDF 版面可不可交付 —— 只能用户判。
  **不拿门禁全绿冒充「更优」。**
- **合入 main**：L4 点头之后再谈。
- 已记档的既有缺陷（`pptx_read` 大 deck 无 stdout 上限 · `pptx-edit` 漏替换静默 ·
  deckcraft 代码块围栏 · `scripts/` 下三个门禁脚本仍 `import fitz`）—— L3 没有证据表明它们挡合并。

### ⚠️ 这一刀的 CI 一次都没跑成（2026-08-04，run 30908967466）

push 之后 **13 个 job 全部在 3~12 秒内 failure，且 steps 为空** —— 这是「job 根本没启动」
的形状，不是测试挂。annotation 原文：

> The job was not started because recent account payments have failed or your
> spending limit needs to be increased.

**账号计费问题，与本刀代码无关**（同一分支 6 小时前的 run 30884153919 是 10/10 全绿）。
后果必须写清楚：**新增的 `office-skills-l3` job 至今只在作者机器上跑过** ——
而「只在作者机器上跑过的门禁」是这个仓库连续两轮漏掉缺陷的根因（§六·补六、§六·补八）。
S6 那个 Windows 编码缺陷就是 CI 第一次运行才挖出来的，本机三平台扫描全过。

**用户处理计费后必须重跑 CI，并确认「绿」不是沉默**（三平台是否都真的取到了语料、
`--require-corpus` 有没有静默跳过）。在那之前，本刀的跨平台结论只有一句诚实的话：
**没有验过。**

#### 重跑（2026-08-04，用户把仓库改成 public 后）：Windows 当场红，红的是我的脚本

用户改 public 后重跑 run 30909867741。**`office skills L3 corpus (windows-latest)` 在
「Fetch the L3 corpus」这一步失败**：

> `python-docx: LICENSE 内容与清单记录不符 —— 许可变了，必须人工复核后重建清单`

真因：**Windows 的 git 默认 `core.autocrlf=true`**，检出文本文件时把 LF 换成 CRLF ⇒
`LICENSE` 的 sha256 与在 macOS 上建清单时记的值对不上。**清单和许可都没问题，是取语料
的方式在 Windows 上不逐字节。** 修法不是把比较放宽（那会把「许可真的改了」一起藏掉），
是给临时克隆显式设 `core.autocrlf=false` + `core.eol=lf`，让检出**逐字节等于上游**。

本机复现了那个条件（`GIT_CONFIG_GLOBAL` 指到一份 `autocrlf=true` 的 gitconfig），两条臂：

| 臂 | LICENSE 含 CRLF | sha 匹配清单 | 语料 .docx 逐字节 |
|---|---|---|---|
| 控制臂（= CI 上红掉的那版） | ✅ | ❌ | ✅ |
| 修复后 | ❌ | ✅ | ✅ |

⚠️ 顺带实测到一件不能靠假设的事：**语料本体（.docx 二进制）在两条臂下都逐字节相同** ——
git 的二进制启发式确实挡住了，受影响的只有文本文件。但那是启发式不是保证，所以
`core.autocrlf=false` 同时也是给语料上的保险。

固化成常驻控制 **C26**：用一个**本地** git 仓库（不联网）复现 git 自己的换行行为，
两条臂分别带/不带那两行 config。**并且当两条臂结果相同时直接判红** ——
一条在某台宿主上什么也没证明的控制，不许安静地绿。

**这是同一个形状的第五次**：S6 的 Windows 编码缺陷、本条的 Windows 换行缺陷，
都是**本机三平台扫描全过、CI 第一跑当场红**。本机扫的是路径与命令，
而这两个缺陷一个在**编码**上、一个在 **git 的检出行为**上。

本机能补的两件已经补了（都是 CI 冷启动路径的复现，不是替代）：
- `ULTRAWORK_L3_CORPUS` 指向一个**全新空目录** → 四个源完整取回、231/231 sha256 对上、
  全量两臂跑完仍是同一组数字（证明 CI 的 cache-miss 路径与默认缓存路径等价）。
- `--require-corpus` 对着一个空缓存 → **判红**（rc=1，逐条列出缺失文件），证明
  「语料没取到」不会伪装成通过。

#### 第二次重跑（run 30911346681）：macOS 首绿，Windows 与 ubuntu 各暴露一个新问题

| job | 结果 |
|---|---|
| docs · node ×3 · rust ×3 · office skills ×3 | ✅ 全绿 |
| **office skills L3 corpus (macOS)** | ✅ **绿** —— 新门禁第一次在不是作者的机器上全绿 |
| office skills L3 corpus (Windows) | ❌ fetch 过了（CRLF 修复生效），自检挂 |
| office skills L3 corpus (ubuntu) | ❌ runner 被打死（exit 143） |

**① Windows：`text=True` 不给 encoding 是一个「静默」陷阱，不是报错。**
`materialize_baseline` 用 `subprocess.run(..., text=True)` 取旧 `doc-edit` 脚本，
Windows 的 locale 编码是 cp1252，而那些脚本带中文注释。关键在于：**解码发生在
`subprocess` 的读取线程里**（`_readerthread` 是 **Windows 专有**的，POSIX 在主线程解码），
那个线程抛异常只把 traceback 打到 stderr，`run()` 照常返回，只是 `stdout` 变成 **None** ——
于是真正炸出来的是十万八千里外的 `TypeError: data must be str, not NoneType`。
⇒ 所有 `subprocess.run` 一律显式 `encoding="utf-8", errors="replace"`；
`materialize_baseline` 另加「rc=0 却没有内容」的一句话出口。

固化成 **C27**，而这条控制**连判红三次，三次都是我对被测对象的描述错了**：
(a) cp1252 对绝大多数字节**有**映射，随便一句中文只会被静默解成**乱码**（内容悄悄错了），
只有 `0x81/0x8D/0x8F/0x90/0x9D` 五个未定义字节才给 None —— 两种坏法都要钉；
(b) 期望集**依赖平台**（Windows 静默 None / POSIX 抛异常），只能实测量出来并**打印走了
哪个分支**；(c) 「乱码臂」的探针里「码」= `E7 A0 81` 恰好命中 0x81，两条臂又分不开了。
现在两个探针的字都是**算出来挑的**（「不」= E4 B8 8D 命中未定义字节；乱码臂全字节可映射）。

另外补了 **`guarded()`**：一条控制抛异常时记 FAIL 并继续。第一版没有这层，Windows 上
C9 一炸，**后面 17 条控制一条都没跑** —— 一个崩掉的 harness 比一个判红的 harness
告诉你的少得多。

**② ubuntu：不是断言失败，是 runner 被打死。** `exit 143` +
`The runner has received a shutdown signal`，死在 baseline/xlsx 走到那份最大行号
workbook 附近 —— 而那一份的 L2 校验本机实测吃 **4.7 GB**。
暴露的是我的设计缺口：**每步有超时，却没有内存边界**，而「机器扛不住」绝不能被记成
「技能崩了」。修法：L2 worker **自己给自己**设地址空间上限（撞上限归 `gate_limit`），
CI 并行度降到 2。
⚠️ **不用 `preexec_fn`**，两个原因都是实测的：macOS 上 `RLIMIT_AS` 设不了
（`preexec_fn` 直接抛 `SubprocessError`）；且 `preexec_fn` 在**多线程父进程**里本就不安全，
而这个门禁正是线程池并行的。

**这一条要留三句诚实的话：**
- **「大概是 OOM」是从退出码与进度条位置推的，不是量到的** —— GitHub 不报 runner OOM。
  ubuntu 若再死一次，这个推断就是错的。
- **内存上限只管得住 L2 worker**（我们自己的代码）。环里的外部脚本（技能脚本、旧
  doc-edit）只有 120s 时间边界，**没有内存边界**。
- **C28 的 Linux 分支在作者机器上从未执行过**（macOS 设不了那个 limit，控制如实打印
  `nocap(ValueError)` 而不是假装验过）。它只能由 CI 执行 —— 验收方式是**在 ubuntu 的
  日志里看到 `cap=3072MB` 被打印出来**。

#### 第三次重跑（run 30913197581）：两条控制自己出问题，而它们出的问题正是它们要测的东西

ubuntu **不再被打死**（内存上限 + 并行度 2 生效了那一半），Windows 的 fetch 也过了；
两边都停在**自检**上，各挂一条控制 —— 而两条都是**控制自身的缺陷**，不是被测对象。

**① C27 在 Windows 上被它自己要测的那个陷阱废掉了。** 观察值是 `stdout=''`（空串，
不是 None）：探针子进程用 `print()` 打中文，而 **Windows 的子进程自己就按 cp1252 编码
stdout**，第一个中文字就 `UnicodeEncodeError` 死掉 ⇒ **管道上一个字节都没有**，
父进程要测的解码路径压根没被走到。这就是 S6 那个缺陷的形状，长在控制身上。
修法：探针改成 `sys.stdout.buffer.write(...)` **绕过子进程的文本编码直接写原始字节** ——
这样管道上的字节三平台完全一致，唯一变量才是「父进程怎么解码」，也正是要测的东西。

**② C28 在 ubuntu 上红了，而它红得对**：64MB 上限下 worker 没打出预期的标记。
但真正的教训是**这条控制不可诊断** —— 它只打印判定、不打印观察到了什么，
所以红了一轮我却看不出 worker 到底死成什么样。**一条不可诊断的控制会浪费一整轮 CI。**
修法两条：(a) worker 自己兜 `MemoryError` 并打一个**确定的**标记 `__L3_MEMCAP__` +
专用退出码 3（不指望上游措辞，上游措辞是会变的），另认 `Cannot allocate memory` /
`std::bad_alloc` 等 C 层说法；(b) 控制**无论红绿都打印 rc 与 stderr 尾部**。

**这一轮的元教训**：C26/C27/C28 三条跨平台控制，**每一条第一版都在它要测的那个平台上是坏的**，
而且坏法各不相同（换行、编码、不可诊断）。本机能跑绿的控制，**不等于在它真正要守的那台
机器上能工作** —— 与 S6 的结论同形，只是这次连「验证工具」本身也一起中招了。

#### 第四次重跑（run 30913666661）：Windows 与 macOS 的 L3 都绿了，而两边数字不一样

| job | 结果 | 耗时 |
|---|---|---|
| **office skills L3 corpus (macOS)** | ✅ 绿 | 9.1 分钟 |
| **office skills L3 corpus (Windows)** | ✅ **绿**（第一次跑完整个回归） | 10.5 分钟（超时 30 分钟，余量充足）|
| office skills L3 corpus (ubuntu) | ❌ C28 的笔误（`Step.stdout` 实为 `.out`），已修 | 0.8 分钟 |

**新臂的数字三平台逐格相同**（docx 0/0 · xlsx 崩溃 1 拒绝 4 损坏 0 · pdf 崩溃 1 具名认领）。
**不同的是基线臂与输入门**，而两处差异都查清楚了，都不是抖动：

**① 旧实现在 Windows 上读不了中日韩 workbook（S6 那个缺陷，长在被替换的那一方）。**
基线臂在 Windows 上多崩 4 份：`rph.xlsx`（日文）· `whitespace_trim.xlsx`（中文）·
`issue_553.xlsx`（韩文）· `issues.xlsx`（`☺`）。本机实测这四份的旧脚本 stdout
**全都无法用 cp1252 编码** —— 旧 `xlsx_read.py` 没有 UTF-8 reconfigure，Windows 上
打印即 `UnicodeEncodeError` 退出 1。⇒ 基线崩溃率 4.0%（macOS）vs **8.8%（Windows）**，
损坏率 66.7% vs 65.2%（那四份从「损坏」挪到了「崩溃」）。
**判据在两个平台都成立，而且 Windows 上差距更大** —— 但要说清楚差距为什么更大，
不能只报一个更好看的数字。

**② `zipfile.namelist()` 不是平台无关的。** `issue_530.xlsx` 把条目名存成
`xl\workbook.xml`（违反 ZIP/OOXML 规范，野外真有）；CPython 的 `ZipInfo.__init__`
会把 `os.sep` 换成 `/`，所以**同一份字节在 Windows 上读回 `xl/workbook.xml`、
在 POSIX 上读回 `xl\workbook.xml`** ⇒ 输入门 Windows 放行、macOS 判「缺 part」，
两边分母不同（102 vs 101）。修法：门禁自己归一化，**测量必须与平台无关**。
控制 **C29**（断言裸 `namelist()` 的命中结果恰好等于 `platform == win32`，
归一化后两平台一致）。契约 → gotchas §12。
⚠️ **技能本身的行为有意未改**：openpyxl/python-docx 同样走 zipfile，所以「能不能打开
这类文件」也是平台相关的。文件本身违规、两种行为都说得通，但**要知道它不一致**。

**③ 顺带修掉主报告里的一个诊断缺口。** 崩溃行打的是 stderr 的**第一行**，而裸 traceback
的第一行永远是 `Traceback (most recent call last):` —— 上面那四份 Windows 独有的崩溃在
CI 日志里全是这句废话，机制只能靠本地反推。有 traceback 时改打**最后一行**。
**一条不可诊断的报告和一条不可诊断的控制一样，会白烧一轮 CI。**

#### 跨平台对账（归一化之后，2026-08-04）：每一格差异都有名字

| | macOS | Windows | 差异从何而来 |
|---|---|---|---|
| xlsx 输入坏 / 可用 | 3 / 102 | 3 / 102 | ✅ zip 名归一化之后两边一致（此前 4/101 vs 3/102）|
| **new** xlsx 崩溃 / 拒绝 / 损坏 | 1 / **5** / 0 | 1 / **4** / 0 | `issue_530` 的反斜杠条目名：macOS 上 openpyxl 打不开 ⇒ **拒绝**；Windows 上 zipfile 替它归一化了 ⇒ 读得了。**技能层面的平台差异，有意未改** |
| **baseline** xlsx 崩溃 / 损坏 | **4** / **62** | **9** / **58** | 多出的 5 = 4 份中日韩（`rph`/`whitespace_trim`/`issue_553`/`issues`，旧脚本无 UTF-8 reconfigure ⇒ Windows 上 print 即崩）+ `issue_530`。那 4 份从「损坏」挪到「崩溃」，62−4=58 ✓ |
| 判据 | 新 1.0% / 0% vs 旧 3.9% / 66.7% ✅ | 新 1.0% / 0% vs 旧 8.8% / 65.2% ✅ | 两平台都成立 |

**这张表本身就是结论的一部分**：一份跨平台的回归报告如果两边数字不一样，只有两种可能 ——
要么每一格差异都能指名道姓，要么这份报告不可信。这里是前者。

#### 第六次重跑（run 30915941230）：三平台的 L3 全绿，以及一条不能含糊的话

| job | 结果 | 耗时 |
|---|---|---|
| office skills L3 corpus (ubuntu) | ✅ **绿**（六轮以来第一次跑完回归）| 5.4 分钟 |
| office skills L3 corpus (macOS) | ✅ 绿 | ~9 分钟 |
| office skills L3 corpus (Windows) | ✅ 绿（第四轮已验，10.5 分钟）| |
| `node (ubuntu)` | ❌ **已记档的 flake**，与本刀无关（见下） | |

**ubuntu 与 macOS 的数字逐格相同**（xlsx 3/102 · new 1/5/0 · baseline 4/62 ·
崩溃率 1.0% vs 3.9% · 损坏率 0% vs 66.7%），Windows 只在前述两处已具名的地方不同。
**两个 POSIX 平台完全一致，是「这个测量与机器无关」目前最强的证据。**

**C28 的 Linux 分支拿到了真机证据**（此前只能说「本机执行不了」）：
`[linux] 可设上限=True 上限=8MB → rc=3 hit_mem_cap=True crashed=False refused=False
有产出=False；stderr: cap=8MB | __L3_MEMCAP__`。上限设上了、撞上了、打出了确定标记、
被归成「门禁局限」而不是「技能崩了」。

**⚠️ 但有一条不能顺口说过去的：内存上限在这一跑里根本没被触发过。**
ubuntu 与本机（无上限）的掩码行**逐字节相同** —— `[('X2', 8), ('X1', 5), ('VALIDATE', 3)]`，
`判不了` 两边都是 0。所以 **ubuntu 这次活下来不能归功于内存上限**：第二轮（死）到第六轮
（活）之间真正生效的变量只有 **`--jobs 4→2`**，而「第二轮那次死亡到底是不是 OOM」
**至今未被证明**，也可能只是一次与本刀无关的 runner 回收。
上限的价值是**给未来设一个边界**，不是「它修好了这次」。**不把相关当成因果。**

**连带发现门禁自己的一个新盲点（已记入 Pending）**：「L2 超时」与「L2 撞内存上限」
**塌陷成同一个掩码结果**，报告分不出这两者 —— 正是这个盲点让上面那个问题在本轮无法回答。
这是本刀第四个同族问题（前三个：控制不可诊断 · 崩溃行打第一行 · 控制只打判定不打观察值）。

**`node (ubuntu)` 那条红与本刀无关**：`command-selector.test.tsx`，本刀 `git diff` 里
**一个 TS 文件都没有**。新数据点：这次红的是 **E**（S6 那次是 D），而且这一跑**没有新增
任何 TS 测试** ⇒ **排除了**专题里原本挂着的「是不是新增测试加重并行负载把既有竞态顶出来」
那条怀疑。累计 ubuntu 至少 4 次（E · D+E · D · E），mac/Windows 从未红过。**仍无定论。**

#### 第七次重跑（run 30916996529，纯文档 commit）：ubuntu 又死一次，而这次凶手指名道姓了

这一跑的**代码与上一跑逐字节相同**（只多了文档），macOS 与 Windows 的 L3 都绿，
**ubuntu 又是 `exit 143` + `The runner has received a shutdown signal`** ——
同代码一绿一红，所以它是**间歇的**；但关键在于：

**两次死亡停在进度条的同一个字符上** —— `XD····rDDDDDDD·D···D·iXDDD`，26 个之后。
按顺序数第 27 份是 **`issue_174.xlsx`（142 KB，`max_row=1048576`）**，
而它此刻正进入**基线臂** —— 旧 `xlsx_read.py` 会 `openpyxl.load_workbook()` 全量加载它，
本机同类加载实测 **4.7 GB**。那一刻整个 job 里唯一无界的进程就是它。

⇒ 「大概是 OOM」从推断变成了**有证据的结论**：同一文件、同一位置、两次，
且唯一无界的进程可指名。**此前我说「不能归功于内存上限」是对的，理由现在更清楚了：
我的上限只包住了 L2 worker，而凶手在环里。**

**修法：给环里的外部脚本也上界**（`sh -c 'ulimit -v …; exec "$@"'`，仅 Linux ——
macOS 的 `RLIMIT_AS` 设不了、Windows 没有 ulimit；**不用 `preexec_fn`**，它在多线程
父进程里不安全）。**撞上界与超时同等记崩溃**，而不是记成「门禁的局限」：
对被测实现而言「处理不了这份文件」是它自己的属性 —— 新 `xlsx_read` 在同一份文件上
**3.2 秒、几百 MB** 就干完了。（L2 worker 撞我自己设的上限才是门禁的局限，两者刻意不同类。）
控制 **C30**：两平台走同一条代码路径，只有期望值分叉（Linux 撞上界 / 其它平台如实说
「本平台没有内存上界，只靠超时兜底」）。

**顺带修掉报告里一个印错的数字**：`why()` 读的是**全局**的超时预算，而控制臂会临时把
预算压低再改回 —— 于是报告印「超时 >120s」而当时预算其实是 60s。改成把预算记在 Step 上。
**报告印错数字，与被测对象印错数字是同一类问题。**

#### 收官（run 30918100995，HEAD `c7f5cd64`）：**13/13 全绿**

环内存上界落地后的一跑，**13 个 job 全部 success**（含此前一直间歇性红的
`node (ubuntu)`）。L3 三平台：

| | macOS | ubuntu | Windows |
|---|---|---|---|
| new xlsx 崩溃/拒绝/损坏 | 1 / 5 / 0 | **1 / 5 / 0** | 1 / 4 / 0 |
| baseline xlsx 崩溃/损坏 | 4 / 62 | **4 / 62** | 9 / 58 |
| 崩溃率 · 损坏率（新 vs 旧）| 1.0%/0% vs 3.9%/66.7% | **同左** | 1.0%/0% vs 8.8%/65.2% |
| 耗时 | 349s | **141s** | 365s |

**开工前写下的预测逐条命中**：Linux 上 `issue_174` 从「超时」改判「撞 3GB 内存上界」，
**崩溃数不变（4）**，两个 POSIX 平台仍逐格相同；Windows 的差异仍只有那两处已具名的原因。
一条附带结果：ubuntu 耗时 **322s → 141s** —— 吃内存的进程现在快速失败，而不是抖到超时。

**一个值得记下的性质**：同一份 `issue_174.xlsx`，macOS 上撞的是**时间**上界
（`read: 超时 >120s`）、Linux 上撞的是**内存**上界（`validate: 撞 3GB 内存上界`）——
**理由依平台，结论不依平台**。一个跨平台判据应当长这样：允许机器给出不同的**原因**，
不允许它给出不同的**结论**。
