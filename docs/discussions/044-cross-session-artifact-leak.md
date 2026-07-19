# 044 — 跨会话产物泄漏（共享工作区 + mtime 时间窗归属，并发写误判）

> 状态：**🟡 草稿 / 待评估（先记档，不改代码）** · 2026-07-19
> 根因层级：**已代码 + 真实 mtime 双重确证**（确定性逻辑局限，非概率抖动）。
> 触发面：两个会话**共用同一 workspace** 且**写文件的时间相互重叠**时，B 会话写的文件被误算作 A 会话的产物。
> 影响范围：仅「产物 / 本轮产物」的**归属展示**（不影响文件本身、不影响「工作区」原始文件浏览器、不造成数据损坏）。
> 关联：ADR-048（产物预览/归属）· ADR-051（IM 会话 idle 轮转 + 侧栏发现性）· 归属实现 `lib/use-session-artifacts.ts` + `lib/turn-artifacts.ts` + `src-tauri/src/lib.rs` `scan_workspace_changes`。
> **与本次 HTML 预览 / deckcraft 居中改动无关**（git 确认这些归属文件本轮未被触碰）。

---

## 一、缘起（现象）

会话「用deckcraft重新生成codex.html」（今天 09:48 收尾）的右栏「产物」与转录「本轮产物」中，出现了 **`luxun.html`** —— 而它是**另一个会话「鲁迅介绍HTML页面」**的产物，本会话从未生成它。

同时右栏「工作区 `workspace1`」列出了 `luxun.html` / `lu_xun.html` / `shenzhen.html` / `tank-battle.html` / `opencode.*` / `remote-collab.*` 等一大批文件。

**先分清两个区域（重要）**：
- 「**工作区**」= 共享工作目录的**原始文件浏览器**，所有会话共用同一个 `workspace1/`，列出目录里全部文件是**设计如此、非缺陷**。
- 「**产物 / 本轮产物**」= 本应**按会话隔离**的派生视图。`luxun.html` 泄漏进这里，才是本 bug。

---

## 二、根因（逐环佐证，已确证）

### 2.1 隔离机制的两步

`lib/use-session-artifacts.ts`：

1. **baseline** = 本会话最早消息时间（`messages` 里最小 `time.created`）。
2. **扫描**：`invoke("scan_workspace_changes", { dir: directory, sinceMs: baseline })` —— Rust 侧 `walk` **整个 workspace 目录**，收集所有 `mtime_ms >= since_ms` 的文件（`src-tauri/src/lib.rs` 的 `scan_workspace_changes`）。
3. **按会话过滤**：`filterScanByWindows(hits, windows)` —— 只保留 mtime 落在**本会话某个 turn 时间窗**内的文件（`sessionTurnWindows`）。注释原文：「sessions sharing a workspace don't show each other's outputs (mtime baseline alone can't tell them apart)」。
4. **归属到轮**：`turn-artifacts.ts` 的 `turnIndexForMtime` 把每个扫描命中按 mtime 落进哪个 turn 窗，挂到该轮的「本轮产物」。

### 2.2 死穴

隔离**完全依赖「mtime 是否落在本会话 turn 窗内」**。而 turn 窗是**真实墙钟时间区间**（一个 turn 从首条消息 `created` 到末条 `completed` + grace）。因此：

> **只要另一个会话在本会话某个 turn 窗的时间区间内写了文件，该文件的 mtime 就落进本会话窗口 → 通过 `filterScanByWindows` → 被误算作本会话产物。**

mtime 只记录「文件何时被改」，**不记录「谁改的」**——原理上无法区分同一共享目录里另一会话的并发写入。turn-window 过滤是尽力而为的缓解，对**时间重叠的跨会话写**必然失效。

### 2.3 真实 mtime 佐证（为何只有 luxun.html 漏）

| 文件 | mtime (2026-07-19) | 落在 codex 会话窗（≈09:42–09:48）? | 结果 |
|---|---|---|---|
| **luxun.html** | **09:42:00**（另一会话写）| ✅ 落窗内、≥ baseline | **泄漏** |
| codex.html / codex.pdf | 09:47:47（本会话写）| ✅ | 正确归属 |
| lu_xun.html | 06-06 | ❌ mtime < baseline | 正确过滤 |
| shenzhen.html / tank-battle.html | 06-06 | ❌ | 正确过滤 |
| opencode.html | 07-18 | ❌ | 正确过滤 |

老文件因 `mtime < baseline` 在扫描阶段就被排除——**这精确解释了为何同在工作区的一堆 html 里，唯独 09:42 写的 luxun.html 漏了**。

### 2.4 触发条件

两个会话**共用同一 workspace** + **写文件时间重叠**。本例：用户约 09:42 在「鲁迅」会话生成 luxun.html，而 codex 的 deckcraft 长流程（~6 分钟）正在跑 → 撞进 codex 的 turn 窗。单会话、或会话间无时间重叠时不触发。

---

## 三、影响评估

- **仅归属展示错**：产物卡/本轮产物多出一张别的会话的卡。点开它会预览那份 HTML（内容真实存在于共享工作区）。
- **不损坏数据**、不误删、不影响「工作区」文件浏览器、不影响文件本体。
- **误报方向**：只会把别的会话的文件**多算进来**（false positive），不会漏掉本会话自己的产物。
- 严重度：中低（观感/信任问题，非数据安全）。但对「产物 = 本会话交付物」的语义是实打实的破坏。

---

## 四、候选解法（均未实现，待评估权衡）

### A. 会话级 workspace 子目录隔离
每个会话在 workspace 下有独立子目录，扫描只扫本会话子目录。
- ✅ 根治：物理隔离，mtime 归属不再跨会话。
- ❌ 改动大：改变文件落地位置与 UX（用户/agent 现在把文件写在 workspace 根）；跨会话「共享同一批文件」的现有用法被打破；deckcraft 等技能的输出路径约定要跟着改。

### B. 仅归属本会话工具/进程碰过的文件
放弃「盲扫 workspace」，只认本会话 `write/edit` 工具 + 已知子进程写的文件。
- ✅ 无跨会话泄漏。
- ❌ **废掉扫描的初衷**：扫描正是为了抓**不走工具调用**的 bash/python 副作用产物（如 deckcraft 经 python 导出的 deck.html/pdf/pptx）。改成纯工具归属会让这类产物**从产物面消失**——比多显一张卡更糟。

### C. 写入时给文件打会话标记
产物写入时落一个 manifest（或 xattr）记录 `sessionId`，归属按标记而非 mtime。
- ✅ 较稳，保留盲扫能力。
- ❌ 侵入：需要在所有产物写入路径（含技能子进程）注入标记；xattr 跨平台语义不一（NTFS/APFS/ext4）；manifest 需维护一致性。

### D. 缓解（非根治）：并发写去重启发式
扫描命中若其 mtime 同时落在**多个并发活跃会话**的窗口，标记为「不确定归属」降级处理。
- ✅ 改动小。
- ❌ 治标：需要「其它会话此刻是否活跃」的全局视图（当前 hook 只见本会话）；仍会在「另一会话已结束但 mtime 落窗」时误判。

**倾向**：A 最干净但代价高；B 有明确反效果不可取；C 最平衡但侵入。需先定「workspace 到底是会话私有还是共享」这个产品语义（ADR-051 已指出发现性/隔离是纠缠问题），再选路。

---

## 五、未决 / 待拍板

1. **产品语义**：workspace 是「每会话私有」还是「多会话共享的一块地」？这决定走 A 还是 C。
2. 是否接受「盲扫产物」这个能力（决定 B 出局与否）。
3. 优先级：当前为 false-positive 观感问题，非数据风险——是否值得动核心归属逻辑，还是先以「已知限制」挂着。

> 本文仅记档 + 列方案，**不改代码**。落地前应升级为正式 ADR 并补测试（现有归属测试 `__tests__/lib/turn-artifacts.test.ts` / `use-artifact-unread.test.ts` 需扩「跨会话并发写」用例）。
