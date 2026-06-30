# ADR-039: 自定义 Provider / 模型配置全局化（方案 A — 复用 Rust 全局写入器）

**状态**: Proposed
**日期**: 2026-06-30
**关联轮次**: 配置体系收口

## 背景

Ultrawork 嵌入的 opencode sidecar 用 `OPENCODE_APP_NAME=ultrawork` 把全局配置目录定位到 `~/.config/ultrawork/`（ADR-020）。在此之上，桌面端有多类"配置写操作"，但它们的**作用域不一致**：

| 配置类 | 当前写入 | 作用域 | 机制 |
|--------|---------|--------|------|
| MCP（含 browser / knowledge-base） | `~/.config/ultrawork/opencode.json` (`mcp`) | **全局** | Rust `write_mcp_config` → `modify_global_opencode_json`（`lib.rs:1874/1863`） |
| 内置技能 + 安装技能 | `~/.config/ultrawork/skills/**` | **全局** | Rust 文件拷贝（`ensure_builtin_skills`） |
| provider API key | `~/.local/share/ultrawork/auth.json` | **全局** | `PUT /auth` |
| **自定义 provider 定义 / baseURL / 删除** | **`<workspace>/opencode.json`** (`provider` / `disabled_providers`) | **每工作区** | `PATCH /config`（写实例目录，`config.ts:1505`） |
| **模型选择** | **`<workspace>/opencode.json`** (`model`) | **每工作区** | `PATCH /config` |
| 技能 paths/urls | `<workspace>/opencode.json` (`skills`) | 每工作区 | `PATCH /config` |

也就是说 **MCP 与 skills 早已是全局**，唯独 **provider 定义**（及 model 选择）随 `PATCH /config` 落在每个工作区的 `opencode.json`。这带来一组真实痛点（gotchas §8、discussion 006 §11）：

1. **换工作区即丢失**：在工作区 A 配的自定义 provider，到工作区 B 看不见，要重配。
2. **无活动工作区时配置入口必须禁用**：`x-opencode-directory` 为空时请求命中"漂移的默认实例"——provider 时隐时现、`getModel` 抛 `ProviderModelNotFoundError`、config 偶尔不落盘。
3. **删不干净的幽灵子项**：`PATCH` 走 `mergeDeep` 只能增/改 key、删不掉，删除 provider 只能靠 `disabled_providers` 隐藏 + `whitelist` 过滤残留 model（`client.ts:387-396`、`setProviderDisabled`）。物理残留长期堆在工作区 `opencode.json` 里。

API key 已在全局（`auth.json`），MCP/skills 已全局，因此 provider 全局化是把"配置一处、全工作区可见"这个心智补齐的最后一块。

## 决策

**把自定义 provider 定义、baseURL 编辑、删除（hide）全局化，复用 opencode 原生的全局配置端点 `PATCH /global/config`（`Config.updateGlobal`）；不碰 vendor opencode、不加 Rust 命令。**

### 关键修订：为什么不用 Rust 写文件，而用 `PATCH /global/config`

起草初稿时设想"复用 Rust 全局写入器"（镜像 MCP 的 `write_mcp_config`）。**调研 opencode 运行时后否决了这条**——单靠从外部进程写全局 `opencode.json` **运行时不生效**：

- opencode 把全局配置缓存为**无限 TTL** 的 `cachedGlobal`（`config.ts:1267` `cachedInvalidateWithTTL(..., Duration.infinity)`），provider 列表又缓存在 per-directory `InstanceState`（`provider/provider.ts:985/1293`）。
- **配置目录无 file watcher**（`file/watcher.ts` 只监听项目 worktree + `.git`，不看 config 目录）。
- `POST /instance/dispose` / `POST /global/dispose` 只清实例缓存，**不动 `cachedGlobal`**——dispose 后仍从无限缓存重读旧全局配置。
- 因此 Rust 写完文件后，`GET /provider` / `prompt_async` 看不到新 provider，**直到 sidecar 重启**。这是回归（现状 `PATCH /config` 会 `Instance.dispose()` 即时生效）。

opencode **自带**一个全局配置写端点，正好做对了这件事：

> **`PATCH /global/config`**（`server.ts:100` 挂 `/global` 前缀 → `routes/global.ts:201` → `Config.updateGlobal`，`config.ts:1531`）：从磁盘读 `before` → `mergeDeep` 请求体 → 写回**全局** `~/.config/ultrawork/opencode.json` → `invalidate()`（`invalidateGlobal` 丢无限缓存 + `Instance.disposeAll()`）。

它**写全局文件 + 失效全部缓存**，下一次 `GET /provider` / prompt 立刻重解析。且是**全局路由、不需要 `x-opencode-directory`**——天然消除"无活动工作区不能配"的痛点 2。该端点在我们 pin 的 vendor（1.3.13）里已存在、已编进 sidecar 二进制。

> MCP 当初走 Rust 而非此端点，是因为 MCP 持久化要在 **sidecar 未就绪/关闭时也能落盘**（knowledge-base 注册注释）。provider 配置只在设置页（sidecar 必然在跑）发生，无此约束，故用 HTTP 端点更简、更对。**MCP 维持现状不动。**

### 前端改造点（纯 api-client + 极小 desktop，零 Rust）

新增两个 api-client 方法：`getGlobalConfig()`=`GET /global/config`、`patchGlobalConfig(updates)`=`PATCH /global/config`。然后：

| 文件 | 现状 | 改为 |
|------|------|------|
| `api-client/client.ts` `upsertCustomProvider` | 客户端拼完整 provider 对象 → `patchConfig({provider})` + `setProviderDisabled(false)` | 拼对象逻辑**不变**（whitelist/advanced merge/capability flags 仍在客户端算），末端 `patchConfig` → **`patchGlobalConfig`**；key 仍 `putProviderAuth`（已全局） |
| `api-client/client.ts` `setProviderDisabled` | `getConfig()`(merged) 读 + `patchConfig({disabled_providers})` | `getGlobalConfig()` 读全局 + `patchGlobalConfig({disabled_providers})` 写全局 |
| `components/settings/models-section.tsx` `handleSaveConfig`（baseURL） | `api.patchConfig({provider:{[id]:{options:{baseURL}}}})` | `api.patchGlobalConfig(...)` |
| `components/settings/models-section.tsx` 删除 / `hasWorkspace` 门控 | `setProviderDisabled(true)` + `deleteProviderAuth`；表单按 `hasWorkspace` 禁用 | 删除逻辑不变（仍走 disabled_providers，见下）；**移除 `hasWorkspace` 门控**（全局端点不需工作区） |

**API key 不变**：仍 `PUT/DELETE /auth`（`auth.json` 已全局）。
**model 选择不变**：`setModel` 维持 `PATCH /config`（每工作区/会话粘滞，见下）。

### 取舍：放弃"物理删除"红利，换零 Rust

`updateGlobal` 同样走 `mergeDeep`（删不掉 key），故删除 provider **仍用 `disabled_providers` 隐藏 + `whitelist` 过滤残留 model**（与现状一致，gotchas §8）。即放弃了 Rust 方案"物理删除根除幽灵子项"的红利——但 `whitelist` 本就兜住了幽灵 model，这只是少了块锦上添花。换来的是**零 Rust、零新 Tauri 命令、零跨平台路径代码、diff 极小**，判定划算。

### model 选择**保留每工作区/会话级**，不全局化

opencode 会话的 model 是**会话粘滞**的（首轮 prompt 解析后固化，gotchas §9）。不同项目用不同模型是常见诉求，因此 `model-context.tsx setModel` 维持现状（`PATCH /config({model})`）。**结论：provider 池子全局，当前选哪个 model 仍局部。**

### 明确边界：外部 ACP agent 不受益

全局化只覆盖 **opencode 世界**（单 agent + Team 的 `opencode:*` 委派子会话，共用 :4096 sidecar 的 `opencode.json`）。Team 模式下的**外部 ACP agent**（claude/gemini/hermes/qoder）是独立进程，**从不读 `opencode.json`**——它们经 `agents.json` + 各自原生凭证（`~/.claude` / `~/.gemini` / `~/.hermes`）配置，只接收 `hostMcpServers()` 转发的至多两个 host MCP（knowledge-base + orchestrator delegate）。**全局 provider 不会、也无法喂给外部 ACP agent**，这是架构所限，须在 UI/文档中说清，避免用户误以为"全局 provider 全员可见"。

## 考虑过的替代方案

- **方案 A-Rust — 复用 Rust 全局写入器（初稿设想）**：镜像 MCP 的 `write_mcp_config`，加 4 个 Tauri 命令写全局 `opencode.json`。**否决**：单靠外部进程写文件，运行时**不生效**（opencode 全局配置无限缓存 `cachedGlobal`、配置目录无 watcher、dispose 端点不刷全局，见决策节），要到重启才可见——是回归。且需 4 命令 + 跨平台路径 + Rust 测试，比 HTTP 端点重得多。唯一独有红利"物理删除"由 `whitelist` 已兜住，不值当。
- **方案 C — 连 model 一起全局化**：会改变"会话粘滞 + 多项目不同模型"的既有行为，收益不抵行为破坏。**否决（保留局部）。**
- **不做，维持每工作区**：痛点 1/2/3 持续存在，与已全局的 MCP/skills/key 心智割裂。**否决。**

## 后果

**正面**
- provider 配置一次、全工作区可见，与 MCP/skills/key 的全局心智一致。
- provider 配置入口不再依赖活动工作区，消除"漂移默认实例"类偶发故障（痛点 2）。
- 即时生效：`updateGlobal` 写完即 `invalidate()`，无需重启 sidecar。
- 零 vendor 改动、零新 Tauri 命令、零跨平台路径代码，diff 极小，bump 维护面不增加。

**负面 / 风险**
- **存量迁移 — 经评估不实现（无存量用户）**：opencode 配置合并顺序是"全局先、项目后"，**项目配置优先级更高**。理论上，已在某工作区 `opencode.json` 写过 provider 的老用户，其工作区残留会**覆盖**新写的全局 provider。曾考虑两案：(a) 首启一次性清扫 recent workspaces（迁移残留入全局后剥离）；(b) 仅文档化、手动清理。**最终决策：(b)，且不实现 (a)。** 该软件尚无存量用户——自动迁移是为"不存在的安装"写的兼容代码，纯冗余且要永久维护（曾实现 (a) 后整段回退，分支已删）。残留只可能来自开发者自测，手动删对应工作区 `opencode.json` 的 `provider`/`disabled_providers` 块即可（gotchas §8 已记）。**若将来有了存量用户基数再考虑 (a)。**
- **跨进程写竞态（低、已存在类）**：Rust（`write_mcp_config`，原子 rename + 进程内锁）与 opencode（`updateGlobal`，`fs.writeFileString` 非原子）写**同一个**全局 `opencode.json`。极端并发下 last-writer-wins 可能丢一侧改动；但二者都是用户驱动的、相隔数秒的离散动作（设置页存 provider vs 加 MCP），重叠概率极低，且 Rust 侧读到半写文件会解析失败而中止（不损坏）。与 gotchas §8 既有结论一致（"last writer wins，文件不损坏"）。不额外加锁。
- 跨平台：无新增路径代码；全局文件位置由 opencode 自身（`Global.Path.config`，已随 `OPENCODE_APP_NAME` + xdg-basedir 三平台解析）决定。
- 测试：api-client 改 `upsertCustomProvider`/`setProviderDisabled` 的单测断言从 `/config` 改为 `/global/config`；新增 `getGlobalConfig`/`patchGlobalConfig` 单测；desktop `models-section.test.tsx` baseURL 路径断言更新；真机走查"配 provider → 切工作区仍在 → 即时可选"。**无 Rust 测试改动。**

## 后续强化：opencode「软刷新」机制 — 即时生效且不打断在用会话（系统性）

初版用 `PATCH /global/config`（hard）即可写全局 + 即时生效，但深查 opencode 运行时发现一个被低估的代价：`Config.invalidate()` = `invalidateGlobal` + **`Instance.disposeAll()`**，而 `disposeInstance` 会运行 `SessionPrompt` runner 的 finalizer → **abort 该实例所有在流回合**（源码确证：`prompt.ts` runner finalizer → `Fiber.interrupt` → `llm.ts` `acquireRelease` `ctrl.abort()` → 真正中止 fetch）。即"改一次 provider 会把所有工作区正在流式的回合一起打断"——多会话 / Team 并发下是真实危害。且单纯从外部写文件运行时**不生效**（全局 config 无限缓存 `cachedGlobal`、配置目录无 watcher、`/instance/dispose`/`/global/dispose` 都不刷全局缓存）。

**决策：做一个通用「软刷新」机制**，把"刷新配置派生缓存"与"拆整个 instance"解耦：

- 新增 `effect/soft-invalidate-registry.ts`（与 `instance-registry` 的 disposer 集合平行的软失效集合）。`InstanceState.make(init,{soft})` / `makeSoft` 在置位时把同一个 invalidator **额外**注册进软集合。
- **(A) 配置派生纯缓存**（无 finalizer，可随便驱逐重建）标 `makeSoft`：config / provider / provider-auth / skill / agent / command / format / tool-registry（8 个）。
- **(B) 活资源**（finalizer 会杀子进程/流/socket/订阅）**绝不标 soft**：SessionPrompt(流式 runner) / MCP(stdio) / LSP / PTY / FileWatcher / Plugin / **Bus(杀了 SSE 全断)** / Permission / Question / ShareNext / Vcs / SessionStatus / Instruction / FileTime。
- `Config.refreshGlobal()` = `invalidateGlobal` + `Instance.softRefreshAll()`（遍历活跃目录只软失效 (A)，惰性驱逐重建，失败 `log.warn` 不静默），**不调 disposeAll**。
- 路由：`PATCH /global/config?refresh=soft`（写 + 软刷新；`?refresh` 缺省仍走 hard `disposeAll`，对 TUI / 其它 config key 零影响）+ 新增 `POST /global/refresh`（只软刷新不写）。

**安全性关键**：活跃回合的流式 fetch 绑在 SessionPrompt(B) + `llm.ts` 自己的 AbortController 上，**不绑在 provider/config(A) 上**；(A) 全是无 finalizer 纯缓存，驱逐只丢缓存值对象（JS GC 保活在用引用）、不关任何 scope。故只刷 (A) 不碰 (B) → 流不中断。「注册生命周期」安全（最高风险项）：`make` 在 layer/runtime 构造时跑一次，其 `addFinalizer(off/offSoft)` 绑长生命周期 runtime scope；`disposeAll` 只让注册的 invalidator 驱逐缓存项、**不关 make-scope**，故软失效器不会被 disposeAll 注销——镜像既有 `registerDisposer`，且 e2e `provider-soft-refresh` 的「硬后软仍生效」用例实测确证。

**应用接线**：api-client `patchGlobalConfig` 走 `?refresh=soft`、新增 `refreshGlobalConfig()`=`POST /global/refresh`；provider 写入即时生效不打断；**skills**——opencode 技能列表缓存且无 watcher，新装技能此前要重启才见，`use-skills.refresh` 现先 `refreshGlobalConfig()` 再拉取 → 即时可见、不打断（agents/commands 同 (A) 集合白捡）。

**已知限制（#3，设计如此）**：软刷新**不覆盖 MCP / plugin / LSP 配置变更**——它们是 (B) 活资源，软刷新刻意不碰；这类全局配置变更需 hard dispose/重启才 live。对 Ultrawork 无实际影响（MCP 走 Rust 持久化 + `POST /mcp` 运行时注册，本就 live，不依赖全局 config 软刷新）。API key 不在任何 (A) 缓存（`Auth` 每次读 `auth.json`），改 key 无需刷新即生效。

此强化同时**消解了上文的 disposeAll 爆炸半径风险**（provider 改动不再打断任何在流回合）。跨进程写竞态结论不变（仍建议文档化）。

## 关联：`~/.ultrawork` 命名不一致（**本 ADR 范围之外**）

调研顺带发现三处 sidecar 把数据硬编码在 `~/.ultrawork`、不认 XDG，与 config/acp/orchestrator 走 XDG 的约定割裂：

- `packages/knowledge/sidecar/src/index.ts:16-17` — `~/.ultrawork/knowledge/kb.db`（数据，理应 xdgData）
- `packages/channel/gateway/src/config-store.ts:7-8` — `~/.ultrawork/channels.json`（配置，理应 xdgConfig）
- `packages/channel/gateway/src/session-store.ts:5` — `~/.ultrawork/session-map.json`（状态/数据）

**评估**：代码改动本身**极小**（各是一个 `join(homedir(), ".ultrawork", …)` 常量），且**已是跨平台安全的**（用 `homedir()` 非 `$HOME`，ADR-037 的硬要求并未违反——这是命名一致性问题，不是跨平台 bug）。但**收口收益有限、风险不为零**：

1. 生产环境这两个 sidecar 本就不被注入 `XDG_CONFIG_HOME`（gotchas §8），即便改成 XDG-aware，默认仍解析到同样的 `~/.config`/`~/.local/share`——**生产行为不变**，唯一实益是测试隔离能一起搬 + 概念整洁。
2. **存量数据**：用户机器上已有 `~/.ultrawork/knowledge/kb.db`（重建索引成本）、`channels.json`（钉钉/微信凭证）。挪窝需迁移逻辑，否则丢数据。
3. `~/.ultrawork` **不会消失**：Rust 仍在其下放 workspace/node/browser-MCP/chrome-profile/sidecar 副本等大量**非配置**资产，这些本就该留在那。

**建议：不并入本 ADR。** 两件事目标不同（本 ADR 是"作用域：项目→全局"，那个是"命名空间一致性"），耦合会放大迁移风险。若要做，单列一个轻量任务/ADR，且仅在带"移动既有文件 if exists"的迁移下进行；否则文档化为"已知不一致、跨平台安全、暂不收口"即可。
