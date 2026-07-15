# ADR-057：首启默认免费模型 = OpenCode Zen 试用入口（同意门控 + 探活优选 + 显式失败）

- 状态：已接受（Accepted — P1~P4 完成 + P5 自动化验证通过 + **macOS 真机验收通过**〔真 Rust consent 落盘/清除 + 真 opencode seed + 真 Zen 回复，2026-07-15〕；Windows/Linux 靠 CI 兜底）
- 日期：2026-07-15
- 背景调研：`docs/discussions/040-default-free-zen-model.md`（含逐条实证数据）
- 相关：ADR-037（跨平台）· ADR-042（BYOK）· ADR-034/049（idle-guard，失败必须可见）· gotchas §1（OpenCode 契约）

## 背景

全新电脑首次安装后，应用没有被选中的默认模型：`currentModel` 初始为空，全局 `opencode.json` 不存在 ⇒ 模型选择器显示 "no model"，用户必须先进设置页配 provider + API key 才能对话。零门槛体验缺失。

诉求：把默认设成 OpenCode Zen 的**免费**模型，做到开箱即用。

调研实证（详见 discussions/040）三个关键事实：

1. **免费模型已能匿名加载，无需 vendor patch**：`opencode` provider 的 loader 在无 key 时保留免费模型并用 `apiKey:"public"` 匿名访问（`provider.ts:178-198`）。空配置真跑 sidecar，`/provider` 的 `connected` 已含 `opencode` + 6 个免费模型。
2. **「列出即失败」是真的**：`/provider` 列出的免费集 ⊄ 线上匿名可用集——`mimo-v2.5-free` 在 connected 里却匿名 401；`gpt-5-nano`（官方称永久免费、且是 opencode 的标题模型默认优先级）匿名 401。今日实测能匿名跑通且支持工具调用的是 5 个：`big-pickle`、`deepseek-v4-flash-free`、`nemotron-3-ultra-free`、`north-mini-code-free`、`hy3-free`。
3. **可靠性不受我们控制**：免费集随 models.dev 运行时刷新而漂移；模型会被弃用/轮换；匿名池全球共享有配额（`FreeUsageLimitError`）；官方文档已改口称免费模型也需注册+账单，匿名 `public` 是未文档化通道，随时可能关闭。

## 决策

把默认免费 Zen 模型定位为**零门槛试用入口**（不是可靠免费层），并用三条约束兜住上面的风险。

### D0：定位 = 试用入口，不承诺可靠免费层

产品叙事上，这是「让新用户一键先跑起来看看」的入口，长期使用引导 BYOK（ADR-042）。据此，任何不可控的第三方降级都以「引导去配自己的 key」收场，而非视作产品故障。

### D1：同意门控（consent-gated first-use）——取代「首启自动 seed」

**隐私默认关**与「开箱即用」直接冲突：不能默认就把用户代码发给「数据可能用于训练」的免费模型。因此**首启不自动激活**免费模型。

- 首次在无任何模型可用（未配 key）时**发起对话**，弹一次性同意卡片：
  「免费试用实验性模型？你的输入可能被第三方用于改进模型。〔启用免费试用〕〔用我自己的 API Key〕」
- **点「启用」才** seed `cfg.model` 为选中的免费模型并激活；点「用自己的 Key」走现有设置页流程。
- 同意标志持久化在全局配置（如 `~/.config/ultrawork/opencode.json` 的一个私有字段，或独立 flag 文件），设置页提供开关可随时撤销（撤销后清 seed 的 model、恢复未配置态）。
- 未同意前，选择器维持现状（"no model" + 引导），下拉里即便列出免费模型也**不预选、不激活**。

> 明确否决：首启静默 seed 并直接用免费模型。它满足「开箱即用」但违背「隐私默认关」——把用户代码发给会训练的第三方而不告知，是信任红线。「一键同意」已经足够低门槛。

### D2：探活优选（probe-then-pick）——取代「选第一个免费模型」

不信任 `/provider` 列出的免费集，也不写死一个模型 id（会腐烂）。

- 维护一个**偏好序**（仅作排序，不作白名单）：`big-pickle` > `deepseek-v4-flash-free` > `nemotron-3-ultra-free` > `north-mini-code-free` > `hy3-free`（依据 discussions/040 实测：可匿名 + 支持工具调用）。
- 用户点「启用」时，在 `connected` 的 `opencode` 免费模型中，**按偏好序取交集**，对候选发一个**最小探活请求**（含一个 dummy tool，验证匿名可用 + 工具调用），**第一个通过的**作为 seed。
- 偏好序里的都不通过时，回退到 connected 免费集里任意一个通过探活的；全都不过 ⇒ 落到 D3。
- 探活结果可短期缓存（避免每次启用都打网络），但**不长期钉死**——免费集会变。

> 明确否决：硬编码单一 `default = "big-pickle"`。模型会被弃用/轮换（`grok-code` 已 deprecated），硬编码等于给未来埋一个「某天所有新机默认模型 404」的雷。探活让它自愈。

### D3：显式失败，绝不静默挂

- 探活全失败 / 匿名通道被上游关闭（整片 401）⇒ 不 seed，明确告诉用户「免费试用当前不可用」并引导配 key，**不留一个选中却发不出消息的死状态**。
- 运行期遇 `FreeUsageLimitError`（配额耗尽）⇒ 明确提示「免费额度已用完」+ 引导（升级 Zen Go / 配自己的 key），**不能让回合静默卡住**（ADR-034/049 的教训：静默挂比报错更坏）。

### D4：辅助模型角色一并切到可用免费模型

opencode 给 `opencode` provider 的标题模型默认优先级是 `["gpt-5-nano"]`（`provider.ts:1546-1548`），而 gpt-5-nano 匿名 401。启用免费试用时，必须把标题/摘要等辅助角色也指到 D2 选中的免费模型（经 config 覆盖，如 `small_model` / 相应字段），否则自动起标题会静默失败。**待实现时确认 opencode 该版本覆盖辅助模型的确切 config 键。**

### D5：UI 诚实标注

下拉/卡片里给这些模型打「免费 · 实验性」标签；同意卡片明示隐私影响。不美化成「稳定免费」。

## 跨平台（ADR-037）

本改动主体是前端 TS（同意流、探活、seed）+ 读写全局 `opencode.json`，与平台无关。免费加载机制在 provider 层，三平台一致。无 unix-only 命令、无硬编码路径。CI 三平台 typecheck/test 兜底。

## 影响面（预估，待实现细化）

- 前端：`lib/model-context.tsx`（seed/激活）、新同意卡片组件、`components/settings/models-section.tsx`（撤销开关）、`components/chat/model-selector.tsx`（标签 + 未同意态）。
- Rust/config：全局 `opencode.json` 读写已有帮手（`lib.rs:6032/6041-6066`），加一个「免费试用已同意」标志与 seed 写入。
- 无需 vendor patch。

## 明确不做

- 不内置真 API key 打包分发（会被扒出盗用 + 违反 ToS）。
- 不做完整 onboarding 向导（超出「试用入口」范围，另议）。
- 不承诺免费额度/SLA。

## 验证计划（实现时）

- **单测**：同意门控状态机（未同意不激活 / 同意后 seed / 撤销后清除）；探活回退逻辑（首选失败→次选→全失败落 D3）。
- **实测**：空配置真跑 sidecar 走完整「首次对话→弹卡片→启用→探活→seed→发消息成功」链路（headless + 真 opencode + 真 Zen 网关）。
- **注入故障**：mock 整片 401（通道关闭）验 D3 落地引导；mock `FreeUsageLimitError` 验配额提示不静默挂。
- **辅助模型**：验证启用后自动起标题不再打 gpt-5-nano、不 401。
- **隐私**：验证未点同意前，没有任何请求发往 Zen 网关（含探活）。
- 真机手动验收（打包 .app，非 dev——参考 ADR-053/056 教训，通知/权限类只有打包身份才准）。

## 待实现时确认的落地细节（非阻塞，非新调研）

1. ~~opencode 该版本覆盖标题/辅助模型的确切 config 键（D4）。~~ **已查实**：config 键 `small_model`（`config.ts:906`，格式 `provider/model`），在 `getSmallModel` 里**优先于**内置 `["gpt-5-nano"]` 优先级（`provider.ts:1526-1531`）⇒ seed 时同写 `small_model: "opencode/<模型>"` 即可，无需 vendor patch。
2. 同意标志存全局 `opencode.json` 私有字段 vs 独立 flag 文件，二选一（倾向：独立 flag，避免污染 opencode 的 schema；见清单 P2）。
3. 探活缓存/回退状态存放（见清单 P1/P4）。

> **设计定稿（2026-07-15，采纳 review 建议）**：
> - **不做独立探活**，改「**乐观 seed + 首条真实消息失败即透明回退**」——点「启用」直接 seed 偏好序第一名，首条消息若 401/配额错则客户端透明换下一候选、重发、重 seed。理由：砍掉独立探活机制（最大不确定项）+ 探活口径与生产完全一致（本就是真消息）。代价：极少数首条消息有一次可见重试，可接受。
> - **撤销带保护**：仅当 `model`/`small_model` 仍等于当初 seed 的免费值时才清；已被用户改动则只清 consent flag、不动 model。

---

## 三路对抗审查（2026-07-15，真机验收前）— 抓 4 缺陷全修

实现完成后、用户手动验收前，三路并行对抗审查（正确性/竞态 · 跨平台/打包 · 团队-ACP/完备性），抓出 **4 个真缺陷**（其中 2 个 HIGH 致命），全部已修 + 补回归测试：

- **🔴 HIGH-1 · P4 自动回退重发完全失效（死代码）**：原实现在 SSE idle handler 里**同步**触发重发，但 `setSending(false)`/`markSessionIdle` 是未 flush 的 setState、`activeIdsRef` 要下次渲染才更新 ⇒ `sendMessage` 的 busy 门当场吞掉重发，且 `freeTrialResendModelRef` 已提前清空 ⇒ 首条免费模型 401 后**用户消息静默永不重发**。修：移出 idle handler，改由**键在 `sending` 上的 effect** 触发（effect 在 state flush 后运行，门已放行）。回归测试 `use-session-messages-freetrial-fallback.test.ts`（驱动 发送→session.error(auth)→idle→断言重发第 2 次用新模型；旧代码此测试失败）。
- **🔴 HIGH-2 · 启用后同意卡片重开、首消息发不出**：`handleEnable` 的 retry 是 consent 之前渲染捕获的 stale 闭包，`setState` 未 flush ⇒ 再入 `maybeOfferFreeTrial` 仍读到 `""`/`false` ⇒ 门二次触发、卡片重开。修：`maybeOfferFreeTrial`/`advanceFreeTrialModel` 改**读 ref 而非捕获 state**，`handleEnable` 在调 retry 前**同步更新 ref**。回归测试（model-context.test.tsx「stale-closure regression」：retry 再入门断言返回 false）。
- **🔴 HIGH-3/4 · ACP 模式误弹卡片**（单 agent + 团队 leader 皆中）：门只看全局 `currentModel`/consent，不看 backend。装了 Claude/Gemini CLI 的用户选 ACP agent 时 `currentModel=""` ⇒ 误弹「免费 zen 试用」卡片，而 ACP backend 根本不用 opencode model。修：门调用处用现成信号短路——`Home.tsx` `!isACP`、`Session.tsx` `supportsModel`（ACP 会话为 false）。
- 🟡 附带修：`handleEnable` 失败/空候选路径 `pendingRetryRef` 泄漏、`isFallbackResendRef` 随 HIGH-1 修复而正确消费。
- ✅ 审查确认无问题项：UI 侧拦截完整（IM/delegate/后端自发正确豁免）· 门置于副作用前无二次 materialize/重复会话 · SSE 无重订阅 · 跨平台无硬编码（consent 文件走 `global_config_dir()`/`PathBuf::join`，无 unix-only 权限分支，Tauri camelCase↔snake_case 双向映射正确）。

---

## 分阶段实现清单（定稿）

> 依赖：P1、P2 可并行；P3 依赖 P1+P2；P4 依赖 P3；P5 收尾。每阶段都要能独立验证。
> **隐私不变量（贯穿全程）**：用户点「启用」之前，**不得有任何请求发往 Zen 网关**。首条消息（含隐含的乐观 seed）只发生在「启用」之后，因此不违反。

### P1 — 选型逻辑（纯逻辑，无 UI、无网络，可单测）✅ 已完成（`src/lib/free-model.ts`）
- [x] `FREE_MODEL_PREFERENCE`：偏好序常量 `["big-pickle","deepseek-v4-flash-free","nemotron-3-ultra-free","north-mini-code-free","hy3-free"]`（依据 discussions/040 实测：可匿名 + 支持工具调用）。
- [x] `orderedFreeCandidates(providers)`：从 `GET /provider` 的 `opencode` connected 免费模型（`cost.input===0`，排除有 key 时混入的付费模型 + 排除 cost 缺失的未确认模型）中，先按偏好序排，再把偏好序外的其余附后（自愈漂移），返回有序候选列表；无则空数组。附 `isFreeZenModel()`（供 D5 标签）。
- [x] 单测 9 个全绿（provider 缺失 / 偏好序排序 / 漂移模型附后 / 排除付费 / 排除无 cost / connected 空 / provider id 标记 / isFreeZenModel / 偏好序无重复）+ typecheck 干净。

### P2 — 同意状态与持久化（Rust config + 前端逻辑）✅ 已完成
- [x] 全局「免费试用已同意」标志：**独立 flag 文件** `~/.config/ultrawork/free-trial-consent.json`，Rust 路径参数化读写 + 3 个 Tauri 命令 `get/set/clear_free_trial_consent`（`lib.rs`，已注册）。camelCase 序列化。解析失败/缺失 → 读作「未同意」（隐私默认关，永不误读为已同意）。**不污染 opencode.json schema**；sidecar 不碰此文件 ⇒ 无跨进程双写。
- [x] seed：`enableFreeTrial()`（`lib/free-trial.ts`）走 **`patchGlobalConfig`**（单一写入者=sidecar；`?refresh=soft` 不打断在飞 turn）写 `model` + `small_model`（均 `opencode/<候选>`），再 `setConsent` 记 seed 值。
- [x] 撤销（**带保护**）：`revokeFreeTrial()` **仅当** `model`/`small_model` 仍等于记录的 seed 值时才清（清=**空串**：opencode config 深合并无删键、zod 拒 null，空串在前后端 `if(cfg.model)` 均 falsy＝unset，`ModelId=z.string()` 接受空串——已核 vendor 源码，非猜）；被用户改过则保留其选择。
- [x] IO 适配器 `lib/free-trial-store.ts`（Tauri invoke + api-client，含 stub-host resolve-null 防御）。api-client `OpenCodeConfig` 补 `small_model` 字段。
- [x] 单测：Rust 5 个（缺失/损坏→未同意 · roundtrip · clear · camelCase）+ 前端 6 个（seed 两字段+记值 · 撤销未改→清 · 撤销已改→保留 model 只清 small · 两者都被改→只清 flag · 无 seed 记录→只清 flag）全绿。
- [ ] ~~前端 React 状态 `freeTrialConsent`~~ → **移至 P3**（与触发/卡片 UI 耦合，逻辑模块已就绪，React 接线在 P3 做）。

### P3 — 首用触发 + 同意卡片 UI（依赖 P1+P2）✅ 已完成（代码层；交互/视觉验收留 P5）
- [x] 触发条件用纯函数 `shouldOfferFreeTrial(providers,currentModel,consented)`（+6 单测）锁死：仅当无选中模型 + 未同意 + 有免费候选 + **无其他可用连接模型**（配了自己 key 的用户不会误弹——服务端会挑其付费模型，无泄露）。
- [x] **pre-dispatch 拦截**：`maybeOfferFreeTrial(retry)` 接入**全部三处发送入口顶部**——`Session.tsx handleSend`（materialize 之前，避免自动重发二次拷贝附件）+ `Home.tsx handleSend`（单发 + 团队 opencode leader 共同入口）。返回 true 则调用方 abort。
- [x] 卡片 `FreeTrialConsentDialog`：〔启用免费试用〕〔用我自己的 Key〕+ **隐私说明**（默认关、可能用于训练）+「启用中…」loading。
- [x] 「启用」→ `orderedFreeCandidates()` 取第一名 → 乐观 seed（**不探活**）→ setCurrentModel + 置 consented → **自动重发**触发消息（空 model 派发经服务端解析落到 seed 值，stale 闭包无碍）；候选为空 → toast「不可用」+ 引导（P4 完整回退在下一阶段）。
- [x] 「用自己的 Key」→ 关卡片 + **跳转 设置 → 模型 tab**（沿用 `navigate("/settings",{state:{section:"models"}})` 约定；ModelProvider 在 Router 之上，故用 `@/router` 单例的 `router.navigate`，且**动态 import 断开 router→页面→useModel 的静态循环**）；输入框文本保留。
- [x] 选择器：免费 zen 模型打「免费」徽标（D5，`/provider` flatten 已带 `cost`，用 `isFreeZenModel` 判定）。
- [x] 设置页撤销开关：`freeTrialConsent` 为真时显示「免费试用已启用 + 关闭」，接 `revokeFreeTrial`（P2 带保护逻辑）。
- [x] i18n 中英各 12 键；typecheck 干净、desktop 全量 **606** 通过。
- [x] **交互链路已由真浏览器 e2e 覆盖**（`free-trial-consent.e2e.ts` 7/7 PASS：卡片实弹/启用/自动重发真 Zen/徽标/撤销）——与 ADR-047/048/051/053/055 不同，本功能是 DOM 逻辑（非原生窗口/主线程堵塞），Playwright 够得着。仅**像素级观感** + **真 401 触发透明回退**（难构造）留人工。

### P4 — 透明回退 + 失败/配额兜底（D3，依赖 P3）✅ 已完成（逻辑层；SSE 时序验收留 P5）
- [x] 纯函数 `classifyZenError()`（quota/auth/other）+ `nextFreeCandidate()` + `isZenModelId()`（+8 单测）。
- [x] **架构现实**：模型 401/配额错**不是 `connector.prompt` 的 reject**（prompt 是 fire-and-forget，返回 204 即 resolve），而是 **`session.error` SSE 事件**——故在 `use-session-messages.ts` 该单点处理（它同时拥有 `sendMessage` 与消息历史）。
- [x] **透明回退（auth）**：`session.error` 分类为 auth 且当前是免费 zen 模型 → `advanceFreeTrialModel()` 换下一候选并重 seed → **延迟到该会话下次 `session.status:idle` 再重发**上一条用户消息（`session.error` 时 `sending` 仍 true，立即重发会被 busy 门吞——用 ref 暂存、idle 触发）；每次 auth 推进一个候选 ⇒ 自然终止；另设 `MAX_FREE_TRIAL_FALLBACKS=6` 兜底防误分类死循环；候选耗尽 → 撤销 seed（不留选中却发不出的死态）+ 「不可用」引导。
- [x] **配额（`FreeUsageLimitError`）**：分类为 quota → 明确提示「免费额度已用完」+ 引导（配 key / 升级 Zen Go），**不静默挂**（既有代码已 toast 原始串，此处替换为本地化可操作提示）。
- [x] **耦合处理**：`use-session-messages` 因此需 `useModel`，为不破坏隔离单测（无 ModelProvider）新增**不抛错的 `useModelOptional()`**，无 context 时回退关闭免费试用逻辑。i18n 中英各 +2 键。
- [x] 单测 8 个（分类 quota/auth/other · 候选推进/耗尽/未知/空）全绿；desktop 全量 **614** 通过、typecheck 干净。
- [ ] **SSE 时序链路验收留 P5**（首候选 401→idle→自动重发→次候选成功 · 配额提示 · 耗尽撤销）——依赖真 SSE 事件时序，单测够不着，需真机或 headless 真 opencode。

### P5 — 验证与验收（自动化部分 ✅；真机手动留用户）
- [x] 单测汇总：desktop **614**（free-model 23 + free-trial 6，共约 30 新）· Rust **147**（consent 5）· 全 monorepo typecheck 8/8 · 跨包无回归（gateway 251 / connector 90 / api-client 73）。
- [x] **可复用验证脚本** `scripts/verify-free-zen.ts`（固化 discussions/040 的实证探针，vendor bump 后复验）：A 空配置真跑 sidecar → `/provider` 列出 6 个 opencode 免费模型；B 线上 Zen 匿名探活偏好序（含工具调用）；C 首选 `big-pickle` 可用。**本次运行全过**（big-pickle/deepseek/north-mini/hy3 匿名+工具皆通；nemotron 偶发无工具但非首选）。
- [x] **真浏览器 e2e** `e2e/free-trial-consent.e2e.ts`（Chromium + 真 Vite app + 真 fresh-config opencode + **真 Zen 网关联网**，`bun run e2e:free-trial`）：A fresh install 发送弹同意卡片；B 启用→seed→自动重发→**真 Zen 返回内容 marker**（整链路端到端）；C 选择器免费徽标；D 设置页撤销开关显示+关闭清除。**本次运行 7/7 PASS**。消耗少量匿名免费额度；非 CI 常驻（联网+慢），on-demand。
- [x] **隐私断言（论证证明）**：Zen 网关仅在**消息派发（`connector.prompt`）**时被命中；`/provider` 走本地 sidecar、`patchGlobalConfig`/consent 均本地；P3 门在**派发前**拦截未同意的发送 ⇒ 同意前不可能有请求发往 Zen（构造性保证，非运行时抓包）。**唯一背景流量** = sidecar 无条件后台刷 models.dev（模型**元数据**，非用户代码，与隐私门无关）。
- [x] **辅助模型（论证证明）**：seed 同写 `small_model`（`opencode/<免费>`），vendor `getSmallModel` 优先读 `cfg.small_model`（`provider.ts:1526-1531`）先于内置 `gpt-5-nano` ⇒ 起标题不会打 401 的 gpt-5-nano。
- [x] 跨平台：逻辑全平台无关（TS + 本地 config 读写，无 unix-only/硬编码路径）；Rust consent 用 `path.parent()` 无平台分支；CI 三平台兜底。
- [x] **macOS 真机验收通过（2026-07-15，`tauri dev` + 临时 XDG 模拟首次安装，真 Rust/真 WKWebView/真 sidecar/真 Zen）**：① fresh install 发消息**弹卡片** ✓；② 点启用 → **真 Rust 写 `free-trial-consent.json`**（`consented:true` + `seededModel/seededSmallModel=opencode/big-pickle`，camelCase 正确）+ **真 opencode.json seed** `model`+`small_model=opencode/big-pickle` + **真 Zen 回复** marker ✓；③ 选择器「免费」徽标 ✓；④ 撤销 → **真 Rust 清 consent**（`consented:false`）+ **带保护清 model**（`model/small_model`→空串，因仍等于 seed 值）✓。**验证坑（血泪）**：opencode **向上目录树合并 opencode.json**，dev 机三处泄漏 model（仓库根 / desktop 包 / 工作区），首次安装须用**无 opencode.json 的干净工作区**；macOS WKWebView localStorage **按 bundle 存、不随 XDG 变**，旧 sidecar 密码残留致首连 401（清 `ultrawork-config` 重取即好）。剩 ④ 透明回退真 401（难构造）+ 打包 `.app` 与 Windows/Linux 未上真机。
- [x] ~~小 UX 欠账：「用自己的 Key」未跳设置页~~ → 已补：跳转 设置 → 模型 tab。
