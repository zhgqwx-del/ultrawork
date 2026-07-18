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

注意：本 example 的 facts.json 与全部数据均为**演示用虚构语料**（scenario），
数据页页脚带可见标注——这也是 scenario 规则的示范。
产物（deck.html/qa_report.json/export/）由上面命令现生成，不入库。
