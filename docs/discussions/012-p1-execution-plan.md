# 012 · P1 可执行方案 — IM 流式 / 持久记忆 / 多 Agent UI

> **状态**：讨论中（方案提案，未定论；落地前各项需评审，可能拆成独立 ADR）
> **日期**：2026-06-08
> **来源**：[011-architecture-comparison.md](./011-architecture-comparison.md) 第 5 节 P1。本文把 P1 三项展开为可执行方案。
> **范围**：方案文档，**不含任何代码改动**。所有 file:line 为现状定位，供实施时参考（实施前以当时代码为准）。
> **共同前置**：所有改动遵循 [quality-gates.md](../quality-gates.md)；typecheck `bun run --bun turbo run typecheck`；gateway 改后 `bun run build:gateway`，sidecar 改后重编译。

---

## TL;DR · 三项的最小可行切法

| 项 | MVP（低风险高回报，先做） | 后续增强 | 需产品决策点 |
|----|--------------------------|---------|------------|
| **P1-1 IM 流式** | 段落级「块流式」多条发送 + 代码块安全切分（钉钉/微信通用，不依赖编辑能力） | 钉钉 AI 卡片 send-and-edit 打字机预览（付费 API + 权限，配置开关） | 钉钉卡片流式是否值得引入计费成本 |
| **P1-2 持久记忆** | `opencode.json` 写 `instructions[]` 指向 `~/.ultrawork/{IDENTITY,SOUL,MEMORY}.md` + 前端编辑 UI（零 opencode 改动） | 会话结束自动抽取记忆 + per-turn 检索式记忆（`system` 字段） | 记忆是「用户级统一」还是「per-workspace」 |
| **P1-3 多 Agent UI** | Build/Plan 主 agent 切换器（能力已就绪，仅前端） | subagent（general/explore）过程可见（task 卡片懒加载子 session） | 是否需要自定义 subagent（当前无 Scout） |

> 建议实施顺序：**P1-3 MVP（最小）→ P1-2 MVP → P1-1 MVP**。理由：P1-3 MVP 纯前端、风险最低、用户可见收益立竿见影；P1-2 MVP 零 opencode 改动；P1-1 涉及 Gateway 时序重构，最重，放最后。

---

## P1-1 · IM 流式输出重构

### 目标
把 Gateway 当前「攒齐全文 → 一次性回复 + 20KB 硬截断 + 3min 空闲兜底」改为「**边生成边分段发送**」，消除长回合的体验断裂与截断。

### 现状与硬约束（来自 Gateway 深挖）
- 当前时序：`bridge.ts:119 processMessage` → `promptAsync`（:206）→ SSE 累积 `textParts`（`onPartDelta` :436 / `onPartUpdated` :423）→ 仅在 `session.status==idle`（:454）或 `IDLE_TIMEOUT_MS=180_000`（:225）触发 `flushAndReply`（:247-275），**整段一次发**。
- 关键常量：`MAX_REPLY_LENGTH=20_000`（bridge.ts:20）、`IDLE_TIMEOUT_MS=180_000`（:22）、每 chatId 串行队列（:102-112）。
- **渠道编辑能力（决定方案形态）**：
  - **微信 ilink：不能编辑已发消息**（`message_state` 固定 FINISH，协议无 edit 端点）。流式只能「多条分段发送」。
  - **钉钉：可编辑**——官方 AI 卡片 `streamingUpdate`（创建卡片实例 + 增量更新同一卡片，打字机效果），但需开通 3 项权限 + **每次更新一次付费 API**（成本 3-10×），且现有 `dingtalk-stream` SDK 仅用于收消息，需扩展卡片 API。
- `ChannelAdapter` 接口（types.ts:1-11）只有 `sendMessage`，回复靠 `IncomingMessage.reply` 闭包，**无 edit、无消息句柄**。

### 方案

#### MVP：段落级块流式（多条发送，两渠道通用）
不依赖编辑能力，对钉钉/微信都成立。核心是把「攒齐再发」改为「**到达安全断点就发一段**」。

借鉴 openclaw `EmbeddedBlockChunker`：
- **切分规则**：累积文本达到 `minChars`（建议 ~200）后，在**段落 > 句子 > 空白**边界切出一个 block 发送；`maxChars`（建议 ~1500，留余量给 IM 上限）强制切。
- **代码块安全**：维护 ``` ``` ``` 围栏配对状态，**在未闭合的 fence 内绝不切**（积压到 fence 闭合或 maxChars 时连同补全闭合再发）。复用/对齐 `wechat-adapter.ts:300-328 stripMarkdown` 已有的未闭合 ``` 处理。
- **节流**：按「时间 ≥ Nms 或 字符 ≥ minChars」双阈值合并 delta，避免一个 delta 发一条。
- **首条 ack 调整**：保留 `bridge.ts:138 "⏳ 收到"` 或在第一个 block 到达时省略（避免与正文重复）。

改动点：
1. 新增 `gateway/src/block-chunker.ts`：纯函数 `pushDelta(buffer, delta) → { blocks: string[], rest, fenceOpen }`，无副作用，**可单测**（对照 [testing.md](../testing.md)）。
2. `bridge.ts`：`SessionContext` 增 `sentCursor` / `pendingBuffer` / `fenceOpen` 状态；`onPartDelta`（:436）/`onPartUpdated`（:423）改为「累积 → 调 chunker → 有 block 则 `ctx.reply(block)`」；`flushAndReply`（:247）降级为「发送残余 buffer + 收尾」。
3. `IDLE_TIMEOUT_MS` 语义重定义：从「攒齐兜底」改为「flush 残余 buffer」；可缩短（如 30s）。
4. `MAX_REPLY_LENGTH`（:256）改为「单 block 上限」而非「整条上限」。
5. 串行队列（:102）保持——保证同一 chatId 的 block 顺序。

#### Phase 2（可选，需产品决策）：钉钉 AI 卡片打字机预览
仅钉钉，走 send-and-edit：
1. `ChannelAdapter` 扩展能力探测 + 流式原语：
   ```
   capabilities: { canEdit: boolean }
   beginStream?(chatId): Promise<StreamHandle>
   // StreamHandle.update(content, {isFull}) / finalize(content)
   ```
2. 钉钉实现 = createCard + `streamingUpdate`（节流更新，按字符/时间合并）；微信 `capabilities.canEdit=false`，Bridge 自动回落 MVP 多条发送。
3. Bridge 按 `capabilities.canEdit` 分流：能编辑走单卡片更新，不能则走多条 block。
4. **配置开关**（默认关）：因付费 API，需用户/产品显式开启。

### 任务拆解（MVP）
- [ ] `block-chunker.ts` + 单测（段落/句子/代码块/超长边界）
- [ ] `bridge.ts` SessionContext 状态扩展 + delta→block 改造
- [ ] idle/截断语义调整
- [ ] 钉钉 + 微信 端到端手测（含含代码块的长回复）
- [ ] `bun run build:gateway` + 回归

### 验收标准
- 长回复（>2000 字）在 IM 端分多段陆续到达，无 20KB 截断丢内容。
- 含 ``` 代码块的回复不出现「半个代码块」。
- 顺序正确、无重复 ack；微信不刷屏（block 数量受 minChars 控制）。

### 风险与回滚
- **微信刷屏**：minChars 调大；必要时微信侧只发「少量大段」甚至回退单条 finalize（保留开关）。
- **钉钉计费**（仅 Phase 2）：必须节流 + 开关 + 上限。
- **回滚**：MVP 是 Bridge 内部时序改造，保留旧 `flushAndReply` 路径做 feature flag 可一键回退。

### 工作量（粗估）
MVP ~1–2 天（chunker + bridge 改造 + 双渠道手测）；Phase 2 钉钉卡片 ~2–3 天（SDK 扩展 + 权限 + 计费验证）。

---

## P1-2 · Agent Workspace 持久记忆（IDENTITY / SOUL / MEMORY）

### 目标
让 agent 跨会话拥有稳定身份/人格与长期记忆——对标 hermes 的 SOUL/MEMORY/USER。落地 Part II 草案的最小子集。

### 现状与关键发现（来自记忆注入深挖）
- **重要澄清**：opencode **没有内置 SOUL/MEMORY/USER 这类「长期记忆机制」**。它只提供：① 把文件/字符串**原样拼进 system prompt 的注入管道**；② 单会话内的历史持久化 / compaction / summary。它**不会**自动抽取事实、去重、合并、跨会话召回——这些「记忆行为」需 Ultrawork 自建（即本项 Phase 2）。对标的 hermes/openclaw 才是真正内置了记忆机制（prefetch/sync/去重/用户画像）。下文的「注入挂载点」均指 ① 的管道，不是现成的记忆功能。
- opencode 的**注入管道（挂载点）功能齐全，但 Ultrawork 目前全部未用**：
  - 全局 `~/.config/ultrawork/AGENTS.md`（`instruction.ts:30`，零代码自动加载，但全局只认**一个**文件，命中即 break）。
  - `opencode.json` 的 `instructions[]`（`instruction.ts:144-159`）：支持 `~/` 展开、多文件、相对/绝对/URL。
  - prompt_async 的 **`system` 字符串字段**（per-message 追加，拼在 system 末尾，`prompt.ts` PromptInput / `llm.ts:109`）。
- **泄漏风险**：未设 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`，当全局 AGENTS.md 不存在时 `globalFiles()` 会 fallback 到 `~/.claude/CLAUDE.md`（`instruction.ts:32`）——开发者本机的 Ultrawork 项目 CLAUDE.md 可能被误注入。
- **必查**：Ultrawork 写 `~/.config/ultrawork/opencode.json` 现在**只写 `mcp` 字段**（`lib.rs:807-823`，原子写 `lib.rs:1139-1153`）。落地路径 1 前**必须确认该写函数是 merge 还是覆盖**——若覆盖会丢 instructions。
- workspace 机制：`x-opencode-directory`（client.ts:68-70）对应 opencode `Instance.directory`；放 workspace 目录下的 AGENTS.md 天然 per-workspace 生效。
- Part II 设想 connector-centric 注入，但 **connector 未实现**，落地成本高，本方案不依赖它。

### 方案

#### MVP：文件式记忆（路径 1 + 路径 2，零 opencode 改动）
1. **建用户级记忆文件**于 `~/.ultrawork/`：`IDENTITY.md`（身份）、`SOUL.md`（人格/风格/边界）、`MEMORY.md`（长期事实，追加）。
2. **挂载**：在 `~/.config/ultrawork/opencode.json` 增写 `instructions: ["~/.ultrawork/IDENTITY.md", "~/.ultrawork/SOUL.md", "~/.ultrawork/MEMORY.md"]`。
   - ⚠️ 先修 `lib.rs` 写逻辑为 **merge 保留既有字段**（否则与 mcp 字段互相覆盖）。
3. **堵泄漏**：无条件创建 `~/.config/ultrawork/AGENTS.md`（哪怕指向/汇总上面三者或留占位），使 `globalFiles()` 命中它而非 `~/.claude/CLAUDE.md`。或更稳妥：sidecar 启动设 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1`（`lib.rs:1444` 附近，与 `OPENCODE_APP_NAME` 并列）。
4. **前端编辑 UI**：在 Settings 增「Agent 身份/记忆」面板，读写这三个文件（经 Tauri 命令做 fs 读写，参考现有 `get_sidecar_credentials` 等命令模式）。

#### Phase 2：自动记忆抽取 + 检索式记忆
- **会话结束抽取**：会话 idle/结束时，调一次小模型把「值得记住的事实」抽出去重后 `appendMemory()` 到 `MEMORY.md`（对标 hermes `sync_all`）。可在前端 `use-session-messages` 的 finish 分支或新库触发。
- **per-turn 检索式记忆**：扩展 `promptAsync`（client.ts:295）支持 `system` 字段，发送前把「与当前问题相关的记忆片段」（可复用 Knowledge Sidecar 的检索）拼进 `system`。对标 hermes「`prefetch` → 包 `<memory-context>` fenced block 标注是回忆」。
- **缓存纪律**（对标 hermes，重要）：稳定内容（IDENTITY/SOUL）走 instructions 文件（system 前缀，缓存友好）；只有动态检索结果走 `system` 字段尾部；避免回合中途变更注入击穿 prompt cache。

### 任务拆解（MVP）
- [ ] 复查并改 `lib.rs` opencode.json 写为 merge（保留 mcp + 新增 instructions）
- [ ] 启动时确保三文件存在（不存在则建模板）+ 写 instructions
- [ ] 堵 `~/.claude/CLAUDE.md` 泄漏（建全局 AGENTS.md 或设 disable env）
- [ ] Tauri fs 读写命令 + Settings 编辑面板
- [ ] 端到端验证：编辑 SOUL.md → 新会话行为体现该人格

### 验收标准
- 新会话的 agent 行为体现 SOUL.md 设定（如自我介绍/风格）。
- 多 workspace 共享同一身份（用户级统一）。
- 确认 `~/.claude/CLAUDE.md` 不再被注入（看 instruction 加载日志或行为）。
- opencode.json 同时保留 mcp 与 instructions，重启不丢。

### 风险与回滚
- **token 成本**：instructions 每次进 system，SOUL 建议设软上限（Part II 提到 maxPromptLength ~2000）。
- **opencode.json 覆盖**：merge 逻辑务必先验证，否则破坏现有 MCP 配置（高风险，必须单测/手测）。
- **回滚**：删 instructions 字段即恢复；文件式方案无侵入。

### 工作量（粗估）
MVP ~2 天（lib.rs merge 改造最需谨慎 + Settings UI）；Phase 2 ~3–4 天（抽取逻辑 + 检索注入 + 缓存验证）。

---

## P1-3 · 在 UI 暴露 opencode 多 Agent 能力

### 目标
把 opencode 已就绪、但前端「藏起来」的多 agent 能力呈现给用户：① **Build/Plan 主 agent 切换**；② **subagent（general/explore）执行过程可见**。

### 现状与关键发现（来自多 agent UI 深挖）
- opencode 内置 agent（当前 pin `8e9e79d2`）：primary = **build/plan**（+ hidden compaction/title/summary）；subagent = **general/explore**。**没有 Scout**（011 里提到的 Scout 在当前版本不存在）。
- 切 Build/Plan = 换 `prompt_async` 的 `agent` 字段（消息级，缺省回退 build）。`promptAsync` **已支持 agent**（client.ts:299-301）。
- subagent 只能由主 agent 经 `task` 工具委派（`tool/task.ts:29`），跑在 **child session**（`parentID`，task.ts:75-103），结果以 `<task_result>` 回父 session。
- 前端现状：
  - `sendMessage` **只传 model 不传 agent**（use-session-messages.ts:554）。
  - `getAgents()` 存在（client.ts:289）但**无任何调用方**，无 agent-selector / agent-context。
  - 前端 `Agent` 类型**已漂移**（types.ts:285-291 有不存在的 `id`、缺 `mode`/`hidden`）——**必须先修**才能区分 primary/subagent。
  - child session SSE 事件**其实会到达前端**（全局事件流），但被 `use-session-messages.ts:252,342` 按 sessionId **主动丢弃**——所以 subagent 过程当前完全不可见。
  - `task` 工具在主对话渲染为**通用 tool 卡片**（execution-flow.tsx:297 → tool-call-block.tsx，无 task 专用分支），其输出 metadata 含子 `sessionId`（task.ts:158-161）但前端未用。
  - 侧边栏已正确过滤 child session（`roots:true`，use-sessions.ts:48）——**无需改**。
- 输入区 `ChatInput.leftSlot` 现放 `ModelSelector`（Session.tsx:182），是 agent-selector 的天然落点。

### 方案

#### MVP：Build/Plan 切换器（纯前端，低风险高可见）
1. **修类型**：`types.ts:285-291` 的 `Agent` 对齐 server schema（加 `mode`/`hidden`/`description`，`model` 改对象，去 `id`，用 `name` 作 key）。
2. **agent 列表 hook**：仿 `useModel`/model-context 新增 `useAgents`，调 `getAgents()`（client.ts:289），过滤 `mode !== "subagent" && !hidden` → 得 build/plan。
3. **selector 组件**：`agent-selector.tsx`，挂到 `ChatInput.leftSlot`（Session.tsx:182，与 ModelSelector 并列）。维护「当前 agent」状态（新 context 或并入现有）。
4. **传参**：`sendMessage` 签名（use-session-messages.ts:523）加 agent，:554 透传 `{ model, agent }`（client 侧已支持）。
5. **UI 文案**：明确「切换=换模式（Plan 只读/Build 可写），影响下一条消息」，避免误解为新会话。

#### Phase 2：subagent 过程可见（task 卡片 → 子 session）
1. **task 卡片专用渲染**：`tool-call-block.tsx` 加 `tool==="task"` 分支，从 input/metadata 取 `subagent_type`/`description`/子 `sessionId`，渲染为「🤖 委派 @explore：<描述>」可展开卡片。
2. **子内容获取**（二选一）：
   - **懒加载（MVP 友好，推荐先做）**：展开 task 卡片时 `getMessages(childSessionId)` 拉子 session 历史渲染。复杂度低、非实时。
   - **实时归属（复杂）**：放宽 use-session-messages.ts:252/342 的过滤，建「子 sessionID → 父 task part」映射，把子 session SSE 内联到卡片。需处理一步多 task 并行。
3. `Session` 类型补 `parentID`（types.ts:166）若需父子关联。

### 任务拆解
**MVP（Build/Plan）**
- [ ] 修 `types.ts` Agent 类型对齐 server
- [ ] `useAgents` hook + agent 状态 context
- [ ] `agent-selector.tsx` 挂 leftSlot
- [ ] sendMessage 传 agent + 文案
- [ ] 手测：Plan 模式只读（编辑被拒）、Build 正常、同会话可切

**Phase 2（subagent 可见）**
- [ ] task 卡片专用渲染（识别 + 展示 subagent/描述）
- [ ] 懒加载子 session 历史
- [ ] （可选）实时归属

### 验收标准
- 输入区可切 Build/Plan，切换即时影响下一条消息；Plan 下编辑类操作被拒。
- （Phase 2）主 agent 委派 explore/general 时，主对话出现可展开的 task 卡片，能看到子 agent 做了什么。

### 风险与难点
- **类型漂移必须先修**，否则 mode 区分失败（阻塞项）。
- **信息密度**（Phase 2）：subagent 步骤多，必须折叠在卡片内，默认不展开。
- **实时归属复杂度**（Phase 2）：一步可并行多 task，子 session 事件归属需映射——故 MVP 用懒加载规避。
- **无 Scout**：若产品需要更多 subagent 角色，需自定义 agent（放 `~/.config/ultrawork/agent/*.md`）或等 vendor 升级——属独立决策。

### 工作量（粗估）
MVP（Build/Plan）~1 天（纯前端）；Phase 2（subagent 可见）懒加载 ~1–2 天，实时归属另 ~2–3 天。

---

## 待决策清单（需产品/团队拍板）

1. **P1-1**：钉钉 AI 卡片打字机预览是否值得引入付费 API？（MVP 多条发送已可用，Phase 2 是体验升级但有成本）
2. **P1-2**：记忆是「用户级统一」（Part II 倾向）还是允许 per-workspace 覆盖？影响文件布局与挂载方式。
3. **P1-2**：堵 `~/.claude/CLAUDE.md` 泄漏用「建全局 AGENTS.md」还是「设 `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`」？建议后者更彻底。
4. **P1-3**：是否需要超出 build/plan/general/explore 的自定义 agent（如 Scout）？
5. **整体顺序**：建议 P1-3 MVP → P1-2 MVP → P1-1 MVP（按风险递增）；是否认可？

## 信息缺口
- 钉钉 `streamingUpdate` 精确请求体字段、`dingtalk-stream` SDK 是否内置卡片辅助方法——落地前需对照官方 SDK 实测。
- `lib.rs` opencode.json 写逻辑是 merge 还是覆盖——P1-2 落地前**必须复查 `lib.rs:1139-1153` 附近**。
- 各项工作量为粗估，未含联调/边界打磨。

### 来源
现状事实来自本仓库代码深挖（Gateway `bridge.ts`/adapters、`vendor/opencode` instruction/prompt/agent/task 模块、前端 use-session-messages/api-client、`lib.rs`）+ 钉钉/微信官方文档；对标设计来自 [011](./011-architecture-comparison.md)。具体 file:line 见正文。
