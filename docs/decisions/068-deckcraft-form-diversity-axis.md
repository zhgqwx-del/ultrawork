# ADR-068: deckcraft 形式丰富度轴（扩词汇表 + 去收敛 + 松地基）

- 状态：Accepted（✅ Phase A–E 全部实现 2026-07-23 + 深度 review 2026-07-24；真机形式多样性 A/B 验收交用户）
- 日期：2026-07-23（review 补记 2026-07-24）
- 关联：discussions/054（完整根因六重实证 + 4 库量化对比 + 自查漏洞与修正）· ADR-066（内容密度双边带，**同类缺口的内容侧前作**）· ADR-067（对比度机器门禁，**本 ADR 的 D6 直接扩它**）· ADR-061（删内置 ppt-master → deckcraft 成唯一默认做 PPT 技能）· discussions/053 §2.1（第 2 轮 question 被整轮跳过——与本 ADR 的扩容**相乘放大**）· 桌面 `skill_research/01,02,03,07,09`

## 背景

用户反馈：「不同 prompt 做的 ppt，除了颜色不同外，很多风格/布局都高度相似」+「我期望 deckcraft 是个比较完备的技能，形式的丰富应该是需要的」。

**根因（已实证，非猜测，详见 discussions/054 §三/§四）**：这确实是固定模版，且由硬门禁强制。跨 deck 的全部差异在架构上被压缩到 **15 个 CSS 变量**（7 色 + 7 字号 + 1 字体栈）——`spec-lock-format.md` 原文「深色风格把 `--c-bg` 设为深色即可，**结构层不用改**」就是这一事实的架构声明。

收敛来自 **6 条独立的力**，只加版式治不好：① 版式闭集 S01–S10 + E7 反向逼迫用满（≥8 页须 ≥6 种，池子只有 10）；② 结构层 `shell.html` 全局硬编码（`.bar`/`.kicker`/版心/字重）⇒ 风格只能换皮不能换骨；③ E4 把反-slop 黑名单实现成**全局硬门禁**（禁渐变/阴影/圆角），比来源严格——huashu 原文是概率性的「大概率不加」、frontend-slides 的 Bold Signal 预设 `:root` 直接含 `linear-gradient`；④ 四套风格**全是"安静/中性"档**、无"大胆"档（huashu 点名这是 default 千篇一律的根因，对策是故意让大胆款占多数）；⑤ **four-shot 本身在收敛**——四个 example 的 `--font-stack` 逐字节相同、`--c-bg` 全部近白、无一使用 tech-dark；⑥ 选择规则确定性（「拿不准默认 swiss-minimal」），无随机化无剔重。

**这是同一类缺口的第三次**：ADR-066 补了内容密度的下界，ADR-067 补了对比度的物理下界，本 ADR 补形式多样性——三次都是「为对抗某个失败模式加的约束同时压掉了对侧表达空间，且对侧没有任何机器信号提示它被压掉」。

## 决策

### D1 — 去收敛：随机化**落脚本**（不是写文档）+ example 去同质 + 字体配对

- **`scripts/pick_variants.py`（新增）**：用 `项目名 + 主题` 做**确定性 hash 伪随机**（可复现、可回放，无需真随机源），输出打乱后的风格/版式候选与 seed；SKILL.md Phase 3 强制先跑它、按其顺序呈现候选。**删除 `design-styles/_index.md` 的「拿不准时默认推荐 swiss-minimal」**。
  > **为什么必须落脚本**：把「请随机排序、不要固定选第一个」写进 md 属于 ADR-067 立论前提所否定的做法（「本 ADR 前提是文档引导不可靠 ⇒ 把补救办法也写文档同样不可靠」），且 discussions/053 §2.1 已实证 SKILL.md 明写的第 2 轮 question 会被模型整轮跳过。LLM 伪随机有强偏向，"自己随机"≈选最熟的那个。dashiAI 能做到是因为 `layout:query` 是 CLI。
- **example 去同质**：四例覆盖四套风格与三类字体栈（≥1 深底 tech-dark、≥1 衬线、≥1 等宽/几何），与 ADR-066 D5「三档 example 去密度偏」**同构**——那次修内容侧 few-shot 偏，这次修形式侧。
- **字体配对表**：`typography-cjk.md` 增 4-6 组中西配对（全开源可得），每风格文件指定默认配对。

### D2 — 扩词汇表：版式 S11–S20 + 风格 8-12 套 + 图表能力

- **版式**：图文混排 hero / 三栏卡片 / 2×2 矩阵 / 流程链 / 条形图 / KPI 网格 / 全幅图叠字 / 金字塔·漏斗 / 引用+人像 / 代码·终端。`validate_deck.py:134` 的 registry 解析 `layouts.html` 是 SSOT 设计 ⇒ 加 S11 自动生效、零改码。
  每个版式配套缺一不可：骨架 + `outline-schema` content 结构 + 字符预算 + `validate_outline` 的 `STRUCT_CAPS`/`primary_count` 分支 + **probe 实测标定**（⚠️ ADR-066 教训：预算必须实测，手算表被实测证伪过一次）+ **`--pptx-editable` 保真验证**（见「影响/风险」副作用 4）。
- **E7 改比例式 + 素材感知**：池子扩到 20 后「≥8 页须 ≥6 distinct」不再是有效约束 ⇒ 改按页数比例；且**多样性计数须排除素材依赖版式**（图文 hero / 全幅图 / 引用+人像），否则弱网无图时 E7 会逼模型去用它们、产出一堆「图片待补」占位框。
- **`layouts.html` 拆索引**：10→20 后该文件约 280 行且是**整份读入**的，与 progressive disclosure 纪律冲突 ⇒ 拆 `layouts/_index.md`（一行一版式选型表）+ 按需读骨架片段。
- **风格**：按 huashu 温度体系补"大胆"档，每套须逐套过对比度门禁（深色/高饱和是 ADR-067 误报高发区）。
- **图表**：当前完全空白（只有 S05 大数字 + S10 表格）。纯 CSS/内联 SVG 条形·折线·占比，配 dashiAI 的**数值安全层**思路（`safeDenominator/safeMax/safeRatio` + finite-render 门禁，根治脏数据渲成 NaN 几何）。

### D3 — 松地基：结构层 token 化 + Signature Treatments

- **12 个骨相 token**：`--sl-pad` / `--bar-w,--bar-h` / `--kicker-transform,--kicker-spacing` / `--fw-head,--fw-sub,--fw-body` / `--lh-body` / `--measure` / `--radius` / `--rule-w`。全部在 `shell.html` 带 CSS 变量兜底值 ⇒ 旧 deck 不写也照常渲染。
  **这是让风格产生"骨相"差异而非仅"皮肤"差异的唯一办法**——不做这一条，扩再多风格文件仍然只有颜色在变。
- **Signature Treatments**（frontend-slides 核心机制）：每风格一条"招牌笔触（非可选）——少了这一笔就不是这套系统"，用 `data-signature="…"` 做机器可检并接进 `visual-review` R8。

### D4 — E4 从全局硬门禁降为风格级默认（用户拍板的美学立场）

全局默认仍禁；**风格文件可显式声明放开**，经 spec_lock 里的机器可读标记 `<!-- deckcraft:allow gradient,shadow -->` 生效。**白名单式逐项列举，不支持通配**。永不可放开：斜体（CJK 无斜体，是物理正确性问题非审美）· 下划线 · palette 外颜色 · ramp 外字号。

### D5 — 预算折算：骨相 token 与字符预算**不是正交的**（自查修正）

`DELIVERY_BANDS` 的 26/32/42 是在 padding 64px / `--fw-body:300` / `--lh-body:1.65` / `--measure:36em` 这组几何下 probe 标定的（`validate_outline.py:62` 注释）。D3 让这四个全部可变 ⇒ 预算会**偏乐观**，后果是大量「过了 outline 门禁却被 probe 打回」的返工——而 `validate_outline` 正是为消除这种返工而存在的。

修正：**骨相 token 收敛成有限档位**（每个 2-3 个合法值），`validate_outline.py` 读 tokens.css 感知 `--sl-pad`/`--fw-body`/`--lh-body`/`--measure`，按**最紧组合**折算预算系数并对该组合做 probe 实测标定。

### D6 — probe 增加渐变色标采样（D4 的必要前置，用户拍板）

**代码已证实的缺陷**：`probe_overflow.py:82` 只要祖先链上任一元素有 `background-image` 就置 `imaged=true`，而 `:295` 的 `bad = [... and not t["imaged"]]` 把 `imaged` 元素**整体排除出判负**。`linear-gradient` 就是 `background-image` ⇒ 给 `.slide` 加渐变底会让**该页每一个文字元素**免于判负 ⇒ **ADR-067 那道门禁在渐变页上完全失效**，ADR-067 修的缺陷（浅字压浅底 1.10:1 几乎隐形）会原样复活且不报错。

修正：解析 `linear-gradient()/radial-gradient()` 的色标，取**最差端**参与背景合成后照常判负；解析不了的渐变语法与真实位图仍走「标记但不判负」（保持 ADR-067 D3「宁漏报不误杀」）。阈值须重新标定并补测试。**gradient 的放开与本条同期落地，不早于它。**

### D8 — 新增 `--c-head` 语义 token（Phase A 实施期发现的既有缺陷，非计划内）

做「唯一深底 example」时暴露：`--c-primary` **同时**承担「`data-dark` 页背景」与「浅底上的标题/栏头/表头墨色」两个角色，而**深色风格下这两个角色要求相反的明度** ⇒ 深字压深底、近乎隐形（正是 ADR-067 修的那一类缺陷）。

`spec-lock-format.md` 原有的「深色风格把 `--c-bg` 设为深色、`--c-primary` 相应调整即可，**结构层不用改**」是**错的**——但**四个 example 全是浅底，这句话从未被执行过**，所以缺陷一直不可见。这本身就是 discussions/054 主论点的又一个实例：没有被走过的路径不会自己报错。

修法：新增第 8 个 `--c-*` —— `--c-head`（标题/栏头/表头墨色，**跟随风格深浅**），`--c-primary` 退回只当 `data-dark` 页背景与结构元素。全部 87 处 `color:var(--c-primary)`（layouts.html 5 处 + 四例页面 82 处）改写为 `var(--c-head)`。SKILL.md §5.2 的墨色指引同步改为「三条铁律」，不再要求模型自己判断深浅。

### D7 — 多样性下界只能做到 warning 级（诚实的边界声明，用户拍板）

- **做得到**：`validate_deck` 新增 **W3** —— tokens.css 的 12 个骨相 token 若 ≥10 个等于默认值，警告「这份 deck 只换了颜色」；`qa_report.json` 记 `style_id` / 骨相摘要 / 版式序列 / `variant_seed`，让撞脸**可事后核对**。
- **做不到**：硬门禁。**撞脸是跨 deck 属性，单份 deck 判不出来，而 deckcraft 无跨会话状态**；且「这份 deck 该不该用默认风格」是产品语义问题（与 discussions/053 §2.1「提问轮该不该强制」同类）。
- 这条写明为**已知边界**，不假装解决。

## 影响 / 风险

**可行性**：全部落在 `skills/builtin/deckcraft/`（py + md + html 模板 + example），**不碰 vendor patch、不碰业务 TS、无新依赖**（与 ADR-066/067 同）。包体积增量几十 KB（当前 25M 主要是 5039 个图标）。三平台无风险（纯资源 + Python 门禁，不碰路径/进程/外部命令）。

**会发生的副作用（已在决策里各自对应修正）**
1. 渐变页对比度门禁失效 → D6
2. 字符预算与骨相 token 脱钩致返工 → D5
3. 上下文成本随版式数线性增长 → D2 拆索引
4. ~~**新版式在可编辑 pptx 中的不可编辑元素数上升**：CSS 条形图、深层 flex 嵌套大概率整块栅格化~~
   → **Phase D 实测证伪**：156 元素中 98.1% 可编辑，S15 条形图译成 12 个**原生形状**而非图片，
   唯三栅格是真实 `<img>`。纯 CSS 画图在可编辑导出上是正收益。保留「每个新版式跑一遍
   `--pptx-editable`」的纪律——它这次的作用正是**推翻了一个凭直觉写下的风险**。

**需监控**
5. **与既有缺口相乘放大**：discussions/053 §2.1 已实证「Phase 3 第 2 轮 question 会被模型整轮跳过」。风格 4 选 1 变 12 选 1 后，一旦那轮被跳过、模型自选 ⇒ **回到确定性偏好，扩容白做**。两个问题是相乘不是相加。
6. **ADR-067 阈值标定样本被改**：2.3/1.8 双档是拿现有四例的 369 个真实绘制文本元素实测标定的；D1 换深底 example、D2 加高饱和风格、D6 引入渐变采样都会改变该样本 ⇒ **必须重跑 `--dump-contrast` 复核**，不可假设沿用。
7. D4 使防线从"机器"退到"文档自律"（缓解 = 白名单式显式列举 + 保留 `content-guidelines.md` 决策速查）。
8. **改动面约 40 文件**，vs ADR-066 的 7 个、ADR-067 的 3 个 ⇒ **回归风险高一个量级**，故分 Phase 落地。

**通用性（不宣称"整体通用"）**：D1 全部 + D3 骨相 token 是**普适收益**；D2 版式/图表是**补能力空白**（对有素材/有数据的 deck 才有感）；D4 是**打开上限**（默认路径全禁、无感）。

**pack 纪律**：ADR-061 血泪「pack 后禁再动 `skills/builtin/` 树」⇒ **五个 Phase 全部做完再 pack**；`.builtin-version` 经 pack 权威 hash 重生成。

**前向生效**：仅新生成的 deck 受益；老 deck 需重跑门禁链（骨相 token 有兜底值 ⇒ 老 deck 不写也不崩）。

## 实施 Phase（各自可独立验证）

| Phase | 内容 | 验证 |
|---|---|---|
| **A** ✅ | D1 全部（`pick_variants.py` + 字体配对 + example 去同质）+ D7 的 W3/qa_report + **D8（计划外发现）** | ✅ 见下 |
| **B** ✅ | D3 骨相 token + D5 预算折算 + Signature Treatments | ✅ 见下 |
| **C** ✅ | D2 风格扩容（含 `shadow` 放开）+ layouts 拆索引 | ✅ 见下 |
| **D** ✅ | D2 版式 S11–S20 + E7 比例式&素材感知 + 图表 + `--pptx-editable` 保真验证 | ✅ 见下 |
| **E** ✅ | D6 probe 渐变采样 + gradient 放开 + pack + 收尾 | ✅ 见下 |

## 验证

### Phase A（2026-07-23，✅ 完成）

- **三套测试全绿**：`test-deckcraft-validate` **26/26** · `test-deckcraft-contrast` **46/46** · `deckcraft-selftest` **48/0**。
- **四例门禁链全绿**：validate_outline 0 error · validate_deck **0 error / 0 warning（W3 已消除，13/13 骨相 token 全部写出）** · probe **0 overflow / 0 low-contrast**。
- **对比度阈值重标定**（ADR-067 要求，样本已被 D1 换掉）：369 个真实绘制文本元素（与旧样本同量），
  large 档合法最低 **2.54**（floor 1.8，余量 1.41x；ADR-067 原标定 2.57）· body 档合法最低 **4.11**
  （floor 2.3，余量 1.79x；原标定 3.12）· **`imaged`（免判负）0 个 ⇒ 门禁在四例上全程有效、无绕过**。
  结论：**2.3 / 1.8 双档在新样本下继续成立，余量与原标定相当或更好，不需调整**。
- **深底 example 真实截图核对**：`--c-head` 浅墨压深卡片、accent 顶线、等宽标题 + CJK 穿透黑体，均按设计渲染。
- **`deck.html` 重建幂等**（重跑 build 无 diff）· 四例 `qa_report.json` 的 `form` 段全部填满
  （style_id / variant_seed / skeleton 13 项 / layouts 序列）。
- **实施期踩坑一条（已修并入库为文档警告）**：`shell.html` 结构层注释里写了 token 通配 `--sl-*` 紧跟
  `/--fw-*`，其中的 `*` `/` 连写**提前终止了 CSS 注释**，把后续 `.slide{height:720px}` 等结构层规则整段吃掉
  ⇒ probe 从 0 overflow 变 **69 overflow**、文本元素 114→78。**症状是版面整体错位而非局部溢出**；
  用 `git archive HEAD` 抽纯净副本跑同一门禁做 A/B 定位。shell.html 已加显式警告。

### Phase B（2026-07-23，✅ 完成）

- **D5 实测标定（关键）**：在**最紧合法几何**（`--sl-pad:80px` + `--lh-body:1.85`）下，用按**未缩放**
  document 档（p ≤42、S10 8 行）撰写的真实内容跑 probe —— **0 overflow**。而该几何下折算出的预算是
  **p ≤36**，比物理真能装下的还紧 ~17% ⇒ **缩放方向保守且留有实测余量**（不是手算，符合 ADR-066 教训）。
- **越界值确实被拦**：`--sl-pad:96px` → `O10` error（"budgets were never measured for this geometry"）。
- **四例改用各自风格的骨相**（此前 Phase A 保守地全用基准值）：
  academic-calm `lh1.75/measure34` → char×0.89 · editorial-warm `pad72/lh1.75/measure34` → char×0.89 ·
  tech-dark `fw400/lh1.55/measure32` → char×0.86 · swiss-minimal 基准 → char×1.00。
  **四例门禁链在收紧后的预算下仍全绿**（validate_outline 0 error · validate_deck 0/0 · probe 0/0）。
- **测试**：`test-deckcraft-contrast` **46/46**（token 接线后重跑，四例 0 findings）· `deckcraft-selftest` **48/0** · `test-deckcraft-validate` 26→**41/41**（新增 15 例：几何缩放上下界、O10 越界与非数值、
  计数下限不穿透 O9、端到端"同一份大纲基准档过·宽松档拒"、四例逐个回归）。
- **W4 负路径实证**：删掉全部 `data-signature` 后确实报 W4。
- **计划外发现：「名义 token」是一整类缺陷，出现了两次**
  1. 四个 example 里 **19 处招牌笔触是内联硬编码**（`<div style="width:48px;height:8px;…">`）而非
     `class="bar"` —— **完全绕开 `--bar-w`/`--bar-h`**。不改页面的话，骨相 token 只是名义上生效。
     全部改为 `class="bar" data-signature="<id>"` 后，editorial-warm 的 88×3 长细横线才真的渲染出来（截图核对）。
  2. `--radius` 与 `--rule-w` 声明了却 **无人使用**（全仓 0 处 `var(--radius)` / `var(--rule-w)`），
     而 W3 会把它们算作"已选择"⇒ **假信号**。已接线：细分隔线走 `var(--rule-w)`、表头强线走
     `calc(var(--rule-w) * 2)`（保持比例而非各自硬编码）、分区卡片吃 `border-radius:var(--radius)`
     （默认 0 ⇒ 零视觉变化，Allowances 放开圆角时才生效）。共 23 + 12 处。

  **教训**：token 化是"声明 + 消费"两半，只做前一半会得到一个**看起来可配置、实际改不动**的系统 ——
  这与本 ADR 要治的「只有颜色在变」是同一个病因的不同层级。已写入 spec-lock-format 与 checklist 作为纪律。

- **自查修掉的隐患**：两个门禁的 token 解析未剥离 CSS 注释 —— 注释里写 `/* --radius: 圆角用 */`
  会被当作真声明（静默放宽 `validate_deck` E3 的白名单；在 `validate_outline` 里更糟，会**凭空造出
  O10 越界错误**）。与 Phase A 踩的「`*/` 提前终止注释」同源：**CSS 里注释与声明的边界是个反复出雷的地方**。

### Phase C（2026-07-23，✅ 完成）

- **风格库 4 → 10 套**，按 huashu 温度体系**让大胆档占多数**（新增 `bold-poster` / `duotone-vivid` /
  `noir-luxe` / `mono-terminal` 四个大胆档 + `blueprint-tech` 中性 + `paper-craft` 安静）。
  分布：大胆 4 · 中性 3 · 安静 3。`pick_variants` registry 自动涨到 10，候选仍强制跨温度档。
- **每套新风格逐套对比度实测**（风格文件按设计不含 HEX ⇒ 用代表性调色板套到真实页面结构上量，
  页面只用 `var()` 与风格无关）：六套各 96 元素、**合计 576**，全部 **0 overflow / 0 low-contrast**。
  body 档最低 **3.94**（duotone-vivid，余量 1.71x）· large 档最低 **4.32**（bold-poster，余量 2.40x）·
  **`imaged` 免判负 0 个**。连同 Phase A 四例 369 元素，**标定样本累计 945 个、覆盖 10 套风格**，
  2.3 / 1.8 双档继续成立。
- **实测抓到一条可泛化规则（首版调色板真的失败了）**：`bold-poster` 首轮报 2 处 —— 皆为
  `data-dark` 页上靠 `opacity:.55` 压暗的脚注压在**高饱和**主色上，实测仅 **2.21:1**。
  ⇒ **高饱和主色做 data-dark 底时禁止用 opacity 压暗 on-dark 文字，要弱化就缩字号**。
  已写进 `bold-poster` / `duotone-vivid` 两个风格文件，并补进 probe 失败时自带的 `FIX:` 处方。
- **顺带修 Phase A 遗留的处方漂移**：probe 的 `FIX:` 仍在教人「浅底标题用 `var(--c-primary)`」，
  而 D8 已把墨色改为 `--c-head` —— **自带处方也会过期**，已同步。
- **E4 放开机制三路实证**：无 allowance → 拦 box-shadow ✅；`allow shadow` → 放行 ✅；
  `allow gradient` → **明确拒绝并给出原因**（probe 尚不能测渐变上的对比度，落在 Phase E）✅。
  `italic`/`underline` 结构上不可放开（`None` key）。
- **`layouts.html` 拆为 `assets/templates/layouts/`**：一版式一文件 + `_index.md` 选型索引
  （含**需素材**列，供 Phase D 的 E7 排除素材依赖版式）。`valid_layouts()` 改为 glob 该目录 ⇒
  **新增 `Sxx.html` 即自动生效、零改码**；保留对旧单文件与内置 S01–S10 的双重回退。
- **测试**：`test-deckcraft-validate` 41 → **67/67**（新增 26 例：注册表==目录内容、每个版式在索引中有行、
  E4 白名单与不可放开项、10 套风格逐个校验「已注册 + 声明 Signature + 有骨相 token 表」）。

### Phase D（2026-07-23，✅ 完成）

- **版式库 10 → 20**：S11 图文混排 · S12 三栏卡片 · S13 2×2 矩阵 · S14 流程链 · **S15 横向条形图** ·
  S16 KPI 网格 · S17 全幅图叠字 · S18 漏斗/金字塔 · S19 引言+人像 · S20 代码/终端。
  **注册表零改码自动认到 20 个**（Phase C 把 registry 改成 glob 目录的收益兑现）。
- **物理标定**（ADR-066 教训：预算必须实测）：构造一份把 10 个新版式全用上、内容**顶到 balanced 档
  上限**（`p` 恰 32 视觉宽、条目数取各自 cap）的 deck ⇒ probe **0 overflow · 0 low-contrast**（120 元素）。
- **O11 数值安全层**（dashiAI chart-safety 思路，落在 IR 层）：S15 是唯一「数据→几何」的版式
  （宽度 = `value/max×100%`），四类算术炸法必须死在渲染前 —— 非数字 / 负数 / 非有限 / **全零序列
  （除零 → NaN 宽度 → 条形静默不绘制）**。**物理探针看不见这些：零宽度的条不溢出任何东西。**
  含 `isinstance(True, int)` 的布尔陷阱，7 类输入全覆盖。
- **E7 改比例式**：`distinct ≥ round(页数 × 0.6)`（下限 3），取代旧的「≥8 页须 ≥6 种」——
  旧规则在 10 个版式的池子里实际含义是"把词汇表用掉大半"，正是 discussions/054 §四① 的收敛力之一。
  四例零回归；负路径实证（10 页塞 5 种）确实报错。
- **W5 素材感知**（取代"E7 排除素材版式"的原设计，更直接）：`需素材` 版式（S11/S17/S19，从
  `layouts/_index.md` 的列解析）用在没有图片引用的页上 → 警告"会渲成「图片待补」占位框"。
  **不让 E7 的多样性要求成为反手逼出占位框的原因。** 负路径实证通过。
- **`--pptx-editable` 保真实测 —— 推翻了本 ADR 自己写的风险 4**：原文预判「CSS 条形图、深层 flex
  嵌套**大概率整块栅格化**」。实测 156 个元素：**文本 109 + 原生形状 44 + 栅格 3 = 98.1% 可编辑**；
  **S15 条形图译成 12 个原生形状（100% 可编辑，不是图片）**、S14 流程链 100%、S20 代码块保住换行；
  唯三的栅格恰是 S11/S17/S19 里真实的 `<img>`，无一是被迫栅格化。
  ⇒ 纯 CSS 画图（而非内联 SVG）这个选择在可编辑导出上是**正收益**，风险 4 应视为已证伪。
- **计划外发现（ADR-067 实现的真实缺陷，Phase D 的图上叠字版式才让它变得实质）**：
  `probe_overflow.py` 用 `--window-size=1280,720`，但 **`--window-size` 设的是外窗**——OS 装饰吃掉
  ~87px，**实际视口只有 1280×633**。于是 `elementsFromPoint` 在 **y ≥ 633 一律返回空栈**，
  探针静默退回**祖先链**——而 ADR-067 的立论正是「祖先链是错的方法，命中测试才对」。
  失效区恰是每页底部 12%：**脚注、页码、来源标注的聚集地**。
  两处修正：① 窗口改 `1280,900`（布局不受影响——slide 是固定 720 盒子）；
  ② 探针**自检视口**，装不下画布就 `exit 2` 报错，**绝不静默降级**（负路径实证：调回 720 确实报错）。
  另修 `imaged` 只认 CSS `background-image`、**认不出 `<img>` 元素**——S17 全幅图叠字在修复前
  3 个文字元素只有 1 个被标为不可判，修复后 3/3 全标（"宁漏报不误杀"的边界要一致才有意义）。
  **重测结论**：四例 369 元素的标定数值**逐位不变**（body 4.11 / large 2.54 / imaged 0），
  最紧的 duotone-vivid 也不变 —— 该缺陷在既有语料上是**潜伏**的（无覆盖层时祖先链恰好等价），
  但在新增的图上叠字版式上会给出错误数字。**"没走过的路径不会自己报错"第三次应验。**
- **测试**：`test-deckcraft-validate` 67 → **94/94**（新增 27 例：注册表 ≥20、素材版式集合、
  S17/S19 进 content-exempt、8 个新版式各有 STRUCT_CAPS、O11 七类输入、primary_count 认新主列表）。

### Phase E（2026-07-23，✅ 完成）

- **D6 渐变色标采样**：Chrome 会把 computed `background-image` 里的颜色一律规范化成 `rgb()/rgba()`，
  于是色标可读 ⇒ **把两端各当一个候选平底、各算一次对比度、按更差的那端判**。这不是猜测而是精确：
  文字沿着渐变**确实**压在每一个色标上。端到端实证（同一段浅字、同一个探针）：
  `#111111→#f5f5f5` 取**浅端** `#f5f5f5` → **1.02:1 判负**；`#111111→#2d2d2d` 取 `#2d2d2d` → 12.86:1 通过。
  标记是 `L-`（**已判定**）而非 `LI`（免判）——D6 之前两者都会整页豁免、静默放行。
- **gradient 进入 E4 白名单**（`ALLOWABLE = {shadow, gradient}`，`PENDING_ALLOWANCE` 清空）。
  **放开渐变不等于放开字面色**：色标同样只能 `var(--c-*)`，字面 `rgb()` 仍被 E1 硬拦（实证）。
- **`<img>` 保持为声明的盲区**（不做白黑包夹）：包夹是猜测，而猜错就是**误杀**——ADR-067 D3 明确
  把误杀列为代价最高的失败模式。改为把盲区**写进三处**：`layouts/_index.md`（S11/S17/S19 行）、
  `visual-review` R4（「这几页的对比可读性完全由本条判断，没有兜底」）、`checklist`。
- **测试**：`test-deckcraft-contrast` 46 → **52/52**。其中**一条既有用例被 D6 判定为语义过期并修正**：
  它拿 `linear-gradient(#fff,#eee)` 当"不可读背景"的替身来断言"渐变被跳过"——而那恰是 D6 要修的缺陷。
  改用真实 1×1 PNG 位图，断言才回到"只有真正读不了的才豁免"。另补两条视口自检守卫。
- **实施期又踩一次**：D6 的新用例首版把内层 div 写成 1280×720 塞进有 padding 的 `.slide` ⇒ 溢出 ⇒
  **溢出元素会跳过对比度测量** ⇒ 用例测到 0 个元素、断言拿到 `None`。已在夹具里写明这条交互。

### 深度 review（2026-07-24，用户要求"真机验收前先自动化验尽"）

在真机前用 fuzzing / headless 渲染 / 异地运行 / 系统排查把能机器验的验尽。**抓到 2 个新缺陷并修**：

- **S15 条形图满 cap（6 条）+ 页脚重叠 9px**（视觉走查抓到，**probe 溢出探针的盲区**——重叠不出界）：
  末条 label bot=669 压页脚 top=660。修 = bar 列 `gap:32→16`、`height:24→20`、`margin-top:48→40`；
  pad64（最坏几何）6 条实测**间隙回到 83px**。四个 shipped example 不含 S11–S20，故门禁基线不受影响。
- **对比度探针视口装饰是固定 87px，不是比例**（720→633、1400→1313，差值恒 87）：`--window-size` 900 只留
  93px 余量，且 Windows/Linux 装饰量本机测不了。改 **1280,1400**（余量 593px on macOS），让任何平台的
  固定装饰都无法侵入 720 画布；视口自检仍在，双保险。此前 Phase D 只把外窗从 720 提到 900，这次量化后加足。

**系统性验证（全部机器手段，非人眼主观）**：
- **门禁 fuzzing**：geometry_scale 全组合上下界 + O10 越界/非数值 + O11 七类脏数据（含 `isinstance(True,int)`
  布尔陷阱）+ registry glob + read_tokens 注释剥离 + pick_variants CLI 异常/特殊字符 —— **24 例全过**。
- **seed 跨机器可复现性**：同名项目 + 同主题在不同父路径下 → **同 `seed_digest`**（seed 只取目录名，
  与绝对路径无关）⇒ 客户机上候选顺序可复现。
- **端到端交叉走查**：mono-terminal 深底荧光等宽 × 全部 10 个新版式，真 Chrome 渲染 **probe 0/0**；
  且 outline 报 19 error（balanced 满格内容套 mono 紧几何）**证明 D5 的收紧在正确拦截**、而 probe 0 溢出
  又证明 D5 收紧偏保守不假通过 —— 两层一致。
- **bbox 重叠系统排查**：写包围盒重叠检测跑全 10 新版式满 cap → 修 S15 后 **0 重叠**；**并先验证检测器
  本身有效**（对已知的旧 S15 重叠抓到 194×17px），差点因验证脚本自己的 replace bug 误判"检测器假阴性"。
  副产物：证明 discussions/053 backlog 的 **R2 重叠可机器化**。
- **异地运行（Q：客户机打包）**：把 deckcraft 树复制到陌生路径 `/opt/app/resources/.../deckcraft` 跑全链，
  pick_variants/registry/example 门禁链全正常，`scripts/` **无开发机路径残留** ⇒ SKILL_DIR 相对定位无硬编码。
- **跨平台静态面**：无硬编码 `/tmp`（走 `tempfile`）、路径全 `Path`、Windows `CREATE_NO_WINDOW` 分支在、
  渐变解析 fail-safe（匹配不出颜色 → 退化为"标记不判负"不给错数）。
- **单/team 模式**：门禁与 agent 模式无关（纯 CLI+文件）；variants.json 写在项目目录、无跨会话状态冲突；
  question 既有缺口（team 委派不可达，discussions/053）**未加剧**。**补 SKILL.md**：question 不可用时退到
  `variants.json` 第一个候选（seed 相关、非固定值），并堵死"觉得不用问"的跳过借口。

三套测试终值：`test-deckcraft-validate` **96** · `test-deckcraft-contrast` **52** · `deckcraft-selftest` **48**。

**真机形式多样性 A/B 验收交用户**（形式丰富度是视觉/主观判断，按 Working Agreements 由用户判定）。
**监控点**：风格 10 选 1 后，若 Phase 3 question 被整轮跳过（discussions/053 §2.1），扩容会白做 ⇒
真机若觉改善不明显，先查提问轮是否被跳过，别急着再扩词汇表。

### 真实端到端走查（2026-07-24，补最大空白：没跑过真实生成流程）

前面所有验证都是"手工构造产物 → 过门禁"，从没验过"agent 照新文档从主题一步步生成"。补做：
以 agent 身份严格照新 SKILL.md 走一遍（FlowDesk 增长复盘 scenario · blueprint-tech 深底紧几何 ·
9 页含 S16/S15/S18/S12 四个新版式），**不手工构造、只照文档**。结论：

- **文档可遵循**：SKILL.md → outline-schema → spec-lock-format → design-styles/blueprint-tech →
  layouts/Sxx.html 全链无断链，文件都在、骨相表/契约可照抄、章节引用准确。
- **门禁正确引导 agent**（多处"教"我改正，每条精确可操作）：O2 缺讲稿×3（含封面/收尾/引言页）·
  O6 缺 breathing 页 · O9 evidence<3 · W1 偏离 8px 模数 · **D5 写完 tokens 重跑自动把 p≤42 收紧到 p≤38**。
- **新能力全部正确触发**（截图证实）：深底 `--c-head` 反转（标题冷白、`--c-primary` 只当底）·
  **grid-mark signature 是 16×16 方点、不是 swiss 的 48×8 横条 ⇒ 骨相 token 产出真实"骨相"差异** ·
  mono-display 等宽 · D5 char×0.92 · 新版式渲染 · Signature W4 · scenario E10 页脚。probe 9 页 0/0。
- **无新缺陷**：这轮没抓到 bug（不同于之前 S15 是构造测试抓的）—— 经前面几轮修复，端到端流程是干净的。
- **暴露一个设计权衡（非 bug，记为已知取舍）**：`pick_variants` 纯 hash 随机 + 强制跨温度档是**为破除
  "总是 swiss"的收敛**而设，**不做主题-风格匹配**。对"增长复盘"这种数据主题，随机把 paper-craft（手作）
  排到了候选第一。有真实用户时，用户看信号表解释会选对（本例我以"用户点名 blueprint-tech"走）；但
  **无交互 fallback 用 variants[0] 可能配出不贴主题的风格**。要不要在随机基础上加一点主题-温度加权，
  是产品取舍（牺牲一点破收敛换主题适配），留给用户定，不自作主张改。

## 明确不做

- **AI 配图三维系统**（ppt-master 20 渲染×14 配色×11 类型）：deckcraft 无 AI 生图通道，需先定 provider，属独立决策。
- **动画**：deckcraft 定位静态 deck，`content-guidelines.md` 已把逐元素入场动画列为 slop 指纹。
- **品牌 .pptx 模板旁路**（`skill_research/09` 的 C/E 路线）：SKILL.md §路由边界 已划给 ppt-master（curated 可安装）。
- **多样性硬门禁**：见 D7，撞脸是跨 deck 属性且涉产品语义，只做 warning + 可观测。
