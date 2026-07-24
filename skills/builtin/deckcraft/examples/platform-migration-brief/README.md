# examples/platform-migration-brief — briefing × document 档样例（scenario 数据）

一份通过全部门禁的进展通报 deck：7 页、`mode=briefing`、`delivery_purpose=document`（近读通报）。
**全部数据为演示用虚构值（scenario）**，不对应任何真实系统——用于示范三件事：

1. **briefing mode 的事实密度形态**：TL;DR 数据带 → 分域进度表 → 季度时间线 → 已完成/待协调 → 风险页，
   表格/时间线为主，中性事实语气。
2. **evidence 契约的 scenario/user-doc 端**：与 `http-caching-primer`（全真实标准、`fact_id` 溯源）
   形成对照——内部通报数据无公开 URL，用 `{"scenario":true}` / `{"source":"user-doc"}`，
   `research/facts.json` 为空数组。
3. **scenario 数据的诚实披露**：每个数据页（p2–p6）页脚渲染可见「示意数据」标注，
   `validate_deck` E10 硬校验其存在——绝不冒充真实数据。

与 `ai-coding-pilot`（balanced）、`http-caching-primer`（document 教学）、
`product-launch-showcase`（presentation）一起，把 deckcraft 从「高管说服单例」补成
mode × delivery_purpose 的多样样例集（去 few-shot 高管偏，discussions/051 Phase B）。

## 回归链（改 scripts/ 或模板后应全绿）

```bash
EX=${SKILL_DIR}/examples/platform-migration-brief
python3 ${SKILL_DIR}/scripts/validate_outline.py $EX   # 0 errors · 0 warnings（含 0 个 O9 warning）
python3 ${SKILL_DIR}/scripts/build_deck.py $EX         # 7 pages
python3 ${SKILL_DIR}/scripts/validate_deck.py $EX      # 0 errors · 0 warnings（E10 scenario 页脚校验通过）
python3 ${SKILL_DIR}/scripts/probe_overflow.py $EX     # 0 findings
python3 ${SKILL_DIR}/scripts/export_deck.py $EX --shots
```

（Windows：`python3` 不存在时改用 `python`。）

`deck.html` 与 `qa_report.json` 已入库作为字节级基准，重跑上面的链不应产生 git diff。
`export/` 目录不入库，不进分发 zip。

## 形式轴（ADR-068）：`editorial-warm` × `serif-full` × 暖浅底

**全衬线**（标题与正文同族，靠字重与字号分层）+ 暖纸底。骨相偏离基准处：bar 拉成 88×3 的
杂志式长细横线、kicker 只留 .08em 字距。Georgia/Cambria 跨平台可得性优于 Helvetica Neue，
中文侧 Windows 会退到 SimSun（见 `references/typography-cjk.md` §跨平台诚实标注）。
