# 060 — 输入框草稿跨页面保留（Home + Session）

> 状态：**已实现（2026-08-23），本机门禁全绿；真机视觉验收待用户**
> 日期：2026-08-22
> 触发：用户报「Home 页（单 agent / Team 两种模式）输入内容后切到其他页面再切回来，已输入内容被清空」
> 用户拍板（2026-08-22）：① 草稿保留（含点「+ 新建对话」时）② 只需跨页面，不需跨 app 重启 ③ **附件也要保留** ④ mode/agent/成员都保留，Session 跨会话泄漏一起修

---

## 一、根因（实测确认，非推断）

三条事实叠加，缺一不可：

1. **`input` 是 HomePage 的组件本地 state** — `pages/Home.tsx:50`。
2. **路由切换会卸载 HomePage** — `router.tsx` 里 `/`、`/session/:id`、`/settings`、`/orchestration` 是 `RootLayout` 的兄弟子路由，`<Outlet>` 切换时整体替换元素。
3. **没有任何地方存过这个值** — `ChatInput` 是完全受控组件（`chat-input.tsx:39-40`，自身不留副本）；全 `src` 的 14 处 `localStorage` 使用里没有一处是草稿。

### 探针实测（临时 vitest，跑完即删）

**探针 1** — 真实 `HomePage` 挂在真实 `MemoryRouter` 下（重依赖 mock，`ChatInput` 换成受控 textarea）：

```
输入 "写一份季度报告"  → 读回 "写一份季度报告"        ← 控制臂：探针确实量得到非空草稿
navigate("/settings") → queryByTestId("composer") === null   ← HomePage 真的被卸载
navigate("/")         → DRAFT AFTER RETURN = ""              ← 复现
```

**探针 2** — react-router 重挂载语义：

```
/session/A → /session/B（只变 :param）：draft = "draft-for-A"   ← 状态存活 ⇒ 跨会话泄漏
/session/B → /settings → /session/B    ：draft = ""             ← 状态丢弃
```

> **结论：这不是回归，是从未实现的功能。** 佐证：`docs/archive/reviews/review-2.5-chatinput.md` §8「缺少草稿保存」当年即标记 Deferred → 「Phase 3 或后续」，一直没做。

## 二、同一根因下丢失的全部状态

| 丢失项 | 位置 | 用户可感知后果 |
|---|---|---|
| `input` | Home.tsx:50 | 用户报告的问题 |
| `mode`（单 agent / Team） | Home.tsx:56 | 回来后从 Team 掉回单 agent |
| `agentId`（agent / Leader） | Home.tsx:55 | 需重选 |
| `memberIds` + `membersTouched` | Home.tsx:57-58 | Team 成员勾选重置为全选 |
| `attach.items` | `useAttachments` 在 Home 内 | 已选图片/文档全部丢失 |

**反向缺陷（同一处代码的另一面）**：`SessionPage` 的 `input` / `attach` 同样是本地 state，而 `/session/A → /session/B` **不重挂载** ⇒ 草稿与附件从会话 A **泄漏**到会话 B。

> **有利证据**：`Session.tsx:228-235` 已经有一个「按 id 重置 per-session UI state」的 effect（重置 `selectedArtifact` / preview / `autoRevealSuppressed` / `planRevealedRef`），**独独漏了 `input` 和 `attach`** ⇒ 泄漏是遗漏而非设计，且「per-session 状态跟着 id 走」本就是该文件的既定约定。

## 三、存储层选择：纯内存 Provider（**不用 sessionStorage**）

用户第 ③ 条（附件也要保留）推翻了最初的 storage 方案：

| 事实 | 结论 |
|---|---|
| 附件是 data: URL 字符串（`attachments.ts:334`），单图可达 MB 级 | storage 配额 ~5MB，**放不下也不该放** ⇒ 附件只能走内存 |
| 探针 1 证明卸载只发生在 `<Outlet>` 内 | 内存容器挂在 **`RouterProvider` 外层**即对所有路由跳转免疫 |
| 文本走 storage / 附件走内存 | 会出现「文本回来了、附件没回来」的半截状态 ⇒ 一套机制更对 |

代价：整页刷新 / app 重启丢失 —— 与用户第 ② 条拍板一致。

> **实现期修正（2026-08-23，被自己的控制臂推翻）**：原文说「必须挂在 `RouterProvider` 外层」。
> 把 Provider 改挂到 `RootLayout` 内跑端到端探针，`/` ↔ `/settings` 往返**照样 PASS** ——
> 父路由在子路由切换时并不卸载，所以对最常见的路径两个位置**等价**。
> 真正区分它们的只有 **`/workspace` 往返**（该路由在 `RootLayout` 之外）：
> 挂内层时第 4 步草稿变空（FAIL），挂外层时保留（PASS）。
> ⇒ 挂外层仍是对的（§八.2 论证过 WorkspaceSelector 没有「取消」，看一眼也必然走一遭），
> 但它的**收益比原文声称的窄得多**，不是「唯一可行」而是「多覆盖一条路径」。
> 教训：**mutant 不红不等于测试空转，也可能是我对「什么算缺陷」判断错了。**

## 四、结构

新增 `src/lib/draft-context.tsx`，挂在 `main.tsx` 的 `ModelProvider` 与 `RouterProvider` 之间。

```
Map<string, DraftBucket>       key: "home" | `session:${id}`
DraftBucket = { text, attachments,                              // 两页共用
                mode, agentId, memberIds, membersTouched }      // 仅 home 桶
```

**必须拆成两个 context**：

- `DraftStateContext`（读）— 只有当前挂载的页面消费
- `DraftDispatchContext`（写）— 引用恒定，**常驻的 `LeftSidebar` 只消费这个**

> 若合成单个 context，侧栏（为删会话清桶而消费 context）会在**每一次按键**时重渲染 —— 这是一条会被引入的性能回退，拆分即消除。

## 五、改造点与各自的实现陷阱

### ① `use-attachments.ts` — items 存储可注入
写入口只有一个（`setBoth`，L92-98），改造面小。

> ⚠️ **陷阱**：`itemsRef`(L92) 是 hook 本地 ref、初始 `[]`，同时是附件**数量上限的同步权威**（L196 `rejectionOf(file, kind, itemsRef.current.length)`）。外部化后页面重挂载时 ref 是空的而桶里有 3 个 ⇒ 上限判定归零，可加到 13 个。**ref 必须从桶初始化。**

### ② `Home.tsx` — 6 项状态改读写 home 桶
> ⚠️ **陷阱 A**：`membersTouched` 必须一起存。否则 L100-103 依赖 `[agents]` 的 effect 会在重挂载后把成员**重置回全选**，恢复等于白做。
> ⚠️ **陷阱 B**：清桶只能挂在**真正发出去**的位置（L150-152 / L216-217）；L145-148 的早退分支（附件全部 materialize 失败 → toast → return）**不能清**，否则吞掉用户输入。

### ③ `Session.tsx` — `input` / `attach` 改用 `session:${id}` 桶
切 id 自动换桶 ⇒ 泄漏消失，且各会话草稿各自保留。

### ④ `left-sidebar.tsx:210-221` — 删会话时清对应桶
不清则已删会话的 data URL 常驻内存。

### ⑤ `main.tsx` — 挂 Provider

## 六、恢复时的「净化」（缺口 ①，不做则方案是负收益）

**持久化的是"引用"，而被引用的东西会在用户离开期间变化：**

| 状态 | 现在为什么没事 | 持久化后的缺陷 |
|---|---|---|
| `agentId` | 每次回 Home 重置为 `OPENCODE_DEFAULT_AGENT_ID` | `agent-selector.tsx:49` 的 `agents.find(...) ?? agents[0]` **只兜底了显示**；Home 的 state 仍是失效 id ⇒ **界面显示 agents[0]，实际派发失效 id** |
| `memberIds` | 每次重置为「全选当前 agents」 | `membersTouched=true` 后自动全选不再兜底；已卸载的 agent 留在集合里，`memberRoster`(L127-133) 造出 `{id, name: id}` 幽灵成员，写进 leader 系统提示词与 `createTeamSession` |
| `mode="team"` | 每次重置为 `single` | `acpAvailable` 变 false 时 Team 段禁用而状态已在 team ⇒ 停在不可用模式（可切回，非死锁，但 `handleTeamSend` 必失败） |

**对策**：恢复时对着当前 `agents` / `acpAvailable` 做一次净化 —— 过滤幽灵成员、失效 `agentId` 回落默认、`mode` 不可用回落 `single`。

## 七、内存上界（缺口 ②）

现在附件切走即释放；改后留到「发送成功」或「删会话」。每桶上限 `MAX_ATTACHMENTS=10` / `MAX_INLINE_TOTAL_BYTES=15MB`（`attachments.ts:29,80`），而桶数 = 会话数 ⇒ **理论最坏无上界**。

**对策**：文本永久保留（几 KB 量级）；**附件桶按 LRU 只保留最近 N 个会话**（N=3~5）。

## 八、两个产品语义决策

1. **`initialInput` 与草稿冲突**（Settings 装技能 / 依赖引导 → `navigate("/", {state:{initialInput}})`，`Settings.tsx:1807,1854`）
   `initialInput` 是**几百字的完整机器指令**（`i18n-translations.ts:753` 带整段「收敛标准」）⇒ 拼接会产出语义混乱的 prompt，且 Home 的 textarea 最高 200px（`chat-input.tsx:299`），草稿会被挤出可视区。
   **决定：覆盖显示，旧草稿转存 `displaced` 槽 + `toast.info` + 「撤销」按钮。**
   > 这不是新发明：`Home.tsx:88-93` 切 Team 模式清附件时就是 `attach.clear()` + `toast.info(t("attachment.clearedForTeam"))`——「清掉用户的东西时可见地说一声」是该文件既定约定。

2. **切 workspace 不清 home 桶。**
   理由：① 本特性目的就是「别让用户重打字」，清空等于造第二条丢失路径 ② 心智模型要单一可记：**草稿只在两种情况消失 —— 发送成功、会话被删** ③ `WorkspaceSelector` 没有「取消」（L13-34 三个入口全部 `setWorkspace + navigate("/")`），进去看一眼也必然走一次 `setWorkspace` ④ 语境过时是**可见**的，用户随手能删；清掉则不可恢复。

> 两条背后同一个原则：**可见的小混乱 > 不可见的丢失。**

## 八·补、实现期自查发现的回归（方案原文没有，已修）

`itemsRef`（`use-attachments.ts`）不只是数量上限的权威，`remove()` 也从它 filter。外部 store
一引入，它就有两条失配路径：

1. **切会话**（SessionPage 不重挂载）⇒ ref 还是 A 的列表，在 B 里 `remove()` 会把 **A 的附件写进 B 的桶**（不是少算几个，是数据串台）。
2. **发送后**（Session 发完不卸载）⇒ ref 仍计着刚发走的文件，上限被吃掉。

对策：① `AttachmentStore` 增加 `key` 字段，key 变化时用新桶重新播种 ref（**不能**每渲染从
`store.items` 同步 —— 一次串行 add 会在 React 提交前多次推进 ref，那正是 ref 存在的理由）；
② 两个发送点先 `attach.clear()` 再 `clearDraft`，让清空走 `setBoth`。
两条都有控制臂（M8 / M9）。

**已知残留（保守方向，不修）**：LRU 淘汰理论上可能清掉当前活跃桶的附件而 ref 未同步 ——
需要用户在 5 个其他会话里都加过附件且当前桶最老。后果是上限**偏保守**（少让加几个），不会突破。

## 九、查证后排除的担心（不是问题）

- **不会重复打 4MB `/provider`**：`model-capabilities.ts:22-32` 有模块级 promise 缓存，附件恢复后重跑能力门命中缓存。
- **不会拿到失效 blob URL**：`Attachment.previewUrl` 是自包含 data: URL；全域唯一的 `createObjectURL`（`attachments.ts:304`）是解码临时对象、当场 revoke。
- **多行草稿高度不用管**：`chat-input.tsx:292-301` autoresize 依赖 `[value]`，恢复后自动重算。
- **Provider 重渲染不拖累全树**：`main.tsx` 的 render 只调一次，`<DraftProvider>{router}</DraftProvider>` 的 children 是同一 element 引用，React 对其 bail out。
- **唯一残留行为差异**：恢复后首帧 `checking` 短暂为 true，此时按 Enter 会被 `handleSend` 静默 return。窗口 = 一个 microtask + 一帧（<16ms），人手够不到。**记录，不处理。**

## 十、代价

| 项 | 量 |
|---|---|
| 新增 | `draft-context.tsx`（双 context，约 120-150 行） |
| 改动 | `use-attachments.ts` / `Home.tsx` / `Session.tsx` / `left-sidebar.tsx` / `main.tsx` |
| 测试 | 改 3 个既有（`home-workspace-indicator` / `delegate-dock-scope` / `artifacts-panel-render` —— 项目 context 惯例是无 Provider 即 throw，见 `workspace-context.tsx:125`、`sidebar-context.tsx:159`）+ 新增 1 个 |
| 风险集中点 | `use-attachments.ts` —— 唯一被两页共用的 hook；**引用稳定性必须保住**（Provider setter 用 `useCallback` + 函数式更新），否则 `attach.add` 引用漂移 → `useScreenshot(attach.add)` → `attachmentSlot` memo 失效 → ChatInput 每渲染都变 |

## 十一、副作用清单（会改变现有可观察行为）

1. 点「+ 新建对话」会看到上次未发的草稿（用户已拍板接受）。
2. Team 成员 / agent 选择跨页保留 —— 依赖 §六 的净化才安全。
3. 附件内存驻留期从「切走即释放」变为「发送或删会话才释放」—— 靠 §七 的 LRU 兜住。
4. 装技能的 `initialInput` 会顶掉草稿（toast + 撤销）。

## 十二、验证结果（2026-08-23，含第二轮系统 review）

**本机门禁全绿**：desktop 测试 **910/910**（新增 18 条）· typecheck **8/8** · `vite build` 通过 · `check-docs` 无漂移。
CI 的 node job 是 `[macos, windows, ubuntu]` 三平台矩阵 ⇒ 新测试三平台都会跑。

### 第二轮 review 抓到的缺陷（第一轮门禁全绿之后）

**StrictMode 下 `initialInput` 交接跑两次** —— `main.tsx` 用 `React.StrictMode`，effect 双跑 ⇒ 用户看到
**两个 toast**，且第二次把刚写入的指令当成「被顶掉的草稿」捕获 ⇒ **Undo 会还回指令而不是用户的字**。
修：用 `location.state` 对象引用做守卫（react-router 每次导航产生新对象，两次 StrictMode 传递共享它）+ toast 固定 id。控制臂 M10。

> **这一条差点被我自己的探针放过**：第一版探针让 seeder 与 HomePage 同批次挂载，effect 读到的还是空草稿，
> 于是「零 toast」——看起来像另一个 bug，其实是**时序不真实**。改成真实时序（打字 → 去 settings → 带 state 回来）才暴露出双 toast。

### 控制臂 12 个（每个 mutant 只打红它对应的断言）

| Mutant | 变红 | Mutant | 变红 |
|---|---|---|---|
| M1 草稿完全不保留（=旧实现） | 12 | M7 成员总是重置为全选（=旧 effect） | 3 |
| M2 不过滤幽灵成员 | 1 | M8 不按 store key 重新播种 | 1 |
| M3 不净化失效 agentId | 1 | M9 `itemsRef` 从 `[]` 播种 | 1 |
| M4 早退分支也清桶 | 1 | M10 去掉 StrictMode 守卫 | 1 |
| M5 去掉附件 LRU | 1 | M11 Team 发送路径不清桶 | 1 |
| M6 `dropDraft` 变 no-op | 1 | M12 ACP 不可用时不回落 single | 1 |

### 端到端走查（Chrome + Vite + Playwright，真实 app）

只 stub Tauri 桥到足以过 workspace 门；被测的 Provider / 路由 / ChatInput / useAttachments 都不经过桥。

| 探针 | 结果 | 控制臂 |
|---|---|---|
| 文本草稿：输入 → `/settings`（**composer 节点确实消失**）→ 回 `/` | PASS | Provider 挂 `RootLayout` 内 ⇒ `/workspace` 往返那步变红 |
| **附件真实链路**：paste 真 `File` → 真 `ChatInput` → 真 `useAttachments` → 切页面 → 回来附件条还在 → **还能再加第二个**（上限权威没被搞坏） | PASS | — |
| **真实 SessionPage 跨会话**：A 打字 → 切 B（只变 param，**不重挂载**）为空 → 回 A 还在 → 经 Home 回 B 还在 | PASS | `draftKey` 固定成共享值 ⇒ 第 2 步显示 "draft for A"（正是旧的泄漏），FAIL |

> 单测里 `useAttachments` 和 `ChatInput` 都是 mock 的 —— **附件那条真实链路只有这个 e2e 覆盖到**。

### 跨平台 / 打包

- 新增 `draft-context.tsx` **零浏览器/平台 API**（除 React），无 `localStorage`/`invoke`/路径/`Date.now`。
- 六个改动文件扫 `process.env` / `homedir` / `node:path` / `__dirname` / `child_process` / `/tmp` / 绝对路径 —— **零匹配**（扫描前先用「这些文件确实有 import 行」做控制臂，因为 **zsh 不对未加引号的变量做词分割**，第一版扫描整串被当成一个文件名，"无匹配" 是假的）。
- 整个 diff 无任何绝对路径 / 本机信息 / 端口硬编码；探针脚本全部在 scratchpad，未入仓库。
- 状态是**纯内存**，不落盘 ⇒ 无文件权限、无路径分隔符、无 Windows 保留名问题。

### 真机验证（2026-08-23，`tauri dev` 原生窗口 + WKWebView + 四个 sidecar 真实就绪）

用 AppleScript 驱动原生窗口 + `screencapture` 逐步取证（**不是浏览器，不是 stub**；ACP sidecar 真实在 4099，
agent 选择器真实列出 5 个 ACP agent ⇒ `acpAvailable` 真为 true）。

| # | 真机步骤 | 结果 |
|---|---|---|
| 1 | 首页输入中文草稿 → 点侧栏会话离开 → 点「+ 新建对话」回来 | 草稿完好 ✅（顺带证实「点 + 也保留」这条拍板行为） |
| 2 | 离开首页后进入的会话页 | 输入框为空 ⇒ 首页草稿**没有**泄漏到会话 ✅ |
| 3 | 切 Team 协作 → 成员由默认 6 改为 **4** → 离开首页 → 回来 | 模式仍是 Team、成员仍是 **4**、Leader 仍是 OpenCode、草稿完好 ✅ |
| 4 | 单 Agent 下粘贴一张真实 PNG → 离开首页 → 回来 | 附件条 `image.png` 仍在，**缩略图（data: URL）正确渲染** ✅ |
| 5 | 会话 A 打字 → 切会话 B（只变 `:id`，**页面不重挂载**） | B 的输入框为空 ✅（旧实现在这里会显示 A 的草稿） |
| 6 | 在 B 打字 → 切回 A | A 的草稿原样回来 ✅ |

> 第 3 步特意把成员改成**非默认值**：若仍用默认 6，「保留了」和「重置成默认恰好一样」在截图上无法区分。

> **一次误判已证伪**：回到首页后附件条左侧多了个白色方块，我一度当成缩略图损坏。实际上我粘贴的就是一张
> 白底截图，`object-cover` 裁出的正是它的内容 —— **报缺陷前先证伪自己的尺子**。

> **真机自动化的边界**：WKWebView 不外露 web 内容的 accessibility 树（`entire contents` 只有 4 个元素），
> 所以只能靠坐标点击 + 截图判读；第一次点 Team 没生效是焦点时序，重试即成功 —— **单次点击失败不等于按钮禁用**。

### 未自动化覆盖，留给真机

剩下三项（都需要真的花钱或改配置）：**发送后清空**在真机上未走（会真实调用模型）· `initialInput` 交接的 toast + 「恢复草稿」按钮观感（需去设置页装一个技能）· 删会话清桶的真机路径（`dropDraft` 有单测，`left-sidebar` 接线靠 typecheck + review）。

### 测试的已知边界

Session 分桶的**单测**用「迷你复现组件」绑定 `sessionDraftKey(id)` 契约，不是 SessionPage 本体；
**但 e2e 那条走的是真实 SessionPage**，两者合起来覆盖了接线。

## 十三、顺带记录（不在本次范围）

- `SessionPage` 的 `preparing`(L179) 与 `fullBaseline`(L370) 也未进 L228-235 的 id-reset effect。**未验证其跨会话的实际后果**，仅记录。
- 仓库存在嵌套残留目录 `packages/client/desktop/packages/client/desktop/`（54 文件、被 git 跟踪、2026-03-05 创建），疑似历史误提交，与本任务无关 —— 调研时曾差点导致读错文件。
