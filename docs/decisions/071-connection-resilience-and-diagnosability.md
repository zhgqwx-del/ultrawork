# ADR-071：连接韧性与可诊断性 —— 后台慢重试 + 重连对账 + sidecar 日志落盘

- 状态：已接受（**真机验收通过**，2026-07-29）
- 日期：2026-07-29
- 相关：discussions/057（真机验收清单）· ADR-030（connector / SSE 收敛）· ADR-028（sidecar 凭证）· ADR-045（sidecar 端口生命周期）· discussions/022（切换回来的 busy 标记）· gotchas §20 · conventions §22

## 背景

一轮系统性稳定性 review（无 QA、真机问题暴露不出来）挖出一条**完整故障链**，四段各自独立成缺陷：

```
opencode sidecar 崩溃/卡住 → SSE 断流 → 重试预算耗尽后永久放弃 → 会话永久卡在「运行中」
```

关键证据（全部实测，非读码推断）：

1. **opencode `/event` 无重放** —— 路由订阅即开始（`Bus.subscribeAll`），无 Last-Event-ID、无缓冲。断流窗口内的事件永久丢失。
2. **`gave-up` 是终态** —— 真实 HTTP 探针实测：后端恢复健康后，服务端 accept 计数不再增长，transport 再也不敲门。
3. **sidecar 无守护** —— `spawn_sidecar` 只在启动阶段调用；`watch_sidecar_exit` 拿到 `Terminated` 只置一个仅供启动期换端口用的 flag。
4. **三个自研 sidecar 的 153 处 `console.*` 全部被丢弃** —— Rust 侧 drain 后弃用，且它们自己不写日志文件（只有 vendor 的 opencode 有）。现场问题零信息。

**对照组证明这是遗漏而非设计**：ACP 路径明确实现了 snapshot-on-subscribe（`acp-manager.ts`）来解决同一问题，opencode 路径没有对应物 —— 而 `GET /session/status` 这个原语一直存在，上游 TUI 自己在用。

## 决策

### D1：`gave-up` 从终态改为「快速重试耗尽」，之后转入后台慢重试

`SseRetryPolicy` 增加 `keepRetryingEveryMs`。快速指数退避 5 次后，**状态置 `gave-up` 一次**给 UI 报警，然后每 15s 静默重试直到接上。

「静默」是必需的：慢重试期间不广播 connecting/error/reconnecting，否则 UI 的断连状态每 15s 闪一次。

**不设 `keepRetryingEveryMs` 时行为完全不变** —— gateway 的 `UNLIMITED_SSE_RETRY` 不受影响，且有专门用例守护这条。

**ACP 同步改造**：`ACP_SSE_RETRY` 同样加上。ACP sidecar 也是无守护的本地进程，「31 秒后永久放弃」同样会让单 agent（Claude/Gemini）和 team 的 ACP 成员断流。

### D2：重连后从服务端重新求值，而不是相信可能丢失的事件

`sse-context` 新增 `reconnectEpoch` —— **只在掉线后重新连上时 +1，首连不算**。下游据此重新求值一切「靠折叠事件得出的状态」：

- `use-sessions`：用 `GET /session/status` 重建 `activeSessionIds`
- `use-session-messages`：本地 `sending` 跟随 app 级 map 一起松开

**只处理 opencode 绑定的会话**。ACP 活在另一个进程、自己会重放 busy 快照，去动它只会打架。

### D3：sidecar 输出集中捕获到文件（Rust 侧一处）

在 `watch_sidecar_exit` 里落盘，而不是让每个 sidecar 自己写日志。理由：一处改动覆盖全部四个 sidecar，且**能抓到 panic 和启动期失败** —— 那些永远到不了 JS 侧 logger。

- 落点 `<xdgData>/ultrawork/log/sidecar/<name>.log`，与 acp-sessions / orchestrator-runs 同根
- 4MB 轮转保留一代 ⇒ 单 sidecar 磁盘**硬上限 8MB**
- **写失败即永久禁用 logger，绝不重试** —— shell 插件的事件通道容量为 1 且读端 `block_on(tx.send)`，一个死磕重试的 logger 会把背压直接顶回 sidecar 进程

### D4：断连要有常驻指示

`ConnectionBanner`（4s 宽限，普通抖动不弹）取代原先一次性 toast。

**原计划还要区分「sidecar 死亡」与「网络断开」**（前者没有任何东西会重启它，说「正在重试」是撒谎），由 Rust 侧新增的 `sidecar-exited` 事件驱动。**该实现已撤下** —— 见下方「Windows 加载失败」。

## 实测数据（推翻了两个想当然）

**① 到 `gave-up` 是 61 秒，不是延迟相加的 31 秒。**

真实 sidecar 加时间戳实测：30 秒时心跳看门狗先触发 `stalled` → `forceReconnect()` 把 `reconnectAttempts` 清零 → 又跑一轮完整预算。

```
[t+16.5s] reconnecting   ← 快速预算用完
[t+30.0s] stalled        ← 看门狗介入，预算重置
[t+61.0s] gave-up
```

无害（横幅按 `connected` 触发而非 `gave-up`），但**别从延迟去反推这个数字**。

**② 横幅触发时机分两种。**

| 故障形态 | 出现时间 | 原因 |
|---|---|---|
| 杀进程（socket 断） | **秒级** | 读端立即报错 |
| 冻住不响应（TCP 不断） | **约 34 秒** | 30s 心跳看门狗 + 4s 宽限 |

心跳检测的固有代价，不是缺陷。

## 被否定的假设（同样重要）

review 中有两个方向经实测**证伪**，明确不做：

- **长会话下消息数组 O(n) 复制导致卡顿** —— 真实库最大会话 86 条消息 / 402 个 part，这个规模下数组复制是噪声。
- **海量工作目录导致产物扫描卡顿** —— 80,000 条目实测 14–150ms。
  （但同一探针挖出了真缺陷：LIFO DFS + 截断会**静默漏掉最新产物**，同一文件放 `d000` 找不到、放 `d199` 找得到 —— 已改为有界堆 + 目录按 mtime 从新到旧遍历。）

## 后果

**正面**：断流可自愈；卡死的「运行中」可解开；现场问题第一次有日志可查。

**代价**：
- 断连期间每 15s 一次连接尝试（后端日志会有规律错误行 —— 这是特征不是故障）
- 每次重连多两个请求（`/session/status` + 会话列表刷新）
- sidecar 日志写盘在 drain 线程上：**「慢盘」（非「坏盘」）未覆盖**

## Windows 加载失败：`sidecar-exited` 的 Rust 侧实现已撤下

合入 main 后 CI 的 `rust (windows-latest)` 挂了，而其余七个 job 全绿。失败形态特殊：**测试二进制加载不起来，一个用例都没跑** —— `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139)，是链接/加载问题而非断言失败。

排除与归因（两次 CI 对照，均确认发生了真实重编译、不是复用缓存二进制）：

| 假设 | 结论 |
|---|---|
| flake | 排除 —— `--failed` 重跑仍红 |
| 工具链漂移 | 排除 —— 上一次 main 绿的运行做了**同样的** 1.97.0→1.97.1 升级 |
| 依赖漂移 | 排除 —— `Cargo.lock` 已入库 |
| **对照一**：只回退 `lib.rs` | Windows **绿**（重编译 37.68s，跑完 136 用例）⇒ 归因在本轮 Rust 改动 |
| **对照二**：只回退动 Tauri 类型机制的那半，保留纯 std 部分与全部测试 | Windows **绿**（重编译 53.09s，跑完 **143** 用例）⇒ 归因在 `AppHandle` 进 watcher 线程 / `Manager<Wry>` bound / `notify_sidecar_exited` 的 emit |

**SidecarLog、扫描重写与其全部测试在 Windows 上验证通过**（143 用例含它们），撤下的只有 `sidecar-exited` 这一条链路。

**为什么撤而不是继续查**：main 不该停在红色，而这条链路只影响横幅文案的精细度。

**后续（同日）已用不含 Rust 的方案补回** —— `use-backend-liveness.ts`：横幅升起后探 `GET /global/health`，**只有明确的连接失败**才判定进程已退出；任何 HTTP 响应（含 401/500）都证明有进程在听，超时则判 `unknown`（端口可能开着只是服务卡住，此时指控进程死了是编造）。进程判定为已退出时，连「重新连接」按钮也一并隐藏 —— 留着它就是那句谎话的按钮版。**已知边界**：`vite dev` 下请求走 dev-server 代理，目标拒绝时代理答 500 ⇒ 读作 `listening`，所以这个区分是生产环境专属；dev 拿到的仍是通用文案，与改动前一致、无回退。

**机制尚未查清。** 值得注意的是：`run()` 的 boot 线程**早就**在把 `AppHandle` move 进 `std::thread` 并 `emit`（`gw_handle.emit(...)`），且一直是绿的 —— 所以「AppHandle 进线程 + emit」本身不是充分条件，真正的触发点还需要更细的对照。

## 遗留

- **F1b：断流期间的正文补拉未做。** 现在恢复的是状态（转圈、输入框、侧栏），断流窗口里流过的**消息正文**仍会缺一段，直到切走再切回触发全量重取。要动 `use-session-messages` 的分页合并 —— 那里有明确注释警告「重新 seed 会打乱分页顺序并复活已 revert 的轮次」，值得单独一轮设计。
- **日志目录无 UI 入口。** 用户报障时让他自己找 `~/.local/share/...` 不现实。
- **Windows / Linux 未真机验证**，靠 CI 三平台矩阵兜底。
