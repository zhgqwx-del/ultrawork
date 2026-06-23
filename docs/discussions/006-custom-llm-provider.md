# Discussion 006: 自定义 LLM Provider 机制调研 — 兼容 OpenAI / Anthropic 协议的「自带 Key + Base URL」接入

- **日期**: 2026-06-04（初版调研）/ 2026-06-19（§11 实现规划 + spike + 实现落地）
- **状态**: ✅ 已实现 + 真机验证（分支 `feat/custom-provider`）——§11 三项决策落地；api-client + `models-section.tsx` 自定义表单/删除。**真机确认 my-qwen(dashscope) 可选中并对话**。**真机保存/删除卡死根因坐实 = React StrictMode 的 `mountedRef` 守卫 bug（cleanup-only 未在 setup 复位 → dev 下挂载后恒 false → `setSaving(false)` 被跳过）**，修复为 effect setup 复位 ref；Chrome+Playwright StrictMode 下 before/after 截图实证（破损版转圈、修复版恢复）+ jsdom 回归测试。先前两次误判（v1.15.13 争用[实为 v1.3.13]、WKWebView 死连接[日志证伪]）对应的投机改动（请求超时/原子 PATCH 重排/乐观更新）已全部回退（详见 §11.10）。验证：typecheck 8/8 · api-client 58 · desktop 223 · headless API 走查 15/15。
- **参与者**: 用户 + Claude
- **范围**: 基于 `vendor/opencode` 源码（submodule，已 apply Ultrawork patch）+ Ultrawork main 分支前端 / api-client

> 本文回答一个核心问题：**Ultrawork 要让用户「自己填 API Key + Base URL + 自定义参数」添加一个兼容 OpenAI / Anthropic 协议的 provider，需要做什么？**
>
> 结论先行：**opencode sidecar 后端已经原生具备这个能力**，不需要改 vendor 源码。真正要补的是 **Ultrawork 前端 UI** 和 **api-client 封装**——目前前端只能在「已知 provider 列表」里选一个填 Key，无法新建一个列表外的全新 provider。
>
> 所有结论均带源码定位（`文件:行号`），可直接跳读核对。

---

## TL;DR

1. **后端能力完备**。opencode 的 provider 体系由四层数据 merge 而成：`models.dev` 内置数据库 → `opencode.json` 的 `provider` 字段 → 环境变量 → `auth.json`。用户在 `opencode.json` 里写一个全新 provider（指定 `npm` / `api`(=baseURL) / `models` / `options`），就能凭空造出一个 provider，**无需改源码**（`vendor/.../provider/provider.ts:1031+` 的 config merge 逻辑）。

2. **OpenAI 兼容是一等公民**。`@ai-sdk/openai-compatible` 已被 BUNDLED（编译进 sidecar，`provider.ts:34,135`），而且是**所有未知 provider 的默认 SDK**——config merge 时 `npm` 字段的最终 fallback 就是它（`provider.ts:1056-1060`、`config merge` 与 `fromModelsDevModel` 双处）。所以「填个 baseURL + apiKey 接任意 OpenAI 兼容服务」开箱即用。

3. **Anthropic 兼容**靠 `@ai-sdk/anthropic`（同样 BUNDLED，`provider.ts:128`）。只要把自定义 provider 的 `npm` 显式设为 `@ai-sdk/anthropic` 并给一个 `baseURL`，即可接 Anthropic 协议的第三方服务（如自建网关）。

4. **baseURL / apiKey / headers 注入链路清晰**。运行时 `resolveSDK()`（`provider.ts:1295-1430`）把 `options.baseURL`（或 `model.api.url`）、`provider.key`（来自 auth.json）、`model.headers` 拼好后传给 SDK 工厂函数。`baseURL` 还支持 `${ENV_VAR}` 占位符替换（`provider.ts:1311-1331`）。

5. **前端是短板**。`model-dialog.tsx` 只能：在 `GET /provider` 返回的**已知列表**里选 provider → 填 `apiKey`（写 auth.json）+ 填可选 `baseURL`（写 `opencode.json` 的 `provider.<id>.options.baseURL`）。**没有「新建一个列表外 provider」的入口**，也不能填 `models` 列表、`npm` 类型、自定义 header（`model-dialog.tsx:127-160`）。

6. **api-client 也只封装了子集**。`putProviderAuth` 只支持 `{type:"api", key}`；`OpenCodeConfig` 类型是简化版，`patchConfig` 能写 `provider.<id>.options` 但前端从未写过 `npm` / `api` / `models` 字段（`client.ts:280-285`、`types.ts:277-281`）。

7. **推荐实现路径**：**纯前端 + api-client 扩展，不动 vendor**。新增一个「自定义 Provider」表单，收集 `{id, name, protocol(openai/anthropic), baseURL, apiKey, models[], headers?}`，通过 `PATCH /config` 写 `provider.<id>`（含 `npm`/`api`/`models`/`options`）+ `PUT /auth/<id>` 写 key。详见 §8。

---

## 1. Provider 体系的整体架构

### 1.1 四层数据来源与 merge 顺序

provider 列表在 sidecar 启动时由 `Provider` 服务的 state 初始化构建，优先级从低到高叠加（`vendor/opencode/packages/opencode/src/provider/provider.ts:978` 起的 `layer`）：

| 层 | 来源 | 作用 | 源码定位 |
|----|------|------|---------|
| 1 | **models.dev 数据库** | 内置上百个 provider + 模型元数据（cost/limit/capabilities） | `provider.ts:989` `ModelsDev.get()` |
| 2 | **`opencode.json` 的 `provider` 字段** | 覆盖内置 / **新建自定义 provider** | `provider.ts:1031+` config merge |
| 3 | **环境变量** | 检测到 provider 声明的 env（如 `OPENAI_API_KEY`）则自动启用 | `provider.ts:1122-1132` |
| 4 | **`auth.json`** | 用户存储的 API Key / OAuth 凭证 | `provider.ts:1134-1145` + `auth/index.ts` |

> 关键点：**第 2 层（config）是自定义 provider 的落点**。它既能覆盖 models.dev 里已有的 provider，也能定义一个 models.dev 完全没有的全新 provider。

### 1.2 models.dev 数据加载与缓存

`vendor/opencode/packages/opencode/src/provider/models.ts`：

- `Data = lazy(...)`（`models.ts` 顶部）按以下顺序取数：① 本地缓存文件 → ② 编译期内置 `models-snapshot.js` → ③ 从 `models.dev/api.json` 网络拉取。
- `OPENCODE_DISABLE_MODELS_FETCH` 环境变量可禁用网络拉取；每小时 `refresh()` 一次。
- **对自定义 provider 无依赖**：自定义 provider 不在 models.dev 里，完全靠 config 提供元数据，所以**离线也能用**。

### 1.3 models.dev 的 Provider schema（自定义 provider 要对齐的基线）

`vendor/opencode/packages/opencode/src/provider/models.ts:73-82`：

```ts
export const Provider = z.object({
  api: z.string().optional(),        // ← 即 baseURL（默认 API 地址）
  name: z.string(),
  env: z.array(z.string()),          // ← 自动启用用的环境变量名列表
  npm: z.string().optional(),        // ← 该 provider 用哪个 AI SDK 包
  models: z.record(z.string(), Model),
})
```

单个 Model 还能带 `provider: { npm?, api? }` 覆盖（`models.ts:68`），即**模型级别**也能指定 npm / baseURL。

---

## 2. Provider / Model 运行时数据结构

`vendor/opencode/packages/opencode/src/provider/provider.ts:862-875`（`Provider.Info`）：

```ts
export const Info = z.object({
  id: ProviderID.zod,
  name: z.string(),
  source: z.enum(["env", "config", "custom", "api"]),  // 来源标记
  env: z.string().array(),
  key: z.string().optional(),                          // 实际 API Key（从 auth/env 注入）
  options: z.record(z.string(), z.any()),              // 传给 SDK 工厂的配置
  models: z.record(z.string(), Model),
})
```

`Model`（`provider.ts:791-860`）核心字段：`id` / `providerID` / `api: { id, url, npm }` / `name` / `capabilities` / `cost` / `limit` / `status` / `options` / `headers`。

> `api.url` = 该模型实际请求的 base URL；`api.npm` = 用哪个 SDK 包；`headers` = 该模型附加的 HTTP header。这三者在 `resolveSDK` 中被消费（见 §4）。

内置的 well-known provider id 常量列在 `vendor/opencode/packages/opencode/src/provider/schema.ts`：`anthropic` / `openai` / `google` / `openrouter` / `azure` / `amazon-bedrock` / `mistral` / `github-copilot` 等。

---

## 3. 自定义 Provider 的 config schema（关键）

`opencode.json` 的 `provider` 字段定义在 `vendor/opencode/packages/opencode/src/config/config.ts`：

- 字段声明：`config.ts:943` `provider: z.record(z.string(), Provider).optional()`，描述为 *"Custom provider configurations and model overrides"*。
- 单个 Provider schema：`config.ts:801-860`（基于 `ModelsDev.Provider.partial()` 扩展）：

```ts
export const Provider = ModelsDev.Provider.partial().extend({
  whitelist: z.array(z.string()).optional(),   // 模型白名单
  blacklist: z.array(z.string()).optional(),   // 模型黑名单
  models: z.record(z.string(), ModelsDev.Model.partial().extend({ variants: ... })).optional(),
  options: z.object({
    apiKey: z.string().optional(),
    baseURL: z.string().optional(),
    enterpriseUrl: z.string().optional(),       // GitHub Copilot 专用
    setCacheKey: z.boolean().optional(),
    timeout: z.union([z.number().int().positive(), z.literal(false)]).optional(),
    chunkTimeout: z.number().int().positive().optional(),
  }).catchall(z.any()).optional(),              // ← catchall：允许任意额外 SDK option
}).strict().meta({ ref: "ProviderConfig" })
```

> **`options` 末尾的 `.catchall(z.any())`（`config.ts:853`）是「自定义参数」的关键**：apiKey / baseURL / timeout 之外的任何键（如 `headers`、SDK 专属字段）都被接受并原样透传给 SDK 工厂函数。

### 3.1 自定义 OpenAI 兼容 provider 的最小配置示例

```jsonc
{
  "provider": {
    "my-openai-compat": {
      "name": "My OpenAI-Compatible Service",
      "npm": "@ai-sdk/openai-compatible",         // 不写也行：未知 provider 默认就是它
      "api": "https://api.example.com/v1",         // = baseURL
      "env": [],
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "${MY_KEY}"                       // 也可不写，改用 auth.json（见 §4.2）
      },
      "models": {
        "my-model-1": {
          "id": "my-model-1",
          "name": "My Model 1",
          "tool_call": true,
          "limit": { "context": 32000, "output": 4096 }
        }
      }
    }
  }
}
```

### 3.2 自定义 Anthropic 兼容 provider

只需把 `npm` 换成 `@ai-sdk/anthropic`（已 BUNDLED），其余同上：

```jsonc
{
  "provider": {
    "my-anthropic-gw": {
      "name": "My Anthropic Gateway",
      "npm": "@ai-sdk/anthropic",
      "api": "https://anthropic-gw.example.com",
      "options": { "baseURL": "https://anthropic-gw.example.com" },
      "models": { "claude-proxy": { "id": "claude-proxy", "name": "Claude (proxy)", "tool_call": true } }
    }
  }
}
```

### 3.3 config 与 models.dev 的 merge 细节

`vendor/opencode/packages/opencode/src/provider/provider.ts:1031` 起：

```ts
for (const [providerID, provider] of configProviders) {
  const existing = database[providerID]              // models.dev 里的同名 provider（可能不存在）
  const parsed: Info = {
    id: ProviderID.make(providerID),
    name: provider.name ?? existing?.name ?? providerID,
    env:  provider.env  ?? existing?.env  ?? [],
    options: mergeDeep(existing?.options ?? {}, provider.options ?? {}),  // 深合并
    source: "config",
    models: existing?.models ?? {},
  }
  for (const [modelID, model] of Object.entries(provider.models ?? {})) {
    const existingModel = parsed.models[model.id ?? modelID]
    const parsedModel: Model = {
      id: ModelID.make(modelID),
      api: {
        id:  model.id ?? existingModel?.api.id ?? modelID,
        npm: model.provider?.npm ?? provider.npm ?? existingModel?.api.npm
             ?? modelsDev[providerID]?.npm ?? "@ai-sdk/openai-compatible",  // ← 最终 fallback
        url: model.provider?.api ?? provider?.api ?? existingModel?.api.url ?? modelsDev[providerID]?.api,
      },
      status: model.status ?? existingModel?.status ?? "active",
      // capabilities / cost / limit 同样 config 优先、models.dev 兜底...
    }
    parsed.models[modelID] = parsedModel
  }
  database[providerID] = parsed
}
```

要点：
- **provider 不存在于 models.dev 时（`existing` 为 undefined）也能建**——所有字段都有 fallback。
- **`npm` 的最终兜底是 `@ai-sdk/openai-compatible`**（`provider.ts:1056-1060`）：所以哪怕只填 `api`(baseURL) + `models`，不写 `npm`，也能当 OpenAI 兼容服务跑。
- **必须在 config 里显式列出 `models`**——自定义 provider 不在 models.dev，没有模型清单的话 UI / `getModel` 拿不到任何可选模型。

---

## 4. SDK 动态加载 + baseURL / apiKey / headers 注入

### 4.1 BUNDLED vs 动态安装

`vendor/opencode/packages/opencode/src/provider/provider.ts:127-150` 的 `BUNDLED_PROVIDERS`：编译期直接 import 的 SDK 工厂，**无需联网安装**。含本次最相关的两个：

- `"@ai-sdk/openai-compatible": createOpenAICompatible`（`provider.ts:34,135`）
- `"@ai-sdk/anthropic": createAnthropic`（`provider.ts:128`）
- 还有 `@ai-sdk/openai` / `google` / `xai` / `mistral` / `groq` / `openrouter` 等。

若 `npm` 不在 BUNDLED 列表里 → `resolveSDK` 走动态安装（`provider.ts:1410` `Npm.add(model.api.npm)` → 装到 `~/.opencode/cache/packages/` → `import` → 找 `create*` 导出，`provider.ts:1420`）。
> **对本需求的意义**：用 `@ai-sdk/openai-compatible` 或 `@ai-sdk/anthropic` 就走 BUNDLED 快路径，零网络、零安装、离线可用。**应优先引导用户选这两个协议**，避免动态安装的不确定性。

### 4.2 resolveSDK 的注入逻辑

`vendor/opencode/packages/opencode/src/provider/provider.ts:1295-1430`：

```ts
async function resolveSDK(model, s) {
  const provider = s.providers[model.providerID]
  const options = { ...provider.options }

  // 1) baseURL：options.baseURL 优先，否则 model.api.url；支持 ${ENV} 替换
  const baseURL = iife(() => {
    let url = typeof options["baseURL"] === "string" && options["baseURL"] !== ""
      ? options["baseURL"] : model.api.url
    url = url?.replace(/\$\{([^}]+)\}/g, (m, key) => Env.get(String(key)) ?? m)
    return url
  })
  if (baseURL !== undefined) options["baseURL"] = baseURL

  // 2) apiKey：options 没写就用 provider.key（来自 auth.json / env）
  if (options["apiKey"] === undefined && provider.key) options["apiKey"] = provider.key

  // 3) headers：合并 model.headers
  if (model.headers) options["headers"] = { ...options["headers"], ...model.headers }

  // 4) BUNDLED 命中直接调工厂；否则 Npm.add + dynamic import
  const bundledFn = BUNDLED_PROVIDERS[model.api.npm]
  if (bundledFn) return bundledFn({ name: model.providerID, ...options })
  // ... 动态安装分支 ...
}
```

实例化模型 `getLanguage()`（`provider.ts:1454+`）：拿到 SDK 后调 `sdk.languageModel(model.api.id)`（部分 provider 走 `CUSTOM_LOADERS` 特殊逻辑，如 OpenAI 用 `sdk.responses()`、Azure 用 resource name）。

> 三条注入链对应到「用户填的字段」：**Base URL → `options.baseURL`**；**API Key → `auth.json`（`provider.key`）或 `options.apiKey`**；**自定义 header → `model.headers` 或 `options.headers`**。

---

## 5. OpenAI / Anthropic 兼容能力小结

| 协议 | SDK 包 | 是否 BUNDLED | 接入方式 |
|------|--------|:---:|---------|
| OpenAI 兼容（最通用） | `@ai-sdk/openai-compatible` | ✅ `provider.ts:135` | `npm` 省略或显式；填 `baseURL`+`apiKey`+`models` 即可。**未知 provider 默认即此** |
| OpenAI 官方 | `@ai-sdk/openai` | ✅ `provider.ts:134` | 走 `CUSTOM_LOADERS.openai` 用 `responses()` API |
| Anthropic | `@ai-sdk/anthropic` | ✅ `provider.ts:128` | `npm:"@ai-sdk/anthropic"` + `baseURL` |
| 其它（OpenRouter/xAI/Mistral/Groq…） | 各自 SDK | ✅ 多数 BUNDLED | 改 `npm` 即可 |

**结论**：用户「兼容主流 OpenAI 和 Anthropic 协议、自带 apikey + base url + 自定义参数」的诉求，后端 100% 可满足，且主路径全部 BUNDLED（无动态安装风险）。

---

## 6. Ultrawork 前端现状（短板所在）

### 6.1 model-dialog.tsx 的能力边界

`packages/client/desktop/src/components/settings/model-dialog.tsx`：

- **两视图**：List View（已连接 provider/模型列表，`:181-326`）+ Configure View（两步配置，`:328-466`）。
- **Configure View 第一步**：从 `GET /provider` 返回的列表里**选**一个 provider（`:344-391`），按 name/id 搜索（`:115-125`）。**没有「手填新 provider id / 新建」的入口**。
- **Configure View 第二步**：只有两个输入框——
  - API Key（`:412-428`，password，必填）
  - Base URL（`:430-441`，text，标记 optional）
- **保存逻辑**（`:127-160`，`handleSaveConfig`）：
  ```ts
  if (configApiKey.trim()) await api.putProviderAuth(selectedProvider.id, configApiKey.trim())  // → auth.json
  if (configBaseUrl.trim()) await api.patchConfig({
    provider: { [selectedProvider.id]: { options: { baseURL: configBaseUrl.trim() } } },        // → opencode.json
  })
  clearModelCache(); fetchData()
  ```

> 即：**只能给「已知 provider」配 Key + 覆盖 baseURL**。无法新建列表外 provider，无法填 `models` / `npm` / 自定义 header / timeout。

### 6.2 模型选择 / 切换链路

- `model-context.tsx`：`getConfig()` 读 `config.model` 初始化当前模型；`setModel(m)` → `patchConfig({ model: "provider/modelId" })`（`model-context.tsx:34-42`）。
- 发消息时 `promptAsync(sessionId, text, { model: currentModel })`，api-client 把 `"providerID/modelID"` 拆成 `{ providerID, modelID }` 作为运行时 override（`client.ts:295-321`）。
- `model-selector.tsx` 有 5 分钟模块级缓存，添加 provider 后 `clearModelCache()` 失效（`model-selector.tsx:22-46`）。

> **重要**：自定义 provider 的模型一旦进了 `GET /provider`（因为写进了 config 并被 merge），**现有的模型选择 / 切换 / prompt override 链路无需改动**就能直接选用。新增成本集中在「录入 UI」。

---

## 7. api-client 现状与缺口

`packages/core/api-client/`：

| 方法 / 类型 | 现状 | 缺口 |
|------|------|------|
| `getProviders()` `client.ts:250-266` | 把 `GET /provider` 的 `RawProvider.models`(record) 转成 `models[]` 数组，按 `connected` 标记 | 够用 |
| `getProviderAuth()` `client.ts:268-278` | 把 auth methods map 转 `ProviderAuthInfo[]`（`set` 表示已配 key） | 够用 |
| `putProviderAuth(id, key)` `client.ts:280-285` | 仅 `PUT /auth/{id}` body `{type:"api", key}` | 只支持 api key（OAuth/wellknown 未封装，本需求用不到） |
| `getConfig()/patchConfig()` `client.ts:237-246` | 直读写 `/config`（HTTP，非 Tauri command）| 够用 |
| `OpenCodeConfig` 类型 `types.ts:277-281` | `{ model?, provider?: Record<string,{options?}>, [k]:unknown }` | **`provider` 子类型太窄**：只声明了 `options`，缺 `npm`/`api`/`models`/`env`。写入时 `[k]:unknown` 兜底能塞进去，但**无类型提示** |
| `Provider`/`ProviderModel` 类型 `types.ts:214-257` | 基础字段 | 相比 upstream 缺 `status`/完整 `capabilities`/`headers`，但展示足够 |

> `patchConfig` 走的是 `PATCH /config`，**仅写盘不影响运行时**（见 MEMORY「Config PATCH 不影响运行时」）。但 provider 定义本来就是「下次构建 provider state / 重启或重新 list 时」生效的盘上配置，因此对本需求 `PATCH /config` 是正确入口；运行时模型切换才需要 `prompt_async` 的 model override（已有）。

> ✅ **已实测（2026-06-04，见 §10）**：`PATCH /config` 写入自定义 `provider.<id>` 后，**当前 sidecar 进程的 `GET /provider` 立刻反映该 provider**（139→140，无需重启）。原先担心的 `InstanceState` 缓存不构成阻碍。注意 `GET /config` 返回的是运行时内存态，所以前端只能走 `PATCH /config`、不能直接改盘（见 §9.7）。

---

## 8. 实现路径建议

### 方案 A（推荐）：纯前端 + api-client 扩展，不动 vendor

后端能力齐备，**无需碰 `vendor/opencode` 与 patch**。改动集中在两处：

#### 8.1 api-client

1. **扩展 `OpenCodeConfig.provider` 类型**（`types.ts`），让 `provider.<id>` 支持 `name` / `npm` / `api` / `env` / `models` / `options`，对齐 upstream `ProviderConfig`（仅类型，运行时 `patchConfig` 已能透传）。
2. （可选）新增语义化封装 `upsertCustomProvider(def)`，内部组装 config 片段调 `patchConfig`，再调 `putProviderAuth(id, key)`。
3. （可选）`deleteProvider(id)`：`patchConfig` 把 `provider.<id>` 置空 + 清 auth（需确认 `/auth/{id}` 是否有 DELETE，当前未封装）。

#### 8.2 前端 model-dialog

在 Configure View 增加「+ 添加自定义 Provider」入口，弹出表单收集：

| 字段 | 写入目标 |
|------|---------|
| Provider ID（唯一，如 `my-gw`） | `provider.<id>` 的 key |
| 显示名 name | `provider.<id>.name` |
| 协议（下拉：OpenAI 兼容 / Anthropic） | → `npm`: `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` |
| Base URL | `provider.<id>.api` + `options.baseURL` |
| API Key | `PUT /auth/<id>`（不进 config，避免明文落盘 opencode.json） |
| 模型列表（≥1，至少 id + name + 可选 context/output limit + tool_call） | `provider.<id>.models` |
| （高级，可选）自定义 header / timeout | `options.headers` / `options.timeout` |

保存流程复用现有 `handleSaveConfig` 模式：先 `putProviderAuth(id, key)`，再 `patchConfig({ provider: { [id]: {...} } })`，最后 `clearModelCache()` + `fetchData()`。

i18n：复用并扩展 `model.addProvider.*` / `model.configureProvider.*` 现有键（中英已有基础，`i18n-context.tsx`）。

#### 8.3 关键校验（前端做，避免脏配置）

- Provider ID 不与现有冲突（尤其别覆盖内置 anthropic/openai 除非用户有意）。
- 至少一个 model；model.id 必填。
- Base URL 形态校验（http/https）。
- API Key 不写进 opencode.json（走 auth.json），防止明文配置文件泄漏。

### 方案 B：仅文档化「手改 opencode.json」

不做 UI，直接在文档里教用户编辑 `~/.config/ultrawork/opencode.json`（`OPENCODE_APP_NAME=ultrawork` 隔离目录，ADR-020）。零开发量，但违背产品「易用」定位，仅作为过渡 / 高级用户旁路。

### 取舍

- **强烈建议方案 A**，且**不要动 vendor**——避免增加 patch 维护负担（每次 submodule 升级要重对 patch，见 CLAUDE.md「Vendor Patch 管理」）。
- 协议下拉**只暴露 OpenAI 兼容 / Anthropic 两项**（都 BUNDLED），把「任意 npm 包」留给 opencode.json 手改的高级旁路，避免前端引入动态安装的失败面。

---

## 9. 风险与坑点

1. ~~**运行时生效时机**~~ ✅ **已实测解除**（见 §10）：`PATCH /config` 后 provider 在**同一 sidecar 进程**立即出现在 `GET /provider`，无需重启。前端 `patchConfig` 后只需 `clearModelCache()` + 重新 `getProviders()`。
2. **API Key 落盘位置**：务必走 `auth.json`（`PUT /auth/<id>`）而非 `opencode.json` 的 `options.apiKey`——后者会把密钥明文写进配置文件。`resolveSDK` 中 `provider.key`（auth）能在 `options.apiKey` 缺省时自动注入（`provider.ts` apiKey 注入分支），所以**不在 config 写 apiKey 也能用**。
3. **模型元数据缺失的副作用**：自定义 model 不写 `cost`/`limit`/`capabilities` 时走默认值（`tool_call` 默认 true、其余 false/0）。`limit.context` 不准会影响历史窗口/分页估算（ADR-021）；建议表单至少收集 context/output。
4. **OpenAI 官方 vs 兼容的差异**：`@ai-sdk/openai` 走 `CUSTOM_LOADERS.openai` 的 `responses()` API（`provider.ts` CUSTOM_LOADERS），第三方兼容服务未必支持 responses 协议——**自定义服务一律用 `@ai-sdk/openai-compatible`（走 chat completions）**，不要选 `@ai-sdk/openai`。
5. **配置隔离**：写入路径是 `~/.config/ultrawork/opencode.json`（非 `~/.opencode/`，ADR-020 patch 保证），前端经 `PATCH /config` 不用关心物理路径。
6. ~~**MCP/agent 配置共存**~~ ✅ **已实测解除**（见 §10）：`PATCH /config` 写 `provider` 时**深合并**，不会冲掉同级的 `mcp`。⚠️ 但 **PATCH 的响应体只回传本次更新的片段**（不含 mcp），前端不能把 PATCH 返回值当完整 config，须重新 `getConfig()`。
7. **必须走 `PATCH /config`，不要直接写盘** ✅ **已实测**（见 §10）：`GET /config` 返回的是**运行时内存态**——直接覆盖盘上 `opencode.json` 后，`GET /config` 仍返回旧值（运行时未重读盘）。PATCH 会同时更新内存+盘，绕过 PATCH 改盘需重启 sidecar 才生效。
8. **vendor 升级**：因方案 A 不改 vendor，submodule 升级不受影响；但 config schema 若 upstream 调整（如 `options` 字段增减），前端表单需跟进。

---

## 10. 实测结果与遗留待测

> 实测于 2026-06-04：手动启动 `opencode-server serve --port 4096`（注入 `OPENCODE_SERVER_PASSWORD` + `OPENCODE_APP_NAME=ultrawork`，与 Tauri 启动一致），用 curl 走真实 HTTP API 验证，**未改任何代码**。鉴权为 Basic auth（user `opencode` + 凭证文件密码）；`/global/health` 在鉴权中间件之前、其余端点需鉴权（`server.ts:43-50`）。

### 已验证 ✅

1. **PATCH /config → GET /provider 立即生效（同进程，无需重启）**。基线 139 个 provider、无 `uw-test-openai`；`PATCH {provider:{"uw-test-openai":{npm:"@ai-sdk/openai-compatible", api, options.baseURL, models:{...}}}}`（HTTP 200）后**立刻** `GET /provider` 返回 140 个，`uw-test-openai` 出现在 `all` **且** `connected` 中，`name`/`models`/`options.baseURL` 正确回显。
   - 附带发现：**未填 apiKey 也被列入 `connected`**——openai-compatible + 显式 models + baseURL 即视为可用。真实场景用户仍应通过 `PUT /auth/<id>` 配 key。
2. **PATCH /config 深合并，保留 mcp**。写 `provider` 后 `GET /config` 仍含原有 `mcp.browser` / `mcp.knowledge-base`。⚠️ 但 **PATCH 响应体只回本次片段**（仅 `{provider:{...}}`，不含 mcp）——见 §9.6。
3. **GET /config 读运行时内存态**：把盘文件恢复为不含 `provider` 后，`GET /config` 仍返回 `provider`（运行时未重读盘）——见 §9.7。结论：前端只能走 `PATCH /config`。

### 部分验证 / 待测 ⚠️

4. **删除路径（原 §10.5）**：`PATCH {provider:{"<id>":null}}` 被 schema 拒绝（**HTTP 400**，Provider schema 不接受 null），且该 provider 仍在。→ 删除不能简单置 null。待确认正确方案：`/auth/{id}` 是否支持 DELETE？是否有移除 config 项的端点？或前端「改盘 + 重启 sidecar」兜底（结合 §9.7，改盘后需重启才生效）。
5. **端到端发消息（未测）**：本次只验证 provider/config 的注册与即时可见性，**未**用真实可用的 baseURL+key 发 `prompt_async`（用的是 `api.example.com` 占位）。落地前仍需用一个真实 OpenAI 兼容端点验证注入链 §4 端到端连通。
6. **`@ai-sdk/anthropic` + 自定义 baseURL（未测）**：是否被 SDK 正确采纳（部分 AI SDK 对 baseURL 的字段名/校验不同），仍需实测。

---

## 11. 实现规划（2026-06-19 拍板）

> 用户重启此议题（截图反映「配置供应商只能选 opencode 内置清单，需支持自带模型服务」）。本节锁定范围、补齐初版未实测的删除/合并语义，给出可执行规划。**仍不写代码**——待 review 后开工。

### 11.0 与初版的差异校正

- **前端落地文件已变**：初版引用的 `model-dialog.tsx` 于 2026-06-17 重构进 **`packages/client/desktop/src/components/settings/models-section.tsx`**（设置页 section 化，全局 Modal 已拆）。后端分析（§1–§5）不受影响，仅落地文件名 + 插入点变了。现状仍是两步：① 从 `GET /provider` 已知清单**选**一个 → ② 填 API Key + 可选 Base URL；**无新建列表外 provider 的入口**。

### 11.1 三项拍板决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 协议范围 | 前端下拉**仅** OpenAI 兼容 / Anthropic 两项 | 都 BUNDLED（§4.1），零动态安装失败面；任意 npm SDK 留给手改 opencode.json 旁路 |
| 模型录入 | **用户手填**模型清单（≥1，id+名称+可选 context/output limit） | 自定义 provider 不在 models.dev，opencode 要求 config 显式列 `models`（§3.3）；自动拉 `/v1/models` 很多自建端点不实现，仍要手填兜底 |
| 实现策略 | 方案 A：**纯前端 + api-client 扩展，不动 vendor** | §8 已论证，避免 patch 维护负担 |

### 11.2 本轮新核实的后端事实（补 §7/§9 待测项）

1. **`DELETE /auth/:providerID` 存在**（`vendor/.../server/server.ts:133`，调 `Auth.remove`）→ 删 Key 有官方端点，初版 §7「OAuth/删除未封装」的 api key 删除缺口可补。
2. **`PATCH /config` 是 `mergeDeep` 深合并**（`vendor/.../config/config.ts:1531` `mergeDeep(writable(existing), input)` 后写盘）→ **只能增/改 key，无法删 key**。这坐实了初版 §10.4「`provider:{id:null}` 被拒 400」的根因：不是 schema 偶然，而是 update 语义本就不支持删除字段。
3. ~~`disabled_providers` 数组对 config 来源的自定义 provider 不生效~~ **← 此初判被 §11.9 spike 推翻**：实测 `disabled_providers:[id]` **能可靠隐藏**自定义 provider（GET /provider `present=False`）。源码层面 `Provider.list()`（provider state 构建）的 env/apikey/config 各 loop 起手都 `if (disabled.has(providerID)) continue`（`provider.ts:1125/1138/1151/1167`），故被 disabled 的 provider 根本不进 state，自然不在 `connected` 里。这成为 §11.5 删除方案的基石。

### 11.3 改动清单

**api-client（`packages/core/api-client/src/`）**
- `types.ts`：扩 `OpenCodeConfig.provider` 子类型 `{ options? }` → 对齐 upstream `ProviderConfig`（增 `name?/npm?/api?/env?/models?`，纯类型）。
- `client.ts`：新增 `upsertCustomProvider(def)`（组装 config 片段调 `patchConfig` + `putProviderAuth`）；新增 `deleteProviderAuth(id)`（封装 `DELETE /auth/:id`）；新增 `setProviderDisabled(id, bool)`（读当前 `disabled_providers` → 追加/移除 id → `patchConfig` 写回完整数组，§11.9 删除方案）。**全部经现有 `request()`/`buildHeaders()` 走，自带 `x-opencode-directory`——前提是实例 `workingDirectory` 非空（见下）。**

**desktop（`models-section.tsx`）**
- 配置供应商第一步加「+ 添加自定义 Provider」入口 → 新表单子视图（复用 `saving`/`mountedRef`/toast 模式）。
- 列表区给 `source==="config"` 的 provider 加「自定义」徽标 + 删除入口（删除 = `setProviderDisabled(id,true)` + `deleteProviderAuth(id)`）。
- **无活动工作区守卫**（§11.9）：`workingDirectory` 为空时禁用「添加自定义 Provider」入口并提示「请先打开一个工作区」，避免命中漂移默认实例。

**i18n（`i18n-context.tsx`）**：扩 `model.customProvider.*`（中英）。

**测试**：表单校验单测（ID 冲突/必填/baseURL 形态/≥1 模型）+ 保存流程调用顺序断言（putAuth→patchConfig→clearModelCache→刷新）+ 删除流程。

### 11.4 表单字段 → 写入目标

| 字段 | 写入 | 校验 |
|------|------|------|
| Provider ID | `provider.<id>` key | 必填、kebab、**不与现有 id 冲突**（防覆盖 openai/anthropic）|
| 显示名 | `provider.<id>.name` | 必填 |
| 协议下拉 | `npm`: `@ai-sdk/openai-compatible` / `@ai-sdk/anthropic` | 二选一 |
| Base URL | `provider.<id>.api` + `options.baseURL` | 必填、http(s) |
| API Key | **`PUT /auth/<id>`**（不进 config 明文）| 可选 |
| 模型清单（动态增删行）| `provider.<id>.models[id]={id,name,limit?}` | ≥1、每行 id+name 必填；建议引导填 `limit.context`（影响历史窗口估算 ADR-021）|

### 11.5 删除路径（§11.9 spike 已定方案）

PATCH 深合并删不掉 config key（`provider:{id:null}` 被 schema 拒 400）。但 spike 实测找到**干净的服务端方案**：

- **删除 = PATCH `disabled_providers` 追加该 id（隐藏）+ `DELETE /auth/<id>`（清 Key）**。`disabled_providers:[id]` 让 provider 不进 state、从 `GET /provider` 消失（§11.9 H3 实测 `present=False`）。opencode.json 里 provider 条目仍残留但已隐藏、无害。**纯服务端、无需 disk-edit、无需重启**。
  - ⚠️ `disabled_providers` 是数组，PATCH `mergeDeep` 对数组是**整体替换**，故前端需「读当前 disabled_providers → 追加/移除 id → 写回完整数组」。
  - 「恢复/取消删除」= 从 `disabled_providers` 移除该 id（写回不含它的数组）。
  - 注意：`DELETE /auth` 单独**不足以**让 provider 消失——openai-compatible + 显式 models + baseURL 即被视为 connected，删 key 后仍 `present=True`（§11.9 H1 实测）。必须配合 `disabled_providers`。
- **彻底物理删除**（移除 config 条目本身）：仍需 scope-free Tauri 命令编辑工作区 `opencode.json` + sidecar reload，列为后续增强，v1 不做。

→ **v1 采用 `disabled_providers` + DELETE auth**（取代初稿「前端隐藏列表」方案——opencode 原生 `disabled_providers` 更干净、跨重启持久）。

### 11.6 落地前必验（补 §10.5/§10.6 遗留）

- **端到端连通**：用真实 OpenAI 兼容端点（本地 vLLM/Ollama 或自建）发一次 `prompt_async`，验 baseURL+Key 注入链端到端通。
- **`@ai-sdk/anthropic` + 自定义 baseURL**：单独验一次（部分 AI SDK 对 baseURL 字段名/校验不同）。
- Key 务必走 auth.json，**不写 config 的 `options.apiKey`**（防明文落盘）。

### 11.7 验收门禁 + 收尾

- typecheck 8/8 · desktop vitest 全绿（+表单/删除用例）· check-docs 净。
- 真机 Tauri：新建 OpenAI 兼容 provider → 模型进选择器 → 发消息成功；删除后从列表消失。
- 收尾：本文状态「调研」→「已实现」；CHANGELOG Added；按需新增 ADR（若删除走方案 2 的 Tauri 命令/重启）。

### 11.8 分步

1. Spike（~15min）：真实端点验注入链 + 删除方案 1 体验确认。
2. api-client 类型扩 + 两方法 + 单测。
3. 表单视图 + 校验 + i18n。
4. 列表徽标 + 删除入口。
5. 真机走查 + 收尾文档。

### 11.9 Spike 实测结果（2026-06-19，§11.8 第 1 步已完成）

> 方法：XDG_* 全隔离启真实 sidecar 二进制（`opencode-server-aarch64-apple-darwin`，端口 14096，无 password 免鉴权，`OPENCODE_DISABLE_MODELS_FETCH=1` 走内置 snapshot）+ 自建 mock OpenAI/Anthropic 兼容端点（记录收到的 Authorization / x-api-key / model）。零碰真实数据。harness 在 `/tmp/uw-provider-spike/`（mock-llm.ts + 多个 diag-*.sh）。

#### ✅ 注入链端到端坐实（两协议均通）

| 协议 | mock 收到 | 证明 |
|------|----------|------|
| OpenAI 兼容 | `POST /v1/chat/completions`，`Authorization: Bearer sk-spike-OPENAI-123`，`model: mock-model-1`，assistant 正确返回文本，`error=null`，0 ProviderModelNotFound | baseURL + auth.json key + model 全部正确注入；走 chat completions |
| Anthropic | `POST /v1/messages`，`x-api-key: sk-spike-ANTHROPIC-456`，`anthropic-version: 2023-06-01`，`model: mock-claude` | `@ai-sdk/anthropic` + 自定义 baseURL 生效，鉴权头形态正确（x-api-key 非 Bearer） |

→ §11.6「端到端连通」「Anthropic baseURL」两项待验**已消除**。两协议都 BUNDLED、注入链可靠。

#### 🔑 关键前提：所有请求必须带一致的 `x-opencode-directory`

**这是初稿/§10 漏掉的致命细节，足以颠覆「直接可用」结论**：

- spike 初期所有 curl **未带目录头** → 命中 opencode 漂移的「默认实例」：自定义 provider 时而不进 `GET /provider` 列表、`getModel` 抛 `ProviderModelNotFoundError`、`PATCH /config` 偶尔根本不落盘、baseline provider 数在 135/136 间跳。**doc 006 §10「立即生效」是只验了一次 listing、没验 prompt 的侥幸结论**。
- 一旦**所有请求（PATCH /config、PUT /auth、GET /provider、创建会话、prompt）统一带 `x-opencode-directory: <同一 git 工作区>`** → 全部稳定：provider 立即且持续 `present=True models=['mock-model-1']`，prompt 端到端打通，0 错误。
- **真实 app 已天然满足**：`api-client` 的 `buildHeaders()` 在 `workingDirectory` 非空时自动注入该头（`client.ts:69`），实例的 `workingDirectory = workspacePath`（`sse-context.tsx:60`），`models-section` 经 `useApi()` 拿的正是这个实例。**故真实 app 走的就是稳定路径。**
- ⚠️ **唯一隐患**：若 `workspacePath` 为空（无活动工作区时进设置页），目录头缺失 → 踩漂移实例。现有 baseURL 覆盖功能已潜在受此影响。落地时前端应在无工作区上下文时禁用「添加自定义 Provider」或给出明确提示。

#### 🔑 持久化是 per-workspace，不是 global

- `PATCH /config`（route `Config.update`）写入 **`<工作区>/opencode.json`**（实例目录），**非** global `~/.config/ultrawork/opencode.json`。spike 实测 config 落在 `wsX/opencode.json`。
- 即：**自定义 provider 作用域 = 添加时所在的工作区**；切到别的工作区不可见。与现有 baseURL 覆盖 + 模型选择（`config.model`）行为一致——它们也都 per-workspace。
- 想做 global 需 Tauri 直接编辑 global `opencode.json` + sidecar reload（`updateGlobal` 未挂 HTTP route），成本高。
- **附带坑**：非 git 工作区目录的 `opencode.json` 加载不可靠（spike 中 `git init` 后才稳定，呼应 gotchas §9「无 git 目录 opencode.json 不被当 project config」）。真实工作区通常是 git 仓库，但值得注意。
- **→ §11 待拍板新增一项**：自定义 provider 作用域 = per-workspace（推荐，与现状一致、零额外成本）vs global（需 Tauri global-config 命令，列后续）。建议 **v1 per-workspace**，UI 文案点明「当前工作区」。

#### ✅ 删除语义（带目录头重测，可信）

| 操作 | 结果 |
|------|------|
| `DELETE /auth/<id>` | HTTP 200，key 清除，但 provider **仍 present=True connected=True**（openai-compatible+models+baseURL 无需 key 即 connected）→ 单独不足以删除 |
| `PATCH {provider:{<id>:null}}` | HTTP 400（schema 拒 null，mergeDeep 删不掉 key） |
| `PATCH {disabled_providers:["<id>"]}` | HTTP 200 → provider **present=False connected=False**（可靠隐藏）✅ |

→ 删除方案定为 **disabled_providers + DELETE auth**（详见已更新的 §11.5），推翻 §11.2 初判 #3。

#### 对 §11 规划的净影响

1. 注入链无需再验，两协议可靠（§11.6 缩减为「真实 app 内冒烟一次」即可）。
2. **新增硬前提**：前端调用链必须保证 `workingDirectory` 非空（即有活动工作区）；无工作区时禁用入口。
3. **新增拍板项**：作用域 per-workspace（推荐）vs global。
4. 删除方案明确化（disabled_providers），§11.3 改动清单的 `deleteProviderAuth` 需配套一个 `setProviderDisabled(id, bool)`（读改写 disabled_providers 数组）。

### 11.10 真机保存/删除卡死——根因坐实（React StrictMode `mountedRef`）+ 修复（2026-06-19）

> 症状：真机 `tauri dev` 下，添加自定义 provider 保存后/删除点「勾」后，**按钮一直转圈**。曾两次误判误修，最终靠真机日志 + Chrome 前后对照坐实。

**根因（坐实）= 前端 React StrictMode 的 `mountedRef` 生命周期 bug，与网络/连接/vendor patch 无关。**

- **决定性证据**：用户开 `uw.debug.api` 后的真机 console 显示**每条请求都有 `←` 返回、全部成功**（`PATCH /config ←11~29ms`、后续 `GET ←` 全回、无 `✗ TIMEOUT`）→ **不是网络/响应/连接挂起**。
- **真因**：守卫 `const mountedRef = useRef(true); useEffect(() => () => { mountedRef.current = false }, [])` **只在 cleanup 置 false、setup 不复位**。`main.tsx` 包 `<React.StrictMode>`，dev 下 effect 跑 **setup→cleanup→setup**：cleanup 置 false、第二次 setup 不复位 → 挂载后 `mountedRef.current` **恒为 false** → `await` 完成后 `if(!mountedRef.current) return` 提前返回、`setSaving(false)`/`setDeletingId(null)` 被跳过 → **转圈永不停**（请求其实早成功）。「通用」因同时影响保存/删除/旧 baseURL 覆盖（共用该 ref）。**仅 dev（StrictMode）触发**，production 不双调用 effect 故无症；也是**所有自动化此前没抓到的原因**（testing-library/GUI probe 默认不包 StrictMode）。

**解法（一处 effect）**：
```ts
useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false } }, [])
```

**验证（这次有 before/after 实证，不再是推断）**：
- **jsdom 回归测试**：`render(<StrictMode><ModelsSection/></StrictMode>)` 保存断言 `toast.success` 被调用——修复前 fail / 后 pass（入库防回归）。
- **Chrome + Vite + Playwright（StrictMode 下，截图存证）**：同一 probe，**破损版**（cleanup-only）保存后 `onForm=1, shown=0`（停在表单、Save 键转圈 = 复现）；**修复版**保存→「Custom provider saved」+ 列表出现 provider、删除→消失（save/delete 均恢复、零 console 错误）。截图 `/tmp/uw-provider-spike/shots/{broken,fixed}-*.png`。
- 全仓 sweep：此破损 ref 模式仅此一处（pdf-view/pipeline-tab 用 `let cancelled=false` 局部变量式守卫，StrictMode 安全）。

**两次误判（诚实留痕）**：① 「v1.15.13 事件循环争用」——vendor 实为 **v1.3.13**，不适用；② 「PATCH→invalidate→WKWebView 复用死连接致响应挂」——被真机日志（请求全部 `←` 返回）直接推翻。`PATCH /config` 触发 opencode 实例 dispose / SSE 1s 重连是**上游 v1.3.13 原生且无害**行为，非 vendor patch 导致、与卡死无关。

**对无效修复的清理（回应「是否有负作用、是否清理」）**：基于上述错误假设加的改动**已全部回退**，只保留真正的 `mountedRef` 修复 + §11.1–11.9 的合法修复：
- 回退 api-client 请求层 30s 超时 / `requestTimeoutMs` / `uw.debug.api` 追踪（app 级 scope creep、且非本因）；
- 回退 `upsertCustomProvider` 的「单条原子 PATCH 重排」→ 复原为 `PUT auth → PATCH provider → setProviderDisabled(false)`（re-add un-disable 保留）；
- 回退保存/删除成功后的「乐观本地更新」→ 复原为 `fetchData` 重拉（服务端为准，避免乐观值缺 cost/limit 的短暂不一致）。
- 净效果：分支 diff 收敛到「自定义 provider 功能 + 一行 mountedRef 修复 + 回归测试」，无投机残留。

**收口独立 review（2026-06-19）发现并修复**：
- **幽灵模型（Medium，已修）**：delete 仅靠 `disabled_providers` 隐藏、不物理删除 config 的 `provider.<id>`（PATCH 删不掉 key），故「删除→用同 id 重加且模型更少」时旧模型会因深合并残留。修复 = `upsertCustomProvider` 每次写入 `whitelist: 当前模型 id 列表`（数组合并即替换；vendor `provider.ts:1259` 据 whitelist 删除未列出的模型）→ 幽灵被过滤。**headless e2e 实证**：加 mA+mB → 删 → 重加仅 mA → 列表只剩 mA。
- **a11y nit（已修）**：`HoverLabelButton` 的标签 `<span>` 加 `aria-hidden`（避免与 `aria-label` 在无障碍树重复）。
- **已知低风险（未改，数据相关）**：`isCustomProvider` 用 `source==="config" && !env?.length` 区分；若某内置 provider 在 models.dev 无 `env` 又被设了 baseURL 覆盖，会被误判为可删自定义（主流 provider 均有 env，且重名被 idTaken 拦截，触发面极窄）。

---

## 附：相关源码索引

**vendor/opencode**
- `packages/opencode/src/provider/provider.ts` — provider 加载 / merge / `resolveSDK` / `getLanguage` / BUNDLED_PROVIDERS / CUSTOM_LOADERS
- `packages/opencode/src/provider/models.ts` — models.dev 加载缓存 + Provider/Model schema
- `packages/opencode/src/provider/schema.ts` — ProviderID / ModelID 品牌类型 + well-known id
- `packages/opencode/src/config/config.ts:801-860,943` — `provider` 配置 schema（ProviderConfig）
- `packages/opencode/src/auth/index.ts` — auth.json（ApiAuth/OAuth/WellKnown）
- `packages/opencode/src/server/routes/provider.ts` — `GET /provider`、`GET /provider/auth`、OAuth 端点

## §12 增强：每模型参数配置 + 测试连接（2026-06-23 实现，分支 `feat/custom-provider-model-params`）

在 §11 落地的自定义 provider 基础上扩展「每模型可配更多字段」+「测试连接」，**仍零改 vendor**。

- **关键前提（逐行核验 + headless 实证）**：opencode config `provider.<id>.models.<modelId>` 用 `ModelsDev.Model.partial()`（`config.ts:808`），原生接受完整 models.dev Model schema——能力 bool（tool_call/reasoning/attachment/temperature）、`modalities`、`cost`、`limit`、`headers`、`options`、`variants` 等全字段；non-strict（未知 key 静默 strip）。model 级 `options` 经 `session/llm.ts:139 mergeDeep` 注入 AI SDK `providerOptions`，`headers`/`modalities`/能力位由 `provider.ts:912-957 fromModelsDevModel` 消费。**所以无需 vendor patch 即可暴露全字段**（固化于 gotchas §1）。
- **UI**：每个模型行 = id/name + context/output + 能力勾选（工具调用/推理/视觉/附件）+ 可折叠「高级（JSON）」。高级 JSON 经 api-client `deepMergePlain` 最后深合并覆盖；`vision`→`modalities:{input:["text","image"],output:["text"]}`；**强制 `id` 回 map key**（advanced 不可改 id，防与 whitelist/解析失配）；limit 成对校验跨「数字框 + advanced.limit」有效值（拦 partial 防 400 / 放行拆分填写）。
- **测试连接**：Tauri `test_provider_connection`（`lib.rs`，`curl` shell-out，按协议拼 `/models`，`-L` 跟随，分类 200/401/404/网络 → 本地化文案）。理由与坑见 gotchas §6（curl 而非 reqwest/webview fetch）。
- **类型**：api-client `ProviderConfigModel` 扩 `modalities`/`headers`/`options`；新增 `CustomProviderModelDef`（能力位 + `advanced`）。
- **验证**：typecheck 8/8 · api-client 61 · desktop 232 · cargo 16 · headless API 走查 19/19 · Chrome+Vite+Playwright GUI 走查 15/15（shim 注入 `window.__TAURI_INTERNALS__.invoke`，见 gotchas §6）· 真机 Tauri 已验。

---

**Ultrawork main**
- `packages/client/desktop/src/components/settings/models-section.tsx` — provider 配置 UI（model-dialog.tsx 已于 §11 重构为此 section；§12 加每模型参数 + 测试连接）
- `packages/client/desktop/src/lib/model-context.tsx` — 当前模型 / 切换
- `packages/client/desktop/src/components/chat/model-selector.tsx` — 模型选择 + 缓存
- `packages/core/api-client/src/client.ts:237-321` — getConfig/patchConfig/getProviders/getProviderAuth/putProviderAuth/promptAsync
- `packages/core/api-client/src/types.ts:214-306` — Provider/Model/Auth/Config/ModelOverride 类型
