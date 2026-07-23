# 052 — deckcraft 文本对比度：主观 R4 缺机器下界（真机暴露的浅字缺陷）

> 状态：✅ **已实现**（2026-07-23，ADR-067）—— 采方案①机器对比度门禁，双档阈值 2.3:1 / 1.8:1(large)，`scripts/test-deckcraft-contrast.py` 45/45。背景取**真实绘制栈**（`elementsFromPoint`）而非仅祖先链；读不懂的颜色语法计数播报不静默；通用性含 `tech-dark` 整份深底调色板；性能增量 +5.7ms/页（0.38%）。
> ⚠️ **本文 §2.1 的手算校准表已被实测取代**：对四例 369 个文本元素实测，合法最低值是 **2.57:1**（showcase 大号装饰数字），低于本文预测的 3.61 —— 若照本文把阈值定单档 2.3 会误杀它。权威校准数据见 ADR-067 D2。
> 日期：2026-07-23
> 触发：discussions/051（密度双边带 + delivery_purpose）Phase B **真机验收**时，A2（presentation 档《HTTP 缓存机制入门》）某页出现栏头浅字近乎隐形。
> 关联：discussions/051（同一「有主观检查、无机器下界」结构缺口——密度侧已补 O9/R3，对比度侧尚缺）· `references/visual-review.md` R4 · ADR-066

## 一、现象（真机产物，已见截图实证）

一页 **S04 两栏对比**「强缓存：Cache-Control vs Expires」：两个**栏头** `Cache-Control` / `Expires` 被模型染成近白色（`--c-on-dark` 那类浅字），却放在浅灰卡片 `--c-bg2` 上 → **对比度 1.10:1，几乎不可见**；同页下方的 bullet 正文是深色、正常可读，图标（蓝闪电/灰时钟）也在。

> 产物已被后续测试覆盖（同名 `.deckcraft/http-cache` 被中性 prompt B 的产物覆写），但用户桌面截图 `Screenshot 2026-07-23 at 11.46.29.png` 已留存该页；缺陷形态与对比度数值据此实证。

## 二、根因（代码 + 真实调色板双证）

- **模型现场偏离，非被示例带偏**：S04 栏头本该 `--c-primary`（深）配浅卡片 `--c-bg2`。`--c-on-dark` 是**只该用在 `[data-dark]` 深底页**的浅字，被误用到浅卡片上。
- **模板与 few-shot 都是对的**：`assets/templates/layouts.html` 的 S04 栏头示范即 `<h2 style="color:var(--c-primary)">`；三个内置 example（http-caching-primer / platform-migration-brief / product-launch-showcase）的 S04 栏头**全部** `--c-primary`（9.96:1）。即「正确模板 + 正确示例齐备，模型仍偶发偏离」。
- **本该拦它的是 `visual-review.md` R4「对比可读」**——但 R4 是**评审子代理的主观判断**，真机那轮被漏掉/略过。这与密度侧当初「有 R3 主观留白检查、但无机器密度下界」是**同一类结构缺口**：主观检查不可靠，缺一道机器门禁兜底。

### 2.1 对比度实测（WCAG 相对亮度，真实 token 值）

| 形态 | 前景/背景 | 对比度 | 判定 |
|---|---|---|---|
| **缺陷** 栏头浅字在浅卡片 | `#F3F8FC` (on-dark) on `#E8EDF2` (bg2) | **1.10:1** | 几乎隐形 |
| 缺陷（纯白极端） | `#FFFFFF` on `#EEF0F3` | 1.14:1 | 几乎隐形 |
| **有意 muted**（正文说明，应放行） | `#5A6B7B` on `#F6F8FA` | 5.16:1 | 正常 |
| 有意 muted（另一档） | `#6E8887` on `#FBF9F4` | 3.61:1 | 正常 |
| 有意 muted（showcase） | `#71717A` on `#FAFAFA` | 4.63:1 | 正常 |
| 正常栏头（模板正确做法） | `#1B3A57` (primary) on `#E8EDF2` (bg2) | 9.96:1 | 正常 |

**结论：分离带很干净**——缺陷 1.1–1.3 vs 有意 muted 3.6–5.2 vs 正常 9.96。**阈值取 ~2.0–2.5:1** 即可干净逮住缺陷、放行技能自身有意的 muted 样式（不误杀）。这直接决定了机器对比度门禁**高度可行、误报风险低**。

## 三、必要性

**有必要，优先级中，且与 Phase B（密度轴）正交**：
- 影响真实——栏头隐形使观众看不到关键标签（此例是「Cache-Control / Expires」两栏的名字）。
- 但目前低频、且已有主观 R4 名义兜底（只是不可靠）。属**对比度轴**，独立于 discussions/051 的密度轴，不应混入其分支。

## 四、三方案（按 probe 数据）

| 方案 | 做法 | 代价 | 力度 | 风险 |
|---|---|---|---|---|
| **① 机器对比度门禁（推荐）** | 扩 `probe_overflow.py`（本就在 Chrome 渲染）：逐可见文本元素取 computed 前景色 + 有效背景色，算 WCAG 对比度，< ~2.3:1 报缺陷（与 overflow 同样进 qa_report） | 中：~50 行注入 JS + 阈值 + 测试 fixture + 改 `visual-review.md`（R4 加机器门禁指针） | 强、确定性、覆盖**任何**低对比组合 | 阈值已 probe 校准（2.3 放行 muted 3.6+）；「有效背景」需处理透明祖先 / `[data-dark]` 深底 / 图片叠层，需谨慎 + 测试；大号装饰字（accent/大数字）走 WCAG large-text 宽限、低阈值下不误杀 |
| **② 定向 lint（便宜）** | `validate_deck.py` 静态查：`--c-on-dark` / 白色系颜色用在**非 `[data-dark]`** 祖先内即报错 | 低：~15 行 + 测试，无需 Chrome | 中、只逮「on-dark 用在浅底」这一类（恰是本次的错） | 窄——逮不到其他低对比组合（自定义浅 hex）；判任意 hex「是否浅」为启发式 |
| **③ 引导硬化（最便宜）** | references/模板注明「浅卡片标题只用 primary/text，on-dark 仅限 `[data-dark]` 深底」+ 强化 R4 措辞 | 极低：改文档 | 弱、软 | 模型本次已有正确模板 + 正确 example 仍偏离 → 纯引导不保险 |

## 五、建议

- **机器对比度门禁（①）是正解**：把 R4「对比可读」从主观评审升级为物理门禁，与 discussions/051 把密度从主观 R3 升为机器下界（O9）是**同一套路**。数据证明阈值分离干净，可行性高。
- 实施时按「先根因 + probe 阈值实验证明分离、再动码」的节奏（本文档已完成前半）。落地 = 扩 `probe_overflow.py` + 新增 `scripts/test-deckcraft-contrast.py` 校准/回归测试 + `visual-review.md` R4 补机器门禁指针。
- 想要即时安全网可先上 ②+③（定向 lint + 引导），①作为后续补齐。

## 六、实施时的验证判据

- 缺陷复现：手搭「on-dark 栏头在浅卡片」页 → 新门禁报缺陷（< 2.3:1）。
- 不误杀：三个内置 example + ai-coding-pilot 全部通过新门禁（muted 3.6+、正常 9.96 均放行），门禁链仍 0 error。
- 深底页正确：`[data-dark]` 页上的 on-dark 浅字（对深底 primary）对比充足、放行。
- 阈值边界：造 2.0 / 2.3 / 3.0 三档对照页，确认判定符合校准表。

## 七、附带观察（次要，非本缺陷）

中性 prompt B《HTTP 缓存机制入门》产物 `delivery_purpose` 落 **document**（非缺省 balanced）。若模型未主动问消费距离即选 document，说明「歧义时主动问」的推荐逻辑偏保守——但该主题推断成 document 不算离谱。属 delivery_purpose **询问策略**调优点，与对比度缺陷无关，留观察。
