# 042 — Team 协作模式启动期偶发不可用（ACP 冷启动竞态 + 无自动重试）

> 状态：**✅ 已实现（三层全做）**（用户拍板"先出文档再开发"）· 2026-07-16
> 实现落点：`lib/agent-context.tsx`（`nextAgentPollDelay` + `reduceAcpPoll` + 单自调度 tick 循环，替换旧一次性挂载探测 + 自锁轮询）· `components/settings/agents-section.tsx`（折叠本地 `available` → 共享 `acpAvailable`）· `__tests__/lib/agent-context.test.ts`（10 例锁 cadence + 状态机）。真机自动恢复验收归用户。
> 范围：修复"真机启动后偶发 Team 协作模式禁用、tooltip 显示「外部 Agent 服务未运行（:4099）」，手动打开主 agent 下拉即恢复"的缺陷。
> 根因层级：**已代码确证**（两条独立排查路径闭合，确定性逻辑缺陷，非概率抖动）。
> 决策定档：自愈方案走**单自调度轮询 + 几何退避**（对齐仓内 `nextChannelPollDelay` 范式），**双向去抖**，设置页**折叠去重**。

---

## 一、缘起（现象）

真机启动后**偶尔**出现：Home 顶部「单 Agent | Team」分段控件中 **Team 段禁用**，hover 提示「外部 Agent 服务未运行（:4099）」。用户发现——**只要点开一下"主 agent"下拉选择，Team 就恢复可用**。

---

## 二、根因（逐环代码佐证，已确证）

### 2.1 Team 可用性 = 单一布尔 `acpAvailable`

- `pages/Home.tsx:318` → `teamDisabled={!acpAvailable}`；disabled 时 tooltip = `agent.sidecarUnavailable`（`i18n-translations.ts:978` =「外部 Agent 服务未运行（:4099）」）。
- 同一量还控制 agent-selector 底部提示（`agent-selector.tsx:124`）。

### 2.2 `acpAvailable` 初值 false，仅由一次挂载探测确定

- `agent-context.tsx:45` `useState(false)`；`:62-99` `refreshAgents()` 调 `acp.http.health()`（GET `:4099/acp/health`，2s 超时，`acp-http.ts:80-90`）→ `setAcpAvailable(healthy)`。
- `:101-103` 只在**挂载时跑一次**。`AgentProvider` 是 app 级 Provider，整个生命周期只挂载一次、不会重挂。

### 2.3 关键：ACP sidecar 在"首帧渲染那一刻"才开始启动，探测与之抢跑

- 启动门（`get_sidecar_ports`）**只等 opencode（4096）** 健康就放行首帧——`src-tauri/src/lib.rs:143`「once opencode is healthy」。
- `lib.rs:121-124`：gateway、knowledge、**acp** 只在 opencode 健康**之后**才开始 spawn，即"UI 首次出现那一刻附近"。
- `lib.rs:6500-6548`：ACP sidecar 在自己的 `std::thread::spawn` 里起、注释明说「non-critical, don't block UI」；boot 标 `ready` 只看 `engine_ok`（opencode），三个非关键 sidecar（含 acp-client）"仍在各自线程里启动，UI 没它们也可用"。
- ⇒ WebView 加载 + `AgentProvider` 挂载（发那次一次性探测）**必然早于** ACP 的 `:4099` 健康。**竞态窗口是设计使然**，不是偶发抖动。

### 2.4 失败后无任何自动恢复路径

- 唯一的轮询 effect（`agent-context.tsx:112-140`，4s/次）开头即 `if (!acpAvailable) return`——它只维护**已连上**的 per-agent 状态点新鲜度，**从不从初次失败中恢复**，也不调 `health()`/`setAcpAvailable`。
- 全仓其余 `refreshAgents()` 触发点全是**手动 UI 交互**：agent-selector 下拉**打开**（`:58` `if (next) void refreshAgents()`，注意是"打开"而非"选中项"）、team-member-select（`:28`）、设置页外部 Agent（`agents-section.tsx:110`）。

### 2.5 现象闭合

「启动 Team 禁用 / 打开下拉即恢复」是上述链的**必然结果**：一次性挂载探测撞上故意后启、非阻塞的 ACP sidecar；失败后唯一轮询自锁在 `if(!acpAvailable) return` 无法自愈；只能靠手动打开下拉重探（`agent-selector.tsx:58`）恢复。真机复现只影响"命中概率"，不影响"缺陷存在"的判定。

### 2.6 顺带发现的对偶 bug（"只上不下"）

稳态轮询捕获并吞掉 `listAgents` 异常、**从不把 `acpAvailable` 降回 false**。⇒ ACP 若中途崩溃，Team 会**错误地保持可用**，用户点 Team 才失败。属同一处的对偶缺陷。

---

## 三、方案（定稿）

对齐仓内既有冷启动修复 `channel-sessions-context.tsx`（`nextChannelPollDelay`，见其 `:22-46, :80-111`）的**单自调度 `setTimeout` 循环 + 成功清零 failures + 几何退避**范式。

### 3.1 结构：两 effect 合一

把 `agent-context.tsx` 现有的两个 effect（mount 一次性 `refreshAgents` `:101-103` + 自锁 4s 轮询 `:112-140`）合并为**一个自调度 `setTimeout(tick, …)` 循环**，同时承担：①（重）探测拉起可用性、②稳态刷新 per-agent 状态点、③掉线降级。`refreshAgents`（导出回调）保留给下拉/设置页手动触发。

状态提升到组件作用域 ref，供循环与手动回调共享同一真相：`failuresRef`（连续失败计数）、`availableRef`（`acpAvailable` 镜像）。

### 3.2 单 tick 逻辑（双向自愈）

```
tick():
  acp = connector.getBackend(ACP)
  if (!acp): failuresRef++; schedule(nextAgentPollDelay(failuresRef)); return

  if (availableRef.current):
    // 稳态：listAgents 成功即等价 health（省一次请求）
    try:
      fresh = await acp.http.listAgents()
      mergeStatuses(fresh)              // 现有 4s 轮询的活，更新圆点
      failuresRef = 0
    catch:
      failuresRef++
      if (failuresRef >= DOWN_THRESHOLD):
        setAcpAvailable(false); availableRef = false
        setAgents([OPENCODE_AGENT])     // ACP agent 已不可达，回退
  else:
    // (重)连接探测：显式 health()，便宜、2s 超时
    healthy = await acp.http.health()
    if (healthy):
      acpAgents = await acp.http.listAgents()
      setAgents([OPENCODE_AGENT, ...acpAgents]); hydrateBindings()
      setAcpAvailable(true); availableRef = true; failuresRef = 0
    else:
      failuresRef++

  schedule(nextAgentPollDelay(failuresRef))
```

- 稳态用 `listAgents` 兼作健康信号（不额外加请求）；仅掉线/未连时走显式 `health()`。
- **上行立即置真**（冷启动快速解禁，修主症状）；**下行去抖**（见 3.4）。

### 3.3 退避形参（纯函数，抽出并导出以便单测）

```ts
const STEADY_MS      = 4_000    // 沿用现有 agent 状态轮询 4s 稳态，零行为回退
const BOOT_RETRY_MS  = 1_000    // 首次失败后 1s 起跳，快速拉起
const MAX_BACKOFF_MS = 30_000   // 见下"与 channel 的差异"
const DOWN_THRESHOLD = 2

export function nextAgentPollDelay(failures: number): number {
  if (failures <= 0) return STEADY_MS
  return Math.min(BOOT_RETRY_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
}
```

节奏序列（failures=1…）：`1s → 2s → 4s → 8s → 16s → 30s(封顶) → 30s…`

**`MAX_BACKOFF_MS` 取 30s（≠ channel 的 5min），刻意不同**：channel 的 5min 是因"多数用户根本没配 IM 渠道"、gateway 可能永久缺席；而 **ACP sidecar 是 `boot_sidecars` 每次必起的自带 sidecar，正常几秒内就绪，"缺席"= 崩溃/spawn 失败（罕见）**——故要更快恢复节奏，30s 封顶仍兜住真死的 sidecar 不被永久轰炸。

冷启动收益：`acpAvailable` 初值 false → 循环走 reconnect 支、以 1/2/4/8s 探 `health()` → ACP 就绪后**下一 tick 内（≤ 数秒）自动解禁**，无需用户动下拉。

### 3.4 掉线去抖（防抖动闪禁用）

- `DOWN_THRESHOLD = 2`：稳态下连续失败 **≥2** 次才把 `acpAvailable` 翻 false。
- 单次瞬时抖动只把 `failuresRef` 记为 1 → 因 `failuresRef>0` 下次 tick 以 ~1s 快节奏复检；恢复则清零回稳态，再失败（=2）才降级。
- 真崩溃检测时延约 **1–2s**（`f=1` delay 1s → `f=2` 降级），可接受。
- **上行不设阈值**（首次 `health()` 成功即置真），保证冷启动快速解禁。

### 3.5 effect 结构与并发交互

- **单 effect，依赖 `[connector]`**：内部 `let cancelled=false`；`tick` 用 `setTimeout(tick, nextAgentPollDelay(failuresRef.current))` 自调度；cleanup 置 `cancelled=true` + `clearTimeout`。删除 `:101-103` 与 `:112-140`，合二为一。
- **`setTimeout` 递归而非 `setInterval`**：间隔随 `failuresRef` 变，必须递归调度。
- **`failuresRef` / `availableRef` 提升到组件作用域**，`refreshAgents` 与 `tick` 共享；`refreshAgents` 成功时也写 `availableRef=true / failuresRef=0`，形成手动"快路径"。
- **手动 `refreshAgents` 保留即时语义（无去抖）**：用户显式打开下拉/进设置 = 明确要"现在的真相"，立即反映；去抖只作用于后台被动轮询。此不对称是刻意决定，代码写注释说明。
- **保留 `refreshing` ref 防重入**在 `refreshAgents` 上；`tick` 用内联 `health()/listAgents()`，与手动调用重叠是**幂等只读 + 收敛写**（都写向同一服务端真相，React 批处理末次生效），无害。

### 3.6 设置页 `agents-section.tsx` 去重并继承自愈

**折叠**：删掉本地 `available` 状态与其 `health()` 探测（`:90, :102-103`），改从 `useAgents()` 取共享 `acpAvailable`（该组件已 `import useAgents`）。保留本地 `agents: ACPAgentInfo[]`（比统一 `agents` 多带配置详情），其 (re)fetch 由共享可用性驱动。收益：消除重复探测 + 一并修掉设置页同源冷启动 bug；契合 SSOT。风险低（设置页非启动首帧）。

---

## 四、常量汇总

| 常量 | 值 | 依据 |
|---|---|---|
| `STEADY_MS` | 4_000 | 沿用现有 agent 状态轮询节奏，零行为回退 |
| `BOOT_RETRY_MS` | 1_000 | 与 channel 冷启动一致，1s 起跳快速拉起 |
| `MAX_BACKOFF_MS` | 30_000 | ACP 必起、期望在线 → 比 channel(5min) 更快恢复、仍兜住真死 |
| `DOWN_THRESHOLD` | 2 | 单次抖动不闪禁用，2 次连败才降级 |

---

## 五、测试点（确定性锁死）

1. `nextAgentPollDelay` 纯函数：`0→4000`、`1→1000`、`2→2000`、`4→8000`、`6→30000(封顶)`、大数仍封顶。
2. 双向翻转逻辑（抽成可测的纯 reducer，避免驱动异步定时器）：`unavailable + health成功 → available, failures=0`；`available + listAgents失败×1 → 仍 available, failures=1`；`×2 → available=false`；`失败后 health恢复 → available=true`。
3. 手动 `refreshAgents` 与 `availableRef/failuresRef` 共享写入。
4. 设置页折叠后：`available` 来自 context、随其变化。

---

## 六、验证策略（记明结构性限制）

- 单测覆盖退避函数 + 双向状态机（确定性）。
- **启动竞态本身 e2e 结构上难复现**（Playwright 驱动浏览器，那里没有会被堵住的主线程；同 ADR-047/048/051/054/055 撞过的墙）。真机验收：**人为延迟 ACP 起动**（临时给 `boot_sidecars` 的 acp 线程加 sleep 或断点）后观察"Team 从禁用自动恢复、无需点下拉"——属可编程/可观测断言型验收，视觉观感归用户。

---

## 七、范围与风险分层（可裁剪）

- **必做（修主症状）**：§3.3 + §3.5 的上行自愈循环。仅此即让"启动 Team 禁用"自动恢复。
- **建议做（修对偶 bug + 防抖）**：§3.2 双向 + §3.4 去抖。让 ACP 中途崩溃时 Team 也正确禁用。
- **建议随手做（去重）**：§3.6 设置页折叠；可降级 backlog。

三层互相独立，按纳入意愿逐层落地。

---

## 七点五、实现后对抗审查（2026-07-16，两独立 reviewer + provider 级集成测试）

**自动化验证**：除纯函数单测外，新增 `agent-context-provider.test.tsx`——fake-timer 虚拟时钟驱动**真实自愈循环**：冷启动 false→退避探测→自动翻 true（roster 填充）、单次瞬时失败不闪禁用、连续两次降级、卸载无泄漏、稳态 reconcile 反映服务端增删。desktop 全量 **661** 绿 + typecheck。

**两 reviewer 结论**：无 HIGH。Q4（单/Team 隔离）、Q5（附件/截图零交叉，chat-input 不引用 agent-context，AgentSelector 未改）、所有 `useAgents` 消费方、设置页折叠无死循环——均 CLEAN。

**修复的缺陷**：
- **F1（MED）**：`refreshAgents` 先 `setAvailable(true)` 后 `listAgents()`，若后者瞬时抛错 → catch 里 `setAgents([OPENCODE])` 会造成「available=true 但 roster 被清空」，而旧稳态分支只 merge 不新增 → 永不自愈（部分复活原症状）。**已修**：① `refreshAgents` 改为**先填 roster 再置 available**，catch 仅在 `!availableRef.current` 时才清空；② 稳态分支从「status-only merge」改为**全量 reconcile**（增删/状态皆反映，无变化则返回 prev 不触发 re-render）。此修复同时消解 reviewer B 指出的「手动 vs 循环 UP 判定不一致」（现二者都要 health+listAgents 双通过）。
- **F2（LOW，既存）**：稳态永不新增服务端新出现的 agent——被 F1 的全量 reconcile 一并修掉。
- **F3（LOW）**：`setTimeout` 重排未在 `finally`，异常可永久停摆自愈循环。**已修**：tick 包 `try/finally`，重排移入 finally（`!cancelled` 守卫）。

**接受不改（已评估）**：
- **F4（LOW）**：`connector` 变更时 refs 不重置——`connector` 为 app 生命周期稳定对象，实际不触发；若真变更 ~2s 内收敛。
- **F5（LOW，benign）**：tick 与手动 refreshAgents 对 `failuresRef` 的竞争至多一次错拍轮询，任一成功即清零自愈。
- **degraded sidecar（health 通但 listAgents 恒挂）**：现显示「不可用」+ 禁用新增（旧设置页显空列表+可新增）——边缘场景，新行为更正确且现已一致。
- **无 ACP 用户的 30s 恒定探测**：ACP sidecar 每次必起，「无 ACP」仅 spawn 失败，属自愈设计的既定取舍，无 re-render。

## 八、是否需要 ADR？

**倾向不单开 ADR**：本方案是把仓内**既有**"自愈轮询 + 几何退避"范式（`nextChannelPollDelay`，源自 IM 徽标冷启动修复）套用到 ACP 可用性上，非新架构决策。以本 discussions 文档 + CHANGELOG 记录即可。若实现中出现新的跨模块契约再补 ADR。
