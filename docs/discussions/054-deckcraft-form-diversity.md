# 054 — deckcraft 形式同质化（「不同 prompt 除了颜色都长一样」）根因与形式丰富化方案

> 状态：📋 **方案已定，待实现（P1+P2+P3 全做；ADR-068）**
> 日期：2026-07-23
> 关联：ADR-061（删内置 ppt-master → deckcraft 成唯一默认做 PPT 技能）· ADR-066/discussions/051（内容密度双边带，**同类结构缺口的内容侧前作**）· ADR-067/discussions/052（对比度机器门禁）· discussions/053（deckcraft backlog）· 桌面 `skill_research/00,01,02,03,04,07,09`（7 库深度调研 + 综合方案）
> 触发：用户提问「这个技能实现是用了固定的模版么？不同 prompt 做的 ppt，除了颜色不同外，很多风格/布局都高度相似，这个是符合预期的么？」+「我期望 deckcraft 是个比较完备的技能，内容/形式的丰富应该是需要的吧？」

---

## 一、问题陈述

用户观察：**不同 prompt 产出的 deck，除颜色外风格/布局高度相似**。

两个待答问题：
1. 这是不是"用了固定模版"？
2. 这符合预期吗？一个"完备"的技能应该有形式丰富度。

---

## 二、结论先行

1. **是固定模版，且是硬门禁强制的**（不是软引导，模型无法绕过）。
2. **部分符合预期，部分是未被权衡到的副作用**：门禁的设计目标是 **deck 内部一致**（对抗并行扇出时的风格漂移），"deck 之间雷同"从未作为目标或代价被讨论过 —— discussions/053 backlog 中亦无此条。
3. **收敛来自 6 条独立的力，只加版式治不好**（详见 §四）。

---

## 三、架构事实（代码实证）

### 3.1 三层结构，两层写死，唯一变量层是 14 个 CSS 变量

| 层 | 文件 | 可变性 |
|---|---|---|
| 结构层 | `assets/templates/shell.html` | ❌ SKILL.md §脚本与资源 标注「**禁止改动**」 |
| 版式层 | `assets/templates/layouts.html` | ❌ 闭集 S01–S10，`validate_deck.py:233` E5 硬拦 |
| 变量层 | `<project>/tokens.css` | ✅ 7 个 `--c-*` + 7 个 `--fs-*` + `--font-stack` |

`spec-lock-format.md:46` 原文：tokens.css 是 deck 里**唯一**允许出现字面 HEX 的地方。
⇒ 跨 deck 的全部差异，在架构上被压缩到 **15 个 CSS 变量**。

### 3.2 版式是闭集且机器强制

```python
# scripts/validate_deck.py:133-138
def valid_layouts() -> set[str]:
    """Layout registry SSOT is layouts.html — parse it so adding S11 there
    can never desync this hard gate. Fallback: S01–S10."""
```
`:233` — `data-layout` 不在 registry 内 → `E5` error → exit 1，页面进不了下一步。**模型无法自创版式。**

> 好消息：registry 解析 `layouts.html` 是 SSOT 设计，**加 S11 自动生效、零改码**（注释明写）。扩容通道天生就在。

### 3.3 结构层写死了全部视觉指纹

```
shell.html:17  .slide{width:1280px;height:720px;padding:64px}   ← 版心恒 64
shell.html:19  .kicker{letter-spacing:.25em;text-transform:uppercase}
shell.html:21-24  h1/h2/h3 恒 700/700/500；p,li 恒 300 + max-width:36em
shell.html:27  .bar{width:48px;height:8px}                        ← 招牌笔触是全局类
```
swiss-minimal.md 称 accent bar 是「本风格的招牌笔触——少了它就不是这套系统」，但 `.bar` 是**所有风格共用的全局类**。⇒ 四套风格**没有任何结构差异**。

---

## 四、根因：6 条独立的收敛力（不只是"模版少"）

### ① 版式闭集 10 个，E7 反向逼迫用满

```python
# scripts/validate_deck.py:274-281
if len(pages) >= 8 and distinct < 6:      # ≥8 页须 ≥6 种不同版式
if run >= 3:                              # 禁连续 3 页同版式
```
E7 本意是防偷懒（guizang 的"反向约束"思路），但池子只有 10 个却要求用 ≥6 个 ⇒ **每份像样长度的 deck 都会用掉大半个词汇表**。加上 `outline-schema.md:92`「首页 anchor(S01)、末页 anchor(S08)、每 3-5 页一个 breathing(S02/S07)」，骨架基本定死。

**实测（四个内置 example 的版式序列）**：
```
ai-coding-pilot          S01 S03 S02 S04 S06 S05 S04 S03 S07 S08
http-caching-primer      S01 S03 S04 S10 S06 S03         S08
platform-migration-brief S01 S05 S10 S06 S04 S03         S08
product-launch-showcase  S01 S05 S03 S07 S04 S10         S08
```
首尾完全相同，中段是同一集合 `{S03,S04,S05,S06,S10}` 的排列。**用户观察到的现象，在官方 example 里已经复现。**

### ② 结构层全局硬编码 ⇒ 风格只能换皮不能换骨

见 §3.3。`spec-lock-format.md:60` 原文：「深色风格把 `--c-bg` 设为深色即可，**结构层不用改**」——这句话就是"只有颜色不同"的架构声明。

### ③ E4 把反-slop 黑名单实现成了全局硬门禁，比来源严格得多

```
# validate_deck.py 文件头 E4
E4 forbidden styling: gradient (incl. SVG <linearGradient>/<radialGradient>),
   box-shadow, italic, underline decoration
```
外加 `spec-lock-format.md:40` Forbidden 段禁「圆角卡片铺满网格」。

**与来源对照**：
- huashu 原文是**概率性**的：「想加渐变？→ **大概率**不加」。
- frontend-slides 的 Bold Signal 预设 `:root` 里**直接含** `--bg-gradient: linear-gradient(135deg,...)`（`skill_research/07` §6）。

deckcraft 把"风格级默认"升成了"全局物理禁令" ⇒ **砍掉整类视觉语言**。huashu 40 种风格库里相当一部分在 deckcraft 里根本合法不了。

### ④ 四套风格全是"安静/中性"档

现有：swiss-minimal（冷静克制）/ editorial-warm（沉稳人文）/ tech-dark（克制的锐利）/ academic-calm（学术沉稳）。**没有一套是"大胆"档。**

`skill_research/03` §6.1 明确点名这是「default 千篇一律」的根因，huashu 的对策是**故意让大胆款占多数**，理由：「对抗模型偏安静极简的确定性偏差」。

### ⑤ few-shot 本身在推向收敛（实测证据）

四个 example 的 `tokens.css`：
```
--font-stack : 四份逐字节完全相同（Helvetica Neue + Source Han Sans SC …）
--c-bg       : #FBF9F4 / #F6F8FA / #F7F7F5 / #FAFAFA   ← 全部近白
--fs-*       : 仅 ±4px 差异
```
**四例无一使用 tech-dark。** `typography-cjk.md` 明明给了衬线栈备选（Source Han Serif SC 一族），0/4 使用。

这与 ADR-066 Phase B 修的「few-shot 高管偏」是**同一个失败模式**（D5 已在内容/密度侧修过），但**配色/字体/风格这一侧当时没修**。

### ⑥ 选择规则确定性，无随机化、无剔重

`design-styles/_index.md` 结尾：「**拿不准时默认推荐 swiss-minimal（最不会错）**」。

对照 dashiAI（`skill_research/01` §6）在同一位置的做法：`layout:query` 给 Agent 的候选**每次随机排序**（回显 seed 可复现），SKILL.md 专门警告「不要固定只用列表第一条」，选页用 `hashSeed(seed:role:index)` 且**优先剔除已用 layout**。

---

## 五、与 4 个参考项目的丰富度差距（量化）

| 维度 | dashiAI | ppt-master | huashu | frontend-slides | anthropics | **deckcraft** |
|---|---|---|---|---|---|---|
| 版式 | **1020**（12 主题×~85） | 无闭集（手写 SVG） | 无闭集（手写 HTML） | 34 模板包 | 依赖模板 | **10（闭集+硬门禁）** |
| 视觉风格 | 12 主题 | **19** | **40** | 12 预设 + 34 模板 | — | **4** |
| 风格温度分布 | — | — | **大胆占多数** | Dark4/Light4/Specialty4 | — | **全安静/中性** |
| 配图 | 媒体工作流+装饰槽 | **20 渲染×14 配色×11 类型** | 真图+品牌资产协议 | 分级素材库 | — | logo/真图检索，无 AI 图 |
| 图表 | chart-safety 数值安全层 | page_charts+verify-charts | — | — | addChart 原生 | **无** |
| 字体 | 每主题独立 | 有 | 开源字体替代表 | **Font Pairing 表** | 打包 .ttf | **单一栈，四例全同** |
| 防撞脸 | **hashSeed+剔重+候选随机排序** | — | — | 3 预览混搭(1安全+1bold+1wildcard) | — | **无** |
| mode 叙事轴 | — | 5 | form 推导五问 | — | — | ✅ 5 |
| delivery_purpose | — | ✅ 3 档 | — | — | — | ✅ 3 档 |
| spec_lock 反漂移 | goal.json | ✅ | — | design.md | — | ✅ |
| 机器门禁 | goal-spec 校验 | 首页门/终局门 | Playwright | om-validate | validate.py XSD | ✅ **四道，含对比度物理门禁（独有）** |
| CJK | 视觉宽度 charLength | 有 | 强 | 每套 design.md 一节 | — | ✅ 强 |
| 可编辑 pptx | 混合保真 0.851 | SVG→DrawingML | html2pptx 1178 行 | — | OOXML | ✅ 尽力而为 |

**定位一句话：质量地基是这批项目里最扎实的一档，形式表达力是最弱的一档。**

### 5.1 对照 `skill_research/09` V0→V2 路线图的完成度

已做到（含超额）：progressive disclosure ✅ · spec_lock 每单元重读 ✅ · page_rhythm ✅ · mode 正交轴 ✅ · delivery_purpose ✅ · 反 slop 黑名单 ✅ · CJK 一等公民 ✅ · 概念一票否决 ✅ · 可编辑 pptx ✅ · **防溢出超出方案要求**（09 只要静态字符预算，deckcraft 做成了 Chrome 实测物理探针 + 对比度门禁）。

未做：**风格库仅 4 种（09 建议 3-5 起步，但配的是 19/40 量级的来源）** · **版式库 10 闭集** · AI 配图三维系统 · **原生图表 + 数值安全层（完全空白）** · 字体配对/打包字体 · **选择随机化**。

⇒ **deckcraft 已超额完成 V0，形式词汇表这一维停在 V0。**

---

## 六、方案（P1 / P2 / P3，用户已定：全做）

> ⚠️ 本节是**初版方案**。经一轮自查后有 4 处实质修正 + 3 处通用性修正，见 **§十**。
> 最终定稿以 **ADR-068 决策 D1–D7 + Phase A–E** 为准。

### P1 · 去收敛（不扩词汇表，只改选择规则与 few-shot）

| 项 | 做法 | 风险 |
|---|---|---|
| **P1.1 example 去同质** | 四例覆盖 4 套风格：≥1 例走 tech-dark 深底、≥1 例换衬线栈、≥1 例换等宽/几何栈 | ⚠️ **唯一有真实风险的一条**：ADR-067 的 2.3/1.8 阈值是拿这四例的 **369 个文本元素**标定的；换深底改变标定样本 ⇒ **必须重跑 `--dump-contrast` 复核阈值仍成立** |
| **P1.2 候选随机化** | ~~`_index.md` 写「3-4 候选随机排序呈现」~~ → **§十.1 已修正：必须落脚本 `pick_variants.py`** | ~~零~~ → 见 §十.1 |
| **P1.3 字体配对表** | `typography-cjk.md` 加 4-6 组中西配对（黑体/宋体/楷体/等宽，全开源可得），每风格文件指定默认配对 | 零（`--font-stack` 本就是 token） |

### P2 · 扩词汇表

**P2.1 版式 S11–S20**（10 个）：图文混排 hero / 三栏卡片 / 2×2 矩阵 / 流程链 / 纯 CSS 条形图 / KPI 网格 / 全幅图叠字 / 金字塔·漏斗 / 引用+人像 / 代码·终端。

每个的配套（缺一不可）：
- `layouts.html` 骨架
- `outline-schema.md` §content 结构按版式 一行
- `outline-schema.md` §字符预算 一行 + `validate_outline.py` `STRUCT_CAPS`/`primary_count` 分支
- **probe 实测标定**（⚠️ **ADR-066 教训**：字符预算必须实测标定，手算表被实测证伪过一次——052 手算预测 3.61、实测 2.57）

E7 需同步改：池子 20 个后「≥6 distinct」不再是有效约束 ⇒ 改成按页数比例。

**P2.2 风格扩到 8-12 套**，按 huashu 温度体系补"大胆"档。每套约 25 行 md（本身极便宜），**但必须逐套过对比度门禁**——深色与高饱和是 ADR-067 误报/漏报高发区。

**P2.3 图表能力**（当前完全空白）：纯 CSS / 内联 SVG 的条形·折线·占比图 + dashiAI 的**数值安全层**思路（`safeDenominator/safeMax/safeRatio`，根治脏数据渲成 NaN 几何）。注意 E4 禁 SVG 渐变 ⇒ 纯色填充。

### P3 · 松地基（用户已批准）

- **P3.1 结构层 token 化**：`--slide-pad` / `--bar-w,h` / `--kicker-transform` / `--kicker-spacing` / `--radius` / `--rule-w`。这是让风格有"骨相"差异的唯一办法。
  代价 = 改 `shell.html` + `spec-lock-format.md` + tokens 必填清单 + 四例回填 + 全门禁重跑。
- **P3.2 Signature Treatments**（frontend-slides 核心机制）：每风格一条"招牌笔触（非可选）"，用 `data-signature="…"` 做机器可检，接进 `visual-review` R8。
- **P3.3 E4 分级** ✅ **用户已拍板：降为风格级默认**。全局默认仍禁；风格文件可**显式声明**本风格允许某项（如 tech-dark 允许细微渐变底）。spec_lock Forbidden 段本就支持"可加风格专属禁项"，反向补"本风格显式允许"即可。

---

## 七、可行性 / 代价 / 约束

- **包体积**：版式是 HTML 文本、风格是 md，加 10+8 套约几十 KB。当前 25M 主要是 5039 个图标 ⇒ 无影响。
- **三平台**：纯资源文件 + Python 门禁，不碰路径/进程/外部命令 ⇒ 无跨平台风险。
- **不碰 vendor patch、不碰业务 TS**（与 ADR-066/067 同）。
- **pack 纪律**：ADR-061 血泪「pack 后禁再动 `skills/builtin/` 树」⇒ **一次性做完再 pack**，不可边做边 pack；`skills/builtin/.builtin-version` 须经 pack 权威 hash 重生成。
- **回归面**：`scripts/deckcraft-selftest.py`（489 行）· `scripts/test-deckcraft-validate.py`（166 行，26 用例）· `scripts/test-deckcraft-contrast.py`（431 行，34 用例）三套全须绿。
- **验收分工**：形式丰富度是**视觉/主观判断** ⇒ 按 Working Agreements 由用户做真机 A/B；机器侧负责门禁全绿、版式计数、对比度实测、测试不回归。

### License（`skill_research/09` §13 结论，已复核 deckcraft 现有 `NOTICE`）

| 项目 | License | 可做 |
|---|---|---|
| ppt-master | MIT ✅ | **可直接改编代码**（NOTICE 已声明借用 source_to_md/icons） |
| huashu-design | MIT ✅ | 可搬 design-styles 结构、色彩推导协议、字体替代表 |
| frontend-slides | MIT ✅ | 可搬 design.md 结构、Font Pairing 表、STYLE_PRESETS 的 `:root` 值 |
| anthropics/skills | 专有 | **只能借思路**（deckcraft 现状即如此，NOTICE 已写明） |
| dashiAI | AGPL ⚠️ | **不复制源码**。hashSeed 随机化是几行思路，自实现无传染 |

---

## 八、与前作的结构同构（为什么这是同一类缺口的第三次）

| # | 轴 | 缺口形态 | 修法 | 出处 |
|---|---|---|---|---|
| 1 | 内容密度 | 只有上界（审美字符预算）无下界 | floor+cap 双边带 + O9 机器下界 + 三档 example 去 few-shot 偏 | ADR-066 |
| 2 | 文本对比度 | 只有主观 R4 无物理下界 | probe 实测 painted 真值 + 实测标定双档阈值 | ADR-067 |
| 3 | **形式丰富度** | **只有一致性约束（E7/E4/固定结构层）无多样性下界；few-shot 同质** | **扩词汇表 + 选择随机化 + 结构层 token 化 + 风格级 E4 + example 去同质** | **本文 / ADR-068** |

三次都是同一个模式：**为对抗某个失败模式加的约束，同时压掉了对侧的表达空间；且"对侧"没有任何机器信号来提示它被压掉了。**

---

## 九、明确不做

- **AI 配图三维系统**（ppt-master 20×14×11）：deckcraft 无 AI 生图通道，`fetch_assets` 走的是真图/logo 检索。引入需先定生图 provider，属独立决策，不并入本次。
- **动画**：deckcraft 定位静态 deck（HTML/PDF/pptx 三形态皆静态），`content-guidelines.md` 已把"逐元素入场动画"列为 slop 指纹。不做。
- **品牌 .pptx 模板旁路（09 的 C/E 路线）**：SKILL.md §路由边界 已明确划给 ppt-master（curated 可安装）。不做。

---

## 十、方案自查：4 处实质修正 + 3 处通用性修正（2026-07-23，开工前）

用户追问「方案是完备的吧？会有什么副作用？」后做的自查。**结论：初版方案不完备**，其中 2 处会让方案直接失效或引入新缺陷。以下修正已并入 ADR-068 的 D1/D5/D6/D7。

### 10.1 【实质】随机化写在 md 里 = 本项目自己刚否定过的做法

初版 P1.2 是「在 `_index.md` 里写：候选随机排序、不要固定选第一个」。

**这正是 ADR-067 立论前提所否定的东西**——那份 ADR 原文：「本 ADR 前提是文档引导不可靠 ⇒ 把补救办法也写文档同样不可靠」。且 discussions/053 §2.1 已有真机实证：SKILL.md 明写的「第 2 轮 question」会被模型**整轮跳过**。

更根本：LLM 伪随机有强偏向，「自己随机选」≈ 选最熟的那个。dashiAI 能做到是因为 `layout:query` **是 CLI 脚本**，候选顺序由代码生成。

→ **修正（ADR-068 D1）**：新增 `scripts/pick_variants.py`，用 `项目名 + 主题` 做确定性 hash 伪随机（可复现、可回放），输出打乱后的候选与 seed，SKILL.md Phase 3 强制先跑。

### 10.2 【实质】骨相 token 与字符预算是耦合的，初版当成正交了

`DELIVERY_BANDS` 的 26/32/42 是在 **padding 64px / `--fw-body:300` / `--lh-body:1.65` / `--measure:36em`** 这组几何下 probe 标定的（`validate_outline.py:62` 注释）。P3.1 恰好让这四个全部可变 ⇒ 预算**偏乐观**。

后果不是崩，是**大量「过了 outline 门禁却被 probe 打回」的返工**——而 `validate_outline` 正是为消除这种返工而存在的（它是渲染前门禁，probe 是渲染后）。

→ **修正（ADR-068 D5）**：骨相 token 收敛成有限档位（每个 2-3 个合法值）；`validate_outline.py` 读 tokens.css 感知这四个 token 并折算预算系数；对**最紧组合**做 probe 实测标定。

### 10.3 【实质】放开 gradient 会让对比度门禁在那些页上完全失效（代码已证实）

```javascript
// probe_overflow.py:82   —— 祖先链上任一元素有 background-image 即置 imaged
if (cs.backgroundImage && cs.backgroundImage !== 'none') imaged = true;
// probe_overflow.py:295  —— imaged 元素被整体排除出判负
bad = [t for t in texts if t["ratio"] < floor_for(t) and not t["imaged"]]
```

`linear-gradient` 就是 `background-image` ⇒ 给 `.slide` 加渐变底会让**该页每一个文字元素**免于判负 ⇒ **ADR-067 那道门禁在渐变页上等于关闭**，它修的缺陷（浅字压浅底 1.10:1 几乎隐形）会原样复活且不报错。

初版 ADR 只写了「slop 风险回升」，**漏了这条**——这比 slop 严重得多，等于拿 ADR-067 换 ADR-068。

→ **修正（ADR-068 D6，用户拍板选"同期做"）**：probe 解析 `linear-gradient()/radial-gradient()` 色标，取**最差端**参与背景合成后照常判负；解析不了的语法与真实位图仍走「标记但不判负」（保 ADR-067 D3「宁漏报不误杀」）。阈值重标定 + 补测试。**gradient 放开不早于本条。**

### 10.4 【实质】方案自身没有"多样性下界"，重蹈 066/067 之前的覆辙

§八 刚总结「三次缺口都是只有一侧约束、对侧没有机器信号」，而初版 P1/P2/P3 **全是"扩容 + 放开"，没有任何机器信号检测「这份 deck 又退回默认档了」**。扩到 20 版式 12 风格后，模型完全可能照样输出 swiss-minimal + S01/S03/S04/S05/S08，而门禁全绿。

但这里有个**诚实的边界**：撞脸是**跨 deck 属性**，单份 deck 判不出来，而 deckcraft 无跨会话状态。

→ **修正（ADR-068 D7，用户拍板"加 W3 + qa_report"）**：
- 能做 = `validate_deck` W3（骨相 token ≥10 个等于默认值 → 警告「这份 deck 只换了颜色」）+ `qa_report.json` 记 `style_id`/骨相摘要/版式序列/`variant_seed`，让撞脸可事后核对。
- 做不到 = 硬门禁。写明为**已知边界**，不假装解决。

### 10.5 【通用性】E7 会逼着用素材依赖型版式，无素材时反而更差

新版式里图文 hero / 全幅图叠字 / 引用+人像都要图片。弱网或用户不给图时走「诚实占位块」，而 E7 要求 ≥6 种不同版式会**逼模型去用它们**，产出一堆「图片待补」占位框。

→ **修正**：E7 多样性计数排除素材依赖版式，或按 `images/` 实际内容动态调整。

### 10.6 【通用性】新版式对可编辑 pptx 的保真度未评估

`extract_layout.py` + `html2pptx/assemble.mjs` 逐元素翻译 DOM。CSS 条形图（`width:%` 的 div）、深层 flex 嵌套大概率整块栅格化，而 SKILL.md 承诺逐页报告「第 N 页含 M 个不可编辑元素」。

→ **修正**：每个新版式必须跑一遍 `--pptx-editable` 记录不可编辑元素数，超标的在文档里标注。

### 10.7 【通用性】`layouts.html` 是整份读入的，20 版式 = 上下文成本翻倍

现 132 行，加 10 个约 280 行。SKILL.md 的 progressive disclosure 纪律说「骨架只读需要的那一份」，但版式登记表是**一个文件**。

→ **修正**：拆 `layouts/_index.md`（一行一版式选型表）+ 按需读骨架片段。

### 10.8 通用性逐条判定（不宣称"整体通用"）

| 项 | 通用性 | 说明 |
|---|---|---|
| D1 随机化（脚本化后） | ✅ 完全通用 | 对所有 deck 生效，不改变任何产出约束 |
| D1 字体配对 / example 去同质 | ✅ 完全通用 | few-shot 对所有生成路径生效 |
| D3 骨相 token | ✅ 通用，且**是唯一让风格差异跨所有版式生效的一条** | 但有 10.2 的耦合 |
| D2 风格扩容 | ✅ 通用 | |
| D2 版式扩容 | ⚠️ **部分通用** | 偏向"有素材/有数据"的 deck；纯文字论述型受益有限 |
| D2 图表 | ⚠️ **不通用** | 只对有数据的 deck 有用（但填的是真空白） |
| D4 E4 放开 | ❌ **不通用** | 默认路径全禁、完全无感；只在用户明确要大胆视觉时有价值 |

### 10.9 需监控的副作用：与既有缺口**相乘**放大

discussions/053 §2.1 已实证「Phase 3 第 2 轮 question 会被模型整轮跳过」。风格从 4 选 1 变 12 选 1 后，一旦那轮被跳过、模型自选 ⇒ **回到确定性偏好，扩容白做**。这两个问题是相乘不是相加 —— 若真机 A/B 显示扩容无效，**先查提问轮是否被跳过**，别急着再扩词汇表。

### 10.10 回归风险量级

改动面约 **40 文件**，vs ADR-066 的 7 个、ADR-067 的 3 个 ⇒ 高一个量级。故拆 **Phase A–E** 各自可独立验证地落地（见 ADR-068 §实施 Phase），不一把梭。

---

## 十一、实施期发现（Phase A/B，写回本文以免只留在 ADR 里）

三条都不是计划里的，都是"做了才暴露"，且都印证本文主论点——**没有被走过的路径不会自己报错**。

### 11.1 `--c-primary` 在深色风格下角色自相矛盾（Phase A，D8）

它同时当「`data-dark` 页背景」与「浅底上的标题墨色」，深色风格下两者要求相反明度 ⇒ 深字压深底近乎隐形。
`spec-lock-format.md` 那句「深色风格把 `--c-bg` 设为深色即可、**结构层不用改**」是错的，
**但四个 example 全是浅底，这句话从未被执行过**。修法 = 新增 `--c-head`（87 处改写）。

### 11.2 「名义 token」——声明了却没人消费（Phase B，两次）

1. 四例里 **19 处招牌笔触是内联硬编码** `width:48px;height:8px`，**完全绕开 `--bar-w`/`--bar-h`**。
2. `--radius` / `--rule-w` 全仓 **0 处消费**，而 W3 把它们算作"已选择"⇒ 假信号。

**教训**：token 化是"声明 + 消费"两半，只做前一半会得到一个**看起来可配置、实际改不动**的系统 ——
这与本文要治的「只有颜色在变」是同一病因的不同层级。已接线（23 + 12 处）并写入 spec-lock-format / checklist。

### 11.3 CSS 注释里的 `*` `/` 连写会吃掉后续整段规则（Phase A，自己踩的）

在 `shell.html` 结构层注释里写 token 通配 `--sl-*` 紧跟 `/--fw-*` ⇒ 注释提前终止 ⇒
`.slide{height:720px}` 等被当垃圾吞掉 ⇒ probe 从 0 overflow 变 **69 overflow**、文本元素 114→78。
**症状是版面整体错位而非局部溢出**。定位法 = `git archive HEAD` 抽纯净副本跑同一门禁做 A/B。

### 11.4 一条方法论

三次都是靠**跑真实门禁 + 与纯净基线对拍**发现的，没有一次是靠读代码想出来的。
扩容类改动尤其要坚持"每步都过完整门禁链"，因为新增的表达空间正是旧假设失效的地方。

