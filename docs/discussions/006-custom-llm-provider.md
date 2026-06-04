# Discussion 006: 自定义 LLM Provider 机制调研 — 兼容 OpenAI / Anthropic 协议的「自带 Key + Base URL」接入

- **日期**: 2026-06-04
- **状态**: 调研记录（仅分析，无代码改动）
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

## 附：相关源码索引

**vendor/opencode**
- `packages/opencode/src/provider/provider.ts` — provider 加载 / merge / `resolveSDK` / `getLanguage` / BUNDLED_PROVIDERS / CUSTOM_LOADERS
- `packages/opencode/src/provider/models.ts` — models.dev 加载缓存 + Provider/Model schema
- `packages/opencode/src/provider/schema.ts` — ProviderID / ModelID 品牌类型 + well-known id
- `packages/opencode/src/config/config.ts:801-860,943` — `provider` 配置 schema（ProviderConfig）
- `packages/opencode/src/auth/index.ts` — auth.json（ApiAuth/OAuth/WellKnown）
- `packages/opencode/src/server/routes/provider.ts` — `GET /provider`、`GET /provider/auth`、OAuth 端点

**Ultrawork main**
- `packages/client/desktop/src/components/settings/model-dialog.tsx` — provider 配置 UI（现状）
- `packages/client/desktop/src/lib/model-context.tsx` — 当前模型 / 切换
- `packages/client/desktop/src/components/chat/model-selector.tsx` — 模型选择 + 缓存
- `packages/core/api-client/src/client.ts:237-321` — getConfig/patchConfig/getProviders/getProviderAuth/putProviderAuth/promptAsync
- `packages/core/api-client/src/types.ts:214-306` — Provider/Model/Auth/Config/ModelOverride 类型
