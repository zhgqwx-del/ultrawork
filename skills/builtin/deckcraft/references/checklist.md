# QA checklist（能 grep 的规范才是能强制的规范；门禁按序全过）

> Windows：`python3` 不存在时改用 `python`（python.org 安装器只装 python.exe）。

## P0 — 硬门禁链（任一失败必须修复后重跑；顺序不可换）

```bash
# 1. 大纲内容门禁（HTML 生成之前——内容不够回 Research 补，不是硬编）
python3 ${SKILL_DIR}/scripts/validate_outline.py <project_dir>

# 2. 装配 + 结构门禁（首页门用 --single + --page N）
python3 ${SKILL_DIR}/scripts/build_deck.py <project_dir>
python3 ${SKILL_DIR}/scripts/validate_deck.py <project_dir>

# 3. 物理溢出探针（Chrome 实测裁切/出界，覆盖字符预算兜不住的情况）
python3 ${SKILL_DIR}/scripts/probe_overflow.py <project_dir>

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
