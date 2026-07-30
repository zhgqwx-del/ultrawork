# ADR-072：断流后正文补拉 —— idle 时就地合并服务端快照，而非重新 seed

- 状态：已接受（2026-07-30）
- 日期：2026-07-30
- 相关：ADR-071（连接韧性，本条是其 §遗留 F1b 的销账）· discussions/058（量化）· discussions/022（切换回来的正文缺口）· gotchas §20 · conventions §24

## 背景

ADR-071 把断流后的**状态**恢复做完了（转圈、输入框、侧栏 busy 标记），但**消息正文**没有：`/event` 无重放，断流窗口里流过的文本永久丢失。当时把它列为遗留，理由是「要动 `use-session-messages` 的分页合并，那里有明确注释警告重新 seed 会打乱分页顺序并复活已 revert 的轮次」。

**没人量化过缺口有多大** —— 而 ADR-070 P1 的教训正是「前三版都在防御一个从未验证过的副作用，实测误伤 0」。所以先测再决定为它付多少复杂度（discussions/058）：

| 断流时长 | 回合结束时界面 | 服务端 | 缺失 |
|---:|---:|---:|---:|
| 8s | **300** | 300 | **0** |
| 20s | **300** | 300 | **0** |
| 45s | **7** | 300 | **293（97.7%）** |

**严重程度不取决于断流时长，而取决于是否跨越回合结束**：落在回合内会自愈（后续事件带全量 part 正文补齐）；跨越回合结束则**永不自愈**，因为再没有任何事件会到来。**sidecar 崩溃必然属于后者**（回合随进程一起死），而那正是 ADR-071 写来对付的那条故障链。用户也无从察觉：断连横幅正确弹出，然后一切看起来正常。

## 决策

### D1：修复点在「重连 + 会话 idle」，而不是分页合并

量化把危险区排除掉了。`use-session-messages` 初始加载的合并里写着：

> *Only consult the cache while the turn is in flight (busy). **Idle sessions trust the snapshot fully, so a revert can't be undone and paginated history can't be reordered.***

而本缺口的成立条件**恰好就是回合已结束 ⇒ 会话 idle**。所以那条危险的分页合并**不必碰**：

> `reconnectEpoch` 变化、且该会话已 idle 时，重取一次服务端快照并合并。

回合内断流本来就自愈，**不需要也不应该动** —— 于是「turn 在飞时重新 seed」这个真正危险的场景根本不在射程内。

### D2：合并是「就地」的，不是重新 seed（`mergeSnapshotInPlace`）

直接复用初始加载那条路径会 `setMessages([])` 并重置 `turnStart`/`cursor`/`hasMore` —— 用户已加载的更早历史消失、视口跳动。所以新写一条只合并不重置的路径，四条规则各自对应一个已知的失败模式：

- **已在屏幕上的消息保持位置**，只把 part 升级到正文更长的一版，并刷新 `info`（`finish`/`tokens`/`completed` 正是跨越回合结束时被吞掉的字段）；
- **快照里有而本地没有的消息**，插到「最近一条本地也有的快照消息」之后，保持服务端顺序（实践中都落在尾部 —— 它们就是断流期间诞生的）；
- **比屏幕上最早一条还老的快照消息直接丢弃**，不做前插 —— 它们属于用户没请求过的分页，前插会打乱分页窗口（F2）；
- **任何消息都不删除** —— 删除才是「复活/抹掉已 revert 轮次」的方向。

另外**无变化时按引用返回原数组**：`assistant-turn.tsx` 的 memo 明确依赖「消息对象身份不变则不重渲染」，一次空转 resync 若返回新数组会让整条转录重渲、并可能引起视口跳动。

### D3：三道闸门，每道都对应一个具体的错误后果

| 闸门 | 拦住什么 |
|---|---|
| `resyncedEpochRef >= reconnectEpoch` | 同一次重连里 `activeSessionIds` 抖动导致的重复取历史 |
| `activeSessionIds.has(sid) \|\| sendingRef.current` | 回合仍在飞时补拉（那一档本来就自愈，且是注释警告的危险区） |
| `stoppedRef.current` | 用户按了停止 —— 无 revert 的后端（ACP）服务端仍存着 agent 的完整答案，拉回来等于把「停止」当场撤销 |

**epoch 只在真正跑了一次 resync 之后才算消费**。这不是保守写法而是承重的：F1b 的真实时序是「重连那一刻 app 还以为会话在忙 ⇒ 闸门二拦下 ⇒ `use-sessions` 的 busy 对账落地、把它清掉 ⇒ 依赖变化重跑 ⇒ 这时才补拉」。若在拦下时就消费 epoch，修复对本缺口**永远不会触发**。

取历史失败时把 epoch 退回去，让下一次依赖变化重试；**不给用户任何提示** —— 他手上的列表还是他刚才那份，没有新信息可给。

### D4：两处加固（第二轮对抗性复读发现，2026-07-30）

**① 锚点消息在列表里出现两次时，快照独有的消息会被插入两次。**
`prev` 并不保证 id 唯一：`loadOlderMessages` 是 `[...result.messages, ...prev]` 直接前插、**不去重**，分页边界重叠就会留下同 id 两份。合并时按锚点 id 取 followers，遇到重复锚点就会重复插入。已改为**取出即消费**（`followers.delete`）。

**② 初始加载失败时，补拉必须顺带把分页窗口建起来。**
断流期间打开一个会话 ⇒ 初始加载抛错 ⇒ `setMessages([])`、无 cursor、无 turn 窗口。此时的补拉**就是那次加载本身**，不是打在加载结果上的补丁。原实现只合并正文，结果是「会话恢复了内容、却永久失去『加载更早』」。现由 `initialLoadFailedRef` 精确区分这一条路径（**不用 `messages.length === 0` 判断** —— 那会在正常路径上误命中并变成一次真正的 re-seed）。

## 遗留

- **ACP 自己的流断开不触发补拉。** `reconnectEpoch` 只由 opencode 全局流驱动（`sse-context.tsx` 的 `opencode.onTransportStatusChange`）；ACP 的 per-session 流在 `gave-up` 时只发一条 `session.error` 提示，没有任何东西告诉 renderer「流回来了」。⇒ **ACP 会话（Claude/Gemini CLI agent、Team 的 ACP 成员）在自己的流断开且跨越回合结束时，仍会留下同样的正文缺口**，规避手段同样是切走再切回。sidecar 侧历史是完整的（`session-store.applyEvent` 同步折叠），缺的只是 renderer 的重取信号 —— 修法是给 ACP 的 per-session transport 也surface 一个恢复信号并并入 epoch，属于独立一轮。

## 否决的做法

- **重新跑初始加载的 effect（把 `sessionId` 换成 `[sessionId, reconnectEpoch]`）** —— 最省事，但会清空列表、重置分页窗口，正是 ADR-071 判定「值得单独一轮设计」的那个风险。
- **动分页合并、让它在 busy 时也重新 seed** —— 量化证明这一档根本不需要修（缺失 0），为零收益去碰三条警告注释所守的代码。
- **靠切走再切回**（现状） —— 能补齐，但没有用户会想到去做，而且横幅消失后界面看起来完全正常。

## 影响

- 纯 renderer，一个文件（`use-session-messages.ts`），无 Rust / 无 vendor patch / 无 API 变更。
- ACP 会话一并受益（`fetchHistory` 按 binding 分派），且对它是无害的：ACP 历史本就同步折叠，合并是空转并按引用返回原数组。

## 验证

- **✅ 真机验收通过（2026-07-30，macOS 真 Tauri 壳 / WKWebView）**：可切断代理插在 Vite 与 opencode 之间（用 `vite.config.ts` 现成的 `E2E_OPENCODE_PORT` 开关改转发目标，app 一行未改）。实测：回合中断流 → 正文停住 → 服务端跑完 300 marker → 恢复 → **界面几秒内自动补齐到 M0300，无需切走再切回**。
  - **「一下子补齐」是设计如此**：补拉是「取快照合并」而非「把断掉那段重放一遍」，必然一次性出现。要做成逐字回放等于为动画伪造一段并不存在的实时性。用户判定视觉上「还好」。
  - **视口是否被拽走：本轮未能观察**（答案没超过一屏、没有滚动）。滚动位置由 `useStickToBottom` 管，只在本来就贴底时跟随；e2e case C 已机器验证「用户展开的更早历史在补拉后仍在」。
  - **断流期间打开会话 → 空白 + 「加载消息失败」→ 恢复后自愈**（用户实测），与 D4② 的 `initialLoadFailedRef` 路径一致；**但不构成干净归因** —— 会话重新挂载从外部看结果相同。
  - **注意**：本 rig 的断流是「拒绝新连接」，renderer 判为「后台服务已退出」（gotchas §20⑭：连不上与进程死了长得一样）。真实断网是超时 ⇒ 判 unknown ⇒ 普通断连横幅。措辞差异是 rig 的产物，不是缺陷。

- **单测 17 例**（`use-session-messages-reconnect-resync.test.ts`）：合并语义 9 例（含分页不前插、不删除、按引用返回）+ 闸门 8 例。
- **真 GUI e2e**（`e2e/stream-gap-resync.e2e.ts`，可切断 TCP 代理插在 Vite 与 opencode 之间）：A/B/C 三档同跑，**Chromium + WebKit 双引擎均全绿**（Chromium = Windows 的 WebView2；**WebKit = macOS 的 WKWebView 与 Linux 的 WebKitGTK**，即用户实际安装的壳所用引擎）。
  双引擎在本轮不是走过场：**只跑 Chromium 会一直以为 case C 那段 harness 是稳的** —— WebKit 一跑就暴露它必挂（Playwright 点「加载更早」前的 scroll-into-view 落在转录顶部，触发 app 自己的 `onScrollNearTop → backfillTurns`，重渲染把按钮摘掉、点击永远落不下去，而它触发的回填恰恰就是想要的效果）。改为**断言结果而非断言手势**后两个引擎都稳，判据见 testing.md §11。
- **非空转门是硬要求**：断流期间界面若没停止增长，判 **FAIL 而非 PASS**。Playwright 的 `setOffline` 不切 loopback（discussions/058 实测 `ui 7→66`），没有这道门会得出一份关于「网络从没断过」的报告。
- **负向控制一（关掉 resync）**：单测 21 例挂 5 例、e2e **B 档 19/300 挂〔缺 281〕而 A 档 300/300 仍过** —— 后半句才是关键，它把「修复起作用」和「这一档本来就会自愈」分开了。
- **负向控制二（把合并换成「复用初始加载」的 re-seed）**：**A 300/300 过、B 300/300 过、C 挂（最老一轮丢失）**。这一行是 D2 的全部理由 —— **re-seed 在 A/B 两档表现完美无瑕**，只有 C 能看见它把用户拉出来的历史抹掉了。
- **⚠️ 半吊子的反证会发假通行证**：负向控制二的第一版只把合并换成 `setMessages(snapshot)`，**C 照样绿** —— 21 轮装得进一页 80，不丢消息，而 `turnStart` 没被碰。必须**忠实复刻那个更省事的错误写法**（连 `turnStart`/`cursor`/`hasMore` 一起重置）才打得红。判据与残余边界见 testing.md §11。
