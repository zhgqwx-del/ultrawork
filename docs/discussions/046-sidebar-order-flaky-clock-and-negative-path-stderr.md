# 046 — 「sidebar-order.test.ts（config JSON parse）失败」溯源：一次误读 + 一处挂钟 flaky

> 状态：**✅ 根因已实证确认 · 方案已实施（隐患二修复 + 隐患一降噪）** · 2026-07-20
> 范围：追查「唯一 1 个失败 sidebar-order.test.ts（config JSON parse）」这条历史结论，判定真伪并处理连带缺陷。
> 根因层级：**均已代码 + 实跑确证**（非猜测）。

---

## 一、缘起

历史 session 里留下一句：「唯一 1 个失败 sidebar-order.test.ts（config JSON parse）」。用户要求结合源码核实是否真有缺陷、定根因、评方案。

**先给结论**：跑当前 main —— `sidebar-order.test.ts` **6/6 全绿**，整个 desktop 套件 **683/683 全绿**。所谓「失败」是**误读**。但顺这条线挖出两处真实（一大一小）不足。

## 二、隐患一（根因）：负路径测试把预期 `console.error` 泄漏到 stderr → 被误读成「失败」

- 那行 `SyntaxError: JSON Parse error: Unexpected identifier "not"` 根本不来自 sidebar-order，而来自 `src/__tests__/lib/config.test.ts:121` 的用例 **`returns DEFAULT_CONFIG on invalid JSON`**：它**故意**往 localStorage 塞 `"not-json{{{"`，断言 `ConfigStorage.load()` 回退到 `DEFAULT_CONFIG`。**这是一条正向通过的负路径测试。**
- `config.ts:118-119` 在 catch 里 `console.error("Failed to load config:", err)` ⇒ 该预期错误被打到 **stderr**。vitest 并发跑多文件、stderr 交错，这行落在 `sidebar-order.test.ts` 附近 ⇒ 被读成「sidebar-order 失败，原因 config JSON parse」。
- **关键澄清**：vitest **本就把这行归属到了正确文件**——原始前缀是 `stderr | src/__tests__/lib/config.test.ts > ConfigStorage > load > returns DEFAULT_CONFIG on invalid JSON`。文件名、用例名俱全。**所以这是读日志时的人为误读，不是工具没归属。**

因此隐患一**不是缺陷、是输出洁净度问题**，价值定位＝**防下次再误读**：
- 走 catch 打 `console.error` 的用例在 config.test.ts 里**精确只有 1 条**（invalid JSON），已核对全文件。
- 仓库**已有惯例**：`vi.spyOn(console,"error").mockImplementation(()=>{})` + `afterEach(()=>vi.restoreAllMocks())`（sidecar-auth 等 5 个文件在用，无共享 helper，setup.ts 也无全局处理）。
- 处理＝在该用例局部静音，并把静音升级为**正向断言** `expect(spy).toHaveBeenCalledTimes(1)`（顺手证明「确实记了日志」）。**不影响生产行为**（生产里 localStorage 真损坏时该 `console.error` 是有用的）。

## 三、隐患二（真 flaky）：sidebar-order 分组测试有 ~1 分钟/天的挂钟窗口

跟报错无关，但这才是真缺陷。

- 被测函数 `groupSessionsByDate`（`left-sidebar.tsx:125-126`）用**真实挂钟** `new Date()` 算 `todayStart`（本地零点）。
- 测试（`sidebar-order.test.ts:26`）用真实 `now = Date.now()`，把「刚活跃」的会话造成 `updated = now - 60_000`（1 分钟前），断言它落进 **`dateGroup.today`**（line 42-52）。
- **失效场景**：测试恰在本地**零点后 0–1 分钟**内执行时，`now - 60_000` 落到**昨天** ⇒ 分组成 `yesterday` ≠ `today` ⇒ 断言失败。典型「半夜偶发红一次、重跑就绿」的幽灵 flaky。

**中招面（穷举全套后精确=1 条）**：
- 整个 desktop 套件里对**绝对日期分组**做真实挂钟断言的**只有 line 42 这 1 条**。
- 其余 5 个 sidebar-order 用例是**相对排序**或 `now-30DAY`（永远落 earlier），不碰边界，安全。
- `session-item.test.tsx:32` 也用真 `Date.now()`，但断言相对文案 `"5m ago"` 且舍入方向安全，**不 flaky**。

**这是纯测试确定性问题、不是产品 bug**：生产里 `groupSessionsByDate` 读真实挂钟、23:59 显示「今天」、过零点滚到「昨天」，正是期望行为 ⇒ **源码不动**。

### 会让「简单方案」翻车的坑（务必记住）

`now`/`todayStart` 是在**模块加载时**（`sidebar-order.test.ts:26-27`）算的，早于任何 `beforeEach`。天真地在 `beforeEach` 里 `vi.useFakeTimers()` ⇒ **源码的 `new Date()` 被冻住、而测试的 `now` 还是真实值 ⇒ 两个时钟 desync，比现状更糟**。正确改法必须**把两个时钟钉到同一固定时刻**：把 line 26 的 `Date.now()` 换成固定字面量（安全的午间时刻）+ `vi.setSystemTime()` 设成同一时刻 + `afterEach` 复原。不是一行 `useFakeTimers` 能搞定的。

## 四、方案与优先级

| 隐患 | 定性 | 方案 | 优先级 |
|---|---|---|---|
| 二 分组挂钟 flaky | 真 flaky（1 条 / ~60s 每天） | **钉双时钟**：固定 `now` 字面量 + `setSystemTime` 同刻 + `afterEach` 复原；源码不动 | 先做 |
| 一 负路径 stderr 噪声 | 非缺陷、洁净度 | 该用例局部 `spyOn(console,"error")` 静音 + 升级为 `toHaveBeenCalledTimes(1)` 正向断言 | 顺手 |

方案 B（vitest 全局 `onConsoleLog` 白名单吞 stderr）**不采纳**——它会掩盖真错误，正是这次赖以发现问题的信号。

## 五、无需再进一步调研的确认项

- 同类挂钟分组测试：全套仅此 1 处（穷举确认）。
- catch 路径 `console.error`：config.test.ts 里仅此 1 条（全文件核对）。
- 既有 console-spy 惯例：`spyOn + restoreAllMocks`，5 文件在用，直接套。

## 六、遗留教训

「负路径测试的预期 stderr **靠文件前缀判读、切勿凭交错日志下结论**」——固化到 Working Agreements / gotchas，避免同类误读复发（呼应 MEMORY「终端输出会被污染，绝不能凭它下结论」）。
