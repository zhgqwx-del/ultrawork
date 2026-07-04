# ADR-042: BYOK 联网搜索 — 多 provider websearch + qwen enable_search

- 状态：Accepted（✅ 已实现并真机真 key 验收通过，2026-07-04）
- 日期：2026-07-04
- 关联：[discussions/026](../discussions/026-byok-websearch.md)（完整调研与方案，SSOT）、ADR-036（工具披露 EAGER 名单）、ADR-039（全局配置 + 软刷新生效链路）、gotchas §1/§3/§11

## 背景

opencode 原生 `websearch` 对本项目"名存实亡"：registry 门控只对官方托管 provider 开放（我们全用自定义 qwen provider → 工具表里根本没有搜索工具），且被 ADR-036 折叠名单盖住。模型面对调研/时事类问题只能拿 `webfetch` 猜 URL。根因与四个备选路线的完整论证见 discussions/026 §1-4。

## 决策

### D1 — 路线 A：vendor patch 改造原生 `websearch` 为多 provider BYOK 工具
复用工具 id / 描述锚点 / `websearch` 权限点。`tool/websearch.ts` 重写为 provider 分发：Tavily / 阿里云 IQS（REST + Bearer）+ 原 Exa 公共端点降级为显式 opt-in。优先级：**显式指定 > tavily > aliyun-iqs > exa**；`provider:"auto"` = 清除显式选择（PATCH mergeDeep 删不掉 key，故 enum 里专设 auto 值）；`provider:"exa"` 本身计为 exa opt-in（不静默失效）。显式指定的 provider 缺 key 时回落优先级序（stale 配置不 brick 搜索）。**刻意不做失败 failover**（计费可预测；单次执行只打 `providers[0]`）。

### D2 — key 借道 auth.json（`search-tavily` / `search-aliyun-iqs`）
`PUT /auth/:id` 不校验 id；未知 id 在 `mergeProvider` 早退（不实例化幽灵 LLM provider，026 §5.2 + 安全审查双重核实）。auth.json 每次现读、不进任何缓存 → **配 key 无需任何刷新，下一步即生效**。UI 的"已配置"状态经新增只读端点 `GET /global/auth/:authId/status`（只报存在性+类型，永不回显 secret；在 server basic-auth 后）。

### D3 — 注册门控 = "已配置即注册"，失败降级不杀回合
`registry.ts` 门控改为：`enabled !== false && (hosted ‖ OPENCODE_ENABLE_EXA ‖ isWebsearchConfigured())`。两条硬约束：① `enabled:false` 优先于一切路径；② 可用性检查跑在每步热路径上，auth.json 撕裂读/损坏必须 `catch(() => false)` 降级为"不注册"——`Effect.promise` 拒绝是 defect，会杀掉整个回合（对抗审查 MAJOR）。`websearch` 同时从 disclosure COLLAPSE 移入 EAGER（BYOK 门控已保证"注册即用户配置过"，无需再折叠）。无 key = 不注册 = 自然降级到改动前现状。

### D4 — 设置页「工具」分区（integration 组）
两张 provider 卡（key 保存/删除/测试连接 + 「获取 API Key ↗」外链走 `openUrl`）+ 默认服务商 Select + Exa 收进高级区默认关（国内可达性存疑、第三方公共端点无 SLA）。测试连接走 Rust `curl`（webview CORS 拦直连；沿 `test_provider_connection` 先例，新增 `test_search_provider`，最小真实搜索 1 次额度、UI 明示）；**test-before-save**：已存 key 永不回渲染层，测试按钮仅在输入框有新 key 时可用。IQS 卡明示 key ≠ DashScope key + 新 key 约 5 分钟生效（认证失败 toast 同样带此提示）。卡片间 mutating 操作全局互斥（auth.json 写竞态）。链接常量集中 `lib/external-links.ts`。

### D5 — qwen `enable_search` 零 vendor 改动 + 双挂点
`provider.<id>.models.<modelId>.options.enable_search` 被 opencode 原样 spread 进请求体顶层（链路 026 §5.1，e2e P3 断言锚定）。UI 双挂点：① 自定义 provider 创建表单能力勾选（含 DashScope key 复用提示 + 获取链接）；② **已存在 provider 的模型行 toggle**（写全局 config + 软刷新；创建表单挂点覆盖不到已配置的内置 alibaba-cn——真实主场景）。toggle 显示按 `isDashScopeLike` 启发式（id/name/baseURL 匹配 dashscope|aliyun|alibaba|bailian，**刻意不含裸 qwen**——自建 vLLM Qwen 会被 enable_search 未知键 400）+ "已设置过的模型永远显示"（不 strand）。关闭写显式 `false`（删不掉 key）；re-add 反勾选时读残留才发显式 false（不向非 DashScope host 注入未知键）。**已知边界**：流式路径 `search_info.search_results` 来源被 AI SDK 丢弃 → 只有答案质量提升、无来源展示（vendor `metadataExtractor` 列为可选后续）。

### D6 — 连带修复两处上游合并缺陷（Phase 3 触发面）
config 扩展循环（`provider.ts` config-model-over-models.dev 重建）：`interleaved` 无 `existingModel` 回落（部分覆写即破坏 kimi/glm/deepseek 系 reasoning_content 解析）+ cost 重建丢 `experimentalOver200K`（qwen3.6/3.7-plus 分层计价静默丢失）。两处已进 vendor patch——**任何**config 侧模型覆写（不止本特性）都受益。

## 后果

- **vendor bump 面扩大**：`websearch.ts` 整文件重写 + registry 门控 + config schema + global.ts 路由 + provider.ts 合并修复 + disclosure EAGER 名单全进 patch；bump 连带清单见 `vendor-patch-workflow.md` + `vendor-opencode-bump-survey.md`。
- Team 外部 ACP agent（claude/gemini）用不到本工具（自带搜索；如需覆盖走 `hostMcpServers()` 转发=026 路线 B 思路）。
- 环境变量：`ULTRAWORK_TAVILY_BASE_URL` / `ULTRAWORK_ALIYUN_IQS_BASE_URL` / `ULTRAWORK_EXA_BASE_URL`（e2e stub / 私有网关）。
- 深度参数：config 端 pin（`tavily.searchDepth` / `aliyunIqs.engineType`）**优先于**模型请求（防模型烧 advanced credit；两家精确对齐）；IQS 默认 LiteAdvanced（Generic 计费 ~3.5×）、`contents.summary` 付费项不启用（免费 snippet 够用）。
- 验证：纯函数单测 32 · cargo 40 · desktop vitest 307 · api-client 70 · headless e2e `websearch-byok` 18/18（真 sidecar + stub 双搜索源 + mock LLM 捕获工具注册态与请求体）· 真浏览器 e2e `websearch-ui-walkthrough` 10/10（Chrome+Vite+真 sidecar，每步断言 auth.json/opencode.json 磁盘真相）；5 路对抗审查 + 二轮核实 + 三轮 fresh-eyes（全量 diff / 完备性 / 用户流程）追加修 8 项。
- **真机真 key 验收（2026-07-04，通过）**：① 直连 API 契约核实——Tavily 真实响应 `results[].{content,score,title,url}`+`answer` 精确匹配 `parseTavilyResponse`（`published_date` 确认 basic 档不返回、optional 守卫正确）；IQS 对齐后探针 body（含 `contents`/`timeRange`）**200 接受**、`pageItems[].{link,snippet,rerankScore,publishedTime,title}` 匹配 `parseIqsResponse`；坏 key 状态码 IQS+DashScope key→403 / Tavily 垃圾→401（分类器映射 `auth` 正确，IQS 提示放宽已覆盖）。② 真 sidecar + 真 qwen3.7-max + 真 BYOK 全链——Tavily 与 IQS 各驱动模型真实调用 `websearch`、返回真实结果（metadata `provider` 正确、输出格式含 published/score/snippet）、最终答案引用真实新闻。③ `enable_search` 经真 config 管道——关掉 websearch 工具后模型仍返回今日新闻，证明模型内置搜索在真模型上真实触发。验收 harness 为一次性（不入库，stub e2e 是回归套件）；真 key 未泄漏进任何仓库文件。
