# 043 — 自研 HTML-first PPT 技能（替换内置 ppt-master）

> 状态：**P0 spike ✅ · P1 MVP ✅（对抗审查 10 findings 全修）· P1.5 完备度增强 ✅（四项目对照，见 §十七）· 00/09 蓝图终审 ✅（examples/ + line-break 补齐）· 产物面板纯净化 ✅（.deckcraft 点目录 + --publish）· ADR-061 已转正 · 待真机复走查** · 2026-07-18
> 关联：ADR-040/041（ppt-master 内置与 zip 分发）· [discussions/025](./025-builtin-ppt-master-skill.md)（ppt-master 打包调研）· ADR-033（产物识别）· ADR-037（跨平台）
> 外部调研输入：本地文档集 `~/Desktop/skill_research/`（00 全景 + 01~07 七项目深度拆解 + 09 完备技术实现方案；调研 24+ 个 PPT skill 项目、五条技术路线坐标系）——**本地资料，不入 git**（public 仓库），本文引用其结论时自包含复述。
> 已拍板：主形态=HTML 为源 + pptx 导出分叉 · 范围=精简快线 · 确认交互=原生 question（文字描述式）· ppt-master=两步走删除（先并存验证后删干净，curated 自装保留为长尾退路）。

---

## 一、缘起与痛点

内置 ppt-master（ADR-040，pin v2.12.0）真机使用暴露两个核心痛点：

| 痛点 | 现象 | 根因（均为上游**刻意设计**，不可调参修复） |
|---|---|---|
| **A 慢** | 单次完整 deck 生成耗时长、几十万 token | SKILL.md 全局纪律 6-9 钉死：主 agent **逐页手写 SVG**、串行、禁 sub-agent、禁脚本批量生成（上游试过脚本路线并放弃——跨页一致性依赖每页带完整上下文手写）。ADR-040 当年即记为「已知代价」 |
| **B 交互差** | Strategist 阶段外弹网页（Flask 绑 `127.0.0.1:5050`，`webbrowser.open` 拉起**系统默认浏览器**）做「八项确认」两层向导；chat fallback 是一次性抛 8 项确认，非逐条 question dock | ADR-040 D5 **刻意不改** question dock（视觉候选卡片是设计确认质量核心 + 用户自装 raw upstream 会行为分叉）；「app 内嵌 webview 承载」列为后续特性至今未做 |

结论：两痛点与 ppt-master 核心架构选择直接冲突，**只能换架构自研**，无法在 ppt-master 上参数化解决。

## 二、调研关键事实（决定方案形态的六条）

1. **原生 question 工具链现成，零 app 改动**：vendor `tool/question.ts` 在 `EAGER_BUILTINS`（免 tool_search）；`Question.ask()` 阻塞挂起 → SSE `question.asked` → 前端 `question-dock.tsx` 逐条渲染（单选/多选/自定义输入/推荐项，`N/M` 步进）→ `replyQuestion` 回传。IM 渠道（gateway bridge）也已接同族事件。**skill 只需让模型调 question 工具**。
2. **系统浏览器探测现成**：Rust `detect_chrome()`（`lib.rs:2687`）三平台 Chrome/Chromium 路径清单，Windows 真机验证过（Browser MCP 链路）。Chrome 原生 `--headless --screenshot / --print-to-pdf` CLI ⇒ 导出**不需要 Node/Playwright**。
3. **打包链路现成**：自写技能放 `skills/builtin/<name>/`（参照 `doc-edit` 样板，不经 fetch 脚本）→ `pack-builtin-skills.ts` 自动入 `skills-builtin.zip` → 首启解压 `~/.config/ultrawork/skills/builtin/`，OpenCode 原生 skill 机制按 frontmatter `name` 发现。
4. **产物识别无障碍**：`scan_workspace_changes`（ADR-033）是 mtime 文件系统扫描、不限扩展名，HTML/PDF/pptx 均自动进产物面板。
5. **依赖徽标体系现成**：`use-skill-deps.ts` `DepMap` + Rust 探针（`check_skill_dependencies`），ppt-master 的 `python3.10+`/`python-pptx` 探针可直接复用。
6. **长尾有退路**：ADR-040 阶段 2 已把 ppt-master 加进 curated 自助安装（`INSTALLABLE_SKILLS`）。**删除内置 ≠ 能力永久消失**，需要美化/模板填充/TTS 的用户可设置页自装。

外部调研核心结论（skill_research 09）：五条技术路线（A 截图型 / B DOM 翻译可编辑 / C 模板填充 / D 纯 HTML / E 原生 OOXML）中，**「惊艳视觉」与「可编辑+品牌合规」是矛盾两极**；推荐自研主线 = **D 为源（HTML-first 单源）+ A/B 作 pptx 导出分叉**；一致性靠结构化契约（spec_lock 每页重读 + data-layout 版式契约 + page_rhythm）而非模型记忆。

## 三、已拍板决策汇总

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | 主形态 | HTML 为源 + pptx 导出分叉 | 提速根本靠换生成基质；单源多衍生物 |
| D2 | 范围 | 精简快线（热路径：主题/文档→deck） | 长尾由 curated 自装 ppt-master 兜底 |
| D3 | 确认交互 | 原生 question 工具（文字描述式候选） | 零 app 改动、彻底去 5050；代价=无色卡/字体样张视觉预览（接受；不满意可事后换肤重渲染） |
| D4 | ppt-master 去留 | 两步走：P1 独立触发词并存验证 → 验证通过**整体删除** | 并存的结构性缺陷=触发冲突（两技能 description 都抢「做PPT」，模型选错则痛点复发）；curated 自装兜住长尾 |
| D5 | 依赖面 | python3 + 系统 Chrome/Edge（零 Node） | 复用现有探针 + `detect_chrome`；比 ppt-master 还轻 |
| D6 | pptx 可编辑性 | P2a 图片型先行；可编辑（html2pptx）为 P2b 可选升级 | 精简快线下先补齐「能交 pptx」；2b 是全案最大单项工程 |

## 四、目标与成功判据（P1 验收）

| 痛点 | 目标 | 判据 |
|---|---|---|
| A 慢 | 显著提速降耗 | 同一 12-15 页任务真机对比：**token ≤ ppt-master 的 1/3，墙钟 ≤ 1/2** |
| B 交互 | 全程原生问答 | 零本地 web 服务、零外弹浏览器；澄清/确认全走 question-dock |
| 质量 | 不低于 ppt-master 观感 | 用户真机视觉验收（视觉判断归用户） |

**非目标**（精简快线）：美化已有 pptx（→ §十四扩展路径）、模板填充、建模板、TTS、动画——curated 自装 ppt-master 兜底。

## 五、架构与管线

```
Phase 0 路由（长尾请求礼貌拒绝 → 指引设置页自装 ppt-master）
→ Phase 1 内容规划：source_to_md 转换 + 一轮 question 澄清 + 产出 outline.json (IR)
→ Phase 2 设计锁定：一轮 question 设计确认 + 写 spec_lock.md
→ Phase 3 生成：按 spec_lock + HTML 版式模板并行填页 → 拼单文件 HTML
→ Phase 4 导出：Chrome headless 截图 → PDF / 图片型 pptx
→ Phase 5 QA：校验脚本 + grep 占位符 + 缩略图自检（返工上限 2 轮）
```

单一真相源 = 单文件 HTML（固定舞台 1280×720 + 整体缩放），PDF/pptx 都是一行命令的派生物。

## 六、交互设计（question 编排，替代「八项确认」）

压缩为**两轮、每轮一次 question 调用**（question 工具原生支持一次多问、dock 逐条步进）：

- **第 1 轮（澄清，3-4 问）**：受众与目的 / 页数档位 / 交付形态（HTML / PDF / pptx）/ 内容侧重。有源文档时能推断的不问。
- **第 2 轮（设计确认，2-3 问）**：风格方向（3-4 个文字描述式候选，写具体含类比，如「瑞士极简——大留白、单强调色、无卡片网格」，推荐项置顶标注 (Recommended)）/ 配色气质 / 图片策略（AI 生成 / 不配图 / 占位）。
- SKILL.md 铁律：**禁止起任何本地 web 服务/Flask**；两轮之外不再阻塞提问，其余决策自决并在产出时说明。

## 七、契约设计（一致性的结构保障）

- **outline.json（IR）**：页级 `index / role / visual_type / page_rhythm(anchor|dense|breathing) / title / body / image_slot`；schema 校验与防溢出前移到 IR 层。
- **spec_lock.md**：canvas / 颜色（**唯一 HEX 来源**）/ 字号 ramp / 字体链 / 间距模数 / forbidden 清单 / 逐页 rhythm 表。**每页生成前重读**（继承 ppt-master 被验证的对抗上下文压缩漂移机制）。
- **HTML 侧**：CSS 三层 token（`:root` 变量块 = 主题，换肤 = 换值）+ 每页 `data-layout="Sxx"` 版式契约（供校验脚本断言）+ 6-8 个版式骨架（cover / section / bullets / 两栏对比 / 三卡 / 时间线 / 引用 / 数据页）。
- **反偷懒约束**：12 页至少 6 种版式；不许连续 3 页同结构；`breathing` 页禁卡片网格。

## 八、提速设计与 P0 spike

提速三来源：① 生成基质 SVG→HTML（模型写 HTML 快且稳）；② **并行/分批生成页**（打破 ppt-master 规则 6-9）；③ 版式模板填充替代从零手写。

**核心赌注**：把一致性从「靠模型记忆」换成「靠结构强制」（§七契约）后，并行生成不飘。此为全案唯一真风险，**P0 spike 先行验证**（1 天级）：

- 手搓最小 spec_lock + 2 套版式模板 → 并行生成 10 页 → 检查漂移（配色/字号/版式跑偏、同质卡片化）+ 记录 token/耗时 vs ppt-master 同题实测。
- **判据**：漂移可被契约约束住 → 按方案推进；否则退回「分批串行（每批 3-4 页）」重估提速幅度后再定。

### P0 spike 实测结果（2026-07-17，✅ 赌注成立）

实验设计：同题（「AI 编程助手落地实践」10 页汇报）、同模型两臂对照。A 臂 = 10 个并行 subagent，各自只拿 spec_lock + 8 个版式骨架 + 自己那页的 IR 条目（无共享上下文）；B 臂 = ppt-master 式逐页手写 1280×720 SVG（串行 2 页实测外推，B2 带 B1 成果做连续性上下文）。

**一致性（核心判据，✅ 通过）**：
- 程序化检查 **0 真违规**：全部颜色/字号来自 spec_lock 变量（无任何字面 hex/rgb/渐变/越 ramp 字号）、无禁用特性（script/style/box-shadow/斜体/下划线）、版式指派 10/10 命中、8 种版式无连续重复（9 条报警均为检查器误报——2px 线宽/11px 圆点对位，模数规则本不约束线宽）。
- 接触表视觉检查：10 页配色/字体层级/页码/kicker 语言完全统一，breathing 页（3/9）留白正确，无一页「像另一套 deck」；无溢出/重叠。
- 结论：**「结构强制替代模型记忆」的赌注成立**——契约（spec_lock + 版式骨架 + data-layout）足以让无共享上下文的并行生成保持一致。

**速度**：A 臂 10 页全部落盘 ≤ 70s（单页 12-48s，并行）；B 臂单页 75s / 57s（均值 66s，串行）→ 10 页纯生成外推 ~11 min。**并行 A ≈ 9-10× 于串行 B**；且 B 臂对 ppt-master 显著有利（fresh context、无 Strategist/确认/预览/质检管线开销、SVG 比真实 ppt-master 页简单），真实差距更大 ⇒ 提速结论方向保守可信。

**token（spike 边界，留待 P1 定案）**：两臂单 agent 均 ~41-43k tokens，差异被固定开销（system prompt + 契约文件读取）淹没；且 B 臂 SVG 偏简（2.5-3.2KB vs 真实 ppt-master 页常 8-20KB），输出 token 差距未充分显现。**token ≤1/3 判据无法在本 harness 干净验证，移交 P1 真机同题对比**。

**两条 P1 必须复核的 harness 差异**（spike 用 Claude Code subagent + Fable 5，≠ app 内 OpenCode runtime）：
① app 内并行手段待确认——opencode 的 task 子代理可用性/并发度，不可用则退「单 turn 批量生成」（提速降档但仍显著，因免去 ppt-master 逐页纪律开销）；
② app 内常用模型（qwen 系）的单页生成质量需真机复核。

单页质量：B 臂手写 SVG 与 A 臂模板填充**成色相当**（对照截图已存），HTML 路线未损失单页质量。spike 产物：scratchpad `spike-pptx/`（deck.html / 接触表 / 基线 SVG 对照，已交用户视觉验收）。

## 九、依赖面（比 ppt-master 还轻）

**新 skill 依赖 = python3（已有探针）+ 系统 Chrome/Edge（`detect_chrome` 已有）。零 Node、零 Playwright。**

- 截图/PDF：系统 Chrome headless CLI；建议 Rust 探测扩一条 Edge（装了 WebView2 的 Windows 必有 Edge，headless 兼容）。
- 图片型 pptx 组装：python-pptx 贴图（复用 ppt-master 已建的 `python-pptx` 探针）。
- 徽标接入：`use-skill-deps.ts` `DepMap` 加一行 + Rust 加 chrome 探针 command（包装 `detect_chrome`），改动面小。
- P2b（可编辑 html2pptx）才需要 Node + pptxgenjs——届时可评估用嵌入式 Node（`~/.ultrawork/node/`，Browser MCP 已铺好）承载。

## 十、导出设计

- **P1**：单文件 HTML（主产物）+ PDF（Chrome headless `--print-to-pdf` 或逐页截图拼装）。
- **P2a**：图片型 pptx（Chrome 逐页截图 + python-pptx 贴页；交付时**明示「图片型，文字不可编辑」**）。
- **P2b（可选升级）**：可编辑 pptx——html2pptx DOM 元素级翻译（借鉴 huashu-design MIT ~1200 行：getComputedStyle+getBoundingClientRect 逐元素译成 pptxgenjs 文本框/形状；4 条 HTML 硬约束、渐变栅格化、视觉驱动 HTML 转换率 <30% 需明示取舍）。
- 产物落点：工作区 `projects/<name>/export/`，`scan_workspace_changes` 自动捕获。**待真机验证项**：HTML 产物在产物面板的内嵌预览效果（若可内嵌预览，体验将优于 ppt-master 的 5050 live preview）。

## 十一、app 集成面

- **打包**：`skills/builtin/<name>/`（名称待定，候选 `deckcraft` / `quick-deck`）；自写技能不经 `fetch-builtin-skills.ts`，改动自动被 `pack-builtin-skills.ts` 的 hash 检测重打包。
- **触发词**：验证期独立名字 + 显式触发词（如「快速PPT」/ 直呼技能名），避免与 ppt-master 抢触发；删除 ppt-master 后 description 放宽接管「做PPT / 生成PPT / 演示文稿 / slides / deck」全触发面。
- **复用资产拷入新 skill 自带**（MIT，为删除 ppt-master 做准备）：`source_to_md/` 全套转换脚本、`pptx_intake.py`（§十四美化路径的前置，几乎零成本顺手带上）、图标库**按需裁剪子集**（不搬全部 1.1 万个）、`image_gen.py`（AI 配图；key 约定沿用 `~/.ppt-master/.env` 或新 skill 自己的 `~/.<name>/.env`）。

## 十二、质量门 / CJK / 跨平台

**质量门（MVP 档，能 grep 的规范才是能强制的规范）**：

```
[ ] IR schema 校验（页数/字段/visual_type 白名单）
[ ] 防溢出：字符预算在 IR 层硬拦（CJK 视觉宽度：全角 1、半角 0.5）
[ ] data-layout 合法性 + 版式多样性断言（脚本可执行）
[ ] 内容 QA：grep 占位符残留（lorem|TODO|示例|[insert）
[ ] 视觉 QA：Chrome 截图缩略图栅格过一眼（溢出/重叠）
[ ] 返工 ≤2 轮，超限报 warning 停手
```

**CJK 一等公民**：fallback 链西前中后（`"Geist","Noto Sans SC","PingFang SC"` + Windows `Microsoft YaHei` 兜底）；`font-synthesis:none` 防假斜体；数字 `tabular-nums`；直角引号；字重对比替代字体切换；标题按长度降档 + `min(Xvw,Yvh)` 双约束限高；打包 1-2 个 OFL 中文字体进 `assets/fonts/` 兜离线。

**跨平台（ADR-037）**：脚本全 `pathlib`/`path.join`、不硬编码 `/tmp`；Chrome 探测三平台路径清单；Windows `python3`→`python` 回退；Chrome headless CLI 参数三平台一致。

## 十三、分阶段路线图

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 spike** | 并行一致性 + 提速幅度实测（§八） | §八判据；数据回写本文档 |
| **P1 MVP** | SKILL.md + 版式/风格库 + question 编排 + HTML/PDF 导出 + QA 脚本 + 徽标接入；与 ppt-master 并存（独立触发词） | §四三判据 + 用户真机视觉验收 + 对抗审查 + typecheck/CI 绿 |
| **P2** | 2a 图片型 pptx 导出；2b 可编辑按需评估 | pptx 三平台 PowerPoint/WPS 打开无损；真机验收 |
| **P3 删除** | 整体删 ppt-master（§十五清单）+ 新 skill description 放宽接管全触发面 + 文档收尾 | check-docs 绿 + CI 三平台绿 + 安装包体积回归（约 -7MB） |

## 十四、扩展路径：美化已有 pptx（Phase 3+，可选）

当前方案**不支持**美化已有 pptx（非目标，curated 自装 ppt-master 兜底），但架构天然兼容，未来想做时不需要重新设计：

```
已有 pptx → ppt_to_md.py + pptx_intake.py 抽取（内容/图片/版面几何/主题色）
→ outline.json 带 mode: beautify（页数/页序/文字逐字 1:1 锁定，只重排版）
→ 走同一套 spec_lock + HTML 模板生成 → 导出
```

增量成本小（IR 加 beautify 模式 + 路由加一条判别问题「保留原页数页序和文字，还是当素材重构？」，其余全复用）。**真正的门槛是输出形态**：美化输入是可编辑 pptx，P2a 图片型输出=「给你可编辑的、还我一堆图片」，明显减分 ⇒ **做好美化 ≈ 把 P2b（可编辑导出）从可选提为前置依赖**，而 2b 是全案工程量/风险最大单项。

**触发条件**：验证期观察美化类请求真实频率——高频 → P2 后优先 2b + beautify；低频 → 永远留在 curated 自装退路上。P1 已顺手拷入 `pptx_intake.py` 留门。

## 十五、删除 ppt-master 工程清单（P3）

- `skills/builtin/ppt-master/` 整树删除（53MB / 1.2 万文件）+ `pack-builtin-skills.ts` 自动重打 zip。
- `scripts/fetch-builtin-skills.ts`：移除 ppt-master 条目与 `applyPptMasterPatches`。
- `use-skill-deps.ts`：删 `"ppt-master"` 行（`python3.10+` 探针 deckcraft 仍在用必须保留；`python-pptx` 探针视 P2a 是否已接 python-pptx 决定去留）。
- deckcraft `SKILL.md` 路由边界表 + frontmatter description：删除对 ppt-master 的「已安装则交给它」措辞，统一改为「可在设置安装 ppt-master」指引，并放宽触发面接管「做PPT」全意图。
- curated `INSTALLABLE_SKILLS` 的 ppt-master 条目**保留**（长尾退路）；遮蔽机制（`reconcile_builtin_shadowing`）通用于全部 builtin，保留。
- 文档收尾：gotchas §10 相关条目复核、requirements/architecture 状态表、CHANGELOG、本文档状态更新、ADR 转正。

## 十六、风险与开放问题

| 风险 | 等级 | 缓解 |
|---|---|---|
| 并行一致性不成立 | 中 | P0 spike 前置；退路=分批串行 |
| 文字式设计确认损伤选型质量 | 低-中 | 候选描述写具体含类比；HTML 源 + token 化主题使「事后换风格重渲染」便宜 |
| 用户机器无 Chrome/Edge | 低 | 徽标 + 引导安装（复用现有引导模式） |
| HTML 版式模板质量决定上限 | 中 | 工程大头；借鉴 MIT 模板库（frontend-slides / beautiful-html-templates） |
| 图片型 pptx 被嫌不可编辑 | 中 | 交付明示 + 2b 升级路径预留（§十四同一依赖） |

开放验证项：① HTML 产物 app 内嵌预览效果（P1 真机看）；② P0 spike 数据（✅ 已回填 §八）。

## 十七、P1.5 完备度增强（2026-07-18，真机首走查反馈驱动）

真机走查暴露两问题：① 用户说「做PPT」期待 .pptx 而 P1 只交 HTML/PDF；② 纯主题请求（无源文档）产出「只有样式没内容」——Research/事实验证在 09 方案里本有、落 SKILL.md 时被弱化成一句话，属实现缺漏。据此对照四项目（dashiAI/ppt-master/huashu/anthropics 深度拆解文档，两组挖掘 agent 各产 14-15 条机制清单）实施 P1.5：

**A 内容工程（治空心 deck）**：Research 阶段 MANDATORY（无源文档时 3-6 检索问题 × ≥3 轮 → `research.md` + `facts.json` fact_id 溯源）· outline 正文页强制 `takeaway`(断言句)/`evidence`(≥2 条引 fact_id 或标 scenario)/`confidence`/`speaker_notes` · 新硬门禁 `validate_outline.py`（O1-O7：断言 lint、空话黑名单、fact_id 存在性、scenario 可见标注、rhythm cadence）· mode 叙事轴（pyramid/narrative/instructional/showcase/briefing，与视觉风格正交，`references/modes.md`）· Concept 五问 + 换名测试一票否决（`content-engineering.md`）。
**B 物理/质量门禁**：`probe_overflow.py`（Chrome --dump-dom 注入探针取物理溢出真值，out-of-canvas + clipped 双类）· 首页门（先 1 页过 validate --single + probe 再扇出——并行架构的必需品）· `qa_report.json` 聚合（structure/overflow/visual 三段 + receipt 等式）。
**C 视觉 QA**：`visual-review.md` R1-R8 机器 rubric + 独立评审（不带生成上下文）+ fix 只改定位/间距回炉 ≤1 轮 + 概念终审。
**D 资产**：图片型 pptx 提前落地（`export_deck.py --pptx`：2x 截图 2560×1440 + speaker notes 写入 notes_slide，演讲者视图可用；交付明示图片型）· tabler-outline 图标库整库 5039 个（MIT，grep 检索 + 内联 currentColor 走既有变量门禁）· `fetch_assets.py`（logo：simpleicons CDN→favicon 链；真图：Wikimedia API + 许可/作者 manifest，取不到走诚实占位）。

依赖变化：deckcraft = `python3.10+ / python-pptx / chrome-or-edge`。验证：validate_outline 合成 9/9 · 探针双向（净 deck 0 检出/坏页 4 检出）· pptx notes 10/10 · fetch_assets 真网络冒烟（github logo + Wikimedia CC BY-SA 带署名）· typecheck 8/8 · cargo 147 · vitest 671 · zip 17236 文件 12.5MB。
**刻意暂缓**（记档）：SVG 图表模板 + chart-safety、AI 生图三维系统、illustration sheet 切片、charLength 脚本化、allowWhen 豁免、可编辑 pptx（html2pptx）、跨运行趋势监控、盘古之白开关/标点悬挂等 CJK 细项、打包 OFL 字体。

**对照 00/09 蓝图终审（2026-07-18）**：09 §5 目录结构差距补齐——新增 `examples/ai-coding-pilot/`（契约活样例 + 回归基准双用途：P1.5 全字段 outline + 10 页 fixture + 门禁链 README，且样例建设时被 validate_outline 弱标题 lint 抓过 2 条并修正——门禁真实咬人的实证）；shell.html 补 `line-break:strict`（CJK 避头尾）。schemas/ 不设（validate_outline.py 即可执行 schema）、agents/ 不设（opencode skill 无此约定，评审定义在 visual-review.md）。License 合规复核：AGPL 项目（dashiAI/guizang）仅思路借鉴零代码拷贝，MIT 来源均入 NOTICE。09 §4.1 宽触发 description 模板留待 P3 毕业时启用（已在 §十五）。

P1 实现期 follow-up（对抗审查产出，未阻塞）：
- `--shots` 逐页冷启动 Chrome（每页 ~1s）：pdftoppm 可用时可从 deck.pdf 一次进程出全部页图（pdf 技能已探测 pdftoppm），缺失再回退逐页 Chrome。
- 浏览器探测双清单（Rust `detect_export_browser` / `find_chrome.py`）以「Python ⊇ Rust」超集纪律 + 两侧交叉注释维持同步；更彻底的 env 注入 SSOT（sidecar env 传探针结果）留待需要时做。
- source_to_md 为 ppt-master 的冻结快照（含两处本地修改，见 NOTICE）：ppt-master bump 不会同步到 deckcraft；P3 删除 ppt-master 后本快照即唯一实现，属预期终态。

---

## 十八、P2b（可编辑 pptx）+ P3（删 ppt-master）实施方案（2026-07-18，真机复走查通过后拟）

> 复走查通过（PDF 不缩水、产物面板泄漏已修、todowrite 面板指示已加）。据此推进 P2b + P3。
> **本节是新窗口开工的权威方案**；实施时逐条对照，改动回写本节状态。

### 18.0 先厘清「继续修改」的两条路（避免 P2b 过度设计）

用户要「对生成的 PPT 不满足时能继续修改」，其实是**两个不同需求、两条不同路**：

| 需求 | 走哪条路 | 是否需要 P2b |
|---|---|---|
| **AI 继续改**（换措辞/调版式/加页/改配色） | 改 HTML 单源（`.deckcraft/<name>/pages/page-NN.html` 或 spec_lock/tokens.css）→ 重跑 build+门禁+export | **不需要**——HTML 是唯一真相源，AI 改源重导出即可，今天就支持 |
| **人在 PowerPoint/WPS 里手改** | 需要文字/形状可二次编辑的 .pptx | **需要 P2b**（图片型 pptx 打开只有图，改不了） |

**结论**：P2b 的唯一目标是「交付一份人能在 PPT 软件里编辑的 .pptx」。AI 续改路径已成立，不在 P2b 范围——SKILL.md 应显式告诉用户/agent 这一点（不满意优先让 AI 改 HTML 源重导，要脱离本工具手改才用可编辑 pptx）。

### 18.1 P2b 架构：Chrome 抽取（现有依赖）+ Node 组装（唯一新依赖）

html2pptx 拆成两段，把「新依赖」压到最小：

1. **浏览器侧抽取器（复用现有 Chrome，零新依赖）**：headless Chrome 渲染 deck.html，注入一段翻译脚本（模式同 `probe_overflow.py` 的 `--dump-dom` 注入），对每页 `.slide` 内元素用 `getComputedStyle`+`getBoundingClientRect` 逐元素抽成一份 `layout.json`（每元素：类型/绝对定位/尺寸/文字/字体/字号/字重/颜色/对齐/背景/圆角/边框）。这一段吃掉 P2b 最难的「视觉保真」部分，且不引入新运行时。
2. **Node 侧组装器（唯一新依赖 = Node + pptxgenjs）**：读 `layout.json` → pptxgenjs 逐元素译成文本框/形状/图片 → 写 `<name>.pptx`。

**Node 依赖决策**：系统 Node v14 太旧不可用（见 MEMORY）。用**嵌入式 Node**（`~/.ultrawork/node/`，Browser MCP 已铺好下载/管理，见 ADR-046 相关）。P2b 探针：无嵌入式 Node 时降级——明确告诉用户「可编辑 pptx 需要 Node 运行时，请先在设置装 Browser MCP 依赖 / 或退回图片型 pptx」，绝不静默失败。

### 18.2 P2b 保真度与转换模式（huashu-design 借鉴，MIT）

- 借鉴 `huashu-design` ~1200 行（getComputedStyle+getBoundingClientRect 逐元素译 pptxgenjs）。**只借思路/算法，不整段拷贝 AGPL**；MIT 部分入 NOTICE。
- **4 条 HTML 硬约束**（deckcraft 模板本就克制，天然接近）：① 元素绝对可定位（避免复杂 flow）；② 文字在叶子节点；③ 渐变/滤镜/复杂 SVG → 栅格化成图片贴上（无法译成形状的诚实降级）；④ 无 JS 运行期改 DOM。
- **转换率与诚实降级**：视觉驱动的花哨页转换率可能 <70%，无法译的元素栅格化为图片块并在交付报告标注「第 N 页含 M 个栅格化元素（不可编辑）」。**绝不假装全可编辑**。
- 两种 pptx 并存，交付时按用户选择：`export_deck.py --pptx`（图片型，现有）/ `--pptx-editable`（P2b，best-effort + 降级明示）。

### 18.3 P2b 任务分解

1. 嵌入式 Node 探针 + `use-skill-deps.ts` 加 `node` 依赖行（P2b 专属，非硬依赖，缺失可退图片型）+ Rust 探针复用 Browser MCP 的 node 定位。
2. `scripts/extract_layout.py`（或内联进 export）：Chrome `--dump-dom` 注入抽取脚本 → `layout.json`。
3. `scripts/html2pptx/`（Node）：`package.json`（pptxgenjs pin）+ 组装器；skill 打包时**不带 node_modules**，首次用嵌入式 Node `npm i` 到 `~/.<skill>/`（同 Browser MCP 模式），或评估 vendor pptxgenjs 单文件 bundle 进技能树。
4. `export_deck.py --pptx-editable`：串起 extract→node 组装；数量/尺寸校验；降级路径。
5. SKILL.md：交付形态问答加「可编辑 pptx」选项 + 18.0 的「AI 续改走 HTML 源」说明 + 转换率降级明示义务。
6. `deckcraft-selftest.py` 加负样本：栅格化降级触发、layout.json schema、pptx 可打开（python-pptx 读回校验形状数）。

### 18.4 P2b 验证

- 合成用例：一页纯文本+形状 → 译出的 pptx 用 python-pptx 读回，断言文本框数/文字内容/位置误差 <阈值。
- 降级用例：一页含渐变 → 断言栅格化为图片且交付报告标注。
- 真机：PowerPoint + WPS 三平台打开无损、文字可选中可改（自动化够不着，用户验收）。
- typecheck / vitest / cargo / check-docs 全绿；sentinel 重算。

### 18.5 P3 执行清单（细化 §十五，建议 P2b 通过后做）

**排序**：P2b 先、P3 后。理由——删 ppt-master 会放宽 deckcraft 接管「做 PPT」全触发面，若此时 deckcraft 还不能出可编辑 pptx，是对现状的能力回退；P2b 落地后 deckcraft 才是完整替代。（curated `INSTALLABLE_SKILLS` 的 ppt-master 长尾退路始终保留，故 P3 不是不可逆。）

有序步骤：
1. `skills/builtin/ppt-master/` 整树删（~53MB / 1.2 万文件）；`pack-builtin-skills.ts` 自动重打（sentinel 变、存量重装）。
2. `scripts/fetch-builtin-skills.ts`：删 ppt-master 条目 + `applyPptMasterPatches` + `X_REQUIRES` 条目。
3. `use-skill-deps.ts`：删 `"ppt-master"` 行；**保留 `python3.10+`**（deckcraft 用）；`python-pptx` 保留（P2a/P2b 用）；P2b 后 `node` 行已在。
4. deckcraft `SKILL.md` frontmatter description + 路由边界表：删「ppt-master 已安装则交给它」措辞→改「可在设置→技能安装 ppt-master」，**放宽触发面**接管「做PPT/生成PPT/演示文稿/slides/deck」全意图（去掉验证期窄触发限定）。
5. curated `INSTALLABLE_SKILLS` 的 ppt-master 条目**保留**（长尾退路）；`reconcile_builtin_shadowing` 通用机制保留。
6. 文档收尾：gotchas §10 ①（窄触发→已毕业）复核、`requirements.md`/`architecture-phase1.md` 状态表、`document-map.md` 计数、CHANGELOG、本文档状态、ADR-061 状态转「已删 ppt-master」。
7. 设置页两个 tab 同见 ppt-master 的「混合形态」自然消解（ADR-040 预期）。

**P3 验收**：check-docs 绿 + CI 三平台绿 + 安装包体积回归（约 −7MB 压缩后，源树 −53MB）+ 真机确认「做PPT」路由到 deckcraft、ppt-master 仍可从设置安装。

### 18.6 状态

- [ ] P2b 实施（18.1–18.4）
- [ ] P2b 真机验收（PowerPoint/WPS 可编辑）
- [ ] P3 执行（18.5）
- [ ] P3 真机 + CI 验收

---

## 附录：ADR 草稿（✅ 已转正为 [`decisions/061-deckcraft-html-first-ppt-skill.md`](../decisions/061-deckcraft-html-first-ppt-skill.md)，以正式版为准；下文为定稿时的历史草稿）

```markdown
# ADR-061: 自研 HTML-first PPT 生成技能（替换内置 ppt-master）

- 状态：Proposed（草稿；随 P1 落地转 Accepted）
- 日期：2026-07-17
- 关联：discussions/043（完整方案与调研）、ADR-040/041（被本决策分阶段替代）、ADR-033、ADR-037

## 背景

内置 ppt-master 两个不可调参修复的痛点：① 逐页手写 SVG + 串行 + 禁子代理/脚本（上游刻意设计）
⇒ 单 deck 几十万 token、耗时长；② Strategist「八项确认」经 Flask :5050 外弹系统浏览器，
与 app 原生 question-dock 交互割裂（ADR-040 D5 当年为保上游零改造而刻意保留）。
调研 24+ 开源 PPT skill（五条技术路线）+ app 集成面核验（原生 question 工具链 /
detect_chrome / zip 打包链路 / mtime 产物扫描 / curated 自装退路）后决定自研替换。

## 决策

### D1 — HTML-first 单源 + 导出分叉（拒绝延续 SVG 逐页手写路线）
单文件 HTML（1280×720 固定舞台）为唯一真相源；PDF/pptx 均为派生物。提速三来源：
HTML 生成基质 + 并行/分批生成 + 版式模板填充。一致性从「模型记忆」换「结构强制」：
spec_lock 每页重读（唯一 HEX/字号来源）+ CSS 三层 token + data-layout 版式契约 +
page_rhythm + 版式多样性硬断言。并行一致性经 P0 spike 实证后定案（不成立则退分批串行）。

### D2 — 交互全走原生 question 工具（拒绝任何本地 web 服务）
两轮 question（澄清 3-4 问 + 设计确认 2-3 问，文字描述式候选、推荐项置顶），
question-dock 逐条渲染；SKILL.md 铁律禁起本地 server。代价=无色卡/字体样张视觉预览，
以「换肤便宜（token 化主题）+ 事后重渲染」对冲。

### D3 — 依赖面：python3 + 系统 Chrome/Edge（零 Node/Playwright）
导出走 Chrome headless CLI（--screenshot/--print-to-pdf；Rust detect_chrome 三平台
路径清单已有，扩 Edge）；图片型 pptx 用 python-pptx 组装（探针复用）。
P2b 可编辑导出（html2pptx + pptxgenjs）才引入 Node（可走嵌入式 ~/.ultrawork/node/）。

### D4 — 范围：精简快线；长尾走 curated 自装
只做「主题/文档 → deck（HTML/PDF/图片型 pptx）」热路径。美化已有 pptx/模板填充/
建模板/TTS/动画不重建——ppt-master 保留在 INSTALLABLE_SKILLS 供按需自装。
「美化已有 pptx」有明确扩展路径（IR 加 beautify 1:1 锁定模式），依赖 P2b 前置，
按验证期真实频率决定是否做；P1 预拷 pptx_intake.py 留门。

### D5 — ppt-master 两步走删除（拒绝长期并存）
P1 新技能独立触发词并存验证 → 验证通过整体删除内置 ppt-master。
拒绝并存的决定因素：触发冲突是结构性缺陷（两技能 description 都抢「做PPT」，
模型选错即痛点复发，可靠划界需 patch 上游 description、破坏零改造初衷）。
curated 自装兜住长尾 ⇒ 删除内置 ≠ 能力消失。收益：-53MB/1.2 万文件、安装包 -7MB、
维护面收窄。

### D6 — 复用资产（全部 MIT）
拷入自带：ppt-master 的 source_to_md/ 转换脚本、pptx_intake.py、图标库裁剪子集、
image_gen.py；版式/设计系统借鉴 frontend-slides / huashu（CJK 排版、反 AI-slop
黑名单、配方式设计系统）。

## 影响

- 新增 `skills/builtin/<name>/`（P1）；P3 删 `skills/builtin/ppt-master/`。
- 依赖徽标：DepMap 加 chrome 条目 + Rust chrome 探针 command。
- 成功判据：同题 12-15 页 deck，token ≤ ppt-master 1/3、墙钟 ≤ 1/2、零外弹浏览器。
- 质量门：IR schema / 字符预算防溢出 / data-layout 断言 / grep 占位符 / 缩略图自检 /
  返工 ≤2 轮。
```
