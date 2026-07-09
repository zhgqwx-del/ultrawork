# 开发规范

<!-- last-synced: 2026-07-09 -->

项目开发过程中确立的约定与模式，供团队成员参考。

## 1. 代码规范

### 路径与运行时
- 路径别名 `@/` → `packages/client/desktop/src/`
- 所有脚本用 `bun run --bun` 执行（系统 Node.js v14 不兼容）
- MCP 本地服务器必须用 `bunx --bun`（不能用 `npx`，会导致 stdio pipe 断裂）
- Browser MCP 使用内嵌 Node.js（`~/.ultrawork/node/`），npm 安装必须用 `node npm-cli.js install`（不能直接调 `bin/npm`，symlink 相对路径断裂）

### UI 组件
- 遵循 shadcn/ui 模式：Radix 无样式原语 + Tailwind CSS 4
- CSS 变量 token 体系（见 `index.css`）
- 只在用户要求时使用 emoji
- i18n `t(key, params)` 插值用 `split/join` 而非 `String.replace`（replace 会解释替换值里的 `$&`/`$'` 序列——文件路径参数如 `{location}` 可能含）；同一占位符只写一次

### TypeScript
- 构建顺序：修改 `api-client` 类型后，必须先 `tsc --build` 再检查 client
- 工具参数统一 camelCase（`filePath`，非 `file_path`）

## 2. 状态管理

### React Context 分层
10 个 Provider，分两层挂载：
- **app 级**（`main.tsx`，Router 外）7 个：`ConfigProvider` → `ThemeProvider` → `I18nProvider` → `WorkspaceProvider` → `SSEProvider` → `AgentProvider`（ACP 多 agent 注册表）→ `ModelProvider`
- **布局级**（`components/layout/root-layout.tsx`，Router 内）3 个：`TeamSessionsProvider`（编排/Team）→ `SessionsProvider` → `SidebarProvider`

新增 Provider 时按依赖选层：需要路由信息（`useLocation` 等，必须在 Router 内），**或**依赖已确认的工作区上下文（布局级挂在 root-layout 的 workspace-confirmed 门之后、随工作区切换重挂，如 Sessions/TeamSessions）→ 进布局级；两者都不沾的全局横切关注（主题/i18n/配置/SSE 连接）→ 进 app 级。

### 共享 Hook 提取模式
多组件共用逻辑时提取为独立 hook（如 `useMCPServers`, `useSkills`）：
- Hook 暴露数据 + 操作
- UI 状态（showAdd 等）留在各组件本地
- `handleAdd` throw 让调用者控制成功/失败 UI

### useRef 同步乐观更新
`setConfig(newConfig)` 后必须 `configRef.current = newConfig`，否则 React 批量更新期间连续调用读到旧 ref。

### sendingRef 互斥锁
`sendingRef.current` 同步锁防 React 批量更新间双发；`session.status:idle` 和 catch 中重置。

### idRef 跨 Session 异步安全
```ts
const idRef = useRef(id);
idRef.current = id;
// 异步回调中用 idRef.current !== id 检查是否仍在同一 session
```

### setTimeout cleanup 模式
```ts
const timerRef = useRef<ReturnType<typeof setTimeout>>();
useEffect(() => () => clearTimeout(timerRef.current), []);
```

### 挂载守卫 ref 必须在 effect **setup** 复位（StrictMode 坑，2026-06-19 实测）
`isMounted`/`mountedRef` 守卫（`await` 后 `if (!mountedRef.current) return` / `if (mountedRef.current) setX(...)`，防卸载后 setState）**绝不能只在 cleanup 置 false**：
```ts
// ❌ 错：dev StrictMode 跑 effect = setup→cleanup→setup，cleanup 置 false 后 setup 不复位
const mountedRef = useRef(true);
useEffect(() => () => { mountedRef.current = false }, []);
// → 挂载后 mountedRef.current 恒为 false → 所有 await 后的 setState（如 setSaving(false)）被跳过
//   → 按钮 loading 永不停（请求其实早成功）。仅 dev 触发（main.tsx 包 <StrictMode>）。
// ✅ 对：setup 复位 true
useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, []);
```
**测试也要包 StrictMode 才测得出**（`render(<StrictMode><Comp/></StrictMode>)`，断言 await 后的成功路径执行）——testing-library 默认不包，是此类 bug 长期漏网的原因。**优先用局部变量式守卫**（`let cancelled=false; …; return () => { cancelled=true }`，每次 effect 重建新闭包、StrictMode 天然安全，见 `pdf-view.tsx`/`pipeline-tab.tsx`），仅在跨多个 handler 共享时才用 ref。

### 临时 UI 态优先「派生自路由」而非「进入时改写全局态再还原」（2026-07-01 实测）
当某 UI 态只应在特定路由期间成立（如左侧栏在 `/settings` 强制折叠），**从路由派生**它，不要进入时改写共享/全局态、离开时还原：
```ts
// ❌ 脆：进入改写、离开还原，需存"进来前的原值"，快速来回/二次导航易漂 + 污染用户偏好
useEffect(() => { if (isSettings) { prev.current = leftOpen; setLeftOpen(false) } else setLeftOpen(prev.current) }, [isSettings])
// ✅ 稳：纯派生，零存储零还原，离开路由自动恢复用户真实偏好
const effectiveOpen = leftOpen && !isSettings   // 用 effectiveOpen 渲染，绝不写 leftOpen
```
无竞态、不污染偏好、离开自动还原。配套：路由判定抽成单一 `isSettingsPath(pathname)`（`=== "/settings" || startsWith("/settings/")`，避免 `startsWith("/settings")` 误命中未来 `/settings-*` 兄弟路由 + 消除多处重复）。见 `left-sidebar.tsx` / `sidebar-context.tsx`。

### 「返回来源页」用 SPA 内导航历史 ref，别写死目标也别靠 `navigate(-1)`（ADR-038 后续 UX）
关闭覆盖型路由页（如 Settings）要回到"进来前那一页"（Home / `/session/:id` / …）：在共享 Provider（`SidebarProvider`，必在 Router 内）用 effect 记录"最后一个非目标路由"到 ref，关闭时 `navigate(ref.current, { replace: true })`：
```ts
const lastMainPathRef = useRef("/")
const loc = useLocation()
useEffect(() => { if (!isSettingsPath(loc.pathname)) lastMainPathRef.current = loc.pathname + loc.search }, [loc.pathname, loc.search])
```
- **别用 `navigate(-1)`**：页内二次 `navigate("/settings",{state})`（如 popover 点 About）会压历史栈，`-1` 退回 settings 自身而非退出。
- **别写死 `navigate("/")`**：丢失来源。
- ref 初值兜底默认路由；`replace:true` 让历史栈不残留 settings。
- **e2e 坑**：`page.goto` 全量重载会重置 SPA 状态，故造"来源页"必须靠真实 SPA 点击导航（发 prompt 造真 session 再点），不能 goto。见 `e2e/settings-collapse-return.e2e.ts`。

## 3. SSE 事件处理

### 后端调用一律经 @agent/connector（阶段2 起，ADR-030）
会话流（prompt/cancel/fetchHistory/replyPermission/deleteSession/订阅）调 `useConnector()` 的统一面——connector 按会话绑定派发到 OpenCodeBackend/ACPBackend，**新代码不要直连 api-client 或裸 fetch :4099**。backend-specific 面（providers/mcp/skills/file/config）仍经 `useApi()`（= connector 持有的同一 ApiClient，签名未变）。后端行为差异用 `connector.capabilitiesOf(sessionId)` 门控（revert/model/questions/sessionStatus…），不要写 `isACP` 之类的 kind 判断。

### 全局单连接
`SSEProvider`（实为 ConnectorProvider）在 app 级维护单一全局 SSE 连接，跨页面不丢事件；SSE 实现（fetch-reader/退避/心跳看门狗）统一在 `@agent/connector` 的 `sse-transport.ts`。

### useSSESubscribe / useSessionSubscribe
`useSSESubscribe` 订阅全局流（ref 模式，依赖 `[subscribe]` 避免 heartbeat 重订阅）；`useSessionSubscribe(sessionId, handler)` 按绑定订阅单会话——opencode 过滤全局流，ACP 自动**双流合并**（sidecar per-session 流 + 全局流的标题/删除事件），绑定变化自动重订阅。

### 核心事件
| 事件 | 作用 |
|------|------|
| `message.part.updated` | 完整 part upsert |
| `message.part.delta` | 按 partID+field 增量 append |
| `message.updated` | 消息元数据更新 |
| `message.part.removed` | 移除 part |
| `session.status:idle` | Agent 完成，清除 sending 状态 |
| `plan.updated` | 任务规划整表替换（会话级状态，ADR-038；OpenCode 由 connector 从 `todo.updated` 归一，ACP 由 `turn-shaper` 发） |
| `permission.asked` | 弹出权限授权 Dock |
| `question.asked` | 弹出问答 Dock |

### 会话级状态：REST 水合 + SSE 订阅（整表替换）模式（ADR-038 `useSessionPlan`）
"按会话取一份后端整表状态、实时整表替换"的 hook（如任务规划）按此写，**两个竞态各踩过一次**：

1. **水合 vs 实时竞态**：进入会话同时做「`getPlan()` REST 拉权威快照」+「订阅 `plan.updated` 整表替换」。若快照 Promise 在某个实时事件**之后**才 resolve，会用过期快照覆盖更新的实时数据。
   → 用 `liveArrivedRef`：当前会话一旦收到实时事件就置位，快照回填前检查 `!liveArrivedRef.current`（**live 永远 ≥ 快照，live-wins**）。
2. **绑定异步水合竞态**：ACP 的 session→backend 绑定在 sidecar 启动后**异步**水合（ADR-030），可能在 hook 挂载**之后**才把绑定从 opencode 翻成 acp。若水合 effect 只依赖 `[connector, sessionId]`，绑定翻转后不会按正确后端重取 → ACP 会话状态恒空。
   → 把绑定纳入依赖：`useSyncExternalStore(connector.bindings.onChange, () => connector.bindings.get(sessionId))`，绑定变化即重新水合。

```ts
const binding = useSyncExternalStore(
  useCallback((cb) => connector.bindings.onChange(cb), [connector]),
  () => (sessionId ? connector.bindings.get(sessionId) : ""),
)
useEffect(() => {
  let cancelled = false; liveArrivedRef.current = false
  connector.getPlan(sessionId).then((snap) => {
    if (!cancelled && !liveArrivedRef.current) setState(snap) // 不覆盖更新的 live
  })
  return () => { cancelled = true }
}, [connector, sessionId, binding]) // ← binding 必须在依赖里
// handler: liveArrivedRef.current = true; setState(event.properties.entries)
```

### 轮询兜底
Agent 活跃时（`sending || streamingMessageId !== null`）每 3s 轮询 permission/question API，防 SSE 竞态丢事件。

### SSE 重连
30s 心跳超时 → `forceReconnect()`，最多 3 次；收到事件重置计数。`connect()` 用局部 `controller` 变量防旧连接 finally 覆盖新连接。

## 4. OpenCode API 约定

### 消息发送
`POST /session/:id/prompt_async` 是唯一发送方式，返回 204。

### Model 参数
```ts
// prompt_async model 格式
{ providerID: string, modelID: string }
// 客户端从 "provider/model" 格式字符串解析
```

### Config 写入分两条路（ADR-039 起）
- **Per-workspace `PATCH /config`**：只写磁盘工作区 `opencode.json`，**不影响运行时**。运行时模型切换须用 `prompt_async` 的 `model` 参数。
- **全局配置 `PATCH /global/config?refresh=soft`**（vendor patch，ADR-039）：写全局配置文件 + **软刷新**（`refreshGlobal` 只失效 8 个配置派生纯缓存、不 dispose 活资源）→ **即时生效且不打断在流回合**。provider 定义/baseURL/删除、MCP、skills 等全局心智的配置一律走这条（见 `models-section.tsx` / `use-skills.ts`）。缺省（无 `?refresh=soft`）仍是 hard `disposeAll`，**会中止所有在流回合**，勿在有活跃会话时用。
- **`POST /global/refresh`**：只软刷新不写盘（如 skills 目录外部变化后让其即时可见）。
- 机制细节与边界 → gotchas §11（SSOT）。

### File API
路径必须为相对路径 + `x-opencode-directory` header。绝对路径会 join 出错误路径。

### request\<T\> void 处理
检查 204/empty body 后才调 `.json()`，用于 replyPermission/replyQuestion/abortSession。

> 📍 本节是「应该怎么做」。OpenCode API 的**非直觉类型契约与运行时限制**（PartBase/ToolState/PatchPart 结构、PATCH /config 不影响运行时、File API 相对路径、camelCase 等）见 [`gotchas.md`](./gotchas.md) §1-2（权威 SSOT）；端点完整清单见 [`api-reference.md`](./api-reference.md)。

## 5. 组件模式

### 乐观消息
- 用户消息使用 `temp-` ID 前缀
- `message.part.updated` 过滤所有 `temp-` 消息创建真实消息
- Home→Session 传递：`navigate(url, { state: { sending: true, messageText: text } })`

### Dock 优先级
条件渲染顺序：Question > Permission > ChatInput

### Stop 执行（frozenMessageIds）
- `handleStop` 冻结所有当前消息 ID
- SSE handler 屏蔽冻结 ID 的事件
- Temp 消息提升为 `stopped-*` ID
- `session.status:idle` 不清除 `stopped`（在 `handleSend` 中清除）
- `handleSend` 清除 stopped 时同时清空 `frozenMessageIdsRef`

### 流式区域内的操作按钮用 `onPointerDown`（2026-06-11 实测事故）
浏览器只在 pointerdown/up 落在**同一元素**时才派发 click。高速流式（如逐行输出）下消息区每秒回流多次 + 自动滚动，跟随内容流的按钮在按下与抬起之间位移 → click 被吞，用户表现为「点击停止无效」。规则：
- 随内容流动的操作按钮（ExecutionStatus 的停止键）→ `onPointerDown` 触发，不用 `onClick`
- 关键操作同时给一个**位置固定**的入口：ChatInput 发送键在 `loading && onStop` 时变为停止键（`chat-input.tsx`），输入框不回流、永远可点

### React key
优先使用 `part.id`：`('id' in part && part.id) ? part.id : \`part-${i}\``

### Escape 键防冲突
ArtifactPreview 使用 `!e.defaultPrevented` 检查，避免与 CommandSelector 等 capture 阶段 handler 冲突。

### ModelSelector TTL 缓存
模块级 `cachedModels` + `cacheTimestamp`，5 分钟 TTL；有缓存时后台静默刷新。

### Session 状态重置
`useEffect([id])` 重置 messages/pending*/streamingId/sending/selectedArtifact/stopped/frozenIds。`setMessages([])` 必须在 reset 中清空。

### getMessages merge
`prev.length === 0 ? msgs : [...msgs, ...sseOnly]` — 必须配合 session 切换时 `setMessages([])`。

### 回合分组渲染（执行流程）
OpenCode 一个 user 回合会产出 **N 条 assistant message**（每个工具循环 step 一条，`finish="tool-calls"` 则继续；详见 [ADR-029](decisions/029-execution-flow-turn-grouping.md)）。主对话**不要按 message 平铺渲染**，而是：
- `message-list.tsx` 的 `groupIntoTurns()` 把「一条 user + 其后连续 assistant」聚成一个回合，渲染 `AssistantTurn`。
- `AssistantTurn` 的 `buildTurnModel()` 把整回合 parts 切成「过程」（收进无卡片包裹的 `ExecutionFlow` 折叠时间线）与「答案」（最后一条**无 tool** message 的输出 part，容器外渲染）；末尾渲染居中带横线的统计页脚。
- **回合是否在生成**（`message-list.tsx` 的 `isTurnTerminal` / `isTurnStreaming`，纯函数可测）：
  - **终态 = 末条 `finish` 终态（存在且≠`tool-calls`） 或 末条 `info.error` 有值**。出错回合 `finish` 留 `undefined`、错误落在 `info.error`（gotchas §1），**必须把 error 当终态**，否则被误判成「仍在流式」。
  - **「从末条非终态推断流式」这个兜底必须门控 `sessionActive`**（本会话当前真有请求在飞 = `sending || streamingMessageId`）：`isStreaming = !isStopped && (containsStreaming || (isLastGroup && !isTerminal && sessionActive))`。否则**历史/重开会话**里末条非终态（出错/中断）的回合会**永久转圈**（`Session.tsx` 传 `sessionActive`；委派子卡片 `delegate-row` 传 `sessionActive=false`——懒加载历史永不 live）。
  - **不要**用瞬时 `streamingMessageId` 单独判定（step 间/工具执行期会置 null → 抖动）；也**不要**用 `time.completed` 当终态（工具步也有，会误杀回合中段）。
  - **错误态渲染**：`buildTurnModel.hasError` 同时覆盖工具级 error 与消息级 `info.error`，并暴露 `errorText`；出错回合 parts 常为空，`AssistantTurn` 用独立红色错误块显示 `errorText`（否则空白）。
- **memo**：`groupIntoTurns` 每渲染重建数组，`AssistantTurn` 必须用自定义比较器（按 `messages` 元素引用比较）才能让历史回合在流式中跳过重渲染——历史 message 对象引用稳定（state 只换变化的那条）。
- **实时耗时**：`ExecutionFlow` 的 `useNow(active)`（100ms tick）只在「回合流式中 && 该行进行中」时激活（`live=isStreaming` 下传）——恢复/被 stop 的历史回合里残留的 running/thinking 状态**不得走秒**；滴答重渲染被限制在进行中的行 + 头部，不穿透 memo 屏障。

### 下拉选择一律用 `components/ui/select.tsx`（不要原生 `<select>`）
原生 `<select>` 的**展开面板由 OS 渲染、CSS 改不动**（深浅色/圆角/勾选样式全失控）。统一用 shadcn 风格的 `Select`（基于 `@radix-ui/react-select`，与 `dropdown-menu` 同一套 token/勾选/品牌色）：
```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

<Select value={v} onValueChange={setV}>
  <SelectTrigger className="h-8 text-xs">  {/* 默认 h-9；窄场景可覆盖高度 */}
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    {opts.map((o) => <SelectItem key={o} value={o} className="text-xs">{o}</SelectItem>)}
  </SelectContent>
</Select>
```
- **坑：Radix Select 禁止空串 `value=""`**（会抛运行时错）。原生 select 用 `<option value="">默认</option>` 表「无覆盖」的，迁移时改用哨兵值（如 `"__default__"`），在 `onValueChange` 里翻译回 `undefined`。
- 药丸/内联触发器：给 `SelectTrigger` 覆盖 `h-auto w-auto rounded-full ... [&>svg]:size-3` 即可保留原视觉（见 `pipeline-tab.tsx` agent 选择器）。

### Radix Tabs：非活动 `TabsContent` 默认**卸载**——持有在途局部态的 tab 要 `forceMount`（2026-07-09 复审实证）
`@radix-ui/react-tabs` 的 `TabsContent` 在非活动时**整块卸载**（不是隐藏）。若某个 tab 里有**组件局部 state**（未 hoist 的 `useState`/安装进度/半填表单/粘贴的文本），切走再切回会**销毁并重置**这些态——用户切个 tab 回来东西没了，甚至能重复触发在跑的动作（如安装）。两种解法：
```tsx
// 方案 A（推荐，最省）：keep-alive——挂载保活 + 非活动时 CSS 隐藏
<TabsContent value="mcp" forceMount className="data-[state=inactive]:hidden">
  {/* BrowserServiceCard 安装进度 / ServiceAddForm 已填字段等局部态跨 tab 往返存活 */}
</TabsContent>
```
- Radix 只给非活动 Content 挂 `data-state="inactive"`，**不自动加 `hidden` 样式**，所以 forceMount 时必须自己补 `data-[state=inactive]:hidden`（→ `display:none`），否则内容会叠着显示。
- 方案 B：把易失局部态 hoist 到 tab 容器组件（像 `ServicesSection` 的 `useCliConnectors`/`useMCPServers`），则该 tab 无需 forceMount。**判断法**：tab 内组件是否持有不想丢的在途态——有则 forceMount 或 hoist，无（纯派生自 hoisted hook）则放任卸载最省。
- **测试坑**：forceMount 后非活动内容仍在 DOM，jsdom 无 Tailwind CSS 故 `toBeVisible()` 判不出隐藏——改断言容器 `[role=tabpanel]` 的 `data-state="inactive"`；真隐藏由真浏览器走查（`display:none` / `isVisible()===false`）兜。见 `settings-services.test.tsx` + `e2e/connectors-tabs-ui-walkthrough`。
- **反向硬约束：tab 面板是「同一列表的重叠子集」时，绝不能 forceMount**（2026-07-09 A/B 实证）。知识库的「全部」tab 与「本地/平台/API」三个 tab 渲染的是同一个 `sources` 数组的重叠切片——同一个 source 同时属于「全部」和它的类型 tab。此时 forceMount 会让**同一张卡片在 DOM 里挂两份**，连带 `KnowledgeSourceCard` 的索引进度 `setTimeout` 也跑两个。判断法与上面正好相反：**tab 内容是异质面板**（连接器 MCP vs 办公 CLI、技能 内置/推荐/自定义）→ 按局部态决定是否 forceMount；**tab 内容是同一数据源的重叠切片**（含「全部」这类 tab）→ 一律放任卸载。Radix 源码保证这是安全的：`TabsContent` 内部是 `children: present && children`，非活动面板的子组件函数体根本不执行（不是「渲染后隐藏」）。
- 断言这条不变量：`expect(screen.getAllByText(sourceName)).toHaveLength(1)`（RTL 的 `getAllByText` 会匹配 `hidden` 节点，所以 forceMount 造成的重复面板确实会让长度变 2）。见 `settings-knowledge.test.tsx`。

### 设置页 section 子 tab 统一走 `SectionTabs`（2026-07-09）
三个设置 section（技能 / 连接器 / 知识库）的子 tab 共用 `components/settings/section-tabs.tsx`：数据驱动注册表 `{id, labelKey, icon?, count?}` + Radix 段控。要点：
- `SectionTabs` **只包 `TabsList`**，`TabsContent` 由调用方自己写——因为 `forceMount` 是**逐面板**的决定（见上两条），不能做成组件级开关。
- `count` 语义统一为**条目数**（已配置的 MCP server / 内置技能数 / 知识源数），**不是连接状态数**。连接/就绪状态归页头徽章，两个数字不在同一位置抢语义。为 0 也渲染，让空分类自己说出来。
- 新增一类子 tab = 注册表加一行 + 一个 `TabsContent`。

## 6. 构建与部署

### Gateway 重编译
修改 `packages/channel/gateway/src/` 后需：
```bash
bun run build:gateway
```

### Vendor Patch
Apply 后需重编译 sidecar。

### Tauri Sidecar 并行启动
Gateway 非关键，用 `std::thread::spawn` + `app.handle().clone()` 在后台启动。

### 外部链接
Tauri WebView 中 `window.open` 无法打开系统浏览器，必须用 `@tauri-apps/plugin-opener` 的 `openUrl()`。

### Production vs Dev URL 差异
Dev 模式下 Vite proxy 将相对路径转发到后端，Production 下没有 proxy。所有 localhost 服务请求必须区分环境：
```ts
// OpenCode API（已有模式）
const baseUrl = import.meta.env.DEV ? "" : "http://localhost:4096"
// Gateway
const GATEWAY_BASE = import.meta.env.DEV ? "/channel" : "http://localhost:4097/channel"
```

### Gateway CORS 白名单
Production 下 Tauri webview origin（`tauri://localhost`）跨域请求 Gateway，必须配置 CORS。仅允许已知 origin，不要用 `origin: "*"`：
```ts
cors({
  origin: ["tauri://localhost", "https://tauri.localhost", "http://tauri.localhost", "http://localhost:1420"],
})
```

### Gateway 重编译完整流程
修改 Gateway 代码后，必须重新编译 sidecar 二进制并重新打包 DMG：
```bash
bun run --bun scripts/build-gateway.ts  # 编译并复制到 src-tauri/binaries/
bun run --bun tauri build               # 打包 DMG
```
注意：仅 `turbo run build` 会编译到 `gateway/dist/`，**不会**更新 sidecar binaries 目录。

## 7. MCP 持久化

> 📍 MCP 的**踩坑点**（必须用 `bunx --bun` 不用 `npx`、Browser MCP npm 调用方式、工具名前缀叠加、CONNECT_TIMEOUT）见 [`gotchas.md`](./gotchas.md) §3（SSOT）。本节只讲持久化约定。

**术语约定（2026-07-02 更名）**：面向用户的 UI 文案统一用「**MCP 连接器**」（右侧栏窄空间可简作「连接器」）；「MCP 服务器」仅用于开发者语境（mcpBuilder、协议层）。新增文案勿回潮「MCP 服务」。

### 存储迁移（Issue#18）
MCP 服务配置已从 `localStorage` 迁移到 `opencode.json`（通过 Tauri command 读写工作区配置文件）。浏览器 MCP 全局配置存储在 `~/.config/ultrawork/opencode.json`，跨工作区自动恢复。

### Browser MCP 双模式
- **Playwright MCP**（默认）：`~/.ultrawork/mcp/playwright/`
- **Chrome DevTools MCP**（可选）：`~/.ultrawork/mcp/chrome-devtools/`
- Node.js 运行时：`~/.ultrawork/node/`（按需下载 v22）
- MCP 注册名 `browser` + 工具名 `browser_take_screenshot` → 实际调用名为 `browser_browser_take_screenshot`（前缀叠加）

## 8. 内置命令可见性

面向开发者的内置命令（`/init`, `/review`）通过前端过滤对普通用户隐藏，不在 CommandSelector 和 Skills Panel 中显示。过滤逻辑在 `command-selector.tsx` 和 `use-skills.ts` 中。

## 9. Logo 组件

品牌 Logo 使用 SVG 棱镜设计（`src/components/ui/logo.tsx`）。组件内部使用 `useId()` 为 SVG gradient 生成唯一 ID，防止同页面多实例时 gradient ID 冲突。

## 10. SSE 竞态防护（fire-and-forget 端点）

当后端端点以 fire-and-forget 方式启动异步任务（如索引、重建）时，如果任务完成速度快于 HTTP 响应传递，SSE 事件会在前端状态就绪前到达，导致事件被丢弃（前端 `setSources` 的 map 找不到匹配项）。

**修复模式（双重保障）：**

```typescript
// 后端：延迟启动异步任务，让 POST 响应先到达前端
setTimeout(() => {
  indexer.indexFolder(folderPath).catch(console.error)
}, 50)
return c.json({ status: "indexing" }, 202)

// 前端：乐观更新后 fallback 刷新，兜底 SSE 事件丢失
setSources((prev) => [...prev, { status: "indexing", totalFiles: 0, ... }])
setTimeout(() => fetchSources(), 500)
```

**适用场景**：所有返回 202 并以 fire-and-forget 启动后台任务、依赖 SSE 推送进度的端点（如 `/kb/sources` POST、`/kb/sources/:id/reindex`）。

## 11. ACP 外部 Agent 接入（@agent/acp-client，ADR-027 档1）

新接一个 ACP agent / 修改整形逻辑时遵循以下模式（反向坑点见 [gotchas §8](./gotchas.md)）：

**整形契约（sidecar 输出必须「长得和 opencode 一模一样」）：**

```
一个 prompt 回合 →
  user 回显 message（text part.updated + role:"user" 的 message.updated）
  N 个过程 message（reasoning/tool part；封板时 message.updated finish:"tool-calls"）
  1 个答案 message（仅 text part；endTurn 时 finish:"stop" + tokens/cost + time.completed）
```

- **先 `message.part.updated` 建 part（带正确 type），再 `message.part.delta` 追加**——永远不要让 delta 先到。
- tool_call / tool_call_update **按 toolCallId upsert** 到同一 part（核心逻辑集中在 `turn-shaper.ts`，纯函数可测）。
- 事件 sessionID 用客户端传入的 `clientSessionId` 直通，前端零改写。

**接入新 agent**：在 `~/.config/ultrawork/agents.json`（或 Settings UI）注册 `agent name → command/args/env`，无需新代码；Settings「添加 Agent」表单顶部有**预置模板 chips**（claude/gemini/qoder，`agent-templates.ts`，一键填充 command/args/env，已存在同 id 置灰）。per-agent 怪癖集中在 `acp-connection.ts`：常量区（超时等）+ **spawn 期 env 注入函数**（如 `applyGeminiQuirks`——检测 command/args 识别 agent，注入缺省 env + 托管 settings 文件，**显式 agent env 永远优先**，纯函数可离线测）。per-agent 行为开关走 env（如 claude thinking = `MAX_THINKING_TOKENS`，DEFAULT_AGENTS 默认 8192）或 agents.json 字段（如 `thoughtLevel` → 会话级 `session/set_config_option`，best-effort），`PUT /acp/agents/:id` 保存即热生效（断开重连）。

**会话历史持久化（W4b）**：sidecar 端 `session-store.ts` 维护与前端同构的 event-fold reducer（part.updated 按 id upsert / delta 追加 / message.updated merge info），在 user echo 落定与 assistant 终态封板时整体落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（**数据进 xdgData**，与 opencode 存量同级）。前端打开 ACP 会话从 `GET /acp/session/:id/messages` 取历史（`use-session-messages` 按 isACP 分流，hasMore=false）；agent 上下文在下次 prompt 时经 `session/load` 懒恢复 + replay 全抑制——**历史渲染永远不依赖 agent 存活**。会话删除时前端 fire-and-forget `DELETE /acp/session/:id` 防孤儿文件。

**档1 入口约束（one session, one agent）**：Home 是新会话唯一入口——侧栏「+」只 `navigate("/")`；Home 输入框带 AgentSelector（受控模式，会话尚不存在），发送时 `createSession → bindSessionAgent → 按 agent 分流 prompt`，**出生即绑定**；Session 页的 AgentSelector 在 `loading || sending || allMessages.length > 0` 时锁定（仅空会话可换）——中途切 agent 会让历史显示在 opencode/ACP 两个 store 间二选一。

**测试模式（三层）**：① mock ACP agent（`packages/agent/acp-client/scripts/mock-acp-agent.ts`，stdin JSON-RPC 确定性回放，`bun test src` 离线跑）→ ② 真实 agent spike 脚本落盘 fixture（`packages/agent/acp-client/scripts/spike-claude.ts`）→ ③ desktop vitest 用 fixture 喂真实 `buildTurnModel`/`groupIntoTurns` 断言渲染契约。

**真机 UI 验证（不依赖 Tauri 壳）**：Chrome（playwright-core `channel:"chrome"`）驱动 Vite :1420，`addInitScript` 预埋 localStorage——`ultrawork-config`（凭证取自 `~/.config/ultrawork/sidecar-auth.json`）+ `workspace_path`；WorkspaceSelector 的「继续」按钮纯 JS 可点，之后整个 app 流程可自动化（建会话/选 agent/发消息/断言渲染/截图）。

## 12. 内置技能 authoring（`skills/builtin/`，ADR-032）

**目录约定**：每个内置技能一目录，含 `SKILL.md`（frontmatter `name`+`description`+自定义 `x-requires:[...]`）+ 可选 `scripts/` + `LICENSE.txt`（第三方上游许可，须 Apache-2.0/MIT 等**可再分发**）+ `NOTICE`（来源 commit + 改动说明）。上游技能（skill-creator/skill-installer/pdf/markdown-exporter/ppt-master）**由 `scripts/fetch-builtin-skills.ts` 拉取+打补丁，勿手改**；自写技能（doc-edit、feishu-assistant）可直接编辑（改完重打 zip 同步 sentinel）。**生效链路（2026-07-03 起 zip 分发，ADR-041）**：改任意内容 → 重跑 fetch 脚本刷新 `.builtin-version`（内容 hash）→ 构建期 `scripts/pack-builtin-skills.ts` 按 hash 惰性重打 `skills-builtin.zip`（beforeDevCommand/beforeBuildCommand/build-release 自动跑）→ 桌面端 sentinel 变化触发升级重装。注意：**已在跑的 `tauri dev` 期间直接改 `skills/builtin/` 不会进 bundle**——需重启 dev 或手动 `bun run --bun scripts/pack-builtin-skills.ts`；pack/fetch 两脚本的 hash 算法必须逐字节一致（gotchas §10）。

**新增上游技能条目流程**（fetch 脚本 `SOURCES`）：核对 LICENSE 可再分发 → `ref` **pin release tag**（勿 main，bump 时改 tag 重跑）→ 大仓库（整仓 tarball 过大）设 `sparse: true`（blobless sparse clone 只拉 `subdir`；`--branch` 不接受 commit SHA）→ 用 `drop`/`keepOnly` 裁非功能大文件（纯文档图等）→ `X_REQUIRES` 与前端 `BUILTIN_DEP_MAP` 同步 → 专属适配写成 `applyXxxPatches`（先例：skill-installer 改安装目标、ppt-master 注 `.env` 警告+清悬空引用）→ 跑 `bun run --bun scripts/fetch-builtin-skills.ts <name>`（按名过滤）并提交产物。

**自写技能脚本模式**（参考 `doc-edit/scripts/*.py`）：argv 驱动、`--json` 可选结构化输出、依赖缺失时 stderr 打印缺失库名 + `sys.exit(1)`（让 agent 据此提示安装）、无网络副作用、就地改默认/`--out` 另存。保持「薄」：只覆盖高频操作，复杂场景让 agent 直接写库 API 代码。

**依赖徽标 SSOT**：技能→运行依赖映射唯一权威是 `use-skill-deps.ts` 的 `BUILTIN_DEP_MAP`（驱动设置页 `DepBadge`）；SKILL.md 的 `x-requires` 仅人读文档，两者改一处需对齐另一处。可探测的除 PATH 二进制（`check_skill_dependencies` 探 python3/node/pandoc/…）外，还支持 **python 内探针**（`run_python_feature_probe`：版本门 `python3.10+` + pip 库 import 探测如 `python-pptx`；探针防御与语义见 gotchas §10，改探针前必读）。**依赖缺失引导**：`DepBadge` 的 `onGuide` → `depGuidePrompt` handoff 新对话让 AI 按平台引导安装（与 curated 安装同一 `navigate("/",{state:{initialInput}})` 模式）；引导词必须写死**收敛标准**（如「`python3` 命令本身 ≥3.10」），否则 AI 装个版本化命令就交差、徽标不收敛。`DEP_HINTS` 按平台三分支（`isWindows`/`isMacOS`/Linux 兜底，`@/lib/platform` 模块级常量）。

**设置-技能页三区**（`Settings.tsx` SkillsSection）：内置（`skill.location` 含 `/skills/builtin/`，只读+依赖徽标；**被用户同名安装遮蔽的内置技能渲染遮蔽卡**——琥珀徽标+规则说明+「移除用户版本，恢复内置」，fs 真相来自 `useBuiltinShadow` hook 的 `refresh_builtin_skills` 命令）/ 可安装（`INSTALLABLE_SKILLS` curated，「安装」→ `navigate("/",{state:{initialInput}})` 交给内置 skill-installer 在新对话完成；**installed 判定 = 存在非 builtin 同名项**——内置技能的 curated 条目是其自助更新通道，装完永久遮蔽内置版）/ 自定义（现有 paths·urls + 非内置发现技能；name ∈ `BUILTIN_DEP_MAP` 的项也渲依赖徽标）。新增可安装项**只放可再分发许可的来源**；大仓库条目加 **`method:"git"`**（→ `skills.installPromptGit` 强制 `--method git` sparse checkout，skill-installer auto 模式会先下整仓 zip）。遮蔽机制/坑点见 gotchas §10（`changed` 协调契约、fail-open 谓词、`BUILTIN_SKILLS_LOCK`）。

## 13. 跨平台编码规范（macOS / Windows / Linux，ADR-037）

> 本项目要在三平台打包可安装软件。所有新代码与改动**默认必须三平台兼容**。CI（`.github/workflows/ci.yml`）在 mac/win/linux 跑 typecheck+test+`cargo test`，是真正门禁；下列是写代码时的正向模式（违反通常被 CI 抓到，但应在写时就避免）。反向坑点见 `docs/gotchas.md` §12。

### 路径处理
- **拼路径用 `path.join` / `PathBuf::join`，绝不字符串拼 `/`**。取文件名用 `path.basename`（Node/Bun 侧）。
- **Renderer（`.tsx`，跑在 WebView，无 `node:path`）**：用 `@/lib/path-utils` 的 `pathBasename` / `isAbsolutePath` / `shortenPath`（同时吃 `/` 和 `\`）。判断绝对路径用 `isAbsolutePath`（认 `/…`、`C:\…`、UNC），**不要** `startsWith("/")`。切段用 `split(/[\\/]/)`，不要 `split("/")`。
  - 例外：URL 和「provider/model」逻辑 id 的 `/` 是恒定分隔符，**不算文件路径**，保持 `split("/")`。
- **Home 目录用 `os.homedir()`（TS）/ `dirs::home_dir()`（Rust）**，绝不 `process.env.HOME`（Windows 无 `HOME`）。临时目录用 `os.tmpdir()` / `std::env::temp_dir()`，不要硬编码 `/tmp`。
- **PATH 列表分隔符**：TS 用 `node:path` 的 `delimiter`；Rust 用本仓的 `PATH_LIST_SEP`（`;` on win / `:` on unix），不要硬编码 `:`。

### 外部命令与进程
- 调外部命令前问「这命令 Windows 有吗」：`lsof`/`ps`/`pgrep`/`which`/`open`/`kill`/`/bin/sh` 都是 unix-only。用**运行时分支** `if cfg!(target_os = "windows") { … } else { … }`（Rust）或 `if (process.platform === "win32")`（TS）选平台等价命令（`netstat`/`tasklist`/`where`/`explorer`/`taskkill`）。
- **Rust 跨平台优先用运行时 `cfg!()` 分支而非 `#[cfg]` 属性门控**——这样所有分支都能在本机（macOS）`cargo check` 时参与编译/类型检查；`#[cfg(windows)]` 分支本机不编译，只有 Windows CI 才验证。仅当用到平台专属 API（`std::os::unix::*`、`signal_hook`）或平台专属 crate 才用 `#[cfg]` 属性 + 另一侧 no-op，且 Cargo.toml 里把 unix-only crate 放 `[target.'cfg(unix)'.dependencies]`。
- 文件权限 `chmod` / `0o755` 仅 unix 有意义：Rust 用 `#[cfg(unix)]` 包；Bun Shell `$` 里 `chmod` 要 `if (process.platform !== "win32")` 守卫（`mkdir -p`/`cp`/`rm`/`mv` 是 Bun Shell 跨平台**内置**，可直接用，但 `chmod` 不是）。
- 打开文件/在文件管理器中显示：用 lib.rs 现成的 `open_file_with_system` / `reveal_file_in_finder`（已三平台分支），不要新写 `Command::new("open")`。

### 构建 / 脚本
- 构建脚本用 `bun run --bun`（跨平台）；初始化用 `bun run setup`（`scripts/setup.ts`，三平台），不要只写 `setup.sh`（Windows 跑不了）。
- Sidecar 产物命名 `<name>-<target-triple>[.exe]`，Tauri `externalBin` 自动按当前 triple + `.exe` 解析（已 wire，勿改）。
- codesign / lipo / notarytool / strip 仅 macOS：脚本里用 `process.platform === "darwin"` 守卫。`build-release.ts` 非 mac 走「构建 sidecar + `tauri build`」分支，不碰 Apple 签名。
- Tauri `bundle.targets` 设 `"all"`，由 Tauri 按平台产对应安装包（mac dmg/app、win nsis/msi、linux deb/appimage）。

### 进程与端口（ADR-045）
- **杀进程前必须验归属**：拿到 pid 后先读它的可执行文件名，与我方 sidecar 名比对（容忍 dev 的 `-<target-triple>` 后缀与 Windows `.exe`）。**无法归属就 fail-closed 放过**——宁可漏回收一个端口，不可误杀用户的编辑器/数据库/隧道。取进程名的三平台差异见 gotchas §12（Linux 必须读 `/proc/<pid>/exe` 并剥 `" (deleted)"`）。
- **端口不是编译期常量，也不入持久化配置**：宿主启动时决定一次，经 env 下发给直接子进程、经 IPC 下发给 renderer、经 `~/.ultrawork/run/ports.json` 下发给晚加入的孙进程。renderer 侧用**启动 gate**（`main.tsx` 在 `createRoot` 前 `await`）把异步解析收敛到一处，下游 helper 保持同步。
- **凭证同理**：`sidecar-auth.ts` 与 `sidecar-ports.ts` 同形，同一个 gate 里一起 await。两者的 loader **永不 reject**（内建兜底），否则整个 boot 挂死。
- **同一个 sidecar 只能有一个 HTTP client 模块**：`add-source-dialog.tsx` 曾私藏一份 `kbFetch`（硬编码 `:4098`、不带鉴权）。端口动态化 + 加鉴权时只改了 `use-knowledge-base.ts` 那份，添加知识源全线 401。现已收敛到 `lib/kb-client.ts`。新增 sidecar 调用方一律复用既有 client，不要另起 `fetch`。

### 已知平台边界（非 bug，刻意降级）
- **嵌入式 Node 下载 + Browser MCP + Chrome 清理**：三平台均已支持（ADR-037 后续移植）。Windows 走 node `.zip`（`node.exe` 在根 + `node_modules/npm` 无 `lib/`）、`tar -xf` 解压（Win10+ bsdtar）、`resolve_npm_cli`/`embedded_node_bin` 平台分支、Chrome 清理用 PowerShell WMI 命令行匹配 + `taskkill /F /T`。**代码层三平台编译通过，但 Windows 上 Browser MCP 的运行时（真装 + 真起浏览器）需在真 Windows 机器实测**——CI 覆盖不到浏览器自动化运行时。前置：Windows 需 `tar.exe`（Win10 1803+ 自带）+ `curl`（Win10+ 自带）。
- **渐进式工具披露内置工具 id 集**：与平台无关，但 vendor bump 时仍需复核（见 MEMORY Pending Issues）。

## 14. 消息渠道 QR 扫码接入（`qr-registry.ts`，ADR-044）

新渠道要支持「扫码即绑定」，只需实现 `QRProvider` 三件套并注册（`packages/channel/gateway/src/index.ts`）：

```ts
export function createXxxQRProvider(): QRProvider {
  return {
    type: "xxx",
    pollIntervalMs: 3000,            // 兜底；start() 可返回 per-session 覆盖（设备流会下发 interval）
    async start() {                  // 发起上游流程
      return { upstreamToken, qrContent, browserUrl?, expiresInMs?, pollIntervalMs? }
    },
    async poll(upstreamToken) {      // 轮询一次；瞬时错误直接 throw（registry 三连败才判 error）
      // → { state: "pending" | "scanned" | "expired" }
      // → { state: "denied", error? }
      // → { state: "authorized", buildConfig: (base) => ChannelConfig }  // 凭证在闭包里
    },
  }
}
```

骨架承包的事（provider 不要重复做）：后台轮询循环、**authorized 即 addChannel 落盘**（一次性 secret 安全）、统一状态枚举、并发/重复请求去重（in-flight promise + 15s 窗口，键含 autoConnect）、本地过期（尊重 expiresInMs）、取消端点、NaN 消毒、persist-成功-但-autoConnect-失败仍算 authorized。

配套固定动作清单（每加一家）：gateway `types.ts` config 类型 + adapter 工厂注册 → api-client `types.ts` 镜像同步 → 前端 `channels-section.tsx`（下拉项 + `CHANNEL_TYPE_ICONS` + `MANUAL_FORM_FIELDS` 手动兜底字段）→ `brand-icons.tsx` 品牌徽章 → i18n `channel.type.*` 等键（en/zh 成对）→ `bridge.ts` `CHANNEL_LABELS` → `bun run build:gateway` → `docs/api-reference.md`。前端 QR 组件（`ChannelQRLogin`）与手动表单已泛化，按 type 透传即可。上游契约坑（三家互不相通）见 gotchas §4。
