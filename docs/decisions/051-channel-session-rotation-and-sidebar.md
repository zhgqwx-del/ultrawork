# ADR-051 — IM 渠道会话的 idle 轮转与侧边栏发现性

> 状态：**已实施**（2026-07-12，分支 `feat/channel-session-rotation`）
> 关联：ADR-014（Bridge 形态：chatId→session + 队列 + SSE）· ADR-044（IM 扫码接入）· ADR-050（IM 输出净化与 agent 反问，本 ADR 的 in-flight 护栏直接依赖它揭示的「question 期间 session 全程 busy 且零事件」）· ADR-048（渲染期派生消除 effect 时序竞争，本 ADR 的排序沿用同一手法）· ADR-045（动态端口 / ports.json 原子写，本 ADR 的 session-map 原子写与其同构）
> 范围：`packages/channel/gateway/`（store schema + 轮转 + `/resume`）· `packages/client/desktop/`（侧边栏排序 / 渠道徽标 / 未读）· `packages/core/api-client/`（类型）

---

## 背景

真机反馈：**IM 来的消息在桌面端找不到**。用户从微信发消息给 bot，回到桌面端想看这轮对话，却要在侧边栏翻半天——对应的会话既没排在前面，也没有任何视觉标识。

拆开看是**两个可以独立成立的问题**，而它们的修法完全不同：

- **A（发现性）**：列表没把有新活动的会话顶上来。
- **B（会话语义）**：一个 IM 单聊**永远复用同一个 opencode session**，上下文无限增长，几个月前的无关话题污染当前任务。

用户最初的提议是「给 channel session 加 idle 轮转（6~12h）」。这个方向对，但它治的是 **B**，**不是 A**——而用户遇到的是 A。轮转对 A 只是顺带缓解（新 session 因 `time.created` 新而恰好排前面）；只要还有任何形式的会话复用，A 就还在。**必须分开修，不能用 B 掩盖 A。**

### A 的机械根因（两条，叠加）

1. **列表按 `time.updated` 排序，但 SSE 更新时前端原地替换、不重排。** 服务端 `GET /session` 是 `ORDER BY time_updated DESC`，排序键本身是对的；gateway 发 prompt 时 opencode 也确实会 `touch` 该 session 并经全局 SSE 广播完整对象。但接收端（`use-sessions.ts`）是 `next[idx] = {...}` ——**索引不动**。时间文案变了，位置纹丝不动，只有手动 refetch 才会重排。
2. **排序用 `time.updated`，分组却用 `time.created`**（`left-sidebar.tsx` 的 `groupSessionsByDate`）。侧边栏分「今天/昨天/本周/更早」，依据是**创建时间**。于是一个几周前建的渠道 session，哪怕今天刚被激活，**即使手动刷新也还钉在「更早」里**。两条叠加，就是「找了半天」的完整机制。

### 业界怎么做（调研，见 discussions/034）

分水岭是 IM 有没有 thread：

- **有 thread（Slack/Discord）**：thread 即天然会话边界。Claude Tag / Devin / Cursor / OpenHands / opencode 官方 Slack 包全是 `1 thread = 1 session`，**基本不需要 idle 轮转**——用户开新 thread 就是开新会话。
- **无 thread（微信/企微/钉钉单聊）**：只能退化成「一个聊天窗口一个长 session」，边界必须**人造**。三个开源项目直接对标我们的处境：

| 项目 | idle 轮转默认值 | 动机 |
|---|---|---|
| cc-connect（本地 coding agent → 飞书/钉钉/企微） | **30 分钟** | 原话：防 *context drift*——陈旧的失败命令、调试噪声被反复重新喂进上下文 |
| OpenClaw | **60 分钟**（+ daily 4am 兜底，先到先赢；官方示例 DM 240min / 群 120min） | 同上 |
| Hermes（NousResearch） | 默认 **none**，可选 idle/daily | — |

三个数字是 **30 / 60 / 最长 240 分钟**。**没有一家用 6~12 小时**——因为它们轮转是为了防上下文污染，不是为了让会话在 UI 里冒头。6~12h 意味着「只有隔夜才换」，白天连续用一整天上下文照样无限增长，B 根本没被治到。

另外两条业界共识值得记：**「能 compaction 就别 reset」**（上下文窗口满 → 压缩，同一 session；时间过久 → 才 reset）；**没有任何一家在做「话题漂移检测」**自动开新会话。

---

## 决策

### D1 — 排序在渲染期派生，绝不放进 state

`use-sessions.ts` **一行不动**。顺序完全由 `left-sidebar.tsx` 在渲染期从 `time.updated` 算出（`orderSessions()`）。

理由：把顺序放进 state、在 SSE handler 里维护，就是在 effect 里维护派生数据——ADR-048 刚为此付出过代价（`settled` 改渲染期派生消除 effect 时序竞争）。顺序是数据的纯函数，就让它是。

### D2 — 分组键与排序键**必须是同一个**

`groupSessionsByDate` 改用 `time.updated`。并且 `frozen` 参数**设为必填、不给默认值**——排序和分组读同一个 key 是这个修复的核心不变量，一个默认值会让调用方静默丢掉它（行在 hover 时跳组），而单测因为直接传参会**保持全绿**。让 tsc 抓，而不是指望测试。

> 分组标题写的是「今天/昨天」，用户读到的是「今天有动静的会话」，不是「今天创建的会话」。语义本就该跟着最后活动走。

### D3 — hover 冻结（防误点）

IM 消息把老会话顶到最前是**我们想要的**，唯一的真实危害是：**用户正要点某一项时，列表在手底下位移**。

⇒ 鼠标进入列表时对「recency key」拍快照（`snapshotOrder`），排序与分组都读快照值，所以行既不会重排也不会跳组；冻结期间新生的 session **暂不插入**而非插到顶部（否则照样推移光标下的行）；鼠标移开即解冻。行内容（标题、相对时间）仍然实时更新。

### D4 — idle 轮转：默认 **60 分钟**，lazy 判定

`ULTRAWORK_CHANNEL_IDLE_ROTATE_MS`，默认 `3600000`，设 `0` 关闭。

取 60 而非 30：我们的 agent 会跑长任务，用户提交后走开半小时回来追问是完全正常的行为，30min 容易误切。60min 是 OpenClaw 的默认值，其 DM 官方示例甚至是 240min。

**lazy 判定**（消息到达时比对 `lastActiveAt`，无后台定时器）：不需要扫描线程，也天然规避了「轮转发生在无人时、状态无处提示」的尴尬。

### D5 — 轮转**必须**告知用户，且必须有回头路

静默换 session 的代价被低估了：用户隔夜发一句「改一下刚才那个方案」，得到的是一个完全不知道"刚才"是什么的 agent。

⇒ 轮转后的第一条消息先回一句「🆕 已闲置较久，为你开启新会话（上文不再延续）。回复 /resume 可切回上一个会话。」，并新增 **`/resume`**：切回被轮转掉的会话，且**对称**（切走的那个成为新的 `prevSessionId`），误按也能切回来。旧 session **不删除**——它仍在桌面端侧边栏里。

**不做自动摘要跨 session**：业界没有一家这么做。OpenClaw 明说 reset 默认什么都不带、要连续性就用 compaction；自动摘要会把轮转本来要甩掉的 drift 又重新导进来。

### D6 — 三条护栏

1. **session 有工作在飞时绝不轮转**（`activeContexts` 非空）。这条最要命：ADR-050 已证实 question 挂起时 session **全程 busy 且零事件**（实测 195s 静默），而 `QUESTION_TIMEOUT_MS` 允许 30 分钟。阈值配短时若不排除，会在用户正琢磨怎么回答时把 session 换掉——他答完，答案落到一个已经不存在的 question 上。Hermes 明确实现了同一条规则。
2. **只有「我们真正处理了的」消息才刷新活动时钟**（`touchSession`）：ack、轮询等系统流量不算；**被挡回去的旁人插话也不算**（它从未到达 agent，否则群里任何人都能让一个死会话永远活着）。
3. **群聊的 `senderId`/`senderName` 只在建会话时写一次**，后续发言者不覆盖——否则侧边栏徽标显示的是「最后说话的人」而非会话归属者，与 title 里那个只写一次的 `[钉钉·张三]` 前缀自相矛盾。

### D7 — session-map v1 → v2：一次迁移到位

v1 是扁平 `{chatId: sessionId}`，**连时间戳都没有**，所以「这个 session 是哪个渠道来的」（徽标）和「闲置多久了」（轮转）**都答不了**。v2 一次补齐：`channelType` / `senderId` / `senderName` / `workspaceDir` / `createdAt` / `lastActiveAt` / `prevSessionId`，key 加**渠道命名空间**（v1 只按 chatId，两个渠道的用户 id 空间碰撞就会串会话）。

v1 条目**不丢**：其渠道类型无从重建，故保留在裸 chatId 下作为回退查找，该 chat 下一条消息到达时自动改写到命名空间键并补全元数据。`lastActiveAt` 未知，迁移时**戳成当前时刻**——当作「刚活跃」最多浪费一个陈旧回合，当作「远古」则会把用户正在进行的对话直接轮转掉。

### D8 — 渠道 session 的结构化标记只能在 ultrawork 侧建 registry

opencode 的 Session schema **没有** metadata/tags/source 字段，`PATCH /session` **只收** `title` 和 `time.archived`。所以在 vendor 现状下只有三条路：(a) 继续滥用 title 前缀；(b) 挂 `parentID` 到隐藏父 session（那会从 `roots:true` 列表里消失，team session 踩过）；(c) **自建 registry**。

⇒ 走 (c)：gateway 暴露 `GET /channel/sessions`，桌面端 `ChannelSessionsProvider` 消费（照抄 `team-sessions-context.tsx` 的「registry + 徽章」范式）。gateway 不可达时降级为空 registry，侧边栏必须 badge-less 地继续工作。

### D9 — 未读：本地派生 + 冷启动地板

`unread = session.time.updated > (lastReadAt[id] ?? seedAt)`，`lastReadAt` 存 localStorage。

`seedAt`（首次运行时刻）是必须的**冷启动地板**：没有它，功能上线当天**每一个历史会话都会亮成未读**。

一个陷阱：`use-sessions.ts` 的 `markSessionIdle` 会在会话 idle 时**本地伪造** `time.updated = Date.now()`（原本是给 StatusIcon 显示完成勾用的）。不处理的话，**你正开着看的会话跑完就会自己标记成未读**。⇒ `useMarkReadWhileOpen` 让当前会话跟随 `time.updated` 持续标记已读。

---

## 已知边界

- **`ULTRAWORK_CHANNEL_IDLE_ROTATE_MS` 在打包后的 app 里传不进去**：Tauri 只显式传 5 个 env 给 gateway，其余靠继承父进程环境，而双击启动时父环境是 launchd 的。所以它实质是**开发/调试逃生阀**，生产用户只能用默认 60 分钟。与项目里其他 env 旋钮（如 `OPENCODE_STREAM_TOOL_INPUT_TIMEOUT_MS`）同性质。若确认需要用户可调，做进设置页（P2）。
- **Tauri 不转发 sidecar 的 stdout**，所以 gateway 的启动日志在终端里看不见。⇒ `GET /channel/health` 现在返回 `idleRotateMs`——否则「轮转没触发」和「env 根本没到达进程」无法区分。
- **daily 4am 兜底未做**（OpenClaw 有，先到先赢）。单靠 idle 已覆盖真实场景，加它会引入时区边界。
- **群聊仍是全群一个 session**（`group:{conv}`）。业界默认按发送者隔离（Hermes 的 `group_sessions_per_user` 默认开），我们没跟——这与 ADR-050 已修的「旁人插话被当成答案」同根，留作后续。
- **permission 仍是无条件自动放行**（ADR-044 D5 / ADR-050 遗留，未在本轮解决）。

---

## 验证

- 单测：gateway **251**（+20）· desktop **458**（+14）。每条守护都做 **A/B 反证**（撤掉修复必须变红）。
- **`e2e/channel-session-rotation.e2e.ts`**（真 opencode + 真磁盘落盘，只有 IM adapter 是桩）：**15/15**。覆盖真 session 创建、`session-map.json` 真落盘且 v2、gateway 重启后映射存活、超时真轮转、轮转到的新 session 真能收 prompt、`/resume` 真切回且下一条 prompt 真落到老会话、`GET /channel/sessions` 真返回。负向对照：关掉轮转 → 4 项变红。
- **`e2e/sidebar-channel-ui.e2e.ts`**（真浏览器 + 真 opencode + 真 gateway）：Chrome **10/10** · **WebKit 10/10**（WebKit = Tauri 在 macOS 的真实引擎）。负向对照：还原 URL bug → 徽标消失；撤掉排序 → 老会话不冒顶。
- **真机四渠道验收通过**（用户亲验：轮转 + 提示 + `/resume` + 桌面端冒顶 + 徽标 + 未读）。

### 对抗审查与真环境验证抓到的缺陷（均已修）

- **`${gatewayBaseUrl()}/channel/sessions` 双前缀 404**——`gatewayBaseUrl()` 本身已含 `/channel`。后果被两层设计静默吞掉（catch → 退避、"stay badge-less"），症状是**徽标永远不出现且日志无声**。单测全绿（fetch 根本没跑），**真浏览器 e2e 第一次跑就抓到**。已补单测钉死 URL + 首次失败 `console.warn`。
- **并发 `save()` 争用同一个固定临时文件名**——本轮把 `persistSessionMap()` 从「建/删 session 时才调」变成「每条消息都调」，把一个理论上的窄竞态变成常态：两个聊天同时来消息 → 两个 `save()` 同写 `session-map.json.tmp` → 可能把半写入的 JSON rename 成正式文件 → 下次启动解析失败走 corrupt 分支静默清空，**四个渠道的绑定一起丢**。⇒ 唯一临时名（pid + 序号）+ 写入串行化。
- **`lastActiveAt` 漏掉 question 应答路径**——回答走 early-return，从不刷新时钟。见 D6.2。
- **两个测试在撒谎**（都靠 A/B 抓出）：① `vi.stubEnv` **不会被 `restoreAllMocks()` 清理**，「阈值设 0」那条测试把 env 泄漏给了后面所有测试，`/resume` 用例因此根本没发生轮转却以「看似合理」的方式失败；② 「question 挂起时不轮转」那条测试**撤掉护栏仍然全绿**——因为 question 消息在 `pendingQuestion` 分支就被当作答案 early-return 了，**根本走不到轮转判定**，护栏在那条路径上是死代码。真正需要护栏的是「普通 turn 在飞」，测试已重写对准该场景（A/B 验证通过）。
