# 踩坑清单 (Gotchas)

<!-- last-synced: 2026-08-03 -->

> 本文件是 Ultrawork 开发中**实测确认的坑点与非显然契约**的权威清单（SSOT）。
> 与 [`conventions.md`](./conventions.md) 的分工：conventions = "应该怎么做"（正向模式）；gotchas = "别踩什么"（反向陷阱 + 上游/平台的非直觉行为）。
> 来源：从开发过程的本地工作记忆固化而来，确保团队/AI 协作者 clone 仓库即可获得这些经验，而非重复踩坑。
> 新增坑点流程：开发中先记入 auto-memory 的 staging 区，"收尾"时判定为"稳定+团队需要"的固化到此处（详见 [`CLAUDE.md`](../CLAUDE.md) 收尾流程）。

---

## 1. OpenCode API 类型契约（与直觉不符）

调用 OpenCode API / 处理 SSE 时，以下字段结构是**实测确认**的，与命名直觉不同。端点完整清单见 [`api-reference.md`](./api-reference.md)。

- **PartBase**：每个 MessagePart 都带 `id`、`sessionID`、`messageID` 字段。
- **ToolState**：是**嵌套的可辨识联合**（`{ status: "pending"|"running"|"completed"|"error", ... }`），**不是字符串**。
- **PatchPart**：`{ hash, files: string[] }` —— 不是 `{ path, content, operations }`。
- **FilePart**：`{ mime, url, filename? }` —— 不是 `{ mediaType, path }`。
- **StepFinishPart.tokens**：包含 `cache: { read, write }`。
- **SendMessageRequest.parts**：简单的 `{ type, text? }[]`（**不带** PartBase 字段）。
- **prompt_async model override**：`model` 字段是 `{ providerID: string, modelID: string }` **对象**（不是字符串）；客户端从 `"provider/model"` 字符串解析。
- **SSE 事件**：`message.part.updated`（完整 part upsert）/ `message.part.delta`（按 partID+field 增量 append）/ `message.updated` / `message.part.removed`。
- **SSE 阻塞事件**：`permission.asked`、`question.asked` —— properties 直接是请求对象本身（**不嵌套**）。
- **Permission API**：`POST /permission/{id}/reply` body 为 `{ reply: "once"|"always"|"reject" }`。
- **Question API**：`POST /question/{id}/reply` body 为 `{ answers: string[][] }`；`POST /question/{id}/reject`。
- **构建顺序**：改了 `api-client` 的类型后，必须先在 api-client 里 `tsc --build`，再 typecheck client（否则 client 读到旧 `.d.ts`）。
- **出错回合的消息形状 = `finish` 留 `undefined` + `info.error` 有值 + `parts` 常为空（2026-06-13 真机实测）**：assistant 回合因 provider 报错终止（APIError / 内容审核 / 网络失败）时，opencode 不写 `finish`，而把错误落到 **`info.error`**（形状 `{name, data:{message}}`，也可能是字符串），并带 `time.completed`。**`error` 本身就是终态信号**——前端判「回合是否结束」**不能只看 `finish`**（`finish===undefined` ≠ 仍在流式），否则历史/重开会话里出错回合会**永久转圈**（`info.error` 经 REST `GET /session/:id/message` 与 SSE 均透传；`MessageInfo.error` 已补类型）。终态判定见 `message-list.ts isTurnTerminal`、渲染见 [conventions §5](./conventions.md)。**区分**：消息级 `info.error`=回合终止；工具级 `part.state.status==="error"`=单工具失败、agent 照常继续，**不**算回合终态。
- **qwen/DashScope 内容审核会 400 终结回合（`data_inspection_failed`，2026-06-13 真机）**：qwen 系模型对敏感输入（实测「政治新闻调研」）直接返回 HTTP 400 `{code:"data_inspection_failed", message:"Input data may contain inappropriate content"}` 且 **`isRetryable:false`**——回合不可重试、即时终止，落成上一条所述的 `info.error` 消息。属上游 API 行为非本项目缺陷；前端需当终态渲染为错误态（已修）。
- **`finish:"tool-calls"` 只封板「步」不结束「回合」，前端不可据此清 `sending`（2026-06-14 修，避免「步间假完成」）**：opencode 一个用户回合 = N 条 assistant message，每个工具 step 完成时发 `message.updated` 带 **`finish:"tool-calls"`**——这是「循环继续、下一步在路上」的信号，**不是**回合结束。`use-session-messages` 的 `message.updated` 处理**只能在 `finish && finish !== "tool-calls"` 时 `setSending(false)`**；否则步与步之间（尤其模型首 token 慢、可达数十秒的间隙）`sending` 被提前打 false → `sessionActive` 掉下去 → `isTurnStreaming` 兜底返回 false → 回合**短暂渲染成「已完成」**（绿对勾 + 执行流程自动折叠 + 统计页脚），下一步流式又翻回去，产生「以为完成了」的突变感。**这是 2026-06-13 给 `isTurnStreaming` 加 `sessionActive` 门控（修永久转圈）后暴露的耦合**：兜底从此依赖 `sending`，故必须保证 `sending` 在整个回合内（含所有 `tool-calls` 步间）保持 true。回合真正结束由答案 step 的非 `tool-calls` finish（如 `stop`）+ `session.status:idle`（opencode）/ 终态 finish 补 `markSessionIdle`（ACP，无 sessionStatus）兜住，移除 `tool-calls` 那次 `setSending(false)` 不会导致 sending 卡死。终态/流式判定见 [conventions §5](./conventions.md)。
- **Home→Session 乐观发送的 8s 安全定时器会在回合中途强清 `sending`，是「持续假完成」的主因（2026-06-14 real-DOM 走查 + 时序定位实证）**：从首页发消息会带 `initialSending` 跳到会话页，`use-session-messages` 起一个 **8s 定时器**兜底「这次发送根本没产生回合」。但它**无条件**在 8s 后 `setSending(false)`——**任何超过 8s 的真实回合**（研究类轻松 40s+）到 8s 就被强制清 `sending` → `sessionActive` 掉 → 此后每个「模型思考间隙」（首 token 慢、工具间）都渲染成假完成（绿勾+折叠执行流程+统计页脚）。这解释了为何截图里 14s/32s/51s（均 >8s）都在闪假完成，而短回合（<8s）/前述 `tool-calls`·拖尾两处机制都看不全这个。**修复**：把定时器存 `navSafetyTimerRef`，SSE 收到**第一条 `message.*` 活动**即 `clearTimeout` 取消（回合已确证存活）；只保留「发送从未产生回合」时 8s 仍兜底清理的原意。**走查铁律补充**：复现这类必须让回合**跨过 8s**（短回合测不出！），用强制多工具 prompt（实测 4 次 read ≈ 10–12s）即可稳定越过阈值。
- **opencode 在终态 `finish` 前后会发"拖尾/重复"SSE，导致 `isStreaming` 在回合末抖动数百 ms（2026-06-14 真机 SSE 抓包 + real-DOM 走查实证）**：答案 step 的 `finish:"stop"` 前后实测会出现**重复的 `message.updated finish=stop`**，以及**晚到的 `message.part.updated/delta`**（晚到的 part 会把 `streamingMessageId` 重新置上 → `containsStreaming` 真 → 已终态回合又被判成流式）。结果即使修了上面的 `sending` bug，回合末仍会 done→spinner→done 闪一下（~0.3s），瞬间渲染绿勾+折叠执行流程+统计页脚=「假完成」。**根因在上游 SSE 顺序不可靠，前端难逐事件消除**，故用**去抖**收口：`assistant-turn.tsx useStableStreaming(isStreaming, SETTLE_MS=600)`——上升沿（true）立即生效，下降沿（false）需连续 false 满 600ms 才落定，中途回弹即取消。"完成"类视觉（footer / `ExecutionFlow` 折叠 / typing dots）一律用去抖后的值，**时长/token 计算仍用原始值**（数字不是外观）。历史回合初值即 false→立即落定无 600ms 闪。**走查铁律**：验证此类必须采样 DOM 的**展开/折叠态**（`flowOpen`，rail body `ml-[7px].border-l` 是否在），只看 header 图标 spinner/done 会漏掉"isStreaming 仍 true 但已折叠"或回合末抖动；且步间间隙要够长（模型首 token 慢）才采得到。
- **产物识别只看「工具意图」会漏真产物（2026-06-15，ADR-033）**：`artifacts-panel`/`delegate.ts` 旧逻辑只从 `write/edit/create/patch` 工具 input 的路径参数（+ delegate D-2 JSON + 文本正则）提产物。但**最终产物常是 `bash` 跑脚本的副作用**（agent `write` 一个 `.py` → `bash python x.py` 生成 `report.pdf`）：bash 产物没有工具路径参数 → **完全识别不到**；那个 `.py` 反而因被 `write` 写过而冒充产物。**正解 = 文件系统真相（仅桌面端）**：扫会话目录里 **mtime ≥ 回合基线**的文件并入产物（桌面 Tauri `scan_workspace_changes` 返回 `{path, mtimeMs}`，基线 = 会话最早消息 `time.created`、仅 agent 空闲时扫）。忽略 `.git/node_modules/__pycache__/*.pyc/隐藏/temp`，**限深度 8 + 匹配 500 + 访问 50000 项**（大工作区里匹配稀疏会强制全树遍历，每项一次 stat，故须有访问上限），命令 **`async`** 跑在非 UI 线程（大目录别卡 webview）。再用扩展名分「产物 / 工作文件」两组（工作文件=脚本/代码/配置白名单，其余皆产物；无产物时工作文件提升），避免 `.py` 等冒充。**基线为 0（消息无 time）时不扫**——否则 `since=0` 会把工作区里所有既存文件当产物。**编排侧 `collectDeliverable` 刻意不做 fs 扫描**（见 §9）——D-2 `artifacts[]` 只取子会话自己的 write/edit 工具路径。
- **多个会话共用一个工作区时，mtime 扫描会「串会话」——必须按本会话的回合时间窗过滤（2026-06-16 真机踩到）**：`mtime ≥ 会话起点` 不足以归属——同一工作区下的会话 A/B/C 各自产物的 mtime 互相落在对方的 `[起点, now]` 区间内，于是 A 的产物区会显示 B、C 的文件。**正解**：`sessionTurnWindows(messages, active)` 算出本会话**实际在跑回合**的时间窗（user 消息开窗 → 该回合最后一条 assistant `time.completed`(+5s grace) 关窗；最后一回合在 active 时开放到 `Infinity`；回合间的 idle 间隙不在任何窗内），`filterScanByWindows` 只保留 mtime 落在某个窗内的扫描文件。别人会话在它自己回合里写的文件落在它自己的窗、不在本会话的窗 → 不再串。纯 mtime 上下界（span）也不够：会漏掉「本会话 idle 期间别的会话写文件」的串扰，必须按**回合**切窗。
- **opencode `GET /file/content` 对 PDF/二进制返回空 content，前端必须自行判型（2026-06-15）**：后端 `file/index.ts` 的 binary 集合含 `pdf`/`doc(x)`/`xls(x)`/`ppt(x)` 等 → 这些类型 `getFileContent` 返回 `{type:"binary", content:""}`（**图片例外**：返回 base64）。前端 `isBinaryFile`（`file-icon.tsx BINARY_EXTS`）**故意不含 pdf**——pdf 走 `pdf-view.tsx` 用 `pdfjs-dist` 自己读字节渲染（见下条），不依赖后端 content；若把 pdf 误当文本去拉 content 就会拿到空串、渲成「无内容」空白（这正是修复前的 bug）。Office 类仍留在 `BINARY_EXTS` → 走 `BinaryFileCard`「用系统应用打开」（无内嵌渲染器，刻意）。
- **`PATCH /config` 是 per-(instance)-directory + 只增改不删 key（2026-06-19，自定义 provider 实测）**：① **作用域 per-workspace**——`Config.update` 写 `<x-opencode-directory>/opencode.json`（实例目录），不是 global `~/.config/ultrawork/`。api-client 自带 `x-opencode-directory = workingDirectory`（`buildHeaders`），**前提是 `workingDirectory` 非空**；为空时请求命中漂移的默认实例 → provider/config 时隐时现、`getModel` 抛 `ProviderModelNotFoundError`、config 偶不落盘。故配置类入口（自定义 provider 等）**无活动工作区时应禁用**。② **`PATCH` 走 `mergeDeep`，只能增/改 key、删不掉**——`{provider:{id:null}}` 被 schema 拒 400；删自定义 provider 用 `disabled_providers:[id]`（数组，merge 时整体替换）隐藏 + `DELETE /auth/:id` 清 key，**config 里的 `provider.<id>` 物理残留**。③ 残留导致**幽灵子项**：删→同 id 重加且 `models` 更少时，旧 model 因深合并存活；**用 `provider.<id>.whitelist=[当前 model id]` 过滤**（vendor `provider.ts` 据 whitelist 删除未列出模型；数组 merge 即替换）。④ 自定义 provider 完整机制（OpenAI 兼容/Anthropic、auth.json 落 key、models.dev merge）见 [`discussions/006`](./discussions/006-custom-llm-provider.md)。
- **config `provider.<id>.models.<modelId>` 原生接受完整 models.dev Model schema，自定义 provider 配「每模型参数」零改 vendor（2026-06-22 逐行核验 + headless 实证）**：config schema 用 `ModelsDev.Model.partial()`（`config.ts:808`），故一个 model 条目可写的远不止 id/name/limit——还有 `tool_call`/`reasoning`/`attachment`/`temperature`（能力 bool）、`modalities:{input[],output[]}`、`cost`、`headers`、`options`、`variants` 等全字段。**消费端均生效非死字段**：`provider.ts fromModelsDevModel`（:912-957）读 `headers`/`options`/`modalities`→capabilities/各能力位；**model 级 `options` 经 `session/llm.ts:139 mergeDeep(input.model.options)` 注入调用时 AI SDK `providerOptions`**（如 `{reasoningEffort:"high"}`）。schema 是 **non-strict**（Zod 默认 strip）→ 未知 key **静默丢弃不报错**，容错好但写错 key（`tool_calls`/`limt`）不会被后端拒、只是被无视。**含义：自定义 provider 暴露「高级 JSON」逃逸口即可让用户配全部 model 字段，无需任何 vendor patch。**
- **写自定义 model 时 `models[mapKey].id` 必须 == mapKey（否则 opencode 解析/whitelist 失配）**：opencode 按 **map key** 注册/解析模型，若让「高级 JSON」覆盖内层 `id` 使其 ≠ map key（也 ≠ `whitelist` 项），会得到一个选不中/对不上的幽灵模型。api-client `upsertCustomProvider` 深合并 advanced 后**强制 `id` 回 map key**（`name` 可改、无害）。
- **LLM 流式回复会「静默挂死」，AI SDK 无空闲超时——vendor patch 加了工具感知两级 idle guard（2026-06-24，ADR-034，真机+headless 实证）**：某些自定义 provider（实测 `alibaba-cn/qwen3.5-plus`）的 SSE 流会在**发完 reasoning、正文 block 刚开**处静默 stall——连接既不再发 chunk、也不发结束帧、也不报错（TCP 挂着）。AI SDK v6 `streamText` 只有 `abortSignal`、**无任何 idle/stall 超时**，于是 `fullStream` 异步迭代器永远不 yield 也不 throw → `session/processor.ts` 的 `Stream.runDrain` 协程永久挂起 → **该回合永不收尾、session 忙锁不释放 → 后续 prompt 全部排队卡死**（前端表现：永久转圈 + 重试无反应）。**注意这与上面两条出错回合不同**：既无 `finish` 也无 `info.error`（text part 只有 `time.start` 无 end、tokens 全 0），既有的终态判定都兜不住。**修复 = `session/llm.ts` 的 `idleGuard`**（vendor patch，包在 `result.fullStream` 外）：① **两级超时**——首 token 前 `STREAM_TTFB_TIMEOUT_MS`（默认 90s，容忍 prefill/冷启动/reasoning 静默思考），首个 `text-delta`/`reasoning-delta` 后降到 `STREAM_IDLE_TIMEOUT_MS`（默认 30s，流动中 chunk 是亚秒级、stall 快报错）；②**工具感知**——工具在 stream 内部执行（`tool-call`→`tool-result`/`tool-error` 间 `fullStream` 静默），用 `Set<toolCallId>` 跟踪在飞工具，**有工具在跑时撤销看门狗**（长 bash/webfetch/30min delegate 不被误杀；布尔会被并行工具的首个 result 过早重置，故必须用 Set）；③ 触发时 `ctrl.abort()`（断挂死的 fetch、释放连接）+ 抛 plain Error → 经 `SessionRetry.policy`（plain Error 判**不可重试**）→ `Effect.catch(halt)` → 落 `info.error = "LLM stream idle for Nms"`（**终态、解锁、可重试**）；④ finally 里 `it.return()` 必须 **fire-and-forget**（wedged read 可能让 `await` 永挂、反吞掉错误）。env 旋钮 `OPENCODE_STREAM_TTFB_TIMEOUT_MS`/`OPENCODE_STREAM_IDLE_TIMEOUT_MS`。**每个 opencode step 是独立 streamText/idleGuard**（`prompt.ts:1344` 外层 while 每轮 `handle.process`）→ 多 step 回合的工具后首字天然在新 step 重获 TTFB（无需跨 step 状态）。headless 复现配方见 [testing.md](./testing.md)。**⚠️ 该 guard 的「流动中 30s」假设在工具参数相位上不成立，被 ADR-049 修订，见下条。**

- **qwen/DashScope 吐工具参数时会「憋一大段再一次性 flush」，静默 37~65s——这不是挂死，30s idle 杠会误杀（2026-07-11，ADR-049，直连 SSE 探针实证）**：DashScope 的 `compatible-mode` 在流式生成 **tool call 参数**时有两种模式：① **流式模式**——参数逐 `tool-input-delta` 吐出（实测 6~7 万字符的参数、3900+ chunk、最大间隔仅 5~8s）；② **缓冲模式**——先发 `tool_calls[0].function.name` + 几十字节参数前缀（如 `{"command": "`），然后**在服务端把整段参数憋完**，静默 **37~65 秒**后一次性 flush（实测 12/12 复现，且 **12/12 都会自行恢复并正常 `finish=tool_calls`**）。**模式与参数大小无关**（大参数反而更常走流式），触发条件未知、客户端观测不到。⇒ **「SSE 静默 30s」不能推定为挂死**。ADR-034 的 `idleGuard` 原本只在 `tool-call` 事件到达时才把 id 放进 `inflightTools` 撤防，而缓冲模式的停流恰恰发生在 `tool-call` **之前** ⇒ 用最紧的 30s 杠去量一个正常需要 40~60s 的窗口 ⇒ **必然误杀**，且参数越大（大 bash 脚本、大 write 文件）越必挂。**修复 = `idleGuard` 补第三相位**：`tool-input-start` 入 `pendingInputs` 集合、`tool-call` 出集并转入 `inflightTools`，该集合非空时用 `OPENCODE_STREAM_TOOL_INPUT_TIMEOUT_MS`（**默认 600s**，与 ACP 侧 `ACP_PROMPT_TOOL_SILENCE_MAX_MS` 对称）。**为什么是 600s 而不是「实测最大值×N」**：憋参数与真挂死在线上完全同构（都是零字节），时间上无法区分；误杀一次合法的 200s 参数生成 = 工作作废的硬故障，而真挂死多等几分钟只是慢（用户随时可点「停止」，已验证能中断停流中的回合）。
- **`Tool execution aborted` + `0ms` 不代表工具执行过（2026-07-11 排查踩坑）**：`session/processor.ts` 的 `cleanup()` 在回合失败时，把所有未完成的 tool part 一律改写成 `status:error / error:"Tool execution aborted"`，并**把 `time.start` 和 `time.end` 都重写成 `Date.now()`**（故显示 0ms）。它是「回合死时这个工具还没跑完」的**墓碑**，工具可能**根本没开始执行**。
- **DB 里 tool part 的 `input={}` / `raw=""` 无法区分「没收到参数」和「收到了一半参数」（2026-07-11 排查踩坑，差点据此下错结论）**：`processor.ts` 的 `case "tool-input-delta"` 是**空实现**（直接 `return`，从不累积 `raw`），参数只在 `tool-call` 事件到达时才被一次性写进 `state.input`。所以 stall 在参数流中途时，DB 看起来和「一个字节都没收到」完全一样。**排查流式相关问题不要只信 DB——它记不下中间态。**

- **websearch 是 BYOK 门控工具，"看不到搜索工具"大概率不是 bug 而是没配 key（2026-07-04，ADR-042）**：vendor patch 后 `websearch` 注册条件 = `experimental.websearch.enabled !== false` **且**（auth.json 有 `search-tavily`/`search-aliyun-iqs` key ‖ exa 显式 opt-in〔`exa:true` 或 `provider:"exa"`〕‖ 官方托管 provider/`OPENCODE_ENABLE_EXA`）。key 走 `PUT /auth/search-*`（每步现读零缓存，**配 key 无需任何刷新**）；开关/默认 provider 走 `PATCH /global/config?refresh=soft`。门控可用性检查在每步热路径上，读失败（撕裂/损坏 auth.json）会 **catch 降级为不注册**——绝不能改回裸 `Effect.promise`（拒绝=defect=杀整个回合）。`provider:"auto"` 是"清除显式选择"的哨兵值（mergeDeep 删不掉 key）。深度参数 config pin（`tavily.searchDepth`/`aliyunIqs.engineType`）**优先于**模型请求（防模型烧 advanced credit）。
- **阿里云 IQS key ≠ 百炼 DashScope key，且新建 IQS key 约 5 分钟后才生效（2026-07-04，ADR-042）**：IQS（信息查询服务「通晓」）的 API-Key 在 IQS 控制台单独创建（`https://iqs.console.aliyun.com/api-keys`），拿 DashScope key 调 `cloud-iqs.aliyuncs.com` 必 401；新 key 5 分钟内也 401——测试连接失败先等再判配错（UI 提示已带这句）。计费：试用 1000 次仅 15 天，之后按次；`engineType:"Generic"` 计费 ~3.5× LiteAdvanced；`contents.summary` 是付费增值项（我们不启用，免费 `snippet` 够用）。
- **qwen `enable_search` 只在「模型级」options 生效，且来源列表会被 AI SDK 丢弃（2026-07-04，ADR-042 实测链路）**：`provider.<id>.models.<modelId>.options.enable_search` 经 mergeDeep→providerOptions→spread 进请求体**顶层**（provider 级 options 是错误位置，进 SDK 构造器被丢弃）；流式路径下阿里返回的 `search_info.search_results` 引用来源被 AI SDK strict delta schema 丢弃 → 只有答案质量提升、**无来源展示**（要展示需 vendor `metadataExtractor` patch，未做）。**别把 `enable_search` 写给非 DashScope host**——严格的 OpenAI 兼容网关对未知 body 键直接 400（UI 的 DashScope-like 启发式与"读残留才发显式 false"都是为此）。
- **hook 注入的工具，execute 必须返回 opencode 工具结果形状 `{output,title,metadata}`，不能返回裸字符串（2026-06-26，ADR-036 渐进式工具披露 e2e 踩坑）**：通过 `experimental.chat.tools.transform` 钩子往 `tools` map 注入的 AI-SDK 工具（如 `tool_search`），其 execute 返回值经 `session/processor.ts:223` 读 **`value.output.output`** 落 `part.state.output`。若 execute 返回裸 `string`，`value.output.output` 为 `undefined` → `part.state.output` 为空 → **下一步 `toModelMessages` replay 时报 `Invalid prompt: messages do not match ModelMessage[] schema`，拖垮整个多步回合**。opencode 自己的内置/MCP 工具都返回 `{output,title,metadata,attachments?}`，照抄即可。**这类工具的状态不能跨步 evict**（若加 TTL/回落淘汰，绝不能淘汰 message 历史里仍有 tool-call 的工具，否则同样悬空 → schema 错）。

- **`message.part.delta` 事件不带 part 类型，且 reasoning 与正文用的是同一个 `field: "text"`（2026-07-12，ADR-050 实测）**：delta 的 schema 只有 `{sessionID, messageID, partID, field, delta}`（`message-v2.ts:486`），而 processor 对 `reasoning-delta`（`processor.ts:139`）和 `text-delta`（`:335`）**逐字相同地**发 `field: "text"`。⇒ **只按 field 名过滤，永远分不开思考过程和正文**。唯一可行的归属方式：由 `message.part.updated` 的全量事件学习 `partID → type`（`text-start` 发 `type:"text"`、`reasoning-start` 发 `type:"reasoning"`），delta 只对白名单里的 partID 累加。gateway 曾因此把模型的英文 CoT 逐字发到 IM 上。
- **opencode 会把「用户自己」的消息片段也广播成 `message.part.updated`，且包含它注入的 synthetic part（2026-07-12，ADR-050）**：`prompt.ts:1300` 无条件 `updatePart(part)`，`session/index.ts:483` 广播时不分 user/assistant。⇒ **凡是消费 part 事件的下游，必须按 `part.messageID` 判断归属**（订阅 `message.updated` 记下 `info.role === "assistant"` 的 messageID；它一定早于自己的 part，`prompt.ts:565`）。只看 `part.type === "text"` 会把用户原话当成回复内容。plan 模式提示、`"Summarize the task tool output above…"` 等 synthetic user part 同理。
- **`text-end` 会重写一个已经发布过的 text part，使它变短（2026-07-12，ADR-050 实测）**：`processor.ts` 的 `text-end` 分支做 `text = text.trimEnd()` 再经 `experimental.text.complete` 插件，然后**再发一次 `updatePart`**。⇒ **任何对「拼接后的全文」取绝对下标的消费者都会错位**：前面的 part 变短，后面的 part 整体左移，下标没跟着动就会吃掉后一段的开头（gateway 的分块器实测把 `SECOND` 吃成 `COND`）。要按「已消费文本 + 公共前缀」对齐，不能存 offset。
- **question 阻塞在工具执行内部 ⇒ session 全程 `busy` 且零事件（2026-07-12，ADR-050 真二进制实测 195 秒）**：`Question.ask` 在 `tool/question.ts:12` 里 await Deferred，`idle` 只在 Runner 排空（`prompt.ts:124`）或 error（`processor.ts:429`）时才发。⇒ 待答期间**没有 status、没有 part、什么都没有**。凡是把"静默"当作"卡住"的兜底机制（idle 看门狗、轮询寿命）在这里都会误杀，必须显式豁免。
- **turn 进行中再调 `prompt_async` 会返回 204 并排队，不是 BusyError（2026-07-12 实测，推翻了一个看起来很合理的推断）**：Runner 有队列语义。⇒ **不要为"并发 prompt"写拒绝逻辑**；真正的坑在消费侧——若你为每条消息新建一个上下文并覆盖旧的，在飞那一轮剩余的 part 会因 messageID 不在新集合里而被整个丢弃。
- **没有 per-session 的 `ask` 入口（2026-07-12，ADR-050 源码核验）**：`PATCH /session/:id` 只接受 `title` / `time.archived`（`server/routes/session.ts:263`）；`prompt` 的 `tools` 参数虽会落成 session 级 permission ruleset（`prompt.ts:1313`），但只映射 `allow`/`deny` ——**唯独没有 `ask`**（`Ruleset` schema 本身支持）。⇒ 想只给某类会话（如 IM）上锁而不动全局 config，**绕不开 vendor patch**。
- **`permission` 不配置 = 全部放行，不会弹授权框**（2026-07-11 实测）。`opencode.json` 的 `permission.{bash,edit,webfetch}` 全是 optional，缺省即 allow。**验证权限相关 UI（PermissionDock / 委派子权限中继）时必须显式配 `"permission": {"bash": "ask"}` 并重启 sidecar**，否则请求根本不会产生，会误判成「dock 坏了」。

- **多模态门控字段是 `capabilities.input.image` / `.pdf`，不是顶层 `attachment`（ADR-056 / discussions/039 §3.1，2026-07-15 实测）**：`GET /config/providers` 每个模型对象的 `capabilities` 同时有 `attachment`（粗粒度布尔）和 `input: { text, image, pdf, audio, video }`。opencode `provider/transform.ts:265` 的 `unsupportedParts()` 门控用的是 **`capabilities.input[modality]`**——用错字段（读 `attachment`）= 前端放行、后端把 image part 替换成 `ERROR: … does not support image input` 文本喂模型 ⇒ 模型莫名向用户道歉。发送前的能力门控必须读同一个字段。（附：用户默认的 myqwen provider 模型 0 个支持 image，alibaba-cn 有 20+ 个。）

## 2. OpenCode Server 运行时限制

- **`PATCH /config` 不影响运行时**：只写磁盘 `opencode.json`。运行时模型切换**必须**用 `prompt_async` 的 `model` 参数。
- **`POST /session/:id/prompt_async` 是唯一发送方式**，返回 204（无 body，调 `.json()` 前先判空）。
- **File API 路径必须相对** + 带 `x-opencode-directory` header。绝对路径会被 join 成错误路径。
- **工具参数统一 camelCase**：`filePath`（不是 `file_path`）。
- **Session 列表不按目录过滤**（事故实测 2026-06-10，**二次事故 2026-06-12**）：`x-opencode-directory` header 只设请求的工作目录上下文，**不过滤 `GET /session`**；按目录过滤必须用 `?directory=` query。前端侧栏的工作区过滤是客户端 `filterByWorkspace`。误以为 header 过滤两次导致全量误删会话（第二次：测试收尾清理循环只带 header 拉列表逐条 DELETE，删掉 ~110 条跨工作区会话）。**强制流程：批量删除必须 ①用 `?directory=` query 拉取 ②对每行响应里的 `directory` 字段二次断言 ③打印清单+数量人工核对后才执行 DELETE**——只「打印清单」不核对目录字段挡不住这个坑。
- **Permission 规则**：`general` agent 默认 `"*": "allow"`；要拦截需在 `opencode.json` 设 `"permission": { "edit": "ask" }`。
- **SQLite WAL disk I/O**：偶发 500；恢复手段 `PRAGMA wal_checkpoint(TRUNCATE)` + 重启。
- **会话 db 的 WAL 极脆弱（数据恢复实操教训，2026-06-10）**：`opencode-.db` 主文件可能长期不 checkpoint（实测停在两周前），近期数据全部只活在 `-wal` 里；**任何 sqlite3 直接打开（含只读查询和 `.recover`）都会触发 checkpoint 并清空 WAL 历史帧**，毁掉「截断 WAL 回滚到误操作前」的恢复路径。正确顺序：先 `cp -a` 整个目录（db+wal+shm 三件套），再在副本上一次性做 `.recover`；被删行可从 free pages 的 `lost_and_found` 按列前缀（ses_/msg_/prt_）重建。
- **Config.update 文件名 bug**：vendor 已 patch 修复（`config.json` → `opencode.json`），详见 auto-memory `vendor-patches.md`。
- **opencode 会 unlink「当前活动」日志文件——按文件名 `tail`/`ls`/`find` 找不到，调试日志要走 lsof（2026-06-26，渐进式工具披露真机验证踩坑）**：`util/log.ts` 启动时 `cleanup(Global.Path.log)` 会删旧日志，活动日志文件可能被 unlink（句柄仍开、`lsof` 看得到，但 `ls`/`find`/按名 `tail` 都不可见）。日志在 `~/.local/share/ultrawork/log/`：**dev 模式（从源码 `bun run ... serve`）写 `dev.log`；编译版 sidecar（app 拉起）写带时间戳的 `<ISO>.log`**——别盯错文件。真机看 app 的实时日志：`LOG=$(lsof -p $(lsof -nP -iTCP:4096 -sTCP:LISTEN|grep LISTEN|awk "{print \$2}"|head -1) | grep -oE "/Users/.*ultrawork.*\.log" | head -1)`，或直接看 UI「执行流程」面板（输入 token + 工具步）更可靠。

## 3. MCP

- **MCP local 必须用 `bunx --bun`**：用 `npx` 会 spawn 多层进程导致 stdio pipe 断裂、`Connection closed`。
- **MCP 启动连接超时 5s**：vendor patch 把启动握手 `CONNECT_TIMEOUT` 从 30s 拆到 5s（runtime tool 调用仍 30s）。坏 MCP 最多拖 5s（ADR-028）。
- **Browser MCP 用内嵌 Node.js v22**（`~/.ultrawork/node/`），不依赖系统 Node。
- **Browser MCP npm 调用**：必须用 `node npm-cli.js install ...`，**不能**直接调 `bin/npm`（symlink 相对路径会断裂）。
- **Playwright MCP 工具名前缀叠加**：注册名 `browser` + 工具名 `browser_take_screenshot` → 实际调用名是 `browser_browser_take_screenshot`。
- **Playwright 截图产物**：返回 base64 attachment；是否落盘取决于 AI 是否传 `path` 参数；temp 路径在 `/var/folders/.../playwright-mcp-output/`。
- **MCP 持久化**：服务配置存 `opencode.json`（已从 localStorage 迁移，Issue#18）；Browser MCP 全局配置存 `~/.config/ultrawork/opencode.json`，跨工作区自动恢复。
- **运行时 `POST /mcp` 是 per-directory instance 的**（2026-06-12 真机实测）：注册只对请求所带 `x-opencode-directory` 对应的 instance 生效——不带 header 注册到默认 instance，工作区会话**看不到**该工具。desktop ApiClient 自动带当前 workspace header → createMCP 即时生效仅限当前工作区，其它工作区靠全局 opencode.json 重启加载。
- **`GET /mcp` 只列配置文件里的 entry**：`MCP.status()` 遍历 `cfg.mcp`，运行时 `POST /mcp` 加的 server 即使 connected 也**不出现在 GET /mcp**（工具实际可用，`MCP.tools()` 走 instance state）。别用 GET /mcp 验证运行时注册是否成功——直接让会话调用工具验证。

## 4. Gateway / Channel（:4097）

- **重编译必须用 `bun run build:gateway`**（或 `scripts/build-gateway.ts`）：`turbo run build` 只输出到 `dist/`，**不会**更新 sidecar binaries 目录。改完不重编译 = 不生效，且 Tauri 会复用旧进程，需重启。
- **测试 Mock**：`DWClient` / `TokenManager` 必须用 `class` mock，不能用 `vi.fn()`。
- **CORS 白名单**：仅允许 `tauri://localhost` / `https://tauri.localhost` / `http://localhost:1420`，不要用 `origin: "*"`。
- **配置/映射持久化**：`~/.ultrawork/channels.json`（+ mutex）、`~/.ultrawork/session-map.json`（chatId → sessionId，重启恢复）。
- **日志**：`/tmp/gateway.log`。

### 微信 ilink 协议实测坑点

- base URL `https://ilinkai.weixin.qq.com`，认证 `Bearer bot_token` + `ilink_bot_token` header。
- `get_bot_qrcode` 返回的 `qrcode` 是 **token（非 URL）**，`qrcode_img_content` 才是真正的扫码 URL。
- `getconfig` 首次调用会报 `GetTypingTicket rpc failed`，**不能用于连接验证**；直接启动 `getupdates` 长轮询即可。
- `getupdates` 长轮询超时时返回的响应**无 `ret` 字段**，需兼容 `ret=undefined` 视为正常。
- 收消息：HTTP 长轮询 `getupdates`（35s），cursor 同步；session 过期 `errcode=-14`。
- 发消息：`sendmessage` POST，markdown 转纯文本；语音消息用 STT text 当文本输入。

### QR 扫码建渠道骨架（`qr-registry.ts`，ADR-044，契约实拍 2026-07-08）

- **设备流 secret 是一次性交付**：poll SUCCESS 只返回一次 client_secret ⇒ 必须 gateway 后台轮询、**拿到即 addChannel 落盘**，绝不能经前端 HTTP 透传（响应丢失=凭证永久丢失）。取消（DELETE）**不回滚上游**——扫码后上游应用/机器人已真实创建；poll 飞行中被取消时 authorized 结果仍要落盘。
- **三家注册端点全部不在公开 API 文档里**（只存在于各家官方 CLI/SDK 源码），bump/排障以真机实拍为准；base URL/source 均留了 env 覆盖。
- 凭证安全：`channels.json` 0600 + `GET /channel`、`POST /channel` 响应均掩码 secret 字段（`clientSecret/botToken/secret/appSecret`）——**前端拿不到渠道 secret，新功能勿依赖**。
- 三家「渠道」凭证与办公 CLI 连接器（§14）**互不相通**：钉钉渠道=registration 建的新应用（≠dws 内置 OAuth client）；企微渠道=新建专用智能机器人（**严禁复用 CLI 绑定的那只**——CLI bot 有「仅创建者可对话」限制，且共用 `~/.config/wecom/` 会被 init 失败 rollback 连坐）；飞书渠道=新 PersonalAgent 应用（≠lark-cli 绑的 cli_aac1cfd3）。

**钉钉 registration 设备流**（`oapi.dingtalk.com/app/registration/*`，JSON body，真机全链验收 2026-07-08）：
- init `{source}`→`{nonce(300s)}` → begin `{nonce,source}`→`{device_code(7200s), interval:2, user_code, verification_uri_complete}`（**interval=2s 动态下发，非源码推定的 5s**；QR 内容=verification_uri_complete）→ poll `{device_code}`→`status: WAITING|SUCCESS|FAIL|EXPIRED`。
- **失败=HTTP 200 + errcode:0 + status:FAIL + fail_reason**（不是 HTTP 错误也不是 errcode≠0）；SUCCESS 载荷=`client_id/client_secret`（实拍：一键创建的应用 clientId 形如 `dingyob…`）。扫码页可「一键创建新机器人」或绑定已有 bot；source 默认 `DING_DWS_CLAW`（自有品牌需钉钉认可）。

**企微 ai/qc 扫码流**（`work.weixin.qq.com/ai/qc/*`，无需预置鉴权，真机全链验收 2026-07-08）：
- generate `?source=wecom-cli&plat={1|2|3}`→`{data:{scode, auth_url}}` → 3s 轮询 query_result `?scode=`→`{data:{status}}`；success 载荷=`bot_info{botid,secret}`（每次扫码**只能新建** bot，无绑已有路径）。
- **bogus/过期 scode 的 query 也返回 `{status:"pending"}`——上游无任何过期信号，过期只能本地超时判定**（官方 CLI 用 5min）；仅 `success` 是终态。**扫码 URL（auth_url=/ai/qc/c?s=…）与浏览器打开 URL（/ai/qc/gen?scode=…）是两个不同链接**。
- 长连接（`@wecom/aibot-node-sdk`→`wss://openws.work.weixin.qq.com`）：**同 botId 仅一条活跃连接**（新连顶旧连=event.disconnected_event，只能落终态 error 别打架）；重连耗尽（默认 10 次）发 `WSReconnectExhaustedError`，不接住就假在线；单会话频控 30 条/分、1000 条/时；24h 回复窗口。

**飞书 registration 设备流**（`accounts.feishu.cn/oauth/v1/app/registration`，**form-encoded**，真机全链验收 2026-07-08）：
- init `{action:init}`（校验 supported_auth_methods 含 client_secret）→ begin `{action:begin, archetype:PersonalAgent, auth_method:client_secret, request_user_info:open_id}` → poll `{action:poll, device_code}`。
- **pending/denied 态走 HTTP 4xx + JSON body**（`{error:"authorization_pending"}` 等，**不能按 !resp.ok 判错**）；`slow_down`=轮询间隔 +5s 累积；`user_info.tenant_brand==="lark"` ⇒ **切 accounts.larksuite.com 再 poll 才拿得到凭证**（resolved domain 必须存进 config——WS/发送域名同分叉）。
- **PersonalAgent 默认权限模板实拍可用**：不带 Addons，扫码建的应用（`cli_aac74e85…`）单聊收发开箱即通（群聊未实拍，或需 `im:message.group_msg`）。
- **Lark node-sdk `WSClient.start()` 不等连接建立就 resolve**（内部 reConnect 未 await；appId 不匹配 `/^cli_…/` 时**静默返回**）——连接结果只能靠构造参数 `onReady/onError` 回调拿；发消息=`im.v1.message.create`（单聊 receive_id_type=open_id，群聊 chat_id）。

**IM 渠道的出站约束（2026-07-12，ADR-050 / discussions/033）**：
- **四家都不能编辑已发消息**：`ChannelAdapter` 只有 `sendMessage(chatId, content)`，**不返回消息句柄**。⇒ 「流式」在这里只能是「写完一段发一条新消息」。**腾讯官方自己的微信 bot 也是这么做的**（`@tencent-weixin/openclaw-weixin` 的 capabilities 明写 `blockStreaming: true`，攒够 200 字符或空闲 3 秒发一条），不是我们的凑合。
- **群聊的 chatId 是 `group:{conversationId}` —— 整个群共用一个 chatId、一个 session**。⇒ 任何「等待某人回复」的状态都必须记住 senderId，否则群里任何人的下一句话都会被当成那个人的回答。
- **分段发送必须带频控预算**：四个 adapter 的发送路径**零节流**，而企微单会话 **30 条/分、1000 条/时**，钉钉群机器人 20 条/分。切太碎会被限流吞掉（我们封顶每轮 6 个中间块）。
- **真流式是可行的，但四家四套**（未实施，见 discussions/033 §2.2）：飞书 CardKit 卡片实体（普通自建应用即可，免费，单卡 10 次/秒）· 企微智能机器人 `msgtype: "stream"`（**我们的 wecom adapter 已经在 aibot 长连接上，只是没调这个 API**）· 钉钉 AI 卡片 `PUT /v1.0/card/streaming`（**每帧算一次付费 API 调用**，单帧 ≤1KB）· 微信 iLink **协议层无 edit 端点，不存在绕过办法**。

### 渠道会话轮转与 session-map（ADR-051，2026-07-12）

- **`gatewayBaseUrl()` 本身已经含 `/channel` 前缀**（dev 下是 `"/channel"`，prod 下是 `http://localhost:<port>/channel`）。再拼 `/channel/xxx` 会得到 `/channel/channel/xxx` → **404**。正确写法是 `${gatewayBaseUrl()}/xxx`（对照 `use-channels.ts`：列表用的是 `gatewayFetch("")`）。这个坑**极难发现**：`channel-sessions-context` 的失败被 catch → 退避静默吞掉，症状只是「徽标永远不出现」，日志一个字都没有。单测也看不见（fetch 根本没跑）——是**真浏览器 e2e** 抓到的。现已有单测钉死 URL + 首次失败 `console.warn`。
- **`~/.ultrawork/session-map.json` 的落盘频率从「建/删会话时」变成了「每条入站消息」**（要重打 `lastActiveAt`）。因此 `save()` **必须**用唯一临时名（pid + 序号）并**串行化**：共享一个固定的 `.tmp` 名会让两个并发写互相覆盖，可能把**半写入的 JSON** rename 成正式文件 → 下次启动解析失败 → 走 corrupt 分支静默清空 → **四个渠道的绑定一起丢**。（与 ADR-045 的 `ports.json` 原子写同构。）
- **`lastActiveAt` 只能由「我们真正处理了的」消息刷新**。特别是：回答 question 的消息走的是 **early-return**（不经过 `startTurn`），所以时间戳必须在那条分支里单独打——否则一段长达半小时的问答会被判成 idle，轮转会把用户正在进行的对话切掉。反过来，**被挡回去的旁人插话不能刷新时钟**（它从未到达 agent，否则群里任何人都能让一个死会话永远活着）。
- **轮转的 in-flight 护栏（`activeContexts` 非空则不轮转）在 question 路径上是「死代码」**——question 消息在 `pendingQuestion` 分支就被当作答案 early-return 了，根本走不到轮转判定。它真正保护的是**普通 turn 在飞**的场景。写测试时别搞错对象：针对 question 场景的测试**撤掉护栏仍然全绿**（曾实际发生）。
- **`ULTRAWORK_CHANNEL_IDLE_ROTATE_MS` 在打包后的 app 里传不进去**：Tauri 只显式传 5 个 env 给 gateway，其余靠继承父进程环境，而双击启动时父环境是 launchd 的。它实质是**开发/调试逃生阀**，生产只能用默认 60 分钟。
- **Tauri 不转发 sidecar 的 stdout** —— gateway 的 `console.log` 在 `tauri dev` 的终端里**看不见**。所以「轮转没触发」和「env 根本没到达进程」无法区分。⇒ `GET /channel/health` 会返回 `idleRotateMs`，用它来确认。

## 5. Knowledge / IMA（:4098）

- **DB**：`~/.ultrawork/knowledge/kb.db`（SQLite WAL + FTS5 + `_migrations` 版本管理）。
- **MCP 注册名** `knowledge-base`，command `[sidecarPath, "mcp-stdio"]`，direct（同进程）+ proxy（HTTP `/kb/search`）双模式。
- **ONNX 仍延后**：`bun build --compile` 兼容性未解决，继续用 TF-IDF（质量可接受）。
- **IMA API**：base URL `https://ima.qq.com`，认证头 `ima-openapi-clientid` + `ima-openapi-apikey`；响应字段用 `code`/`msg`（**不是** `retcode`/`errmsg`）。对齐 ima-skill v1.1.7。
- **IMA Wiki `search_knowledge` 限制**：只返回 highlight_content 片段；无跨 KB 端点（需客户端 fan-out）；静默 100 结果截断；订阅 KB 返回 `220030` 无权限。笔记类型条目可经 `get_media_info`(media_type=11) 跨模块到 `get_doc_content` 取全文，非笔记类型仍只有片段。
- **IMA Notes 限制**：`get_doc_content` Error `210005` = not author（共享笔记预期行为，已容错降级）；`list_notebook` 无用户笔记本时返回空数组（系统文件夹不在返回），已合成 `__all_notes__` 虚拟条目兜底；笔记写入需 UTF-8 校验（非 UTF-8 会不可逆乱码）。
- **IMA HTTP 错误**：HTTP 401 返回 JSON body `{code:200002, msg:"skill auth failed"}`；`imaFetch` 已处理非 200 的 JSON 解析；`formatErrorMessage` 覆盖 `20004/200002/110030/110021`。
- **IMA 扫码认证不可行**：无公开 OAuth 端点（详见 ADR-026）。

## 6. Tauri / 桌面

- **`setup()` 跑在事件循环启动之前，而窗口已经在屏幕上了 —— 在里面做任何慢活 = 白屏（ADR-055，2026-07-13，源码级确认）**：`tauri-2.10.3/src/app.rs:2370-2383` 先按 `tauri.conf.json` 创建窗口（未设 `visible:false` ⇒ **默认可见**），**之后**才调用户的 `setup()` 钩子；而整个流程发生在 `app.run()` 之前 ⇒ **runloop 还没转**。所以 `setup()` 里每一毫秒的同步工作，用户都是对着一个**画不出任何东西、且无响应**的空窗口在等。白屏不是"渲染慢"，是**根本没在渲染**。**推论一：`setup()` 里只放瞬时操作**（我们只留 `install_signal_handlers()`），其余一律丢进后台线程（`boot_sidecars()`）。**推论二：任何"在 setup 里加个 splash/loading"的想法都是死路**——主线程堵着，splash 同样画不出来；解阻塞与加 loading 是**一件事的两半**，不能只做后者。
- **`blocking_show()` 在 `setup()` 里 = 永久死锁，不是"弹窗没弹出来"（ADR-055）**：`tauri-plugin-dialog` 的 `blocking_show` 内部是 `run_on_main_thread(闭包)` + `rx.recv()` 阻塞等回调（`lib.rs:68-77` / `desktop.rs:215-222`，原生对话框**永远在主线程构造**，满足 AppKit 契约）。在 `setup()` 里调它：`rx.recv()` 阻塞主线程 ⇒ 负责 `send` 的闭包被投递到**同一个尚未启动的事件循环** ⇒ 永远不会执行 ⇒ **app 冻死**。我们的「OpenCode 启动失败」弹窗曾长期处于这个状态。插件文档写的 "should **NOT** be used when running on the main thread context" 指的就是这个。**从后台线程调是安全的、也是唯一正确的**。
- **`titleBarStyle: Overlay` 下 `data-tauri-drag-region` 不生效，但 Tauri 的拖拽脚本仍然三平台都注入**：见下方 Overlay 条目（React 侧要用 `startDragging()`）。注意**只有挂了该属性的元素本身**会响应，子元素不继承 —— 启动 splash 的进度条/文案节点必须各自挂一份，否则用户抓着唯一可见的那部分反而拖不动窗口。
- **启动 splash 的内联样式不能引用 `index.css` 的设计 token（ADR-055，2026-07-14）**：`index.html` 里的 splash 之所以内联，就是为了在 bundle 解析完之前就能画出来；而 `--color-brand` 之流定义在 `index.css` 里，**dev 下这个文件是跟着 bundle 一起到的**（Vite 用 JS 注入 style）⇒ 写 `var(--color-brand)` 会让它在**最需要显示的那几秒里恰好没有颜色**（prod 下 CSS 是 render-blocking 的 `<link>`，反而不复现 ⇒ **dev 能看见的 bug，prod 看不见**，别拿 prod 截图当验证）。主题相关的值由 `<head>` 里的内联脚本写成 `--boot-*`（它先于 body 执行），主题无关的值（品牌色两套主题同值）直接写字面量 + 注释标注需与 `index.css` 同步。**判据**：splash 层的任何依赖，都必须是"webview 首帧就已具备"的东西。

- **`open_file_with_system` / `reveal_file_in_finder`（ADR-037 起已改 opener 插件 Rust 侧 API）**：现内部用 `app.opener().open_path(...)` / `reveal_item_in_dir(...)`（`lib.rs:363/487`，内部 ShellExecute/`open`/xdg-open，三平台）。历史坑：JS 侧 `opener:allow-open-path` 需配静态 scope 且对隐藏目录（如 `.ultrawork`）不可靠 → 曾改自定义 command + `Command::new("open")`（macOS-only），ADR-037 跨平台化时收敛为 **Rust 侧调 opener 插件**（不受 JS permission scope 限制，也无 cmd 注入面，见 §12）。新代码打开文件/揭示文件一律复用这两个现成 command。
- **`window.open` 打不开系统浏览器**：Tauri WebView 中必须用 `@tauri-apps/plugin-opener` 的 `openUrl()`。
- **任何用户可见的链接都必须走 `openExternal()`，`<a href>` 一律不行（ADR-052，2026-07-12）**：Tauri WebView 里裸 `<a href>` **原地导航**（整个 app 被网页顶掉、无返回键），而 `<a target="_blank">` 的 new-window 请求被**直接吞掉**（点击零反应）。**两种写法都是 bug，只是坏法不同**——聊天正文当年选了后者，于是「链接点不开」；md 产物预览用的是 ReactMarkdown **默认 `<a>`**（无 components map），于是点一下 app 就没了。正确做法：`onClick` → `preventDefault()` → `@/lib/external-url` 的 `openExternal(href)`；markdown 一律复用 `@/components/ui/markdown-link` 的 `MarkdownLink`。**协议白名单（`http/https/mailto/tel`）是安全边界不是洁癖**：`openUrl` 走系统 handler，而转录区渲染的是**半可信的模型输出**（可被抓取到的页面、或 IM 渠道里第三方的消息带偏），放行 `file:`/自定义 scheme = 用系统权限唤起任意本地 app。**推论：不要为放行 IM deeplink 给 ReactMarkdown 传宽松 `urlTransform`**——react-markdown v9 的 `defaultUrlTransform` 本来就挡掉 `javascript:`/`data:`/`file:`，传了自定义的就把那层拆了。
- **Rust `navigation_guard` 兜底管不到 `target="_blank"` / `window.open`（实测读 wry 源码，ADR-052）**：Tauri 只给 wry 的 **navigation** handler 开了插件钩子（`plugin::Builder::on_navigation`）；new-window 请求走的是另一条路——**Windows `NewWindowRequested`、Linux `NEW_WINDOW_ACTION`**——wry 在没有 per-webview handler 时**静默 `SetHandled(true)` 丢弃**，而我们的窗口是从 `tauri.conf.json` 建的、从未调用 `WebviewBuilder::on_new_window()` ⇒ **守卫根本看不到这类请求**。所以它兜的是**危险的那种**（原地导航把 app 顶掉），不是**无害的那种**（`_blank` 被吞）。**JS 侧仍然绝不能发 `target="_blank"`。** macOS 上 `_blank` 会先过 navigation delegate 故守卫会触发——**这是平台不对称，别据此以为三平台都兜得住**。
- **缺 WebView2 时必须在 `tauri::Builder` 之前拦截（ADR-046，Windows）**：Windows 不随 app 带 webview，链接系统 Evergreen WebView2；缺失时 `tauri::Builder::run` 会在**创建 webview 阶段 abort**，而 release 构建是 `windows_subsystem = "windows"`（`main.rs:1`），panic 打给一个不存在的 console → 用户看到的是「双击没反应」。因此自检必须在 `main()` 里、`run()` 之前（`webview_runtime.rs`）。检测用 `tauri::webview_version()`（`Err`=无 runtime，静态链接 loader、不需 COM/消息循环/WebView2Loader.dll，进程早期调用安全）；弹框用 `rfd`（`tauri-plugin-dialog` 要 `AppHandle`，此刻还没有）。安装器只能保证装机那一刻有 runtime，**管不到用户事后卸载/组策略移除**（clash-verge-rev#1150），所以运行时自检是必需的兜底，不是冗余。
- **titleBarStyle Overlay 坑**：`data-tauri-drag-region` 在 Overlay 模式不生效（tauri-apps/tauri#9503），须用 `getCurrentWindow().startDragging()` + `onMouseDown`，且需 `core:window:allow-start-dragging` 权限（不在 `core:window:default` 中）。**推论：拖窗口只认显式挂了 `onMouseDown={handleDrag}` 的元素**，没挂的区域一律拖不动（macOS-only；Win/Linux 有原生标题栏，`decorations` 未关，靠系统标题栏拖，感知不到）。因此**折叠/变窄的 UI 容易丢掉拖拽面**——如左侧栏折叠后原本 288px 宽的品牌栏拖拽条塌成 68px 窄缝、且被 logo 按钮占满（`handleDrag` 跳过 `button/a/input/...`，logo 是 button 不可拖）→ 用户无处抓。规避：给折叠态的空白撑满区（`flex-1` spacer）补挂 `onMouseDown={handleDrag}`，`handleDrag` 自带按钮跳过逻辑保证图标列仍可点（`left-sidebar.tsx` 折叠分支）。
- **Finder 启动 PATH 受限 → 已注入登录 shell PATH**：从 Finder/launchd 启动的 app PATH 极简、不读 shell rc，自定义安装目录（`~/.opencode/bin`、`~/.cargo/bin`、`~/.qoder/bin`、各类 bundle wrapper）里的 agent/知识库可执行文件不可见 → `Bun.spawn(["hermes"])` 报 `Executable not found in $PATH`。`rich_path()`（`lib.rs`）以前只手动扫描**硬编码 node-centric 清单**（volta/local/homebrew + nvm/fnm node 目录），追不上跨机器变动的自定义目录。**现已合并登录 shell PATH**：`login_shell_path()` 跑 `$SHELL -lic 'printf <sentinel>$PATH'`（`-l` source `.zprofile`、`-i` source `.zshrc`，PATH export 多在此），sentinel 包裹防 rc 噪音，**5s 超时 + 子线程读 stdout**（rc 挂起/弹交互绝不阻塞启动，失败回落 `rich_path_base`，绝不比旧行为差），`OnceLock` memoize 全进程只跑一次；结果 = `merge_paths(登录PATH, base)`（登录目录优先、保序去重）。`ULTRAWORK_SKIP_LOGIN_SHELL_PATH=1` 可关（排障/CI）。四处调用方（`detect_system_node`/`skill_dep_path`/acp sidecar 启动/**opencode-server 启动**）统一受益。**opencode-server 注入 PATH（2026-07-02 起）**：此前只有 acp-client 拿 rich PATH，opencode sidecar 继承 Finder 最小 PATH → 技能 bash 里的 `python3`/`pandoc` 等按最小 PATH 解析，与依赖徽标探针（rich PATH）**错位**（徽标绿、技能跑挂，或反之）；现 `start_sidecar` 给 opencode-server 也传 `("PATH", rich_path())`，探针与技能运行时同源。注意 memoize 语义：app 启动后新加进 shell rc 的 PATH **目录**要重启 app 才生效（目录里新出现的二进制不受影响，按次解析）。仍找不到时：检查工具目录是否在 `-li` shell 的 `$PATH` 里（非 sourced 文件设的 PATH 看不到），或 agent 启动命令直接填绝对路径。TS 侧 `acp-connection.ts augmentPath`（`EXTRA_PATH_DIRS` = `~/.local/bin`/`~/.bun/bin`/`/usr/local/bin`/`/opt/homebrew/bin`）作 belt-and-suspenders 保留，**不覆盖** `~/.opencode/bin` 等——根治靠 rich_path 注入的登录 PATH。
- **Production vs Dev URL**：Dev 有 Vite proxy（相对路径转发），Production 没有。所有 localhost 服务请求必须区分环境：`import.meta.env.DEV ? "" : "http://localhost:4096"`。
- **健康检查端点是 `/global/health`**（不是 `/health` / `/api/health`）。
- **预览任意路径文件（PDF）别用 assetProtocol / tauri-plugin-fs scope，改 scope-free 自定义命令（2026-06-15）**：工作目录可能在 `$HOME` 之外（外置盘/任意挂载），而 Tauri **assetProtocol 与 plugin-fs 的 scope 都是 `tauri.conf.json` 里的静态配置、无法按工作区动态化** → 这些目录的文件必然读不到（这正是 PDF 预览选型时排除 assetProtocol 的原因）。解法 = 新增自定义 Tauri 命令 `read_file_bytes(path) -> tauri::ipc::Response`（`std::fs::read` 直读、无插件 scope、可读任意路径，`ipc::Response` 二进制回传比 base64/数组高效，JS 侧 `invoke` 得 `ArrayBuffer`）。（`open_file_with_system` 曾同思路绕 scope，后已收敛为 opener 插件 Rust 侧 API，见上条。）
- **pdf.js 在 Tauri/Vite 里的接法（含版本坑，2026-06-16 真机踩过）**：
  - **必须 pin `pdfjs-dist` v4.x，别用 v5/v6**：v6 用了 `Map.prototype.getOrInsertComputed`（2024 超新 TC39 方法），**macOS WKWebView 的 JS 引擎不支持** → worker 一启动就抛 `getOrInsertComputed is not a function`，预览必失败。v4.10.38 实测正常。升级前务必在真机 webview 验证,**单测/headless 测不出**（jsdom 跑不了 pdfjs worker/canvas）。
  - **worker 用 `?worker` 不用 `?url`**：`import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker"` + `GlobalWorkerOptions.workerPort = new PdfjsWorker()`。`?url`+`workerSrc` 在 Tauri webview 里加载 module worker 会失败；`?worker` 让 Vite 自己实例化更稳。单一共享 workerPort 没问题（pdf.js 跨文档复用、不会在 loadingTask.destroy() 时终止外部 port）。`?worker`/`?url` 导入都需 `src/vite-env.d.ts` 的 `/// <reference types="vite/client" />`。
  - 文档清理用 **loadingTask（`getDocument()` 返回值）的 `.destroy()`**——`PDFDocumentProxy` 没有 `destroy()`（只有 `cleanup()`）。
  - **v4 的 `page.render({canvasContext, viewport})` 不接 `canvas` 参数**（`canvas` 是 v5/v6 才加的；v4 传了 tsc 会报）。
  - 字节读取走 scope-free 自定义命令 `read_file_bytes`（见上），不依赖 assetProtocol/plugin-fs scope。Word/Excel/PPT 无内嵌渲染器，维持 `open_file_with_system`。
- **Sidecar 进程生命周期 / 退出清理（2026-06-17 真机实测，`lib.rs`）**：
  - **进程数量**：Tauri 主进程 spawn **4 个顶层 sidecar**（opencode-server :4096 / channel-gateway :4097 / knowledge-sidecar :4098 / acp-client :4099，均为主进程直接子）。但 idle（刚启动未发 prompt）实测共 **9 个进程**——`knowledge-sidecar` 和 `acp-client` **各跑 2 份**（一份 HTTP 给 UI，一份被 OpenCode 当 MCP stdio 子进程拉起：`knowledge-sidecar mcp-stdio` / `acp-client delegate-mcp`，路径在 `~/.ultrawork/sidecars/`），且 `warm_opencode_mcp` 的 `GET /mcp` eager init 会**主动 spawn chrome-devtools-mcp + 一个独立 PGID 的 watchdog**（即便没用浏览器工具）。MCP 子进程挂在 opencode(:4096) 下。
  - **关窗口 == 退出 app**：Tauri 2 默认「最后一个窗口关闭即退出」（macOS「无窗口仍驻留 Dock」需显式处理，本项目没有）。关窗口 / Cmd+Q / 可捕获信号（SIGINT/TERM/HUP）都会清理干净 → `RunEvent::Exit` 或信号处理器调 `shutdown_sidecars()`（按 pid kill 4 sidecar + 端口兜底 + `kill_browser_mcp_processes`；MCP 子进程随 opencode 死、watchdog 自杀）→ **零残留**。
  - **唯一残留场景 = `kill -9` / 崩溃 / panic（非优雅退出）**：`RunEvent::Exit` 不触发、信号不可捕获 → sidecar 被 launchd 收养成孤儿（PPID→1）、端口 4096-4099 残留；二次危害是下次启动复用残留的（可能旧版本）二进制。**已修复**：`prepare_port` 检测孤儿（`port_listener_orphaned` 经 `lsof` + `process_ppid`==1）→ kill 重启而非 reuse（启动自愈，覆盖一切死法）；`install_signal_handlers`（signal-hook）补可捕获信号路径。`shutdown_sidecars` 幂等（drain registry），多路径重复调用无害。**SIGKILL 不可捕获 → 只能靠启动自愈，无法靠信号处理**。
- **`tauri_plugin_shell` 的 `spawn()` 返回的 rx：要么立刻丢弃，要么必须持续 drain（2026-07-09 读 plugin 源码 + 真机实证，ADR-045 阶段 ③）**：`Command::spawn()` 内部 `channel(1)`（容量 **1**），且 stdout/stderr reader 线程走 `block_on(tx.send(..))`。所以**持有 rx 却不读 = 把子进程的写卡死**（旧代码 `let (_rx, child) = ...` 直接丢弃 receiver 反而是安全的：sender 立即报错、被忽略）。需要 `CommandEvent::Terminated`（用于「子进程秒退」≈200ms 识破，不必干等 15s 健康轮询）时，把 rx 移进**专用 std 线程**里 `blocking_recv()` 循环（不在 async runtime 上下文，安全），其余事件读完即丢。
- **e2e 的 Tauri invoke shim 对未知 command 返回 `null`，不是 reject**（`invoke: async (cmd,args) => handlers[cmd]?.(args) ?? null`）：所以「invoke 失败就走兜底」的代码若只 `catch` 异常，会把 `null` 当成合法返回值吃下去。**必须校验返回值形状**。（ADR-045 阶段 ② 实证：`ports = null` → `acpBaseUrl()` 在 SSEProvider 的 `useMemo` 里抛异常 → **整页空白**；vitest 里 mock 的是 reject 路径，测不到，只有真浏览器 e2e 抓得到。同理，新增需要凭证/端口的 command 后，凡是驱动真 sidecar 的 e2e 都要在 shim 的 handlers 里补上。）
- **持久化的 `opencode.json` 里 `mcp.environment` 会覆盖继承的 env**（vendor `mcp/index.ts`：`env: { ...process.env, ..., ...mcp.environment }`，`mcp.environment` **排最后**）。所以任何写进该文件的 `PORT`/凭证类变量都会在下次启动压掉宿主注入的正确值 → **端口与凭证一律不入持久化配置**，由宿主经 env 注入、孙进程继承（或读 `~/.ultrawork/run/ports.json`）。存量条目需开机迁移剥除（ADR-045 `strip_persisted_sidecar_ports`）。
- **`is_port_in_use` 走 `connect()`，对「只 listen 不 accept」的占用者会误判为空闲**：backlog 填满后 `connect` 超时，探测返回 false → 我们以为端口空闲 → 子进程 bind 失败秒退。真机复现（用 python `listen()` 不 `accept()` 蹲住 4096-4099 时必现）。**不是缺陷、也别去改探测**——`start_sidecar` 的「秒退即换端口重试」恰好覆盖它（2026-07-09 真机日志实证：opencode 试 4096 → 子进程 exit(1) → 换 ephemeral 61073 成功）。真实服务端会 accept，不触发。
- **`~/.ultrawork/run/ports.json` 必须原子写（tmp + rename）**：三个 sidecar 线程各自在 ready 后写它，就地 `truncate`+`write` 会让一个写者在另一个写到一半时把文件清零。且**启动后再没人重写它**，损坏是整个 session 永久的：读者 `delegate-mcp` 的 `JSON.parse` 失败后静默回退到 4099，而动态端口模式下 4099 没人监听 → 整个 session 的委派全废。（ADR-045 review 抓到；`write_global_opencode_json` 早就是 tmp+rename，只是没照抄。）
- **进程退出后 pid 立刻可被复用 → 清理注册表时不能只按 pid 匹配**：子进程启动即退（抢端口失败）后，OS 可能把它的 pid 直接发给兄弟 sidecar 刚 spawn 的活进程；此时 `retain(|e| e.pid != Some(dead_pid))` 会把**那个活着的兄弟**的条目删掉 → `shutdown_sidecars` 不再杀它 → 进程泄漏到 app 之后。按 `(name, pid)` 双匹配。
- **`prepare_port` 只探「首选端口」，看不见落在动态端口上的孤儿**：prod 回退到 ephemeral 后被 SIGKILL，下次启动首选端口恰好空闲 → 直接绑上，旧的 `channel-gateway`（抢同一个 IM 长连接）和 `knowledge-sidecar`（单写者 SQLite 的第二个写者）还活着。single-instance 也看不见——对手不是另一个"实例"，是孤儿。解法=开机若 `ports.json` 尚存（干净退出会删它），按记录的端口逐个**归属门控**回收（ADR-045 `reap_orphaned_sidecars`）。
- **hono `cors()` 自己应答预检 OPTIONS 且不调 `next()`** → 鉴权中间件必须挂在 `cors()` **之后**，否则浏览器那个不带凭证的预检会被 401，跨域请求根本发不出去。（`allowHeaders` 留空时 hono 会把 `Access-Control-Request-Headers` 原样反射，所以加 `Authorization` **不需要**改 CORS 配置。ADR-045 阶段 ④b）
- **401 带 `WWW-Authenticate: Basic` 会让浏览器接管认证流程**（hono `basicAuth` 默认就这么答）：Chrome 对这样的 `fetch` **不 resolve**，而是挂起等一个原生密码框（真浏览器实测：请求既无 response 事件也无 requestfailed，纯挂死）；Tauri WebView 里则会为一个用户从没输过的端口弹系统密码框。我们的调用方全是程序化的、自己带头，不需要浏览器的认证流程 → 三个 sidecar 统一用 `sidecarBasicAuth()` 包一层，401 时返回纯 `{"error":"unauthorized"}`、**不带 challenge 头**（hono 的 timing-safe 比较仍在起作用）。
- **`Bun.serve` 默认 10s `idleTimeout` 会掐死没有数据流动的 SSE**：knowledge sidecar 的 `/kb/sources/events` 只在索引进度变化时写，保活 `sleep(30_000)` 是默认值的三倍 → 空闲的知识面板每 10s 断一次、无限重连（旧代码用 `EventSource` 自动重连，症状被吞掉；换成 fetch-reader 后才浮出来）。`idleTimeout: 0` 关掉（ACP sidecar 早就这么做了）。任何长连接的 `Bun.serve` 都要显式设它。
- **`EventSource` 规范不支持自定义请求头** → 带不了 `Authorization`。本项目三个 sidecar 加入站 Basic auth 后，SSE 一律走 `@agent/connector` 的 fetch-reader（`createSseTransport`）。把 token 放 query string 是**明确否决**的替代方案（泄漏进日志/进程列表/Referer）。
- **打任意外部 HTTP（探活/测试连接）用 `curl` shell-out，别引 reqwest、别用 webview fetch（2026-06-22）**：测试自定义 provider 连通性的 `test_provider_connection`（`lib.rs`）跟 `download_node` 一样 `Command::new("curl")` 直跑——**理由**：① 不引 reqwest/tauri-plugin-http 重依赖（编译时间/体积）；② 避开 Tauri webview `fetch` 的 CORS（provider 多不发 CORS 头）；③ key 经 argv（`Command::args`，非 shell）传 `-H`，**无 shell/curl-arg 注入**（前导 `-` 安全归为值），且 key 只到 provider 自身 host。要点：`-sS -L`（`-L` 跟随 3xx，否则网关重定向被误判 http 错误）+ `-o /dev/null -w "%{http_code}"` 取状态码 + `-m 15` 超时；URL 按协议拼（openai=`{base}/models`，anthropic 缺 `/v1` 则补）；状态分类 0=network/2xx=ok/401·403=auth/404=notfound/其余=http。纯函数 `build_provider_test_url`/`classify_provider_status` 抽出单测（不需链接器，`cargo test` 即过）。
- **Chrome+Vite+Playwright 走查需注入 `window.__TAURI_INTERNALS__.invoke` shim（普通 Chrome 无 Tauri 桥，2026-06-22）**：dev 模式 app 经 Vite proxy（→ :4096 无密码 sidecar）走 HTTP，但所有 `invoke("xxx")` 在普通 Chrome 里**没有桥会抛错**。要驱动真实 app（工作区流程依赖 `ensure_default_workspace`/`check_directory_exists`、本功能「测试连接」依赖 `test_provider_connection`），用 Playwright `addInitScript` 注入 `window.__TAURI_INTERNALS__ = { invoke: async(cmd,args)=>handlers[cmd]?.(args) ?? null, transformCallback, metadata }`（`@tauri-apps/api/core` 的 invoke 读这个），未知 cmd 回 `null` 防启动崩；再 `localStorage.setItem("workspace_path", <tempWS>)` 跳过工作区选择。**注意**：① `goto` 后 SSE 长连不进 `networkidle`，用 `domcontentloaded`+定时；② 保存按钮真实文案是 **「Save Changes」非「Save」**；③ 这样验的是**接线 + UI + HTTP 回写**，被 shim 的 invoke（如真实 curl 探活）只能验分支映射、真值靠 Rust 单测 + 真机。隔离栈：标准端口 4096/1420 + temp HOME/XDG + temp 工作区，按端口/PID 清理，零碰真实 `~/.config`。

### 系统通知（`tauri-plugin-notification`，ADR-053，2026-07-12 实测）

- **`tauri dev` 下这条链路会撒谎（macOS）**：`isPermissionGranted()` **直接返回 true 且从没申请过权限**、`sendNotification()` **不抛任何异常**——但 macOS **从未把该 app 注册为通知客户端**（`~/Library/Preferences/com.apple.ncprefs.plist` 里查无 bundle id）⇒ **横幅一条都不弹**。打包成 `.app` 跑一次，注册表里立刻出现 `com.ultrawork.desktop`，横幅正常。**通知功能只能在打包产物上验，dev 下的「成功」全部不作数**（Windows 相反：dev 下会弹，但品牌显示成 "PowerShell"；安装版才用我们自己的 AppUserModelID，而**便携版（未安装）没有承载 AUMID 的快捷方式 ⇒ 无 toast**）。
- **投递失败在 JS 侧永远抓不到（2026-07-12 真机坐实）**：插件的 `show()` 把通知 spawn 到 async runtime 后立刻返回 `Ok(())`；`isPermissionGranted()` 在桌面端**硬编码返回 granted**。真机实测：用户在「系统设置 → 通知」里没给 app 开权限时，`isPermissionGranted()=true`、JS 的 `sendNotification()` 正常返回、**底层 `invoke("plugin:notification|notify")` 也 resolve OK**——横幅就是不出现，全链路零错误。⇒ ① 排查「横幅不弹」**先看系统设置**，别怀疑代码；② 我们**无法在代码里检测这个状态**，只能在设置页文案里引导用户去开（已加）；③ 插件 shim 里 `new window.Notification()` 是 **fire-and-forget**（invoke 不 await、rejection 无人接），所以就算 ACL 拒绝也只会变成一条无人处理的 promise rejection。
- **`requestUserAttention(null)` 不是无用功**：macOS 上确实是 no-op（Dock 弹跳靠聚焦自停），但 **Windows 映射到 `FLASHW_STOP`、X11 上 tao 会 `set_urgency_hint(false)`** —— 不发它，X11 的 urgency 标志会**永久置位**。反过来，**Wayland 上 `requestUserAttention` 整个是空实现**（GTK3 的 `set_urgency_hint` 在 Wayland 后端是空函数）⇒ 默认 GNOME/Ubuntu 下"图标提醒"静默无效，如实降级、不要假装成功。
- **WebAudio 在 Tauri WKWebView 里无需用户手势**：`AudioContext` 创建时是 `suspended`，但 `resume()` 在零手势下成功，且**窗口最小化期间音频时钟照常推进**（`currentTime` 每 tick 精确 +5.00s，实测）。因此提示音可以**在内存里合成**（写 WAV 头 + 正弦样本，或 oscillator），不需要打包任何音频资源。**但 Windows(WebView2=Chromium) 需要 sticky user activation** —— 我们靠「只提醒用户亲手发过 prompt 的会话」天然满足；若哪天放宽这个前提，Windows 上会**只是不出声**。
- **e2e 假 Tauri 桥：未知命令要 `resolve(null)`，不要 `reject`（ADR-053 血泪）**：把未知 `invoke` 做成 reject「模拟非 Tauri 环境」会让 `loadSidecarCredentials` 走进"未授权"分支 ⇒ **SSE 401 无限重连** ⇒ 所有依赖事件的用例**静默变成空转**（「应该静默」的用例全绿、「应该触发」的用例全红，看起来像产品缺陷）。照现有 e2e 的写法：未命中 handlers 表的命令一律 resolve null。
- **headless 浏览器里做不出「窗口失焦」**：Chrome/WebKit 的 `document.hasFocus()` 在另一个 tab `bringToFront()` 之后**仍然是 true**，所以「用户离开」这种前提在 e2e 里**只能由测试显式驱动**（把焦点读做成假桥里的一个可写标志），焦点读本身靠真机探针保证。
- **e2e 里 `page.goto` 会清空模块级单例**（新 document ⇒ 新 JS 上下文）：要模拟"用户在 app 内切到别的页面"必须走客户端导航（`history.pushState` + `popstate`，react-router 会响应），否则测的是"重启 app"而不是"换个页面"。同理，`addInitScript` 注入的计数器在每次导航后归零 ⇒ baseline 必须在导航**之后**取。
- **跑 e2e 前先确认端口 1420 上没有别人**：残留的 `tauri dev`（尤其带调试 flag 的）会让 `poll("vite")` 直接看到"健康"，于是整轮 e2e 跑在**别人的代码**上。e2e 应当在启动前 fail-closed 断言端口空闲。

- **WKWebView 的 DOM `paste` 事件能拿到完整图片（ADR-056 / discussions/039 §5，2026-07-14 实测）**：截图/复制图片后按 `Cmd+V`，`clipboardData.files[0]` 是正经 `image/png` File，`FileReader` 读出的字节与源文件**完全一致**，零依赖零权限——这让「系统快捷键截图 → 粘贴」白送截图能力（不需要屏幕录制权限，走的是系统截图工具自己的权限）。⚠️ WebKitGTK 历史上会「剪贴板说有图但给不出 File」（`types` 含 `image/*` 但 `files` 为空）⇒ 粘贴处理要对这种情况显式报错，别静默无反应。Windows/Linux WebView 待真机复验。

## 7. 构建 / 运行时

- **系统 Node.js v14 太旧**：不支持 `??=` 等现代语法。所有脚本必须用 `bun run --bun` 执行，不要直接 `npx` / `node`。
- **Universal DMG 构建**：`bun run release [-- --unsigned]`，跨编译双架构 sidecar + Tauri `universal-apple-darwin` lipo 合并。Apple Silicon 主机需先 `rustup target add x86_64-apple-darwin`。
- **CI 上光设 `APPLE_*` env 不会签名 —— 必须先把证书导入 keychain（2026-07-26，ADR-069，A/B 实证）**：`release.yml` 早先只设了 `APPLE_SIGNING_IDENTITY` 等 env 就以为能签，但 GitHub runner 是干净 keychain，`codesign` 查不到身份 ⇒ 签名失败**或静默退回 unsigned 而 job 仍绿**。这是最阴的失败模式：「job success」≠「真的签了」。必须补一步把 `APPLE_CERTIFICATE`(base64 .p12) 解码导入一次性 keychain，且 **`security set-key-partition-list -S apple-tool:,apple:`**（否则 codesign 取私钥时会交互挂起/失败）。验证发布是否真签，查**事实**：mac job 日志里应有 `1 valid identities found` + `Notarization approved ✓` + `Stapled ✓`，而非只看 job 是否绿。完整流程 + 6 个 secret 见 [build-and-deploy §九](./build-and-deploy.md) / ADR-069。
- **macOS 自带 LibreSSL 的 `openssl pkcs12` 无 `-legacy` 选项**：合成 `.p12` 时别照抄网上 OpenSSL 3.x 的 `-legacy`（会 `unknown option`）。LibreSSL 的 `pkcs12` **默认就用旧算法（3DES/RC2）**，本就是 keychain 能顺利导入的「legacy」格式，直接去掉 `-legacy` 即可。另：合成时必须 `-certfile` 打进 **Developer ID G2 中间证书**（`https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`），否则 CI 上证书链不全、公证失败。
- **Vendor patch apply 后必须重编译 sidecar**（`bun run build:opencode`）。完整流程（patch 内容表/重新生成命令）见 [`docs/vendor-patch-workflow.md`](./vendor-patch-workflow.md)。
- **新 workspace 包别声明与 root hoisted 不同版本的依赖**：bun 会重解析 root 提升版本（实测 acp-client 声明 `vitest ^3.1.4` 把 root 的 4.0.18 降到 3.2.4，砸了 desktop 的 jest-dom matcher 注册）。新包不要自带测试框架版本，或与 root 对齐。
- **Tauri `prepare_port` 会复用端口上健康的旧 sidecar 进程**（不重启）。`build-acp.ts` 在真正重编时会自动 kill :4099 旧进程，保证下次 app 启动跑新二进制；其它 sidecar（gateway 等）改完仍需手动重启 app（见 §4 第一条）。
- **CI 上打的 DMG 图标顺序是反的（`Applications` 跑到左边）**：tauri-bundler 见到 `CI=true` 就给 `bundle_dmg` 加 `--skip-jenkins`（上游 issue #592），跳过那段驱动 Finder 摆图标、写 `.DS_Store` 的 AppleScript；Finder 于是按文件名排序，`Applications` 排在 `Ultrawork.app` 前面。`bundle.macOS.dmg` 里的 `appPosition`/`applicationFolderPosition` **不会救你**——整段脚本都没跑（上游默认值 180/480 本就正确）。`build-release.ts` 用 `TAURI_BUNDLER_DMG_IGNORE_CI=true` 关掉该行为，并在公证前跑 `scripts/verify-dmg-layout.ts` 断言 `app.x < applications.x`。注意 AppleScript 失败时 `bundle_dmg` 直接 `exit 64`（构建红），这是刻意的——宁可失败也不发出布局错乱的包。v0.2.1 及更早的 Release DMG 均受影响（v0.2.1 实测无 `.DS_Store`；更早版本按 `CI=true` 恒成立外推）。
- **在 CI 上驱动 Finder 是上游明确不支持的路径**：tauri 维护者原话是 DMG 脚本「本来就不该在 CI 工作」，能跑通反而是意外。GitHub 的 macOS 镜像因此炸过一次（[tauri-action#1091](https://github.com/tauri-apps/tauri-action/issues/1091)，`AppleEvent timed out (-1712)`，卡 2 分钟后失败，镜像侧修复）；自托管 runner 无 GUI 会话拿不到 Automation 授权，会报 `-1743 Not authorised to send Apple events`。故 `TAURI_BUNDLER_DMG_IGNORE_CI` 做成可 env 覆盖，配 `--allow-bad-dmg-layout` 才能放行一次带瑕疵的发布——**两个开关缺一不可**，防止单个 flag 静默出坏包。若此类回归反复发生，长期解是构建后注入预制 `.DS_Store`（必须在 `stapler staple` **之前**做，否则作废公证票据）。
- **源码 grep 型守卫要先剥注释**：`verify-dmg-layout.ts --self-test` 断言 `build-release.ts` 仍设置 `TAURI_BUNDLER_DMG_IGNORE_CI`。最初用 `includes("TAURI_BUNDLER_DMG_IGNORE_CI")`，而**注释里就提到了这个名字**——删掉真正那行代码后守卫依然全绿（A/B 反证抓到）。现在先滤掉整行注释，再用 `/TAURI_BUNDLER_DMG_IGNORE_CI:[^\n]*"true"/` 锁住「默认开启」而非仅仅「名字出现」。
- **直接 `bun build --compile` 的产物在 macOS arm64 会被 SIGKILL（exit 137）**：bun 产出的二进制完全无签名（`codesign -dv` 报 not signed），且 `codesign -s -` 直接签会报 "invalid or unsupported format"——必须先 `codesign --remove-signature` 再 ad-hoc 签。**官方构建脚本（`scripts/build-acp.ts` 等）已包含这两步**，本地验证编译产物请走 `bun run --bun scripts/build-*.ts`，不要直接跑包内 `bun run build` 的 dist 产物。

- **`bun build --compile` 后，中文字面量不以明文形式存在于二进制里（2026-07-12 踩坑）**：`strings` 只提 ASCII，而 `grep -a` 连 UTF-8 / UTF-16LE 原字节也搜不到（源码被编成字节码）。⇒ **「中文串搜不到」不能证明代码没进包**。要验证某次改动确实进了 sidecar 二进制，**用 ASCII 的日志串做探针**（如新增的 `console.log` 文案），并同时确认旧代码的串已消失。
- **sidecar 的构建新鲜度 hash 必须覆盖它 bundle 进去的每一个 workspace 依赖 —— 同一个坑犯过两次，现已根治（2026-07-12 首犯 / 2026-07-30 复发并改为自动派生，均 A/B 实证）**：
  - 首犯：`build-gateway.ts` 只喂 `api-client`、漏了 `@agent/connector`，只改 connector 那次被判 `up-to-date, skipping build`。当时的对策是「新增依赖时同步更新 `computeSourceHash` 的 extraDirs」—— **靠人记得，于是第二次照样漏**。
  - 复发：`build-acp.ts` 从来没传过 extraDirs，而 acp-client 依赖 `api-client` / `connector` / `orchestrator` **三个**包。改完 orchestrator 跑 `build:acp` 答 "up-to-date"，二进制停在两天前 —— **本地拿旧二进制做「验证」，而且会通过**。这比慢构建糟得多：验证本身在撒谎。
  - **现改为从 `package.json` 递归自动派生**（`build-hash.ts` 的 `workspaceDepDirs`），新增依赖自动覆盖，不再需要人同步。**必须递归**：gateway→connector→api-client，只走直接依赖会漏掉间接那层。实测精确性：改 `api-client` 精确触发 acp+gateway 重建、knowledge（无 workspace 依赖）正确 skip。
  - **影响边界（别夸大）**：`src-tauri/binaries/` 整个被 gitignore ⇒ 哈希文件不入库，**CI / 发版是干净 checkout，`needsRebuild` 恒 true、全量重建，从不受影响**。受影响的只有本地增量构建（以及在本地跑 `bun run release` 的情形）。

### `os.homedir()` 不认运行时改的 `HOME`（Bun，2026-07-12，血泪）

`os.homedir()` **只在进程启动时解析一次**。运行时写 `process.env.HOME`（`vi.stubEnv` 正是这么干的）**完全无效**。

后果不是抽象的：`session-store.ts` 早期版本在模块顶层就 `join(homedir(), ".ultrawork", ...)`，单测想用 `vi.stubEnv("HOME", tmp)` 隔离——**没生效**，测试直接**覆盖了开发者真实的 `~/.ultrawork/session-map.json`**（真的丢了数据）。

⇒ 两条规矩：
1. **凡是会写真实用户目录的模块，路径必须可注入**（`new SessionStore(path)`），测试传临时路径，绝不构造无参默认实例。
2. e2e 里要重定向 HOME，只能让**父进程 spawn 一个新进程**并在 spawn 时设 env（`channel-session-rotation.e2e.ts` 就是这么做的），并且加 **fail-closed 断言**：`homedir() !== tmp` 就拒绝运行，而不是继续往真实路径写。

## 8. ACP / 外部 Agent（:4099，`@agent/acp-client`）

> 阶段1（ADR-027）实测坑点。SDK pin `@agentclientprotocol/sdk` 0.25.0；claude adapter = `@agentclientprotocol/claude-agent-acp`（0.44 实测；前身 `@zed-industries/claude-code-acp` 永久停在 0.16.2，已弃用）。

- **turn 整形契约（最核心）**：`buildTurnModel` 把「最后一条不含 tool part 的 message」当答案（`assistant-turn.tsx:53`），`isTerminal` 要求 `info.finish && !== "tool-calls"`（`message-list.tsx:110`）。sidecar 必须：工具步骤发过程 message（封板 `finish:"tool-calls"`）、最终文本发独立纯 text message（`finish:"stop"`）、**每个 part 先 `message.part.updated` 建好类型再发 delta**（前端 delta 对未知 part 直接丢弃且新建硬编码 text）。
- **claude adapter 对同一 toolCallId 重复发 `tool_call`**（rawInput 渐进变富）——整形必须按 toolCallId upsert，否则出现卡 pending 的重复 part。acpx 的「tool_call/tool_call_update 同一 upsert」正是为此。
- **SDK 0.25 与早期调研（014 表）的出入**：`usage_update` = `{size, used, cost}`（无 token 明细）；token 明细在 `PromptResponse.usage`（inputTokens/outputTokens/thoughtTokens/cached*）；另有 plan_update/plan_removed/session_info_update 等新变体；`SessionInfoUpdate` 仅 title/updatedAt（无 model）。
- **claude-agent-acp ≥0.44 的 usage 语义（2026-06-11 真机实测）**：`PromptResponse.usage` 是**单轮**累计（adapter 在每次 prompt 开头清零 accumulatedUsage——SDK 类型注释写 "across all turns" 与该 adapter 实际行为**不符**，以实测为准）；**无 `thoughtTokens`**（页脚 reasoning 恒 0 自然隐藏）；流中 `usage_update` 实测带 cost（页脚 cost 可显示）。旧 claude-code-acp 0.16.2 完全不发 usage——token 页脚为空即没升级。
- **0.44 的 thinking 是模型自适应，`MAX_THINKING_TOKENS` 不再保证思考块**：adapter 把该 env 转译为 SDK thinking 选项，但其源码注明 budget「在新模型上退化为 on/off」——on 后是否思考由模型按题目难度决定（真机连试 ultrathink/难题均未触发属正常）。0.16.2 时代「设了就有思考步骤」的预期已失效；0.44 新增 `thought_level`（effort）session config 是新控制杆（**已接入** Settings：agents.json `thoughtLevel` → session/new·load 后 `session/set_config_option`，见下方 thoughtLevel 条目）。`plan` 事件来自 TodoWrite 不变。
- **agents.json 旧包名自动迁移**：`loadAgentConfigs` 对 args 做**精确 token 匹配**重写 `@zed-industries/claude-code-acp` → `@agentclientprotocol/claude-agent-acp` 并写回磁盘（带版本后缀的显式 pin 不动；description 仅默认值才同步换）。见 `agents-config.ts` `migrateLegacyClaudeAdapter`。
- **`CLAUDECODE` env 嵌套检测**：该变量会从 dev shell（如 Claude Code 终端跑 `setup.sh`）一路继承到 claude adapter，旧版 claude-code-acp 据此嵌套会话检测拒绝 `session/new`（claude-agent-acp 0.44 已移除该检测，但底层 SDK 仍可能读）。sidecar 保留 spawn 时清洗 `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`（agent config.env 显式设置除外）。
- **bunx 首启下载 adapter 包可超 15s** → initialize 超时须 ≥30s（现 30s）；claude `session/new` 已知 stall → 60s 超时（acpx 怪癖常量）。
- **会话 ID 直通**：`POST /acp/session` 传 `clientSessionId` 后所有整形事件直接戳客户端会话 ID——前端零改写（旧分支的 sessionID rewrite hack 已不存在）；SSE 端点允许「先订阅、后建会话」。
- **权限回环安全默认**：`request_permission` 挂起后，超时（`ACP_PERMISSION_TIMEOUT_MS`，默认 5min）/ session cancel / agent 断开 / 进程退出均默认 deny/cancelled 并广播 `permission.replied`。
- **权限请求的 `toolCall.kind`**：旧 claude-code-acp 0.16.2 在 `requestPermission` 调用点丢弃 kind（只传 `{toolCallId, rawInput, title}`）；**claude-agent-acp ≥0.44 已带 kind**（spread `toolInfoFromToolUse()`，v0.44.0 tag 源码 + 真机确认）。`permission-label.ts` 分层推断保留为其他 agent / 旧版兜底：显式 kind → TurnShaper 查同 toolCallId 的 `tool_call` 帧 kind（查表前先 `await updateChain` 排空队列）→ rawInput 形状（command/file_path+写字段/url…）→ 反引号 title → 中性 `"tool"`（**不瞎猜 bash**）；`fetch` 映射 `webfetch`。真机验收 bash 权限须用**不在本机 Claude Code 全局 allowlist 的命令**——`ls`/`stat` 之类会被上游放行根本不弹窗。
- **claude 的 ACP adapter 在流式吐工具参数期间不发任何 `session/update`——`pending` 的 tool_call 必须和 `in_progress` 一样豁免看门狗（2026-07-11，ADR-049，真 agent A/B 实证）**：`@agentclientprotocol/claude-agent-acp` 对 `input_json_delta` 是 `case "input_json_delta": break`（直接丢弃）；它只在 `content_block_start` 发一个 `tool_call{status:"pending"}`，等 block 收口后才发填好 `rawInput` 的 `tool_call_update`。⇒ **agent 组装大工具参数（写大文件）的整个窗口，客户端零帧**——实测让 Claude 一次 Write 写 300 行 python，静默 **52.3 秒**。而 idle 看门狗原本只在 `in_progress` 时把工具计入 `activeTools` 撤防 ⇒ 该窗口用 30s idle 杠去量 ⇒ **必然误杀**（真机 A/B：修复前 34s 死于 `ACP turn idle for 30000ms`、工具停在 `pending` 且 `input={}`；修复后 61.9s 正常收尾）。**修法**：`pendingTools` 集合——`pending`（或**省略 status** 的首帧，SDK 允许）入集、`in_progress` 转入 `activeTools`、`completed`/`failed` 两集合都清；`inTool` 判据 = 两集合并集非空 ⇒ 复用已有的 `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认 600s）。与 opencode 侧 `idleGuard` 的 `pendingInputs` 完全对称（§1）。 **⚠️ 连带铁律**：adapter 还会在工具**完成之后**发**不带 status** 的 `tool_call_update`（PostToolUse 的 Edit/Write diff、Bash 的 terminal-output meta）——所以「无 status ⇒ 视作 pending」必须再加一道 `settledTools` 守卫，否则已结束的工具会被复活进 pending 集合且**再无路径删除**，看门狗此后永久停在 600s 杠上、对真正的停顿失明。
- **`/acp/global/events` 只广播 `session.status`，`permission.asked` 和消息 part 都走 `/acp/session/:id/events`（2026-07-11 排查踩坑）**：`acp-manager.ts` 里 `globalSubscribers` 的唯一推送点是 `emitStatus`。写 ACP 的 headless harness 时若只订阅全局流，**会看不到权限请求**，于是 agent 一直等一个没人回的权限（默认 5 分钟后自动拒绝），表现为「回合莫名卡死」——**极易误判成产品缺陷**。要驱动完整回合，必须订阅 session 流并回 `POST /acp/session/:id/permission {permissionId, reply}`。
- **ACP 会话无 `session.status:idle` 事件**：侧栏活动标记靠前端在终态 finish 时补 `markSessionIdle`（use-session-messages）。
- **会话↔agent 绑定 = sidecar 持久化 + localStorage 缓存**（阶段2 connector 已收口，2026-06-11）：绑定权威源是 sidecar 落盘的会话文件（`GET /acp/sessions` 列出），前端启动时经 `BindingStore.hydrate` 合并（sidecar 优先、本地新改动不被覆盖、cache 独有条目保留）；localStorage `uw.acp.sessionAgents` 降级为 warm cache。清 WebView 数据/换设备后绑定**自动恢复**。唯一空窗：绑定后未发首条 prompt（sidecar 无记录）——丢的是零历史空会话，回落 opencode 无损失。注意：hydration 在 AgentProvider 挂载 + ACP health OK 后才完成，期间靠 cache 先行。
- **ACP 会话历史持久化（W4b 已实现）**：sidecar 把整形后的 `{info, parts}` 落盘 `~/.local/share/ultrawork/acp-sessions/<sid>.json`（数据进 xdgData 与 opencode 存量同级，**不是** `~/.config`；env `ACP_DATA_DIR` 可覆盖）。重启后历史从 store 服务（`GET /acp/session/:id/messages`）；agent 上下文在下次 prompt 时经 `session/load` 懒恢复，**replay 事件全部抑制**（不用于渲染）——claude-code-acp 实测 `loadSession: true`。
- **session/load replay 抑制的 idle 窗口必须从 RPC resolve 起算**（无条件重置 lastUpdateAt）：agent 可能在响应 RPC 之后才继续流 replay 通知，否则漏入 shaper 造成重复渲染。常量 `REPLAY_IDLE_MS=80` / `REPLAY_MAX_MS=5000`（acpx）。
- **TurnShaper 的 id 必须带 epoch**（W4b 实测 bug）：shaper 重建（重启/重连）后 seq 从 0 重计，新轮次 message/part id 与持久化历史**完全相同**→新轮覆盖旧历史而非追加（前端渲染同样被覆盖）。id 格式 `acp_msg_<sid>_<epoch>_<seq>`，epoch = Date.now 36 进制 + 实例计数。
- **Codex CLI 原生不说 ACP，经官方 npm 桥 `@agentclientprotocol/codex-acp` 接入（2026-07-17，ADR-060，5 轮真机 spike）**：Codex 只原生支持 MCP（openai/codex#9085），桥把 codex runtime 包成 ACP-stdio agent。接入 = `bunx @agentclientprotocol/codex-acp`（**不带 --bun**，桥自带 @openai/codex 重运行时；与 gemini 同因）。实测契约：① **协议**——桥（`@agentclientprotocol/sdk@1.2.x`）与本仓库客户端（`sdk@0.25.0`）**协商到 protocol v1**，wire 协议整数与 npm 包版本号解耦，无需 bump 本仓库 SDK。② **认证**——`NO_BROWSER=1` + 零 env key 即复用 `~/.codex/auth.json`（本机 ChatGPT/API 登录）；`NO_BROWSER` 只隐藏浏览器登录法广告、不影响缓存登录；未登录者先 `codex login`。③ **沙箱/审批 = `INITIAL_AGENT_MODE` 选**（桥 env，非 `CODEX_CONFIG` 顶层键——后者传 `approval_policy`/`sandbox_mode` 实测**不生效**）：`agent`（默认，workspace-write+on-request）/ `read-only`（每写都 escalate）/ `agent-full-access`（never+无沙箱）。④ **权限门对 codex 通用生效**——codex escalate 时经 `session/request_permission` → 我方 `requestPermission` 发 `permission.asked`（与 claude/gemini 同一条事件，Team 弹窗通用渲染），回批准后工具解锁执行（read-only 下越界写 perm 轮实测往返打通、文件真落盘）；**无死锁**（默认模式多数自决、无人应答 300s 兜底拒绝）。⑤ **默认 agent 模式取舍**——工作区内写自动放行、越界 `apply_patch` 写被 codex **硬拒**（用户看到"被拦"但无"允许"按钮，非死锁 turn 干净结束）。能力：`loadSession:true`、`image`+`embeddedContext`、reasoning 流。复验台 = `packages/agent/acp-client/scripts/spike-codex.ts`（tool/escape/perm 三模式）。**⚠️ 两层独立、勿混淆**：codex 弹权限确认有**两个正交来源**——（A）**沙箱层** = codex 自己的 `INITIAL_AGENT_MODE`（`agent` = workspace-write，工作区内写大多直接执行、不逐次弹；`read-only` = 每次写都弹）；（B）**编排层** = codex 作 Team Leader 时调 `orchestrator_delegate` 委派 MCP 触发的权限（`team-routes.ts:66` `orchestrate:true` + `team-leader-prompt.ts`），任何 agent 作 Leader 都一样、与 codex 沙箱无关。**后果**：即使选了 `agent`（顺滑、少弹窗），Team-Leader 场景仍会因委派看到弹窗——那来自 (B) 不是 (A)。要观察 (A) 的"写文件不弹窗"效果须在**单 agent 模式**下看（Team 场景被委派弹窗盖住）。单成员 Team 是退化配置，直接执行请用单 agent 模式（详见 ADR-060 使用提示）。
- **thoughtLevel（思考力度）机制**：agents.json per-agent `thoughtLevel` 字段（Settings 表单 select），sidecar 在 session/new·session/load 拿到 `configOptions` 后找 `category:"thought_level"`（或 `id:"effort"`）的 select option，值在选项列表内才调 `session/set_config_option`；选项不存在 / 值不合法 / RPC 失败一律 log + 跳过（**调节旋钮永不阻塞会话**）。effort 可选值随模型动态（claude 0.44 真机 `effort=high` 应用成功）；gemini/qoder 无此 option 自然跳过。UI 固定四档 default/low/medium/high。
- **agent 进程 spawn 细节（PATH + cwd）**：spawn 前 PATH 追加 `~/.local/bin`、`~/.bun/bin`、`/usr/local/bin`、`/opt/homebrew/bin`（打包 Tauri app 的 GUI PATH 找不到 qodercli 之类用户级 CLI；显式 PATH 优先）；`connect(cwd)` 把**首个 session 的 cwd**作为子进程工作目录——qoder 的 execute 工具实测**忽略 session cwd 用进程 cwd**（read 工具却正常），不传 cwd 时命令会跑在 sidecar 自己的目录里。
- **gemini（`bunx @google/gemini-cli --experimental-acp`，2026-06-11 真机）**：① **ACP 模式 + interactive shell（node-pty，默认开）→ shell 工具调用永久挂起**——无错误无超时，与运行时（bun/node）和 folder trust 均无关；唯一解 `tools.shell.enableInteractiveShell: false`，且该设置**无 env/flag 形式**，只能经 `GEMINI_CLI_SYSTEM_SETTINGS_PATH` 指向 settings 文件。② 未信任目录 headless 直接拒绝执行（`GEMINI_CLI_TRUST_WORKSPACE=true` 解；Ultrawork 自己的权限回环仍是真正闸门）。③ npm wrapper 会用 process.execPath relaunch 自己——bunx 下落到 **bun 运行时**且多一层进程（三阶段关闭看不见）；`GEMINI_CLI_NO_RELAUNCH=true` 保持单进程。→ 三件套 + 托管 settings 文件（`~/.config/ultrawork/gemini-acp-settings.json`，存在则不覆盖）由 `applyGeminiQuirks`（acp-connection.ts）**自动注入**，显式 agent env 永远优先。④ **不发 usage**（tokens/cost 恒空，页脚自然隐藏）。⑤ **shell 工具默认拦截命令替换**——含 `$(…)` 的命令直接 `Blocked: command substitution detected`（tool 帧报 completed、output 是拦截文案，turn 正常继续解释），写验收用例时命令避开 `$()`。⑥ thought/loadSession/权限 kind 全正常；凭证 `~/.gemini/`（Google 登录，**免费档日配额低**——密集真机回归一天可耗尽 `TerminalQuotaError`）；bunx 首启下载 ~17s（30s initialize 超时内）。
- **claude-agent-acp ≥0.44 支持 `_meta.systemPrompt`（2026-06-12 真机验证）**：`session/new`/`session/load` 参数 `_meta.systemPrompt` —— string 形式 = **整体替换** system prompt；object 形式 = **preset append**（`{append: "..."}`，type/preset 被锁定为 claude_code，保留 Claude Code 自身提示）。Team 页 Leader 注入用 object append 形式；重启经 session/load 重注入（manager 持久化 `systemPrompt` 字段）。**其它 adapter（gemini/qoder）不支持** → sidecar 退化为「首条 prompt wire 前置」（`ACPConnection.prompt` 的 systemPrefix 只上 wire，shaper 用户回显保持干净文本）；判定函数 `supportsMetaSystemPrompt`（spawn command 含 `claude-agent-acp`，agents.json `metaSystemPrompt` 字段可显式覆盖）。
- **qoder（`qodercli --acp`，1.0.4 真机）**：① **权限请求有自身内部超时**——不等回复几十秒内自动放弃（tool→error + 答案「permission timed out, try again?」并正常 end_turn），用户须尽快批复；迟到的回复无害（RPC 仍被 resolve，agent 忽略）。② execute 工具忽略 session cwd（见上方 spawn cwd 条目，已修）。③ **发 usage**（input/output tokens 有、无 cost、reasoning 0）→ token 页脚有数据。④ 连接极快（~0.5s，本机已装无 bunx 下载）；loadSession 恢复上下文正常；stdout 无噪音问题（SDK ndJsonStream 对非 JSON 行本就 log+skip 容错）。⑤ 登录态走本机 qodercli 已有凭证，env `QODER_PERSONAL_ACCESS_TOKEN` 可选。
- **hermes（NousResearch hermes-agent，`hermes acp`，0.16.0 真机，2026-06-13；branch A 零 bespoke 成立）**：① **启动 = `command:"hermes" args:["acp","--accept-hooks"]`**。hermes 是 **Python 包**（venv，非 node 二进制）；安装后 `hermes` 启动器落 `~/.local/bin`（已在 acp-connection `EXTRA_PATH_DIRS`），故能找到——但 venv 里的 `hermes-acp` 入口**不在 PATH**，所以用 `hermes acp` 子命令而非 `hermes-acp`。② **`--accept-hooks`** 是无 TTY 自动放行 shell hooks 的 headless 闸（`HERMES_ACCEPT_HOOKS=1` 等价），类比 gemini 的 interactive-shell——别去掉，否则配置了 shell hook 的环境会卡批准。③ **协议 v1 协商成功**（hermes 用 Python `agent-client-protocol 0.9.0`，`PROTOCOL_VERSION=1`，与我们 SDK 0.25.0 一致）；caps `loadSession:true` + `promptCapabilities.image`。④ **整形开箱即对**（user echo → `[reasoning, tool, tool]`/`tool-calls` → `[text]`/`stop`），**无 shaper / acp-connection / DEFAULT_AGENTS 改动**——和 gemini/qoder 同构，仅 `agent-templates.ts` 一条 chip。⑤ **发 usage**（input/output tokens，**无 cost**，类 qoder）→ token 页脚有数。⑥ 认证走 hermes 自己的 `~/.hermes`（custom endpoint，本机 qwen3.7-max；`hermes model` / `hermes acp --setup` 配），与我们 XDG 隔离无关；模板默认无需 env。⑦ 自带 `search_files` 等只读工具不触发 ACP `request_permission`（读类直接执行）。验证：spike（库级）+ GUI（Chrome+Vite）+ headless API（REST 全链路 14 断言）三轨全过。
- **ACP agents.json 现已跟随 `XDG_CONFIG_HOME` 隔离（2026-06-23 修复；此前是测试隔离缺口）**：`agents-config.ts` 的 `CONFIG_DIR` 早先**硬编码** `homedir()/.config/ultrawork`、忽略 `XDG_CONFIG_HOME`——即便 `XDG_CONFIG_HOME=/tmp` 起隔离 acp sidecar，增删 agent 仍读写**真实** agents.json。现改为经 **`config-paths.ts` 的 `resolveConfigDir()`/`configFile()` SSOT**（镜像 Rust `global_config_dir()`：XDG_CONFIG_HOME 非空则 `$XDG/ultrawork`，否则 `~/.config/ultrawork`），与 opencode 配置同一隔离命名空间；生产默认（XDG 未设）路径不变。**同 sidecar 的另两处 config 文件一并收口到同一 SSOT**：`gemini-acp-settings.json`（`acp-connection.ts`，此前同样硬编码 homedir、是同类残留缺口）+ `sidecar-auth.json` 读取（`opencode-credentials.ts`，原本就 XDG-aware，顺带修掉 `??` 把空串当合法路径的边角）。三者从此一起移动、不再有"半隔离"分裂（生产 sidecar 经 `spawn_sidecar` 继承桌面 `XDG_CONFIG_HOME`、无 `env_clear`，故与 Rust 侧始终一致）。**测试隔离铁律仍建议保留**：设了 `XDG_CONFIG_HOME` 的隔离栈现在天然不碰真实 agents.json，但若走查**未设 XDG**（直接用真实 `~/.config/ultrawork`），仍须 `cp -a` 备份 + md5 基线、走查后还原校验。凭证用 `OPENCODE_SERVER_PASSWORD`/`ULTRAWORK_SIDECAR_PASSWORD` env 覆盖，避免碰真实 sidecar-auth.json。
- **ACP `prompt()` 有工具感知两级 idle 看门狗 + sealed 防僵尸（2026-06-24，ADR-034，headless 14/14 实证）**：`acp-connection.ts` 的 `prompt()` 阻塞到 `conn.prompt` 返回 StopReason，agent 经 `session/update` 持续推活动；若 agent **完全静默**（无 update）就会永久挂、桌面会话转圈。看门狗（`Promise.race(promptPromise, idleWatchdog)`）：① **三级 limit**——有工具在跑（`activeTools` 非空，按 `tool_call`/`tool_call_update` 的 `in_progress`/`completed`+`failed` 增删 `Set<toolCallId>`）用 `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认 10min，治 gemini interactive-shell 类挂死工具）；否则按是否「已开口」选 `ACP_PROMPT_TTFB_TIMEOUT_MS`（默认 90s，首个**内容帧**前）或 `ACP_PROMPT_IDLE_TIMEOUT_MS`（默认 30s，开口后）。② **`sawFirst` 只认内容帧**（`agent_message_chunk`/`agent_thought_chunk`）——`plan`/`usage_update` 打头不算「已开口」，否则会把 TTFB 提前降级成 30s 误杀（Claude 系有 plan 帧）；③ **工具完成（activeTools 清空）时重置 `sawFirst=false`**——ACP 整回合一个 `prompt()`，工具后 agent 重读大上下文产答案的首字要重获 TTFB，否则卡 30s 误杀。④ 触发时 `cancel(sessionId)`（best-effort 停 agent）+ 抛 plain Error → `failTurn` 发 `session.error` → 桌面解锁（502）。⑤ **并发护栏**：同 session 已有在飞 prompt 直接 reject（`promptActivity` 按 sessionId keyed，并发会串扰看门狗）。⑥ **`TurnShaper.sealed`**：`endTurn`/`failTurn` 封口、`startTurn` 解封，`handleUpdate` 封口时早返回——abort 后 agent 在 cancel 落地前继续吐的 chunk 不会在 `session.error` 之后再开新消息（僵尸内容）；meta 帧本就 no-op 故零回归。**对称于 opencode 侧 llm.ts idle guard**（见 §1）。常量 env 可调、lazy 读（便于测试/ops）。

## 9. Orchestrator（编排，:4099 `/orchestration/*`，`@agent/orchestrator`）

> 阶段3 第一批（ADR-031）实测坑点。

- **两类 backend 的 prompt 语义不同，await「turn 完成」必须分支**：`OpenCodeBackend.prompt` 走 `POST /session/:id/prompt_async`（**204 即 resolve，≠ turn 完成**），终态只能等事件；`ACPBackend`/InProc 的 prompt **阻塞至 StopReason**（resolve 即终态）。编排层统一封装在 `runTurn`（orchestrator/src/turn.ts）——新代码不要直接 `await connector.prompt()` 当完成。
- **opencode 终态用双信号 + 残留 idle 防误判**：`session.status` idle 事件偶发丢失（gateway 曾为此加 3min 兜底），`runTurn` 同时认 assistant `message.updated` 的 `finish && finish !== "tool-calls"`；且 **idle 只在本 turn 已见 busy/message 活动后才算数**——订阅先于 prompt，prompt 落地前可能收到上一轮的残留 idle。每步另有硬超时必杀（超时/abort 先 `connector.cancel` 再抛）。
- **编排子会话防侧栏污染（双机制）**：ACP 子会话**不传 `clientSessionId`** → 无 opencode twin 天然不可见（sidecar 里 id 是 UUID 形态）；opencode 子会话带 `parentID` 挂到**跨目录隐藏父会话**（`~/.local/share/ultrawork/orchestrator-hidden` 下，每 run 懒建一个）——`roots:true` 列表过滤 + desktop SSE 插入分支的 `parentID` guard 双保险。**vendor `POST /session` 接受跨目录 parentID**（真机验证，不校验父会话同 directory）。
- **headless run 的子会话权限必须有人应答**：子 agent（如 claude 写文件）发 `permission.asked` 时没有打开的会话页，orchestrator 把它 relay 成 run 事件流的 `step.permission`，run 详情页内联应答（ACP 走 `/acp/session/:id/permission`，opencode 走 api.replyPermission）；不答会挂到 sidecar 的 5min 默认 deny（`ACP_PERMISSION_TIMEOUT_MS`）+ 步骤超时兜底。对已 resolve 的权限重复应答返回 404，无害。
- **run 重启不续跑**：步骤是带副作用的 LLM turn 无幂等保障，sidecar 重启时 running/pending run 一律标 `interrupted`（in-flight step → failed "sidecar restarted"），UI「再跑一次」= 同 recipe 新 run。
- **产物契约靠 prompt 文本约定**（`artifacts.ts buildStepPrompt`）：交付物路径以「（覆盖写）：<path>」行注入，步骤结束 `existsSync` 校验，缺失即 step failed——改契约文案时注意 orchestrator 测试里按此正则解析。
- **delegate 工具防递归是注入侧双保险，不靠深度参数**（第二批 ②）：ACP 子会话 = InProcACPBackend 恒传 `orchestrate:false`（mcpServers 不含 shim，物理无工具）；opencode 子会话 = 每个子 turn 的 prompt 带 `tools:{"orchestrator_*":false}`——vendor 把它落成 **sticky session permission deny**（`session.permission` 持久在会话上，steer 后续轮也安全；GET /session/:id 可见该 ruleset，真机验证）。`POST /orchestration/delegate` 的 depth 恒 0→1，若注入护栏被绕过深度护栏不防递归（接受的残余风险，闸门在注入侧）。
- **阻塞式 delegate 的 MCP 超时三件套**：shim 等待期间每 10s 发 `notifications/progress`（须有 progressToken；vendor `callTool` 带 `resetTimeoutOnProgress:true`，真机 3 帧验证）+ opencode mcp 配置 `timeout:600000`（注意该字段**同时是 connect 超时**，别设过大）+ claude adapter spawn env 兜底 `MCP_TOOL_TIMEOUT=1800000`。
- **list_agents 给 LLM 的状态语义 ≠ 传输层连接态**（2026-06-12 Tauri 真机）：ACP agent 懒连接，未发首条消息前 `conn.status` 恒 disconnected——直接透给 shim 的 `list_agents` 会让 Leader 拒绝委派（qwen3.7-max 真机：「acp:claude 离线」全派 opencode）。`/orchestration/agents` 只透出真实 `error`，其余一律 `available`（delegate 自动连接）；Leader 提示另有「状态离线也照常委派」双保险。新增 LLM-facing 状态字段时谨记：**模型会按字面语义行动**。
- **opencode 主对话有两个「委派」工具并存**（D-8 预言，真机证实）：内置 `task`（只能派自家 subagent）与我们的 `orchestrator_delegate`（跨厂商）。提示词只说「用 delegate 工具」时 qwen 会选内置 task——需要跨厂商委派时主 agent 的指令要点名 `orchestrator_delegate`（工具 description 已写明差异，但模型不保证选对）。
- **delegate-mcp shim 的 stdout 归 MCP 协议**：`acp-client delegate-mcp` 子命令分发在任何 server/manager 初始化之前，日志只走 stderr；新加启动期代码不要在分发前 console.log。
- **「编排模式」Settings 开关已移除（017 第三批，2026-06-12）**：全局 orchestrator MCP 注册降级为 Team 页内部静默 ensure（`lib/orchestrator-mcp.ts`，KB MCP 同模式，幂等）。vendor 仍无 `DELETE /mcp`——条目一旦写入全局 config 即常驻，**安全性靠 prompt 级 deny 闭环**（见下条），不再靠开关。
- **OpenCodeBackend.prompt 的 tools 缺省 = `{"orchestrator_*":false}`（017 拍板 #4 闭环点，2026-06-12）**：connector 层所有**未显式传 tools** 的 opencode prompt 自动 deny delegate 工具——普通会话物理无编排能力；显式传 map 的调用方（orchestrator 子会话 / Team Leader）自管。gateway IM 链路不走 connector，bridge.ts 单独恒传同 deny。**新代码注意：经 connector 发 opencode prompt 时「不传 tools」≠「不限制」**；真要放开 delegate 工具必须显式传含该工具的 map（如 Leader 的 `{"task":false}`）。
- **Team Leader 会话机制（017 立 / 018 改，2026-06-12）**：**018 A-4 起 Leader 是 ROOT 会话**（创建不挂父、不传 title → 进侧栏混排 + opencode 自动标题生效；Team 身份只由注册表标记，desktop 经 `TeamSessionsProvider` 查询）。隐藏 `[team]` 父机制已从 team-routes 移除——**delegate 子会话的隐藏父（`[delegates]`）不变**。ACP leader 仍复用「opencode twin + binding」范式（twin 即 root，ACP 会话 `clientSessionId=twin id` + `orchestrate:true` + systemPrompt）。注册表 `~/.local/share/ultrawork/team-sessions.json`（sidecar 持有，env `TEAM_SESSIONS_FILE` 覆盖）。**opencode leader 的编排指令每轮经 `promptAsync system` 参数携带**（vendor 语义 = agent base prompt 后追加、per-message 不 sticky）+ 每轮 `tools:{"task":false}` deny 内置 task（sticky）——真机：qwen-plus 不点名工具即自发同轮并行调 `orchestrator_delegate` 跨厂商委派并汇总标注来源。
- **018 存量（挂隐藏父的）Team 会话靠「补显」而非迁移**：vendor `PATCH /session/:id` 只支持 `title`/`time.archived`，**parentID 不可改**——`use-sessions.ts` 对「registry 有、roots 列表无」的条目按 id `getSession` 合入侧栏，SSE 插入分支的 `parentID` guard 对 team id 放行（`teamIdsRef`）。legacy 条目标题是 vendor 默认「Child session - <ts>」（旧机制创建时不传 title 且子会话无自动标题），显示链 `session.title → registry title → id`。
- **Team 成员选择是双层强制（018，2026-06-13）**：成员选区原本只是 Leader system prompt 里的软约束，且旧 prompt 还叫 Leader「用 list_agents 核对成员」——但 `/orchestration/agents`（list_agents 数据源）返回**全局所有** agent，与 Team 成员集无关，导致 Leader 委派给选区外的 agent（真机：选 opencode+claude 却派了 gemini+qoder）。现为双层：prompt 把 roster 设为唯一权威 + 禁止委派清单外；服务端 `teamMembersForWorkspace(workspace)`（team-store，按 workspace 取所有 Team 成员**并集**）在 `/orchestration/delegate` 拒非成员（403）、`/orchestration/agents?workspace=` 过滤。**关键约束**：全局 delegate shim 进程只拿得到 workspace、拿不到具体 Team 会话 id（MCP 工具调用不携带宿主会话上下文），所以只能按 workspace 并集 scope；多 Team 共享同一 workspace 时允许集会放宽为并集（已知窄残留）。改 Leader 提示词或成员逻辑时注意这条双层闭环。
- **成员 403 强制是「纵深防御」而非硬隔离——可被自报非 Team 的 cwd 绕过（已知限制，019 pre-merge review #3，2026-06-13）**：上一条的服务端校验是 `scope = body.workspace ? teamMembersForWorkspace(body.workspace) : null`，**仅当该 workspace 下确有 Team（scope 非 null）时才校验**。而 delegate-mcp shim 的 workspace 取自 `input.cwd ?? ULTRAWORK_DELEGATE_CWD`，cwd 完全由 LLM 自报（opencode leader 的全局 MCP entry 没注入 `ULTRAWORK_DELEGATE_CWD`，本就必须自报）。一个被提示注入/越界的 Leader 若传非 Team 的 cwd（如 `/tmp`），`teamMembersForWorkspace` 返回 null → 跳过 403 → 可委派给全局任意 agent。根因：服务端无法把无状态全局 shim 进程绑定到具体 Team session，只能信任 model 自报的 workspace。**处置（拍板：文档化为已知限制，不硬化）**：第一道闸是 Leader system prompt（roster 唯一权威 + 禁清单外委派），服务端 403 是配合的纵深防御边界，正常 prompt 不触发，仅对抗/注入场景失守。真要硬隔离需让 delegate 链路携带可信的 Team session 绑定（改动大，留待有真实威胁模型时做）。**别把代码注释「a Leader can never reach an agent the user didn't pick」当硬保证**。
- **委派成员的产物来自子会话、不在 Leader 转录（018，2026-06-13）**：产物区（`artifacts-panel.tsx`）只扫描当前会话的消息提取文件；但 Team 委派出去的成员是在**各自子会话**里写文件的，那些 write/edit 工具调用不在 Leader 转录里——靠正则扫交付物文本抓路径极不可靠（成员交付物措辞带不带绝对路径全凭运气）。正解：orchestrator `collectDeliverable` 在拉子会话历史时提取 write/edit/create/patch 的文件路径 → 放进 D-2 契约 `artifacts` 字段 → 桌面 `artifacts-panel` 解析 delegate 工具输出 JSON 的 `artifacts` 并入产物区。改委派/产物逻辑时记得这条数据流（产物路径随交付物走，不靠文本正则）。
- **`collectDeliverable` 千万别对工作区做 fs 扫描来抓 bash 副作用产物（2026-06-16，差点踩）**：Leader 默认**同轮并行委派多个成员、且都 `cwd = 同一个工作区`**（见 `team-leader-prompt.ts`）。若在 `collectDeliverable` 里 `scanWorkspaceFiles(workspace, startedAt)`，并发成员 A/B 的文件 mtime 全 ≥ 彼此的 startedAt → A 的 `artifacts[]` 串进 B 的文件（`endedAt` 上界也救不了——生命周期重叠）。**mtime 在共享目录下无法区分并发委派是谁写的**。故 D-2 `artifacts[]` 只取**子会话自己转录里**的 write/edit 工具路径（per-child 准确）；成员的 bash 副作用产物由**桌面 Leader 面板自己的回合窗扫描**兜住（成员在 Leader 工作区、Leader 委派回合内写，落在 Leader 回合窗 → 被扫到）。要 per-delegate 精确隔离只能给每个 delegate 独立 worktree（Fan-out 已支持 `isolation:"worktree"`）。
- **opencode 会话的 model 是会话粘滞的**（018 走查实测）：首轮 prompt 未显式传 model 时按 server config 默认解析并**固化到该会话**，后续轮不传 model 也沿用首轮的——server config 改了默认 model 只影响新会话。无 git 的目录放 `opencode.json` 不会被当 project config 拾取（project root 探测依赖 git），workspace 级默认 model 对临时测试目录无效，须走 server 级 `PATCH /config`。
- **worktree 隔离的输入产物要复制进 worktree**（`worktree.ts stageInputs`）：子 agent cwd 沙箱在 worktree 里，引用主 workspace 绝对路径会触发跨目录读权限弹窗（claude）；产物完成后拷回主 run 目录、worktree 成功即删失败保留（`step.worktreePath` 暴露）。
- **worktree 的回收有三条分支，别把它们记成一条（2026-07-30 soak 实测）**：`completed` 与 `cancelled` 都调 `removeWorktree`（cancel 那条的注释写明「取消没有排查价值」），**只有 `deliverable missing` 那条刻意保留整个 worktree 供排查**。所以「失败保留」只覆盖失败，不覆盖取消。
- **`createWorktree` 建的是 `<root>/<runId>/<stepId>` 两层，早期只回收了 `<stepId>` 那层（已修，2026-07-30）**：run 级父目录由 `mkdirSync(dirname(dir))` 建出来，而**全仓没有任何代码删它** ⇒ 每个用过 worktree 隔离的 run 永久留一个空目录。71 分钟 soak（523 个 run）实测残留 168 个、其中 166 个全空，杀 sidecar 重启也不回收（无启动清理 / 无 TTL / 无上限）。只漏 inode 不损数据，但无界。现于 `removeWorktree` 末尾补一次 `rmdirSync(dirname(dir))`。**用 `rmdir` 而非 `rm -r` 是全部安全论据**：只在父目录已空时才删 ⇒ fan-out 中仍在跑的 sibling、以及刻意保留的失败 worktree，都会让它无害失败。fan-out 并行形状必须单独验（`inputs` 相同的 worker 会并行起多个 worktree），串行链的 recipe 覆盖不到。

- **`delegate.snapshot` 只重放 delegates，不重放待答的权限请求**（ADR-048 实测，2026-07-11）。新订阅者拿到的首帧里没有任何 pending permission，所以**任何持有该状态的组件一旦卸载重挂，那条权限行就永久消失** —— 子 agent 会一直阻塞到 sidecar 超时，界面上无任何线索。
  → 因此 `useDelegateRows` 必须挂在 **Session 级**（组件之上），`DelegateDock` 退化为纯渲染。布局变化（如全屏预览把 dock 从会话列 re-parent 到底部栏）在 React 里等于卸载 + 重建，state 放组件里必丢。

## 10. 内置技能（built-in skills，`skills/builtin/` + Settings 技能页）

- **Anthropic 官方 docx/pdf/pptx/xlsx 文档技能是专有许可、禁止再分发**（`anthropics/skills` 各目录 `LICENSE.txt`）——**不能打包进 ultrawork**。判定捷径：**LICENSE.txt 1467B ≈ 专有 / 11345B ≈ Apache-2.0**。故 PDF 用 OpenAI 的 Apache 版（`openai/skills/.curated/pdf`），Office 读改自写：docx/xlsx 见 059 S3/S4 的专用技能，.pptx 就地读改见 `pptx-edit`（原 `doc-edit`，059 S6 瘦身改名）；长尾格式转换用 `markdown-exporter`（md_exporter）。新增内置技能前**先核对该目录 LICENSE 是 Apache-2.0/MIT 等可再分发许可**。
- **skill 以 frontmatter `name` 索引、不是目录名**（vendor `skill/index.ts:86`，zod `Info.pick({name,description})`）——`zod .pick` **剥离未知 frontmatter 键**，故自定义键（如 `x-requires`）安全、不破坏发现；也意味着目录名与 `name` 可不一致（如 `markdown-exporter`）。同名 skill 在同一次 glob 扫描里 unbounded 并发 add、谁赢不确定（仅 `duplicate skill name` warn）——**builtin vs 用户安装的同名竞态已由 Rust `reconcile_builtin_shadowing` 在文件层根治**（见下方遮蔽条目，ADR-040 阶段 2）。
- **内置技能注入走方案 C（解压落地），不动 opencode.json（2026-07-03 起 zip 分发，原松散树拷贝）**：bundle 携带单个 `skills-builtin.zip` + 并排**外置** sentinel `.builtin-version`（`scripts/pack-builtin-skills.ts` 构建期从 git 松散树 `skills/builtin/` 按内容 hash 惰性打包，beforeDev/beforeBuild/build-release 自动跑）；`ensure_builtin_skills` 首启解压到 `~/.config/ultrawork/skills/builtin/`，被 `{skill,skills}/**/SKILL.md` 自动扫描。**sentinel 控升级刷新，刷新只 `remove_dir_all(builtin/)`——绝不碰同级用户安装技能**（用户/skill-installer 装的技能落在 `skills/<name>`，是 `builtin/` 的兄弟，不在刷新范围）。唯二会动用户目录的入口：`remove_user_skill_override`（用户在设置页显式点「恢复内置」）；唯一会按用户状态删 builtin 子目录的：遮蔽 prune（见下方遮蔽条目）。收益：app Resources 53MB/1.2 万文件 → 10MB/4 文件（mac 签名公证与 CI 打包显著提速、MSI 复活前提成立），首启解压实测 ~1.3s。
- **Tauri `bundle.resources` 对 `..` 源路径的落地层级不确定**：array/glob 形式会把 `..` 改写成 `_up_` 段，map 形式按 value 直放——跨版本/平台有差异。**不要硬编码资源子路径**；`find_builtin_source` 用**有界递归查找 `.builtin-version` 锚点**兼容 map/glob/`_up_` 三种布局。`resource_dir()` 在 `tauri dev` 与打包态解析到不同目录（dev=target 下，打包=`.app/Contents/Resources`）。
- **运行依赖检测靠 `rich_path()` 而非 `std::env PATH`**：Finder 启动的 app 只有最小 PATH，`check_skill_dependencies` 复用 `rich_path()` 探测 python3/node/pandoc/soffice/pdftoppm/git/markdown-exporter。**Python 解释器版本 / pip 库现在可探**（2026-07-02 起，ppt-master 引入）：`run_python_feature_probe` 对解析到的 python 跑一次 `-c`（`sys.version_info>=(3,10)` + `importlib.util.find_spec('pptx')`，find_spec 不真 import、快且无副作用）→ `python3.10+`/`python-pptx` 两个虚拟依赖项。`pptx-edit`（原 `doc-edit`）059 S6 起声明 `python3 + python-pptx`——它瘦身后剩下的两个脚本都无条件 import pptx，只检 python3 会把一台跑不了任何东西的机器显示成「就绪」。**动任何技能的依赖声明，四处必须同步**（漏一处 CI 就红，2026-08-04 又走了一遍）：① `skills/builtin/<skill>/SKILL.md` 的 `x-requires`（人读）· ② `use-skill-deps.ts` 的 `BUILTIN_DEP_MAP`（徽标 SSOT）· ③ `src-tauri/src/lib.rs` 的 `PY_MODULES`（**只有 pip 库需要**，它是解释器内 `find_spec` 探测表，PATH 类工具不在这里）· ④ `__tests__/lib/skills-builtin.test.ts` 断言 key 集合。**改技能名同理**，另加 e2e 的 `BUNDLED` 列表与 `test-skill-originality.py` 的 `OWN_SKILLS`。⚠️ **这条规则本身腐烂过：四处里只有 ②③④ 有测试，① 没有**，于是 059 S3.5 给 deckcraft 的 `BUILTIN_DEP_MAP` 加了 12 个 source reader 而 `x-requires` 停在 4 个，漂了整整一个阶段。2026-08-05 起由 `skills-builtin.test.ts` 的「x-requires ↔ BUILTIN_DEP_MAP 对账」双向守着（直接 import 映射表不解析 TS + 断言真的扫到 ≥11 个技能目录）。**一条没人检查的规则会腐烂，和一条没人检查的 SKILL.md 声明是同一件事。**
- **python 探针的四个防御（改探针前必读，均有 cargo 单测）**：① `check_skill_dependencies` 必须是 `#[tauri::command(async)]`——探针 spawn 真进程，同步跑在主线程会卡 UI、病态解释器会永久冻结 app；② `run_probe` 统一 **5s 超时 + 超时 kill + Windows `CREATE_NO_WINDOW`**（防挂死探测态转圈 / GUI 下黑窗闪现）；③ **macOS 无 CLT 时 `/usr/bin/python3` 是 Xcode shim，执行它会弹系统"安装开发者工具"对话框**——`python_probe_allowed` 先跑 `xcode-select -p`（无害）判定 CLT 在位才执行；④ **Windows 回退候选 `python`**（python.org/winget 只装 `python.exe` 不装 python3；商店 App-Execution-Alias 假可执行靠"执行式探针非零退出"天然过滤，不能靠 is_file 判断）。
- **探针刻意锚定 `python3` 命令而非任意 python3.x（引导收敛标准）**：ppt-master 脚本通篇裸调 `python3`，所以徽标以「PATH 上 `python3` 解析到的那个解释器」为准——用户装出 `python3.11` 版本化命令而 `python3` 仍是 3.9 时徽标继续红是**正确行为**（真机验收实测踩过：AI 引导安装装了 uv 的 python3.11 就交差）。两道防线：`depGuidePrompt` 写死收敛标准（新终端 `python3 --version` ≥3.10 且 `import pptx` 成功，版本化命令须 symlink 指过去）+ 徽标 tooltip 透出实际探测的解释器路径（`DepStatus.path`，显示 `[/usr/bin/python3]`）。另注意 zsh 老会话有 command hash 缓存，`hash -r` 或开新终端才能看到新 symlink；技能运行时每次新起 shell、无此缓存。
- **内置技能落地是「解压到 staging + rename」原子交换，sentinel 后置写入**：`install_builtin_tree`（lib.rs）把 zip 解压到 `skills/.builtin.staging`（点目录，opencode `{skill,skills}/**` glob 不带 dot 选项扫不到），**zip 内刻意不含 sentinel——全量解压成功后才把外置 sentinel 写进 staging 再 rename**，不变式强化为「sentinel 可见 ⇔ 整树完整」（中途退出/磁盘满只会留下旧一致树或无树，有 cargo 测试锚定 extract-先于-删旧树 的顺序）。staging（`.builtin.staging`/`.builtin.restore`）每次调用先经 `clear_staging` 清理——**必须用它而非裸 `remove_dir_all`**（后者对预置 symlink 静默失败，解压会穿透写进 link 指向的外部目录）；**install/reconcile/override 三入口由 `BUILTIN_SKILLS_LOCK` 串行化**——async 命令（thread pool）并发共享固定 staging 路径时，两个 restore 交错可让 rename 落一棵残缺树且 sentinel 仍有效、永不自愈（对抗审查实证的组合竞态）。
- **同名遮蔽（builtin vs 用户安装）= Rust 文件层确定性裁决（ADR-040 阶段 2，2026-07-02，真机全链验证）**：`reconcile_builtin_shadowing`（`ensure_builtin_skills` 内，启动/设置页挂载/刷新/恢复/工作区切换都跑）保证扫描面上同名只剩一份——**prune**：存在同名（按 frontmatter name 匹配，目录名无关）用户技能 → 删 builtin 磁盘副本，**用户版永久胜出、跨 app 升级不回退**，直到手动移除；**restore**：用户版移除 → **按技能前缀从 bundled zip 选择性解压**（component 级 strip_prefix，`ppt-master-extra` 不误配；0 匹配报错防空树自愈死循环）经 `.builtin.restore` staging+rename，restore 门=「SKILL.md 精确大小写存在」而非目录存在（残缺树/普通文件占位自愈）。bundled 名单枚举=读 zip central directory 里恰为 `<dir>/SKILL.md` 的 entry（复用 `skill_registration_name_from_str` 谓词；**顶层目录名拒绝 dot 开头/含 `\` 或 `:`**——恶意 `../SKILL.md` 否则可把 prune 指向 skills 根；坏 zip fail-open 空名单、不 prune 不 restore）。UI=设置页内置区遮蔽卡 +「移除用户版本，恢复内置」（`remove_user_skill_override`：只认 shadowed 名 + under-root 双护栏 + **拒绝经 symlink 祖先删除**——`remove_dir_all` 会穿透 link 真删外部源文件；直接 symlink 的安装只删 link 不删目标，Windows 目录 symlink 用 `remove_dir`）。curated 推荐安装 = 该机制的自助更新通道（`INSTALLABLE_SKILLS` 条目 `method:"git"` → prompt 强制 `--method git`，skill-installer auto 模式会先下数百 MB 整仓 zip）。
- **遮蔽判定必须镜像 opencode 注册谓词、整块验证、一律 fail-open**：opencode 注册要求 frontmatter **name+description 双必需**（gray-matter+js-yaml+fallbackSanitization+zod pick），且 frontmatter **任一行**让 js-yaml 两轮都抛错（`key:value` 冒号后无空格、未闭合引号/flow、重复 key、tab 缩进、开栏栅非列 0、栏栅未闭合、`description: # 注释`=null）都会**跳过整个文件不注册**。Rust `skill_registration_name` 是整块保守 validator：拿不准返回 None=不 prune（fail-open，最坏=竞态残留）；反方向错误（把 opencode 不注册的目录当用户版去 prune）会让技能两边皆无、凭空消失。配套「全部真实 bundled SKILL.md 必须解析通过」cargo 回归防误伤自家技能。另一坑：`dir.join("SKILL.md").is_file()` 在大小写不敏感 fs（mac/Win）会匹配 `skill.md` 而 opencode glob 不会——判定用 read_dir 精确大小写匹配（`exact_skill_md`）。
- **「Rust 动了磁盘」必须让前端跟进软刷新——`changed` 协调契约**：reconcile 返回 `changed` 标志（本次 install/prune/restore 动了磁盘），`useBuiltinShadow` 的 state 与返回值**同一对象**（identity 去重依赖它，别 clone），SkillsSection 用 `handledStatusRef` 对每个 changed status 精确一次跟进 `useSkills.refresh()`（soft refresh + 重取），否则 UI 会同时显示两份/列出文件已被删的技能。**命令「先变更磁盘、后返回 Err」时 changed 信息随 Err 丢失**（如 stale 遮蔽卡：pre-check reconcile 已 restore 内置、随后拒绝 override 删除）→ 前端 catch 路径不能只 reconcile resync（第二次 reconcile 对已稳态磁盘报 changed:false、协调 effect 不触发），必须**无条件链 refresh**。已知残余边界（刻意）：reconcile 只覆盖 config-dir `skill|skills` 两根——`~/.claude/skills`、`~/.agents/skills`、project 目录、`cfg.skills.paths` 里的同名仍竞态；mid-session 安装后、下一个 reconcile 触点前的新 instance 扫描仍可短暂竞态（workspace 切换已补 best-effort invoke 收窄）。
- **ppt-master（MIT，pin v2.12.0）专属注意——P3 起「curated 可安装、非内置」**：2026-07-18（ADR-061 / discussions/043 §18.5）deckcraft 毕业为做 PPT 的默认技能后，**内置 ppt-master 整树已删**（`fetch-builtin-skills.ts` 的 SOURCES/`applyPptMasterPatches`/`X_REQUIRES` 条目一并移除）；ppt-master 仅保留为 `INSTALLABLE_SKILLS` 的 curated 长尾退路（`method:"git"`，装到 `~/.config/ultrawork/skills`，**无 builtin 副本可遮蔽**）。**用户安装后**仍适用的坑：① **图片生成 API key `.env` 放 `~/.ppt-master/.env`（上游原生支持）或工作区 `./.env`**，别放技能目录；② 八项确认/实时预览走本地 `localhost:5050` 网页（confirm_ui 与 svg_editor 分时共用端口，chat fallback 是上游一等公民）——刻意不改成 question dock；③ 单次完整 deck 生成消耗几十万 token 是上游刻意设计（主模型逐页手写 SVG、禁子代理），用户侧要有成本预期。历史（bundle 期）的 fetch sparse/post-patch/drop 复核细节见 git history + discussions/025 §9。
- **zip 分发管线坑点合集（2026-07-03，八路对抗审查产出，改 pack/extract 前必读）**：① Rust zip crate `enclosed_name()` 对绝对路径条目是**消毒**（剥前导 `/`）而非拒绝——防篡改需显式 raw name 检查（extract 已拒 `/` 开头、`\`、`:`、symlink entry；**凡从 entry 名派生再用于 join+删除的路径必须同套设防**）；② pack/fetch 的 sentinel hash 算法**必须逐字节一致**（对账不变式，改一处同步另一处）——2026-07-03 起喂「相对路径+`\0` 分隔」（裸 basename 对目录改名/文件搬家失明→会发布陈旧 zip）；③ tauri v2 string 形式 beforeDevCommand 是 **wait:false**（spawn 后轮询 devUrl 不等退出）——孤儿 vite 占 1420 时 cargo build 与钩子并发，钩子产出的构建产物必须 temp+rename 原子落位且 **tmp 名带 pid**（并行 e2e/dev+release 共享固定 tmp 名会互相截断）；hooks cwd=frontend dir（含 package.json 的 CLI 调用目录）；④ `tauri::generate_context!` **编译期**要求 bundle.resources 源路径存在——gitignore 的构建产物目录须以 `.gitkeep` 入 git，否则 CI 裸 cargo test 编译失败；⑤ fflate zipSync `os:3 + attrs:(0o100000|mode)<<16` 保 unix exec bit（Rust 侧解压回写 `mode & 0o777`）；unzipSync **不暴露 attrs**（e2e helper 不恢复 exec bit 的已知分叉）；⑥ **Windows CI 打的 zip sentinel 与 git 提交值不同**（CRLF checkout 改文本字节，仓库无 .gitattributes）——per-platform 自洽（zip+sentinel 同一次遍历产出、同机比对），别拿 sentinel 跨平台对账；⑦ bump 复核项：Windows 保留设备名（CON/PRN/…）/尾点尾空格未设防（pack 期不报、用户首启 File::create 才炸）；文件名含 `:`/`\` pack 期已 fail-fast。
- **deckcraft（自写，HTML-first PPT，ADR-061）专属注意**：① **P3 已毕业为做 PPT 的默认技能**（2026-07-18，ADR-061 / discussions/043 §18.5）——description 从验证期窄触发放宽到接管「做PPT/生成PPT/演示文稿/幻灯片/slides/deck」全意图；内置 ppt-master 已删、ADR-040 的「两 tab 同见 ppt-master」混合形态随之消解（ppt-master 转 curated 长尾退路，见上一条）；② **浏览器双清单同步义务**：`find_chrome.py` 候选集必须 ⊇ Rust `detect_chrome`+`detect_export_browser` 清单（绿徽标必须蕴含脚本可用，反向红灯可用可接受）——两侧都有交叉注释，改一侧必查另一侧；③ **skill 工作目录必须点目录**（`.deckcraft/`）：中间文件（页面片段/截图/spec_lock/tokens.css 等几十个）放点目录才不淹没产物面板，交付走 `export_deck.py --publish`。**血泪（真机走查暴露）**：产物面板有**两条来源**且对 dotdir 处理曾不一致——Rust fs 扫描器（`lib.rs` `collect_changed_files`，`name.starts_with('.')` continue）跳 dotdir，但前端 tool-derived 提取器（`artifacts-panel.tsx` `extractArtifacts`，从 Write/Edit 工具调用抠路径）**原本零 dotdir 过滤**，agent 写进 `.deckcraft/` 的文件照样泄漏进面板。已在两源共同入口 `isValidArtifactPath` 补对称的 dotdir 过滤（拒绝相对路径含 `.` 开头目录段）。**点目录不足以隐身、还需 tool-derived 侧同样过滤——两侧都要**；④ shell.html 模板**注释里不能出现字面 `{{占位符}}`**（build 的全局 str.replace 会把内容塞进注释——曾致 split 数出 2 倍页 + 截图全白）；⑤ **headless `--print-to-pdf` 会执行页面 JS**：屏幕适配脚本写的 inline zoom（旧为 transform）会污染 PDF（默认视口 800px → 全 deck 缩 60%），解法=`@media print` 里 `#stage{zoom:1!important}`（stylesheet !important 压 inline style；见 ⑬）；⑥ `__pycache__` 绝不能进技能树（pack hash 漂移 → 全量重打包 + 存量用户技能重装；pack JUNK 集与 .gitignore 已双重设防，本地跑过 skill 脚本后提交前自查）；⑦ **P2b 可编辑 pptx（`--pptx-editable`）：pptxgenjs 官方 `dist/pptxgen.bundle.js` 在 Node `require()` 下返回的是 JSZip 不是 PptxGenJS**（那是浏览器 `<script>` UMD，外层 `module.exports=t()` 里 `t()` 产出的是内联的 JSZip）——必须用 **esbuild 自打包 CJS 单文件**（`entry.cjs = module.exports=require('pptxgenjs')` → `esbuild --bundle --platform=node --format=cjs`）才拿到 PptxGenJS 类，产物 vendor 进 `scripts/html2pptx/vendor/pptxgen.vendor.cjs`（零 node_modules——`node_modules` **不在** pack JUNK 排除集，走 `npm i` 会把整个 node_modules 打进 zip 污染 sentinel；单文件避开）；⑧ **Node 双清单同步义务**（与②浏览器同构）：`find_node.py` 的嵌入式路径（`~/.ultrawork/node/{bin/node|node.exe}`）+ 版本门必须与 Rust `get_node_path_internal`/`embedded_node_bin`/`detect_system_node`（≥18）一致——徽标 `node` 由 Rust 探针算、脚本按同规则找，改一侧查另一侧；⑨ 可编辑 pptx 的**中间产物（layout.json / raster/ 裁剪图）必须落 `export/` 目录**（`out_dir`，已被 pack `isGeneratedDir` 与 .gitignore 双重排除）——写到项目根会污染产物面板 + 改动例子字节基准；⑩ 坐标映射 SSOT 在 Node 侧（1280px 舞台恰 96 px/in → `in=px/96`、`pt=px×0.75`），抽取侧（scale 1）与栅格化裁剪侧（device-scale-factor 2）**同用 per-page 隔离页**（丢掉 fit() 脚本、slide 在 0,0），故 bbox×2 对齐 2x 截图；⑪ **Team 委派下 question 门不可达（已知限制，2026-07-18 全分支审查发现，defer 修复）**：deckcraft 两轮 question（Phase 2/3，SKILL.md 硬门禁无降级）在**单 agent 直连 opencode 正常**；但 Team 模式 Leader 委派给 `opencode:default` 子会话时，子会话抛的 `question.asked` 被 `delegate.ts` 的 `onEvent` 丢弃（它**只中继 `permission.asked/replied`**，不中继 question），子会话阻塞到 orchestrator `timeoutMs`（默认 600s）超时失败。根因是既有 Team 委派架构缺口（delegate 从来只中继 permission），deckcraft 是首个把 question 设为核心硬门禁的默认技能才暴露它。**规避**：Team 场景直连而非委派跑 deckcraft。**根治**（follow-up）：delegate `onEvent` 对称中继 `question.asked/replied` 到 DelegateDock + 前端支持回答委派会话的 question；⑫ **内联进页面的 `<script>`（PROBE_JS / extract_layout 注入脚本）源码与注释里绝不能出现字面闭合 script 标签**（`<` + `/script` + `>`）：HTML 解析器在 script-data 状态遇到该序列立即闭合 script 元素——写在注释里也照样触发，会把脚本从中间截断、measure()/抽取器不再运行、`__probe__`/`__layout__` 节点不生成 → 门以「no report」失败。血泪：修「可见文本含该标签致 json.loads 崩溃」时，第一版修复的**解释性注释里**写了字面标签、自身复现同一 bug，经 Chrome `--dump-dom` 实测才定位。转义用 `String.fromCharCode(60)`（`<`）拆分、`fromCharCode(92)`（`\`）+`u003c` 拼 JSON unicode 转义，避免源码里出现字面 `<` 与多层反斜杠转义（selftest 锁「extract survives </script> in visible text」）；⑬ **fit 脚本用 `zoom` 缩放、不用 `transform:scale`（+ 负 margin）**（discussions/050，2026-07-22，取代 ADR-062 的 transform+translateX 方案）：`.stage` 固定 1280px，`transform:scale(s)` **不缩布局盒**、`scrollHeight` 仍是未缩放全高 `h`，而负 `marginBottom` 补偿又**改不动 `scrollHeight`**（负 margin 只减 body 高度、盒子仍溢出到 `h` 并计入滚动区）→ 应用内预览（面板 <1312px → s<1）**末尾留 `(1−s)·h` 大片深色可滚空白**（真机 lhopital 14 页 vw=1188 实测 983px；`scrollHeight==offsetHeight` 排除 margin-collapse）；直接开文件因浏览器窗口 ≥1312→s=1 不缩放故正常，独立 HTML 无此机制也正常。解法=`st.style.zoom = min(1,(vw-32)/1280)`：**zoom 同时缩布局+绘制**，`scrollHeight` 自动=视觉高度、无空白；横向居中交回 `.stage{margin:0 auto}`（zoom 后正确居中），删掉 translateX / 负 margin / `h` 缓存（后者顺带消除「字体/图片未加载完就采集 `h`」的时序隐患）。`@media print` 从 `#stage{transform:none!important}` 改 **`#stage{zoom:1!important}`**（headless print-to-pdf 会先跑 fit 写下 zoom≈0.6，须压制）。`probe_overflow.py`/`--shots`/`extract_layout.py` 拆单页且**丢弃 fit 脚本**、原生 scale=1 → PDF/pptx 零影响。护栏：e2e `html-preview-iframe.e2e.ts` 断言从 transform 改 zoom + **新增「末页下方无空白 gap≤30px」门禁**（旧机制此处 ~950px）；改 `shell.html` 后照例重跑 pack + 同步两 sentinel。lucide 版本坑（顺带）：0.562 把 `FileVideo`→`file-play`、`FileAudio`→`file-headphone` glyph 别名，断言 lucide 渲染 class 时以实际 glyph 为准（`lucide-<glyph>`）；⑭ **`--c-on-dark` 是深底页专用浅字，放到浅卡片上近乎隐形**（ADR-067 / discussions/052，2026-07-23 真机暴露）：模型偶发把 S04 栏头染成 `--c-on-dark` 留在 `--c-bg2` 浅卡片上 → 对比度 **1.10:1**。**注意这不是引导缺失**——`layouts.html` 模板与三个内置 example 的 S04 栏头全是正确的 `--c-primary`（9.96:1），正确 few-shot 齐备模型仍偏离，故**纯改文档不保险**，已加机器门禁：`probe_overflow.py` 逐文本元素测 WCAG 对比度（前景 computed `color` + **合成**背景——合成是关键，只有它能区分同一个 on-dark 色在 `data-dark` 页正确 vs 在浅卡片是缺陷，静态 lint 做不到），双档下界 **2.3:1 正文 / 1.8:1 large**，报 `CONTRAST` 行即判负。**合成必须取真实绘制栈（`elementsFromPoint`）而非只走祖先链**：浅字绝对定位压在**兄弟**深色块上时（观感完全可读）祖先链只看到卡片浅底 → 误杀合法设计，该假阳性由自测抓出并已修（命中测试看不到元素时退回祖先链降级）。**读不懂的颜色语法（`oklch()`/`color()`/`lab()`）必须计数并播报，绝不静默跳过**——静默会让「0 low-contrast」实际等于「一个都没检查」，是门禁唯一不能有的失败模式（首版就是静默，已修）。**阈值别顺手调低**：它由四例 369 个实测元素标定（合法最低 2.57 = showcase 大号装饰数字，缺陷 1.10），discussions/052 的手算表预测 3.61 偏高、照抄会误杀；新配色触线先看 `--dump-contrast` 判断是真缺陷还是调色板本身偏浅。透明字与 `background-image` 底刻意不判负（宁漏报不误杀）；⑮ **headless `--window-size` 是外窗、真实视口更小**（ADR-068，2026-07-24 实测）：macOS headless 固定吃 **87px**（720→633、1400→1313，与窗口高无关）→ `document.elementsFromPoint` 在视口高度以下**返空栈**，依赖命中测试的逻辑**静默退回次优路径**（probe 曾因此在每页底部 12% 退回祖先链、丢掉脚注/页码/来源标注区的对比度判定）。修=窗口给足余量（现 `1280×1400`，slide 恒 720、多余是空白无成本）**＋页面里自检 `document.documentElement.clientHeight` 装不下即 `exit`，绝不静默降级**。凡用 `elementsFromPoint`/视口坐标做判定的 headless 脚本都要先自检视口；⑯ **`getComputedStyle().backgroundImage` 认不出 `<img>`/`<svg>`/`<video>` 元素**（只反映 CSS `background-image`）：文字压在 `<img>` 上时「背景不可读」检测会漏，拿覆盖层颜色合成到白底当真背景＝**一个自信的错数比一个声明的盲点更糟**。修=遍历绘制栈时同时按 `el.tagName` 判 IMG/SVG/VIDEO/CANVAS，标记为不可判（不判负，宁漏报）；⑰ **CSS 变量 token 化的三个隐形失效**（ADR-068）：(a) 页面**内联硬编码同名尺寸＝token 白做**——四例里 19 处 `width:48px;height:8px` 手抄版绕开 `--bar-w`/`--bar-h`，改风格骨相看不出变化，**必须用结构类（`.bar`）承载、禁内联硬编码**；(b) **注释里连写 `*/`**（结构层注释写 token 通配 `--sl-*` 紧跟 `/--fw-*`）提前终止 `<style>` 注释、吞掉后续整段规则（症状＝版面**整体错位**而非局部溢出，probe 从 0→69 overflow；排查＝`git archive HEAD` 抽纯净副本 A/B）；(c) **门禁读 `tokens.css` 前必须 `re.sub(r"/\*.*?\*/"," ")` 剥注释**，否则注释里的 `/* --radius: 圆角用 */` 假声明被当真（放宽 E3 白名单 / 凭空造 O10 越界）。深色风格 `--c-primary` 曾同时当「data-dark 底」与「浅底标题墨色」（相反明度）已由新增 `--c-head` 语义 token 修，详见 ADR-068 D8。
- **SKILL.md 里指向别的技能，指错了没人会告诉你——除非门禁去看**（2026-08-04 起 `check-docs.ts` §11）。`description` 是模型路由的**唯一依据**，指向一个不存在的技能，agent 找不到就**静默退化成不用技能硬写**，看起来只是「这次没用技能」。059 §1 的 `doc-export` 断链（三处）是靠人肉读 SKILL.md 才发现的；S6 把 `doc-edit` 改名时，`pdf`/`xlsx` 的 description 里各有一处「that is `doc-edit`」会当场变断链。§11 认四种写法（`x` 技能 / `x` skill / that is·use the·install `x` / 列举 `a` / `b` / `c` 技能），合法目标 = `skills/builtin/` 下真实目录 **+** 设置页 `INSTALLABLE_SKILLS`（`ppt-master` 不内置但指它是对的，名单从 Settings.tsx 现读不另抄）。⚠️ **中文引导词「改用/安装」必须同行有「技能」二字才算**——deckcraft 写着「就改用 `python`」指的是命令名，第一版因此误报。`bun run --bun scripts/check-docs.ts --selftest` 是它的 11 条正负控制（负向复刻的是真实出过的错误写法），CI 与全量扫描一起跑。
- **更新内置技能用 `scripts/fetch-builtin-skills.ts`**（上游 tarball / 大仓库 sparse clone + 打补丁 + 注入 `x-requires` + 写 NOTICE + 刷新 `.builtin-version`；支持按名过滤 `bun run --bun scripts/fetch-builtin-skills.ts pdf`——避免顺带把 pin 在 main 的其它技能拉到未审内容），结果**提交入库**。**不要手改 `skills/builtin/{skill-creator,skill-installer,pdf,markdown-exporter}/`**——重跑脚本会覆盖；`deckcraft` / `docx` / `xlsx` / `pdf` / `pptx-edit` 是自写、可直接改（deckcraft 改后须重跑 `pack-builtin-skills.ts` 并把 `resources/builtin-skills/.builtin-version` 同步写回 `skills/builtin/.builtin-version`）。skill-installer 的安装目标已由脚本补丁从 `$CODEX_HOME/skills` 改指 `~/.config/ultrawork/skills`（装到 `builtin/` 同级，免被 sentinel 刷新清掉）。

## 11. OpenCode 配置 / 数据路径地图（隔离机制 SSOT，2026-06-23）

> 「Ultrawork 到底读写哪些 opencode 配置路径」的单一权威清单。背景决策见 ADR-020（配置隔离）/ ADR-028（sidecar 副本 + 凭证）。

- **隔离总开关 = `OPENCODE_APP_NAME=ultrawork`（编译期 source patch，不是运行时代码）**：`patches/vendor-opencode-config-fix.patch` 把 vendor `global/index.ts:7` 改成 `const app = process.env.OPENCODE_APP_NAME || "opencode"`，烤进 opencode sidecar 二进制。Tauri 启动 opencode-server 时注入该 env（`lib.rs:1957`）→ 所有 xdg-basedir 派生目录从 `opencode` 切到 `ultrawork`。**没有这个 patch 就退回 `~/.config/opencode`、与真实 opencode CLI 撞库**——它是整个隔离的地基，不是死代码。bump vendor 时逐 hunk 复核（Patch 5 `config.json→opencode.json` 等可能被上游原生采纳；当前 pin 1.3.13 上 5 hunk 全部仍需要）。
- **派生路径（patch 后自动跟随 app name）**：

  | 路径 | 用途 | 决定方 |
  |------|------|--------|
  | `~/.config/ultrawork/` | **全局配置**：`opencode.json`(MCP/provider/skills/models) · `sidecar-auth.json`(凭证 0600) · `agents.json`(ACP) · `skills/builtin/` · `gemini-acp-settings.json` | Rust `global_config_dir()`(`lib.rs:1223`，尊重 `XDG_CONFIG_HOME`) + vendor xdg-basedir |
  | `~/.local/share/ultrawork/` | **数据**：`opencode.db` · `auth.json` · `mcp-auth.json` · snapshot · worktree · `acp-sessions/`(§8) · `orchestrator-hidden/` · `team-sessions.json`(§9) | vendor `Global.Path.data`（patch 后跟 app name；env `ACP_DATA_DIR`/`TEAM_SESSIONS_FILE` 可覆盖子项） |
  | `~/.cache/ultrawork/` | models.json · skills · bin | vendor `Global.Path.cache` |
  | `~/.local/state/ultrawork/` | plugin-meta · locks | vendor `Global.Path.state` |
  | macOS `/Library/Application Support/ultrawork` | system-managed config | patch 后 `systemManagedConfigDir()`(config.ts:63) |
  | `~/.ultrawork/` | **非 config**：sidecar 二进制副本 · 默认 workspace · 嵌入 node · browser MCP · chrome-profile（与 opencode 配置解析无关，见 §6） | Rust 独立管理 |

- **被刻意排除的路径（隔离关键）**：patch（`config/paths.ts`）在 `OPENCODE_APP_NAME` 设置时**跳过 `~/.opencode/` home 目录搜索** → 原生 opencode CLI 用户的 `~/.opencode/` 配置**不会泄漏进 Ultrawork**；同时 `config.ts` 的 endsWith 过滤改认 `.ultrawork` 后缀。
- **各 sidecar 的 env 注入差异（易踩）**：只有 **opencode-server** 拿 `OPENCODE_APP_NAME`（`lib.rs:1957`）；**acp-client / gateway / knowledge sidecar 都不带它**——它们不直接解析 opencode 配置路径所以无需要（acp-client 只拿 `PATH`+`OPENCODE_SERVER_PASSWORD`，见 `lib.rs:1932`）。生产环境**四个 sidecar 都不被注入 `XDG_CONFIG_HOME`**（继承用户 shell 环境，通常未设）。
- **`agents.json` 现跟随 `XDG_CONFIG_HOME` 隔离（2026-06-23 已修，曾是与 §8 同源的缺口）**：`agents-config.ts` 早先硬编码 `homedir()/.config/ultrawork`、无视 XDG，设了 `XDG_CONFIG_HOME` 时与 opencode 配置劈叉。现 `config-paths.ts` 的 `resolveConfigDir()`/`configFile()` SSOT 镜像 Rust `global_config_dir()`（读 XDG_CONFIG_HOME 否则回落 `~/.config`，再接 `ultrawork`），与 opencode-server 同一命名空间；生产默认路径不变。**sidecar 内三处 config 文件（agents.json / gemini-acp-settings.json / sidecar-auth.json）全部走这一个 SSOT**，不再各自硬编码。详见 §8 对应条目。
- **改全局 config 想"即时生效"别用 hard `invalidate`——它 `disposeAll` 会中止所有在流回合（ADR-039）**：opencode 的 `Config.invalidate()`（`PATCH /global/config` 缺省路径、`config.ts`）= `invalidateGlobal` + **`Instance.disposeAll()`**，而 `disposeInstance` 运行 `SessionPrompt` runner 的 finalizer → `Fiber.interrupt` → `llm.ts acquireRelease` `ctrl.abort()` → **真正 abort 那个实例所有正在流式的回合**。所以"在设置页改/加/删 provider"若走 hard 路径，会把**所有**工作区（含 Team 并发委派）正在流的回合一起打断。反过来：单纯从外部进程（Rust）写全局 `opencode.json` **运行时不生效**——全局 config 是无限 TTL 缓存（`cachedGlobal`）、**配置目录无 file watcher**、`POST /instance/dispose`/`/global/dispose` 都**不**刷全局缓存（只清实例缓存后又从无限缓存重读旧全局）。**正解 = 软刷新**：`PATCH /global/config?refresh=soft` / `POST /global/refresh` → `Config.refreshGlobal()` 只惰性驱逐**配置派生纯缓存**（config/provider/provider-auth/skill/agent/command/format/tool-registry，经 `InstanceState.makeSoft` 标记 + `soft-invalidate-registry`），**绝不碰活资源**（流式 runner/MCP 子进程/LSP/PTY/watcher/Bus）→ 即时生效且不打断在流回合。Ultrawork 的 `patchGlobalConfig` 已默认带 `?refresh=soft`。**判断标记 (A) 可软失效 vs (B) 必存活**：看该 `InstanceState` 的 init 有没有注册 `addFinalizer`/`acquireRelease` 杀活资源——有就是 (B)、绝不能 soft。**已知限制**：软刷新不覆盖 MCP/plugin/LSP 配置变更（它们是 (B)，需 hard/重启）；但 MCP 走 Rust 持久化 + `POST /mcp` 本就 live、不依赖此机制，API key 也不进缓存（`Auth` 每次读 `auth.json`）。**bump 连带**：(A)/(B) 分类基于 v1.3.13 的 `InstanceState.make` 站点；上游若新增 state，按"有无杀资源 finalizer"归类，纯配置缓存才标 `makeSoft`。
- **自定义 provider 配置是全局的（ADR-039，2026-06-30 起）**：经 `PATCH /global/config`（`patchGlobalConfig`）写 `~/.config/ultrawork/opencode.json`，**不再** per-workspace（旧 `PATCH /config` 写 `<workspace>/opencode.json` 的行为见本节上方 line 36 仍适用于 `model` 选择等其它 key）。换工作区不丢、无工作区也可配。**存量坑**：opencode 合并顺序"全局先、项目后"、**项目优先级更高**——老用户在某工作区残留过 `provider`/`disabled_providers` 会**遮蔽**新全局值（编辑看似无效），需手删该工作区 `opencode.json` 的对应块。`model` 选择仍刻意 per-workspace（会话粘滞，见 §9）。**同类（ADR-042）**：手写的 `<workspace>/opencode.json` 里若有 `experimental.websearch` 也会遮蔽全局——设置页只读写全局，会出现"设置页显示已启用但该工作区工具不见了"；Ultrawork 自己不往工作区写这个键，仅手工编辑会触发，排查时手删该块即可。

## 12. 跨平台（macOS / Windows / Linux，ADR-037，2026-06-27）

> 正向模式见 `docs/conventions.md` §13。这里是**实测/分析确认的反向坑**。强制门禁 = `.github/workflows/ci.yml` 三平台矩阵。

- **进程销毁不等后台线程 ⇒ 「已升屏障」不代表「已清理干净」（ADR-055，2026-07-13）**：两条退出路径都在 `shutdown_sidecars()` 一返回就把进程干掉——信号路径 `std::process::exit(128+sig)`，`RunEvent::Exit` 返回后由 tao 终止。**没有任何东西会等后台线程把它欠下的清理做完**。所以一个卡在 `spawn_sidecar` 里的线程（子进程已 fork、尚未登记注册表）不是"晚了一步"，而是**即将连同它欠下的 `kill_pid` 一起被销毁**；那个子进程既不在被 `mem::take` 抽空的注册表里、也不在已被删除的 `ports.json` 里 ⇒ 下次启动的 `reap_orphaned_sidecars` 同样找不到它 ⇒ **永久孤儿**（动态端口下 `prepare_port` 也看不见）。**一个原子 bool 屏障只能定所有权，定不了时序**：必须用锁把「查屏障→spawn→登记」和「升屏障→抽空注册表」变成互斥的原子步骤（`SPAWN_LOCK`）。同理 `write_ports_json` 的屏障检查必须在 `PORTS_JSON_LOCK` **之内**、且 `remove_ports_json` 也要持同一把锁，否则一个刚就绪的 sidecar 会把已被删除的 `ports.json` **写回来**。
- **超时常量之间要交叉核对，否则"兜底"会变成 bug 源（ADR-055）**：渲染端的启动门原设 20s，而 Rust 侧自己的最坏合法启动是 `MAX_START_ATTEMPTS(3) × 15s = 45s`（还没算首装的文件开销）⇒ 兜底会在**合法的慢启动**上触发、把 UI 渲染到一个尚未就绪的后端上，正好破坏它本该保护的不变量。同理前端 splash 的兜底必须**严格晚于**该门（否则会把 splash 从一个 React 还没渲染的空 `#root` 上摘掉 ⇒ **把白屏造回来**）。当前：门 90s < splash 兜底 120s。

- **本机 `cargo check` 不编译 `#[cfg(windows)]` 分支**：macOS 上 `cargo check`/`cargo test` 只编译当前 target，`#[cfg(windows)]` 属性门控的代码**完全不参与编译/类型检查**——写错了本机发现不了，只有 Windows CI 才报。**所以 Rust 跨平台优先用运行时 `if cfg!(target_os = "windows") { … }` 分支**（`cfg!()` 是编译期 bool，所有分支都编译），仅平台专属 API/crate 才用 `#[cfg]` 属性。
- **比较「路径是否在工作区内」不能用裸 `startsWith`（ADR-052，2026-07-12）**：Windows 上两边的分隔符**真的会不一致**——工作区根从 Rust 来是 `C:\\ws\\proj`（`PathBuf`），而模型写 `write` 工具调用**惯用正斜杠** `C:/ws/proj/out/a.pdf` ⇒ `startsWith` 判「不在工作区」⇒ **产物被整个丢弃，侧栏和转录区都没有，且无任何提示**。同一个裸 `startsWith` 还有**兄弟目录前缀碰撞**（root `/ws/proj` 会把 `/ws/proj-old/a.pdf` 判成「在里面」，再吐出垃圾相对路径 `-old/a.pdf`，三平台都中）。正确做法：比较前把 `\\` 归一成 `/`（长度不变，所以按 root 长度 slice 仍成立），且必须校验**结尾分隔符**（`f === r || f.startsWith(r + "/")`）。见 `artifacts-panel.tsx` 的 `withinRoot`/`toRelative`。
- **`process.env.HOME` 在 Windows 是 `undefined`**：曾导致 knowledge sidecar DB 路径变 `undefined/.ultrawork/...` 初始化失败。一律 `os.homedir()`（已修，`knowledge/sidecar/index.ts`）。
- **Renderer 跑在 WebView，没有 `node:path`**：`.tsx`/`src/lib`/`src/components` 里**不能 import `node:path`**。用 `@/lib/path-utils`（`pathBasename`/`isAbsolutePath`/`shortenPath`，同吃 `/` 和 `\`）。`fs.watch` 在 Windows 给反斜杠路径——段过滤要 `split(/[\\/]/)`（已修 `watcher.ts`）。
- **`split("/")` 不全是路径**：URL（`part.url`）、provider/model id（`anthropic/claude-x`）的 `/` 是恒定逻辑分隔符，**不要**当路径改成双分隔符——会误伤。改前先判断语义。
- **Bun Shell `$` 的内置命令跨平台、但 `chmod` 不是**：`mkdir`/`cp`/`rm`/`mv`/`cat`/`which` 是 Bun Shell 跨平台内置（Windows 也能用，不依赖 cmd）；**`chmod` 不是内置**，Windows 上会「command not found」抛错——必须 `if (process.platform !== "win32")` 守卫（已修 `build-opencode.ts`）。
- **`signal-hook` 是 unix-only crate**：放 Cargo.toml `[target.'cfg(unix)'.dependencies]`，否则 Windows 编译拉它失败。`install_signal_handlers()` 走 `#[cfg(unix)]` 真实现 + `#[cfg(not(unix))]` no-op；Windows 退出清理只靠 Tauri `RunEvent::Exit` + 下次启动 `prepare_port` 自愈。
- **`lsof`/`ps`/`pgrep`/`/usr/bin/which`/`open`/`kill` 全 unix-only**：Windows 等价 `netstat -ano`(端口→PID) / `where` / `taskkill /F /PID`。lib.rs 已抽 `pids_on_port`/`kill_pid` 跨平台 helper + `PATH_LIST_SEP` 常量。**杀进程统一走 `kill_pid()`、勿直调 `Command::new("kill")`**（曾在 `start_sidecar` 漏一处，review 抓到）。
- **「打开文件 / 在文件管理器中显示」别手搓 `Command`**：用 `tauri-plugin-opener`（`app.opener().open_path(path, None::<&str>)` / `reveal_item_in_dir(path)`，内部 ShellExecute/`open`/xdg-open）。手搓 Windows `cmd /C start "" <path>` 有 **cmd 元字符注入面**（文件名含 `& % ^`，产物名半可信）且对正斜杠不可靠——opener 插件规避这一切。
- **Tauri `externalBin` 自动解析 triple + `.exe`**：conf 里写 `binaries/opencode-server`（无后缀），Tauri 按当前 target 找 `opencode-server-<triple>[.exe]`。构建脚本产物命名必须严格对齐（已对齐，含 windows-x64）。`bundle.targets` 用 `"all"` 让 Tauri 按平台产对应安装包（Windows/Linux 实际由 `build-release.ts` 的 `--bundles` 特判收窄，见下条）。
- **Windows MSI 曾因超大资源树停用、2026-07-10 已恢复（ADR-046 / discussions/030）**：`bundle.resources` 带 ppt-master（1.2 万文件、深图标路径）时，WiX v3 `light.exe` 在链接期直接挂（`failed to run ...WixTools314\light.exe`）；ADR-041 把该树 zip 化（File Table 1.2 万行→3 行）后前提消失，`chore/msi-probe` 分支 workflow_dispatch 实证 `--bundles nsis msi` 全绿并产出 `Ultrawork_x_x64_en-US.msi`（**187.6MB，比 NSIS 胖 ~58MB**，WiX cabinet 压缩率不如 NSIS LZMA）。现 `build-release.ts` Windows 出 `nsis msi`。**注意仍锁 WiX v3.14**（tauri-bundler 自建管线，无 WiX 4 配置项）；**MSI 只出 embed 版**（不出 offline MSI——187.6+195≈380MB 不值，§9.3-C）。
- **Windows WebView2：`embedBootstrapper`/`offlineInstaller` 把微软下载从安装期搬到构建期，且无哈希校验（ADR-046 / discussions/030 §9.3-A）**：`tauri-bundler/util.rs` 的 `download_webview2_bootstrapper`/`download_webview2_offline_installer` 用裸 `download()`（HTTPS 但不 pin 哈希，非 NSIS 工具链那套 `download_and_verify`）。且 `webview2_guid_path()` 每次构建都先 HEAD 微软 fwlink、再 `strip_prefix` 断言重定向落在硬编码 CDN 主机 `msedge.sf.dl.delivery.mp.microsoft.com/...`——而 `delivery.mp` 是**地域均衡主机族**，**国内本机 release 构建最易触发 `WebView2 URL prefix mismatch`**（反讽：为解决国内网络引入的 offline 模式恰在国内构建最易炸）。逃生口=预置安装器到 `%LOCALAPPDATA%\tauri`（缓存判据只是「文件存在」，`if !file_path.exists()`）。CI 缓存该目录只省字节传输、**挡不住** prefix 断言（断言在 exists() 检查之前跑）；且静态 cache key + `actions/cache` 精确命中不再保存 ⇒ WebView2 事实上不缓存（tauri 按版本 GUID 分目录，新版会自动重下）。
- **Windows NSIS 产物名写死不可配 → 双包必须中间改名（ADR-046）**：`tauri-bundler` 的 `nsis/mod.rs:652` 把输出硬编码为 `{product}_{ver}_{arch}-setup.exe`，同一 target 跑两次 `tauri build --bundles nsis` 会**静默覆盖**。`build-release.ts` 的 `buildWindowsInstallers()` 先出 embed+msi、把 `-setup.exe` 临时改名 `.embed-stash`，再出 offline（复用同名）改名 `-offline-setup.exe`，最后恢复 embed 名。已核实 `nsis/mod.rs:195` 的 `remove_dir_all` 清的是 `release/nsis/<arch>/` 暂存目录、不是 `release/bundle/nsis/`，故改名后的产物能活过第二次构建。`webviewInstallMode` 配错**不报错**只静默退回默认 → 末尾 fail-closed 断言 offline 比 embed 大 ≥100MB（实测差 195MB）。
- **`lsof -i :PORT` 匹配本地端口**或**远端端口任一命中**（2026-07-09 真 socket 实证，ADR-045 阶段 ①）：`lsof -ti :PORT` 会一并返回「仅仅连接到该端口的客户端」和「出站连接恰好抽到该临时端口的无辜进程」。要**监听者**必须 `-sTCP:LISTEN`；Windows `netstat -ano` 同理须过滤 `State == LISTENING`。旧 `kill_port_process` 因此会杀旁观者——4096-4099 均非 IANA 保留段，撞上完全可能。
- **Linux `ps -o comm=` 截断到 15 字符**（内核 `TASK_COMM_LEN`）：`knowledge-sidecar`(17 字符) 读回来是 `knowledge-sidec`，用它比对进程名必然失配。取进程名三平台**三套源、不可互换**：Linux 读 `/proc/<pid>/exe`（symlink→绝对路径）；macOS `ps -o comm=` 给全路径且不截断；Windows `tasklist /FO CSV`。
- **Linux `/proc/<pid>/exe` 在磁盘文件被替换/删除后 readlink 返回 `…/name (deleted)`**（自动更新、或 `tauri dev` 重编译覆盖旧 sidecar 时**必现**）。比对前必须 `strip_suffix(" (deleted)")`——注意是**空格开头**，`starts_with("name-")` 那类前缀匹配救不了裸名形态。
- **Linux 上 `lsof` 未必存在**（deb 只 `depends: curl`）→ 端口自愈/孤儿检测会静默退化为「什么都没找到」。已在 deb/rpm depends + CI 里显式声明；更彻底的解法是读 `/proc/net/tcp` 去掉该依赖。
- **`bind(0)` → close → 交给子进程 bind 的 TOCTOU 窗口是实证会发作的**（ADR-045）：写测试时被并行兄弟测试的 `bind(0)` 抢走，**6 跑 5 挂**。产品侧没有「换个固定端口」的奢侈，所以**重试循环是必需的，不是保险**。
- **嵌入式 Node / Browser MCP / Chrome 清理三平台已支持（ADR-037 后续移植）**：Windows 的 node 是 `.zip` 布局——`node.exe` 在 dist 根（非 `bin/node`）、`node_modules/npm` 在根（非 `lib/`）、npm-cli 在 `node_modules/npm/bin/npm-cli.js`。移植已覆盖：`get_platform_arch`(win)/`embedded_node_bin`(node.exe)/`download_node`(zip+`tar -xf`)/`resolve_npm_cli`/`npm_install_in`(PATH `;`)/`kill_browser_mcp_processes`(PowerShell WMI+`taskkill /F /T`，no pgrep)。**坑**：① Windows node 用 `tar -xf`（不带 `-z`，bsdtar 自识别 zip）；② 前端 `buildMcpCommand` 的 `homeDir` 正则要吃反斜杠；③ Browser MCP 的 Windows 运行时**只能真机验**（CI/cargo 测不到）——**2026-07-13 已在 Windows 真机验证通过**（v0.2.7：下载 Node → `npm install` → 驱动 Chrome 全链路可用）。前置 Win10 1803+ 的 `tar.exe`/`curl`。

- **GUI 子系统程序派生控制台程序 ⇒ Windows 给它新建一个可见窗口（ADR-054 / discussions/037，2026-07-13）**：release 构建是 `windows_subsystem = "windows"`（`main.rs`），**自身没有控制台**；此时用 `std::process::Command` 起 `taskkill`/`netstat`/`tasklist`/`powershell`/`node`/`curl` 等控制台程序，若不带 `CREATE_NO_WINDOW`（`0x0800_0000`），系统会**为子进程新建一个可见控制台窗口**，子进程退出即销毁 ⇒ 用户看到「闪一下就没了」。退出清理路径曾一次性弹出 **4 个 PowerShell + 每个 sidecar 一个 taskkill**。**Rust 侧一律走 `sys_cmd()` 构造 Command，禁止裸 `Command::new`**（`no_bare_command_new` 单测强制，扫描整个 `src/`；GUI 子进程如 `explorer` 可用同行 `allow-bare-command: <理由>` 豁免）。**dev 构建测不出来**——它自带控制台，子进程直接复用，永远不弹窗。
- **这条规则会「转嫁」：隐藏了父进程，窗口就跑到孙进程身上（同上）**：给 PowerShell 加了 `CREATE_NO_WINDOW` 之后**它自己也没有控制台**了 ⇒ 它管道里 `ForEach-Object { taskkill ... }` 派生的**每个 taskkill 都会被系统分配一个新窗口**（Chrome helper 全带 `--user-data-dir=…\chrome-profile`、全命中 needle ⇒ 可能几十个，**比原 bug 更糟**）。**所以 PowerShell 只能用来枚举、绝不能在里面杀进程**：`... | ForEach-Object { $_.ProcessId }` 把 PID 打回 stdout，由 Rust 侧 `kill_process_tree()` 起 taskkill（GUI 主进程直接派生 ⇒ 走 `sys_cmd` ⇒ 带 flag ⇒ 零窗口）。**同一条转嫁规则的残余落点：`npm install`**（npm 的 postinstall/git/node-gyp 孙进程可能各自弹窗，我们控制不了 npm 怎么 spawn，已知未修）。
- **`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%…%'"` 会匹配到执行它的那个 PowerShell 自己（同上）**：查询串里的 needle **就字面写在 powershell.exe 的命令行里**，所以它满足自己的过滤条件 ⇒ 旧代码把自身 PID 喂给 `taskkill /F` ⇒ **PowerShell 中途自杀、尚未枚举到的 PID 一个都没清理**（WMI 枚举顺序未定义 ⇒ 不确定性失败，Windows 上的浏览器清理很可能**从来没可靠工作过**）。**必须 `| Where-Object { $_.ProcessId -ne $PID }`**。needle 里含 `\ % _ '` 还会破坏 WQL `LIKE`（`browser_mcp_needles_need_no_wql_escaping` 单测守着）。

- **应用内截图 / macOS 屏幕录制（TCC）权限（ADR-056，2026-07-15 实测）**：
  - **`screencapture` 无屏幕录制权限时静默降级**：退出码 **0**、文件正常产出、尺寸都对，但窗口内容被剥光只剩壁纸；**交互式 `-i` 同样被挡**（用户看得见框、能拖选区，截出来还是壁纸 ⇒ 人眼所见 ≠ `screencapture` 所返）。直接 spawn **不会**自动弹授权框。⇒ 必须 `CGPreflightScreenCaptureAccess()` 查授权（**看退出码判成功=假绿**）、`CGRequestScreenCaptureAccess()` 显式拉起（实测**能**弹系统框、可做一键引导），授权后需**重启 app** 才在 preflight 翻 true。成功信号只能是「已过 preflight 闸 **且** 文件非空」。
  - **成功检测必须先 `remove_file` 目标路径**：成功信号是「文件非空」而非退出码；pid 会被 OS 复用、计数器每次启动归零，若崩溃跳过清理留下 `shot-<pid>-0.png`，下次同 pid 首次截图**取消**（不产文件）时会读到那个陈旧文件、误判为新截图并交出**上次的**内容（隐私+正确性）。capture 前 unlink 目标即可堵死。
  - **Windows `ms-screenclip:` 唯一取消信号是超时**：它只写剪贴板、无文件无回调，取消（Esc）时剪贴板不变 ⇒ 只能靠有界轮询超时判取消。所以**抢到冻结快照后要立刻恢复主窗**——否则「隐藏窗口→截图→取消」会让主窗隐藏满整个轮询周期（60s）像卡死。唤起走 `tauri-plugin-opener` 的 Rust API，**不能** `cmd /c start`（ADR-054 闪窗 + 元字符注入）。
  - **`clipboard-manager` 的 `read_image()` 不能在主线程调用**（插件文档明示，Linux 会死锁冻结整个 app）⇒ 放进 `spawn_blocking`。顺带：**Rust 直接调插件 API 绕过 JS 侧 ACL**，所以 capability 里**不要**为此加 `clipboard-manager:allow-read-image`（那只放行 renderer、纯过度授权）。
- **Tauri 打包二进制里 webview 资源是压缩嵌入的 ⇒ `strings`/byte-scan 命令名 grep 不到 ≠ 命令没注册（2026-07-15 血泪）**：Tauri 把前端 JS/HTML 资源**压缩**后嵌进二进制，命令名字符串搜不到是正常的；**命令注册是编译期保证**（在 `generate_handler!` 里且能编译 = 已注册、能路由）。别拿 byte-scan 当「命令是否注册」的 oracle——曾据此误判「release LTO 把某命令 strip 了」并做了无效"修复"，被打包 `.app` 上真实的授权流程当场证伪。**要验命令能否路由，只能跑打包 app 触发它。**
- **`tauri dev` 借的是终端（父进程）的 TCC 身份，不是 app 自己的（2026-07-15 现场确认）**：dev 二进制（`cargo run`/`tauri dev` 从终端拉起、未签名）没有独立代码身份，屏幕录制等 TCC 权限归到「负责进程」= 终端（如 ghostty）。所以 dev 下「截图能截到真内容」用的是终端的授权，**授权引导态（未授权分支）根本测不出**。⇒ **TCC 类功能必须 `tauri:build` 打成 `.app`、从 Finder/Dock 启动**（才有独立 ad-hoc 身份、才在系统「屏幕录制」列表里以 app 名出现、首次截图才弹真授权框）才测得准。从 Terminal/dev 里测的是终端的权限。

- **Windows 的 git 默认 `core.autocrlf=true` ⇒ 任何「按 sha256 核对检出文件」的逻辑在 Windows 上必错**（2026-08-04，L3 语料获取器上 CI 第一跑就红）。检出时 LF 被换成 CRLF，于是在 macOS/Linux 上算出来的哈希对不上，脚本报出的却是别的原因（本仓库当时报的是「许可变了，必须人工复核」——**一个完全误导的结论**）。⇒ 临时克隆一律显式 `git config core.autocrlf false` + `core.eol lf`，让检出**逐字节等于上游**；**不要**改成忽略换行的比较，那会把「文件真的改了」一起藏掉。实测：`.docx`/`.xlsx`/`.pdf` 这类二进制**不受影响**（git 的二进制启发式挡住了），但那是启发式不是保证。同族提醒：`.gitattributes`、`autocrlf=input`、以及 CI runner 的默认值都可能在不同宿主上给出不同字节。

- **`zipfile.namelist()` 不是平台无关的**（2026-08-04，L3 语料实证）。CPython 的 `ZipInfo.__init__` 里有 `if os.sep != "/" and os.sep in filename: filename = filename.replace(os.sep, "/")` ⇒ 一个（违反 ZIP/OOXML 规范地）把条目存成 `xl\workbook.xml` 的档案，**在 Windows 上读回 `xl/workbook.xml`，在 POSIX 上读回 `xl\workbook.xml`**。野外真有这种文件（calamine 语料的 `issue_530.xlsx`）。后果实测：同一份字节，同一个检查，**Windows 放行 / macOS 判「缺 xl/workbook.xml」** —— 两台机器的分母不一样，而两边看起来都「正常工作」。⇒ 凡按名字找 OOXML part 的代码，自己 `n.replace("\\", "/")` 归一化，不要依赖 zipfile 的平台行为。**连带结论：靠 openpyxl/python-docx 打开这类文件的能力也是平台相关的**（它们同样走 zipfile），本仓库有意未改技能行为——文件本身违规，两种行为都说得通，但要知道它不一致。
- **子进程崩溃时打 stderr 的第一行等于什么都没打**：裸 traceback 的第一行永远是 `Traceback (most recent call last):`，异常类型与消息在**最后一行**。本仓库为此白烧过一轮 CI（四份只在 Windows 上崩的文件，日志里全是那句废话，机制只能靠本地反推）。⇒ 报告里遇到 traceback 取**最后一行**。

## 13. 桌面组件测试（vitest + jsdom）

- **页面级组件测试：mock hook 必须返回稳定引用，否则无限重渲染循环伪装成「测试卡死」**：被测组件若有以 hook 返回值为依赖的 effect（如 HomePage 的 `useEffect(..., [agents])` 里 setState），而 mock 每次渲染返回**新对象/新数组**（`useAgents: () => ({ agents: [] })`），依赖身份每轮都变 → setState → 再渲染 → 死循环。症状极具迷惑性：vitest worker 300% CPU 空转数分钟不退出、无任何报错输出。写法：工厂内定义一次 `const value = {...}; return { useX: () => value }`。（`home-workspace-indicator.test.tsx`，2026-07-03 实测）
- **不要用 `importOriginal` 部分 mock 大 barrel（如 `@/components/chat`）**：`importOriginal()` 会实例化整个桶文件的真实依赖树（markdown/代码高亮栈），转换耗时数分钟拖垮 worker。要保留个别真实组件时精确单文件导入：`vi.mock("@/components/chat", async () => ({ CopyButton: (await import("@/components/chat/copy-button")).CopyButton, ChatInput: () => null, ... }))`。（同上）

- **`fireEvent.mouseEnter` 触发不了 React 的 `onMouseEnter`，必须用 `userEvent.hover()`**：RTL 的 `fireEvent.mouseEnter` 派发的是**不冒泡**的 `mouseenter`，而 React 的 enter/leave 是由 root 容器上的 `mouseover`/`mouseout` **委托合成**的 —— 手工派发的那个事件 React 可能根本看不到。**症状极具迷惑性：整文件跑过、单跑（`-t` 过滤）必挂**，且在 CI 的 ubuntu runner 上挂而 mac/Windows 过（2026-07-29 实测，`command-selector.test.tsx`）。`fireEvent.mouseOver(el, { relatedTarget })` 同样不行。正解是 `await userEvent.hover(el)`（`@testing-library/user-event` 已在依赖里），它会驱动 React 需要的完整指针序列。**推论：一条只在某种运行模式下通过的测试，本身就是坏味道，不要靠"整文件跑是绿的"放过它。**
- **e2e 的工作区不能建在系统 tmpdir**（ADR-048 踩坑）。macOS 的 `tmpdir()` 是 `/var/folders/…`，而产物识别的 `TEMP_PATH_RE`（`artifacts-panel.tsx`）**刻意把它当临时路径过滤掉** —— agent 在那里写的文件永远进不了产物列表，测试会莫名其妙地「没有产物」。把沙箱 HOME 留在 tmp，但**工作区放到 `homedir()` 下的临时目录**。
- **产物行的选择器要限定在 `[data-testid="artifacts-panel"]` 内**。「工作区」面板排在产物区之上、同样默认展开、且其文件树会列出同一个文件 —— 无限定的文本匹配会点到那一行惰性文本上，表现为「点了没反应」。（ADR-059 前排在上方的是「执行活动」段，现已移除，但「工作区」段仍在其上、限定依旧必要。）

- **`vi.restoreAllMocks()` 不会清理 `vi.stubEnv()`** —— 必须显式 `vi.unstubAllEnvs()`。曾实际中招：一条「阈值设 0 关闭功能」的测试把 env **泄漏给了后面所有测试**，导致 `/resume` 的用例根本没发生轮转，却以「看起来合理」的方式失败（ADR-051）。
- **给纯函数加「必填参数」比加测试更能防漏传**：`groupSessionsByDate(sessions, t, frozen)` 的 `frozen` **刻意不给默认值**——排序与分组必须读同一个 key，而一个默认值会让调用方静默丢掉它（行在 hover 时跳组），同时单测因为直接传参**保持全绿**。让 tsc 抓，别指望测试（ADR-051）。同理 `ChatInput` 的 `placeholder` 改必填后当场炸出**三个**测试文件在裸渲染（2026-07-30）——可选默认值只能是个未翻译的英文字面量，正是中文界面里将来会冒出来的那句。
- **`fireEvent.keyDown` 在 jsdom 里不执行任何默认编辑行为 ⇒ 任何「按键有没有改动输入框内容」的断言用它写都是假守卫**（2026-07-30 实测三态：`fireEvent` 无论有无 `preventDefault` 都得到 `"hi"`；`userEvent.type` 无 `preventDefault` 得 `"hi\n"`、有 `preventDefault` 得 `"hi"`）。所以 `chat-input.test.tsx` 里 13 条 `fireEvent` 的 Enter 测试只守住了「没调 `onSend`」，**「裸 Enter 不插换行」一条都没守到**——把 `handleKeyDown` 里的 `e.preventDefault()` 整行删掉，那 13 条照样全绿（实跑验证）。要守默认行为**必须用 `userEvent`**（它尊重 `defaultPrevented`），并且被测组件要套一个真受控壳：现有 `defaultProps` 把 `value` 写死，textarea 内容永远不变，断言同样空转。

## 13.1 加长 placeholder 会在极窄宽度被裁切（2026-07-30，composer 提示行实测）

- 会话页 composer 的 placeholder 追加「Shift+Enter 换行」后，在**输入框可用宽度 ≤ 116px** 时实排 3–4 行而 `rows=1 / minHeight:44px` 只显示 2 行 ⇒ 句子断在中间，且 `overflow:auto` 滚不动空 textarea，第 3 行起是真看不见。WebKit / Chromium 阈值一致。可用宽度 ≈ 窗口宽 − 约 360px（左侧栏 `w-64` = 256px + `px-4` + `pr-10`），产物预览打开时该列再减半。**文案层修不掉**：hint 里的 `(Shift+Enter` 是约 85px 的不可断 token，实测 5 个候选写法在 116px 下全部超 2 行（缩短 hint 无用、只有缩短 base 有用，且也只能把「单行区间」从 ≥860px 拉到 ≥700px）。**根因是 `tauri.conf.json` 没有 `minWidth`**，窗口可拖到任意小（400px 时工具栏的模型选择器本来就已溢出）。
- **量行数不要用 `ceil(文本宽 / 可用宽)`** —— 那假设可以在任意位置断行，对 CJK 成立、**对英文不成立**（按词断行，填充效率更低）。同一次标定里这个错误让中文的裁切阈值从「测试范围内不裁切」变成「116px 就裁切」，也就是说理想除法会给出**假安心**。正解是塞一个 `white-space: pre-wrap; overflow-wrap: break-word` 的隐藏 div、宽度设成真实可用宽、读 `getBoundingClientRect().height / lineHeight`，让引擎自己排。

## 14. 办公 CLI 连接器（lark-cli + dws + wecom-cli，ADR-043 / discussions/027）

> 三家官方 CLI 的**上游契约全部以真机实拍为准**（lark-cli v1.0.65 @2026-07-06；dws v1.0.47 @2026-07-07；wecom-cli v0.1.9 @2026-07-07）——内嵌文档/二进制 strings/源码推定的形状多处与实际不符，且**三家在多条轴上语义互相相反**（探针输出、URL 流向、双源 hash、安装形态各成一套），绝不能拿一家的契约推另一家。cargo 单测以实拍 payload 锚定；bump 任一 pin 版本时逐条复核本节。

### lark-cli（飞书）

- **错误态 JSON 走 stderr + 非零退出；成功态走 stdout + exit 0**。机器读输出必须两路都接（`lark_json_output`：stdout 优先、空则回落 stderr）。只读 stdout 会把 `not_configured` 读成空串误判异常。
- **`auth status --json` 成功态是状态文档，没有 `ok` 字段**（内嵌 lark-shared 文档说的 `ok:true` 形状不存在）：`{appId, brand, identities:{bot:{status,available,…}, user:{status,available,openId,userName,tokenStatus,scope,expiresAt,…}}, identity}`。**授权判据 = `identities.user.available` 布尔**；未授权时 `status:"missing"/available:false`。错误对象存在（含 `error:null`）才走三态分诊（`not_configured`/`auth`/其余）。
- **设备流字段实为 `verification_url`**（user_code 内嵌在 URL query），无独立 user_code/interval；实拍 shape=`{device_code, expires_in, hint, verification_url}`。二进制 strings 里的 `verification_uri`/`_complete` json tag 属于其它内部结构体，不是本命令输出。
- **连接器级授权必须 `--recommend`，绝不能 `--domain all`**：`--domain all` 首次只静默授予 4 个基础 scope，**重复授权时托管页把缺失域路由进「开通申请审核」流**（人工审核、不发 token、授权按钮从此等不到结果）；且审核挂起黏在应用上会挡住后续正常授权（解法=换新应用或等审核）。`--recommend` 免审批 scope 秒过且覆盖极广（docs/base/wiki/im/task/sheets/drive/mail/vc/审批等上百项）；日历等审核域由技能在任务时增量 `auth login --domain/--scope`（可能触发开通审核，agent 按 SKILL.md 如实告知等待、勿重发）。
- **`auth login --device-code` 部分授予时非零退出但输出 `event:"authorization_complete"`（granted/missing 清单）——这是成功不是失败**（`classify_complete_auth`），最终状态以 auth status 探针为真相。
- **实现要点（改探针/安装前必读）**：① `~/.ultrawork/office-cli/bin` **领跑** `compute_rich_path`（pin+sha256 校验的二进制必须压过用户 brew/npm 旧装，UI 与 agent bash 才同源；该目录只放自管 CLI，前置无副作用）；② 探针 Error 态 detail **永不为空**（空串是 JS falsy 会压掉 UI 红横幅）；③ `--version` 按二进制路径缓存（配置轮询每 3s 一次、版本不会变）、install 时失效；④ `config init --new` 子进程 spawn 后**立即入 slot**（先取管道）——双击并发时第二次 invoke 才能 kill 前任，清理走 pid 守卫；app 退出在 `shutdown_sidecars` 排空 slot（孤儿会跨启动竞争 CLI 配置文件）；⑤ spawn lark-cli 统一带 `LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1` 静噪；env 有 `OPENCLAW_HOME`/`HERMES_HOME` 时 config init 默认拒绝（要求 config bind）。
- **CLI 自带 27 个内嵌技能（`lark-cli skills list/read`，构建期嵌入与版本同步）**——这是 feishu-assistant 走薄路由（教 agent 按需 read 而非转译副本）的根据；`doctor`（JSON、恒 exit 0、逐项 checks）是比 auth status 更全的健康探针备用。

### dws（钉钉，Phase 2 实拍 2026-07-06/07）

- **`auth status` 成功/未登录都是 exit 0 + stdout success 信封**（与 lark 的「未配置=stderr 错误+exit 3」相反）：未登录 `{"success":true,"authenticated":false,"message":"未登录"}`；已登录多 `token_valid/refresh_token_valid/corp_id/corp_name/user_id/user_name` 字段。**授权判据 = `authenticated` 布尔**。错误信封 = `{"success":false,"code","message"}`（官方 error-codes.md）；login/doctor 另有 stderr 形 `{"error":{category,code,message}}`。
- **设备流输出完全不是 JSON**：`auth login --device` 打人类可读 box 到 **stderr**（`-f json` 对此流无效），URL 从 `verify.htm?user_code=XXXX-XXXX` 正则提取；**无 `--no-wait`/`--device-code` 恢复机制——login 是单个阻塞轮询子进程**（900s 过期/5s 轮询），必须常驻托管（连接器 slot），**绝不能让 agent 在 bash 里代跑**（bash 超时会杀在半途）。`--device --no-browser` 组合实测可用。
- **白名单检查在 token 交换之后、CLI 侧**（Step 4，非浏览器拦截）：`cli_not_enabled` 实拍 = stderr 人类块（含**组织主管理员姓名** + 管理后台直达 URL）+ 尾部 pretty JSON `{"error":{"category":"auth","code":2,"message":"device authorization failed: CLI data access is not enabled…"}}` + exit 2。开关实际生效入口是**旧版**设置页 `open-dev.dingtalk.com/fe/old#/developerSettings`（新版控制台首页侧栏可能不显示该菜单）。判据 = message 含 "CLI data access is not enabled"。**观察项**：此失败发生在 token 交换后，token 是否持久化未验证——若持久化，后续 `auth status` 会报 authenticated:true（探针无法感知白名单态）。
- **`doctor` 不是探针**：stdout 恒人类可读表格（`-f json` 无效）+ 外呼（网络/版本检查）+ 失败 exit 5；轮询健康检查用 `auth status`。
- **schema 自省要预热**：登录后仅 3 个本地条目，`cache refresh` 后才展开（实测 24 产品）——连接器授权成功后自动触发一次（单飞）；技能教 agent 空 schema 先刷。
- **无 config init/建应用环节**（OAuth client 内置）——连接器状态机比 lark 少一态（无 not_configured）。scope 模型宽松：默认登录即可读业务数据，无 lark 式部分授予/审核流；缺 scope 时 CLI 提示 `auth login --scope <x>`。官方 logout 提示推荐 `auth login --recommend`（批量授予推荐权限，语义未单测）。
- **安装双源不是字节等同**：GitHub Release（checksums.txt 六平台）与 npm 包（41MB tarball 内嵌全部产物+dws-skills.zip）的 **darwin 二进制同版本不同 hash**（签名差异；windows 相同）→ 按源分别 pin（GitHub 按 checksums.txt、npm 按整 tarball sha256 传递背书）。**npmmirror `/-/binary/` 不镜像该仓库（404）**，大陆 fallback = npm tarball。**别用 GitHub `/latest`**（上游会把 feature-branch release 标成 latest，实见 2026-07-07）。npm postinstall 会把技能强推 `~/.claude/skills/dws` 等 16 个 agent 目录（Rust 直下避开此副作用）。
- **官方技能不在二进制里**（与 lark 相反）：`dws-skills.zip` 独立分发（mono 144 文件 + multi 18 技能 EXPERIMENTAL）；`skill setup --target` 只认白名单 agent 名（**文档声称的 `.` 路径写法被拒**，上游 bug v1.0.47）→ 连接器安装时自行解 zip 的 `mono/` 前缀到 `office-cli/skills/dws/`，dingtalk-assistant 教 agent 读该目录（Windows 注意 read 工具不展开 `~`，用 `%USERPROFILE%` 绝对路径）。
- **agent 首次 read materialize 的官方文档会触发 opencode `external_directory` 权限确认**（工作区外路径，每工作区一次、「总是允许」后免问）；lark 走 `skills read` 子命令（bash）无此问。真机验收实录：`tool_search → skill → bash(auth status) → read(SKILL.md) → read(contact.md) → bash(get-self)` 全链通。

### wecom-cli（企业微信，Phase 3 实拍 2026-07-07，v0.1.9——第三家第三套契约，勿从 lark/dws 互推）

- **探针 = 隐藏命令 `auth show`（`.hide(true)`，help 不列但可调）**：未授权 = exit 0 + stdout **纯文本 `unauthorized`**（非 JSON、非 stderr、非非零——三家三样）；已授权 = exit 0 + stdout pretty JSON `{"create_time":…,"id":"aibk…"}`（**id 是字符串**，真机锚定；分类器容忍数字防上游漂移）。`--auth-status` 变体恒纯文本 `authorized`/`unauthorized`。纯本地读 `bot.enc`、零网络（好探针，但**不验证凭证服务端有效性**）。错误 = anyhow → stderr 人类中文 `Error: <msg>` + exit 1，全 CLI 无结构化错误 JSON（三家最简）。
- **「授权」= QR 扫码 init，不是 OAuth 设备流**：`init --noninteractive --no-open` 是单阻塞子进程（3s 轮询/300s 过期），**QR 页 URL 走 stdout 裸行**（`work.weixin.qq.com/ai/qc/gen?source=…&scode=…`，按 `scode=` 标记提取；与 dws 的 stderr box 相反），cliclack 装饰框走 stderr；扫码自动创建/绑定机器人、凭证服务端下发 CLI 自存（AES-256-GCM `bot.enc`，密钥 keyring+文件双写）——app 全程零碰凭证，且**无 config init/建应用环节**（比 lark 少一态）。**禁 agent bash 代跑 init**（同 dws login：bash 超时会杀在半途）。**上游 rollback 坑**：init 中途失败（验证凭证不过/网络断）会 `clear_bot_info` **连旧凭证一起清**——好在 UI 已连接态无重授权按钮（授权按钮只在 bot.enc 已缺失的未授权态出现），实际暴露面极小，重扫一次即恢复。
- **安装 = 第三种形态（npm 平台分包，无 GitHub Release）**：GitHub Releases 实测空数组、无 checksums.txt；真身 = `@wecom/cli-{darwin-arm64,darwin-x64,linux-x64,linux-arm64,win32-x64}`（5 平台、**无 win-arm64**），二进制在 tarball 内 `package/bin/`。**npm ↔ npmmirror 字节相同**（sha256 实测一致，与 dws 双源不同 hash 相反）→ 每平台单 hash、npmmirror 常规镜像即大陆 fallback。Windows 分包也是 `.tgz`（非 zip）——`tar -xf` bsdtar 自动识别 gzip（实证验证）。
- **能力按企业规模服务端分级，探针不感知**：>10 人企业只下发 文档+待办；≤10 人全量（消息/文档/日程/会议/待办/通讯录，本机企业实测 6 品类 ~47 工具全开）。调用未下发品类 = stderr `当前企业暂不支持授权机器人「××」使用权限` + exit 1——**属技能文档层**（教 agent 如实告知、勿重试勿重授权），不是连接器状态（wecom 四态：not_installed/not_authorized/connected/error，无 not_configured 无 not_enabled）。
- **工具全动态发现、文档要教 `--schema`**：6 品类静态注册，工具表从企业 MCP gateway `tools/list` 下发（24h 文件缓存，`cache clear` 重刷）；连 `<category> --help` 都要凭证+网络（未 init = `Error: 未找到 MCP 配置缓存`）。**`<method> --help` 拿不到参数定义**（disable_help_flag，只有描述）——参数 JSON Schema 唯一出口 = `<method> --schema`（实拍验证）；`<category>` 裸跑 = clap exit 2 + stderr，列工具用 `<category> --help`（exit 0）。
- **成功输出是双层信封**：stdout 打完整 JSON-RPC 响应，业务 JSON 是 `result.content[0].text` 里的**字符串**（实拍锚定）——解析剥两层。默认超时 30s、`get_msg_media` 120s（媒体落盘回 `local_path`）。**全 CLI 无 `--dry-run`/`--yes`**（与 lark/dws 都不同）——写操作唯一预览机制 = agent 先向用户复述确认（wecom-assistant 安全底线）。
- **官方技能无版本化工件** → vendored 单一 commit 快照进 builtin zip（`wecom-assistant/references/official/`，SKILL.md→INDEX.md 改名防 `skills/**/SKILL.md` 嵌套误扫；取舍与维护规则见该目录 `_ORIGIN.md`）。**vendor 快照必须整树单一 commit**：`git checkout <commit> -- dir/` 不删工作树多余文件，两轮审查各抓到一次混合快照——重做快照用 `git archive <commit>` 双向逐文件比对核实。
- 杂项：`WECOM_CLI_CONFIG_DIR` env 可整体重定向配置目录（测试沙箱友好，lark/dws 均无）；探针 spawn 剥 `WECOM_CLI_LOG_LEVEL`（stdout 精确 sentinel 防日志污染）；CLI 授权的机器人**仅创建者本人可对话**（官方防冒用限制）。

---

> 维护说明：本清单中"已 patch / 已修复"的条目反映的是**写入时**的状态。引用具体文件/函数/flag 前请确认其仍存在（尤其 vendor 升级后）。可疑或过期条目应在"收尾"时清理。

## 15. 会话转录区滚动（`use-session-scroll.ts` + `Session.tsx`，ADR-047，2026-07-10）

> 三条根因全部由**真机逐帧采样**坐实，不是推断。jsdom 没有布局引擎，desktop 的 423 个 vitest **一条都测不到本节**——回归靠 `e2e/session-scroll.e2e.ts`，且**必须两个引擎都跑**（`E2E_ENGINE=webkit`）。

- **`contentRef` 绝不能是被 stretch 的 flex item，否则它的 ResizeObserver 静默失效**：单行 flex 容器高度确定时，flex line 交叉尺寸 = 容器内高，`align-items: stretch` 把 item 钉死在那个高度，子元素只是溢出它。实测塞进 6021px 消息，`contentRef` 高度恒为 616px（= `clientHeight`），RO **全程只触发 1 次**（挂载那次）。ADR-021 Phase 4 的「智能滚动」因此从落地起就没运行过。滚动容器用 `block` + 内容层 `mx-auto`，别用 `flex justify-center`。症状很隐蔽：流式期间靠 `[messages]` effect 每 token 滚一次，看起来一切正常；只有在动画停止后发生异步撑高（图片/字体/代码块/工具结果）时才永久卡死。
- **转录区内绝不能出现 `content-visibility: auto`**：`contain-intrinsic-size` 的 `auto` 关键字是「记住上次渲染尺寸」，元素**首次**被加上 CV 时**没有记忆值**，只能用 fallback 长度（MDN / csswg-drafts#7807）。原代码在 `isStreaming` 翻假那一帧给刚完成的 turn 挂 CV，于是一个真实 1700px 的 turn 被压成 500px，`scrollHeight` 2327→658，`scrollTop = scrollHeight` 滚到的「底部」其实是顶部（`658-616=42`）。**谎言只存在一帧**，但那一帧正好是唯一的滚动触发点。换 `use-stick-to-bottom` 也救不了（Δ≈1050px，且它把随之而来的 scrollTop 钳制误判成用户上滚而主动 escape）。
- **`use-stick-to-bottom` 不要设 `resize: "instant"`**：那会让它在每个增长帧硬写 `scrollTop`，**用户物理上无法在流式期间拖离底部**。用库默认的弹簧。它的 `isAtBottom` 容差是 70px，完成后 Δbottom 可残留 ≤70px——被转录区底部的 `pb-24`（96px）吸收，视觉无影响。
- **`use-stick-to-bottom` 的 `initial` 动画只覆盖内容观察器看到的第一次 resize**。`SessionPage` 跨 `/session/:id` 复用（react-router 不重挂载），所以**会话切换永远拿不到 `initial`**——历史以普通增长涌入，视图会可见地弹簧滚到底（实测 `scrollTop` 经过 75 个取值）。修法：会话变更后 800ms 内把 `resize` 钉成 `"instant"`（库每次 resize 都重读 options），之后交还弹簧。别一直钉着，见上一条。
- **`use-stick-to-bottom` 的 `handleScroll` 会吞掉与 resize 同 tick 的滚动事件**（`if (state.resizeDifference || …) return`）。流式期间 RO 一直在响，所以**单次 `scrollTop -= N` 的瞬移会被无视**。真实用户拖滚动条是连续多个 scroll 事件，总有一个落在安静窗口。写 e2e 时必须模拟多帧拖拽，否则会误判成「库不让用户逃逸」。
- **escaped 检测必须按位置判定，不能只监听 `wheel`**：原自研 hook 只在 `wheel && deltaY < 0` 时置 escaped，拖滚动条 / PageUp / Home / 触摸拖拽一律漏检 → 把正在看历史的用户强行拽回底部。Claude Code、Gemini、Cursor 桌面版都被开过这个 issue。
- **WebKit 在折叠大块内容时会自己保住阅读位置，不需要手动 anchoring**：一度以为 WebKit 无 scroll anchoring（webkit.org #171099）需手动补偿，A/B 反证推翻——禁用补偿后 WebKit 折叠帧位移仍是 0px。沙箱里观察到的 817px「跳动」实为**贴近底部时的钳制**。唯一真会跳的是「折叠后转录区短于视口」的退化场景，此时 `scrollTop` 必然钳到 0，无解也无需解。
- **`macOS 最低版本 10.15`，而 `content-visibility` 要 Safari 18 / macOS 15**：macOS ≤14 的用户既碰不到上面的 CV bug，也从来没享受到 ADR-021 那次 CV 优化。给任何 CSS 性能优化下结论前先查 WKWebView 支持面。
- **一个 step 先输出文本、随后又发起工具调用时，那段文本会被 `buildTurnModel` 从「答案」重新归类为「过程 narration」并塌成一行**（`assistant-turn.tsx` `lastIsAnswerStep`，ADR-029 有意取舍）。实测可在一帧之内蒸发 4628px。写涉及转录区高度的 e2e 时要预期到这种中途大幅收缩，别把它当成滚动 bug。

### `use-stick-to-bottom` 只观察**内容层**，不观察**滚动容器**（ADR-048 实测，2026-07-11）

库的 `ResizeObserver` 挂在 `contentRef` 回调里（`useStickToBottom.js`），所以它只知道「转录区变高了」，**对「滚动容器变矮了」一无所知**：内容高度没变，只是视口短了，视图就被永久晾在离底 N px 处，且**永不收敛**。

触发它的都是日常动作：输入框重新出现（退出全屏预览）、权限/提问 dock 打开、委派 dock 中途冒出。实测差值恰好等于那个元素的高度（100px）。

修法在 `use-session-scroll.ts`：**额外挂一个观察滚动容器的 RO** —— 容器变矮且此前贴底时 `scrollToBottom({animation:"instant"})`。用 ref 读 `isAtBottom`：容器变矮那一刻库还没重算，读到的正是变矮前的值，而这正是需要的。

> ⚠️ 这个洞一直存在，只是被偶然掩盖：全屏预览的早期版本把 chat 列收成 `w-0`，退出时宽度 0→N 的剧变**顺带**触发了内容层 RO 把位置修回来。后来为消除重排改成宽度恒定，救场消失，洞才暴露。**不要指望宽度变化替你兜底。**

### 隐藏子树里的「持续贴底」不可靠，且两引擎不一致（ADR-048 实测）

全屏预览期间 chat 列是 `visibility:hidden`（布局盒仍在）。**WebKit 上 agent 回复会让隐藏的视图漂离底部约 122px**；Chromium 有原生 scroll anchoring，表现不同。

所以**不要建立在「隐藏期间会一直贴底」这个前提上**。正确语义是：**进入隐藏前若贴底，退出时就贴底** —— 在进入那一刻用 ref 快照 `isAtBottom`（不能放进 effect 依赖，否则隐藏期间的漂移会把快照污染掉），退出时按快照 `forceScrollToBottom()`。

## 16. OpenCode 系统提示组装 / 注入点（ADR-064 / discussions/048，2026-07-21）

想给默认会话改「主提示」（身份、输出风格、护栏）时，注入点选错会静默牵连别的模型。三条实测契约：

- **`agent.<name>.prompt` 是「整体替换」，且对所有模型无条件生效**（`session/llm.ts:232`：`input.agent.prompt ? [input.agent.prompt] : SystemPrompt.provider(model)`）。而 `provider()` 按模型分流（`session/system.ts:20-33`：Claude→anthropic.txt / GPT→gpt·beast.txt / Gemini→gemini.txt / Kimi→kimi.txt / **其余含 qwen→default.txt**）。所以给 `build` agent 设一段静态 `prompt`，会把 Claude/GPT/Gemini 的**模型专属调优提示一并丢掉**——本 app 是 BYOK 多 provider（ADR-042），这是真降级。**别用 `agent.prompt`/`OPENCODE_CONFIG_CONTENT` 整体替换来加通用指令。**
- **正确注入点＝插件钩子 `experimental.chat.system.transform`**（`llm.ts:244` 对所有已注册插件无条件 fire，`output.system` 是已组装的提示数组）。**追加**而非替换 → 保留每模型基座；要中和某个基座的措辞（如 default.txt 的 `fewer than 4 lines`）就**子串探测后追加一段 override**，别正则删基座（脆、且会误伤别的模型）。范例＝`plugin/rich-output.ts`（ADR-064）与 `plugin/tool-disclosure.ts`（ADR-036）。
- **缓存与重复追加**：`system.transform` 是**每 step** fire，但 `llm.ts:228` 每 step 重建 `system` 数组 → 追加**不会跨 step 累积**；且追加内容须**静态**（`llm.ts:249` 靠 header 稳定维持 2-part 结构保前缀缓存，动态内容会破缓存）。
- **`environment()`（`system.ts:40`）始终注入 `You are powered by the model named <id>. The exact model ID is <provider>/<id>`**，任何 `agent.prompt`/`system.transform` 都**改不掉它**（它是独立段）。所以「不泄露 model/provider」只能是**软护栏**（叮嘱模型别说，但上下文里真信息还在）；要真藏得 patch 掉这行。
- **默认 primary agent = `build`**（`agent/agent.ts:109`）；前端普通会话不指定 agent 即走它。plan/title/compaction/summary 各有独立 prompt，`build` 的改动不影响它们；**Team/ACP 子进程**（Claude Code/Gemini/Codex）更是各自的 system prompt，opencode 侧改动完全够不到（但 **opencode 后端的 Team Leader** 走的是 `build`，会被 `system.transform` 触及）。

## 17. 聊天正文内联 markdown 图片（ADR-065 / discussions/049，2026-07-22）

模型「画图」= 把 SVG/PNG 写进工作区、正文用 markdown 图片语法 `![alt]（路径）` 引用。要让这类内联图显示，四条实测契约（渲染器 `MarkdownImage`/`message-parts.tsx`）：

- **react-markdown 默认 `urlTransform` 会把 `data:` URI 和 Windows 盘符路径 `C:\` 清空为 `""`**（`c:` 被当 scheme；实测：`data:image/png…`→`""`、`C:\…`→`""`，而 `C:/…`、`/Users/…`、相对路径存活）。→ 直接用默认 `img` 渲染，base64 图与 Windows 本地图**根本不显示**。必须给 `MarkdownContent` 传自定义 `urlTransform`（保 `data:image/` + `^[A-Za-z]:[\\/]`，其余交 `defaultUrlTransform`，`javascript:` 仍拦）。链接不受影响（`MarkdownLink` 经 `isOpenableUrl` 再过滤）。
- **opencode `/file/content`（vendor `File.read`，`file/index.ts:513`）只认 workspace 相对路径**：`path.join(Instance.directory, file)` + `containsPath` 禁逃逸。绝对路径（`/Users/…/ws/x.svg`）会被 `path.join` 拼坏→返回空。→ 前端必须先 `toWorkspaceRelative`（`@/lib/path-utils`）剥 workspaceDir 前缀转相对再取；workspace 外的图取不到（安全边界），降级兜底。图片扩展名走 base64 分支返回 `{mimeType, encoding:"base64"}`，前端拼 `data:${mime};base64,${content}`（与产物预览同通道）。
- **markdown 把 `\` 当转义符** → `![]（C:\a\b.png）` 纯反斜杠路径解析阶段即被破坏（renderer 无法挽回）。可存活形态＝相对路径 + 正斜杠绝对（`C:/…`）；rich-output 引导推模型用相对路径。
- **`useApi` 必须返回稳定引用**：`MarkdownImage` 的解析 `useEffect` 依赖 `api`；若 mock/实现每渲染返回新对象 → 每渲染重跑 effect+setState → **无限渲染循环**（e2e 单测踩过）。生产 `useApi` 由 connector 记忆化，稳定。
- **⚠️ markdown 管线会把 src 百分号编码，而这一层在组件之外（2026-08-15 L4 实测）**：`mdast-util-to-hast` 的 image handler 是 `{src: normalizeUri(node.url)}`（`lib/handlers/image.js`，上游按设计如此 —— 它产的是给浏览器的 URI）。于是 `![](输出/page-001.png)` 到达 `MarkdownImage` 时**已经是** `%E8%BE%93%E5%87%BA/page-001.png`。后果两条，都只在**非 ASCII 路径**上出现：① 相对路径 → 客户端再 `encodeURIComponent` 一次 ⇒ 请求的是名字里真含 `%E8…` 的文件 ⇒ 空 body ⇒ 兜底卡片；② **工作区名本身带中文**时更狠 —— 编码后前缀不再等于 `workspaceDir`，`toWorkspaceRelative` 返回 null ⇒ **请求根本不发出**。→ 解析本地路径前必须**解码一次**（`toLocalPath`）；`classify()` 仍在**原始 src** 上跑（`a%3Ab.png` 解码后会像个 scheme）。解码放在 `..` 检查**之前**，`%2E%2E%2F` 才拦得住。⚠️ **此前 18 条组件测试全绿而功能是坏的，因为每条路径都是纯 ASCII，且单测直接喂 src、绕开了加编码的那一层** —— 这类断言必须走 `MarkdownContent` 全管线。
- **`/file/content` 对「不是图也不是文本」的文件返回 `{content:""}`，与「文件不存在」逐字节相同**（PDF 实测如此）。→ 客户端分不出「这是 PDF」和「没这个文件」，只能靠扩展名；产物预览面板另走 pdf.js 自己读字节（`artifact-preview.tsx` 对 pdf 跳过取内容），所以把 PDF 兜底成**可点的文件卡片**是有依据的，不是空头支票。
- **本机验证陷阱（非产品）**：① 新编译的 sidecar 二进制带 `com.apple.provenance` xattr → macOS 静默杀（`--version` 零输出 exit 0），bash 直接 spawn 起不来；`xattr -c` + `codesign --force --sign -` 恢复（打包正式签名不受影响）。② e2e 连跑双引擎时前一轮 opencode 偶尔没及时释放端口，需按端口清理。

## 18. 数学公式渲染（KaTeX，ADR-070 / discussions/055，2026-07-27）

管线 = `remark-math`（默认配置）+ `rehype-katex`，加在 `message-parts.tsx` 与 `artifact-preview.tsx` 两处。**零启发式**是刻意的，下面每条都是实测结论。

- **`singleDollarTextMath` 必须保持默认 `true`，别「为了防货币误伤」关掉它**。关掉后单 `$q(x)$` 不再渲染，渲染正确性就被绑死在「模型是否改用 `$$`」上 —— 而实测 qwen3.7-max **85% 的公式用单 `$`**，即使 prompt 明确要求 `$$` 也只到 82.4%、且 4/12 的回答混用两种定界符（同一条回答里一半渲染一半不渲染，比全不渲染更难看）。保留单 `$` 的已知代价是货币误配对（`$5 … $10` 会配成公式），但拿 **24 个真实模型回答 / 279 个公式**实测：**真实误伤 0**。别为一个实测不发生的风险付复杂度。
- **两种「货币守卫」都别写，写了会更糟（各自实测失败）**：① mdast 层把「像货币」的 `inlineMath` 降级回 text —— **治不了混排**，因为 micromark 从左到右贪婪配对，`成本 $100 时，接受率为 $` 会先成对、把后面真公式的开定界符**偷走**，损伤发生在分词阶段、mdast 已太晚；② 分词前用字符串预处理转义货币 `$` —— 要同时跟踪代码围栏、行内 code、贪婪配对边界，**第一版实现就误杀了真公式并向界面漏出 `\5` 脏字符**。
- **`.katex-display > .katex` 带 `white-space: nowrap`，而 katex.css 自己没有任何 overflow 规则** ⇒ 超过阅读列宽的块级公式会撑破正文列或被裁掉右半边（而修复前的源码形态是会折行、内容全可见的）。**必须自己加 `.katex-display { overflow-x: auto }`**。副作用是好的：公式外部宽度被锁在列宽内 —— 顺带**消除了流式期间的横向抖动**（实测块级公式流式全程宽度 0 次变化、仅高度变 3 次）。
- **KaTeX 把同一条公式输出三份**（MathML 无障碍层 + `<annotation>` 里的 LaTeX 原文 + 可视 HTML 层）⇒ 拖蓝选中复制会得到 `M⋅q(x)≥p(x)M \cdot q(x) \geq p(x)M⋅q(x)≥p(x)`。修法是 `.katex-mathml { user-select: none }`（**不是 `display:none`**，MathML 要留在无障碍树里）。「复制整条回答」按钮不受影响 —— 它走 `answerText` 原始 markdown，不是 DOM。**写断言时别拿 `textContent` 判渲染结果**：annotation 让它必然含 `\cdot`，要断言就取 `.katex-html`。
- **`strict` 必须设 `false`**：默认 `warn` 下，模型合法写出的中文变量名（`P(患病|阳性)`）会**按字符**刷 console 警告。`throwOnError` 同样必须 `false`，否则一条坏公式会掀掉整条消息。
- **`$...$` 由 micromark 在强调解析之前夺取** —— 这正是 `$\frac{p(x^*)}{M \cdot q(x^*)}$` 的两个 `*` 不再被吃成 `<em>` 的机制。反过来说，**没有 math 插件时 markdown 会主动破坏公式源码**：`*` 被配成强调、`\{ \_ \%` 类反斜杠被 CommonMark 转义吞掉（而 `\cdot`/`\frac` 不受影响，因 `c`/`f` 不是可转义标点 ⇒ **损伤是选择性的**，更难排查）。下标 `_` 反而安全（CommonMark 禁 intraword 强调）。
- **`\(...\)` / `\[...\]` 无解，别试图支持**：反斜杠在 markdown **解析期**就被吞掉（`\(a^2\)` → `(a^2)`），定界符信息彻底丢失 ⇒ 任何渲染后补救都不可能，**换 MathJax 也没用**（定界符由 remark-math 的**分词层**决定，不在渲染层）。qwen 实测 0 次使用；GPT 系有此习惯，只能靠 prompt 劝阻。
- **IM 出站的 LaTeX→Unicode 降级（P2）必须用 KaTeX 的 MathML 树，不能取树的朴素文本**：`math-unicode.ts` 走 `katex.__renderToDomTree(tex, {output:"mathml"})` —— 它返回**树对象**，不用解析 XML 字符串（`renderToString` 会逼你回去写正则）。**朴素取文本会把分式拍平**：MathML 把分子分母平铺，`\frac{1}{M}` 的 `.toText()` 是 `"1M"`，**一个不同的数**。故 `mfrac / msup / msub / msubsup / munderover / mover / munder / msqrt / mroot / mtable` 全部要规则处理。另外 **`<annotation>` 子节点装着 LaTeX 原文，必须显式丢弃**，否则每条公式输出两遍（一遍降级、一遍原文）。
- **降级的括号策略不能只看字符串，分母要看树**：`needsParens` 那类「扫描顶层运算符」的字符串判据对**并置乘法**完全失明 —— `\frac{1}{2\pi}` 的分母 `2π` 里一个运算符字符都没有，输出 `1/2π` 读作 `(1/2)·π`。判据必须落在**节点**上（分母是不是单个原子 / 已被括号包住 / 是函数调用 `Q(i)`），字符串层只够管分子。**这条是拿真实语料跑出来的**：`\frac{e^{z_i}}{\sum_j e^{z_j}}` 曾输出 `e^zᵢ/∑ⱼe^zⱼ`。
- **`_` / `^` 的回退形式必须永远带括号**（`y_(ic)` 而不是 `y_ic`）：Unicode 没有下标 `c`，整组回退成 ASCII 时 `_`/`^` **没有闭合定界符**，`y_{ic}\log(...)` 会退成 `y_iclog(...)` —— 下标到哪结束无从判断。同理 **accent 要换成组合字符**：KaTeX 发的是**间隔**重音符（`\hat{y}` → `y` + U+005E `^`），直接拼出来的 `y^` 和指数无法区分，须映射到 U+0302 得 `ŷ`；`\underline` 发的是 `‾`（U+203E，overline 字形！）要按 munder 映射到 U+0332。
- **KaTeX 不是「要么成功要么抛异常」—— 它认识但拒绝执行的命令会被渲染成命令名本身**：`\href` / `\url` / `\includegraphics` 这些被 `trust` 门控的命令，在 `throwOnError:true` 下**不抛**，而是把 `\href` 四个字符按 `errorColor` 上色输出，**`{点我}` 那部分内容直接消失**。桌面端至少还是红字有提示，降级成纯文本就是**静默内容丢失**。判据只能用 KaTeX 自己的信号（把 `errorColor` 设成哨兵色、树里遇到就当解析失败保留原文）——**不能扫输出里的反斜杠**：`a \backslash b` 合法地渲染成 `a\b`。
- **降级扫描器必须跳过 URL，这不是可选项**：实测桌面管线（`remark-parse+gfm+math`）**保留** `[文档](https://ex.com/a$b$c)` 与裸 URL 里的 `$`（remark-math 不碰链接目标）。IM 侧若照常转换，`$b$` 会被吃掉、URL 静默变成 `.../abc` —— 一个**桌面端没有、IM 端独有**的链接损坏。代码围栏 / 行内 code 同理（`$PATH … $HOME` 会被当成一个 span 吞掉，改的是用户会去粘贴执行的命令）。
- **降级只放在 `bridge.ts` 的 `send()` 一处**（四个 adapter 都不写）：那是所有出站消息的唯一漏斗，streamed block 和最终 flush 都过它。顺序上**先降级再截断** `MAX_REPLY_LENGTH`，否则可能从一个 span 中间切开、留下半截不再可解析的 LaTeX。
- **降级后 `stripMarkdown` 的 `_` 规则要补 CommonMark 的 intraword 保护**：降级产物里 `_(...)` 是常客（Unicode 映射不了的下标），两处回退会被裸 `_(.+?)_` 配成一对、吃掉中间的正文。桌面端白拿这条保护（CommonMark 禁 intraword 强调），IM 的裸正则没有，得自己加 `(?<![^\s])_ … _(?![\p{L}\p{N}])`。
- **IM 出站的 `stripMarkdown`（`wechat-adapter.ts`）必须把公式先占位再剥离强调**：裸正则 `_(.+?)_` 会**跨公式配对**，把 `$\sum_{i=1}^{n} a_i = b_i$` 改写成 `$\sum{i=1}^{n} ai = b_i$` —— 求和下标没了、`a_i` 变 `ai`，**数学含义被改变**（桌面端只是显示难看，IM 端是内容在出站前被篡改）。占位符要用 NUL 之类正文不可能出现的字符，但**源文件里必须写 `\u0000` 转义序列而非字面 NUL 字节** —— 后者会让 `grep` 把整个文件当二进制静默跳过（实际发生过）。

## 19. `/` 斜杠命令菜单 & 全局键盘接管（discussions/056，2026-07-29）

① **全局捕获阶段接管键盘的组件，必须显式让出输入法组字期。** `command-selector` 的监听挂在 `document` 捕获阶段并 `stopPropagation`，若不判断组字状态，中文输入法**上屏用的 Enter 会被菜单抢去选中命令**、**方向键会被抢去移动选中项**（输入法本来用它翻候选）。判据要**双信号**：标准 `e.isComposing` + 遗留 `e.keyCode === 229`（后者是 Windows 微软拼音的主信号）。⚠️ 这条**只有真机 + 真输入法能暴露** —— Playwright 用 `fill()` 直接塞文本，永远进不了组字态。

② **中文输入法的组字串里有空格。** macOS 拼音按音节分段，敲 `ppt` 组字串是 **`p p t`**。任何形如 `value.includes(" ")` 的判断（如「有空格＝命令名打完了、开始打参数」）在 IME 下都会误触发 —— 现象是 `/` 菜单在组字过程中整个消失、上屏后才回来。**已知且有意保留**（豁免后菜单会全程挂「无匹配」，未必更好），见 discussions/056 §8.7。

③ **skill 的 `description` 是写给模型的，不能直接当 UI 标签。** 它来自 SKILL.md frontmatter，用途是技能路由判定：9 个内置技能实测 163–605 字符（中位 315），4/9 以 `Use when the user wants to…` 样板开头，4/9 含反引号 markdown（在 UI 里**原样显示**）。任何直接渲染它的地方都必须单行 `truncate` + 提供看全文的途径。

④ **面板标题写死必然与内容漂移。** 弹层顶上曾写死「命令」，而默认安装下列表 **100% 是技能**（`init`/`review` 被隐藏、仓库不发 config command、自带 MCP 只注册 tool 不注册 prompt），同时设置页和分组标题都叫「技能」——三处用词打架。改为**内容同源时用该源的名字、异源时不加标题**。

⑤ **`--color-fg-muted × opacity-70` 是本项目已知的不达标组合**（浅色 2.68:1 / 暗色 3.73:1，AA 正文需 4.5:1），这是**第二次**踩（第一次见 `conventions.md §20`）。另外**强调背景上的 muted 更紧**：`--color-fg-muted` 落在 `--color-accent` 上只有 4.40:1，仍不达标 —— 选中行要改用 `--color-accent-fg`。


## 20. SSE 断流 / sidecar 生命周期 / 会话状态端点（ADR-071 / discussions/057，2026-07-29）

**① opencode `/event` 没有重放。** 路由订阅即开始（`Bus.subscribeAll`），无 Last-Event-ID、无缓冲。**断流窗口内的一切事件永久丢失** —— 包括 `session.status:idle` 和 `message.updated finish`。任何「靠折叠事件得出的状态」在重连后都必须**从服务端重新求值**，不能指望补发。

**② `GET /session/status` 的语义是「非 idle 集合」。** 会话转 idle 时其条目被 **delete**（`session/status.ts` 的 `set`），所以 **key 集合就是 busy 集，缺席即 idle**。这是重连对账的权威依据。

**③ ⚠️ opencode 按目录分实例 —— 不带 `x-opencode-directory` 的请求会被另一个实例回答。**
`/event`、`/session/status` 都受此影响：不带头时订阅到的是默认实例的 Bus，**看不到任何事件、状态永远是 `{}`**。
排查时踩过一次：以为端点坏了，其实是探针没带头。`ApiClient.buildHeaders()` 一直带，产品侧正确 —— 但**新增调用方务必走 ApiClient，别自己 `fetch`**（有测试守着 `getSessionStatuses`）。
后果不是「查不到」而是「查到全 idle」⇒ 对账会**误清正在运行的会话**，比它要修的 bug 更糟。

**④ 到 `gave-up` 的时间不是延迟相加。** `FINITE_SSE_RETRY` 的 1+2+4+8+16=31s 是错的，**实测 61s**：30 秒时心跳看门狗触发 `stalled` → `forceReconnect()` 把 `reconnectAttempts` 清零 → 又跑一轮完整预算（budget 3 ⇒ 最多约 4 轮）。别从延迟反推这个数字。

**⑤ 断连横幅的出现时机分两种，不是一个数。** 杀进程（socket 断）**秒级**；冻住不响应（TCP 不断）**约 34 秒**（30s 心跳 + 4s 宽限）。心跳检测的固有代价，不是缺陷。

**⑥ sidecar 崩溃后没有任何东西会重启它。** `spawn_sidecar` 只在启动阶段调用。所以 UI 上「sidecar 已退出」与「网络断开」必须是**两套文案** —— 对前者说「正在重试」是撒谎。

**⑦ sidecar 日志写盘绝不能重试。** shell 插件的事件通道容量为 1 且读端 `block_on(tx.send)` ⇒ 一个死磕重试的 logger 会把背压**顶回 sidecar 进程**。写失败即永久禁用（`SidecarLog.disabled`）。

**⑧ `sidecar-auth.json` 被重新生成曾会把 app 永久锁死（已修，2026-07-29）。**
`config-context.tsx` 里 localStorage 一旦有密码就**永不重新拉取**。用户删掉 `~/.config/ultrawork/` 重置 ⇒ Rust 生成新密码、前端继续用旧的 ⇒ 永久 401。**症状与「重连失败」完全一样**（横幅常驻 + 点重连没用 + 后台每 15s 重试），排查时极易误判 —— 我真机测试时就踩了这个坑。
现由 `use-credential-resync.ts` 恢复：探测到 **401/403** 且 base URL 是 **auto** 时向 Rust 重取一次。两条守卫都是承重的 —— 非 401 不动（普通断线与凭据无关），非 auto 不动（**用户在设置页指向自己的 opencode 时，那套凭据是他的，覆盖掉等于为了修一个他没有的问题而毁掉他的配置**）。

**⑨ 服务端存的 session `directory` 是 realpath，而 `?directory=` 是精确匹配。**
macOS 上 `/var` → `/private/var`。工作区路径若经软链接，侧栏会**一条会话都不显示**。既有行为；默认工作区不受影响。

**⑩ 测试绝不能写真实 home（复发过一次）。** `SidecarLog` 起初直接用真实日志目录，`cargo test` 把四个假 sidecar 的记录写进了用户的 `~/.local/share/ultrawork/log/sidecar/`。已改为注入式（ADR-051 同款）。**新增任何落盘功能，第一件事就是让路径可注入。**

**⑪ ⚠️ Windows：把 `tauri::AppHandle` 引进 sidecar watcher 会让 `cargo test` 的二进制加载不起来。**
症状 = `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139)，**编译成功、一个用例都没跑**就挂 —— 是链接/加载问题，别去查断言。
两次 CI 对照坐实归因：只回退 `lib.rs` 转绿 · 只回退「`AppHandle` 进 watcher 线程 / `Manager<Wry>` bound / `emit`」这半也转绿（保留纯 std 部分，Windows 跑完 143 用例）。
**机制未明**：`run()` 的 boot 线程早就在 move `AppHandle` 进 `std::thread` 并 `emit` 且一直是绿的 ⇒ 这不是充分条件。
⇒ **在 Rust 侧新增 emit 前先在 Windows CI 上验一次**；macOS/Linux 全绿说明不了任何事。
该能力最终用**不含 Rust 的方式**补回（`use-backend-liveness.ts` 探 `/global/health`），见 ADR-071。

**⑫ ⚠️ 用 `useRef` 当「取消标志」在 effect 里会漏循环。**
ref 跨 effect 运行共享：新一轮把它重置为 `false` **早于**上一轮的 `await` 恢复 ⇒ 旧运行以为自己还有效，继续 `setState` 并**再排一个 timer**，而那一轮的 cleanup 早已跑完、清不掉它。每次依赖变化漏一个轮询循环。
判据：**取消标志必须是 effect 内的局部变量**，不是 ref。
复现要两个条件缺一不可：① 依赖变化时探测**仍在途**（立即 resolve 的 mock 看不到）；② 时钟推进**一整个间隔**（漏掉的循环下一跳在 10s 后，200ms 窗口什么都看不到）。实测计数 = 4（一次配置变化一个循环）。

**⑬ `btoa` 遇非 Latin-1 抛异常，而设置页允许用户随便输用户名/密码。**
把 Basic 头拼在 `try` 外面 ⇒ 变成 **unhandled rejection**，轮询循环直接静默死掉、之后再也不上报。凭据既然编码都编不出来就更认证不了，所以**裸发请求让服务端答 401** 才是诚实做法。

**⑭ ⚠️ opencode 的 401 响应**没有** CORS 头 —— 浏览器里根本读不到状态码。**
`server.ts` 的中间件顺序是 `basicAuth` **在** `cors` **之前**，所以鉴权失败的响应不经过 cors 中间件。实测（真实 sidecar + `origin: tauri://localhost`）：
```
正确凭据: HTTP 200  Access-Control-Allow-Origin = tauri://localhost
错误凭据: HTTP 401  Access-Control-Allow-Origin = ❌ 缺失
```
⇒ **从 renderer 看，「密码错」和「端口没人听」完全一样**（fetch 都是直接 throw）。曾据此把凭据失效误报成「后台服务已退出，请重启」——而重启根本没用，坏密码在 localStorage 里活得好好的。
**逃生口 = `mode: "no-cors"`**：它是**简单请求**，浏览器不发 preflight 也不检查回应 ⇒ 任何状态码都返回 `opaque`（status 0），**只有连接本身失败才 throw**。读不到内容无所谓 —— 要问的不是服务端说了什么，而是**有没有人在那儿说话**。真 Chrome 实测：

| 场景 | 可读 GET | 手动 OPTIONS | no-cors GET |
|---|---|---|---|
| 在跑 + 正确密码 | 200 | **THROW** | opaque |
| 在跑 + 错误密码 | THROW | **THROW** | opaque |
| 已杀 | THROW | THROW | THROW |

**⚠️ 手动发 `OPTIONS` 是没用的**（我先试了这条，被真 Chrome 否掉）：手写的 OPTIONS 不是 preflight，它自己就是个**非简单请求、需要自己的 preflight**，而服务端答的是 `Allow-Methods: GET,HEAD,PUT,POST,DELETE,PATCH` —— **不含 OPTIONS**，所以三种场景全被拦，健康时也一样。

**三种判定已在 WKWebView 真机闭环**（listening / unauthorized / absent 各一次，2026-07-29）—— Chrome 的 e2e 只能证明 Chromium 系（= Windows 的 WebView2），macOS/Linux 是 WebKit 系，属于另一个引擎。

**两层验证都会骗你，必须上真浏览器**：① jsdom 的 fetch 完全不执行 CORS，401 会被正常读到；② 我在 node 里手写的「浏览器模拟」只检查了 ACAO 响应头、**没模拟 preflight 流程**，于是给 OPTIONS 方案发了通行证。常驻回归 = `e2e/backend-liveness-cors.e2e.ts`（真 Chrome + 真 sidecar）。

**⑮ 断流的破坏力不取决于时长，而取决于是否跨越回合结束（ADR-072 / discussions/058，2026-07-30）。**
同一份 harness、同一条 300 marker 的回合，只改断流时长：

| 断流 | 回合结束时界面 | 服务端 | 缺失 |
|---:|---:|---:|---:|
| 8s / 20s（落在回合内） | **300** | 300 | **0 —— 完全自愈** |
| 45s（跨越回合结束） | **7** | 300 | **293（97.7%）且永不自愈** |

机制：回合还在跑时，后续 `message.part.updated` 带的是**全量 part 正文**，会把洞补上；回合一结束就再没有任何事件会到来，界面永远停在断流那一刻的那个词。
⇒ **`sidecar 崩溃` 必然落在坏的那一档**（回合随进程一起死）。**日常抖动都落在好的那一档，所以这个缺口能长期没人发现。**
⇒ 横幅正确弹出，**但没有任何迹象表明正文没补回来** —— 切走再切回能补齐，可那是没人会想到的操作。
现由 `use-session-messages` 的 resync effect 修复（重连 + idle 时就地合并服务端快照）。

**⑯ ⚠️ 自愈能不能跑完，取决于「重连之后还剩多少回合」—— 缩短测试参数会把自愈档静默变成不自愈档。**
写 e2e 时把回合从 300 chunk 缩到 90 chunk、断流从 8s 缩到 4s（想让 harness 快点），**负向控制立刻暴露：本该自愈的 A 档也只剩 19/90**。也就是说那份「A 档通过」根本不是自愈，是修复本身在兜底，而 A 档存在的唯一意义恰恰是证明**修复没破坏自愈**。
⇒ **A/B 两档的参数是实测标定出来的，不是随便取的**（`stream-gap-resync.e2e.ts` 里 `CHUNKS` 上方写死了这条）。**任何「让 harness 快一点」的改动都必须重跑负向控制**，否则守卫会在你看不见的地方退化成第二个 B 档。同类教训见 ADR-067 的对比度阈值标定、gotchas §10⑭。

**⑰ ⚠️ 边跑 harness 边改源码 = Vite HMR 把页面刷了，测量对象在你脚下被换掉。**
症状很好认但极易误判：非空转门报 `ui 19->0` —— **marker 数不是没长，是掉到 0**（整条转录被重新挂载）。第一反应会以为是产品缺陷。
⇒ 判据：**变多 = 传输层根本没断**（Playwright `setOffline` 的典型症状）；**变少 = 页面被重置了**，先想 HMR。`stream-gap-resync.e2e.ts` 的失败信息已经把这两种分开报了。

---

## 21. OOXML 文档技能（`skills/builtin/{pdf,xlsx}`，discussions/059，2026-08-02）

> ⚠️ **①（PyMuPDF）对 `skills/builtin/` 已经完全不适用了** —— `pdf` 技能（059 §六·补三）与
> `deckcraft/scripts/source_to_md/pdf_to_md.py`（§六·补四）都已换成
> pypdfium2 + pypdf + pdfplumber + reportlab，**技能树里没有任何一个文件 `import fitz`**。
> ① 仍然对 `scripts/` 下那三个门禁脚本有效（它们不分发）。
> 新工具链自己的契约见 **⑨–㉑**；坐标系那一族尤其要连着读 **⑨ + ⑳ + ㉑**，
> 它们是三个不同的坐标系陷阱，**没有一个会在未旋转页上现形**。

**① PyMuPDF 有三个坐标系，旋转页必踩。** `get_text` / `get_text("rawdict")` 返回的框是
**页面坐标系**（未旋转），`page.draw_rect` 吃的**也是**页面坐标系，但 `get_pixmap` 渲染的是
**显示坐标系**（旋转后）。实测旋转 90° 的页：抽出的框内 36 个暗像素，乘 `page.rotation_matrix`
后 2282 个。**同一个错误在一轮里出现两次**（技能自己的 bbox 输出 + L2 门禁的豆腐块判据），
后者被判红的还是未改动的源文件。凡「读坐标 → 画到位图上」都要先乘 `rotation_matrix`。

**② `openpyxl.load_workbook(f)` → `save()` 是有损的，损的是「它不认识的 part」。**
实测本仓库 `sample.xlsx` 做**空操作** round-trip（一个字节都不打算改）丢 `xl/metadata.xml`
（904B 动态数组元数据）；自建 fixture 丢 3 个 customXml part。**part 级还不是全部** ——
存活下来的 `sheet1.xml` 内部也会丢 `<ignoredErrors>`。
纠偏一条免得选型时被传闻带偏：**图表 / 条件格式 / 数据验证 / 冻结窗格 / 自动筛选都不丢**
（换个库解决不了也不需要解决）。真正丢的只有它没有模型的 part：customXml、metadata、
线程批注、透视缓存、宏。
⇒ 编辑既有 workbook 的正确姿势是**别把包交给库重建**（见 conventions §26）。

**③ 删一个 OOXML part 是三件事，加回来也是三件事。** part 字节 +
`[Content_Types].xml` 的 `Override` + 每一个指向它的 `Relationship`。只删字节 ⇒ 留下指向空气
的关系（本仓库的 `validate` 层实测咬到过）；只加字节 ⇒ 孤儿 part。
**加回来时 `rId` 必须重新分配，不能照抄** —— 库重建包时会重编号，旧 `rId` 在新包里多半已经
指着别的东西，照抄等于静默改接线。

**④ `xl/calcChain.xml` 是求值顺序的缓存：公式变了必须删，只改值必须留。**
留着旧的 ⇒ Excel 报「发现部分内容有问题」并进入修复流程；无脑删 ⇒ 白白让人重算一遍。

**⑤ 入 git 的 Office fixture 必须逐字节可复现，而不可复现有两个来源。**
`skills/builtin/` 下所有文件都进 `.builtin-version` 哈希 ⇒ 重生成一次 fixture，全体桌面端
重装内置技能。openpyxl 的两个来源：zip 条目时间戳用「现在」，**并且把保存时刻盖进
`docProps/core.xml` 的 `dcterms:modified`，覆盖掉你设的 `wb.properties.modified`**。
后者是跑两遍 diff 才发现的 —— 第一遍以为设了 property 就够了。
PyMuPDF 同族：默认每次 save 换 `/ID`，`doc.save(..., no_new_id=True)` + 固定 metadata 日期可解；
**加密件解不了**（AES 密钥每次随机），只能标注「别随手重跑」。

**⑥ Excel 列宽单位是「默认字体下的字符数」，一个汉字占两格。**
`len()+2` 正好差一半，值老老实实在文件里、屏幕上被截断或显示成 `####`。三条配套规则见
conventions §26；其中**横跨多列的合并标题不算它第一列的宽度**这条，本仓库的 L2 门禁曾因此
把一份渲染完全正常的表判红（转 PDF 读回 20 个字全在）。

**⑦ `fetch-builtin-skills.ts` 的 SOURCES 里留着已改成自写的技能 = 每次 fetch 把自写实现删掉。**
`fetchSubdir` 先 `rmSync(into)` 再拷上游。pdf 重写为自写后已从 SOURCES + `X_REQUIRES` 移除。
另：对上游技能做的任何手改（如 markdown-exporter 的 description 重路由）**必须写成 patch 函数**
（`applyExporterPatches`），否则下次 fetch 静默还原 —— 且改完要**逐字节核对** patch 产出与提交
的文件一致。

**⑧ `soffice` 必须用 `-env:UserInstallation` 指定隔离 profile。** 否则它写进用户真实的
`~/.config` profile（跑一次技能就改了用户的机器），且两次并发转换会抢同一把 profile 锁、
其中一个以一个与文档毫无关系的错误失败。另：**soffice 对它悄悄拒绝的输入也退出 0** ⇒
判成功必须看输出文件在不在，不能看退出码。

---

### 21.1 宽松许可 PDF 工具链（pypdfium2 / pypdf / pdfplumber / reportlab，2026-08-02）

**⑨ 坐标系两个方向相反，且只在旋转页现形。** `pdfplumber` 给的是**显示坐标系**（旋转已应用），
而 widget 的 `/Rect`、页面内容流、要画回文件里的框全是**页面坐标系**；`/Rect` 还额外是
**左下原点**。⇒ 从 pdfplumber 拿的框要**逆**旋转回页面系，从 `/Rect` 拿的框要先转左上原点
再**正向**旋转到显示系。对照值（`report-cjk.pdf` 第 3 页，旋转 90°）：显示
`(502,60,517,450)` ↔ 页面 `(60,78,450,93)`。**方向搞反在未旋转页上完全看不出来**（两个框
一模一样），只有旋转页会把框画到空白纸上。

**⑩ AcroForm 里填的值，pdfplumber / pdfminer / PDFium 一个都看不见。** 三者都只读**页面内容
流**，而域里的值活在 widget 的 `/AP` 外观流里。⇒ 想量「字实际落在哪」必须先把外观**压平**
到页面内容（临时副本），压平规则是 PDF 32000 §12.5.5：`/BBox` 过 `/Matrix` 得到框，再缩放
平移贴到 `/Rect`。（PyMuPDF 的 `get_text()` **会**带上 widget 文字，所以从它迁过来时这一层
是凭空多出来的工作，不迁就以为不存在。）

**⑪ pypdf 的 `replace_contents()` 会把它替换掉的那批 `/Contents` 对象全部置 Null，
而两个页面可以共享内容对象。** `page.merge_page()` 内部走这条路。实测 `table-grid.pdf`
（两页只差格线，MuPDF `garbage=4` 把前 13 个对象去重合并了）：给第 1 页画个框，
**第 2 页整页变空白**（文字 66 字符 → 0）。⇒ 合并任何叠加层之前，先把该页内容拼成一份
**私有**流（`pdfcommon.detach_contents()`）。pypdf 自己也警告 `replace_contents()`
"has proved being unreliable"。**页面之间不共享对象的文档试不出这个**，本仓库是靠 capability
门（P3 的 L2 fidelity）咬出来的，行为测试的 E4 表达不了。

**⑫ pypdf 对加密文件的守卫是「按对象」而不是「按值」。** 加密只覆盖**字符串和流**，页树是
明文，`/Root → /Pages → /Count` 本来就答得出来；但 `len(reader.pages)` 会直接抛
`FileNotDecryptedError`。⇒ 只为这一个数字临时置 `reader._override_encryption = True` 是正确
的（读的是明文数字），但**目录在压缩对象流里时那个流是加密的** ⇒ 拿不到就老实返回 null。

**⑬ pypdf 无论用哪个口令打开，都返回文件里存的那一份 `/P`。** 实测同一个文件 user / owner
都读到 20。⇒ **「以 owner 打开会看到全部允许」这条规范事实用 pypdf 验不出来**（PyMuPDF 会施加
owner 语义，所以从它迁过来的验证代码会静默失去意义）。防线只能放在**写入前**：限制性
`--allow` 且没给独立 owner 口令，就拒绝写。

**⑭ reportlab 的三个静默失败。**
- **`setPageSize()` 只在第一页生效**，后续页面照样继承文档级 `/MediaBox`（实测：canvas 要
  842×595，第 3 页写出来还是 595×842）。内容流坐标是绝对的，所以事后用 pypdf 改
  `/MediaBox` 是对的。
- **标准 14 号字画中文不报错**，会静默掉进 ZapfDingbats、把每个汉字画成黑方块（抽出来是
  `nnnnnnnn`）。⇒ 写之前必须自己查字形覆盖（TTF 用 `face.charToGlyph`，标准字用 cp1252 可编码性）。
- **`Canvas` 会把一个从没用过的 Helvetica 写进每一页的资源字典**，于是「这份文件的字体是不是
  都嵌入了」答案是「否」而理由与正文毫无关系。⇒ 传 `initialFontName=<你的字体>`。

**⑮ reportlab 的 `acroForm.choice()` 遇到非拉丁选项值直接崩**（`escapePDF` 是按字节做的，
`KeyError: 25216`）。⇒ 中文表单域只能用 pypdf 手工构造 widget 字典，`/Opt` 用
`TextStringObject`（它会自动写 UTF-16BE）。

**⑯ macOS 上第一个能找到的 CJK 字体恰恰是嵌不了的那个。** `/System/Library/Fonts/
Supplemental/Hiragino Sans GB.ttc` 是 PostScript(CFF) 轮廓，reportlab 报
`postscript outlines are not supported`。⇒ 字体候选必须**逐个试注册**而不是「路径存在就用」。
实测可用：`Songti.ttc`(subfontIndex=0) · `Arial Unicode.ttf`。另：`.ttc` 要给 subfont 索引，
有用的那一张脸不一定是 0。

**⑰ pdfminer 会把中文读成「康熙部首」，而这一层折叠要分两半做。** Chrome 的 print-to-PDF
把中文导成 Type3 字体，其 ToUnicode 把不少字映射到部首块：`力`(U+529B) 到手是 `⼒`(U+2F12)，
`同比`→`同⽐`、`时长`→`时⻓`。**长得一模一样，比较不相等** ⇒ 搜索/diff/喂模型全部受影响
（PyMuPDF 静默折叠了，从它迁出来才冒出来）。**康熙部首块 (U+2F00–2FD5) 每个码位都有 NFKC
分解**，逐字符 NFKC 即可；⚠️ **CJK 部首补充块 (U+2E80–2EF3) 的 113 个码位一个分解都没有**，
同样的招数对它完全无效，只能查表 —— 且**只该折「本身就是独立汉字」的简化部首**（⻅见 ⻓长
⻛风），`⺅` `⻌` `讠` `纟` 这类**部件**折了等于替文档说它没说的话。
**整串 NFKC 是错的**：会连 `①`→`1`、`％`→`%`、`Ａ`→`A`、`ﬁ`→`fi` 一起改掉。

**⑱ PDF 里没有「空格」只有距离，所以「要不要插空格」是个必须实测标定的阈值。** 同一基线上
分处两地的两段文字之间没有空格字符，直接拼接就粘成 `+31%-24%83%`。实测 deck.pdf 的 1044 对
相邻字符：**CSS letter-spacing 占 0.0180~0.2500（字号倍数），真正的分段从 1.2934 起，中间
5.17 倍宽的带里一对都没有**。阈值必须落在那条空带里（本仓库取 0.9）。**调低的代价不是没效果
而是重现 PyMuPDF 的老毛病** —— 它就是把 letter-spacing 当词间空格，把 kicker 拆成
`E N G I N E E R I N G`。

**⑲ pdfplumber 把「有边框的方块」报成 1×1 的表格。** 幻灯片正是由这种卡片组成的，实测
deck.pdf 第 4/7 页各中一枪：产出 `||` / `|---|` 这种废话 Markdown，**并且顺手吞掉卡片里的
正文**（惯例是丢弃与表格区域重叠的文本块）。⇒ 判据加**「≥2 行且 ≥2 列」**：网格才是表格，
边框不是。

**⑳ 「显示坐标系」之外还有第三个坐标系：文字的阅读系。** ⑨ 讲的是页面系 ↔ 显示系；这一条是
显示系 ↔ **阅读系**。任何按「文字向右走、行往下叠」写的逻辑（按 `y0` 排序、把上方 15% 当页眉带）
在旋转页上都不成立，因为 pdfplumber 给的是 /Rotate 之后的框。**只改行聚类的轴不够** ——
交给上层的每一个几何量（文字/图片/表格/矢量图/页面尺寸）都要换算到同一个阅读系，
渲染时再换回去。附带独立一坑：**页面文字不横向走时 pdfplumber 的 `size` 报的是字的前进宽度
而不是字号**（实测 24pt 标题报成 18.67，连带正文/标题排序全错）—— 字号要从阅读系的框高取。

**㉑ 裁剪框翻转了 y，「有墨」这个判据会给它发通行证。** 实测同一个夹具：正确裁剪墨占比
**0.399**，上下翻转的错误裁剪 **0.587——更高**（翻过去正好落在一张图上）。⇒ 判「裁对了没有」
只能拿**整页渲染后按同一个框裁下来的那块**逐像素比（该路径不做任何 PDF 坐标换算，所以独立）：
正确 0.00，翻转 66.13。墨占比只能证明「不是白纸」，证不了「是这块」。

**㊿ PDFium 不调 `init_forms()` 就不画表单值，而填过的表和空表因此逐像素相同。**
用户填进 AcroForm 的值活在 widget 的 `/AP` 外观流里（⑩），PDFium **只有在表单环境存在时**
才画它。`pypdfium2` 的 `PdfDocument(...)` 不会自动建，`page.render(draw_annots=…)` 也管不着
（那个参数在 v5 已经不是具名形参，传进去落进 `**kwargs` 静默无效）。实测同一份
`form-filled.pdf`：不调 **13540** 暗像素、调了 **22291**；而未填的空表两种情况都是 13540 ——
也就是说**「表单没填」和「画表单的那层没起来」是同一张图**，没有任何东西会报错。
⇒ ① `init_forms()` 必须在**构造之后、取页数或页句柄之前**调（PDFium 的硬性要求）；
② 放在**共享的打开函数**里，不要放在某个渲染入口里 —— 后者就是本仓库栽过两次的
「护栏装在没人走的那条路上」；③ 结果（`initialised` / `none` / 失败原因）**无论成败都要报**。
对非表单 PDF 零影响（实测普通文档 / 无 widget 的扁平件 / 加密件差值全为 0），`init_forms()`
在无 AcroForm 时返回 `False` 而不抛。
⚠️ **量这个缺陷不能用 PyMuPDF 重渲染**：fitz 无论有没有表单环境都画 `/AP`（实测未填 5778 /
已填 9903），拿它当尺子的话修复与「撤回修复」得分完全相同，缺陷直接隐形 ——
必须读被测入口**自己写出的那张 PNG**。这也是「两个门禁量的不是同一件事」的一个新形状：
L2 的 P1/P4 走 PyMuPDF 光栅化，所以它看得见的东西，产品的用户看不见。

**⓫ 用 `add_page` 重建文档会把 catalog 里的 `/AcroForm` 丢掉，而后果取决于阅读器实现。**
（2026-08-05 修）每个 widget 的 `/V` 与 `/AP` 都跟着页面走，catalog 的 `/AcroForm` 不走 ⇒
直接画 `/AP` 的阅读器（PyMuPDF 实测前后都是 9903，macOS 预览属这一类）照样看得见；
走表单模块的（PDFium ⇒ Chrome 内置阅读器，以及本仓库的 `pdf_render`）**看不见**
（实测 13540 = 空表）。而且它**不再是一份可填表单**。
⚠️ **范围比想象的大**：`merge` / `extract` / `delete` / `rotate` / `split` **五个操作全中** ——
凡是「新建 writer 再把页面拷进去」都是这个形状，只盯着 merge 修就是又一次「护栏装在
没人走的那条路上」。修法装在五个操作**共同的那个 `save()`** 上。
三条搬运规则：① `/Fields` 必须从**产出的页面**重建（`add_page` 克隆了注释，输入的 `/Fields`
数组指的不是这份文档现在装着的那些对象）；② 一个 widget 可能挂在父域下（一个域多个页面上
的多个 widget），要**上溯到根域再去重**；③ `/DR`（表单的字体资源）与 `/DA` 得一起带走 ——
一个决定重建外观流的阅读器找不到字体时，把中文值画成空白。
⚠️ **两份都带表单的文件不能默默合并**：同名域在阅读器眼里**就是同一个域**（在一个里打字
另一个跟着变），两份 `/DR` 里同名字体也可能不是一回事。本仓库的选择是**拒绝并点名冲突的域**。
⚠️ 附带一条量它的教训：`/DA` 来自**源文档**而不是填充脚本，本仓库 committed 的
`form-acroform.pdf` 没有它、重生成的那份有 ⇒ 断言写成一张固定的键表会在正确实现上判红。
正确的判据是**「输入有的一个都不能丢」**，这也是搬运唯一能承诺的事。

**⓮ `.ttc` 里「第一个能注册成功的面」不是「适合排整份文档的面」，而两者的差别没有任何东西会报。**
（2026-08-06 L4 人工验收抓的，用户原话是「字体上好像都是黑色粗字体」。）
实测 macOS 15 的 `/System/Library/Fonts/Supplemental/Songti.ttc` 八个面：
`0=SC-Black 1=SC-Bold 2=TC-Bold 3=SC-Light 4=STSong 5=TC-Light 6=SC-Regular 7=TC-Regular`。
而本仓库的候选表把 **index 0 写在第一位**并「注册成功即采用」⇒ 选中的是**最重的 Black**，
又因为一个 face 要画完整份文档，**正文也变成了展示字重**。
⚠️ **面序跨 OS 版本会变，所以修法不是改成 index 6**，是按**字体自述的名字**判字重
（`Black/Heavy/Bold/…`），文字字重直接胜出、展示字重只在别无选择时兜底，并把
「只剩展示字重」这件事报出来（`heavy_weight_only`）。同一个文件里再找**配套的 Bold** 给标题用
——只靠字号分级的标题在 h3（1.25×正文）上读起来是平的；`font-synthesis` 那类合成粗体在
中文上尤其难看，**没有真字重就报 None，不要伪造**。
⚠️ **顺带一条更普遍的**：`Songti.ttc` 的八个面里，**唯独 index 0 没有 U+2022** ——
「哪个面能画哪些字」和「哪个面是第几个」毫无关系，凭位置选面是在赌两件事。

**⓯ 字形覆盖检查只查了调用方写的字，而列表标记是排版自己补的 ⇒ 圆点画成空白，报告说一切正常。**
（同一天、同一份产物，与 ⓮ 是一个因两个果。）`pdf_create.py` 的 `BULLET = "• "` 是**代码常量**，
`collect_text()` 收 `text`/`items`/`header`/`rows` —— 没有任何调用方会在 spec 里声明这个圆点，
于是它**从来没进过覆盖检查**。配上 ⓮ 选中的无 U+2022 的面，每个圆点都画成 `.notdef`：
**纸上是空白，文本层是 `\x00`，报告里是 `missing_glyphs: []`，没有任何一处报错。**
⇒ 通用形状：**「凡是要画的字符都查过」这句话，必须把代码自己注入的那部分也算进去**，
否则守卫在、输入短一截，看起来和通过一模一样。
⚠️ 修法上还有一层取舍：**调用方的字缺字形要拒绝**（从用户的句子里删掉一个字是撒谎），
**标记缺字形应当降级**成 ASCII 替身并报出换了什么（为一个圆点让整份文档失败不划算）——
两者不是同一类东西，用同一条规则处理必然有一头是错的。
⚠️ 量它只能读**产出文件的文本层**：`\x00` 是 `.notdef` 唯一留下的痕迹，问写入方它会说没问题。

**⓰ 「中文任意两字之间都可以断行」差一点点就对，而差的那一点每个中文读者一眼就看见。**
（2026-08-06 L4 自查 B10 路径抓的，缺陷比这一刀老得多。）`pdffont.wrap()` 把每个 CJK 字符
都当成一个断行机会，而 `is_cjk()` 的范围本来就包含 U+3000–303F（`。`）和 U+FF00–FFEF（`，`）
⇒ **标点会被顶到行首**。实测一份四段的中文报告：**823 行里 57 行违规（6.9%）；
试过的 80 个栏宽里有 40 个至少出现一次**。行尾禁则（`（「` 留在行末）在自然语料里罕见，
但在窄栏（表格单元格）下稳定复现。
⇒ 修法是**押出（push-out）**：把标点焊在它所属的那个字上一起挪行，而不是悬挂到版心外
——一个偶尔外挂的栏和真的溢出很难分辨，而本技能的检查正是从页面上读溢出的。
⚠️ **逃生舱比规则本身更要紧**：焊起来的那一串如果本身就宽于整栏（窄单元格里成串标点），
强行不断会把正文推出版心 —— **拿一个排版瑕疵换一个看得见的溢出是亏的**。这种情况必须拆开断，
并且这条让步要写进 SKILL.md，否则下一个人会把它当成漏网。
⚠️ **两个 shipped 夹具都恰好在别处断行** ⇒ 这个缺陷存在于**每一份产物**、而**一个测试都没红**。
所以断言必须自带「夹具还在不在真的考这条」的守卫：拿从页面上量到的字宽模拟一次贪心断行，
证明**不带禁则的话本来会违规**；守卫失败要报「失败的是守卫不是规则」，而不是悄悄变绿。

---

### 21.2 WordprocessingML（`skills/builtin/docx`，discussions/059 S4，2026-08-02）

**㉒ 一句话不是一个 run，而错误实现是「部分正确」的。** Word 因为格式变化、拼写检查、
每次保存的修订 id 把段落切成多个 `<w:r>`。所有人第一反应的
`for r in p.runs: r.text = r.text.replace(a, b)` 在本仓库夹具上实测 **1/2** ——
标题里那次（单 run）找得到，正文里被切成 `"2026 年第"` + `"三季度"` 的那次找不到。
⇒ 必须建**段落字符流**（`<w:t>` 节点 ↔ 偏移映射）再匹配。
⚠️ **一处都找不到的工具一分钟内会被报 bug；十处对九处的工具会一直用下去** ——
所以这条坑的危险不在难度，在它不报错。
附带：替换应继承**第一个** run 的格式（另一种做法会在用户没要求的地方插入格式边界）；
穿过 `<w:tab>`/`<w:br>` 的匹配应拒绝并点名，而不是悄悄把换行删掉。

**㉓ `<w:sectPr>` 必须是 `<w:body>` 的最后一个子元素，而 `body.append(p)` 恰好违反它。**
追加段落是最常见的 docx 编辑，自然写法就是错的。Word 的反应是「修复」文件，
**修掉的正是那个 section** —— 页面尺寸、页边距、页眉页脚绑定一起没。
同族三种序规则都要建模：SEQUENCES（`pPr`/`rPr`/`sectPr`/`tblPr`/`tcPr`/`trPr` 是严格
`xsd:sequence`）· LEADING（`w:p` 的 `pPr`、`w:r` 的 `rPr`、`w:tbl` 的 `tblPr`+`tblGrid` 必须领先）·
TRAILING（就是这条）。

**㉔ 删除的文字是 `<w:delText>`，插入的文字是普通 `<w:t>`，两者都不能按直觉处理。**
`<w:del>` 里的文字**已经不在文档里**，把它折进正文会让文档说出相反的话；
`<w:ins>` 里的文字**在文档里**，漏掉它同样是失真。
⚠️ **python-docx 的 `paragraph.text` 只遍历直接的 `<w:r>` 子元素 ⇒ 读不到被跟踪插入的文字**
（实测本仓库夹具：它给出「本季度同比增长。」，漏掉 `净利润`）。从它迁出来或与它对照时必须知道。

**㉕ python-docx 的 round-trip 不丢东西 —— 不要把 openpyxl 的结论搬过来。**
实测：`Document(p).save(q)` 后 **17/17 part 逐字节相同**（openpyxl 同样操作会丢 customXml/
metadata，见 ②）。它只丢**没有任何关系指向的孤儿 part**（注入一个，保存后消失）。
⇒ docx 用「外科式编辑」的理由**不是**补库的窟窿，而是做库表达不了的事（修订、批注、域、跨 run）。
**照抄 xlsx 的叙事就是一句没有数据的形容词。**

**㉖ 转 .docx 要的是 LibreOffice **Writer**，不只是 `soffice`。** 只装 `libreoffice-calc`
的机器上 `soffice` 二进制存在、**对 .docx 退出 0 且不产出任何文件** —— 与 ⑧ 是同一条规则的
更强版本：判成功只能看输出文件在不在。本仓库 CI 因此一直红着（L2 的 D7 对每个 docx 用例
都转 PDF），只是分支没 push 所以没响。

**㉗ python-docx 自带的 `default.docx` 不合规，所以它不能当门禁的正样本。**
`<w:zoom w:val="bestFit"/>` 缺 Transitional 要求的 `w:percent`（§5·补.8d 首次跑 D2 时发现）
⇒ **它产出的每一份文档都带这条**。要一份能过 XSD 的 docx 夹具，只能手写 ——
本仓库 17 个 part 共 8.3 KB，一次通过 D1–D7 零 finding，且逐字节可复现。

**㉘ 模板填充与文本替换的契约必须不同。** 替换找不到叫「没找到」；
**模板填不上叫「合同带着窟窿发出去了」**。所以模板路径必须额外回答：还剩哪些占位符
（`unfilled`）· 你给的哪个值一个都没匹配上（`unused_values`，基本都是键名打错，
而它与「模板里本来就没这个占位符」在报告里长得一模一样）· 并提供 `--strict` 拒绝写出。
另：**模板默认要填页眉页脚**（普通替换则应 opt-in）—— 信笺抬头里的占位符和正文一样多。

**㉙ 「按条数裁 stdout」挡不住「条数少但每条巨大」，而这一半是两个技能共有的。**
`compact()` 按**列表长度**裁剪，所以一份含 **1 张 800 行表格**的报告列表长度是 1、
直接放行 —— 实测 `docx_read.py --tables` 打出 **130,602 字节**（同一脚本长文档路径的预算是 6,000）。
stdout 由 agent 读、按 token 付费，**team 委派下还要跨边界再付一次**。
⇒ 两道闸都要：**条数**（多而小）+ **字节**（少而大），且**过度修正本身是另一个缺陷** ——
裁完必须仍然说得出「这里有一张多大的表被省略了」，否则「巨大的表」和「没有表」分不出来。
⚠️ **这个缺陷是「换个角度提问」抓的，不是门禁抓的**：C1 只喂过「很多段落」，
从没喂过「一张很大的表」。gotchas §21.1 那条 pdfminer stdout 是同一族。

**㉚ 跟踪修订有五种形态，只认识 `<w:ins>`/`<w:del>` 会毁掉文档。** 另外三种：
`moveFrom`/`moveTo`（+ 区间标记，只解一半等于留半个移动）· **段落标记上的修订**
（`<w:pPr><w:rPr><w:ins/>`，它表示**段落分隔符**被插入/删除，接受或拒绝意味着**合并两个段落**，
当成行内修订解包会「文档看起来没变、编辑其实没生效」）· `<w:pPrChange>` 等格式修订
（**旧属性存在它内部**，拒绝时要放回去；直接删掉 = 报告说拒绝了、格式却留着新的。
⚠️ 还要注意旧属性比看上去深一层：`<w:pPrChange>` 里装的是一个 `<w:pPr>`，
要放回去的是**它的子元素**，直接上提会得到 `<w:pPr><w:pPr>`）。
⇒ 唯一诚实的契约是**每次操作后重扫并报告 `remaining`**，让不认识的形态显形而不是被当成成功。
**段落标记必须最后处理**：它在文档序里是段落的第一个元素，按文档序扫会在段落还装着
即将删掉的内容时就去问「空了吗」⇒ 拒绝一个被插入的段落会留下一个空段落。

**㉛ `<w:ins>` 里嵌 `<w:del>` 是合法的、也是最普通的评审流水**（插入的文字后来又被删了）。
本仓库的 L2 D5 曾用 `.iter()` 后代遍历把它判红 —— **裁决来自 vendored 的 ECMA-376 XSD**
（`CT_RunTrackChange` 的内容模型含 `EG_ContentRunContent`，其中就有 `w:ins`/`w:del`）：
D2 判 VALID、D5 判红 ⇒ D5 错。**放宽必须配正样本用例**，否则分不出「修好了」和「没牙了」。
附带：**python-docx 的 `paragraph.text` 读不到跟踪插入的文字**，所以带未处理修订的文档
用它断言「正文里有没有某句话」会得到错误答案 —— L1 的 sample 写 `contains` 时要点名修订之外的文字。

**㉜ 一条批注是五样东西，删掉最后一条时那个 part 也要走。**
`word/comments.xml` · `[Content_Types].xml` 的 Override · document.xml 到它的关系 ·
`<w:commentRangeStart/End>` · 装着 `<w:commentReference>` 的 run。写三样 = Word 提示修复。
而删一个 part 又是三件事（见 ③）。⇒ 门禁侧同样要有出口：**「这个 part 是有意删掉的」
必须能被表达**，否则唯一的出路是谎报产物 —— 与 `finance_colors` 那条（§21 之外，059 §六·补二）
是同一个病。本仓库的做法是让 `may_drop` 对保真度检查的**每一条**规则生效，并配「不声明就照样打红」的控制臂。

**㉝ 页眉页脚是四样东西，而首页 / 奇偶页变体是五样 —— 第五样才决定前四样有没有用。**
四样 = part · `[Content_Types].xml` 的 Override · document.xml 到它的关系 ·
`<w:sectPr>` 里的 `<w:headerReference>`。第五样是**开关**：`first` 要
`<w:titlePg/>`（同一个 `sectPr` 里），`even` 要 `<w:evenAndOddHeaders/>` ——
**它不在 section 里，在 `word/settings.xml`**（CT_Settings 是一个 97 个子元素的
`xsd:sequence`，`evenAndOddHeaders` 在第 48 位、`updateFields` 在第 78 位，追加即非法）。
四样全对、schema 全过、Word 打开一看还是原来那个页眉，**没有任何东西报错**。
反向同理：删掉首页页眉必须把 `<w:titlePg/>` 一起关掉，否则第一页变成**完全没有页眉**。

**㉞ 目录是一个域，域的结果是缓存，而 LibreOffice 转 PDF 时也不更新域（实测）。**
所以「写好页码，下游会有人更新」不成立 —— 缓存里写什么，PDF 里就是什么。
本仓库的取舍：**条目缓存**（标题文字 + 层级 + 指向书签的超链接，打开即可读可点）、
**页码不写**（放一个不会被误认成数字的占位符），另加 `w:dirty` +
`<w:updateFields w:val="true"/>` 请阅读器自己算，并把这三条写进报告。
⚠️ 附带：TOC 条目活在 `<w:hyperlink>` 里，**python-docx 的 `paragraph.text` 看不见它们**
（与 ㉔/㉛ 同一个原因）⇒ L1 sample 的 `contains` 只能点名标题自身或 TOC 标题。

**㉟ 多级编号有两半，只写一半的 XML 看起来完全正确；而写对了两半会连累第三个东西。**
一半是 `<w:abstractNum>` 的每一级用 `<w:pStyle>` 点名 `HeadingN`，另一半是**标题样式自己的
`pPr` 里要有对应的 `<w:numPr>`** —— 少了后者，编号一个都不出现。
⚠️ 而两半都写对之后：`TOCHeading` 按惯例 `basedOn="Heading1"`，于是**继承**了这套编号，
**目录页自己占掉第 1 号**，真正的第一章变成 2。实测渲染是
「1. 目录 / 2. 经营概况 / 2.1 收入分析 / 3. 风险提示」，**包里没有一处非法**。
解法是给它写 `<w:numId w:val="0"/>`（§17.9.18 留给「取消编号」的值）。
**这个缺陷只有把产物渲染出来才看得见**，结构检查和 XSD 都是绿的。
⚠️ **而这是同一条继承的一半 —— 另一半要真的更新一次域才看得见。**
`basedOn="Heading1"` 同时传下 `outlineLvl=0`，于是「目录」这个标题在阅读器眼里
**就是一级标题**，更新目录时把自己列了进去。实测 WPS（2026-08-05）：技能写的 7 条缓存
变成 8 条，新的第一条是「目录 …… 1」。**渲染也看不见它** —— 渲染出来的是技能自己写的
缓存，而 LibreOffice 从不更新域。两样都要显式取消：`numId=0` + **`outlineLvl=9`**（正文级）。
**这一条给「门禁全绿≠没缺陷」补了一个新形状：有些东西只有在一个会更新域的阅读器里更新
一次才存在** —— 静态检查、XSD、连渲染都路过了它。
附带一条同族的：**目录页码属于最后更新它的那个引擎**。实测同一文件 WPS 排 2 页、
LibreOffice 排 3 页，在 WPS 更新后的页码经 LibreOffice 排版 6 条里 3 条对不上 ——
「下游按一次 F9 就好了」只对**按 F9 的那个阅读器**成立。

**㊱ Word 的图片尺寸单位是 EMU（1 英寸 = 914400），而且一张图要写两个尺寸。**
`<wp:extent>`（排版框）与 `<a:ext>`（图被拉伸成的大小）**必须一致**，
不一致时 Word 画一个尺寸的框、把另一个尺寸的图塞进去 —— 看起来像「导出模糊」不像 bug。
把**像素数**填进 extent ⇒ 图宽 0.00026 英寸（等于没有）；填**厘米数** ⇒ 图几十页高；
**两个都不报错**。尺寸要从图片自己声明的分辨率算（PNG 的 `pHYs` / JPEG 的 JFIF density）：
实测 240px 的图，读 `pHYs`（150 dpi）得 1462919 EMU，按「大家都用 96 dpi」得 2286000 —— 差 56%。
另：往一个从没装过图的包里插图，`<Default Extension="png">` 是**必须新加**的
（它是 Default 不是 Override），少了它 Word 提示修复。

**㊲ 一个 run 没有 `w:rFonts` 不等于它没有字体，而「给每个中文 run 写上宋体」是错的。**
字体沿四层解析（§17.7.2）：run 自己的 `rPr` → `w:rStyle` 字符样式及其 `basedOn` 祖先 →
`w:pStyle` 段落样式及其祖先 → `w:docDefaults`。值可能**早就被说过了**，
覆盖掉任何一层都是在给作者已经做过决定的文字改样式 —— 而改完**一样过 D6、一样能渲染**，
只是不再是交进来的那份文档。⇒ 巡检必须先走样式链并逐 run 报告**这个值从哪来**，
只有「四层都没说」时用默认值才是诚实的（本仓库为这一类单列计数 + `--strict` 拒绝）。
附带：`@w:eastAsiaTheme` **算已绑定**（它是一层间接，不是缺失），
要「显式化」它只能复制那个**属性**，把值 `theme:minorEastAsia` 当字体名写进去是新缺陷。

**㊳ 「哪些 part 有正文」只能有一个答案，忘掉页眉页脚是一种没有症状的缺陷。**
`docx_revise.py` 出厂时**只处理 `word/document.xml`**：页眉里的跟踪修订
`--accept-all` 会**静默留下**，而 `remaining` 也只扫正文 ⇒ 它一边留着修订、
一边报告「没有剩余」。⚠️ **发现它的不是任何针对 W7 的断言，是 W18 的闭环校验**
（接受全部修订后逐字等于 B）在**别的能力**上跑出来的。
⇒ 本仓库把它收进 `docxcommon.text_parts()`（正文 + 全部 header/footer）：
**读与解析覆盖全部 part，写仍是 opt-in**（`docx_edit.py --in-headers` 那套）——
「用户要求改正文」不该悄悄改到信笺抬头，但「接受全部修订」之后还剩修订是纯粹的损坏。

**㊴ 表格边框 `w:sz` 的单位是八分之一磅，而「不写这条边」不等于「这条边没有」。**
写成磅会得到一条细得像渲染 bug 的线，**没有任何东西会报错**。
更隐蔽的是省略：表格若已声明 `w:tblStyle`，你**没有写**的那条边会由样式定义**显出来** ⇒
要「无边框」必须显式写 `w:val="none"`。`CT_TblBorders`/`CT_TcBorders` 的子元素序是
`top, (start|left), bottom, (end|right), insideH, insideV`（Strict 与 Transitional 两套拼写
同处一个 `xsd:choice`）；`CT_TblCellMar` 同理。三张表都是 strict sequence，顺序错即非法。
另：**三线表的那条线不能用 `insideH`** —— `insideH` 画在每一对行之间，那是网格加粗外框，
不是三线表；表头下那一条要写在表头**单元格**的 `w:tcBorders/bottom` 上。

**㊵ 中文列宽：一个显示宽度单位实测 = 105 dxa（中日韩字符），拉丁字符 94~122。**
标定办法是把每个字符串**单独成段**渲染（不可能折行）再从 PDF 量回 x 跨度 ——
不要凭字号推算。`len()` 把一个汉字和一个字母算作等宽 ⇒ 中文列只拿到需要量的**一半**，
而旁边的数字列坐在富余上。本仓库分配用 **130 dxa/单位**（实测最大值往上圆一档）+
两侧 `tblCellMar`。⚠️ **`w:tblLayout` 不写 `fixed` 时，你算出来的 `gridCol` 只是建议**，
渲染器可以不理。以及 **AutoFit-to-contents 会让表变窄** ——
一张声明 7500 dxa 宽却只装四个字的表，「适应内容」之后就是窄的，这是对的，不是缺陷。

**㊶ 跨页重复表头是 `w:tblHeader`，写在表头行的 `w:trPr` 里（实测有效）。**
实测：带它时表头出现在第 1/2/3 页，不带时只在第 1 页 ⇒ 这是**二值、可在渲染层断言**的属性，
也是「表格预设」这类主观能力里少数能被门禁检查的东西之一。
斑马纹底色要**从第一个数据行开始数**，把表头算作第 1 条带 ⇒ 下面每一条都错位一行。

**㊷ 两份 .docx 的 XML diff 几乎必然是噪声，因为 Word 每次保存都重写这些东西：**
`w:rsid*` · `w:proofErr` · `w:bookmarkStart/End` · `w:lang` · 空 run 合并 · 属性顺序 · zip 条目顺序。
⇒ 有用的 diff 必须先定义「什么算一处差异」（本仓库：**一个段落的可见文字变了** + 显式白名单），
并且把上面这些**逐类报出计数而不计为差异** —— 「我看了并判断它不重要」和「我没看」
是两回事，而只有前者可以被检查。
⚠️ **「接受全部修订后等于 B」这条判据必须限定在本次新加的修订 id 上**：
文档可能自带别人的修订，`--reject-all` 把那条也拒掉是正确行为、却不是你要问的问题。

---

### 21.3 真实语料暴露的形状（L3，discussions/059 §六·补九，2026-08-04）

> 下面每一条都**只有别人产的文档才碰得到**：本仓库全部手编夹具跑绿的同时它们是坏的。
> 教训来源见 059 §六·补九「六条独有的教训」。

**㊸ pypdf 是惰性解析的：装在 `PdfReader(...)` 构造处的兜底只盖住一小半。**
一份页面树是瓦砾的 PDF **构造照样成功**，`PdfReadError` / `PdfStreamError` 要等走
`reader.pages` 或对象树时才炸。实测 73 份可读 PDF 里 **9 份**因此把一墙 Python 交给调用方。
⇒ 错误边界要放在**整个入口**上，把 `pypdf.errors.PyPdfError`（+ `DependencyError`）
当成「这个文件坏了」= 一句话 + 非零退出，而不是当成「我们的 bug」。

**㊹ PDF 的元数据值可以是间接引用，`json.dumps` 会当场炸。**
`/Producer` 存成 `12 0 R` 时 pypdf 返回 `IndirectObject`；库写的夹具**永远**把它写成字面量，
所以这条在自建夹具上不可见。⇒ 任何要序列化的 PDF 元数据都得先 `.get_object()`
（**有界地**解，引用可以成环），再把非 JSON 原生类型转字符串。

**⓬ openpyxl 的 `write_only` 工作表是边到边流式写出的，`<cols>` 写在它的开头 ——
所以第一次 `append` 之后设的列宽被静默丢弃。** 不报错、不警告：实测
`xlsx_convert.py --from csv --autofit` 报 `widths_set: 5` 而产物里一个 `<cols>` 都没有
（openpyxl 3.1.5；最小复现是同一段代码把设宽挪到 append 之前，`<cols>` 就在了）。
⇒ ① `write_only` 下**列宽必须在第一次 append 之前设**；② 报告里的数要**从写出的文件里
读回来核对**——这个缺陷能活下来，全靠没有人问过「你报的 5 在文件里吗」。
⚠️ 附带一条覆盖面的教训：本仓库所有列宽断言测的都是**编辑路径**
（`xlsx_write.py --autofit`，走外科式写 sheet XML，一直是对的），**创建路径零覆盖** ——
同一个能力两条代码路径，只测了一条。

**⓭ 一个 multiline 表单域会折行，所以「整串装不装得下一行」是个错的问题。**
实测同一个域：整串要 490.0pt、框宽 300pt，而折行后最宽的一行是 295.44pt，两行都完整渲染。
按单行判会把一个完全可见的值报成溢出。⇒ 认 `/Ff` 第 13 位（`1 << 12`），multiline 走折行后
**逐行**比宽度；真正会出事的是**高度**（行数超过框高 ⇒ 尾巴没了，且没有别的症状）。
⚠️ 门禁里的折行**不要 import 被测技能的实现** —— 一个门禁要能在技能错时和它唱反调，
就不能借用被测对象的代码（与 ㊽「不能用被测对象自己站着的库判输入」同一条规矩）。

**㊺ `<row r="1048576">` 是野外真实存在的，openpyxl 会照单全收。**
非 read_only 的 `Worksheet` **不看 `<dimension>`**（那串字符串是摆设），它的 `max_row` 是从
实际单元格算的 —— 而一份 145 KB 的 workbook 完全可以在最大行号上放一个单元格，于是
`max_row × max_column` = 千万级。实测：默认的整表扫描 **10 分钟没返回**，并把一张 2 行的表
**报成 1048576 行**（后者是错答案，不只是慢）。
⇒ ① 任何「遍历整张表」的路径都要有**单元格预算**，超了必须**打印出来**（一个看起来像完整
结果的截断结果比报错更糟）；② `rows`/`columns` 要从**实际有值的单元格**数出来。
⚠️ `reset_dimensions()` 看着像解药，但 openpyxl 3.1.5 **只在 `ReadOnlyWorksheet` 上有它** ——
在普通 worksheet 上 `hasattr` 直接 False，一个静默不执行的守卫会让注释里的修复变成谎话。

**㊻ `docProps/app.xml` 的 `<Application>` 不是这份 XML 的出处证明。**
它说的是**原始文档**是谁存的；夹具被手工裁过之后它照样留在那里。实测：三份写着
`Microsoft Word` 的 .docx，`<w:tbl>` 缺必需的 `<w:tblPr>` —— Word 不会那么写。
⇒ 想说「这是 Word/Excel 亲手存的」时，只能说「它**声称**是」。

**㊼ 两套实现比崩溃率时，判据不能是退出码。** 退出码是**约定**，而两代实现的约定可以不同：
本仓库新技能是「exit 2 = 可操作的错误，exit 1 留给真崩溃」，被它取代的旧脚本是
`print('Error opening …'); return 1`（一行干净的话）。按退出码判，旧的会因为**用了另一套约定**
被整片记成崩溃，比出来的差距是测量造的。⇒ 判据取**与约定无关**的那个量：
stderr 里有没有裸 traceback（外加信号/超时）；退出码另记一笔，且只对声明过它的那一方有意义。

**㊽ 「输入好不好」不能用被测对象自己站着的库去判。** 用 openpyxl 判 xlsx 输入是否合法，
而被测的 `xlsx_read.py` 也站在 openpyxl 上 ⇒ 凡是它读不了的都被划进「输入本来就坏」，
**它的崩溃率是它自己划的分母**。⇒ 输入门只做**结构性**判断（能否当 zip 打开 / 必需 part
在不在 / XML 良构），PDF 换一个独立实现（pdfminer，不是 pypdf）。
另：输入**自带**的规范违规不该扣分母，只该**屏蔽那一条检查**对输出的判定。

**㊾ 拿真实语料喂门禁，会先打脸门禁自己。** in-process 跑校验既没有超时也没有内存边界：
上面㊺那份 workbook 让 L2 的 openpyxl 校验吃到 **4.7 GB RSS 且不收敛**，一份病态文件挂死整轮。
⇒ 校验跑在**子进程 + 超时**里，顺带守住第二件事：lxml / pypdfium 这类 C 扩展在畸形输入上
会**段错误**，in-process 的话整个门禁跟着死，而且死状看起来像「跑完了」。
判不了的那些要单列成「**门禁自己的局限**」，不进任何率的分子 —— 它不是被测对象的缺陷。
