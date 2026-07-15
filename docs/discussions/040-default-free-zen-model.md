# discussions/040 — 首启默认免费模型（OpenCode Zen）可行性调研

> 状态：调研完成，结论汇入 **ADR-057**。本文件保存实证数据与逐条核验，供后续复核。
> 日期：2026-07-15

## 缘起

诉求：软件打包安装到全新电脑后，首次启动没有任何可用模型（需用户先配 provider + API key 才能对话）。能否把默认模型/provider 设成 OpenCode Zen 的**免费**模型，做到开箱即用？

## 一、现状核验（fresh install 到底发生什么）

真正挂载生效的前端上下文是 `packages/client/desktop/src/lib/model-context.tsx` + `lib/agent-context.tsx`（`main.tsx:57-58`）。
（注：`contexts/ModelContext.tsx` / `contexts/AgentContext.tsx` **不存在**，早期调研误报，勿信。）

- `currentModel` 初始 = `""`（`model-context.tsx:15`）；仅当 `GET /config` 的 `cfg.model` 存在时填充（`:20-28`），持久化走 `PATCH /config`（写服务端 `opencode.json`），**无 localStorage**。
- 新机全局配置 `~/.config/ultrawork/opencode.json` 不存在 → 读出 `"{}"`（`src-tauri/src/lib.rs:6032`）→ `cfg.model` 空 → 选择器显示 "no model" 占位（`components/chat/model-selector.tsx:94-96`）。
- **无 onboarding**；配 provider 是设置页手动动作（`components/settings/models-section.tsx`）。
- 仓库**无内置 API key、无 seeded 默认模型**；sidecar 以 `serve --port <p>` + `OPENCODE_APP_NAME=ultrawork` 启动，**不注入 model/key**（`lib.rs:6286-6304`）。

**关键纠正**：下拉框在新机上**不是空的**。服务端 `/provider` 的 `connected` 由 `Object.keys(Provider.list())` 决定；`opencode`（Zen 网关）的自定义 loader 在无 key 时**保留免费模型、用 `apiKey:"public"` 匿名加载**：

```ts
// vendor/opencode/packages/opencode/src/provider/provider.ts:178-198
async opencode(input) {
  const hasKey = /* env OPENCODE_API_KEY | Auth.get | config.apiKey */
  if (!hasKey) {
    for (const [key, value] of Object.entries(input.models)) {
      if (value.cost.input === 0) continue   // 留免费
      delete input.models[key]               // 删付费
    }
  }
  return { autoload: Object.keys(input.models).length > 0,
           options: hasKey ? {} : { apiKey: "public" } }
}
```

**⇒ 这套匿名免费机制在当前 pin 的 vendor 里已经存在，无需 vendor patch。** 真正缺的是「首启自动选中一个」，不是「让模型可用」。

## 二、实测：空配置真跑 sidecar（decisive）

用已构建的 `binaries/opencode-server-aarch64-apple-darwin`，隔离空 HOME + `OPENCODE_APP_NAME=ultrawork`，零 key，`GET /provider`：

```
connected = ["opencode", "uw-test-openai"]
opencode 自动加载 6 个免费模型：
  mimo-v2.5-free, nemotron-3-ultra-free, deepseek-v4-flash-free,
  north-mini-code-free, hy3-free, big-pickle
```

（`uw-test-openai` 来自仓库根 `opencode.json` 占位符；真实新机无项目级配置，只会剩 `opencode`。）
注意：这 6 个是**运行时从 models.dev 刷新**得到的集合（`models.ts:106-128`，app 未设 `OPENCODE_DISABLE_MODELS_FETCH`），与静态 snapshot 不同（snapshot 里 `gpt-5-nano` 标 `cost.input:0` 但此处未出现）⇒ **免费集随时间漂移、非确定**。

## 三、实测：线上网关匿名可用性 + 工具调用

直接打 `https://opencode.ai/zen/v1`，`Authorization: Bearer public`：

| 免费模型 | 匿名推理 | 工具调用 | 备注 |
|---|---|---|---|
| `big-pickle` | ✅ 200 cost 0 | ✅ | 后端路由到小米 mimo-v2.5 |
| `deepseek-v4-flash-free` | ✅ 200 cost 0 | ✅ | |
| `nemotron-3-ultra-free` | ✅ 200 cost 0 | ✅ | |
| `north-mini-code-free` | ✅ 200 cost 0 | ✅ | |
| `hy3-free` | ✅ 200 cost 0 | ✅ | |
| `mimo-v2.5-free` | ❌ 401 "No provider available" | — | **`/provider` 列它，但匿名跑不了** |
| `gpt-5-nano` / `gpt-5.4-nano` | ❌ 401 "Missing API key" | — | 官方称「永久免费」但匿名不可用 |

`GET /zen/v1/models`（Bearer public）返回 200 且列全部 55 个模型（含付费），但**能否推理另说**——列表 ≠ 可用。

## 四、核心风险（逐条实证，非推测）

1. **列出即失败**：`/provider` 列出的免费集 ⊄ 线上匿名可用集。已确认 `mimo-v2.5-free` 就在 connected 里却 401。⇒ 不能直接「选第一个免费模型」，必须探活。
2. **免费集漂移 + 模型腐烂**：运行时刷 models.dev；模型会被弃用（snapshot 里 `grok-code` 已 `deprecated`）、轮换。死名单会过期。
3. **辅助模型角色**：opencode 给 `opencode` provider 的**标题模型优先级 = `["gpt-5-nano"]`**（`provider.ts:1546-1548`），而 gpt-5-nano 匿名 401 ⇒ 不干预则自动起标题静默失败。
4. **配额/限额**：匿名池全球共享，`retry.ts:57` 有 `FreeUsageLimitError` → "Free usage exceeded, subscribe to Go"。耗尽须显式报错，不能静默挂（呼应 ADR-034/049 idle-guard 历史）。
5. **隐私**：官方明示「免费期间数据可能用于改进模型」。默认把用户代码发给它 = 信任问题。
6. **未文档化 + ToS**：官方当前文档已改口称免费模型也需注册+账单；匿名 `public` 是未文档化通道，随时可能关闭；产品化规模依赖它可能触碰 Zen ToS。

## 五、结论

技术可行、工作量小（管道现成、无需 vendor patch），但**匿名免费访问的可靠性与存活不受我们控制**。因此定位只能是「**零门槛试用入口**」，不能承诺「可靠免费层」。落地必须配三件套：**同意门控 + 探活优选 + 显式失败**。详见 ADR-057。
