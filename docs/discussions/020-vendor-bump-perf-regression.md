# 020 — vendor/opencode v1.15.13 性能回退分析与系统性解决方案

> 状态：**调研记录 + 讨论中**（基于 v1.15.13 源码独立核验）
> 日期：2026-06-16
> 适用范围：① fork 项目（已在 v1.15.13，正在治理）② 本项目后续 `vendor/opencode` bump 追赶社区对齐时的**前置参考**

---

## 0. TL;DR

- **本项目当前 pin 在 v1.3.13（commit `8e9e79d2`），尚未升级**，所以下面这些回退**当前不影响本项目**——但只要 bump 到 v1.15.13 架构（session 模块重写 `96621fcd3`）就会**全部继承**。本文是 bump 前的"已知雷区清单 + 解法手册"，与 `vendor-opencode-bump-survey.md` 配套。
- 桌面上 `dev-performance-regression-report.rtf` 是 fork 项目的内部分析 + 已实施修复记录。本文**独立核验了它的每一条**（用 v1.15.13 tag 的真实源码，worktree `/tmp/oc-v1.15.13`），**确认大部分成立、修正了 4 条夸大/失准的判断、并新发现 3 处 report 漏掉的热点**。
- 两个用户体感主诉都坐实：
  1. **`/global/health` 慢**——handler 本身是 O(1)，但请求要穿越完整 Effect HttpApi 管线（`Layer.mergeAll` ~45 个 defaultLayer + 6 层中间件），叠加 bootstrap 尾段无界后台 fiber 抢占事件循环 → 偶发 >500ms。**根因是架构级，不是单点。**
  2. **snapshot 高频扫描慢**——`track()`/`patch()` 每轮被调 6–9 次，每次 `add()` 都做全量 `diff-files`+`ls-files --others`+`check-ignore`+`stat×N`+`git add`，大目录单次 1.5–4.5s。
- 解法不是堆补丁，而是 **9 类系统性策略**（§4），按 ROI 排出 P0/P1/P2（§5）。本项目应把这些固化为 `patches/` 下的 vendor patch，每次 bump 重新核验。

---

## 1. 背景与方法

### 1.1 回退的架构根因

v1.15.13 相对 v1.2.x 是一次 session 模块架构重写（37 文件 / +8868 −6072）。性能代价来自 6 个架构选择的**叠加**，不是单点 bug：

| 架构变化 | 设计目的 | 性能代价 |
|---------|---------|---------|
| `InstanceState.make` + ScopedCache 懒初始化 | 多 worktree 实例隔离 | 高成本初始化集中砸在**用户交互路径**（首条消息） |
| Hono → Effect HttpApi | 类型安全 / 可组合 | health 等轻路径穿越 `Layer.mergeAll` + 多层中间件 |
| session JSON → SQLite 多表 + projector 事件回放 | 结构化存储、可查询 | 逐 part 写库 |
| snapshot 增加 ignore/stat/drop 逻辑 | 防大文件/忽略文件误入快照 | 每次 `track()` 全量扫描 |
| Plugin trigger 链 | 可扩展性 | 每次请求多次同步等待（即使无插件也走完链路） |
| LLM 路径拆分 + Schema 校验 + native runtime | 多 runtime 支持 | 额外序列化分支 |

### 1.2 核验方法

- 用 `git worktree add --detach /tmp/oc-v1.15.13 v1.15.13` 拉出**未打 patch 的纯 v1.15.13 源码**（tag `385cb6944`，`package.json` 实测 `1.15.13`）。
- 逐条比对 fork report 的断言与真实 `file:line`，并行派 2 个 Explore agent 分别审计「AI 回复热路径」与「启动/首条消息路径」，独立估算严重度，且**主动 hunt report 没提到的热点**。
- 结论分三档：✅ **坐实**、⚠️ **修正**（report 夸大或定位失准）、🆕 **新发现**。

> 复现完后请清理：`git -C vendor/opencode worktree remove /tmp/oc-v1.15.13`。

---

## 2. 回退点核验清单

### 2.1 启动 / 首条消息路径

| # | 回退点 | 核验 | 真实位置（v1.15.13） | 严重度 |
|---|--------|------|---------------------|--------|
| S1 | **MCP 懒初始化阻塞首条消息** | ✅ 坐实 | `project/bootstrap.ts:48` 的 init 数组**不含 MCP**；首条消息 → `session/tools.ts` resolve → `mcp.tools()` → `InstanceState.get` miss → 对所有 server `Effect.forEach(..., {concurrency:"unbounded"})` 并行 spawn（`mcp/index.ts:559`） | **极高** |
| S2 | **bootstrap 外层并发无界** | ✅ 坐实 | `bootstrap.ts:50` `{ concurrency: "unbounded" }`，9 个 service 的 `init()` 同时点燃后台 fiber | 高（事件循环抢占） |
| S3 | **`File.scan` 单次独占事件循环** | ✅ 坐实（已 fork 预热但仍阻塞） | `file/index.ts:379` `Stream.runCollect` 一次性 buffer 全量文件，再主线程 for 循环建 dirname 索引；100k 文件 200–500ms 独占。`cachedScan`（L402）已 forkScoped，但被触发时仍卡 | 中高 |
| S4 | **Instruction `findUp` 无缓存重复扫描** | ✅ 坐实（频率修正） | `session/instruction.ts:109-152` `systemPaths()` **无缓存包裹**：`existsSafe` 循环（L114-119）+ `fs.findUp` 自 ctx.directory 向 worktree 递归（L123-131）+ config.instructions glob（L134-148）。调用频率经核实 = **每次 prompt 构建一次**（`session/prompt.ts:1438` 的 `Effect.all` 内），多步回合按步重复；report 的"每条消息约 2 次"**未能在源码证实**，已下修 | 中高 |
| S5 | **Skill 启动期全量 glob** | ⚠️ **修正：实为懒加载** | `skill/index.ts:255` 经 `InstanceState.make` 包裹，首次访问才 `discoverSkills`，**不在启动期 eager 执行**。report 的"启动期扫描"定性偏重 | 低（仅首访） |
| S6 | **FileWatcher 启动 git-dir 解析 + subscribe** | ⚠️ **修正：低影响** | git 操作快、subscribe 已 fork；O(`.git` 内文件数) 通常 10–50 | 低 |
| S7 | **Data Migration 启动期分页扫表** | ⚠️ **修正：已后台化** | `data-migration.ts` 已 `Effect.forkScoped`，不阻塞启动；仅首次升级有后台 I/O | 低（启动） |

### 2.2 `/global/health` 慢（用户主诉 1）

✅ **坐实，且是架构级而非单点**：

- handler 本体 O(1)：`server/routes/instance/httpapi/handlers/global.ts:75-77` 仅返回 `{ healthy:true, version }`。
- 但请求要穿越**完整管线**：`server/routes/instance/httpapi/server.ts:189` `Layer.mergeAll(rootApiRoutes, …)` 后 `Layer.provide([errorLayer, compressionLayer, corsVaryFix, fenceLayer, cors, …~45 个 defaultLayer])`（L190-244），加 root 组自带 `schemaErrorLayer` + `authorizationLayer`（L120-124）。
- **真正的 500ms 来源 = 事件循环争用**：bootstrap 尾段 S1/S2/S3 的无界后台 fiber 集中抢 tick 时，即便 health 是 O(1) handler，也排不进 500ms 的调度窗口。stock v1.15.13 **没有任何 fast path**——`webHandler`（server.ts:249）直接 `HttpRouter.toWebHandler(routes)`，health 与其他路由同管线。

### 2.3 snapshot 高频扫描（用户主诉 2）

✅ **坐实，量级最大**：

- 核心成本在 `add()`（`snapshot/index.ts:196-259`）：`sync()`（写 info/exclude）→ `Effect.all([diff-files, ls-files --others], {concurrency:2})`（L198-208，**大目录全量扫描**）→ `ignore(all)`（`check-ignore --no-index --stdin`，L226）→ `stat×N {concurrency:8}` 大文件过滤（L238-254）→ `stage(allow)`（`git add --all --sparse`，L258）。
- `track()`（L279）、`patch()`（L304）、`diff()`（L478）**各自独立调用 `add()`**——没有任何复用。
- 调用频率（`session/processor.ts`）：`track()` @ L109（pre-capture）/ L529（step-start）/ L556（step-finish）；`patch()` @ L591 / L693。N 个工具步的回合 = **6–9 次 `add()`**。
- stock v1.15.13 **没有** `cold` 跳过、**没有**后台预热、**没有** `skipAdd`、**没有** dirty 缓存——全是 fork 后加的。

### 2.4 AI 回复热路径（每请求 / 每 part）

| # | 回退点 | 核验 | 真实位置 | 严重度 |
|---|--------|------|----------|--------|
| R1 | **`provider/transform.ts` 全量消息正则清洗** | 🆕 **新发现（report 漏）** | `provider/transform.ts:62` 源码自带 `// TODO: fix this stupid inefficient dogshit function`；`normalizeMessages` + `sanitizeSurrogates`（L25-26，代理对正则 `/[\uD800-\uDBFF]…/g`）对**每请求的全部消息文本**逐 part 跑正则；Anthropic/Bedrock 还有额外 filter pass。`llm.ts` 每次 streamText 中间件调用 → O(M·P·L) | **高** |
| R2 | **每请求重建 prompt/tools/headers** | ✅ 坐实（偏中低） | `session/llm/request.ts`：system 多源合并（L56-76）+ plugin `chat.system.transform`/`chat.params`/`chat.headers` 三次同步 trigger（L67/L105/L125，调用点无条件，即使无插件也走 trigger）+ `mergeOptions` **3** 层深合并（L89，逐行确认是 3 不是 report 说的 4）+ `resolveTools` 全量过滤 + `toSorted()`（L139/L165/L188-194）。权限过滤经核实落在 `core/permission.ts:37-44` `disabled()`：`tools.filter(t => ruleset.findLast(r => Wildcard.match(...)))` = **每工具对 ruleset 全扫**，O(T·R)；`merge` 仅 `.flat()`（轻） | 中（插件无界是隐患） |
| R3 | **message-v2 装配 O(M·P)** | ✅ 坐实（部分修正） | `session/message-v2.ts` `toModelMessagesEffect` 对**全历史**逐 part：`hasSignedReasoning` 二次全扫（L771）、`supportsMediaInToolResult` 循环内字符串匹配（L646-657,799,803）、`convertToModelMessages`（L904，AI SDK 黑盒）。⚠️ report 说的"语言检测"在 v1.15.13 **不存在** | 中 |
| R4 | **SQLite Projector 逐 part 写库** | ⚠️ **修正：报告与源码相悖，逐行追实** | ① 每个 `PartUpdated` 只碰 **2 张表**（`projectors.ts:174` select+upsert `PartTable` → `applyUsage` `core` 改 `SessionTable`），**不是 report 说的 5 张**。② **关键：逐 token 不碰 SQL**——`processor.ts` 的 `text-delta`/`reasoning-delta`（L334/L645）走 `session.updatePartDelta`（`session.ts:834-842`），它**仅** `bus.publish(PartDelta)`；而 `PartDelta` 是 `BusEvent`（`message-v2.ts` `message.part.delta`，纯内存/SSE），**不在** projectors 的 7 个 `SyncEvent.project` 之列。SQL 写（`PartUpdated`）只在 **part 边界** 经 `updatePart`（start/end/工具状态转换）触发，每轮个位数次。report 的"每 token 一次 SQL 事务"**不成立** | 低（已坐实非瓶颈） |
| R5 | **Native LLM Runtime 额外序列化** | ⚠️ **修正：默认关闭** | `session/llm.ts` 的 native 分支 gated 在 `flags.experimentalNativeLlm` 后，**默认 off**；开启时转换与 AI SDK 路径基本并列，无额外 Schema.Class 重编解码 | 低 |

### 2.5 其它新发现（report 漏）

| # | 回退点 | 位置 | 严重度 |
|---|--------|------|--------|
| N1 | **`config.loadInstanceState` 多次目录向上walk** | `config/config.ts:607,616` 2–3 次 `fs.up()`，深层项目 +50–200ms（bootstrap 早段） | 低中 |
| N2 | **config npm install 无界并发** | `config/config.ts:638-658` 多个 `.opencode` 目录同时 spawn npm install（已 fork 但 I/O 饱和） | 低中 |
| N3 | **config 远程 wellknown 拉取阻塞 bootstrap** | `config/config.ts:556-596` 遍历 auth，每个 `wellknown` 条目串行发 **2 次** `fetchRemoteJson`（L562/L574）；`fetchRemoteJson`（L397-410）**只有 retry、无 `Effect.timeout`**。整段在 `config.get()` 内同步 `yield*`，而 `bootstrap.ts:42` `yield* config.get()` 会 await 它 → **auth 含 wellknown 时直接阻塞 bootstrap，端点挂起无超时兜底** | 中（条件触发，但触发即可能长阻塞） |

---

## 3. 叠加效应（为什么体感是"启动慢、首条慢、每轮慢"）

```
启动阶段（bootstrap, concurrency:"unbounded"）
  → config.get + plugin.init + 9 service init 同时点燃后台 fiber（S2）
  → File.scan 若被触发，200–500ms 独占事件循环（S3）
  → /global/health 排不进调度窗口 → 偶发 >500ms（主诉 1）

首条消息（"完美风暴"，全部懒初始化同时爆发）
  → MCP: spawn N 个子进程 + connect + listTools，无界并发（S1）
  → Snapshot: git init + 首次全量 add() 扫描 1.5–4.5s（主诉 2）
  → Instruction findUp 首扫 + Skill 首次 glob（S4/S5）
  → 叠加 5–15s 阻塞

每轮 AI 回复
  → Snapshot track()/patch() × 6–9 次 = 10–40s（最大瓶颈，主诉 2）
  → provider/transform 全量正则清洗 × 每请求（R1）
  → request.ts 重建 prompt/tools + 插件链（R2）
  → message-v2 装配 O(M·P)（R3）
```

---

## 4. 系统性解决策略（9 类）

不要逐点打补丁，按**策略族**治理；每条标注对应回退点与 fork 是否已验证。

### A. 关键路径绕行（fast path）
轻量探活/高频路由不该穿越重管线。
- **health fast path**：在 `webHandler` 闭包外包 `fastHandler`，命中 `GET /global/health` 直接返回常量 `Response`，绕过 6 层中间件 + `Layer.mergeAll`；URL 用 `endsWith` 字符串匹配避免 `new URL` 构造。**fork 实测 p99 <5ms**。→ 主诉 1 根治。
- ⚠️ 故意省略 auth/cors/observability，需在代码旁写明"为何安全"（health 仅 loopback 探活），防被后续 review 善意撤回。

### B. 并发收敛（concurrency capping）
把"同时点燃的后台 fiber / 子进程"从无界压到个位数，削峰防事件循环饥饿。
- bootstrap 外层 `unbounded → 4`（S2）；MCP spawn `unbounded → 3`（S1，`mcp/index.ts:559`）；config npm install 加界（N2）。
- 依据：init 函数本身轻量（重活已 forkScoped），收敛并发对总耗时影响 <10ms，只削峰。

### C. 预热 / 移前（eager warmup）
把高成本懒初始化从**用户交互路径**移到**启动后台**。
- **MCP 进 bootstrap**：给 `MCP.Service` 加 `init()`（内部 `InstanceState.get` 触发缓存），加入 bootstrap 并行数组 → 首条消息不再等 spawn+listTools（S1）。
- **snapshot 首次 track 后台预热**：state init 末尾 `Effect.cached(track())` + `forkScoped`；对外 `track` 用一次性消费标志复用预热结果（主诉 2 首启段）。

### D. 冷路径简化（cold-path skip）
首次 index 必空时跳过无意义的 git 操作。
- snapshot `add()` 加 `cold` 选项：gitdir 首次 init 时跳过 `diff-files`/`check-ignore`/`git rm --cached`，仅 `ls-files` + `stat` + `git add`（主诉 2）。

### E. 去重 / 缓存（dedup & cache）
- **snapshot `skipAdd`**：`patch(hash,{skipAdd})` / `diff(hash,{skipAdd})`；processor 在紧邻 `track()` 后的 `patch()` 传 `skipAdd:true`，省 1 次全量扫描（主诉 2，**单步省 1.5–4.5s**）。
- **instruction findUp 缓存**：InstanceState 级缓存 `systemPaths()` 结果（S4）。
- **message-v2 memoize**：`supportsMediaInToolResult` 按 model 记忆一次；`hasSignedReasoning` 改主循环内单遍 flag，去掉二次全扫（R3）。

### F. 流式让步（cooperative yielding）
长同步循环让出事件循环，保 health/SSE/TUI 调度。
- `File.scan`：`Stream.runCollect` → `Stream.runForEach` 边收边建索引，`processed % 2000 === 0` 时 `yield* Effect.yieldNow`（S3）→ 100k 文件从单次独占变 ~50 个 <10ms 片段。

### G. 增量代替全量（incremental，**高风险/低优先**）
- snapshot dirty 缓存：`lastHash + dirty` 标志，FileWatcher 事件驱动失效，`!dirty` 时复用 lastHash。**风险：依赖 watcher 事件准确性，漏报 → 快照不一致**。收益场景窄（长会话纯推理），fork 评估为**暂不做**。
- message-v2 增量装配代替全量重建（R3）；provider/transform 正则预编译/按需（R1）。

### H. 去噪（remove noise RPC）
- MCP `collectFromConnected` 调 `listPrompts/listResources` 前先 `getServerCapabilities()?.[capability]` 过滤；tools-only server 不再触发 JSON-RPC `-32601`，每次刷新省 N 次无效往返。

### I. 防御性注释固化（lock-in intent）
所有"故意绕过/取值依据（4 / 2000 / fast-path 省略项）"在代码旁写成段注释，避免下次 vendor bump merge 时被回退。

---

## 5. 优先级路线图（按 ROI）

| 优先级 | 动作 | 策略 | 回退点 | 成本 | 风险 | fork 已验证 |
|--------|------|------|--------|------|------|------------|
| **P0** | health fast path | A | 主诉1 | 低 | 低 | ✅ p99<5ms |
| **P0** | bootstrap 并发 →4 | B | S2 | 低 | 低 | ✅ |
| **P0** | MCP spawn 并发 →3 | B | S1 | 低 | 低 | ✅ |
| **P0** | MCP 进 bootstrap 预热 | C | S1 | 低 | 低 | ✅ |
| **P0** | snapshot `skipAdd` | E | 主诉2 | 低 | 低 | ✅ 单步省 1.5–4.5s |
| **P0** | File.scan 流式让步 | F | S3 | 低 | 低 | ✅ |
| **P1** | snapshot cold path + 后台预热 | C+D | 主诉2 | 中 | 低 | ✅ |
| **P1** | instruction findUp 缓存 | E | S4 | 中 | 低 | ⬜ 待做 |
| **P1** | MCP capability 过滤去噪 | H | — | 低 | 低 | ✅ |
| **P1** | config npm install 加界 / 远程拉取后台化 | B | N2/N3 | 中 | 低 | ⬜ 新发现 |
| **P2** | provider/transform 正则预编译/精简 | G | R1 | 中 | 中 | ⬜ **新发现，建议优先评估** |
| **P2** | message-v2 增量装配 + memoize | E+G | R3 | 高 | 中 | ⬜ |
| **P2** | snapshot dirty 缓存 | G | 主诉2 | 中 | **高（快照一致性）** | ❌ fork 暂不做 |

**先做 P0 六件套**：两个主诉直接被 health fast path + snapshot skipAdd/预热 + 并发收敛覆盖，成本低、风险低、fork 已实测。R1（provider/transform）是 report 漏掉的高价值新点，建议在 P2 里**优先排查发射量级后再决定**。

---

## 6. 对本项目的落地建议（bump 工作流）

1. **本项目走 patch 机制**（CLAUDE.md §Vendor Patch）：上述修复**全部固化为 `patches/vendor-opencode-perf-*.patch`**，与现有 `vendor-opencode-config-fix.patch` 并列，由 `setup.sh` / `build-opencode.ts` 自动 apply。
2. **bump 顺序**：先按 `vendor-opencode-bump-survey.md` 处理配置隔离 patch 的搬家（global→core/global.ts、managed dir→config/managed.ts），再叠加本文 perf patch。
3. **每次 bump 重新核验**：v1.15.13 之后上游可能已自行修复部分点（尤其 R1 那个自带 TODO 的函数、projector 发射频率），apply 前先 `git log --oneline <旧>..<新> -- packages/opencode/src/{snapshot,provider/transform.ts,project/bootstrap.ts,mcp,server/routes/instance/httpapi}`，避免重复打或冲突。
4. **fork 复用**：fork 已把 P0/P1 大部分实现为 commit（health fast path、snapshot cold/skipAdd/预热、bootstrap/MCP 并发、File.scan 让步、MCP capability 过滤）。本项目 bump 时可直接 cherry-pick 思路或移植成 patch，不必重造。

---

## 7. 验证基准（Definition of Done）

| 指标 | 目标 | 测法 |
|------|------|------|
| `/global/health` p99 | **<500ms（理想 <5ms）** | 100k 文件目录 + N 个 MCP server，bootstrap 尾段并发压测下打 health |
| 每轮 snapshot 总耗时 | 大目录单步 `add()` 不超 1 次 | 计时 `track()`/`patch()` 调用 + add() 次数计数 |
| 首条消息阻塞 | MCP 不在交互路径 spawn | 日志确认 MCP 在 bootstrap 预热、首条消息 0 spawn |
| 事件循环让步 | File.scan 无 >10ms 独占段 | `yieldNow` 计点 / event-loop lag 监控 |

建议在 fork 与本项目各留一个**可复跑的 perf 基准脚本**（造 100k 文件目录 + mock N MCP），bump 前后对比，防回退复发。

---

## 8. 开放问题 / 风险

- ~~**R4 projector 发射频率**待实测~~ → **已逐行追实并结案**：逐 token 走 `PartDelta`（内存/SSE），**不进 SQL**；`PartUpdated`（2 表写）仅 part 边界触发，每轮个位数次，非瓶颈。唯一真实小成本：`updatePart`（`session.ts:643`）每次全量更新做 `structuredClone(part)`，大工具输出时深拷贝有量级但仅 part 边界发生——可观察，非热点。
- **G 类（dirty 缓存 / 增量装配）有正确性风险**，非性能纯收益，需充分测试，优先级压后。
- **patch 漂移**：这些是 vendor 本地 patch，上游每次 bump 可能冲突；R1 的函数上游自带 TODO，未来很可能被官方重写——届时本地 patch 要让位官方实现，别硬保。
- **本文基于 v1.15.13 静态读码 + fork 实测**，本项目实际 bump 后仍需在**本机真机 + 大目录**复测，数值仅供量级参考。

---

## 9. fork 项目适配增补

> 本文主体是站在**本项目（仍 pin v1.3.13，未 bump）**视角写的，默认"什么都还没做"。但 fork 项目**已在 v1.15.13 且按 `dev-performance-regression-report.rtf` 落地了一批修复**。fork 读本文时**不要照搬 §5 待办清单**——它的一半对 fork 已过时。fork 该用本文做三件事：① 用 §2 的"修正/证伪"砍掉无效优化；② 用下表的"未碰"列定位真盲点；③ 用 §4 策略 + 下面的落地补充规划剩余 P1/P2。

### 9.1 fork 现状对账（已修 vs 未碰）

把 RTF 已知的 fork commit 映射到本文回退点，gap 一目了然：

| 回退点 | 本文判定 | fork 状态（据 RTF） | fork 下一步 |
|--------|---------|---------------------|------------|
| S1 MCP 懒初始化 | 极高 | ✅ 已修 `3678a8715`（eager + spawn 并发→3） | — |
| S2 bootstrap 并发无界 | 高 | ✅ 已修 `0ac948ce9`（→4） | — |
| S3 File.scan 独占 | 中高 | ✅ 已修 `0ac948ce9`（runForEach + yieldNow 2000） | — |
| 主诉1 `/global/health` | — | ✅ 已修 `0ac948ce9`（fast path，p99<5ms 实测） | 补回归测试（9.5） |
| 主诉2 snapshot 高频扫描 | — | ✅ 部分修 `c64653355`（cold+预热）+`bc7c64ea6`（skipAdd） | dirty-cache 仍 defer（风险高，见 §8） |
| MCP `-32601` 去噪 | — | ✅ 已修 `0ac948ce9`（capability 过滤） | — |
| **R1 provider/transform 正则** | **高** | ❌ **未碰** | **优先（9.2）** |
| R2 request 重建 | 中 | ❌ 未碰 | profiling 后定（9.3） |
| R3 message-v2 装配 | 中 | ❌ 未碰 | memoize（§4 E） |
| S4 instruction findUp 无缓存 | 中高 | ❌ 未碰 | InstanceState 级缓存（§4 E） |
| N1 config 目录 walk | 低中 | ❌ 未碰 | 低优 |
| N2 config npm install 无界 | 低中 | ❌ 未碰 | 加界（§4 B） |
| N3 config wellknown 无 timeout | 中 | ❌ 未碰 | 加 `Effect.timeout`（9.4 条件触发） |

> ⚠️ RTF 标"剩余 TODO / 未触及"的 #4–#11 与上表"未碰"列一致——以 fork 自己仓库 `git log` 为准复核，本表据 RTF 文字推断。

### 9.2 R1（provider/transform）落地方案——fork 当前最高价值点

**为什么优先**：每 LLM 请求对**全量历史消息文本**跑代理对正则清洗（`sanitizeSurrogates`，`provider/transform.ts:25-26`），O(M·P·L)；源码自带 `// TODO: fix this stupid inefficient dogshit function`（L62）——上游已知烂但没修。会话越长越拖每一轮。

**关键洞察**：历史消息**不可变**——`normalizeMessages` 每请求重扫全量，但只有**新增的那条/那几条**变了。两条互补优化（建议都做、可分步）：

1. **按 part 记忆已清洗结果**：以 `part.id`（+ 内容 hash 兜底防原地改）为 key 缓存 sanitize 后的文本；命中即跳过正则。把"每请求全量" 降到"只处理增量"。
2. **already-clean 快速判定**：绝大多数正常文本不含游离代理对——先用一次廉价扫描（或 `String.prototype.isWellFormed?.()`，Node 20+/Bun 有）判定，干净就**原样返回不进正则替换**。对中文/英文/emoji 正常文本几乎都命中，省掉 replace 分配。

> ⚠️ `sanitizeSurrogates` **不能删**——游离代理对会让 JSON 序列化 / provider API 报错，是正确性保护；只能"少做"不能"不做"。Anthropic/Bedrock 的额外 filter pass（`transform.ts` L133+）同理按 provider 分支，可一并 memoize。
> ⚠️ **先验后改**：本方案是基于"历史不可变"的假设推断，fork 落地前应先确认 `normalizeMessages` 入参确实是累积历史（而非已增量切片），并跑 9.3 profiling 确认它真的是热点再投入。

### 9.3 量化 / profiling 配方（severity 是估的，排序前必须真测）

本文所有 severity 是**静态读码估算**，不是测量。fork 排 R1 vs R2 vs R3 优先级前，在三处插 timing（`performance.now()` 或 Effect span 已有的 `withSpan`，看 trace）：

| 插桩点 | 位置 | 看什么 |
|--------|------|--------|
| LLM 请求装配总耗时 | `llm.ts` streamText 中间件入口/出口 | 每请求 prepare+transform+convert 墙钟，按 session 消息数分桶看是否随 M 线性涨 |
| `ProviderTransform.message` | `provider/transform.ts` 入口 | R1 单独占比；100 消息会话跑一轮看绝对值 |
| snapshot `add()` | `snapshot/index.ts:196` | 单次墙钟 + 每轮调用次数（验证 skipAdd 后是否真降到 1 次/步） |
| health 调度延迟 | fast path 命中前后 | bootstrap 尾段压测下 p99，确认 fast path 真生效 |

**基准环境**：造 100k 文件目录 + mock N 个 MCP server + 一个 ≥100 消息的长会话；优化前后各跑 3 次取中位数。建议把这套固化成可复跑脚本，进 CI 防回退。

### 9.4 N3 条件触发说明（避免 fork 误判）

N3（config wellknown 无 timeout 阻塞 bootstrap）**仅当用户 auth 配置含 `type:"wellknown"` 条目时触发**（`config.ts:557`）。普通本地 key 用户不会命中。fork 若用户群不用 wellknown 远程 config，N3 可降为最低优先；若用，则补 `Effect.timeout`（对齐 `instruction.ts` 的 5s）+ 失败软降级（拉不到不阻塞启动），是简单高收益修复。

### 9.5 上游漂移核查 + 回归防护（fork 持续追上游的纪律）

1. **行号复核**：fork 在自己 dev（merge 了 `96621fcd3`），与纯 `v1.15.13` tag 可能有偏移——本文 `file:line` 在 fork 树上**以实际 grep 为准**，别照抄。
2. **bump 前先比上游**：动手优化 R1/N3 等前，先 `git log v1.15.13..<上游 dev> -- packages/opencode/src/provider/transform.ts packages/opencode/src/config/config.ts packages/opencode/src/session/{instruction.ts,message-v2.ts}`——R1 那个自带 TODO 的函数**上游迟早重写**，若已修则直接拿上游版本，别自造 patch 跟上游打架。
3. **回归测试固化**（防下次 bump 静默冲掉已有修复）：给 health fast path（命中返回常量、跳过 auth 的安全断言）、snapshot 单步 `add()` 调用次数、MCP 不在首条消息路径 spawn 各加一条测试；策略 I 的"防御性注释"配合测试双保险。
4. **安全注记**：health fast path 故意跳过 auth/cors/observability——fork 若未来引入 Web 仪表盘（浏览器跨域调 health）需重新评估；当前仅 loopback 探活安全。

---

## 关联

- `vendor-opencode-bump-survey.md`（本地专题记忆）— bump 的 patch 搬家与兼容性调研
- `docs/gotchas.md` §1（OpenCode 契约）/ 构建章节 — 坑点 SSOT
- 桌面 `dev-performance-regression-report.rtf` — fork 内部原始分析（本文的核验对象）
- CLAUDE.md §Vendor Patch 管理 — patch 生成/apply 工作流
