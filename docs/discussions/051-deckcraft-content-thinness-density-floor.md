# 051 — deckcraft 内容单薄 / "只有上界没有下界" 根因与密度轴方案

> 状态：✅ **已实现（Phase A 引擎+文档 commit `ce1847ff` + Phase B 三档 example + 收尾，ADR-066）**
> 日期：2026-07-22
>
> **Phase B 落地（2026-07-22）**：补三档多样化 example 去 few-shot 高管偏——`examples/http-caching-primer`（instructional × **document**，全**真实**标准 RFC 9111/9110/5861 + MDN、`fact_id` 溯源，密度「密」端）、`examples/platform-migration-brief`（briefing × document，全 **scenario**、每数据页 E10「示意数据」页脚）、`examples/product-launch-showcase`（showcase × **presentation**，明确**虚构产品** Lumo，密度「疏」端）。三例各 7 页、门禁链全绿（validate_outline 0 error / **0 O9 warning** · validate_deck 0/0（W1 clean）· probe **0 findings**）+ 独立视觉审查（无生成上下文）**7/7 × 3** + deck.html 重建幂等 + `qa_report.json` visual 段字节稳定。`pack-builtin-skills.ts` 实跑重打（5213 文件 3.0MB zip，客户可达）；committed `skills/builtin/.builtin-version` 经 pack 权威 hash（`52ca1f324acb2b38`）重生成（对账不变式恢复，顺带治愈 Phase A 遗留漂移）。连同 `ai-coding-pilot`（pyramid × balanced）现有 4 个 example 覆盖 mode × delivery_purpose × evidence 契约两端。ADR-066 记双轴决策。
>
> **Phase A 落地（2026-07-22）**：已改 7 文件（全 `skills/builtin/deckcraft/`）——`scripts/validate_outline.py`（双边带按 `delivery_purpose` 取档 + S04 补 `points` 预算与条目数堵洞 + O3 泛化 `looks_like_assertion` + O9 dense 下界 warning）、`assets/templates/layouts.html`（S04 `height:432px`→`min-height:432px`）、`references/{outline-schema,content-engineering,modes,visual-review}.md`、`SKILL.md`（Phase 2 第 1 轮 question 增 `delivery_purpose`）。**三个开放决策已定**：① delivery_purpose 全局默认 `balanced` + 由消费距离信号推荐、**不绑 mode**；② 补 instructional+briefing+showcase 三例；③ O9 下界 = dense 页 ≥3 主列表项 且 ≥3 evidence → `validate` warning（band 无关，保持现状）+ `visual-review R3` 判负。**验证**：`scripts/test-deckcraft-validate.py` 26/26 · 真 Chrome 物理 A/B 证 min-height 堵门禁洞（旧 `height` 令过量内容溢出卡片外、`overflow:visible` 使 probe 静默放行）· `pack-builtin-skills.ts` 实跑重打（sentinel 变→客户可达）。跨平台/打包/单 agent 均 ✅；Team 委派 question 门是**既有**正交缺口（gotchas §10⑪）本次未加剧未修。**Phase B 待做**见 §四.四。
> 关联：ADR-061（删 ppt-master、deckcraft 升为唯一默认做 PPT 技能）· discussions/050（deckcraft 预览）· skill_research/01-04（4 库调研）· skill_research/09（被砍 depth 的综合方案）
> 触发：用户反馈「几次生成 PPT 最终产物内容稍显单薄」+「整条 deckcraft 管线为说服型/高管型 deck 调优、处处上界没有下界——不通用吧？」+「examples 够不够、要不要参考 dashiAI/ppt-master/huashu/anthropics 4 库」

## 一、问题陈述

两个疑虑：
1. **内容单薄**：deckcraft 产出的 deck 内容偏薄，怀疑 Research/调研不够，或过程中对内容做了限制/删减。
2. **非通用**：整条管线是否只为说服型/高管型 deck 调优（处处上界、无下界），因而不适合信息/教学/学术等密集型 deck。

用户要求：**先确认并验证根因，再定方案，先不改代码**（避免臆测导致错误方案）。

## 二、根因（已实证，非猜测）

一句话：**内容单薄的绑定瓶颈是渲染侧的 IR 字符预算（+结构上限+断言检测器），全部集中在 `scripts/validate_outline.py`；而它是一套比物理现实紧约 2.5 倍的"审美上界"，且被无差别套用到所有 mode/style。这不是 bug，而是一次设计收窄——源调研里存在的"内容深度/密度下界"机制，在综合方案（桌面 `skill_research/09`）那一步被丢弃，deckcraft 忠实实现了被砍过的方案，工程上还把上界压得更死。**

### 2.1 设计溯源：depth 机制是在 doc 09 被砍的（对照桌面 skill_research）

- **源调研本是"通用 + 有下界"的**：`02-ppt-master` 有"采集"式 research 阶段（`topic-research`，带 `深度` 参数，WebSearch/WebFetch **采集**素材而非仅核验）；有 `delivery_purpose = text/balanced/presentation` 三档**正文密度**杠杆（text=20px 密集文档档）；`instructional/briefing` 是**一等 mode**；§4.2 明写「学术/科学/工程/医疗图**可突破 150–300 词上限扩到 500–1000+ 词**」——这正是"信息型 deck 的内容下界"。`05-guizang` 甚至**预警**过：美学优先管线「**不适合大段表格、图表叠加、培训课件——美学优先牺牲了承载力**」。
- **doc 09 只继承天花板、丢了地板**：09 的 Phase 1 只有「事实**验证** WebSearch」（核验），没有 ppt-master 的「采集」；`mode` 降级为**可选 enum**、不接密度；`delivery_purpose` 密度档**整个没进 09**；§4.2 词数扩展无对应物。guizang 的警告 09 未理会。
- **当前实现 = 忠实执行被砍过的 09，还加码**：research 只有「拆 3–6 问 / ≥3 轮核验」（固定下限、无深度参数、无按类型加深）；五个 mode 在 `modes.md` 只改页序/语气/讲稿，`validate_outline.py` 的 `KEY_BUDGETS`/`STRUCT_CAPS` 是**模块级常量、不随 mode/style 变**——密度制度只有一套。

### 2.2 三层压上界、零层设下界（代码实证）

| 层 | 压内容上界的机制 | 位置 | 有无对应下界 |
|---|---|---|---|
| IR 门禁 | 每字段字符预算：`p`≤26 视觉宽(≈13 汉字)、`h`≤12、`title`≤18；条目数硬顶 S03 points≤4 / S06 nodes≤5 / S10 ≤5 行×4 列 / S09≤6 | `validate_outline.py` O8 / `STRUCT_CAPS` | ❌ 无"太薄"判负 |
| 物理探针 | Chrome 实测溢出即 fail | `probe_overflow.py` | ❌ 只拦多不拦少 |
| 视觉审查 | **R3：dense 页留白<20% 判缺陷**（最密页也≤80%填充） | `references/visual-review.md` | ❌ 无"页太空"判负 |
| 版式词汇 | S01–S10 每槽是短标签或"一句说明"，**无多段落/密集正文版式** | `assets/templates/layouts.html` | ❌ 结构上无法表达一段有实质散文 |

唯二的"下界"是字号下限与版式多样性下限（≥6 种版式）——后者反而把内容摊得更薄。反 slop 黑名单（赋能/抓手…）防的是空话、与密度正交，**保留**。

### 2.3 repro 实测（本次做的对照实验，产物在 scratchpad）

构造一份**按真实教学丰富度自然书写、未向预算妥协**的 instructional outline（主题「HTTP 缓存机制入门」，7 页，facts.json 齐备以隔离出纯密度/结构 bite），跑**未改动的**门禁：

- `validate_outline.py` → **exit 1，17 个 error**：
  - **13 个是 O8 `p` 预算**：教学正文自然长度 36–70 视觉宽（均 ~57），预算 26 → **每句被迫压 ~2.3–2.7 倍**。这是"单薄"的直接、确定性成因。
  - 1 个 S10 表 6 行被拒（cap 5，一张常用响应头速查表放不下 6 个头）。
  - 3 个 O3「takeaway 是裸标签」：教学式结论（「内容敏感用 ETag，成本敏感用 Last-Modified」）被 `ASSERTION_HINT` 正则漏判——它只认说服式措辞（数字/提升/领先/超过），漏教学式的"A 用 X、B 用 Y"。
- **物理探针反证**：把同样这 4 段 57–66 字密集正文手搭成 S03 页 → `build_deck.py` OK → `probe_overflow.py` **0 findings**，截图**渲染干净、左栏整片留白、离溢出很远**。
  - ⇒ **26 是审美上界、不是物理必需**（内容"超预算 2.5 倍"仍零溢出）。真正的溢出守卫（probe）放行。**放宽 IR 预算是安全的**——probe 仍兜底。

**主导因子结论**：绑定瓶颈 = `validate_outline.py` 的 IR 字符预算（主）+ 结构上限 + 断言检测器（次）。

### 2.4 research 供给侧实测（补测①）：非绑定因子

真跑 3 轮 WebSearch（技能规定下限）on HTTP 缓存：**3 轮即得 ~16 条可溯源事实**（按"3–6 问"轻松 30+）。而 deck 在当前门禁下的**吸收容量**：~5 正文页 × ~4 点 × 13 汉字 ≈ **全 deck 仅 ~260 字正文** + ~2 evidence/页 ≈ 10–14 条引用。⇒ **研究供给几乎瞬间在渲染门禁上饱和**，即使研究深 3 倍每点仍只显示 ~13 字。

结论：research 深浅**不是"单薄"的绑定因子**（与物理探针 0 溢出一致）。它影响的是另外两轴：①事实正确性/具体度、②广度（撑起多少不同页）——而广度又被"用户选的页数档位 + 一页塞不下就拆页"另行节流。**边界**：冷门/私有无网络资料的主题，research 可能真薄 → 诚实占位正确触发，属合理的另一种场景、非本缺陷。

### 2.5 examples 单一 + 4 库对照（补测②③）

- **全技能仅 1 个 example**：`examples/ai-coding-pilot/`，`mode=pyramid`、受众"研发中心管理层"、10 页高管说服 deck。`modes.md` 定义 5 mode 却只示范 1 种 → few-shot 把模型往高管腔带（**实践层的偏见来源**）。
- **4 库借鉴排序（针对"通用增强"目标）：ppt-master > dashiAI > huashu > anthropics**（详见 skill_research/01-04）：
  - **ppt-master**（最高，一库供齐三目标）：20+ 覆盖 5 mode 的完整实例（目录形状 = deckcraft `examples/` 已有的 outline/spec_lock/tokens/pages/export）；`delivery_purpose`（text 20 / balanced 24 / presentation 32 px → 正文字号+页密度+页数推荐）；`page_rhythm`；fit-to-box 有下界（body−4px、仍溢出报 warning 不重构）。
  - **dashiAI**（密度地板机制）：每槽 `Math.max(floor, Math.min(cap, base×k))` **floor+cap 双边带**，锚定"槽位物理容量"（以 demo 文案实际长度反推，非拍脑袋常数）；超预算补救=**"换更密的版式"**（deckcraft 现仅"改短"）。
  - **huashu**（谨慎摘取）：白皮书/信息图按产出类型的密度预设 + "容量估算"提问；整体审美优先偏留白，只摘点子别搬人设。
  - **anthropics/skills**：本目标用处最小（无示例、无密度分层），留作可编辑 pptx OOXML 参考。

## 三、是不是缺陷

**是，且是产品级缺口**：ADR-061 已删 ppt-master（那个本带 depth 机制的技能），deckcraft 成为**唯一默认做 PPT 技能**。于是教学/参考/信息密集型 deck **既被压薄、又无退路**。SKILL.md 自称"通用默认技能"，实际被调优成通风高管 deck 专用——**名实不符**。

## 四、方案 v2（通用化，非场景打标签，未实现）

设计目标（用户明确）：**整体增强 deckcraft 的通用性与内容效果，不是给它加一个"教学模式"**。因此核心不是"按 mode 分档"，而是把**单一通风制度**拆成两个**正交且普适**的旋钮 + 去偏的示例集。

### 4.1 两旋钮通用设计（取代原"按 mode 给密度默认"）

| 旋钮 | 借鉴 | 性质 | 作用 |
|---|---|---|---|
| **① 物理适配硬门**：把 `KEY_BUDGETS`/`STRUCT_CAPS` 从 cap-only 改成 **floor+cap 双边带**，上界锚定"槽位在 1280×720 里物理能装多少字"（用 probe 反推校准，而非拍脑袋 26） | dashiAI `Math.max(floor,Math.min(cap,…))` | **硬**、对所有 deck 一视同仁 | 逼近物理现实（repro 证 ~57 字都不溢出），probe 兜底。**去掉审美上界**、加**内容下界** |
| **② 消费距离软预设** `delivery_purpose: presentation / balanced / document` | ppt-master `delivery_purpose` | **软**、普适属性（非题材） | 调默认正文字号 + 目标密度 + 页数推荐；airy 是它*主动追求*的结果，非内容被砍 |

**为什么通用**：消费距离（投影远观 vs 当文档近读）是**任何 deck 都有的属性**，与 mode(pyramid/教学/发布…) 正交。同一份教学 deck，投影版该通风、讲义版该密集——由消费距离驱动而非题材。**mode 仍只管叙事/页序/语气，不碰密度 → 零题材硬编码**。default 走 `balanced`（近似今日观感、不回归）。

#### 4.1.1 双边带实测数值（probe 校准，取代早前"~40–48"估值）

对 S03/S04/S06/S10 各造密集压力页、build + probe 实测（本机 tokens.css：body 21px / caption 14px；建议 cap 留 ~20% 头寸以吸收 Linux CJK 字体差异——门禁量盒不量字形）：

| 版式 | 槽位 | 当前 cap | **实测物理承载** | 建议 cap（presentation / balanced / dense） |
|---|---|---|---|---|
| S03 | 点数 | ≤4 | 4×57字 0 溢出 | 4 / 4 / 5 |
| S03·S06 | 点/节点 `p` 字符（视觉宽） | ≤26 | **S03 57、S06 45 均 0 溢出**（≈2x 太紧） | 26 / 32 / 42 |
| S06 | 节点数 | 3–5 | 5 0 溢出 | 5 / 5 / 5 |
| S10 | 行数 | ≤5 | **8 行 0 溢出**（≈1.6x 太紧） | 5 / 6 / 8 |
| S10 | 列数 | ≤4 | 4（实质内容）0 溢出 | 4 / 4 / 4 |
| S04 | 点数/点字符 | **validate 完全未预算**（`points` 不在 KEY_BUDGETS） | 固定高 432px→封顶 4；**改 `min-height`→5 点 0 溢出** | 骨架改 min-height；validate **补** S04 points 预算 4 / 4 / 5 × ~35 字 |

**两个结构性发现**：
1. **"无需加新版式" 已从 n=1 升到 n=4 实证**：S03/S06/S10 现有骨架都装得下远超当前 cap 的密集内容，**不需要 4.3 的新版式**。
2. **S04 是唯一例外，且成因是双向错配**：validate **根本没给 S04 的 `points` 设预算**（漏洞，可无限长），而骨架的固定 `height:432px` 又**物理封顶 4 点**。修法=骨架 `height:432px`→`min-height:432px`（一行，实测放开到 5 点 0 溢出）+ validate 补 S04 points 预算堵漏。**不是加版式**。

### 4.2 配套（补下界 + 去偏，均通用）

3. **`dense` rhythm 加内容下界**：今天只有 `breathing` 有下界（R3 ≥50% 留白），`dense` 无下界。给 `dense` 页设"≥N 点 / 每点≥M 字"的软下界；`visual-review R3` 增 dense 页**内容过稀**判负（与"留白<20%"对称）。
4. **O3 断言检测器泛化**：从"说服式谓语白名单（数字/提升/领先）"改为"是否真结论 vs 光秃话题词"，接纳教学/通报式结论（"A 用 X、B 用 Y"）。
5. **"内容太薄→换更密版式"补救**（dashiAI 反向 remedy）：validate 对过稀页建议 densify，而非只会"改短"。
6. **补 2–3 个多样化 example**（ppt-master 模式）：在现有 `examples/` 形状下加 **instructional（教学）** + **briefing（数据/信息通报）**（+可选 showcase）——这两类最密、最直接对冲高管偏见；去 few-shot 偏。

### 4.3 密集承载版式 —— 实测判定：不需要
7. **4.1.1 的 n=4 probe 已判定：无需新增版式**。S03/S06/S10 现有骨架装得下远超当前 cap 的密集内容；唯一撞墙的 S04 是骨架固定高 + validate 漏预算的双向错配，一行 `min-height` + 补预算即可，不是加版式。若未来出现真·多段落散文需求（现 layouts 无此槽），再单独评估——但当前方案不含。

### 4.4 各改动落点（文件级）
- `scripts/validate_outline.py`：`KEY_BUDGETS`/`STRUCT_CAPS` 改双边带 + 按 `delivery_purpose` 取档 + O3 泛化 + 过稀 remedy。
- `references/outline-schema.md`：§字符预算 cap-only → floor+cap 带 + `delivery_purpose` 字段。
- `references/modes.md` / `content-engineering.md` §四：加消费距离说明 + "容量估算"提问（借 huashu）+ §4.2 学术扩词下界。
- `references/visual-review.md`：R3 增 dense 过稀判负。
- `assets/templates/shell.html`：`document` 档正文字号档（若需）。
- `SKILL.md` Phase 2：第 1 轮 question 增 `delivery_purpose`（给默认，不加轮次）。
- `examples/`：+2–3 个 deck。

## 五、可行性 / 风险 / 值不值

- **可行性：高**。全部落在 `skills/builtin/deckcraft/`（md + py + html 模板 + example），**不碰 vendor patch、不碰业务 TS**。4.1/4.2 主要是 `validate_outline.py` 一个文件 + 文档 + 示例。
- **风险：低**。物理探针 + 视觉审查仍在；放宽上界不会失控（repro 证 probe 兜底）；default=balanced 不回归；反 slop 黑名单保留（与密度正交）。
- **值不值：值**。把"名为通用、实为高管专用"的默认技能修正为**真通用**（ppt-master 已删、缺口无退路）；两旋钮 + 多样 example 是产品能力补齐，非审美偏好。

## 六、验证判据（实施时）

- repro `HTTP 缓存教学 deck` 在 `document` 档下 `validate_outline` 从 17 error 降到 0（或仅合理项），`probe_overflow` 仍 0 findings。
- `presentation`/默认档不回归：现有 `ai-coding-pilot` 仍 exit 0、观感不变。
- 新增 instructional/briefing example：各档 exit 0 + probe 0 + 视觉审查过。
- 反 slop（空话黑名单、scenario、占位拦截）在所有档位不失效。
- 真机视觉：dense 讲义 deck 与 airy 高管 deck 各一份，用户判"信息量够 + 不拥挤"。

## 七、未决 / 待用户拍板

- ~~双边带取值~~ **已 probe 校准，见 4.1.1**；实施时仅需按 Linux CJK 字体再验一次头寸。
- ~~是否需要新密集版式~~ **已实测判定：不需要（见 4.3）**。
- `delivery_purpose` 默认策略：全局默认 balanced，还是按 mode 给推荐默认（pyramid→presentation、briefing→document）后仍可覆盖？
- 补几个 example、哪些 mode（建议 instructional + briefing）。
- `dense` 内容下界锚**实质（点/证据数）**而非字数的具体阈值（防 thin→bloated，见五·负作用①）。
