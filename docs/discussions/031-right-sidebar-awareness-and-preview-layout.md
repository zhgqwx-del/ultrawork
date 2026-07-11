# 031 — 右侧栏感知缺失 + 产物预览挤压主会话

> 状态：**📋 方案已定稿，待实施**（2026-07-11 拍板四项：① 规划自动展开 + 产物只徽标；② 预览与右侧栏互斥 + half/full 双态；③ 预览面板内置产物导航；④ full 态保留输入框。定稿前经一轮自查，补掉了「互斥切断产物导航链」与「full 态无法对话」两处方案自身的缺口）
> 日期：2026-07-11
> 输入：用户实际使用中的两个体感问题——① 主会话产生产物/规划时右侧栏不会自己展开，用户根本不知道有了；② 点产物打开的预览挤在右侧栏左边，把主会话压窄
> 关联：ADR-009（产物预览 50/50 分屏，本文将其部分推翻）· ADR-033（产物捕获 fs 真相 + PDF 预览）· ADR-038（任务规划面板）· ADR-047（会话贴底滚动，本文的 full 态实现有回归风险）· conventions §2（Provider 分层）
> 范围：Session 页的右侧栏（`<aside>`）、产物预览面板、两者与主会话列的宽度关系，以及产物/规划事件的用户感知链路。**不含**左侧栏、不含产物识别逻辑本身（ADR-033 已定）。

---

## 0. 一句话

用户的两个判断都成立，且**第二个问题的实质不是「挤压」而是「布局账算不平」**——预览、右侧栏、chat 三者并排时宽度总和溢出 288px，全部由 chat 独吞。解法=**把散落的硬编码宽度收进一个布局状态机**，让预览与右侧栏互斥（half/full 双态），并把产物/规划的到达做成**分级通知**（规划自动展开一次、产物只打徽标、手动关闭永久压过自动行为）。

---

## 1. 现状核验（源码级，非推测）

### 1.1 问题一：产物/规划到达时，用户零感知

三层遮挡叠加，任何一层单独都足以让用户看不见：

| # | 遮挡 | 证据 |
|---|------|------|
| 1 | 右侧栏**默认关闭**，且**没有任何代码能程序化打开它** | `components/layout/sidebar-context.tsx:30` `useState(false)`；`setRightOpen` 虽在 context type 里导出（`:10`），但**全仓无任何调用者**——唯一入口是 TopBar 的手动按钮（`pages/Session.tsx:178-189`） |
| 2 | 即使右侧栏开着，「产物」section **默认是收起的** | `pages/Session.tsx:344`，`RightSidebarSection` 无 `defaultOpen` → 默认 `false`（`Session.tsx:371`） |
| 3 | 产物的 fs 扫描**只在 agent 空闲时**跑，产物出现还要再晚一拍 | `components/session/artifacts-panel.tsx:341-355`，`if (active \|\| !directory \|\| !baseline) return` |

零徽标、零 toast、零自动展开：三轮 grep（`badge\|unread\|autoOpen\|notif\|hasNew\|animate-pulse`）在右侧栏相关文件里零命中。

**任务规划**同理：`lib/use-session-plan.ts:74-84` 订阅 `plan.updated` 后只 `setSteps`，UI 侧唯一副作用是 Plan section 首次挂载时 `defaultOpen`（`Session.tsx:333-337`）——**前提是右侧栏本来就开着**。

> 净效果：agent 写出一个 PDF、列出一个五步规划，用户如果没手动开右侧栏 + 手动展开对应 section，**全程无感**。唯一的被动可见路径是聊天流内的 `FileBlock`/`PatchBlock` 内联块。

### 1.2 问题二：三者并排 → 宽度溢出，全由 chat 承担

预览、右侧栏、chat 是同一 flex 行的三个兄弟（`pages/Session.tsx:173`）：

| 元素 | class | 来源 |
|------|-------|------|
| Chat 列 | 预览打开时被**显式改成** `w-1/2`，否则 `flex-1`；带 `min-w-0` | `Session.tsx:175` |
| 产物预览 | `w-1/2 shrink-0` | `Session.tsx:323` |
| 右侧栏 | `w-72 shrink-0`（288px） | `Session.tsx:330` |

三者同时打开时：`50% + 50% + 288px = 100% + 288px`。**只有 chat 带 `min-w-0`**，所以全部溢出由它吸收 → **chat 实际宽度 ≈ 50% − 288px**。

在 1440px 窗口下（再减左栏 256px）chat 仅剩约 300px，而正文列的目标宽度是 `max-w-[860px]`（`Session.tsx:206`，三个 dock 同步对齐）——**直接崩塌**。

ADR-009 当年设计 50/50 分屏时，布局假设写的是「预览(w-1/2) | Chat(w-1/2) | Sidebar(w-80)」，**当时就没算平这笔账**；且实现里预览已从左侧移到右侧、sidebar 从 `w-80` 变成 `w-72`，文档与代码已漂移。

### 1.3 布局状态机：目前是一片空地

`sidebar-context.tsx` 全部布局状态 = 两个裸 boolean（`leftOpen` / `rightOpen`），无枚举、无宽度、无持久化（刷新即重置）。预览的开关状态甚至不在这里，是 `Session.tsx:40` 的局部 `selectedArtifact`。所有宽度都是硬编码 Tailwind 常量。

> 这既是问题的成因，也是好消息：**没有存量抽象要推翻**，新的状态机可以直接落在 `SidebarContext`。

---

## 2. 业界调研（2026-07，区分有据可查 / 未找到）

### 2.1 可迁移的五条（均有一手来源）

1. **手动操作必须压过自动行为。** VS Code Agents Window 官方明文：保留用户手动关闭的侧栏，并在多会话并排（用户明显在做对照）时**暂停** auto-collapse。同源教训是 `explorer.autoReveal` 那一串 issue（[#5329](https://github.com/microsoft/vscode/issues/5329) / [#175690](https://github.com/microsoft/vscode/issues/175690) / [#9932](https://github.com/Microsoft/vscode/issues/9932)）——最终形态是**默认开、可关、关掉后手动入口仍在**。来源：https://code.visualstudio.com/docs/copilot/agents/agents-window
2. **自动展开要有阈值，不是「有东西就开」。** ChatGPT Canvas 的启发式是「生成内容超过 10 行」才自动开面板；Claude 只有 artifact 才开面板，普通代码块不开。来源：https://openai.com/index/introducing-canvas/ · https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-it
3. **宽度双态（half → full）是行业共识。** Claude Artifacts 与 ChatGPT Canvas 都是「半屏并存 → 可扩宽为全屏、聊天隐藏、输入框下沉」。且 Claude 曾**主动把默认从 full 降级成 half**（TestingCatalog 2024 抓到的改版）。
4. **列表 ≠ 详情。** Zed（Review Changes → multi-buffer tab）、Windsurf（preview 作为 editor tab）、Cursor（browser layout）一致：侧栏放清单/摘要，详情开到主区。反面教材同样有据：Claude Code [issue #42347](https://github.com/anthropics/claude-code/issues/42347) 就是用户抱怨 diff 抢占主编辑区，被 closed as not planned——**「抢主区」也有代价，没有免费的解**。
5. **passive 用徽标，action-required 才打断。** NN/g：无需用户响应的通知应当 less intrusive（徽标/角落提示）；需要立即处置的才配用打断式。「产物已生成」是 passive；「需要你授权才能继续」才是 action-required。来源：https://www.nngroup.com/articles/indicators-validations-notifications/

### 2.2 一个不能照搬的先例（重要）

**Claude / Canvas 的「预览取代侧栏」不能直接搬到我们身上**：它们的侧栏里**没有产物列表**（artifact 是从聊天流里点开的）。而我们的产物列表和工作区文件树**都长在右侧栏里**——一旦互斥，点开一个产物就切断了看下一个产物的路径。这是 §4.3 要专门解决的。

### 2.3 明确未找到公开资料

Claude Cowork 的面板布局细节、Manus 是否默认自动展开右栏、Cline / Continue / Qoder / OpenClaw / Hermes 的相关设计说明——**均无权威来源，不作为本方案的论据**。（用户提及的 Cowork 行为来自其本人观察，作为需求输入而非外部先例引用。）

---

## 3. 方案

### 3.1 布局状态机（`sidebar-context.tsx`）

新增 `previewMode: "closed" | "half" | "full"` 及其 action。三条硬规则：

- **互斥**：打开预览 → 快照当前 `rightOpen` → 强制收起右侧栏；关闭预览 → 按快照恢复。
  - 边界：**用户在预览打开期间手动开了右侧栏**，则快照作废（不能在关预览时又把它关掉）。「手动压过自动」在这里同样适用。
- **宽度按 mode 派生**，替换 `Session.tsx:175` 的 `selectedArtifact ? "w-1/2" : "flex-1"`：

  | mode | chat | preview | 右侧栏 |
  |------|------|---------|--------|
  | `closed` | `flex-1` | — | 用户自定 |
  | `half` | `w-1/2` | `w-1/2` | 强制收起 |
  | `full` | 转录区隐藏、**输入框保留** | `flex-1` | 强制收起 |

  三者永不并排 → §1.2 的溢出账**从结构上消失**，不是靠调数值糊过去。
- **窄窗口降级**：主区可用宽度 < 1100px 时，打开预览直接进 `full`，不给两边都不可用的 half。（阈值待真机校准。）

`selectedArtifact` 仍可留在 `Session.tsx` 的局部 state（它是数据不是布局），但**开关它必须经过 context 的 action**，不能再直接 `setSelectedArtifact`。

### 3.2 分级通知

| 事件 | 行为 | 理由 |
|------|------|------|
| **规划首次出现**（`plan.updated` 且 steps 0 → >0，**每会话仅一次**） | 自动展开右侧栏 + 展开 Plan section | 规划是「这一整个回合要干什么」的导航，价值高、只发生一次、不重复打扰 → 符合 §2.1-2 的阈值原则 |
| **产物出现** | **只打徽标**，不碰右侧栏 | 产物常在回合末尾成批到达，自动展开会反复抢视线 → §2.1-5 的 passive notification |

- **徽标位置**：TopBar 的 `PanelRight` 按钮（未读计数）+ 侧栏内 Artifacts section header 的计数。用户展开该 section 即清零。
- **粘性意图**：用户手动关闭过右侧栏 → 本会话内标记 `autoRevealSuppressed`，后续规划不再自动展开，只给徽标。切会话重置。
- **kill switch**：设置页开关（关掉后规划也不自动展开）。徽标本身不提供关闭——零打扰，无需开关。
- Artifacts section 的 `defaultOpen` 从 `false` 改为「有产物时默认展开」。

### 3.3 产物派生逻辑提升到 Session 级（本方案唯一的非平凡数据流改动）

徽标计数需要在**右侧栏关着时**也能拿到产物数量，而现在产物派生（`extractArtifacts` + fs 扫描 + `classifyArtifacts`）全在 `ArtifactsPanel` 内部的 `useMemo`/`useEffect` 里（`artifacts-panel.tsx:318-366`）——侧栏没开，组件根本没挂载。

抽成 `useSessionArtifacts` hook 在 Session 级常驻，`ArtifactsPanel` 退化为纯渲染。**它同时是 §3.4 预览内导航的数据源。**

> ⚠️ **代价必须说清**：fs 扫描 effect 依赖 `[active, directory, baseline, messages.length]`，agent 忙时 return（`artifacts-panel.tsx:343`），实际频率是**每回合结束扫一次**。提升到 Session 级后，这个扫描从「侧栏开着时每回合一次」变成「**永远每回合一次**」。Rust 侧有上限保护（深度 ≤8、访问上限 5 万项，`src-tauri/src/lib.rs:1540-1552`），但在大工作区上这是一笔**新的常驻开销，必须实测**（见 §5）。

### 3.4 预览面板内置产物导航

互斥的固有代价：产物列表在侧栏里，点开一个产物侧栏就没了，看下一个得先关预览。**不补的话，浏览多个产物会变成「每看一个闪一次侧栏」。**

补法：预览 header 加「上一个 / 下一个」+ 位置指示（`3 / 7`），数据源即 §3.3 的 `useSessionArtifacts` 列表。

- **降级**：工作区文件树点开的文件（`Session.tsx:160-162` `handleFileTreeClick`）**不在产物列表里**，此时导航态无意义 → 隐藏导航控件，只保留关闭/最大化。

### 3.5 full 态保留输入框

`full` 态隐藏转录区但 **ChatInput 下沉到全宽底部**，用户可以一边看全屏产物一边说「把第二段改短一点」。对齐 ChatGPT Canvas。

- **配套**：转录区隐藏时 agent 的回复用户看不见 → 需要一个轻提示（如输入框上方一行「已回复 · 查看」，点击退回 half）。否则用户不知道 agent 回话了。

---

## 4. 决策记录（2026-07-11 用户拍板）

| # | 议题 | 选项 | 决策 |
|---|------|------|------|
| D1 | 规划/产物到达时右侧栏行为 | ① 规划自动展开+产物只徽标 ② 全部只徽标 ③ 全部自动展开 | **①** |
| D2 | 预览与右侧栏关系 | ① 互斥+half/full 双态 ② 只互斥不做 full ③ ①+可拖拽 resizer | **①**（resizer 刻意不做，见 §6） |
| D3 | 互斥后如何看下一个产物 | ① 预览内置导航 ② 靠 Esc 唤回侧栏 ③ 侧栏收成窄 rail | **①** |
| D4 | full 态下的对话能力 | ① 保留输入框（Canvas 式） ② 纯阅读态 | **①** |

---

## 5. 实现风险与必测项

| # | 风险 | 说明 | 验法 |
|---|------|------|------|
| R1 | **`full` 态可能打破 ADR-047 的贴底滚动** | ADR-047 依赖 `contentRef` 的 ResizeObserver 持续触发。用 `display:none` 隐藏转录区会让 RO 停摆，退回 `half` 时滚动位置可能错乱 | 实现用**零宽 + overflow hidden**（而非 `display:none`），并在 e2e 里断言 half↔full 往返后仍贴底 |
| R2 | **fs 扫描提升到 Session 级的常驻开销**（§3.3） | 从「侧栏开着时每回合一次」变成「永远每回合一次」 | 大工作区（含 node_modules）实测单次 `scan_workspace_changes` 耗时；必要时加「首个产物出现前不扫」之类的惰性门控 |
| R3 | 快照恢复语义的边界 | 「预览期间用户手动开侧栏」必须让快照作废 | 单测覆盖此反例 |
| R4 | 窄窗口阈值（1100px）拍脑袋 | 未经真机校准 | 真机在多档窗口宽度下走查 |

---

## 6. 刻意不做

- **可拖拽 resizer + 宽度持久化**：独立工作量（拖拽状态机、min/max 约束、持久化），half/full 两档已覆盖实际痛点。
- **预览停靠位置可配**（Zed 的 dock left/right/bottom）：我们没有 editor 区，主区就是 chat，无意义。
- **产物 toast**：与徽标重复打扰。
- **规划自动展开联动委派子会话**：ADR-038 已定「不聚合 delegate 子会话的 plan」，本方案不改变该语义。

---

## 7. 验证计划

- **单测**：布局状态机的互斥/恢复语义（含 R3 反例）、粘性意图的抑制逻辑、未读计数的清零时机、导航在「文件树文件」下的降级。
- **e2e**（复用现有两引擎基建，chromium + webkit 都跑）：开预览 → 断言右侧栏消失 **且无横向溢出**（直接量 `scrollWidth <= clientWidth`，这是 §1.2 的直接回归守卫）→ 切 full → 退回 half → 断言 chat 仍贴底（R1 守卫）。
- **真机（用户）**：`full` 态滚动观感、规划首次自动展开的打扰程度、徽标是否足够醒目、窄窗口阈值是否合适。**像素与主观观感由用户判断。**
