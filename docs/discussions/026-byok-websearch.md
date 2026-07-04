# 026 — BYOK 联网搜索：Tavily + 阿里云 IQS 接入方案（websearch 复活）

> 状态：✅ 方案已拍板，待实现
> 日期：2026-07-03
> 关联：ADR-036（渐进式工具披露，EAGER/COLLAPSE 名单）· ADR-039（全局配置 + 软刷新，生效链路）· gotchas §1/§3/§11 · `docs/vendor-patch-workflow.md`
> 范围：给 agent 提供真正可用的联网搜索工具（BYOK：用户自配 key 启用，不配则降级现状）；连带 qwen `enable_search` 模型内置搜索开关。**不涉及** Team 外部 ACP agent 的搜索能力（它们自带）。

---

## 0. 一句话

opencode 原生有 `websearch` 工具但对我们"名存实亡"（registry 门控只对官方托管 provider 开放 + 我们的 tool-disclosure 又把它折叠），模型面对调研类问题只能拿 webfetch 猜 URL。方案 = **vendor patch 把 `websearch` 改造成多 provider BYOK 工具**（Tavily / 阿里云 IQS / Exa 兜底），key 借道 auth.json，设置页新增「工具」分区配置，配 key 即软刷新生效、不配自然降级；连带给 qwen 加 `enable_search` 开关（**已验证零 vendor 改动可通**）。

---

## 1. 问题根因（源码实证）

"今天有哪些 AI 新闻"之类的调研问题基本不搜索、全靠 webfetch，是**两层叠加**：

1. **registry 门控**（`vendor/.../tool/registry.ts:165-167`）：`websearch`/`codesearch` 仅当 `model.providerID === "opencode"`（官方托管 provider）或 `OPENCODE_ENABLE_EXA=1` 时才注册。我们全用自定义 provider（qwen）→ 模型工具表里**根本没有搜索工具**。
2. **渐进式工具披露**（ADR-036，`plugin/tool-disclosure.ts:70-73`）：即便放开门控，`websearch` 也在 `COLLAPSE_BUILTINS` 折叠名单里，模型需先调 `tool_search` 才能用到。

补充事实：
- 原生 `websearch`（`tool/websearch.ts`）= 硬编码 POST **Exa 公共 MCP 端点** `https://mcp.exa.ai/mcp`（无 key、非 BYOK，国内可达性存疑）。
- `webfetch` 零搜索能力：纯 fetch 单 URL + turndown 转 markdown（`tool/webfetch.ts`），描述文本也无任何搜索语义。

## 2. vendor 侧可用的注入机制（备选路径盘点）

| 机制 | 位置 | 说明 |
|---|---|---|
| 改内置工具（**选定**） | `tool/websearch.ts` + `registry.ts` | 复用工具 id / 描述 / `websearch` 权限点；经 vendor patch 管理 |
| plugin `tool` hook | `packages/plugin/src/index.ts:192-194`，注册于 `registry.ts:104-109` | 不改 vendor 可注入新工具（内置 plugin 先例 = tool-disclosure） |
| config 目录 `tool/*.ts` 扫描 | `registry.ts:89-102` | 零 patch，但工具代码散落用户 configDir，升级管理差（内置技能 zip 已踩过同类坑） |
| MCP server | 现有 MCP 注册链路 | 见 §4 路线 B |

生效链路关键事实：`tool-registry` 在 ADR-039 软刷新八缓存集合内（`registry.ts:61` `InstanceState.makeSoft`，我们的 patch）→ `PATCH /global/config?refresh=soft` 后工具注册状态即时更新、不打断在流回合。

## 3. 两个搜索 API（官方文档实证，2026-07-03）

### 3.1 关键纠偏：百炼帮助页 ≠ 独立搜索 API

https://help.aliyun.com/zh/model-studio/web-search 讲的是 **`enable_search` 模型参数**（Chat Completions 里 `extra_body: {"enable_search": true}` + `search_options`，来源经响应 `search_info.search_results[]` 返回，仅 title/url 无摘要）。它是"模型回合内自动联网"，**不能当独立 `search(query)` 工具给任意 agent 调**。

阿里独立搜索 API = **IQS（信息查询服务，产品名「通晓」）**。

### 3.2 API 对比

| | Tavily | 阿里云 IQS（unified） |
|---|---|---|
| Endpoint | `POST https://api.tavily.com/search` | `POST https://cloud-iqs.aliyuncs.com/search/unified` |
| 认证 | `Authorization: Bearer tvly-xxx` | `Authorization: Bearer <IQS API-Key>`（**⚠️ 不是 DashScope key**，IQS 控制台单独创建） |
| 关键参数 | `query` / `search_depth`(basic=1 credit, advanced=2) / `topic` / `max_results`(≤20) / `time_range` / `include_domains` | `query` / `engineType`(Generic/GenericAdvanced/LiteAdvanced/Deep) / `timeRange` / `advancedParams.numResults`(≤50) / `contents.{summary,rerankScore,...}` |
| 响应结果 | `results[]{title, url, content, score}`（**摘要字段叫 `content`**）+ 可选 `answer` | `pageItems[]{title, link, snippet, publishedTime, rerankScore?, mainText?}` |
| 免费额度 | **每月 1000 credits 循环**，无需信用卡 | 试用 1000 次 / **仅 15 天**；之后 Generic ~42 元/千次、LiteAdvanced 12 元/千次 |
| 官方 MCP/SDK | `tavily-mcp`（npm）+ hosted MCP + `@tavily/core` SDK | 无官方 MCP；SDK 走 AK/SK 签名（BYOK 场景直接 fetch + Bearer 最干净） |

两者可无损抽象为统一 `search(query, {depth, maxResults, timeRange}) → [{title, url, snippet, score?, publishedAt?}]`。命名陷阱：Tavily 摘要 = `content`（≠ `raw_content`）；IQS 深度档位映射 basic→`LiteAdvanced`、advanced→`Generic`（计费差异大）。

来源：Tavily [API Reference](https://docs.tavily.com/documentation/api-reference/endpoint/search) / [Credits](https://docs.tavily.com/documentation/api-credits)；IQS [统一接口](https://help.aliyun.com/zh/document_detail/2883041.html) / [凭证管理](https://help.aliyun.com/zh/document_detail/2872258.html) / [计费](https://help.aliyun.com/zh/document_detail/2862023.html)。

### 3.3 社区先例（印证设计）

- **OpenClaw `web_search`**：15 provider，按凭证可用性自动探测优先级，无任何可用 provider 时工具**不注册**——"配 key 才注册、没 key 降级"是业界一致做法。
- **Open WebUI**：Admin 设置选 provider + 贴 key 的纯 BYOK 模式。
- opencode 上游无官方方案（issue #309 open）；社区 `opencode-websearch`（provider-native 搜索、零 key）、`opencode-websearch-cited`（custom tool + 引用）。

## 4. 路线对比与拍板

| 路线 | 要点 | 结论 |
|---|---|---|
| **A：vendor patch 改造原生 `websearch` 为多 provider BYOK** | 改动集中（~2 文件）；复用工具 id/描述/权限点；`tool-registry` 软刷新即时生效；disclosure EAGER 一行搞定（tool-disclosure.ts 本就是我们的 patch 文件） | ✅ **选定** |
| B：内置 MCP server（抄 knowledge-base 骨架） | 零 vendor patch、可经 `hostMcpServers()` 给外部 ACP agent；但 MCP 工具默认被 disclosure 折叠、多常驻进程、工具名前缀尴尬、启停链路绕 | ❌ |
| C：直接挂官方 `tavily-mcp` | 最快但 IQS 无对应物、node 子进程、输出不可控 | ❌ |
| D：configDir `tool/*.ts` 注入 | 零 patch 但工具代码散落用户目录、升级管理差 | ❌ |

**四个决策点（用户已拍板，2026-07-03）**：
1. 路线 **A**（vendor patch 原生工具）。
2. **单一 `websearch` 工具 + provider 优先级**（显式指定 > tavily > aliyun-iqs > exa 仅显式开启），非两个独立工具。
3. **Exa 免费端点默认关**，高级区显式开关（国内可达性存疑）。
4. **IQS 独立 API 与 qwen `enable_search` 两者都做**。

## 5. 两个关键机制核实（源码实证，实现依赖）

### 5.1 `enable_search` 零 vendor 改动可通 ✅

`provider.<id>.models.<modelId>.options` 里的任意键会被原样 spread 进 chat completions 请求体顶层：
- config → `provider/provider.ts:1100`（model.options merge）→ `session/llm.ts:216-221`（mergeDeep）→ `llm.ts:368` `providerOptions: ProviderTransform.providerOptions(...)` → `transform.ts:938-939` 以 providerID 为命名空间 → `@ai-sdk/openai-compatible` `getArgs()` 把未知键 **spread 进请求 body 顶层**。
- ⚠️ 注意：**provider 级** `provider.<id>.options` 是错误位置（进 SDK 构造器被丢弃），必须放**模型级** options。
- **已知边界**：流式路径下阿里返回的 `search_info.search_results` 引用来源被 AI SDK 丢弃（delta 是 strict schema + opencode 未开 `includeRawChunks`）→ phase 3 只有答案质量提升、**无来源展示**；要展示需另做 vendor patch（`metadataExtractor`），列为可选后续。

### 5.2 搜索 key 借道 auth.json 安全 ✅

- `PUT /auth/:id` 不校验 id 是否已知 provider（`server/server.ts:119-129`；`ProviderID.zod` 即任意字符串）。
- provider 枚举虽遍历 auth.json 全部 entry（`provider/provider.ts:1136`），但未知 id 在 `mergeProvider` 的 `if (!match) return`（`provider.ts:1026`）被静默跳过——**不会实例化幽灵 provider**。
- 约束：id 不得与 models.dev provider id / config provider id 撞名 → 用 `search-tavily` / `search-aliyun-iqs`。
- auth.json 不进任何配置缓存（每次现读），改 key 无需刷新。

## 6. 实现计划

### Phase 1 — vendor patch：多 provider BYOK `websearch`

| 文件 | 改动 |
|---|---|
| `tool/websearch.ts` | 重写为 provider 分发：读 config 定顺序；execute 时 `Auth.get("search-tavily"/"search-aliyun-iqs")` 现读 key；Tavily/IQS 两个 REST client；结果统一格式化 `title/url/snippet/score/publishedTime`（Tavily `answer` 有则附）；保留 `ctx.ask("websearch")` 与 `abortAfterAny` 超时；缺 key 报可操作错误；endpoint 允许 env 覆盖（`ULTRAWORK_TAVILY_BASE_URL` 等，为 e2e stub） |
| `tool/websearch.txt` | 微调：多源搜索、保留年份注入、强化"调研/时事类问题优先用本工具" |
| `tool/registry.ts:165-167` | 门控改为：「config 已启用且有已配置 provider」‖ 原两条件；`codesearch` 门控不动 |
| `config/config.ts` | 新增 `experimental.websearch: { enabled, provider?, exa?, tavily?: {...}, aliyunIqs?: {...} }`（沿用 `experimental.tool_disclosure` 先例） |
| `plugin/tool-disclosure.ts` | `websearch` 从 `COLLAPSE_BUILTINS` 移入 `EAGER_BUILTINS` |

生效链路：设置页写 key（`PUT /auth/:id`）→ 写开关（`PATCH /global/config?refresh=soft`）→ `tool-registry` 软失效 → 下一回合工具即出现；不配 key = 不注册 = 自然降级现状。patch 按 `docs/vendor-patch-workflow.md` 重新生成（新文件如有需先 `git add -N`），重编 `bun run --bun scripts/build-opencode.ts`。

### Phase 2 — 设置页「工具」分区（desktop）

- `pages/Settings.tsx`：`SettingsSection` 联合类型 + `NAV_GROUPS` 的 `integration` 组新增 `tools`（紧挨「MCP 连接器」）。
- 新文件 `components/settings/search-tools-section.tsx`：两张 provider 卡（外壳抄 `BrowserServiceCard`〔Settings.tsx:321〕，key 输入抄 models-section password 模式〔:539/:782〕）：key 输入（只显"已配置"不回显）、启用 toggle、默认 provider 单选、测试连接（复用自定义 provider 探活机制；**实现时确认 renderer 直连外网 CORS，不行走 Rust 侧**）。IQS 卡明示 key ≠ DashScope key + 计费；Exa 开关收进高级区默认关。
- **获取 key 引导链接**（key 输入区旁「获取 API Key ↗」外链，系统浏览器打开——沿用现有外链机制 tauri-plugin-opener，勿裸 `<a>`）：
  - Tavily → `https://app.tavily.com`（注册即送每月 1000 credits，key 前缀 `tvly-`）
  - IQS → 控制台 API-Key 页 `https://iqs.console.aliyun.com/api-keys`（需先开通服务；**⚠️ 新建 key 约 5 分钟后才生效**——测试连接失败提示中必须带这一句，避免用户误判配错）
  - 链接 URL 抽成常量集中管理（便于失效时统一修），文案 i18n 中英对称。
- i18n 中英对称；数据流：key → `putProviderAuth`（`api-client/client.ts:357`），开关 → `patchGlobalConfig`（`:307`）。非 MCP，不动 `BUILTIN_MCP_NAMES`。

### Phase 3 — qwen `enable_search` 开关（零 vendor 改动）

- 写 `provider.<id>.models.<modelId>.options = { enable_search: true, search_options: {...} }`，走 `PATCH /global/config?refresh=soft`。
- UI：models-section 每模型参数区（`feat/custom-provider-model-params` 那套）加「模型内置联网搜索」勾选 + "仅阿里云百炼（DashScope）模型支持"提示。
- key 说明：`enable_search` **复用该 provider 已配置的 DashScope key，无需新 key**；在提示文案处附 DashScope key 获取引导链接 `https://bailian.console.aliyun.com/?tab=model#/api-key`（帮助文档 https://help.aliyun.com/zh/model-studio/get-api-key ；新 key 前缀 `sk-ws`，明文仅创建时展示一次）。
- 边界（§5.1）：来源不展示，写进 gotchas。

### 测试方案

1. 单测：provider 分发/两家响应格式化/缺 key 错误路径（抽纯函数）；desktop 新分区 vitest。
2. headless e2e：stub HTTP 服务仿两家响应 + env 覆盖 endpoint → 真 sidecar 验「配 key→注册→调用→结果注入」「无 key→工具不存在」两态 + 软刷新即时生效。
3. 真机 + 真 key：Tavily/IQS 各验"今天有哪些 AI 新闻"触发 websearch；enable_search 真 qwen 开/关对照。
4. 回归：typecheck 8/8、desktop 281+、vendor opencode 套件、check-docs。⚠️ GitHub Actions 停摆期间本机全量自验。
5. 惯例：多轮对抗审查后合入。

### 收尾文档

ADR-042（BYOK 联网搜索）· CHANGELOG · gotchas（IQS key ≠ DashScope key / search_info 丢弃 / websearch 门控新语义）· `vendor-patch-workflow.md` patch 内容表 · `vendor-opencode-bump-survey.md` 追加 bump 连带（websearch.ts 整文件进 patch，bump 需重做；EAGER 名单复核项+1）。

## 7. 风险与刻意取舍

- **vendor bump 面扩大**：websearch.ts 整文件重写进 patch——已列 bump 连带清单。
- **Team 外部 ACP agent（claude/gemini）用不到本工具**：刻意不覆盖（它们自带搜索；如未来要覆盖走 `hostMcpServers()` 转发，即路线 B 思路）。
- **IQS 试用短**（15 天）且按次计费 → 默认推荐位给 Tavily（月循环免费额度）。
- **Exa 默认关**：免费但国内可达性存疑，且是第三方公共端点无 SLA。

规模预估：vendor patch ~350 行 + desktop ~500 行 + 测试。
