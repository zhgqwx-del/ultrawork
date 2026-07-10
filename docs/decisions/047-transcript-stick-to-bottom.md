# ADR-047: 会话转录区的贴底滚动 —— 去 content-visibility、修活 ResizeObserver、改用 use-stick-to-bottom

**状态**: Accepted (✅ 已实现)
**日期**: 2026-07-10
**关联**: ADR-021 (长对话性能优化)、ADR-029 (执行流程分组)、ADR-037 (跨平台)

## TL;DR

「AI 回复完成后没滚到底」不是没滚，是**滚到了一个假的底部，而且没有任何机制能纠正它**。三条互相独立的根因：`content-visibility: auto` 让 `scrollHeight` 在关键的那一帧撒谎；`contentRef` 被 flex stretch 钉死导致它的 `ResizeObserver` 从未触发过；完成路径上没有任何补正。修法是去掉 CV、把滚动容器改成 block、把 175 行自研启发式换成 `use-stick-to-bottom`。真机实测完成后 Δbottom 从 1619px 降到 1px。

---

## 背景

用户报告：对于有一定量工具调用和思考过程的任务，AI 回复完成后主窗口没有滚动到底。短回复不复现。

### 根因（真机实测，非推断）

用真 opencode + 真模型 + 真渲染器测量，逐帧采样 `scrollTop / scrollHeight / contentRef 高度 / RO 触发次数`。

**根因 1 — `content-visibility: auto` 在完成那一帧让 `scrollHeight` 撒谎。**

`message-list.tsx` 原本对非流式 turn 挂 `contentVisibility: auto` + `containIntrinsicSize: auto 500px`。`isStreaming` 一翻假，CV 立刻落到刚完成的那个 turn 上。而 `contain-intrinsic-size` 的 `auto` 关键字是「记住上次渲染尺寸」——元素**首次**被加上 CV 时**没有记忆值**，只能用 fallback 的 500px（MDN / csswg-drafts#7807）。

实测轨迹（同一采样点）：

```
    t(ms)  Δbottom  scrollTop  scrollHeight  CV元素
    22201        0       1711          2327       1     ← 贴底跟随中
    24202     1619         42          2277       2     ← CV 落地
```

真实高度 1700px 的 turn 被压成 500px，`scrollHeight` 从 2327 塌到 658。`scrollTop = scrollHeight` 忠实地滚到了这个假底部：`658 - 616(clientHeight) = 42`。下一帧它膨胀回真实高度，`scrollTop` 却永远停在 42。**谎言只存在一帧，但那一帧正好是我们唯一的滚动触发点。**

这解释了「内容多才复现」：turn 高度 < 500px 时 fallback ≈ 真实高度，看不出来。

**根因 2 — `contentRef` 的 ResizeObserver 从落地那天起就没触发过。**

`Session.tsx` 的滚动容器是 `display: flex`，`contentRef` 是它的 flex item。单行 flex 容器高度确定时，flex line 的交叉尺寸 = 容器内高，`align-items: stretch` 把 item 钉死在这个高度上，子元素只是溢出它。实测：塞进 6021px 的消息，`contentRef` 高度恒为 616px（= `clientHeight`），**RO 全程只触发 1 次（挂载那次）**。

ADR-021 Phase 4 引入的「智能滚动」核心机制，从 `ac9f7e4e` 落地起就没运行过。流式期间之所以正常，纯粹是 `messages` 数组每个 SSE token 都换引用，靠 `[messages]` 那个 effect 在滚。

**根因 3 — 完成路径没有补正。**

会话加载有 100ms/300ms 两个 settle 定时器，完成时刻没有。而 `useStableStreaming` 在 +600ms 折叠执行流、加上 footer，这是纯 React 状态变化，不改 `messages`、不触发 RO，无人补滚。

### 顺带发现

- `use-session-scroll.ts` 的 escaped 检测只监听 `wheel` 且 `deltaY < 0`。**拖滚动条、PageUp/Home、触摸拖拽一律漏检**，会把正在看历史的用户强行拽回底部（Claude Code / Gemini / Cursor 桌面版都被开过这个 issue）。
- hook 返回了 `userScrolled`，`Session.tsx` 从未消费——没有「回到底部」按钮。
- `minimumSystemVersion` 是 10.15，而 `content-visibility` 要 Safari 18 / macOS 15。**macOS ≤14 的用户既碰不到这个 bug，也从来没享受到 ADR-021 那次 CV 优化。**
- desktop 的 423 个 vitest 跑在 jsdom 上，**没有布局引擎，一个都测不到这类缺陷**——这正是它能活这么久的原因。

---

## 决策

### D1 — 移除 `content-visibility`，不做替代

列表已被 `TURN_INIT = 15` 窗口化（`use-session-messages.ts`），且每个 turn 都被 `turnPropsEqual` memo 挡住重渲染。CV 是压在这两层之上的第三层，边际收益小；而它对 `scrollHeight` 的污染是持续性的（贴底判定、「加载更早」的批量未绘制 turn、滚动条 thumb 跳动）。macOS ≤14 是天然对照组，没有长会话卡顿投诉。

**用一个会对 `scrollHeight` 撒谎的 CSS 优化去换 15 个 turn 的 layout 开销，不划算。** 真要优化长历史，正确的工具是虚拟列表或收紧窗口。

### D2 — 滚动容器改 block，内容层 `mx-auto` 居中

`flex + justify-center` 换成 `block + mx-auto`。这让 `contentRef` 的高度重新等于内容高度，RO 复活。

实测（隔离复现台，两引擎一致）：静置到弹簧动画停止后，单帧撑高 1440px（一个代码块 / 一张图 / 一坨工具结果就是这个形状）——

| 布局 | RO 触发 | Δbottom 轨迹 |
|---|---|---|
| flex（原状） | 0 | 1201, 1201, 1201 …（**永久卡死**） |
| block | 1 | 701→262→88→…→**1** |

### D3 — 换用 `use-stick-to-bottom`，不再自研

`use-session-scroll.ts` 的 175 行里有四个互相独立的缺陷：RO 挂在被 stretch 的元素上（死）、escaped 靠 `wheel deltaY<0` 猜（漏键盘/滚动条/触摸）、`overflow-anchor` 开关在 WKWebView 里大概率空操作、`markAuto` 的 1500ms TTL + 2px 容差是个脆弱启发式。把这四条逐个修好，产出物基本就是那个库。

`use-stick-to-bottom`（Vercel AI Elements、ElevenLabs UI 在用）提供：按位置判定的 escaped 态、选区保护（`getSelection()`）、写 `scrollTop` 前临时切 `scroll-behavior: auto`、以及用速度弹簧追一个尺寸还在变的目标。

**两个坑（都实测过）：**

- 不要设 `resize: "instant"`。那会让 hook 在每个增长帧硬写 `scrollTop`，**用户物理上无法在流式期间拖离底部**。保持库默认的弹簧。
- 库自身在 `content-visibility` 面前一样会挂（Δ≈1050px，且它把 CV 塌陷导致的 `scrollTop` 钳制误判成用户上滚而主动 escape）。**D1 是 D3 的前提，换库救不了。**

库的 `isAtBottom` 容差是 70px，所以完成后 Δbottom 可能残留 ≤70px。转录区底部有 `pb-24`（96px）内边距，残留被吸收，视觉上无影响。

### D4 — 补上「回到底部」浮动按钮

离开底部时出现，点击平滑回底并重新贴底。主流 AI 聊天 UI 的标配。

### D5 — 不做「把最新提问 pin 到视口顶部」（ChatGPT 式）

单独立项。它和「完成时折叠执行流」冲突更狠：提问钉在顶部、下方内容突然缩掉几千像素，会留下更难看的空洞。ChatGPT 没有执行流折叠这个东西。

### D5b — 会话切换要临时把 `resize` 钉成 `instant`

库的 `initial` 动画**只作用于内容观察器看到的第一次 resize**。`SessionPage` 跨 `/session/:id` 复用（react-router 不重挂载），所以会话切换拿不到 `initial`——历史内容以普通增长的形式涌入，视图会**可见地弹簧滚动到底**（实测 `scrollTop` 经过 75 个取值，0 → 3514）。

库每次 resize 都重读 `optionsRef.current`，所以修法是：会话变更后的 800ms 内把 `resize` 钉成 `"instant"`，之后交还弹簧。**不能一直钉着 instant**——见 D3 的第一个坑。实测修复后 `scrollTop` 只经过 2-3 个取值。

由 e2e case F 守住。

### D6 — 不为执行流折叠做手动 scroll anchoring

一度实现了（WebKit 不实现 scroll anchoring，webkit.org #171099）。**A/B 反证推翻了它**：禁用补偿后，WebKit 上折叠帧的阅读位置位移仍然是 0px，`scrollTop` 照样自己减去收缩量。隔离沙箱里观察到的 817px「跳动」其实是**贴近底部时的钳制**，不是缺少 anchoring——我把两者混为一谈了。代码删除。

真正会跳的只剩「折叠后转录区短于视口」的退化场景，此时 `scrollTop` 必然钳到 0，任何补偿都无能为力。

---

## 验证

**真机（真 opencode + 真 qwen3.7-max + 真渲染器），同一提问同一模型：**

| | 修复前 | 修复后 |
|---|---|---|
| 完成后 Δbottom | 1619px / 3962px | **1px** |
| contentRef 上 RO 触发 | 1 次 | 120+ 次 |
| contentRef 高度取值 | 恒 616px | 120+ 个不同值 |

**`e2e/session-scroll.e2e.ts`（`bun run --bun e2e/session-scroll.e2e.ts`，`E2E_ENGINE=webkit` 切引擎）**：A 完成贴底 / B RO 存活 / C 无 CV / D 拖滚动条不被拽回 + 按钮出现 + 点击回底 / E 折叠不跳动 / F 会话切换瞬间贴底。**两个引擎都要跑**——Chromium 的原生 scroll anchoring 会独自吸收折叠，E 在它上面是空跑。

**e2e 里刻意不静默降级**：E 的前置（执行流够高 + 折叠后转录区仍溢出）不满足时打 `SKIP ⚠️` 而不是 PASS。这个场景无法用真模型稳定构造——一个先输出文本、随后又发起工具调用的 step，其文本会被 `buildTurnModel` 从「答案」重新归类为「过程 narration」（ADR-029 的有意取舍），可能一帧之内蒸发掉 4628px，把停好的阅读位置冲到底部附近。

---

## 后果

- **正向**：完成后正确贴底；用户上滚不再被拽回（含键盘/滚动条/触摸）；流式中选中文本不会被抽走；任何异步撑高（图片、字体、代码块、工具结果）都能自愈；多了「回到底部」按钮。
- **代价**：新增依赖 `use-stick-to-bottom@1.1.6`（~5KB）；失去 CV 的屏外跳过（对 15 个窗口化 turn 而言可忽略，且在 macOS ≤14 上本就不存在）。
- **约束**：`contentRef` **永远不能**是被 stretch 的 flex item；转录区内**永远不能**出现 `content-visibility: auto`。两条都写进了 `use-session-scroll.ts` 的文档注释和 `gotchas.md §15`，并由 e2e case B / C 守住。
- **另行走查过、无缺陷的集成路径**（两引擎各一遍）：右侧栏开合与窗口缩放都不会把已上滚的用户拉到底；贴底状态下滚动容器变高（dock 消失 / 窗口放大）不会被误判成用户上滚而脱锁。「加载更早」的批量 prepend 未验证——但新旧实现在这条路径上行为一致（都靠浏览器默认 `overflow-anchor: auto`，WebKit 两版都没有），不是本次引入的风险。
- **未做**：长会话性能对照（去 CV 后用 `scripts/test-long-session.ts` 跑 100 轮）。窗口化仍在，预期无可测退化，但未实测。
