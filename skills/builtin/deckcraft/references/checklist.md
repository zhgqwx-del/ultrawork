# QA checklist（能 grep 的规范才是能强制的规范；门禁按序全过）

> Windows：`python3` 不存在时改用 `python`（python.org 安装器只装 python.exe）。

## P-1 — 设计锁定前（Phase 3 第一步，别凭印象挑风格）

```bash
python3 ${SKILL_DIR}/scripts/pick_variants.py <project_dir> --topic "<主题>"
```
- [ ] 第 2 轮 question **按 `variants.json` 的 `styles`/`font_pairings` 顺序原样呈现**（顺序已被脚本打乱）
- [ ] `tokens.css` 写全：8 个 `--c-*`（含 `--c-head`）· 7 个 `--fs-*` · `--font-stack`+`--font-display` · 12 个骨相 token
- [ ] 深色风格（`--c-bg` 深）：`--c-head`/`--c-text`/`--c-muted` 必须**全部反转为浅色**，`--c-primary` 留在底色家族
- [ ] 骨相值**从风格文件的「骨相 token」表抄**，四个耦合项只取标定档位（否则 O10 报错）
- [ ] **写完 tokens.css 重跑一次 `validate_outline`** —— 它这时才能读到几何、给出真实预算
- [ ] 版式：先读 `assets/templates/layouts/_index.md` 选型，再只读本批要用的 `Sxx.html`（禁 glob 全目录）
- [ ] Allowances：可放开 `shadow` / `gradient`（逐项写进 spec_lock 标记 + 写明理由）；渐变色标仍只能用 `var(--c-*)`
- [ ] **图上叠字页（S11/S17/S19）：机器测不了对比度**（图片内容不可读，只标记不判负）⇒ 这几页必须人工过 R4
- [ ] Signature：spec_lock 写 `Signature id`，且 ≥1 页带 `data-signature="<id>"`（W4）；招牌笔触用 `class="bar"` 承载，**不要内联硬编码尺寸**（会绕开 `--bar-w/--bar-h`）

## P0 — 硬门禁链（任一失败必须修复后重跑；顺序不可换）

```bash
# 1. 大纲内容门禁（HTML 生成之前——内容不够回 Research 补，不是硬编）
python3 ${SKILL_DIR}/scripts/validate_outline.py <project_dir>

# 2. 装配 + 结构门禁（首页门用 --single + --page N）
python3 ${SKILL_DIR}/scripts/build_deck.py <project_dir>
python3 ${SKILL_DIR}/scripts/validate_deck.py <project_dir>
#    出 W3 = 骨相 token 缺省过半，这份 deck 只换了颜色 → 回 tokens.css 补写（写值=已选择）

# 3. 物理探针（Chrome 实测）：裁切/出界 + 文本对比度下界（覆盖字符预算与主观 R4 兜不住的情况）
python3 ${SKILL_DIR}/scripts/probe_overflow.py <project_dir>
#    报 CONTRAST 行 = 该文本几乎不可见。两个高发因：--c-on-dark 浅字放到了浅底上（改用 --c-head/--c-text）；
#    深色风格里标题仍用了 --c-primary（深字压深底——改用 --c-head，它才是跟随风格深浅的墨色）
#    python3 ${SKILL_DIR}/scripts/probe_overflow.py <project_dir> --dump-contrast   # 逐元素实测值，调试用

# 4. 残留兜底
grep -rniE "lorem|ipsum|待补充|\[insert" <project_dir>/pages/   # 应无输出
```

## P1 — 视觉审查（独立评审，见 visual-review.md）

```bash
python3 ${SKILL_DIR}/scripts/export_deck.py <project_dir> --shots
```

- [ ] R1-R8 rubric 逐页有 verdict（receipt 等式：verdict 数 === 页数）
- [ ] `fix` 页只改定位/间距，回炉 ≤1 轮；`needs_human` 如实列给用户
- [ ] 概念终审：换名测试（失败 = 内容空心，回大纲层，禁止视觉修补掩盖）

## P2 — 内容终审

- [ ] 每页标题是结论句；scenario 页有可见「示意数据」标注
- [ ] 用了 fetch_assets 真图的页：许可要求署名的已在页脚 credit（查 images/assets-manifest.json）
- [ ] low-confidence 页清单准备好放进交付报告

## 交付

```bash
python3 ${SKILL_DIR}/scripts/export_deck.py <project_dir> --pdf --pptx   # 按用户所选形态
```

- [ ] 交付报告：产物路径 + qa_report 摘要 + low-confidence/scenario 声明 + 「pptx 为图片型（含讲稿 notes）」明示
