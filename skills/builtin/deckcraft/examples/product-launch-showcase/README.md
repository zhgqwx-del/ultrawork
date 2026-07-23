# examples/product-launch-showcase — showcase × presentation 档样例（虚构产品）

一份通过全部门禁的产品发布 deck：7 页、`mode=showcase`、`delivery_purpose=presentation`（投影远观）。
**产品「Lumo 口袋投影仪」为明确虚构**（品牌 Lumo Labs），规格/价格/引言全为演示用虚构值（scenario）。

**这是 delivery_purpose 双边带的「疏」端样例**——正文最短（`p` ≤26 视觉宽）、每页要点最少（S03 ≤4）、
留白最多。airy 是 presentation 档**主动追求**的亮点节奏，不是内容被砍。与 `http-caching-primer`
（document 密集，`p` ≤42）恰好构成消费距离两极；`ai-coding-pilot`（balanced，≤32）居中。

**看点**：
1. **presentation 档的通风节奏**：悬念开场 → 大字规格冲击（S05）→ 一页一亮点（S03）→ 用户引言换气（S07）
   → 对比（S04）→ 规格表（S10）→ CTA（S08）。短促标题（≤8 字）、大数字优先。
2. **mode × delivery_purpose 正交**：`showcase` 决定页序与语气，`presentation` 决定密度——两轴独立。
3. **虚构产品的诚实披露**：每个数据页页脚带「示意数据 / 虚构产品」标注（E10 硬校验），引言署名标（示意）。

## 回归链（改 scripts/ 或模板后应全绿）

```bash
EX=${SKILL_DIR}/examples/product-launch-showcase
python3 ${SKILL_DIR}/scripts/validate_outline.py $EX   # 0 errors · 0 warnings（含 0 个 O9 warning）
python3 ${SKILL_DIR}/scripts/build_deck.py $EX         # 7 pages
python3 ${SKILL_DIR}/scripts/validate_deck.py $EX      # 0 errors · 0 warnings
python3 ${SKILL_DIR}/scripts/probe_overflow.py $EX     # 0 findings
python3 ${SKILL_DIR}/scripts/export_deck.py $EX --shots
```

（Windows：`python3` 不存在时改用 `python`。）

`deck.html` 与 `qa_report.json` 已入库作为字节级基准，重跑上面的链不应产生 git diff。
`export/` 目录不入库，不进分发 zip。
