# ADR-048: 产物预览与右侧栏互斥（half/full 双态）+ 产物/规划分级通知

**状态**: Accepted（✅ 已实现 · 两引擎 e2e 13/13 · **真机人工验收全通过**；三轮对抗审查共修 13 项，其中 4 项 high）
**日期**: 2026-07-11
**关联**: [discussions/031](../discussions/031-right-sidebar-awareness-and-preview-layout.md)（完整调研与决策记录）· **部分取代 [ADR-009](./009-artifact-preview-split.md)**（50/50 分屏的布局假设）· ADR-033（产物捕获）· ADR-038（任务规划面板）· ADR-047（贴底滚动，本 ADR 有回归风险）

## 背景

Session 页有两个用户实际撞到的问题：

**① 产物/规划到达时用户全程无感。** 三层遮挡叠加，任何一层单独都足以致盲：
- 右侧栏默认关闭（`sidebar-context.tsx:30`），且 `setRightOpen` 虽已导出，**全仓无任何调用者** —— 不存在能程序化打开右侧栏的代码路径；
- 即使右侧栏开着，「产物」section 默认收起（`Session.tsx:344`）；
- 产物的 fs 扫描只在 agent 空闲时跑（`artifacts-panel.tsx:343`），还要再晚一拍。

零徽标、零 toast、零自动展开。

**② 预览、右侧栏、chat 三者并排时宽度账算不平。** 它们是同一 flex 行的兄弟：预览 `w-1/2 shrink-0`（`Session.tsx:323`）、右侧栏 `w-72 shrink-0`（`:330`）、chat 打开预览时被显式改成 `w-1/2` 且带 `min-w-0`（`:175`）。三者相加 = **100% + 288px**，而**只有 chat 可收缩**，故溢出全由它独吞 → chat 实际宽度 ≈ 50% − 288px。1440px 窗口下 chat 仅剩约 300px，`max-w-[860px]` 正文列直接崩塌。

ADR-009 当年的布局假设写的是「预览(w-1/2) | Chat(w-1/2) | Sidebar(w-80)」——**当时就没算平这笔账**，且实现已漂移（预览从左移到右、sidebar 从 `w-80` 变 `w-72`）。

## 决策

### D1 — 分级通知，而非无脑自动展开

| 事件 | 行为 |
|------|------|
| 规划首次出现（`plan.updated` 且 steps 0 → >0，**每会话仅一次**） | 自动展开右侧栏 + 展开 Plan section |
| 产物出现 | **只打徽标**（TopBar `PanelRight` 按钮未读计数 + Artifacts section header 计数），不碰右侧栏 |

- **粘性意图**：用户手动关闭过右侧栏 → 本会话内不再自动展开（`autoRevealSuppressed`），切会话重置。
- **kill switch**：设置页开关。徽标本身不提供关闭（零打扰）。
- Artifacts section 用 **`autoOpen`（而非只有 `defaultOpen`）**：`useState(defaultOpen)` 只在挂载时读一次，而**规划几乎总是先于第一个文件到达** —— 规划自动展开侧栏的那一刻产物还是 0，section 会以收起状态挂上并**再也不会自己打开**，等于在本 ADR 新引入的路径上复现了背景 ① 那个盲区。`autoOpen` 在「产物从无到有」时展开它；用户手动折叠后不再自动展开。（第二轮审查发现。）

依据：NN/g 的 passive（徽标）vs action-required（打断）分档；ChatGPT Canvas 的「>10 行才自动开」阈值原则；VS Code Agents Window 明文的「手动操作压过自动行为」（同源教训见 `explorer.autoReveal` 系列 issue：默认开、可关、关掉后手动入口仍在）。

### D2 — 布局状态机：预览与右侧栏互斥 + half/full 双态

`SidebarContext` 新增 `previewMode: "closed" | "half" | "full"`。

| mode | chat | preview | 右侧栏 |
|------|------|---------|--------|
| `closed` | `flex-1` | — | 用户自定 |
| `half` | `w-1/2` | `w-1/2` | **强制收起** |
| `full` | 转录区隐藏、**输入框保留** | `flex-1` | **强制收起** |

- 打开预览 → 快照 `rightOpen` → 强制收起；关闭预览 → 按快照恢复。
- **边界（互斥是双向的）**：用户在预览打开期间**手动开右侧栏**，则**预览让位关闭**，快照一并作废。它们不能并存，所以这里不存在「两者同时在场」的第三种状态；快照必须作废，否则稍后关预览会把用户刚亲手打开的侧栏又关掉。单测里有这条反例。
- 三者永不并排 → 背景 ② 的溢出账**从结构上消失**，不是靠调数值糊过去。
- **窄窗口降级**：主区可用宽度 < 1100px 时，打开预览直接进 `full`（不给两边都不可用的 half）。只在**打开那一刻**求值——之后的窗口 resize 不会把布局从用户手里抽走。
- **规划自动展开会给预览让路**：若 plan 到达时预览正开着，不抢焦点，也**不消耗**「每会话一次」的额度——推迟到预览关闭后再展开。
- `Escape` 分级回退：`full` → `half` → 关闭（而不是从全屏一步跳出）。
- `selectedArtifact` 仍是 `Session.tsx` 的局部数据 state，但开关必须经 context action；`previewMode` 是「预览是否在场」的唯一真相，任何把它归零的路径都会连带清空选中项。

### D3 — 预览面板内置产物导航

互斥的固有代价：产物列表长在右侧栏里，点开一个产物侧栏就没了。**Claude / Canvas 的「预览取代侧栏」不能直接照搬——它们侧栏里压根没有产物列表**（artifact 从聊天流点开）。

补法：预览 header 加「上一个 / 下一个」+ 位置指示（`3 / 7`）。数据源是提升到 Session 级的 `useSessionArtifacts`。文件树点开的文件不在产物列表里 → 导航控件降级隐藏。

### D4 — `full` 态：无输入框，但行动项全部保留

（**2026-07-11 真机反馈后修订**：原方案是「转录区隐藏、输入框下沉到底部」，用户实测后认为全屏产物下方的输入框是杂音。现改为**不渲染输入框**，全屏底部只有一条细横幅。）

转录区隐藏，输入框一并去掉——它所属的对话都不在了。**但所有 action-required 的东西必须留下**：权限请求、提问、以及**委派子 agent 的权限**。它们是 agent 正卡着等你的，藏起来不是变清爽，是让一个回合无声地卡到超时。它们无内容时不渲染，所以常态下全屏底部就是一条细线。**停止按钮**原本长在 ChatInput 里，一并提到横幅那一行——否则全屏下跑起来就停不掉。配套：转录区不可见时 agent 回复用户看不到 → 输入框上方给一行轻提示（「已回复 · 查看」，点击退回 half）。**该提示按 assistant 消息数计基线**，不是全部消息数：`sendMessage` 会同步 append 一条临时 user 消息，用总数当基线的话，用户从这条底部输入框发出消息的瞬间横幅就会翻成「agent 已回复」—— 而这正是 `full` 存在的意义所在的那个动作。（第二轮审查发现。）

**行动项都要跟着 composer 走**：`PermissionDock`/`QuestionDock` 之外，**`DelegateDock` 也必须一起搬到底部栏**。它中继的是**委派子 agent 的权限请求**，被卡住的子 agent 和被卡住的父 agent 一样卡；把它留在（隐藏且 inert 的）chat 列里，会让委派任务一直阻塞到 sidecar 超时，用户既看不见原因也点不到按钮。（第二轮审查发现——第一版恰恰漏了它，而底部栏的注释还写着「permission requests must still be reachable」。）

### D5 — 产物派生提升到 Session 级

徽标计数需要在右侧栏关着时也能拿到产物数量，而现在产物派生全在 `ArtifactsPanel` 内部（`artifacts-panel.tsx:318-366`），侧栏没开组件根本没挂载。抽成 `useSessionArtifacts` hook 在 Session 级常驻，`ArtifactsPanel` 退化为纯渲染。它同时是 D3 导航的数据源。hook 另外暴露 `settled`（工作区扫描已跑完或确定无可跑）——未读徽标的 seed 必须等它，否则会把扫描晚到的产物当成新产物。

**未读判定用「产物路径集合」，不是计数**（`lib/use-artifact-unread.ts`），且 **seen 按 session id 记忆、跨会话切换存活**。第二轮审查证明计数版有两个必然出错的方向：① 每次挂载归零 ⇒ 回到已读过的会话会重新宣布同样几个产物是「新的」；② 高水位计数 ⇒ agent 删除/重命名文件时列表变短，`length - seen` 变负，**真正的新产物被静默吞掉**。会话打开时既有的产物 seed 为已读（是历史不是新闻）。

## 考虑过的替代方案

1. **全部只给徽标，绝不自动展开** — 最保守、零打扰，但用户仍需主动点才知道有规划。规划是「这一整个回合要干什么」的导航，每会话只出现一次，自动展开的收益 > 打扰成本。
2. **规划和产物都自动展开** — 产物常在回合末尾成批到达，会反复抢视线。业界无人这么做。
3. **只互斥、不做 full 态** — 修好了溢出，但用户细看长文档/PDF 时仍只有半屏，无扩宽手段。
4. **侧栏收成窄 rail（保留图标入口）** — 引入第三种侧栏形态 + 弹出层，复杂度最高，且 rail 仍占宽度。
5. **可拖拽 resizer + 宽度持久化** — 独立工作量（拖拽状态机、min/max 约束、持久化），half/full 两档已覆盖实际痛点。**刻意不做。**
6. **预览停靠位置可配**（Zed 的 dock left/right/bottom）— 我们没有 editor 区，主区就是 chat，无意义。

## 后果

**正面**：
- 溢出账从结构上消失（三者永不并排），不再有「chat 被压到 300px」。
- 产物/规划从「完全不知道」变成「规划自动露面一次 + 产物有徽标」。
- 布局状态从散落的硬编码 Tailwind 常量收敛为单一状态机，后续加 resizer / 新面板有落点。
- `full` 态支撑「全屏看产物 + 继续对话」。

**负面 / 代价**：
- **fs 扫描频率上升（已实测，可接受）**：D5 使扫描从「侧栏开着时每回合一次」变成「**永远每回合一次**」。**实测**：本 monorepo（含 `node_modules`，命中 500 上限）单次 `collect_changed_files` = **91ms**，异步 invoke 不阻塞渲染 → 结论是可接受，**不加惰性门控**。Rust 侧上限保护仍在（深度 ≤8、访问上限 5 万项，`src-tauri/src/lib.rs:1540-1552`）。
- **`full` 如何隐藏 chat 列是三重约束下的唯一解**（第二轮审查后重做）：① 不能 `display:none`/卸载 —— ADR-047 依赖 `contentRef` 的 ResizeObserver 持续触发，否则贴底停止自我纠正；② 不能收成零宽 —— 0px 内容盒会让每条消息按 min-content 重排（约每词一行），进出各一次，长会话上是一大笔同步布局；③ 必须移出 tab 序列与无障碍树 —— 里面还有侧栏开关、转录区的产物链接，而 **`inert` 扛不住这条：它要 Safari 15.5+（macOS 12.4+），而我们 `minimumSystemVersion` 是 10.15**，旧 WKWebView 会静默忽略它。最终解 = **脱流 + `visibility:hidden`，宽度保持与 `half` 相同**：三条全满足（远古浏览器就支持的 tab/AT 移除、宽度不变故零重排、布局盒仍在故 RO 存活）；`inert` 作为现代引擎上的附加保险保留。**两引擎 e2e 实测**：往返后 Δbottom = **0px**、隐藏时宽度 589px→589px（零重排）、chat 列内可聚焦元素 **0** 个。
- 互斥意味着「预览开着时看不到活动/规划面板」——这是刻意取舍（列表 ≠ 详情），代价由 D3 的预览内导航部分抵消。
- 1100px 窄窗口阈值是拍脑袋的，待真机校准。
- 预览面板仍不可拖拽调宽（刻意，见替代方案 5）。
- **已知边界（对抗审查发现，评估后不修）**：`composer` 在 half⇄full 之间会被 **re-parent**（chat 列内 ↔ 底部全宽栏），React 视作不同位置 → `ChatInput` 卸载重挂，**输入焦点丢失、`isComposing`（IME 组字态）重置**。输入的文本本身不丢（受控于 Session 级 `input`）。触发条件是「正在用输入法组字的同时用鼠标点最大化按钮」——极窄；而修复需要 portal（保住 React state）+ 手动焦点恢复（DOM 节点被移动时浏览器必然 blur），复杂度不划算。若将来 full 态要支持键盘快捷键切换（焦点更可能停在输入框上），应重新评估。

## 验证

- **单测（18 项新增）**
  - `__tests__/components/layout/preview-layout.test.tsx`（6）：互斥、快照恢复、「关着的侧栏不会被预览凭空唤醒」、**「预览期间手动开侧栏 → 预览让位且快照作废」这条反例**、窄窗口降级、`openPreview` 对已最大化的预览是 no-op。
  - `__tests__/lib/use-artifact-unread.test.ts`（7）：seed（历史不是新闻）、`settled` 之前不 seed、markSeen 清零、**跨会话切换记忆 seen（不 cry wolf）**、**列表变短不吞掉新产物**。后两条直接对应第二轮审查抓到的两个必然错误。
  - `__tests__/components/session/right-sidebar-section.test.tsx`（5）：**`autoOpen` 在挂载后翻真时仍能展开**（plan 先于产物那条路径）、手动折叠后不再自动展开、徽标仅在收起时显示、展开即算已读、计数在已展开时变动也算已读。
  - **A/B 反证 ×2**：移除 `openPreview` 里的 `setRightOpen(false)`（互斥本身）→ 对应测试转红；移除 `RightSidebarSection` 的 autoOpen effect → 对应两条转红。守卫不是同义反复。
- **e2e**（`e2e/preview-layout.e2e.ts`，真模型一轮同时产出「一个产物 + 一屏放不下的长回复」，**chromium + webkit 两引擎 12/12 全绿**）：
  - A 基线贴底 · B 产物默认可见（徽标未读=1）· **C 预览打开时右侧栏消失** · **D chat 列恰占主区 50.0%**（旧实现 ≈30%，即 `50% − 288px`）· **E1 全屏态转录区 `visibility:hidden`** · **E2 隐藏时宽度 589px→589px（零重排）** · E3 全屏态输入框仍可用 · **E4 chat 列内可聚焦元素 = 0（已移出 tab 序列）** · **H1 用户自己发消息不被当成「agent 已回复」** · **H2 agent 真回复后横幅确实亮起**（双向断言，H1 无法靠「永不提示」蒙混）· **F 全屏往返后 Δbottom = 0px**（R1）· G 关预览后侧栏恢复。
  - 踩到的 e2e 陷阱（**非产品缺陷**，已在脚本里注明）：① 工作区不能建在系统 tmpdir——macOS 的 `/var/folders/…` 被 `TEMP_PATH_RE` 当临时路径过滤，产物永远进不了列表；② 产物行的选择器必须限定在 `[data-testid="artifacts-panel"]` 内——「执行活动」面板排在其上、同样默认展开、且列出同一个文件的绝对路径，无限定的文本匹配会点到那一行惰性文本上。
- **回归**：typecheck 8/8 · desktop vitest **441**（基线 423 + 新增 18）· Rust 122 · check-docs 无漂移。

## 审查记录（两轮）

**第一轮（8 角度，5 项）**：`repliedWhileHidden` 首帧误报（ref 不触发重渲染 ⇒ 谎言常驻）· `aria-hidden` 容器内含可聚焦元素 · 徽标样式两处复制 → 抽 `UnreadBadge` · 外层容器缩进断裂 · composer re-parent（见「已知边界」，不修）。

**第二轮（深度对抗审查，5 项，全部是第一轮漏掉的真缺陷）**：

1. **`DelegateDock` 在 `full` 态被 `inert` 掉**（high）—— 委派子 agent 的权限请求不可见也不可点，子任务阻塞至超时。**第一版只把自己会话的 permission/question 提到了底部栏，漏了委派中继**，而底部栏注释还宣称「permission requests must still be reachable」。→ DelegateDock 并入 composer。
2. **`repliedWhileHidden` 仍然误报**（high）—— 第一轮只修了首帧。`sendMessage` 同步 append 临时 user 消息，所以**用户自己发消息就会立刻翻成「agent 已回复」**，而这正是 `full` 的主场景。→ 改按 assistant 消息计数。e2e H1/H2 双向守。
3. **plan 自动展开反而制造新盲区**（medium-high）—— plan 先到，侧栏展开时产物为 0，`defaultOpen` 只在挂载时求值 ⇒ 产物区收起且永不自开。→ `autoOpen`。
4. **徽标切会话后谎报未读**（medium）—— `seenCount` 每次挂载归零。→ per-session 记忆。
5. **未读用计数高水位**（medium）—— 列表变短时静默吞掉新产物。→ 按路径集合判定。

第二轮同时**明确排除**了这些角度（已逐一核过，勿重复排查）：状态机竞态与 StrictMode 双调用、Settings 路由对 `leftOpen` 估算的影响、会话切换时 plan/messages 的陈旧读、`useSessionArtifacts` 的 in-flight 跨会话写入、`previewNav` 在流式重排下的越界、`full` 态停止 agent 的可达性（`ChatInput` 自带 stop 按钮）、`config.planAutoReveal` 的存量迁移。


## 三轮对抗审查（共修 13 项，4 项 high）

**第一轮（8 角度，5 项）**：`repliedWhileHidden` 首帧误报（ref 不触发重渲染 ⇒ 谎言常驻）· `aria-hidden` 容器内含可聚焦元素 · 徽标样式两处复制 · 缩进断裂 · composer re-parent（当时记为「已知边界」，后被 D4 修订消解）。

**第二轮（深度，5 项，全是第一轮漏的）**：
1. **`DelegateDock` 在 `full` 态被 inert 掉**（high）—— 委派子权限不可见也不可点。
2. **`repliedWhileHidden` 仍误报**（high）—— `sendMessage` 同步 append 临时 user 消息，**用户自己发消息就翻成「agent 已回复」**，而这正是全屏的主场景。改按 assistant 计数。
3. **plan 自动展开反而制造新盲区**（medium-high）—— plan 先到，侧栏展开时产物为 0，`defaultOpen` 只在挂载时求值 ⇒ 产物区收起且永不自开。→ `autoOpen`。
4. 徽标切会话后谎报未读 · 5. 未读用计数高水位 ⇒ 列表变短时静默吞掉新产物。→ 改按路径集合 + 按会话记忆。

**第三轮（深度，4 项，全是第二轮漏的；且第 1 条是第二轮的修复从另一扇门回来）**：
1. **`DelegateDock` 在 half⇄full 切换时被卸载重挂**（high）—— 第二轮把它放进 composer 以保证全屏可见，但 composer 在两个位置之间是**条件渲染**，切换 = 卸载重建。而 **delegate SSE 只重放 delegates、从不重放待答权限**（gotchas §9）⇒ 已经在等的那条权限行**永久消失**，子 agent 阻塞至超时。→ 订阅提升为 Session 级 `useDelegateRows`（conventions §15）。
2. **新会话第一轮产物徽标恒为 0**（high）—— seed 要等 fs 扫描 settle，而扫描只在空闲时跑 ⇒ 整个第一轮不 settle ⇒ 等它 settle 时刚产出的文件已被一并 seed 成「已看过」。**旗舰场景从头到尾不亮徽标。**
3. **打开老会话亮出幻觉徽标**（medium-high）—— seed 读到同一 commit 里即将被重置的旧 `settled`。→ `settled` 改**渲染期派生**（conventions §16）。
4. QuestionDock 答题进度同样因 re-parent 丢失 → 由 D4 修订（全屏不再 re-parent 它）消解。

**审查明确排除、无需再查的角度**：状态机竞态与 StrictMode 双调用 · Settings 路由对 `leftOpen` 估算的影响 · 会话切换时 plan/messages 的陈旧读 · `useSessionArtifacts` 的 in-flight 跨会话写入 · `previewNav` 在流式重排下的越界 · 新旧两个 ResizeObserver 互相打架 / 无限循环 / 重现 ADR-047 的「流式期间拖不走」· `w-1/2` 的 containing block · 停止按钮判定不一致 · `config.planAutoReveal` 的存量迁移。

## 滚动：本 ADR 顺带挖出并修复的 ADR-047 遗留缺陷

`use-stick-to-bottom` **只观察内容层，不观察滚动容器**。所以「容器变矮」（输入框回来、权限 dock 弹出、委派 dock 冒出）它一无所知——内容没变高，只是视口短了，视图被永久晾在离底 N px 处。**实测 100px，永不收敛。**

这个洞一直存在，只是被偶然掩盖：全屏早期版本把 chat 列收成 `w-0`，退出时宽度 0→N 的剧变**顺带**触发了内容层 RO 把位置修回来。为消除重排改成宽度恒定后，救场消失，洞才暴露。

两处修复（gotchas §15）：
1. `use-session-scroll.ts` 补挂一个**观察滚动容器**的 RO——容器变矮且此前贴底时立即回底。
2. 不依赖「隐藏期间持续贴底」（WebKit 实测漂移 122px，Chromium 因原生 scroll anchoring 而不同）——改为**进入全屏前若贴底、退出时就贴底**（进入那刻快照）。

## 真机验收（2026-07-11，用户执行，全部通过）

自动化够不着、只能真机验的三类，全部通过：

1. **委派 + 全屏往返**：Team 会话 → 子 agent 请求 bash 权限 → 全屏往返 → **权限行仍在、仍可点**。（造这个场景需要真委派 + 真子权限，e2e 做不到。）
   - ⚠️ 踩坑：`permission` 不配置 = 全部放行，**权限请求根本不会产生** —— 必须显式配 `"permission": {"bash": "ask"}` 并重启 sidecar（gotchas §1）。
2. **新会话第一轮徽标**：从 Home 页直接发（**不是先建会话再发**——e2e 走的正是后者，因此绕开了 bug）→ 产出后徽标亮起。
3. **fs 扫描产物链路**：bash 副作用产出的 `data.csv` / `report.pdf`（无任何 write 工具触碰）出现在产物列表，`gen.py` 折叠在「工作文件」组；PDF 预览与全屏重绘正常；窄窗口阈值行为合理。
   - 这条是**本轮改动的直接风险区**（扫描链路被改了三处），而 e2e 把 `scan_workspace_changes` 整个 mock 掉了 —— **零自动化覆盖**。
