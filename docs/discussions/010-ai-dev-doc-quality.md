# 010 — AI 驱动开发的文档质量保障体系：现状诊断与优化方案

> 状态：已落地（全案于 2026-06-06 执行，见文末「实施记录」）
> 日期：2026-06-06
> 关联：`CLAUDE.md`、`AGENTS.md`、auto-memory `MEMORY.md`、`docs/conventions.md`、`docs/document-map.md`、`docs/getting-started.md` §AI 协作工作流、全部 `docs/`

---

## 0. TL;DR（结论先行）

1. **本项目的"开发质量"高度依赖文档体系，这个判断是对的。** 因为开发主力是 Claude Code，而 Claude 没有跨 session 的隐式记忆——它每次只"知道"自动加载进来的三个文件 + 任务中主动读取的文档 + 本地 auto-memory。**文档体系就是这个项目事实上的 QA 系统**：它替代了人类团队里"老员工的经验"。文档错/缺/旧 = AI 直接犯错。

2. **体系的顶层设计是合理的**：三层加载（auto-load 常驻 → on-demand 按任务读 → auto-memory 工作记忆）+ 收尾同步（开发中暂存到 MEMORY，"收尾"时格式化进 conventions/CHANGELOG/ADR）。这套机制思路正确，问题出在**执行细节正在劣化**。

3. **发现一个 P0 级硬故障**：作为"每次 session 地基"的 `MEMORY.md` 实测 **207 行，已超过自身 200 行上限**，本 session 启动时系统明确警告 *"Only part of it was loaded"*——即**关键的「已知坑点」「Current Status」可能在某些 session 静默不加载**。这是质量保障链条上最危险的单点：地基本身在缺角。

4. **第二个结构性风险**：项目最稠密、最"救命"的操作型知识（API 类型细节、各种坑点、当前状态）主要活在 **不入 git、不共享、不可被 review** 的 auto-memory 里。对"长期研发质量保障"而言，最该沉淀的知识恰恰沉淀在了最易丢失、最难协作的地方。

5. **第三个慢性病**：同一事实散落多处（API 端点至少 4 处、vendor patch 至少 3 处、环境命令至少 4 处），没有单一事实源（SSOT）。冗余对 AI 召回有一点好处，但**多副本 = 多个漂移源**——已经能观察到漂移实例（AGENTS.md 仍写 "27 ADRs"，实际已有 029；document-map 漏列 `vendor-opencode-bump-survey.md`）。

6. **本文档只做分析与方案，不动任何文件。** 第 4 节给出按类别的优化建议，第 5 节给出优先级路线图，第 6 节列出需要你拍板的开放问题。**待你选定方向后再单独执行。**

---

## 1. 背景与问题定义

### 1.1 用户诉求

> 当前项目主要由 AI（Claude Code）开发，如何保障开发质量？我的理解是质量很大程度取决于 (1) 你的记忆 和 (2) spec 文档。为长期研发质量保障，想提升当前项目里开发用到的文档——可按需修改、删除、清理。先分析讨论方案，放到 docs/discussions，先不实际调整。

### 1.2 把问题重新表述清楚

"AI 驱动开发的质量保障"本质上是一个**上下文工程（context engineering）问题**：

- 人类团队靠"人脑里的隐性知识 + 代码评审 + 口头传承"保障一致性；
- AI 团队没有隐性知识，**每次 session 都是"失忆的新员工"**。它的全部"经验"= 这次能读到的文本。

所以对本项目，"文档质量"不是锦上添花的工程素养问题，而是**直接决定每一行 AI 产出代码对不对**的核心变量。用户的直觉判断（质量 ≈ f(记忆, spec 文档)）是准确的。本文据此评估：**现有文档体系作为一套 QA 机制，哪里有效、哪里失效、怎么修。**

---

## 2. 现状：文档体系如何承担质量保障

### 2.1 三层上下文加载模型

| 层级 | 文件 | 加载时机 | 行数 | 在 git？ | 作用 |
|------|------|---------|------|---------|------|
| **① Auto-load（常驻）** | `CLAUDE.md` | 每次 session 自动 | 197 | ✅ | 工作流程指令：任务分类加载、收尾流程、vendor patch 规则 |
| | `AGENTS.md` | 每次 session 自动 | 97 | ✅ | 项目概览：包结构、技术栈、API 摘要、命令 |
| | `MEMORY.md` (auto-memory) | 每次 session 自动 | **207 ⚠️** | ❌ 本地 | 工作记忆：环境/API 类型/坑点/Current Status |
| **② On-demand（按任务读）** | `conventions.md` | 写组件/SSE/API 时 | 218 | ✅ | 开发规范与模式（QA 核心） |
| | `architecture-phase1.md` | 架构变更时 | 1869 | ✅ | 系统架构、模块职责、数据流 |
| | `api-reference.md` | 调 API 时 | 298 | ✅ | OpenCode 端点细节 |
| | `testing.md` / `requirements.md` / … | 按需 | 474 / 233 | ✅ | 测试策略 / 需求验收 |
| **③ Auto-memory 拓展（本地）** | `vendor-patches.md`、`dingtalk-channel-plan.md`、`vendor-opencode-bump-survey.md`、`project_sidecar_process_cleanup.md` | 召回时 | — | ❌ 本地 | 专题深度记忆 |

> 决策层 `docs/decisions/`（28 个 ADR + README）和讨论层 `docs/discussions/`（含本文 8+1）属于"按需引用"的知识库，不在常驻加载中。

### 2.2 知识流转闭环（设计意图）

```
开发中发现坑点/模式 ──一行摘要──▶ MEMORY.md「New Patterns (pending sync)」暂存区
                                              │ 用户说"收尾"
                                              ▼
                            conventions.md（格式化+代码示例） + CHANGELOG.md + ADR(如有)
                                              │
                                              ▼
                            （下次 session）作为 on-demand 文档被 AI 重新读取
```

**这套闭环的设计是好的**：它区分了"瞬时工作记忆"（MEMORY）与"沉淀的团队规范"（conventions/ADR），并用"收尾"作为人工触发的固化点。问题在于闭环的**几个关键节点正在失效或泄漏**（见第 3 节）。

---

## 3. 诊断：质量风险（按影响排序）

### 🔴 P0-1：MEMORY.md 超限，地基被静默截断

- **事实**：`MEMORY.md` 实测 **207 行**，文件自身声明上限 200 行；本 session 启动时系统注入警告 *"WARNING: MEMORY.md is 202 lines (limit: 200). Only part of it was loaded."*（注：警告时的快照是 202，当前已涨到 207）。
- **后果**：这是**每次 session 都自动加载、用来给 AI"打底"的文件**。一旦被截断，靠后的 `## Pending Issues`、`## User Preferences`，甚至部分 `Key Files` / `Known Limitations` 可能在某些 session 里根本没进上下文——而这些恰恰是防止 AI 重复踩坑的内容（如"File API 路径必须相对""工具参数 camelCase""MCP 必须用 bunx"）。
- **为什么是最高优先级**：QA 链条上其它环节都是"概率性失效"，唯独这一条是"地基缺角"——AI 会**自信地基于不完整记忆做事**，且不会意识到自己漏读了。
- **根因**：MEMORY.md 违背了自身设计——它本应是"一行一条的索引"，detail 移到专题文件；但现在塞进了完整 API 端点清单、整段 IMA 坑点、ACP 全量细节，体积持续膨胀。

### 🔴 P0-2：救命知识只活在不入 git 的本地记忆

- **事实**：最稠密的操作型知识（`OpenCode Upstream Type Alignment`、`Server Known Limitations`、各 sidecar 的实测坑点）在 auto-memory 里，**不入版本控制、不在 GitHub、无法 code review、换机器/换人即丢**。document-map 第 144 行也明确："GitHub 上看不到此目录"。
- **后果（针对"长期 + 团队"质保）**：
  - 协作者 clone 仓库拿不到这些坑点 → 别人（或别的 AI 实例）会重新踩一遍；
  - 这些知识无法被评审/质疑/纠错 —— 见 P1-3 的 ACP 误标实例；
  - 真正的 SSOT 应该是入 git 的 `conventions.md` / `api-reference.md` / ADR，但大量知识卡在 MEMORY 里没流转出去。
- **张力点**：auto-memory 的"本地、私密、跨 session"特性对**个人开发**很顺手，但与"长期研发质量保障"（= 可共享、可追溯、可评审）的目标**方向相反**。需要明确划界：什么留在 MEMORY（瞬时/个人/状态），什么必须沉淀到 git（团队规范/API 契约/坑点）。

### 🟠 P1-1：收尾同步链路是手动且有损的

- **事实**：知识从 MEMORY 流到 conventions 依赖三个人工条件全部成立：(a) AI 开发中记得暂存到 staging、(b) 用户记得说"收尾"、(c) AI 正确格式化写入。当前 `New Patterns (pending sync)` 区为空——可能是真没新模式，也可能是**坑点被直接写进了 MEMORY 各 section 而没走 staging 通道**（观察：大量坑点散落在 `Known Limitations`/`Knowledge Base`/`Gateway` section，不像是经 staging→conventions 固化的）。
- **后果**：闭环实际在"泄漏"——知识进了 MEMORY 但没流到共享层，长期看 conventions.md 会落后于 MEMORY 里的真实经验。

### 🟠 P1-2：文档-代码漂移，无任何校验

- **事实**：文档里有大量"会过期"的断言——状态标记（✅/🔲/Done）、文件路径、行数、计数、ADR 编号。已观察到的漂移：
  - `AGENTS.md` 第 94 行写 *"27 ADRs, 001–028 除 027"*，但实际已有 **ADR-029**（main 已合并）→ 已过期；
  - `document-map.md` 第 88-90 行的 auto-memory 文件清单**漏列** `vendor-opencode-bump-survey.md`（2026-06-04 新增）；
  - `document-map.md` 顶部"约 64 个 md 文件"、分层表里的计数都是手数的，易随增删失真。
- **背景佐证**：MEMORY 的 Current Status 记录了 2026-06-04 专门做过一次"文档-代码整体对齐"任务——**说明漂移是周期性手工返工的慢性病**，目前没有自动化护栏。
- **后果**：AI 读到过期的文件路径/状态会做出错误假设（比如以为某模块未实现而重复造，或引用已重命名的文件）。

### 🟠 P1-3：同一事实多处副本，互为漂移源

同一知识点在多个文件重复，没有 SSOT。已识别的主要重复：

| 知识点 | 出现位置 | 风险 |
|--------|---------|------|
| OpenCode API 端点 | `AGENTS.md` §API + `api-reference.md` + `MEMORY.md` §Endpoints + `conventions.md` §4 | 4 副本，改一处其余皆旧 |
| 环境/常用命令 | `CLAUDE.md` §通用约定 + `AGENTS.md` §Commands + `getting-started.md` + `MEMORY.md` §Environment | 4 副本 |
| vendor patch 内容 | `CLAUDE.md`（最详）+ `MEMORY.md` + auto-memory `vendor-patches.md` | 3 副本，且详略不一 |
| sidecar 端口/凭证 | `AGENTS.md` + `getting-started.md` + `MEMORY.md` + ADR-028 | 多副本 |

- **权衡**：对 AI 而言，关键信息适度冗余能提高召回率，**不应盲目去重**。但"无主"的冗余（没有指定哪个是权威、其余指向它）必然漂移。**正解是 SSOT + 交叉引用**，而非物理消除。

### 🟡 P1-4：陈旧/已纠错知识仍驻留记忆（ACP 实例）

- **事实**：`MEMORY.md` §ACP Client 用大段篇幅描述 `feat/acp-support` 分支细节，并自带一条纠错说明："MEMORY.md 此前误标'完成'，已修正……main 不包含此功能"。ACP 相关提示还散落在 §Current Status、§Key Files、§ADR 索引等多处，每处都要手工挂"仅 acp-branch"的免责声明。
- **意义**：这是 P0-2（知识无人评审）的**活体证据**——记忆一旦写错，会在多个 session 里持续误导，直到偶然被人发现。它也加重了 MEMORY 体积（P0-1）。

### 🟡 P2-1：文档分类语义与实际用途错位

- `docs/discussions/` 被 README 定义为"探索阶段、可能被否决"，但 004–009 实为**OpenCode 内部机制的权威调研记录**（内置工具、内置 Agent、Permission 机制、多 Agent 等），是 AI 应当信赖并查阅的参考资料，而非"待定提案"。把它们归在"讨论/可能被否决"层，可能让 AI 低估其可信度、不去读。
- 大型 ADR/讨论（ADR-026 1552 行、ADR-021 968 行、Discussion 001 1204 行、003 1062 行）本身没问题（参考资料按需读），但缺少"摘要/TL;DR 前置"会拉高 AI 的读取成本。

### 🟡 P2-2：缺少统一的"完成定义 / 质量门禁"单页

- 质量标准散落各处：typecheck 5/5（多文件提及）、Gateway 113 / Desktop 123 用例（getting-started）、手动测试清单（testing.md）、收尾流程（CLAUDE.md）。没有一页"改动合入前必须满足什么"的 checklist。对 AI 而言，**没有显式门禁 = 每次靠 CLAUDE.md 里分散的约定自行拼凑**，容易漏项。

---

## 4. 优化方案（按类别，仅建议，待选定后执行）

> 原则：①**先止血再优化**（P0 优先）；②**SSOT + 交叉引用**，不盲目删冗余；③**让正确的事更省力**（降低 AI/人遵守规范的成本）；④**能自动校验的就别靠人记**。

### A. 止血 auto-memory（对应 P0-1 / P0-2）

- **A1（必做）瘦身 MEMORY.md 回到 < 200 行的纯索引**：把深度内容（完整 API 端点表、整段 IMA 坑点、ACP 全量细节、Key Files 长清单）下沉到 auto-memory 专题文件（如 `opencode-api.md`、`knowledge-ima.md`、`acp-branch.md`），MEMORY 只留"一行 + 指针"。这是 MEMORY 设计的原意，也是恢复"地基完整加载"的唯一办法。
- **A2（关键决策）把"该共享的坑点"迁出本地记忆、沉淀进 git**：将 `OpenCode Upstream Type Alignment`、`Server Known Limitations`、各 sidecar 实测坑点中**稳定的、团队需要的**部分，固化进 `docs/conventions.md`（或新建 `docs/gotchas.md`「踩坑清单」）。MEMORY 里只保留指针 + 个人/瞬时状态。**这是回应"长期研发质量保障"的核心动作。**（需你确认，见 §6 Q1）
- **A3** 明确 MEMORY 与 git 文档的**分工边界**并写进 CLAUDE.md：MEMORY = 瞬时工作状态 / 个人偏好 / Current Status / staging；git docs = 团队规范 / API 契约 / 稳定坑点 / 架构决策。

### B. 加固收尾同步闭环（对应 P1-1）

- **B1** 在 CLAUDE.md 收尾流程里增加一步「**MEMORY 体检**」：检查行数是否逼近上限、是否有应下沉的 detail、是否有应固化到 git 的坑点。把"防膨胀"变成例行动作而非偶发大扫除。
- **B2** 明确"坑点也要走 staging→固化"：发现坑点时不直接塞进 MEMORY 各 section，而是先进 staging 区，收尾时判定"个人/瞬时"留 MEMORY、"团队/稳定"进 conventions 或 gotchas。

### C. 去重并建立 SSOT（对应 P1-3）

- **C1** 为每类重复知识指定**唯一权威源**，其余位置改为"摘要 + 链接到权威源"：
  - API 端点权威源 = `api-reference.md`；AGENTS/MEMORY/conventions 只保留高频子集 + 指针。
  - vendor patch 权威源 = `CLAUDE.md` §Vendor Patch 管理（已最全）；MEMORY/vendor-patches.md 指向它。
  - 环境命令权威源 = `getting-started.md`；其余指针化。
- **C2** 注意**保留有意为之的冗余**：高频、救命的几条（bunx 不用 npx、路径相对、camelCase、/global/health）可在多处重复以提高 AI 召回——但要标注权威源，避免各自演化。

### D. 漂移防护（对应 P1-2）

- **D1（轻量、高性价比）** 写一个 `scripts/check-docs.ts` 做**机械校验**（不判断语义，只查可机检的事实）：
  - ADR 文件数 vs README 索引 vs AGENTS/document-map 里的计数是否一致；
  - 文档中引用的 `packages/.../*.ts`、`src/...` 路径是否真实存在；
  - MEMORY.md 行数是否 < 200（CI/pre-commit 卡住）；
  - document-map 列出的 auto-memory 文件 vs 实际文件差异。
  - 接入 `bun run` 脚本，可选挂 pre-commit / CI。
- **D2** 立即修两处已知漂移（待批准后随实施一起做，不在本 PR）：AGENTS.md ADR 计数 → 含 029；document-map 补 `vendor-opencode-bump-survey.md`。
- **D3** 减少文档里写"行数/文件总数"这类极易过期的硬数字，改为"由脚本生成"或"约数 + 注明非权威"。

### E. 分类语义修正（对应 P2-1）

- **E1** 把 discussions 004–009 这类**机制调研**与"待定提案"在 README 索引里用状态区分（如「调研记录(权威)」vs「讨论中(提案)」已有雏形，可强化），或考虑迁出到 `docs/research/`，让 AI 明确它们是可信参考。
- **E2** 给超长 ADR/讨论（>500 行）统一前置 `## 0. TL;DR`（009 已是好范例），降低 AI 读取成本。

### F. 新增"质量门禁"单页（对应 P2-2）

- **F1** 新建 `docs/quality-gates.md`（或并入 testing.md 顶部）：一页列出"改动合入前必须满足"——typecheck 5/5、相关包单测通过、收尾流程已走、涉及状态变更已更新状态文档。让 AI 每次有明确 checklist 可对照。

### G. 清理 / 归档候选（对应"可删除/清理"诉求）

> 以下仅为**候选**，需你逐项确认，不擅自删除（见 §6 Q3）：

- `docs/test-config-isolation.md`（143 行，2026-04-24 后未动）：若 ADR-020 配置隔离已稳定且测试已纳入 testing.md，可考虑归档到 `docs/archive/`。
- `docs/architecture-full.md`（4727 行，2026-03-10 后未动，document-map 注"暂不纳入开发索引"）：确认是否仍是活跃蓝图；若是远期愿景，明确标注"非当前实现"以免 AI 误读为现状。
- auto-memory `dingtalk-channel-plan.md` / `project_sidecar_process_cleanup.md`：若对应功能已落地并有 ADR/conventions 覆盖，可精简为指针。
- **注意**：归档层（`docs/archive/`）按 document-map 规则"只追加不修改"，历史审查/总结**不应删除**，保持可追溯。

---

## 5. 优先级路线图（建议执行顺序）

| 阶段 | 动作 | 对应 | 工作量 | 收益 |
|------|------|------|--------|------|
| **第 1 步（止血）** | A1 MEMORY 瘦身回 <200 行 + A3 分工边界 | P0-1 | 小 | 立即恢复"地基完整加载" |
| **第 2 步（沉淀）** | A2 把稳定坑点固化进 git（conventions / 新建 gotchas） | P0-2 | 中 | 知识可共享/可评审/不丢 |
| **第 3 步（护栏）** | D1 check-docs 脚本 + D2 修两处已知漂移 | P1-2 | 中 | 漂移从"周期手工返工"变"自动拦截" |
| **第 4 步（去重）** | C1/C2 建 SSOT + 指针化 | P1-3 | 中 | 降低长期维护成本 |
| **第 5 步（流程）** | B1/B2 收尾流程加 MEMORY 体检 + F1 质量门禁页 | P1-1/P2-2 | 小 | 防止问题复发 |
| **第 6 步（整理）** | E 分类语义修正 + G 清理候选（逐项确认） | P2 | 小-中 | 提升可信度与可发现性 |

**最小可行起步**：只做第 1 步（A1）就能消除最危险的 P0 故障，且零风险、可独立完成。建议无论是否采纳全案，都先做这一步。

---

## 6. 待你拍板的开放问题

- **Q1（最关键）**：稳定坑点固化进 git 时，倾向哪种落点？
  - (a) 全部并入现有 `docs/conventions.md`（单一规范文件，可能变长）；
  - (b) 新建 `docs/gotchas.md`「OpenCode/sidecar 踩坑清单」与 conventions 并列（按"规范" vs "坑点"分文件）；
  - (c) 暂不固化，仅做 A1 瘦身（坑点继续留本地记忆，接受不共享）。
- **Q2**：是否接受引入轻量校验脚本 `scripts/check-docs.ts`（可选挂 pre-commit / CI）？还是只要文档结构调整、不加自动化？
- **Q3**：清理候选（§4.G）里，`architecture-full.md`、`test-config-isolation.md` 是否仍是活跃文档？能否归档？
- **Q4**：去重力度——倾向"激进 SSOT（尽量单副本 + 链接）"还是"保守（保留对 AI 召回有利的关键冗余，只标权威源）"？本文倾向**保守**（见 C2）。
- **Q5**：本轮范围——只整改"开发用到的文档"（auto-load 三件套 + conventions + api-reference + 收尾流程），还是连同 ADR/discussions/archive 一起做一次全量梳理？

---

## 附录：本次分析依据（源码/文档实证）

- 文档清单与行数：`find docs -name '*.md'` + `wc -l`（docs 39 + 根 4 = 43 个 md，document-map 称"约 64 个"含 design/ 与 auto-memory）。
- auto-memory 实测：`MEMORY.md` 207 行（>200 上限）；目录含 5 个文件，document-map 仅列 4 个（漏 `vendor-opencode-bump-survey.md`）。
- 漂移实例：`AGENTS.md:94` "27 ADRs"（实际已含 029）；`document-map.md:88-90` auto-memory 清单不全。
- 加载链路：`CLAUDE.md`「自动加载的上下文」表 + `getting-started.md` §AI 协作工作流 + 本 session 启动注入的 claudeMd / MEMORY 上下文。
- 收尾闭环：`CLAUDE.md`「任务收尾流程」Step 1-6 + `conventions.md` 顶部 `<!-- last-synced -->` 标记。

---

## 实施记录（2026-06-06，全案执行）

经用户确认（坑点落点=新建 gotchas.md；清理=只标注不删除），第 4 节方案已全部执行：

| 路线图步骤 | 落地内容 |
|-----------|---------|
| 1 止血（A1/A3） | `MEMORY.md` 207 → **58 行**：坑点/类型契约/Key Files/ACP 全部下沉；新增「知识索引」指针段 + 顶部分工边界说明 |
| 2 沉淀（A2） | 新建 **`docs/gotchas.md`**（OpenCode/MCP/Gateway/IMA/Tauri/构建 7 章坑点，入 git）；ACP 细节迁入本地 `acp-branch.md`；Key Files 迁入 `AGENTS.md` |
| 3 护栏（D1/D2） | 新建 **`scripts/check-docs.ts`** + `bun run check:docs`（校验 ADR 计数 / 引用路径 / MEMORY 行数，当前 0 漂移）；修复 AGENTS「27 ADRs」→28、document-map 漏列文件 + 漏列 discussion 002 |
| 4 去重（C1/C2） | SSOT 指定：API→api-reference、坑点→gotchas、命令→getting-started、关键文件→AGENTS；各处指针化；保留高频救命冗余 |
| 5 流程（B1/B2/F1） | `CLAUDE.md` 加「记忆与文档分工」节 + 收尾 Step 3 加 MEMORY 体检 + Step 3.5 漂移校验；新建 **`docs/quality-gates.md`** |
| 6 整理（E/G） | discussions README 加「调研记录 vs 讨论中」状态语义；`architecture-full.md` 顶部标注「远期愿景·非当前实现」；清理候选按用户选择**只标注不删除** |

### P2 架构文档重构（2026-06-06 补做，分支 `docs/quality-system-hardening`）

第 6 步遗留的两份大架构文档重构（原第二轮 P1 暂留「待下一轮」）已执行，经用户确认两项策略：

| 文档 | 落地内容 |
|------|---------|
| `architecture-phase1.md`（1869→1919 行） | 拆 **Part I 现状 / Part II 规划中（🔲 设计草案）**：connector 抽象、Agent Workspace 身份/记忆持久化（IDENTITY/SOUL/MEMORY/HISTORY + 读写生命周期）、Proactive Services、Process Lifecycle 进程注册表 → 统一下移 Part II；Part I 前半保持纯现状。顶部加 TL;DR + 目录。`~/.ultrawork/` 现状布局留 Part I（✅ 已实现目录 vs 🔲 规划文件分清）。 |
| `architecture-full.md`（4732→4540 行） | **超集文档**（Phase-1/2 同章节交织，无法整章删）→ 用户选「只删纯重叠段 + 表内瘦身」：删 connector 数据流 / Key APIs / Build / Updating（−197 行，改指针）；Module Overview 表已实现包行瘦身为指针；旧 `.agent/` per-project 模型标注「已被 `~/.ultrawork/` 取代」；彻底 SolidJS→React（留决策记录）；标题/顶部收敛为「远期愿景 Phase 2+」。 |

> 关键判断：full.md 并非可按整章删除的「16 个 Phase-1 章节」，而是 Phase-1/2 在 Directory/System Architecture/Feature Summary 等共享章节内**逐行交织**的超集——整章删会丢 Phase-2 内容（hub/supervisor/web/mobile/context/control-plane 包）。故采用「纯重叠段删除 + 交织章节表内瘦身/指针」。check:docs 0 漂移。

**未来可叠加**（本轮未做，非阻塞）：check-docs 接 pre-commit / CI；给其余超长 ADR（026/021、discussion 001/003）补 TL;DR；full.md 的大 ASCII 目录树仍含 Phase-1 包细节（本轮以顶部指针标注、未逐包拆解，留作进一步瘦身候选）。
