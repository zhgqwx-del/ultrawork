# examples/http-caching-primer — instructional × document 档样例

一份通过全部门禁的教学讲义 deck：7 页、`mode=instructional`、`delivery_purpose=document`（近读讲义）。
**这是 delivery_purpose 双边带的「密」端样例**——与 airy 的 `ai-coding-pilot`（默认 balanced）、
`product-launch-showcase`（presentation）形成密度三档对照，纠正「只有上界没下界」的高管偏。

**看点**：
1. **document 档的高密度承载**：正文页全部 `dense`，条目说明可长到 42 视觉宽（balanced 档 32、presentation 26）；
   S10 速查表 6 行、S03 每点更实——密不是错，是消费距离（对屏细读）驱动的主动选择。
2. **真实事实溯源**：全部 evidence 引用真实 Web 标准（RFC 9111/9110/5861 + MDN），`research/facts.json`
   带 `fact_id` + `source_url`；与 `platform-migration-brief`（全 scenario）形成 evidence 契约两端的对照。
3. **O9 dense 下界 warning-clean**：每个 dense 页 ≥3 主列表项 且 ≥3 evidence → `validate_outline` 0 warning。

## 回归链（改 scripts/ 或模板后应全绿）

```bash
EX=${SKILL_DIR}/examples/http-caching-primer
python3 ${SKILL_DIR}/scripts/validate_outline.py $EX   # 0 errors · 0 warnings（含 0 个 O9 warning）
python3 ${SKILL_DIR}/scripts/build_deck.py $EX         # 7 pages
python3 ${SKILL_DIR}/scripts/validate_deck.py $EX      # 0 errors · 0 warnings（W1 8px 模数亦 clean）
python3 ${SKILL_DIR}/scripts/probe_overflow.py $EX     # 0 findings
python3 ${SKILL_DIR}/scripts/export_deck.py $EX --shots
```

（Windows：`python3` 不存在时改用 `python`。）

`deck.html` 与 `qa_report.json` 已入库作为字节级基准，重跑上面的链不应产生 git diff。
`qa_report.json` 的 `visual` 段记录独立评审（无生成上下文）逐页 R1-R8 结果 = 全 pass。
`export/` 目录不入库（打包脚本按相对路径排除），不进分发 zip。
