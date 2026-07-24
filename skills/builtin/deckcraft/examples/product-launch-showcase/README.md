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

## 形式轴（ADR-068）：`tech-dark` × `mono-display` × **深底（唯一深底样例）**

**这是四例中唯一的深色底 deck**，也是它暴露了一个此前从未被验证过的缺口：
`--c-primary` 原本同时承担「深色底」与「浅底上的标题墨色」两个角色，**深色风格下二者互相矛盾**
（深字压深底 ≈ 隐形）。旧文档「深色风格把 `--c-bg` 设为深色即可」因此是错的——四例全浅底时无从发现。
修法 = 新增 `--c-head` 语义 token（标题/栏头/表头墨色，跟随风格深浅），`--c-primary` 退回只当背景与结构元素。

本例的深浅反转：`--c-bg`/`--c-primary` 深 ⇒ `--c-head`/`--c-text`/`--c-muted` **全部为浅色**。
骨相偏离基准处：等宽标题族（汉字必然穿透到黑体，预期行为）、32×6 短促 bar、.3em 开阔 kicker 字距。
