# 023 — 渐进式工具披露（Progressive Tool Disclosure）

> 状态：✅ 已落地（ADR-036，单 agent + team 真机验收，默认 ON）
> 日期：2026-06-26
> 关联：discussions/004（OpenCode 多 Agent / 委派）· discussions/007（内置工具全景）· ADR-030/031（connector 能力分流 / delegate）· ADR-035 + discussions/022（多 Team 委派归属）· gotchas §1（OpenCode 契约）
> 范围：**只覆盖「模型运行时按需披露工具」这一个能力**。手动静态门控（UI 模式开关、config `tools` glob 关停）不在本方案内——它是被本能力取代的旧做法，不要混入。

---

## 0. 一句话

接入的 MCP 越多，每次请求全量注入工具 schema 的「固定税」在**成本、延迟、准确率**三条线上线性恶化；MCP 协议层不解决，必须由平台层（Ultrawork）实现「平时工具降为 name-only、模型经 `tool_search` 按需提升为原生」的渐进式披露（对齐 Claude Code harness / Anthropic Tool Search，非 JVS 泛型代理）。这是**长期地基能力**，不是可选优化。

---

## 1. 现象与实测（根因量化）

真机：一句 `hi`，对照 agent 652ms，Ultrawork 2.2s。用临时插桩 dump 出 opencode 真正发往模型的 payload（`session/llm.ts` streamText 前，env 门控，已撤），实测构成：

| 构成 | 实测 est tok | 占比 | 来源 |
|------|------|------|------|
| opencode 内置工具（12 个） | 9,351 | 49% | `bash` 2637 + `todowrite` 2364 + `task` 1326 为大头 |
| system prompt | 4,930 | 25% | provider 基础指令 + 环境 + skills |
| browser MCP（chrome-devtools，29 工具） | 4,708 | 24% | config `browser` MCP `enabled:true` |
| **合计** | **~19k**（计量器 17.9k，量级吻合） | | |

- 工具 schema 在 MCP 连接时即 `listTools()` 缓存（`mcp/index.ts:621` `mcp.tools()` 读 `s.defs`），所以**披露与否只影响「塞不塞进请求」，不影响连接成本**。
- **team 协作那一层贡献 0**：普通会话直连 opencode（connector 仅内存查表），且 desktop 对每个 prompt 传 `tools:{ "orchestrator_*": false }`（`backends/opencode.ts:207`）显式拒绝委派工具——实测 0 token。慢与 team 无关。
- 旁证：第三方实测 GitHub 官方 MCP server ≈17,600 token/请求，与本数字几乎一致——这是业界公认的 "too many tools problem"。

**对照组 JVS Copilot 实测**（同用 opencode + qwen3.7-max，一句 hi 652ms）：输入 **11,357 token**。拆解：内置工具 schema ~3,750(33%) + AGENTS.md/CLAUDE.md ~3,000(26%) + **MCP 走 3 个代理工具**（`list_mcp_tools` / `get_mcp_tool_schema` / `run_mcp_tool`，模型不直接看 5 个 MCP server 的工具）。
- 关键差异：JVS 把 MCP 维度收成 3 个代理工具，我们把 browser 29 工具全量注入（4.7k）——**这正是 17.9k vs 11.3k 差距的主因**，坐实 MCP 披露是我们最该动的可控成本。
- 但 JVS **仍有 11.3k**：内置工具 + 指令文件都没收。说明①「收 MCP」只是一个维度；②内置工具/指令文件注入是**正交**的另两个优化（不在本方案范围，但应单列）。

---

## 2. 必要性判断：是长期必要能力（证据）

**① 头部玩家已 shipped，不是研究探索：**
- Anthropic：API `Tool Search Tool`（`defer_loading: true`）、Programmatic Tool Calling；**Claude Code 默认把 MCP 工具设为 deferred**（`ENABLE_TOOL_SEARCH=auto`：占比低于阈值才预载，`alwaysLoad` 豁免）。
- VS Code / Copilot：硬限 128 工具/请求 + **"virtual tools"**（大 server 藏在 `activate_*` 桩工具后）——即本方案的「门面」模式。
- Cursor：活跃工具**硬卡 ~40 个**，超了静默丢弃。
- LangChain `langgraph-bigtool` / LlamaIndex `ObjectIndex`：工具向量检索。Cloudflare Code Mode：2500 端点 ~1.17M→~1K token。

**② 代价双重，已被一手数据量化——不只是省钱，更是准确率：**
- Anthropic 自评 eval：开 Tool Search 后工具选择准确率 Opus 4 **49%→74%**、Opus 4.5 **79.5%→88.1%**；并称「**超 30–50 个工具后准确率明显退化**」。
- RAG-MCP：全量 13.6% → 检索 43.1%。"Less is More"：同任务 **46 工具失败 / 19 工具成功**（上下文放得下，纯粹选项太多）。
- 机制背书 Lost-in-the-Middle：长平铺列表中间的工具更难被选中。

**③ MCP 协议层不会替你解决：**
- 规范本质是「一次性全量列出 + 完整 inputSchema 内联」，分页≠搜索，无 `tools/search`/`tools/get_schema`。按需 schema 检索（社区提案 SEP-1576）至今**未采纳**。
- 结论：随接入增多三线同时恶化，且协议不自动救你 → **能力必须落在平台/客户端层**。

> 印证：当前 Claude Code harness 自身用 deferred tools + ToolSearch；VS Code 用 virtual tools；Claude Code 默认 defer MCP。这条路业界已收敛。

---

## 3. 上游现状（尽调项 1）：自建，别等

我们 pin `vendor/opencode` = **v1.3.13**（commit `8e9e79d2`，2026-04-03），上游已远超。仓库已从 `sst/opencode` 迁移到 `anomalyco/opencode`。

- **零发布、零合并 PR**：HEAD 源码无 tool-search/lazy 文件，code search `ToolSearch`/`lazyLoad mcp` 0 命中。
- **需求极旺但维护者无承诺**：规范化总 issue **#9461「Claude-style Tool Search Tool」OPEN，无 roadmap/无 milestone**；#8625 / #11995 / #23298（要 `defer_loading` 透传，被去重）/ #8277 / #9350 等大量重复 issue，closed 的几乎都是去重/过期/spam，**没有一个是「已实现」关闭**。
- **插件系统缺关键原语**：官方 hook 列表工具相关只有 `tool`（加工具）、`tool.execute.before/after`、`tool.definition`（改单工具）——**没有「工具列表变换/过滤」钩子**。社区实现（omarwaly-ai 单文件插件、`famitzsy8` fork、`mcpproxy-go` BM25 代理）都只能靠拦 execute / 动态注册去「绕」。

**判断**：上游「呼声高但迟迟不做」，最可能卡在设计（auto-defer 会破坏委派，见下 §6），落地时间不确定。**Ultrawork 应自建**，同时可并行向上游提一个**窄钩子 PR**（见 §5 路线 Step 3）。

> ⚠️ **直接踩坑警告**（来自 oh-my-openagent #3592）：曾有实现把 `task`/委派类工具也 defer 掉，**破坏了 delegation**。Ultrawork 有 ACP/orchestrator 委派链路，**披露引擎必须把 `task` 及委派工具列入永不 defer 的 eager 名单**。

---

## 4. 落点（尽调项 2）：纯 plugin 做不到，需「窄接缝 patch + plugin 写策略」

### 4.1 工具表怎么拼（`session/prompt.ts:resolveTools` 388–550）
- 内置工具：`registry.tools()`（436），plugin 注册的 `tool` 也在此并入（`tool/registry.ts:106`）。
- MCP 工具：`mcp.tools()`（476），键名 `<sanitize(server)>_<sanitize(tool)>`（`mcp/index.ts:648`），schema 来自连接时缓存的 `s.defs`。
- 返回 `tools: Record<string, AITool>`（550），上交 `llm.stream`。

### 4.2 为什么纯 plugin 不行
现有钩子能**增**工具、改**单个**工具描述，但**没有任何钩子能删除/替换整张工具表**，且 MCP 工具压根不过 `tool.definition`。门面披露要「按激活态动态删/换 MCP 工具」，现有原语做不到。

### 4.3 最小核心 patch（两处）
1. **`packages/plugin/src/index.ts`**（Hooks，~276 行后）新增一个钩子类型：
   ```ts
   "experimental.chat.tools.transform"?: (
     input: { sessionID: string; agent: string; model: Model; step: number },
     output: { tools: Record<string, any> },   // 与 prompt.ts 的 AITool map 同引用
   ) => Promise<void>
   ```
2. **`packages/opencode/src/session/prompt.ts`**（`resolveTools` 调用点 1460、StructuredOutput 注入 1477 之后）fire：
   ```ts
   yield* plugin.trigger(
     "experimental.chat.tools.transform",
     { sessionID, agent: agent.name, model, step },
     { tools },
   )
   ```
   `Plugin.trigger`（`plugin/index.ts:235-248`）是「逐 hook 调用、原地 mutate output、返回同对象」语义 → plugin 可在 `tools` 上 `delete` 被降级工具的键、`assign` 一个 `tool_search` 工具键。

> ⚠️ **关键机制澄清（避免实现踩空）**：AI SDK 的 `tools` 数组里**一个工具要么带完整 schema、要么不存在**，没有「只给名字」的中间态。所以 **name-only 名录不能放进 `tools` 数组**，必须**以文本注入**——复用**已存在**的 `experimental.chat.system.transform` 钩子（`plugin/src/index.ts:251`，无需新增 core patch），把被降级工具的「名字 + 一行描述」追加进 system prompt（即 harness 把 deferred 工具名放在 system-reminder 文本里的做法）。因此披露引擎 plugin 同时挂**两个钩子**：新的 `tools.transform`（删真 schema + 加 `tool_search`）+ 既有 `system.transform`（注入名录文本）。

**核心 patch 仍只有「加一行钩子类型 + fire 一次」**（名录走既有 system.transform，零额外 core 改动）。**策略全在 plugin**（披露引擎），稳定、rebase 负担极低，符合 vendor patch 最小化原则。一旦该钩子进上游主线，patch 即可退役、引擎降级为纯 plugin。

> **实现载体**：spike 阶段把引擎做成 opencode **internal plugin**（`plugin/index.ts:INTERNAL_PLUGINS`）最快验证；生产形态应改为**外部 plugin 文件**（随 Ultrawork 打包，经 config `plugin` 加载），使引擎不进 vendor patch、只留那一行钩子在 patch 里。

### 4.4 关键利好：每 step 重解析 + 工具不进缓存
- `resolveTools` 在**回合的每个 step 都重跑**（`prompt.ts:1460`）→ 激活后**下一步自动展开**，无需改 step 循环。
- openai-compatible（DashScope/qwen 走的就是这条）的 **tools 参数本就不进 prompt cache，每次全量重传**（`llm.ts:370` tools 作为独立参数）→ **动态改 tools 数组对缓存无额外惩罚**。
  - ⚠️ **缓存惩罚校正（对抗审查 2026-06-26）**：先前「零惩罚」说法不完整。name-only 名录被注入 **system prompt**，而 system 是按缓存优化的（2-part，`llm.ts:122/200-205`）。**若名录随工具逐个 fetch 而收缩，system 文本每次变 → 破坏 system 前缀缓存**。修法：名录做成**静态**——始终列出全部可披露工具（已 fetch 的也留在名录里，标注「已加载，可直接调用」），使 system 文本在回合内不变，**只有 tools 数组随 fetch 变（而它不缓存）**。这样才真正接近零惩罚。Anthropic provider 仍需走原生 `defer_loading` 保前缀缓存。
- MCP 已支持 `tools/list_changed`（收到通知刷新 `s.defs`）→ 对**自有 MCP server**（knowledge / orchestrator / 给 browser 套代理）有一条「server 端先报门面、激活后发 list_changed 报全量」的旁路，零核心改动；但第三方 server（chrome-devtools）管不到，仍需 §4.3 的通用通道。

---

## 4.5 两种披露架构：代理 vs 搜索-提升（对标 JVS 与 Claude Code harness）

业界两条不同的实现路线，**选择决定准确率上限**：

| | **B. 通用代理 / 网关** | **A. 搜索-提升为原生**（本方案选 A） |
|---|---|---|
| 代表 | JVS Copilot（3 代理工具）、mcpproxy-go | Claude Code harness（deferred + `ToolSearch`）、Anthropic Tool Search Tool |
| 发现 | `list_mcp_tools` 列出 | 工具以 **name-only** 进上下文（名录）+ 单一 `tool_search`（关键字 / `select:<name>`） |
| 执行 | 永远经 `run_mcp_tool(name, args)` **泛型派发** | fetch 后真实 schema 注入 → **当原生工具直接调** |
| 准确率 | 较低：模型不在原生 tool-call 格式、args 不经 schema 校验 | 高：原生调用——**49%→74% 的收益正来自此** |
| 每次调用 | 2-3 跳（list→get_schema→run） | 发现后零额外跳 |
| provider 依赖 | 无（任意后端可用） | 需能动态改 tools 数组（opencode 每 step 重解析满足）或原生 `defer_loading` |

**决策：选 A**。理由——渐进披露的核心收益是「让模型在一个小而相关的集合上做**准确的原生工具调用**」（§2 的准确率数据），B 的泛型派发恰恰把这个收益丢了。opencode `resolveTools` 每 step 重跑（§4.4）让 A 落得了地：fetch 的工具下一步即以原生形态出现。

> JVS 实测 11.3k（§1）证明 B 也能显著收 MCP 维度；但我们要的是**更高准确率 + 零额外往返**，且 harness 已用 A 验证可扩展到上千工具——所以对齐 A。

---

## 5. 方案设计：搜索-提升式披露（对齐 harness / Anthropic Tool Search）

### 5.1 架构
**窄接缝钩子（§4.3） + 披露引擎 plugin（挂两个钩子）**。引擎持有「每 session 已 fetch 工具集」（模块级 `Map<sessionID, Set<toolId>>`，回合结束 / TTL / N 步空闲后回落）。每 step `resolveTools` 重跑 →
- `tools.transform`（新钩子）：据已 fetch 集 + 策略，把被降级工具从 `tools` 数组 `delete`，并确保 `tool_search` 在数组里；已 fetch 的恢复原生 schema。
- `system.transform`（既有钩子）：把被降级工具的 name-only 名录文本注入 system prompt（因 AI SDK 数组放不下 name-only 态，见 §4.3 澄清）。

### 5.2 策略模型（抄 Claude Code `ENABLE_TOOL_SEARCH=auto`）
| 档位 | 行为 | 配置 |
|------|------|------|
| `eager` | 一直原生全量（**含 `task`/委派工具，强制**） | 高频核心（read/edit/bash…）+ 委派白名单 |
| `auto` | 工具占比 < 阈值（如 10% 上下文）预载，否则降为 name-only | 默认 |
| `lazy` | 强制 name-only | 工具多的（browser/devtools/低频 MCP） |

> 注意：策略作用于**所有工具**（内置 + MCP），不止 MCP——`todowrite`(2.4k) 等低频内置工具在 chat 回合也可降级，与 harness「核心 eager + 长尾 deferred」一致。

### 5.3 发现 + 提升为原生（对齐 harness）
- 被降级的工具以 **name-only 名录**进上下文（仅名字 + 可选一行描述，每个 ~几 token），能力始终可发现——**解决「用户要浏览时模型说不行」**。
- 注入单一 `tool_search` 发现工具：支持关键字检索与 `select:<name>` 直取（即 harness `ToolSearch` 形态）。
- 模型调 `tool_search` → 引擎把命中工具加入该 session 已 fetch 集 → **下一步 `resolveTools` 重跑、钩子注入这些工具的真实原生 schema**（直接复用 `mcp.tools()`/registry 里已 wire 好 execute 的 AITool，非泛型派发）。
- 代价：**首次发现某工具多一次模型往返**（一个 step）；高频标 `eager` 规避。

### 5.3b 粗粒度变体：per-server 门面（可选）
server 少且工具同质时，可用「每 server 一个 `use_<server>` 门面」替代细粒度名录（≈ VS Code virtual tools 的 `activate_*`）。本质同 A——门面被调后提升该 server 全部工具为原生。名录式更细、更省 floor、更贴 harness；门面式更省「描述」但粒度粗。**默认走名录式，门面式作为 server 同质场景的简化。**

### 5.4 规模分层（面向「MCP/工具很多」）
- 中等规模：name-only 名录 + `tool_search` 关键字检索。
- 超大规模（上千工具，名录也嫌长）：`tool_search` 后端换 BM25 / embedding top-k（Anthropic Tool Search 的 regex/bm25 变体、harness 的关键字 rank 即此形态）。
- 走 Claude 模型时：直接透传原生 `defer_loading` + tool_search_tool，平台层不必自造引擎。

### 5.5 正交优化（非披露机制，可独立随时上）
- 每 server 工具白名单（chrome-devtools 29→核心 6-8 个）。
- 在 `ProviderTransform.schema`（`prompt.ts:481`）接缝处对 MCP schema 做描述截断/去示例。
> 这些降低**单价**（floor 与激活态都受益），但不是「按需」机制，不占 phase。

---

## 6. 风险 / 待定

- **委派工具不可 defer**（#3592 实锤）：`task` 及 orchestrator/delegate 工具必须 eager，否则破坏 Team/ACP 委派。**硬约束。**
- **首次发现往返延迟**：被降级工具首次用多一跳；靠 `eager` 名单 + 好的 name-only 描述缓解。
- **模型发现行为**：可能漏搜/误搜；名录描述质量是关键，必要时加 system-reminder 提示「需要 X 能力时先 `tool_search`」。
- **不可抄 JVS 的泛型代理（B）**：`run_mcp_tool` 派发省事但掉准确率（§4.5），与本能力主诉（提准确率）相悖。
- **阈值/回落策略**待真机调参：`auto` 阈值、激活 TTL、回落步数。
- **跨 provider**：qwen（openai-compatible）tools 数组不缓存；但名录入 system 需静态化以保 system 缓存（见 §4.4 校正）；Anthropic 走 `defer_loading`，行为分别验证。

### 6.0 实现契约（#6 e2e 踩坑实录）
- **hook 注入的工具 execute 必须返回 opencode 工具结果形状 `{ output: string, title, metadata }`，不能返回裸字符串**。processor 在 `processor.ts:223` 读 `value.output.output` 落 `part.state.output`；裸字符串会让 `part.state.output` 为 undefined → 下一步 `toModelMessages` replay 报 `Invalid prompt: messages do not match ModelMessage[] schema`，**拖垮每个多步折叠回合**。e2e 实测确认（webfetch / todowrite 两例修复后通过）。

### 6.0b 自动化验证记录（2026-06-26，真机前自测）
- **typecheck** 干净；**opencode 回归**（tool read/write/edit/webfetch + permission-task + task 委派）100/0，确认插件常驻但 env 关闭时完全 inert。
- **综合单测 22/22**（直接驱动 hook）：折叠/EAGER/catalog、静态名录（fetch 前后文本字节一致）、select+keyword 搜索、grace 降级、**dangling-safe（被历史引用永不降级）**、**并发两会话状态隔离**、`session.deleted` 清理、撞名 `uw_tool_search`、空/仅-eager 工具不注入 tool_search、usedToolIds 含 `invalid` 不崩。
- **生命周期 3/3**：TTL sweep + LRU 淘汰 + 当前会话不被误删（注：`MAX_SESSIONS`/`TTL_MS`/`GRACE` 是模块加载期常量，须由进程启动 env 提供——测试经 CLI env 验证）。
- **真模型 e2e 3/3**（qwen3.7-max）：webfetch（折叠）`tool_search`→原生调用→正确答案；todowrite（折叠）同样自动发现使用；EAGER-only（read）**不触发** tool_search 直接完成。
- **per-step 名录稳定性**（reviewer P0）实测 `disclosable=35→35`（debug 日志 `~/.local/share/ultrawork/log/`，`ULTRAWORK_DISCLOSE_DEBUG=1`），证伪「名录随步变」。
- **compaction 安全**：`compaction.process`（prompt.ts:1400）是独立分支、以 `tools:{}` 调 LLM（compaction.ts:261），**不经本钩子**——无副作用。
- **审查修复**：`GRACE` 默认 2→3（给模型 fetch 后更充裕使用窗）、`tool_search` 返回 `title` 用实际名（撞名时 `uw_tool_search`）。
- 其余 reviewer 报点经裁决为误报/设计如此/既有行为：ghost-tool（降级工具列入名录可再 fetch=正确）、子会话状态隔离（按 sessionID 隔离=正确）、repair→invalid 破坏追踪（折叠工具无法被原生直调，不触发）、pending/running replay（opencode 既有逻辑）。
- 测试脚本留存于 session scratchpad（`disclosure-comp-test.ts` / `disclosure-lifecycle-test.ts`），引擎外置化时移入 Ultrawork 仓库随插件维护。

### 6.0c 真机验收（2026-06-26，桌面 app `setup.sh --dev`，config flag 启用）
- **单 agent 模式 1–8 场景全过**：纯聊天（无 search、输入 token 由 ~17.9k 降至 ~11–14k）、EAGER-only（read/edit/bash 直接用、不触发 search）、折叠工具自动发现（webfetch/browser `tool_search`→原生）、todowrite eager 规划不退化、多步任务无中断。
- **team 委派模式过**：Leader 经 `orchestrator_delegate` 正常委派（委派工具 eager、不被折叠、无前置 search），成员（ACP sidecar，披露插件不触及）正常执行、无报错。委派工具 EAGER 覆盖核对：`orchestrator_delegate`/`orchestrator_list_agents`（`startsWith("orchestrator")`）+ `task`（精确）。
- 真机日志坑：opencode 自带 log cleanup 会 unlink 活动日志文件（`ls`/`tail` 按名找不到、lsof 可见），与本特性无关；验证以 UI「执行流程」(输入 token + 工具步) 为准。

### 6.1 对抗审查（2026-06-26）落地的 2b 必处理项
- **[高] 状态生命周期**：模块级 `fetched`/`catalog` Map 永不清理 → 长跑泄漏。会话销毁时清理 或 LRU+TTL。（spike 门控、一次性，不阻塞 spike）
- **[高] 回落不可淘汰被历史引用的工具**：一旦加 TTL/回落，若淘汰了仍在 message 历史里有 tool-call 的工具 → tools 数组缺该工具 → provider 可能报错（参考 llm.ts `_noop`/LiteLLM 注释同类问题）。约束：回落跳过「历史中出现过的工具」或留 stub；并验证各 provider 容忍度。（spike 不回落故不触发）
- **[中] EAGER 从 registry 取真实 id**：勿靠前缀猜；枚举真实 `task`/委派工具 id（#3592 硬约束）。
- **[低] 名录静态化的副作用**：静态名录恒在 system，floor 略增（但只一行/工具）；与缓存收益权衡。
- **[低] 硬化**：无可折叠工具时不注入 `tool_search`（gate `cat.length>0`）；`tool_search` 撞名守卫（或命名 `uw_tool_search`）；`if(!sessionID) return` 防御；compaction/summarize 链路 bypass。
- **[低] 脆弱性**：`catalog` stash 跨 `tools.transform`(prompt.ts) → `system.transform`(llm.ts) 两个 fire 点的顺序耦合，当前由 `Plugin.trigger` 串行保证（`plugin/index.ts:242-246`），加注释防重构破坏。

---

## 7. 路线（只做渐进式披露，无手动门控阶段）

> **版本决策（已拍板 2026-06-26）**：在当前 pin 的 **v1.3.13** 上实现，不等 vendor bump。理由：核心 patch 仅一行钩子 + 一处 fire，bump 后重对成本极小；引擎是 plugin，受 bump 影响更小。bump（discussions/020）是独立工程，不阻塞本能力。

- **Step 1 — 尽调（本文档，已完成）**：必要性 + 上游现状 + 钩子落点钉死。
- **Step 2 — 建能力本体**：
  - **2a spike（先做，验证闭环）**：加钩子类型 + fire；写最小 internal plugin，对单一目标（如 `browser_*`）降级为 name-only 文本 + 注入 `tool_search`；用 dump 在三态验证——baseline（全量）/ 降级后（无 browser schema、有 tool_search、system 有名录）/ 已 fetch（schema 复现）。**目标：deterministically 证明「删→名录→search→下一步原生复现」闭环。**
  - **2b 铺开**：`auto` 阈值策略 + 全工具（内置+MCP）+ 委派 eager 硬约束 + 引擎改外部 plugin 形态。headless + 真机双验证。
- **Step 3 — 规模化 + 上游**：`tool_search` 后端按需换 BM25/embedding；并行向上游提「工具列表变换钩子」窄 PR（引用 #9461 + 社区实现），merge 后 patch 退役。

---

## 8. 验收标准（Definition of Done）

**spike（2a）通过判据**（不依赖模型行为，dump 实测）：
- baseline 态：payload 含 browser 全量 schema（≈4.7k tok）。
- 降级态：browser schema 从 `tools` 消失、`tool_search` 出现在 `tools`、system prompt 出现 browser 工具 name-only 名录；"hi" 输入 token 较 baseline 明显下降。
- 已 fetch 态（预置/强制 fetched 集）：被 fetch 的 browser 工具真实原生 schema 在**下一步**重新出现且 execute 仍可用。

**能力（2b）通过判据**：
- 真机：发「访问某网页」→ 模型先 `tool_search` 命中 browser → 下一步原生调用浏览器工具成功（一次额外往返内）。
- 回归：`task`/委派工具始终 eager，Team/ACP 委派不受影响（对照 #3592）。
- 既有测试基线不掉（acp 108 / orchestrator 67 / desktop 207 / connector 75 / gateway 120 等）。
- "hi" 输入 token：目标从 17.9k 降到内置+system 量级（MCP 维度收掉）。

---

## 附：核心代码坐标（v1.3.13）
- 工具拼装：`packages/opencode/src/session/prompt.ts:388-550`（内置 436 / MCP 476 / 返回 550）
- 每 step 调用点（fire 落点）：`packages/opencode/src/session/prompt.ts:1460`（StructuredOutput 1470-1477）
- MCP 工具枚举/缓存：`packages/opencode/src/mcp/index.ts:621-654`（键名 648）
- plugin 钩子类型：`packages/plugin/src/index.ts:189-276`
- plugin trigger 语义（原地 mutate）：`packages/opencode/src/plugin/index.ts:235-248`
- plugin 工具并入：`packages/opencode/src/tool/registry.ts:106`
- tools 传参 / system 2-part 缓存：`packages/opencode/src/session/llm.ts:370` / `:122` / `:200-205`
- 委派工具拒绝（现状）：`packages/core/connector/src/backends/opencode.ts:207`
