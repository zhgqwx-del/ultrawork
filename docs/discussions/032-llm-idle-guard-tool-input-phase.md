# 032 — 回复中途报错 `LLM stream idle for 30000ms`：idle 看门狗漏掉「工具参数生成」相位

> 状态：**✅ 已落地（ADR-049）**（2026-07-11：工具参数相位给 600s 兜底杠；opencode + ACP **两条后端路径都有同源缺陷、已一并修复**）
> 日期：2026-07-11
> 输入：用户三张真机截图（2026-07-09 一张、2026-07-11 两张）——AI 回复中途报 `回合出错: LLM stream idle for 30000ms`，最后一个工具显示 `0ms` + `Tool execution aborted`
> 关联：ADR-034（LLM 流式 idle 看门狗，本文**证伪其一条核心假设**）· ADR-042（BYOK 联网搜索 / `enable_search`，本文**排除**其嫌疑）· gotchas §1（opencode/llm.ts）
> 范围：opencode 后端 `session/llm.ts` 的 `idleGuard`，以及 ACP 侧 `acp-connection.ts` 的看门狗（起初以为不含，实测发现同源缺陷 —— 见 §7 R4）。

---

## 0. 一句话

**Provider 没有任何问题，是我们的看门狗量错了。** qwen/DashScope 在「流式吐工具参数」这个相位上有一种**缓冲模式**：报出函数名后先吐几十字节前缀，然后**在服务端把整段参数憋完再一次性 flush**，中间静默 **37~65 秒**（实测 12/12 复现，且 12/12 全部自行恢复并正常收尾）。而 `idleGuard` 恰恰**没有为这个相位设相位**——此时 `inflightTools` 还是空集，于是它用最紧的 30s 杠去量一个正常需要 40~60 秒的窗口，**必然误杀**。

---

## 1. 现象与第一层误导

三张截图的共同形态：报错前的最后一个工具都显示 **`0ms` + `Tool execution aborted`**，回合以 `LLM stream idle for 30000ms` 收尾。这**看起来**像「工具正在执行，被看门狗误杀了」。

**不是。** `processor.ts:399-411` 的 `cleanup()` 在回合失败时，会把所有未完成的 tool part 一律改写成 `status:error / error:"Tool execution aborted"`，并且**把 `time.start` 和 `time.end` 都重写成 `Date.now()`**——所以显示成 0ms。它是「回合死时这个工具还没跑完」的**墓碑**，不是「工具跑了 0ms 被杀」。工具其实**从未开始执行**。

> 这条显示语义本身有误导性（见 §7 遗留 R3）。

---

## 2. DB 取证（`~/.local/share/ultrawork/opencode-.db`）

截图对应会话 `ses_0afd58abfffeYkElbChI3u6Wuh` 的两个失败回合：

| 消息 | 时间 | tokens.output | 最后一个 part |
|---|---|---|---|
| `msg_f502a9ace001…` | 15:53:17 | **0** | tool `bash`，`state.status=error`，`input={}` |
| `msg_f50309c48001…` | 15:59:50 | **0** | tool `bash`，`state.status=error`，`input={}` |

关键时间戳（epoch ms）：

- 回合 A：reasoning 结束于 `…400136` → 墓碑打在 `…430247` = **+30111ms**
- 回合 B：text 段起于 `…797048` → 墓碑打在 `…827877` = **+30829ms**

`idleGuard` 每收到**任何**一个 fullStream 事件就重置计时器，所以「墓碑时刻 = 最后一个事件 + 30s」⇒ **最后一个事件落在 reasoning/text 结束后约 0.1 秒处，此后整整 30 秒零事件**。

`tokens.output = 0` 佐证 `finish-step` 从未到达，流是死在中途而非正常收尾。

### 2.1 ⚠️ 一处必须记下的取证陷阱（我在本次排查中一度据此下了错误结论）

`input={}` **不能**推出「一个参数字节都没收到」。因为 `processor.ts:168-169` 的 `tool-input-delta` 分支是**空实现**（直接 `return`，从不累积 `raw`），所以：

> **DB 里的 `input={}` / `raw=""` 无法区分「没收到参数」和「收到了一半参数」。**

真实情况是后者（§4 时间线实证）。教训：**「DB 没记录」≠「没发生」**。

---

## 3. 对照组：排除「参数太大 / 生成太慢」

同一会话里的成功回合（同一 provider、同一模型、同一时间段）：

| 时间 | 工具 | 参数长度 | 消息耗时 | 结果 |
|---|---|---|---|---|
| 15:54:18 | bash | 5268 字符 | 39.7s | ✅ 完成 |
| **15:56:56** | **bash** | **12181 字符** | **87.5s** | **✅ 完成** |
| 15:53:17 | bash | **2**（`{}`） | 33.0s | ❌ idle 30s |
| 15:59:50 | bash | **2**（`{}`） | 37.0s | ❌ idle 30s |

12181 字符的工具参数、87.5 秒的回合能安然完成 ⇒ **工具参数在正常情况下是逐 delta 流式吐出的**（每个 delta 都重置计时器），大参数本身**不可能**触发 30s idle。所以失败的不是「大」，是**静默**。

---

## 4. 直连 SSE 探针（绕开 AI SDK，不设 idle 超时）

脚本：直连 `https://dashscope.aliyuncs.com/compatible-mode/v1`（provider `myqwen` = `@ai-sdk/openai-compatible`），原始 SSE 逐 chunk 记时间戳，只留 10 分钟硬超时，让停流有机会自行恢复。

### 4.1 E1/E2：中等参数（生成 PDF 报告脚本，约 9~14k 字符）

```
B组(无 enable_search): maxGap 45.9 / 64.9 / 37.0 / 56.0 / 51.9 / 37.1 s  → 6/6 停流, 6/6 恢复
A组(enable_search=true): maxGap 57.7 / 38.4 / 39.8 / 42.9 / 50.8 / …  s  → 6/6 停流, 6/6 恢复
```

- **停流 100% 复现，且 100% 自行恢复**（每次都 `finish=tool_calls`，吐出完整脚本）⇒ **停流是暂态的，不是挂死。**
- 停流点固定在 `after tool_args`。
- **`enable_search` 与本问题无关**（E2 结论）：开/关两组停流率都是 100%、gap 分布几乎一致 ⇒ 从嫌疑名单划掉。

### 4.2 逐 chunk 时间线（钉死静默窗口的边界）

```
 2.7s  reasoning …（一路亚秒级 chunk）
 2.8s  TOOL_NAME=bash          ← 报出工具名（= AI SDK 的 tool-input-start）
 2.9s  args(+13)               ← 只吐了 13 字符的参数前缀（约等于 {"command": "
51.4s  args(+8433)  gap=48.3s  ← 静默 48.3 秒后，8433 字符一次性喷出
51.8s  FINISH=tool_calls       ← 正常收尾
```

与 §2 的 DB 时间戳**完全吻合**：最后一个事件 = 那个几十字节的参数前缀（reasoning 结束后 +0.1s），此后静默 → 30s 被打死。

### 4.3 E3：超大参数（1200 行 python 模块，6~7 万字符）——**推翻了「越大越久」的外推**

```
argChars=62356 → maxGap=7.8s   total=294s  chunks=3932
argChars=73203 → maxGap=6.7s   total=359s  chunks=5021
argChars=66820 → maxGap=5.1s   total=296s  chunks=4143
→ 0/3 停流
```

**参数越大 ≠ 静默越久。** 6~7 万字符的参数反而**全程逐 chunk 流式吐出**（3900~5000 个 chunk），最大间隔仅 5~8 秒。

### 4.4 结论：DashScope 有两种模式，不是一条随大小单调的曲线

| 模式 | 表现 | 命中场景 | 对 guard 的影响 |
|---|---|---|---|
| **流式模式** | args 逐 delta 吐，间隔亚秒~数秒，chunk 数千 | E3 超大参数 3/3；会话里 12181 字符的成功回合 | 安然无恙 |
| **缓冲模式** | 函数名 + 几十字节前缀 → **服务端憋完整段** → 一次性 flush | E1/E2 中等参数 12/12 | **必杀**（静默 37~65s > 30s） |

缓冲模式的静默时长 ≈ 参数的生成时间，实测约 **180~250 字符/秒**（8.4k/48s、11.4k/65s）。

**模式由谁决定、何时切换，未知**——服务端在开始生成时并不知道最终参数多大，所以大概率不是按大小选的（可能与负载/路由有关）。**本文不猜。** 这条未知直接决定了 §6 的阈值取法。

---

## 5. 根因

`idleGuard`（`vendor/opencode/packages/opencode/src/session/llm.ts:52-97`）只认三种状态：

| 状态 | 判据 | 预算 |
|---|---|---|
| 首 token 前 | `!sawFirstToken` | `STREAM_TTFB_TIMEOUT_MS` = 90s |
| 首 token 后、流动中 | `sawFirstToken` | `STREAM_IDLE_TIMEOUT_MS` = **30s** |
| 工具**执行**中 | `inflightTools.size > 0` | **撤防** |

而 **`tool-input-start` → `tool-call` 之间的「工具参数生成中」相位，落进了第二档**：此时 `tool-call` 尚未到达，`inflightTools` 还是空集（id 只在 `tool-call` 时才入集合），`sawFirstToken` 已被 reasoning/text delta 置真 ⇒ **用最紧的 30s 杠，去量一个 provider 正常需要 40~60 秒的窗口。**

参数越大、缓冲模式下憋得越久 ⇒ **任务越复杂越必挂**，正好对应三张截图（大 bash 脚本 / 大 write 文件）。

> **ADR-034 被证伪的假设**：「一旦 token 开始流动，chunk 间隔就是亚秒级，所以 30s 静默 = 挂死」。该假设在**文本相位**成立（§4.2 时间线证实文本 chunk 亚秒级），在**工具参数相位**不成立。ADR-034 当时只想到了「工具**执行**」需要豁免，漏掉了「工具**参数生成**」同样需要。

---

## 6. 方案

### 6.1 为什么不能用「实测最大值 × N」定阈值

§4.4 的两种模式是**独立**的：坏组合（缓冲模式 + 超大参数）我们没测到，也测不完。按 180~250 字符/秒外推，缓冲模式下一次 4 万字符的 write ⇒ **静默约 200 秒**；6 万字符 ⇒ **约 300 秒**。任何按当前实测上限（65s）乘个系数定出来的固定阈值（180s / 300s）都会在坏组合上继续误杀。

更根本的一点：**时间上无法区分「服务端在憋参数」和「真挂死」**——两者在 SSE 上完全同构（都是零字节）。既然无法区分，就必须看两类错误的代价：

| | 代价 |
|---|---|
| **误杀**一个合法的 200 秒参数生成 | **硬性产品故障**：工作作废、上下文丢失、用户被迫重来 |
| **真挂死**多等几分钟 | 难受但**可恢复**：用户有「停止」按钮；而看门狗存在的**唯一刚需**是防止 ADR-034 那个 **session 忙锁永不释放的死锁**，一个很长的兜底杠同样能治 |

⇒ **在工具参数相位上，看门狗的正确姿态是极度保守。**

### 6.2 拍板（D1）：工具参数相位 = 600s 兜底杠

给 `idleGuard` 补第四个相位：

```
限额 = inflightTools 非空                  → 撤防（不变）
     : pendingInputs  非空                 → STREAM_TOOL_INPUT_TIMEOUT_MS = 600_000（新增）
     : sawFirstToken                       → STREAM_IDLE_TIMEOUT_MS = 30_000（不变）
     : 否则                                 → STREAM_TTFB_TIMEOUT_MS = 90_000（不变）
```

- **600s 与 ACP 侧 `ACP_PROMPT_TOOL_SILENCE_MAX_MS`（默认 10 分钟工具静默上限）对称** ⇒ 两条后端路径语义统一。
- 覆盖缓冲模式最坏推算（6 万字符 ≈ 300s）仍有 2x 余量。
- 真挂死仍会在 600s 被抓住 ⇒ **ADR-034 要治的死锁不复发**。
- 文本相位 30s、首字 90s **保持不变**（§4.2 证实这两条杠是对的）。
- 常量 env 可覆盖（`OPENCODE_STREAM_TOOL_INPUT_TIMEOUT_MS`），与既有两个常量同风格。

### 6.3 簿记方式（已核实 AI SDK v6 事件形状，非推测）

`ai@6.0.138` 的 `TextStreamPart` 联合类型（`node_modules/ai/dist/index.d.ts:4554-4580`）：

```
tool-input-start { id, toolName }  →  tool-input-delta { id, delta }
                                   →  tool-input-end { id }
                                   →  tool-call { toolCallId }
                                   →  tool-result | tool-error { toolCallId }
```

**`tool-input-start.id` 与 `tool-call.toolCallId` 是同一个值**——由 opencode 自己的代码坐实：`processor.ts:157` 在 `tool-input-start` 时以 `value.id` 建 part，`processor.ts:178` 在 `tool-call` 时以 `value.toolCallId` 取回**同一个** part（取不到就 `return`）；工具在真机里正常渲染 ⇒ 这个 key 一直对得上。

⇒ `pendingInputs: Set<string>`：`tool-input-start` 入集 → `tool-call` 出集**并**转入 `inflightTools`。**防泄漏**：`tool-error` / `tool-result` 也做删除；`finish-step` 清空整个集合。（泄漏的后果不是崩，而是 guard 在该 stream 剩余时间里一直用最松的杠 = 看门狗部分失效，所以要堵死。）

### 6.4 不做 / 已排除

| | 结论 |
|---|---|
| **让 idle abort 可重试**（`retry.ts` 识别 + 重试前 `Session.removePart` 清残留 part） | **本次不做**。主修之后误杀消失，这条只覆盖「真挂死」的残余场景，却要引入 part 去重的复杂度（失败 attempt 会在同一条 assistant 消息上留下 reasoning + pending tool part，重试会叠加）。列为观察项。 |
| **`enable_search`** | **排除**（E2 实证，与本问题无关） |
| **前端「重试本回合」按钮 + 渲染 `status: retry`** | 独立于本修，另议（现状：前端**完全没渲染** `status: retry`） |
| **让 `tool-input-delta` 累积 `raw`** | 可选小增强（流式模式下能让用户看到参数正在生成）；但缓冲模式下根本没有 delta，救不了本问题。**顺带修可，非必须**——真正的价值是消除 §2.1 的取证陷阱。 |

---

## 7. 已知边界 / 遗留

| # | 项 | 说明 |
|---|---|---|
| R1 | 缓冲模式的**触发条件未知** | 服务端行为，无法从客户端观测。600s 兜底杠使其无关紧要，但若日后 DashScope 把憋参时间拉得更长，仍需调 env。 |
| R2 | **真挂死的用户体感变差** | 从「30s 报错」变成「最长干等 600s」。缓解：用户随时可点「停止」。这是 §6.1 取舍的自觉代价。 |
| R3 | `Tool execution aborted` + `0ms` 的**显示语义误导** | `cleanup()` 把墓碑写成「执行被中断」，且抹掉真实 `time.start`。本次排查一度被它带偏。属既存问题，可另议。 |
| R4 | ~~ACP 侧未验证~~ → **已实测，同源缺陷，已一并修复** | 真 Claude agent A/B：未修复的二进制 34s 死于 `ACP turn idle for 30000ms`（工具停在 `pending`、`input={}`），修复后 61.9s 正常收尾（参数流式期间静默 **52.3s**）。根因同构：claude adapter 对 `input_json_delta` 是 `break`，参数窗口零帧；我们只在 `in_progress` 撤防。修法=`pendingTools` 集合复用已有的 600s 工具静默上限。详见 ADR-049 §ACP。**排查中一处自我纠错**：最初只订阅 `/acp/global/events`（只广播 `session.status`），看不到 `permission.asked`，导致 agent 干等无人回复的权限，我一度把这个 harness 假象当成缺陷表现。 |
| R5 | 其他 provider 是否有缓冲模式 | 未测。但 600s 是**放宽**方向，对其他 provider 只会更安全，无回归风险。 |

---

## 8. 验证计划

1. **单测/headless 回归**（沿用 ADR-034 的 mock provider 配方，`testing.md §8`）：mock 一个 openai-compatible provider，发 `tool_calls.function.name` + 短前缀 → 静默**超过旧的 30s 杠**（用 env 把常量缩小以免测试跑太久）→ 断言**不再被杀**、工具正常执行、回合正常收尾。
2. **反向断言**：静默超过**新的**工具参数杠 → 仍然落 `LLM stream idle` 错误终态（证明看门狗没被改废）。
3. **A/B 反证**：删掉 `pendingInputs` 那几行，用例必须变红（防止写出一个"注释里有 env 名就能过"的假守卫）。
4. **真机验收**：qwen3.7-max + 「生成一个内容随意的 PDF」（原始复现场景），连跑 5 次不再出现 `LLM stream idle for 30000ms`。
5. vendor patch 重新生成（`docs/vendor-patch-workflow.md`）+ typecheck。
