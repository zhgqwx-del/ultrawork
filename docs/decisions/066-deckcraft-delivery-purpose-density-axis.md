# ADR-066: deckcraft 内容密度双边带 + delivery_purpose 消费距离旋钮（通用化，去「只有上界没下界」）

- 状态：Accepted（✅ 已实现：Phase A 引擎+文档 commit `ce1847ff` + 三层验证；Phase B 三档 example 门禁全绿+独立视觉审查 7/7×3，2026-07-22）
- 日期：2026-07-22
- 关联：discussions/051（完整根因五重实证 + probe 校准数值 + 方案 v2）、ADR-061（删内置 ppt-master，deckcraft 升为**唯一默认做 PPT 技能**——通用化缺口无退路的直接动因）、skill_research/01-04（4 库调研）、skill_research/09（被砍 depth 机制的综合方案）

## 背景

用户反馈两点：① deckcraft 产出「内容稍显单薄」；② 整条管线「处处上界没有下界，不通用吧？」。

**根因（已实证，非猜测，详见 discussions/051 §二）**：内容单薄的绑定瓶颈是 `validate_outline.py` 的 IR 字符预算——一套比物理现实紧约 2x 的**审美上界**，被无差别套用到所有 mode/style，且**只有上界、无内容下界**。真正的溢出守卫（物理探针 `probe_overflow.py`）反证：教学正文「超预算 2x」仍零溢出——26 是审美常数、非物理必需。ADR-061 删掉了本带 depth 机制的 ppt-master 后，deckcraft 成为唯一默认技能，教学/信息/学术密集型 deck **既被压薄、又无退路**——SKILL 自称「通用默认技能」实为通风高管 deck 专用，名实不符。

## 决策

不是「加一个教学模式」，而是把**单一通风制度**拆成两个**正交且普适**的旋钮 + 去偏的样例集。

### D1 — 字符/条目预算改 floor+cap 双边带，按 `delivery_purpose` 取档（`validate_outline.py` O8）
上界锚定「槽位在 1280×720 里物理能装多少」（probe 校准，见 051 §4.1.1），随消费距离取档；下界由结构条目数 + O9 承担。`p`/`points` 预算：presentation 26/30 · balanced（缺省）32/35 · document 42/42；S03 条数、S04 每栏条数、S10 行数同随档放宽。物理探针二次兜底不变。

### D2 — 顶层 `delivery_purpose`（消费距离）与 `mode` 正交
`presentation`（远观投影/airy）· `balanced`（缺省，近似今日观感、不回归）· `document`（近读讲义/密集）。**消费距离是任何 deck 都有的属性、与题材无关**——同一份教学 deck 投影版该通风、讲义版该密集。`mode` 只管叙事/页序/语气，**绝不碰密度**（零题材硬编码）。第 1 轮 question 按用户描述的消费距离信号推荐，**不由 mode 推定**。

### D3 — 补内容下界（与上界对称）
- **O9 dense 下界**（`validate_outline` 出 WARNING、`visual-review R3` 判负）：`rhythm:"dense"` 页须 **≥3 主列表项 且 ≥3 evidence**，否则「补点或换更密版式（densify）」。锚**条目/证据数、不锚字数**——防 thin→bloated 灌水凑字数。band 无关（各档一致）。
- **O3 断言检测器泛化**：从「说服式谓语白名单」扩到接纳教学/通报式结论（`looks_like_assertion`：数字 OR 断言谓语 OR 复合对偶句），如「内容敏感用 ETag，成本敏感用 Last-Modified」不再误判为裸标签。

### D4 — S04 双向错配修复（一行 + 补预算，非加版式）
`layouts.html` S04 骨架 `height:432px`→`min-height:432px`（固定高物理封顶 4 点）；`validate_outline` 补 S04 `points` 字符预算与每栏条目数（此前完全无预算=洞）。probe 实测放开到 5 点 0 溢出。**实测判定无需新增密集承载版式**（S03/S06/S10 现有骨架都装得下远超旧 cap 的密集内容，见 051 §4.3）。

### D5 — 补三档多样化 example，去 few-shot 高管偏（Phase B）
原仅 1 example（`ai-coding-pilot`，pyramid/高管说服）→ few-shot 把模型往高管腔带。补三例覆盖 mode × delivery_purpose × evidence 契约两端：
- `http-caching-primer`：instructional × **document**，全**真实**标准（RFC 9111/9110/5861 + MDN，`fact_id` 溯源）——密度「密」端。
- `platform-migration-brief`：briefing × document，全 **scenario**（内部通报，`scenario`/`user-doc`，每数据页 E10 「示意数据」页脚）。
- `product-launch-showcase`：showcase × **presentation**，明确**虚构产品**——密度「疏」端。
三例各门禁全绿（validate_outline 0 error / 0 O9 warning · validate_deck 0/0 · probe 0 findings）+ 独立视觉审查（无生成上下文）7/7。

## 影响 / 风险

- **可行性高、风险低**：全部落在 `skills/builtin/deckcraft/`（py + md + html 模板 + example），**不碰 vendor patch、不碰业务 TS**。放宽上界不失控（probe 兜底、repro 证 2x 仍零溢出）；default=balanced 不回归；反 slop 黑名单（与密度正交）保留。
- **正交缺口未加剧**：Team 委派下 deckcraft 的 question 门是**既有**架构缺口（gotchas §10⑪、delegate 只中继 permission 不中继 question），本次未加剧未修。
- **前向生效**：仅新生成的 deck 与新 example 受益；老 deck 需重跑门禁链。
- **committed sentinel**：新增 example 改变内置技能内容 → `skills/builtin/.builtin-version` 经 pack 权威 hash 重生成（对账不变式恢复，顺带治愈 Phase A 遗留漂移）。

## 验证

`scripts/test-deckcraft-validate.py` 26/26 · 真 Chrome A/B 证 S04 `min-height` 堵门禁洞（旧 `height` 令过量内容溢出卡片外、`overflow:visible` 使 probe 静默放行）· 三档 example 门禁链全绿 + 独立视觉审查 7/7×3 · `pack-builtin-skills.ts` 实跑重打（5213 文件 3.0MB zip，sentinel 变→客户可达）· deck.html 重建幂等。跨平台（`zoom`/`min-height` 三 WebView 通用）/ 单 agent ✅。真机密度 A/B（document 讲义 vs presentation 投影两版）验收交用户。
