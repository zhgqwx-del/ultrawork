# ADR-073：输入框草稿跨路由存活 —— 内存分桶 Provider 挂在 Router 之外

- 状态：已接受（2026-08-23）
- 日期：2026-08-23
- 相关：discussions/060（根因实测 + 完整方案 + 验证记录）· gotchas §23 · conventions §29 · testing §13 · ADR-030（会话-agent 绑定）· 018（Team 模式是任务的出生属性）

## 背景

用户报：首页（单 agent / Team 两种模式）输入内容后切到其他页面再切回来，输入被清空。

**根因用两个 vitest 探针实测确认，不是推断**：

1. `input` 是 `HomePage` 的组件本地 `useState`（`Home.tsx:50`）。
2. `/`、`/session/:id`、`/settings`、`/orchestration` 是 `RootLayout` 的**兄弟子路由**，`<Outlet>` 在切换时整体替换元素 —— 探针实测 composer 节点消失，页面真的被卸载。
3. `ChatInput` 是完全受控组件，自身不留副本；全 `src` 的 14 处 `localStorage` 没有一处是草稿。

⇒ **这不是回归，是从未实现的功能**（`docs/archive/reviews/review-2.5-chatinput.md` §8 当年即标记 Deferred）。

同一根因下一并丢失的还有 `mode` / `agentId` / `memberIds` / `attach.items`。另有一个**方向相反**的既有缺陷：`/session/A → /session/B` 只变 `:param`，react-router **不重挂载**（探针 2 实测）⇒ 草稿和附件从会话 A 泄漏到会话 B —— 而 `Session.tsx:228-235` 早有「按 id 重置 per-session UI state」的 effect，独独漏了这两项。

## 决策

### D1：状态放**内存** Provider，不放 `sessionStorage`

用户拍板「附件也要保留」，这一条推翻了最初的 storage 方案：

- 附件是 `data:` URL 字符串（`attachments.ts:334`），单张可达 MB 级，而每桶上限 `MAX_INLINE_TOTAL_BYTES` = 15 MB ⇒ 远超 Storage 的 ~5 MB 配额。
- 文本走 storage、附件走内存会产出**最糟的中间态**：文字回来了、文件悄悄没了。

代价是整页刷新 / 重启丢失 —— 与用户拍板的「切页面够用」一致。

### D2：Provider 挂在 `RouterProvider` **外层**

父路由在子路由切换时不卸载，所以挂 `RootLayout` 内对 `/` ↔ `/settings` **等价**（这一点是被自己的 mutant 推翻后才搞清的）。唯一能区分的是 **`/workspace`** —— 它在 `RootLayout` 之外，而 `WorkspaceSelector` 没有「取消」，只是去看一眼也必然走一遭。

### D3：拆**双 context**（State 读 / Dispatch 写）

`LeftSidebar` 常驻，且需要 dispatch（删会话时丢桶）。合成单个 context 的话，**每敲一个键整个侧栏都会重渲染**。dispatch 值引用恒定。

### D4：恢复时按当前世界「净化」，且**派生不写回**

桶里存的是**引用**（agent id / 成员 id / 依赖 ACP 的模式），被引用的东西会在用户离开期间消失。派生能在 `agents` 还空的头几帧自动让路；写回会把那一瞬间的空值永久固化成用户的选择。

> `AgentSelector` 的 `agents.find(...) ?? agents[0]` **只兜底显示** —— 失效 id 仍会照常派发，于是「界面显示 A、提示词发给 B」。

### D5：附件桶按 **LRU 保留最近 5 个**，文本永久保留

驻留期从「切走即释放」变成「发送或删会话才释放」，而桶数 = 会话数 ⇒ 不设上界就没有上界。文本几 KB，是用户要重打的部分，永久留；附件两次点击可重挂，超额淘汰。

### D6：`initialInput` 交接 —— 覆盖，但把草稿交还

设置页「装技能 / 依赖引导」交接过来的是**几百字的机器指令**（`i18n-translations.ts:753`），拼接只会产出没法发的东西，而首页 textarea 只有 200px 高，用户自己的字会被挤出视野。所以覆盖，但 `toast` + 「恢复草稿」按钮 —— 与 `Home.tsx:88-93` 切 Team 模式清附件时的既有做法一致。

**切 workspace 不清草稿**：心智模型保持单一 —— **草稿只在两种情况消失：发送成功、会话被删**。

> D6 与切 workspace 两条背后是同一个原则：**可见的小混乱 > 不可见的丢失**。

## 后果

### 正面
- 首页 / 会话页的输入、附件、任务出生配置跨路由存活；点「+ 新建对话」也保留（用户拍板）。
- 顺带修掉会话间草稿 / 附件泄漏这个既有缺陷。

### 负面 / 需要注意
- 整页刷新丢失（设计如此）。
- 附件驻留期变长，靠 D5 的 LRU 兜住上界。
- `use-attachments` 的 `itemsRef` 与外部 store 有失配风险，靠 store 的 `key` + 清空走 `setBoth` 解决（gotchas §23③）。
- `React.StrictMode` 下交接 effect 双跑，需自带守卫（gotchas §23④）。

## 验证

910/910 单测 · typecheck 8/8 · `vite build` · **12 个 mutant 控制臂**（每个只打红对应断言）· 浏览器 e2e（Chrome + WebKit 双引擎）· **真机 `tauri dev` 原生窗口 6 步全过**（含 Team 模式成员改为非默认值后往返、真实 PNG 附件往返、会话 A/B 隔离）。

明细见 discussions/060 §十二。
