# ADR-061: 自研 HTML-first PPT 生成技能 deckcraft（分阶段替换内置 ppt-master）

- 状态：Accepted（✅ P0 spike + P1 MVP + P1.5 完备度增强 + P2b 可编辑 pptx 已实现；验证期与 ppt-master 并存，P2b 真机验收通过后按 P3 删除内置 ppt-master——见 043 §十八）
- 日期：2026-07-18
- 关联：discussions/043（完整方案、spike 数据、四项目对照、路线图 SSOT）、ADR-040/041（被本决策分阶段替代）、ADR-033（产物识别）、ADR-037（跨平台）

## 背景

内置 ppt-master 两个不可调参修复的痛点：① 逐页手写 SVG + 串行 + 禁子代理/脚本（上游刻意设计）⇒ 单 deck 几十万 token、耗时长；② Strategist「八项确认」经 Flask :5050 外弹系统浏览器，与 app 原生 question-dock 割裂（ADR-040 D5 为保上游零改造而刻意保留）。调研 24+ 开源 PPT skill（五条技术路线）+ app 集成面核验后决定自研替换；真机首走查暴露「纯主题请求产出空心 deck」后，以 dashiAI/ppt-master/huashu/anthropics 四项目深度对照补齐内容工程（P1.5）。

## 决策

### D1 — HTML-first 单源 + 导出分叉（拒绝延续 SVG 逐页手写路线）
单文件 HTML（1280×720 固定舞台）为唯一真相源；PDF / 图片型 PPTX（2x 截图 + speaker notes，演讲者视图可用、交付明示不可编辑）均为派生物。提速三来源：HTML 生成基质 + 分批/并行生成 + 版式模板填充（S01–S10 骨架，registry SSOT=layouts.html）。一致性从「模型记忆」换「结构强制」：spec_lock 每批重读（唯一 HEX/字号来源，tokens.css 落地）+ CSS 变量门禁 + data-layout 契约 + page_rhythm + 多样性硬断言 + **首页门**（并行架构必需：先 1 页全链过门再扇出）。P0 spike 实证：10 页并行 ≤70s、契约 0 违规、视觉一致（B 臂 ppt-master 式串行外推 ~11min）。

### D2 — 内容工程一等公民（P1.5，治「只有样式没内容」）
**事实验证先于假设**：无源文档时 Research 阶段 MANDATORY（3-6 检索问题 × ≥3 轮联网 → `research/facts.json`，一条外部主张一个 `fact_id`）；outline 正文页强制 `takeaway`（断言句）/`evidence`（≥2 条引 fact_id 或标 `scenario:true`，scenario 页渲染可见「示意数据」标注）/`confidence`/`speaker_notes`；mode 叙事轴（pyramid/narrative/instructional/showcase/briefing）与视觉风格正交。**诚实占位 > 编造**（data/quote slop 硬拦）。门禁链：`validate_outline.py`（断言 lint/空话黑名单/fact_id 存在性）→ `validate_deck.py`（结构 E1-E8）→ `probe_overflow.py`（Chrome --dump-dom 物理溢出真值——本管线独有的便宜条件）→ 独立评审 R1-R8 rubric + 概念换名测试一票否决 → `qa_report.json` receipt 等式。

### D3 — 交互全走原生 question 工具（拒绝任何本地 web 服务）
两轮 question 封顶（澄清含 mode 确认 + 设计确认，文字描述式候选、推荐项置顶），question-dock 逐条渲染。代价=无色卡视觉预览，以「token 化主题换肤便宜 + 事后重渲染」对冲。

### D4 — 依赖面与资产
依赖 = `python3.10+`（source_to_md 拷贝件用 PEP604 注解）+ `python-pptx`（图片型导出）+ `chrome-or-edge`（headless 导出引擎，Rust `detect_export_browser` 探针；**同步义务：find_chrome.py 候选集 ⊇ Rust 清单**，绿徽标必须蕴含脚本可用）+ `node`（**可编辑 pptx `--pptx-editable` 专属，OPTIONAL 不 gate 就绪**；嵌入式 `~/.ultrawork/node` 优先、系统 node≥18 回退，`find_node.py`⇌Rust `get_node_path_internal` 同步）。资产：tabler-outline 图标 5039 个（grep 检索 + 内联 currentColor 走变量门禁）、`fetch_assets.py`（logo：simpleicons→favicon 链；真图：Wikimedia + 许可 manifest）。**P2b 可编辑 pptx（html2pptx）已实现**（Chrome 抽取 layout.json + Node/pptxgenjs 组装，无法翻译元素栅格化并诚实明示，043 §十八）；AI 生图/SVG 图表刻意暂缓（043 记档）。

### D5 — 工作目录点目录 + publish 交付（产物面板纯净）
项目目录 `.deckcraft/<name>/`（ADR-033 扫描整体跳过 dotdir，页面片段/截图/qa_report 等中间文件不进产物面板）；`export_deck.py --publish` 把 `<name>.html/.pdf/.pptx` 拷到工作区可见位置——产物面板只见最终交付物。

### D6 — 范围与 ppt-master 两步走删除（拒绝长期并存）
精简快线：只做「主题/文档 → deck」热路径；美化已有 pptx/模板填充/建模板/TTS/动画不重建（curated 自装 ppt-master 兜底；「美化」有明确扩展路径=IR beautify 1:1 锁定模式，依赖可编辑导出前置，见 043 §十四）。验证期 deckcraft **窄触发**（仅 deckcraft/快速PPT）与 ppt-master 并存；复走查通过后整体删除内置 ppt-master（043 §十五清单）——拒绝长期并存的决定因素：两技能 description 抢「做PPT」的触发冲突是结构性缺陷。`examples/ai-coding-pilot/` 为契约活样例 + 回归基准（门禁链全绿）。

## 影响

- 新增 `skills/builtin/deckcraft/`（SKILL.md 117 行 + references×10 + scripts×7 + 版式/图标/样例；MIT 来源入 NOTICE，AGPL 项目仅思路零代码）；zip 17252 文件/12.5MB。
- app 侧：Rust `detect_export_browser` + `check_skill_dependencies` 推 `chrome-or-edge`；`use-skill-deps.ts`/DEP_HINTS/测试/e2e mock 对应更新；`pack-builtin-skills.ts` JUNK 集 +`__pycache__`。
- 质量：P1 对抗审查 10 findings（9 CONFIRMED）全修（PDF transform 污染/依赖声明不足/双清单漂移/split 脆弱/字典序乱序/validate 误报族等）；套件 typecheck 8/8 · cargo 147 · desktop 671。
- 成功判据余项：token ≤1/3、墙钟 ≤1/2 的真机同题对比在复走查中定案。
