# ADR-067: deckcraft 文本对比度机器门禁（把主观 R4 升为物理下界）

- 状态：Accepted（✅ 已实现，2026-07-23）
- 日期：2026-07-23
- 关联：discussions/052（根因 + probe 校准数据 + 三方案对照）、ADR-066（密度轴——同一「有主观检查、无机器下界」结构缺口的另一半）、ADR-061（deckcraft 为唯一默认做 PPT 技能，质量兜底无退路）

## 背景

ADR-066 Phase B 真机验收时暴露一个与密度轴正交的缺陷：`presentation` 档某页 S04 两栏的**栏头**被模型染成 `--c-on-dark`（深底页专用浅字）却留在浅卡片 `--c-bg2` 上 —— 对比度 **1.10:1，几乎隐形**（截图实证，见 discussions/052 §一）。

**根因不是引导缺失**：`assets/templates/layouts.html` 的 S04 栏头示范是正确的 `--c-primary`，三个内置 example 的 S04 栏头**全部** `--c-primary`（9.96:1）。即「正确模板 + 正确 few-shot 齐备，模型仍偶发偏离」。本该拦下它的 `visual-review.md` R4「对比可读」是**评审子代理的主观判断**，真机那轮漏掉了。

这与密度侧当初「有 R3 主观留白检查、却无机器密度下界」是**同一类结构缺口**：主观检查不可靠，缺一道机器门禁兜底。ADR-066 用 O9 补上了密度轴的机器下界，本 ADR 补对比度轴。

## 决策

**扩 `probe_overflow.py`（它本就在 headless Chrome 里渲染每一页），逐可见文本元素实测 WCAG 对比度并设下界** —— 即 discussions/052 的方案①。不选方案②（`validate_deck` 静态查 on-dark 用在浅底）：它只逮这一种错法，逮不到任意自定义浅色；不单独用方案③（引导硬化），因为本次证明了纯引导不保险 —— 但引导仍作为便宜的补充一并做了。

### D1 — 测「painted 真值」，不测源码
前景取 `getComputedStyle().color`；背景是**合成值**：从元素向上遍历祖先，把每层 `background-color` 由外向内叠在不透明白底上。这是唯一能把「同一个 `--c-on-dark` 在 `data-dark` 深底页上正确、在浅卡片上是缺陷」区分开的做法 —— 静态 lint 做不到。祖先的 `opacity` 折进字色 alpha。

### D2 — 双档阈值，形状借 WCAG 的 large-text 宽限
`MIN_CONTRAST = 2.3`（正文）· `MIN_CONTRAST_LARGE = 1.8`（≥24px，或 ≥18.66px 且 bold）。

**阈值由实测标定，不由手算**：对四个内置 example 实测 Chrome 真正绘制的**每一个**文本元素（369 个），与缺陷值对照 ——

| 形态 | 实测 | 备注 |
|---|---|---|
| 缺陷（on-dark 浅字在浅卡片） | **1.10:1** | 28px h2，属 large |
| 合法 large 最低 | **2.57:1** | showcase 80px 橙色装饰数字压深青底 |
| 合法正文最低 | **3.12:1** | 14px accent kicker |
| 正确的 S04 栏头 | 9.96:1 | |

两档各自比「例子里合法的最低值」低约 1.4x，缺陷比 large 档还低 1.6x —— **两侧都不在刀刃上**。注意 discussions/052 §2.1 手算表预测的合法最低是 3.61，实测更低（2.57）；**若照抄手算表把阈值定在 2.3 单档，那个装饰数字就会被误杀** —— 实测这一步是必需的，不是仪式。

这是一条「人眼还看得见吗」的下界，**刻意远低于 WCAG AA 的 4.5** —— 门禁不该跟技能自己的 muted/accent 风格争论，只拦几乎不可见的。

### D3 — 判不了的不判
- 字色 `alpha == 0`（`background-clip:text` 渐变字一类的绘制技巧）→ 不测量。
- 任一祖先有 `background-image`（含渐变）→ 合成出的背景不是真值，**照常测量并在 `--dump-contrast` 里标 `I`，但绝不据此判负**。宁可漏报，不可拿猜测拦人。

### D4 — 与 overflow 同渠道，不新增门禁步骤
findings 走同一条命令、同一个 `qa_report.json`（新增 `contrast` 段，`overflow` 段结构不动）、同一个退出码（0 干净 / 1 有 finding）。门禁链仍是四步。新增 `--dump-contrast` 逐元素打印，供标定与排障。

### D5 — 引导同步硬化（便宜的补充，非替代）
`SKILL.md` Phase 5.2 明写「`--c-on-dark` 只能出现在 `data-dark` 页内，浅底标题/栏头用 `--c-primary`」；`visual-review.md` R4 补机器门禁指针，并把评审的职责收窄到「门禁放行范围内的观感」。

## 影响 / 风险

- 全部落在 `skills/builtin/deckcraft/`，**不碰 vendor patch、不碰业务 TS**；跨平台无新依赖（复用既有 Chrome 探针，Windows `CREATE_NO_WINDOW` 分支不变）。
- **误杀风险已由实测封顶**：四个内置 example 共 369 个文本元素全部放行。
- **前向生效**：老 deck 需重跑门禁链才受益。
- 新增 example / 换配色时若触到 2.3，应先看 `--dump-contrast` 判断是真缺陷还是调色板本身偏浅，**不要顺手调低阈值** —— 阈值的正当性来自上面那张实测表。
- 遗留（既有行为，非本 ADR 引入）：`probe_overflow.py` 每页 120s 的 Chrome 超时，在**连续大量启动** headless Chrome 时偶发触发。实测定位=测试套件一轮连开 ~40 个实例造成的资源争用；**单独探一份 deck 稳定（3/3）**，真实用法一次只探 7–14 页。故修测试脚手架（超时重试一次）而非放宽产品超时。

## 验证

`scripts/test-deckcraft-contrast.py` **34/34**：真实缺陷复现（实测 1.1:1，与 052 记录一致）· 同卡片正常正文/正确栏头/deliberate muted 全放行 · `data-dark` 页上同一个 on-dark 色判为正确（10.98:1，证明合成背景真的解析到了深底而非默认白）· 阈值边界 2.0 判负 / 2.6 / 3.0 放行 · large 宽限（同色 40px 放行、14px 判负，而缺陷 1.1 仍被逮住）· 透明字与图片底跳过 · **注入 JS 的亮度算法与独立 Python 实现逐元素对账**（防两侧任一悄悄漂移）· `qa_report` 写入与退出码 · 四个内置 example 零误报 exit 0。`deckcraft-selftest.py` 无回归。
