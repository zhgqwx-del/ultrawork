# examples/ai-coding-pilot — 完整实例工程（契约活样例 + 回归基准）

一个通过全部门禁的最小完整项目：10 页 deck、pyramid mode、瑞士-编辑部混合风格。
**双用途**：

1. **契约活样例**：写 outline.json / 页面片段拿不准格式时，Read 这里的对应文件
   （outline 展示了 takeaway/evidence/confidence/speaker_notes/scenario 的正确用法；
   pages/ 展示了 data-layout 片段与 CSS 变量纪律）。
2. **回归基准**：改动 scripts/ 或 shell/layouts 模板后，跑下面这条链应全绿：

```bash
EX=${SKILL_DIR}/examples/ai-coding-pilot
python3 ${SKILL_DIR}/scripts/validate_outline.py $EX     # 大纲门禁
python3 ${SKILL_DIR}/scripts/build_deck.py $EX           # 装配（10 pages）
python3 ${SKILL_DIR}/scripts/validate_deck.py $EX        # 结构门禁（0 errors）
python3 ${SKILL_DIR}/scripts/probe_overflow.py $EX       # 物理探针（0 findings）
python3 ${SKILL_DIR}/scripts/export_deck.py $EX --pdf --pptx   # 派生物
```

（Windows：`python3` 不存在时改用 `python`。）

注意：本 example 的 facts.json 与全部数据均为**演示用虚构语料**（scenario），
数据页带可见「示意数据/虚构」标注（validate_deck E10 硬校验）——这也是 scenario 规则的示范。
`deck.html` 与 `qa_report.json` **已入库作为字节级基准**：重跑上面的链应当不产生 git diff，
出现 diff 即说明脚本行为变了（这本身就是回归信号）。`export/` 目录不入库，
打包脚本（pack/fetch-builtin-skills）也按相对路径排除它——不会进分发 zip。
