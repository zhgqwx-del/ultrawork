# ADR-050 — IM 渠道输出净化与 agent 反问

> 状态：**已实施**（2026-07-12，分支 `feat/im-channel-output-and-question`）
> 关联：ADR-013（gateway sidecar）· ADR-014（Bridge 形态：chatId→session + 队列 + SSE）· ADR-044（IM 扫码接入，其 D5 已把 permission 自动放行列为 known issue）· ADR-005（桌面端 Permission/Question Dock）· discussions/033（调研 + 方案 + 拍板）
> 范围：`packages/channel/gateway/`。桌面端只经 HTTP :4097 与 gateway 通信、不引用其源码，**renderer 零改动**。

---

## 背景

四张真机截图（微信 / 企微 / 飞书 / 钉钉）暴露三个问题：IM 上收到的回复里夹着模型的**英文思考过程**和**被回显的用户原话**；每轮固定先来一条「⏳ 收到，正在处理」，然后长时间静默、最后一次性甩出全文；agent 的反问在 IM 上从未出现过。

前两个是 bug。第三个的真相比"不支持"更糟：**gateway 一直在替用户回答** —— permission 无条件放行、question 无条件拒绝。而 vendor 侧 reject 等于「用户驳回了这个问题」，所以 **agent 一旦反问，在 IM 上就等于任务直接失败**。

## 决策

### D1 — 出站文本只收「assistant 的 text part」，用白名单而非类型判断

opencode 的 `message.part.delta` 事件**不携带 part 类型**，而 processor 对 `reasoning-delta` 与 `text-delta` 用的是**同一个 `field: "text"`**（`processor.ts:139` / `:335`）。仅按 `field` 过滤，永远分不开二者。

⇒ 订阅 `message.updated` 记下 assistant 的 messageID（它一定早于自己的 part，`prompt.ts:565`），并由 `message.part.updated` 的全量事件学习 `partID → type`，两条累积路径都只接受「属于 assistant 且已知为 text」的内容。这同时干掉了 user 原话回显（opencode 会无条件广播用户自己的 part，`prompt.ts:1300`）和 opencode 注入的 `synthetic` part。

**配套（否则修复本身会造成新故障）**：
- idle 兜底定时器改为由**任何** part 活动重置（含 reasoning / tool）。过滤后长思考期间没有 text part，沿用旧写法会让 180s 兜底在模型还在想的时候强发一个空回合。
- 补一条空回合提示。过滤前 `textParts` 总是至少含被回显的用户原话，空回复不可能发生；现在真会出现只有 reasoning / 工具调用的回合，静默会被读成"机器人不理人"。

### D2 — question 转发给用户，并引入「挂起等待」会话态

问题渲染成**编号列表**发到渠道（四家都拿不到按钮通道，这是按钮 bot 在无富 UI 渠道上的同一种降级），用户回数字或直接打字，`/skip` 可拒答。

**question 阻塞在工具执行内部**（`tool/question.ts:12`），因此 session 全程保持 `busy` 且**完全不发事件**（真 opencode 实测：195 秒静默、零 status、零 part）。而 bridge 的每一个超时机制都把"静默"当作"卡住"，所以挂起态必须同时做三件事，缺一即挂：

1. **暂停 180s idle 兜底**（它由 part 更新重置，待答期间没有 part）；轮询的 5 分钟寿命同样豁免。
2. **用户的下一条消息优先路由到 question**，不走 `promptAsync`；解析失败也只能重问，不能落回 prompt。
3. **30 分钟未答自动拒绝**并告知用户 —— 否则一个走开的人会把 agent 永久钉死在工具里。

数字答案的语义有一处刻意选择：**越界数字当作自由文本，而不是"序号错误"**。模型设不了 `custom=false`（`QuestionTool` omit 掉了该字段），所以"预算 80 万"里的 `80` 是答案不是笔误；报错重问会让用户陷入死循环。

### D3 — 分段推送（BlockChunker），不做"编辑同一条消息"

四个 adapter 都无法编辑已发消息（接口是 `sendMessage(chatId, content)`，**不返回消息句柄**）。所以渐进输出只能是"把写完的段落作为新消息陆续发出"——**腾讯官方自己的微信 bot 就是这么做的**（capabilities 里明写 `blockStreaming: true`，攒够 200 字符或空闲 3 秒发一条）。

段落边界切块、代码围栏内不切、**每轮中间块封顶 6 条**。封顶不是保守而是必需：企微单会话 30 条/分，而四个 adapter 的发送路径零节流。

**chunker 不能对拼接文本取绝对下标**：opencode 的 `text-end` 会重写一个已经发布过的 part（`trimEnd()` + `experimental.text.complete` 插件），使它变短、后面的 part 整体左移 —— 绝对偏移会**吃掉下一个 part 的开头**（实测 `SECOND` → `COND`）。改为记住已发文本并按公共前缀重新对齐。

### D4 — ack 条件化：延迟 2.5 秒，有真实输出就取消

「⏳ 收到，正在处理」当初存在的唯一理由是长回合期间 IM 侧完全静默。现在首块很快到达，秒回的问题再收一条"正在处理"纯属噪音。

**实测数据**：首个可见输出到达 3.8~5.0 秒。2.5 秒意味着常规问答**仍会先收到 ack**；提到 6 秒才能让它在常规问答里消失，但慢回合前 6 秒将完全无反馈。**权衡后保持 2.5 秒**（用户拍板）。

### D5 — permission 维持现状（自动放行），留到 P2

**这不是偷懒，是一个硬约束**：permission 只在规则为 `ask` 时才产生 `permission.asked` 事件 —— 不让 opencode 对 IM 会话产生 ask，危险工具会**直接执行**，gateway 连拦截点都没有。而 opencode **没有 per-session 权限入口**：`PATCH /session/:id` 只接受 `title` / `time.archived`；`prompt` 的 `tools` 参数虽会落成 session 级 ruleset（`prompt.ts:1313`），但只映射 `allow` / `deny` —— **唯独没有 `ask`**。

⇒ 只有两条路：**vendor patch**（扩展 `PATCH /session/:id` 接受 ruleset，只影响 IM、桌面零感知）或**改全局 config**（桌面端也会跟着弹 dock）。而真要"问"用户，就需要 `Allow once / Always / Deny` 三按钮 —— 那正是 P2 改 `ChannelAdapter`（引入消息句柄 + 交互能力）才能做的事。与其现在用编号列表凑合、P2 再重做，不如合并。

**P2 落地时的白名单已定**：自动放行 `read` `glob` `grep` `list` `codesearch` `lsp` `todowrite`；其余（`bash` `edit` `external_directory` `webfetch` `websearch` `skill` `task` `doom_loop`）必须问。`webfetch` 不放行是因为它能打任意 URL（内网 SSRF 面）。

### D6 — 群聊里只有被提问的人能回答

群聊的 chatId 是 `group:{conversationId}` —— **整个群共用一个 chatId、一个 session**。question 落地后，待答期间群里任何人的下一条消息都会被当成答案，包括无关闲聊。ctx 记住发起本轮的 senderId，非提问对象的消息回一句「正在等待 X 回答」而不是当成答案（也不能落回 `promptAsync`）。

---

## 一个被实验推翻的推断（值得记下）

对抗审查报告"用户答完题紧接着补一句 → `promptAsync` 撞 `BusyError` → 毁掉在飞的 turn"，并给了 mock 复现。

**实测推翻了它**：turn 进行中调 `prompt_async` **返回 204**，opencode 的 Runner 会**排队**。真正的机制是 `activeContexts.set()` **覆盖了在飞的 ctx** —— 新 ctx 的 `assistantMessageIds` 是空的，于是 turn 1 剩余的 part 全被当成"不是我们的"丢弃。**结论（会丢答案）一致，但机制和修法完全不同**：应当复用 ctx 让 opencode 排队，而不是拒绝新消息。

## 验证

- 单测 **231**（gateway 基线 187）；typecheck 8/8；全仓 11/11 task。
- **每条修复各做 A/B 反证**。A/B 脚本第一版因 ANSI 色码导致 grep 失配、把"撤掉修复后仍全绿"误报成通过；剥掉色码重跑才发现「question 待答期间不得重启 idle 兜底」这条**根本没有测试守护**，遂补上。
- 端到端（真 opencode 二进制 + 真 qwen + 真 Bridge + 假 adapter）**8/8**，深度修复后复验仍全过。
- **真机验收**（四渠道全连，桌面 app 跑 Tauri 装的 sidecar）：思考过程不再泄漏 ✓ · agent 反问走通一个来回 ✓ · 长文分段推送 ✓。所测二进制经 SHA 比对确认与构建产物**逐字节相同**（防"测了旧副本"）。

## 已知边界

- **群聊抢答（D6）无真机证据**：有单测 + A/B 守护，但缺群环境，未真机验。
- **permission 仍是无条件自动放行**：任何能给机器人发消息的 IM 成员，都能让 agent 无确认地执行 bash/edit（见 D5，留到 P2）。
- **CRLF**：`BlockChunker` 按 `\n\n` 找段落边界。模型输出实质不产 `\r`，万一出现，降级为"本轮不分段、末尾一次性发"（fail-soft，不丢内容）。
- **P2（真流式卡片）未做**：飞书 CardKit / 企微 aibot `msgtype:stream` / 钉钉 AI 卡片都能做真流式（钉钉按帧计费），微信协议层不可编辑。详见 discussions/033 §2.2。
