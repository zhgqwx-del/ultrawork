# 038 — 启动白屏：根因与过渡 Loading 方案

> 状态：✅ **已实现**（ADR-055，v0.2.8；macOS 真机像素级验收通过，Windows/Linux 真机待验）
> 日期：2026-07-13
> 关联：ADR-045（动态端口）· ADR-054（Windows 闪窗）· **ADR-055**

## 〇 问题

启动 Ultrawork 后，主界面渲染出来之前有一段明显的「白屏」——窗口已经在屏幕上，但内容区一片空白，且期间窗口不响应。

## 一 根因（已从源码 + 实测坐实，非推测）

### 1.1 窗口先于 setup 创建，而 setup 阻塞在事件循环启动之前

Tauri 自己的源码 `tauri-2.10.3/src/app.rs:2370-2383`：

```rust
fn setup<R: Runtime>(app: &mut App<R>) -> crate::Result<()> {
  for window_config in app.config().app.windows.iter().filter(|w| w.create) {
    WebviewWindowBuilder::from_config(app.handle(), window_config)?.build()?;  // ① 先建窗口
  }
  app.manager.assets.setup(app);
  if let Some(setup) = app.setup.take() {
    (setup)(app)...                                                            // ② 才跑我们的 setup
  }
}
```

- `tauri.conf.json` 未设 `"visible": false` ⇒ `visible` 默认 true ⇒ **①处窗口立刻可见且为空**。
- 这整个 `setup()` 发生在 `app.run()` **之前**——事件循环尚未启动。
- 主线程被②里的同步代码占住 ⇒ runloop 不转 ⇒ WebView **一帧都画不出来**。

这解释了为什么白屏期间窗口是「僵」的：不是渲染慢，是根本没在渲染。

### 1.2 setup 里唯一没被丢到后台的 sidecar 就是 opencode

`lib.rs:5523-5741` 的 setup 同步执行：

| 行 | 操作 | 代价 |
|---|---|---|
| 5526 | `install_signal_handlers()` | 轻 |
| 5530 | `ensure_sidecar_copies()` | 拷贝 sidecar 二进制（opencode 124MB+）；`size:mtime` 幂等，**仅首装/升级后付费** |
| 5535 | `ensure_builtin_skills()` | 解压 `skills-builtin.zip` |
| 5542/5547 | `canonicalize_sidecar_mcp_paths()` / `strip_persisted_sidecar_ports()` | 读写 opencode.json |
| 5552 | `reap_orphaned_sidecars()` | lsof/WMI + kill + `sleep(200ms)` |
| 5557 | `load_or_create_sidecar_credentials()` | 磁盘 IO |
| **5596** | **`start_sidecar("opencode-server", …)`** | **主阻塞源** |

代码注释自己承认了（`lib.rs:5578`）：

```rust
// OpenCode goes first (critical — blocks until ready).
```

`await_sidecar_ready`（`lib.rs:855-879`）是纯同步轮询：`poll_interval = 200ms`，`max_wait = 15s`，`MAX_START_ATTEMPTS = 3`，靠 `std::thread::sleep` 卡住主线程。

**对比**：gateway / knowledge / acp 三个都在 `std::thread::spawn` 里（`lib.rs:5642 / 5674 / 5707`），注释写着 "non-critical, don't block UI"。**唯独 opencode 没有。**

### 1.3 实测数据

| 项 | 实测值 | 方法 |
|---|---|---|
| opencode spawn → `/global/health` 返回 200 | **1295 ms**（热启动，M 系列 Mac） | 直接跑 `opencode-server serve --port 4196` 并轮询 |
| 首屏 JS bundle | **2.4 MB** 单体（`dist/assets/index-*.js`） | `ls -lhS dist/assets` |
| 健康轮询粒度 | 200 ms（1.3s 实际会被向上取整到 ~1.4s） | `lib.rs:863` |

冷启动（刚装完、二进制不在 page cache、Gatekeeper 首次校验）只会更慢；最坏路径 15s × 3 次尝试。

### 1.4 白屏是四段**串行**叠加

1. **setup 主线程阻塞等 opencode 健康检查** — ~1.3s（热），冷启动更久 ← 主因
2. **setup 里的文件重活** — 拷贝二进制 / 解压技能 zip / `reap` 里的 `sleep(200ms)` ← 首装、升级后显著
3. **单体 JS bundle 解析执行** — 2.4MB，无 code splitting，14 个 CodeMirror 语言包全在首屏 chunk（`vite.config.ts` 无 `build.rollupOptions`；全仓库仅 `delegate-row.tsx` 一处 `React.lazy`）
4. **前端自己的两道门**：
   - `main.tsx:36` `Promise.all([loadSidecarPorts(), loadSidecarCredentials()])` resolve 之前 **`createRoot().render()` 根本不调用**，`#root` 保持空
   - `root-layout.tsx:22` `initializing` 为 true 时渲染一个视觉全空的 div（只有背景色 + DragRegion）

> **关键点**：第 1 段和第 3 段**本可并行**（opencode 在后台起，WebView 同时解析 JS），但主线程被堵死，两者被迫串行。解开阻塞本身就是一次提速。

### 1.5 全链路零视觉反馈

- `index.html` 的 body 只有 `<div id="root"></div>`，无静态占位、无内联背景色、无主题 class。
- 启动路径上 grep `splash|Skeleton|Spinner` **零命中**。

### 1.6 附带发现（两个既存缺陷）

**(a) 深色模式启动闪浅色。** `theme-context.tsx:16` `resolvedTheme` 初值硬编码 `"light"`，`root.classList.add(effectiveTheme)` 只在 `useEffect` 里跑；而 `config.ts:69` 默认 `theme: "system"`。深色用户必然先看到一帧浅色。

**(b) 启动错误弹窗大概率从未成功弹出。** `tauri-plugin-dialog-2.6.0/src/lib.rs:355` 明写：

> This is a blocking operation, and should **NOT** be used when running on the main thread context.

而我们的两个 `blocking_show()`（`lib.rs:5567` 凭证失败、`lib.rs:5623` opencode 启动失败）**正是在主线程的 setup 里调的**。方案 B 把启动搬到后台线程后，这个缺陷被顺带修复。

---

## 二 方案 B（选定）：解阻塞 + 静态 splash

### 2.1 为什么必须先解阻塞

**只要主线程还堵在 setup 里，任何 splash 都画不出来**——包括 index.html 里的纯静态 HTML。「解阻塞」和「加 loading」不是两个可选项，是一件事的两半。

### 2.2 A/B 取舍（已定 B）

| | A：UI 挂载即摘 splash | **B：UI 挂载 且 opencode ready 才摘** |
|---|---|---|
| 符合「主界面一出来就完成」 | 严格符合 | 基本符合（两者并行，差值小） |
| 后端未就绪时的首屏 | 会话列表等请求会失败，需各业务组件自己兜重试/局部 loading | 不存在该状态 |
| 现有不变量「首次渲染时后端必可用」 | **被打破** | **保住** |
| 改动面 | 扩散到业务组件 | 收敛在 `lib.rs` + `index.html` + `main.tsx` |
| 典型总时长 | ≈ max(JS 1.0s, —) ≈ 1.0s | ≈ max(JS 1.0s, opencode 1.3s) ≈ **1.5s** |

**选 B**：多等的 ~0.5s 换来零业务改动 + 零半可用状态。而且相比现状的「串行 ~2.5s 白屏」，B 是「并行 ~1.5s 有反馈」——**更快且更好看**。

### 2.3 改动清单

#### (1) Rust：启动协调线程（`lib.rs`）

setup 只保留**快**的部分同步执行，其余全部移入一个 boot coordinator 线程，setup 立刻 `Ok(())` 返回 ⇒ 事件循环启动 ⇒ WebView 可绘制。

- **留在 setup 主线程**：`install_signal_handlers()`（必须最早、且极快）。
- **移入协调线程**（顺序**完全不变**，依赖关系零改动）：
  `ensure_sidecar_copies` → `ensure_builtin_skills` → `canonicalize_sidecar_mcp_paths` → `strip_persisted_sidecar_ports` → `reap_orphaned_sidecars` → `load_or_create_sidecar_credentials` → `start_sidecar(opencode)` → spawn 其余三个 sidecar 线程。
- 两处 `blocking_show()` 随之落到后台线程 ⇒ 符合插件契约（见 §1.6b）。

**端口时序**（关键细节）：`get_sidecar_ports` 是渲染端同步基址的唯一来源，端口未定时不能被读到。所幸**选端口（`plan_port`，几十 ms）和等健康（1.3s）是两件事**——协调线程先 `plan_port` + `spawn` + `set_sidecar_port`，再去慢慢 `await_sidecar_ready`。这样 `main.tsx` 的启动门语义**一行都不用改**。

#### (2) Rust：停机握手 —— **本方案唯一的新增风险，必须处理**

现状 `shutdown_sidecars()`（`lib.rs:640-643`）用 `mem::take` **抽空** `SIDECAR_REGISTRY`，随后 `remove_ports_json()`（`:673`）。

今天 setup 阻塞，用户在启动期间**没有机会退出**，所以这条路径不可达。**一旦 setup 变成非阻塞，「启动中途退出」立刻成为可达路径**：协调线程会在注册表被抽空**之后**继续 `reg.push(...)` 新 sidecar ⇒ 该进程永不被杀，且 ports.json 已删除 ⇒ **下次启动的 `reap_orphaned_sidecars` 也看不见它**（它只读 ports.json）。这是纯新增的孤儿进程路径，正是 ADR-045 / ADR-054 一直在打的那类 bug。

**设计要求**：

- 新增 `SHUTTING_DOWN: AtomicBool`。
- `shutdown_sidecars()` 入口先置位。
- 协调线程在**每次 spawn 之前**检查该标志，已置位则直接放弃后续启动。
- spawn **之后**再检查一次：若此时已置位（spawn 与 shutdown 竞态），立刻 `kill_pid` 自己刚起的子进程。
  （「先注册后检查」的顺序保证不漏：注册表若已被抽空，这次 kill 就由协调线程自己负责。）
- 验收：应用启动过程中立即退出，不留任何 sidecar 残留（`ps` 断言）。

#### (3) 前端：`index.html` 内联 splash

- body 里内联一段纯 HTML/CSS 的 splash（**零 JS 依赖**，WebView 第一帧即可绘制），含细进度条 + 阶段文案。
- 同时内联一小段 `<script>` 主题探测：读 `localStorage["ultrawork-config"]` 的 `.theme`（`config.ts:77` `CONFIG_STORAGE_KEY`），为 `system` 则查 `prefers-color-scheme`，据此给 `<html>` 打 `light`/`dark` class + 设 splash 背景色。**顺带修掉 §1.6a 的深色闪白。**
- macOS `titleBarStyle: "Overlay"`：splash 需带 `data-tauri-drag-region`，否则启动期间窗口拖不动。

#### (4) Rust → 前端：启动阶段事件

协调线程 emit `boot-progress`（阶段枚举：`preparing` 拷贝组件 / `skills` 解压技能 / `engine` 启动引擎 / `ready` / `failed`），splash 显示**真实阶段文案**。

**不做假百分比**——首装那次是真的慢，假进度条卡在 90% 比诚实的阶段文案更伤。

#### (5) 前端：splash 摘除时机与逃生门

摘除条件 = **React 已挂载** `&&` **收到 `ready`（或 `failed`）事件**。

三条硬约束：

- **非 Tauri 环境必须能摘。** e2e（40+ 个 Playwright 用例，跑在普通浏览器 + Tauri shim 上）和 vitest 里 `boot-progress` 事件**永远不会来**。若 splash 只听事件，**全部 e2e 会挂**。⇒ 检测不到 Tauri 宿主时，React 挂载即摘。
- **超时逃生。** `failed` 事件之外再加一个前端侧上限（如 20s），到点强制摘除并在 UI 内提示，避免任何未预料路径把用户永久锁在 splash 上。
- **摘除后不得残留。** splash 节点直接 `remove()`（非 `display:none`），且淡出期间 `pointer-events: none`，否则会拦截 e2e 的点击。

#### (6) 可选：Vite code splitting

`vite.config.ts` 加 `build.rollupOptions.manualChunks`，把 CodeMirror / markdown / pdf 从首屏 chunk 拆出。砍掉 §1.4 的第 3 段。**可独立于本方案单独做**，不阻塞。

### 2.4 预期收益

- 白屏 → 有反馈的 loading（**根因层面消除**，不是遮盖）。
- 启动**实际变快**：JS 解析与 opencode 启动从串行变并行，总时长从「相加」变「取大」。
- 顺带修复：深色闪白（§1.6a）、启动错误弹窗失效（§1.6b）。

---

## 三 跨平台评估（ADR-037 三平台约束）

| 关注点 | macOS | Windows | Linux | 说明 |
|---|---|---|---|---|
| 窗口先于 setup 创建且默认可见 | ✅ | ✅ | ✅ | Tauri 通用行为，非平台特性 |
| 主线程阻塞 ⇒ 无法绘制 | ✅ | ✅ | ✅ | 三平台事件循环同理 |
| 内联 splash（纯 HTML/CSS） | ✅ | ✅ | ✅ | WKWebView / WebView2 / webkit2gtk 均无依赖 |
| `std::thread::spawn` 协调线程 | ✅ | ✅ | ✅ | 与既有三个 sidecar 线程同构 |
| `blocking_show` 移出主线程 | ✅ | ✅ | ✅ | 符合插件契约（现状是违反的） |
| `data-tauri-drag-region` | 必需（`titleBarStyle: Overlay`） | 无害 | 无害 | Overlay 仅 macOS 生效 |
| `SHUTTING_DOWN` 标志 | ✅ | ✅ | ✅ | 纯 Rust 原子量，无平台分支 |

**Windows 专项**：`reap_orphaned_sidecars` 会派生 PowerShell/WMI/taskkill。移到后台线程后，**ADR-054 的 `sys_cmd()` 守卫依然有效**——`CREATE_NO_WINDOW` 是**每个 Command** 的标志，与调用线程无关。⇒ **不会引入新的闪窗**。但这是「推理正确」，仍应纳入 Windows 真机验收（见 §四）。

**结论：方案本身无平台分支，三平台同构。** 唯一需要真机确认的是 Windows 闪窗未回归（推理上不会）。

---

## 四 验收判据

| # | 项 | 手段 |
|---|---|---|
| 1 | 启动全程无白屏，splash 立即可见 | 人工（用户）· 录屏 |
| 2 | splash 在主界面出现的同时消失，无闪烁/无残留节点 | 人工 + DOM 断言 |
| 3 | 深色模式启动**不闪浅色** | 人工（用户）· 视觉判断 |
| 4 | **启动中途退出，无 sidecar 残留** | 可编程：启动后立即退出 → `ps`/`tasklist` 断言无残留 ← **本方案的核心回归风险** |
| 5 | 40+ e2e 全绿（splash 在非 Tauri 环境正常摘除） | `bun run test:e2e` |
| 6 | opencode 启动失败时错误弹窗**能弹出**（现状不能） | 手动注入失败（占用端口 / 改坏二进制路径） |
| 7 | Windows 无闪窗回归 | Windows 真机（可并入既有欠账批次） |
| 8 | Rust 单测 132 + 各包测试基线不退 | CI |

> 注意：#1 #2 #3 是**视觉判断，由用户做**（分工准则）。#4 #5 #6 #8 是可编程断言，我做。

---

## 四点五 实现后的三路对抗审查（2026-07-13）

实现完成后按三个互不重叠的视角各跑一轮对抗审查（并发/生命周期 · 跨平台 · 前端与 e2e 回归面）。**九条真缺陷，全部已修并复验**。

### 最重的三条

**① `boot-progress` 的阶段文案是死代码**（两个视角独立撞上，且实测复现）。
`dismissSplashWhenReady()` 原本在 `Promise.all([loadSidecarPorts(), …]).then()` **内部**才调用，而 `loadSidecarPorts()` 要等启动门——门在 opencode 健康后才开。⇒ 渲染端挂上 `listen("boot-progress")` 时，协调线程**早已跑完所有阶段**。真机插桩证据：webview 只收到 `stage=ready` 一条，`preparing`/`skills`/`engine` 全部 emit 给了空气。**后果=在最需要它的那次启动（首装：拷 124MB + 解压 12165 个技能文件 ≈ 2 秒）用户只看到写死的「正在启动…」一动不动。**
根因是我自己在 `main.tsx` 写的一条**错误注释**（"宿主在端口一选定就放行"——实现改了，注释没改），写注释的人以为门开得早、阶段文案才有意义。
修：新增 `beginBootTracking()`，在 `main.tsx` 顶部、启动门**之前**调用。修后实测：`skills → engine → ready` 逐级可见。

**② 停机屏障能定所有权，定不了时序 ⇒ 仍会漏孤儿进程。**
两条退出路径都在 `shutdown_sidecars()` 一返回就销毁进程（信号路径 `std::process::exit`；`RunEvent::Exit` 返回即由 tao 终止），**没有任何东西等协调线程**。所以一个卡在 `spawn_sidecar` 里的 spawner（子进程已 fork、尚未 push 注册表）不是"晚了"，而是**即将连同它欠下的 `kill_pid` 一起被销毁**——那个子进程既不在被抽走的注册表里、也不在已被删除的 `ports.json` 里 ⇒ 下次启动的 `reap` 也找不到它 ⇒ **永久孤儿**。
而且窗口远比"启动中途退出"宽：gateway/knowledge/acp 在 opencode 健康**之后**才开始派生，也就是主界面刚出现那会儿——**用户在窗口弹出后一秒按 Cmd-Q 就落进去**。
修：新增 `SPAWN_LOCK`，把「查屏障 → spawn → 登记」和「升屏障 → 抽空注册表」变成互斥的两个原子步骤。复验：0.6/1.2/1.6/2.0/2.6/3.2s 六个时刻 SIGTERM，**全部零残留**。

**③ 兜底计时器装在了不会卡的那条腿上。**
`Promise.all([whenBootReady(), whenPainted()])` 里，有 60s 兜底的是 `whenBootReady`（它本来就必定 resolve），而 `whenPainted()` 的 rAF **没有任何超时**——三平台 WebView 在窗口最小化/被遮挡时都会停 rAF ⇒ 启动中最小化 ⇒ splash 永不摘除，兜底也管不到（它只结算自己那条 Promise）。修：`whenPainted` 自带 2s 超时。

### 其余六条

④ `PortPlan::Reuse` 分支绕过屏障检查（`plan_port` 含健康探测、可能耗几百毫秒）⇒ 被"接管"的进程无人负责。
⑤ `write_ports_json` 的屏障检查在锁**外**、`remove_ports_json` 根本不拿锁 ⇒ ports.json 可在删除后被写回来。修：检查移进锁内 + 删除也持同一把锁。
⑥ `BOOT_PORTS_WAIT = 20s` **低于代码自己的最坏合法启动**（`MAX_START_ATTEMPTS` × 15s = 45s，还没算首装文件开销）⇒ 会在合法慢启动上触发回退、把 UI 渲染到一个没起来的后端上，正好打破选 B 就是为了保住的不变量。改为 90s；`BACKSTOP_MS` 相应改为 120s（**必须严格晚于门**，否则兜底会把 splash 从一个 React 还没渲染的空 `#root` 上摘掉——反而把白屏造回来）。
⑦ 两条失败路径都在设置终态**之前** `blocking_show()` ⇒ 错误弹窗压在一个还在转圈说「正在准备组件…」的 splash 上，且要等用户点掉。修：先置 FAILED + 放行门，再弹窗。
⑧ splash 纯中文，而 app 对非 `zh` locale 默认英文 ⇒ 英文用户在最慢的首启全程盯着中文。修：内联脚本与 `boot-splash.ts` 都按 `ultrawork-config.language` → `navigator.language` 解析。
⑨ 主题闪白只修了一半：`theme-context.tsx` 的 `resolvedTheme` 仍硬编码初值 `"light"` ⇒ class 首帧对了，但它的消费者（Toaster、CodeMirror 主题）在深色下仍吃一帧浅色。修：初值改读 `documentElement.classList.contains("dark")`。

### 顺带确认的既存缺陷（本次改动修好了）

`tauri-plugin-dialog` 的 `blocking_show` 内部靠 `run_on_main_thread` 把弹窗投递给事件循环，再阻塞在 channel 上等回调。而旧的 `setup()` **跑在事件循环启动之前**并阻塞在主线程 ⇒ 那个闭包永远不会被执行 ⇒ **OpenCode 启动失败时 app 永久死锁**，不是"弹窗没弹出来"。搬到后台线程是必需的正确修法。

### 判为"不是问题"（逐条给了证据，不复述）

`SIDECAR_CREDENTIALS_LOCK` 死锁 · `spawn_blocking` 线程池耗尽 · 单实例插件与协调线程的交互 · 双路径 `shutdown_sidecars` 的幂等性 · e2e 布局/截图/点击类用例被 splash 污染（`position:fixed` 脱离文档流，且全仓无 `force:true` 点击 / `elementFromPoint`）。

---

## 四点六 真机像素级验证（2026-07-13）—— 白屏的存在与消除，首次被客观测量

**Playwright 结构上验不了白屏**：它驱动的是浏览器里的 `localhost:1420`，而白屏是**原生窗口**在主线程被堵住时画不出东西——浏览器里根本没有那个主线程。此前所有 e2e/探针都只覆盖了 splash 的**逻辑**，从未验证过**白屏本身是否消失**。

**方法**：`swiftc` 编一个 `CGWindowListCopyWindowInfo` 小工具拿到 Ultrawork 的 CGWindowID → `screencapture -l <id>` **只截该窗口**（第一版用全屏 diff 定位窗口，结果把我自己滚动的终端量了进去，产出了一组自信而完全虚构的数字——已弃）→ 逐帧统计窗口**中心区**的非背景像素（splash 的进度条与文案都在正中，空白窗口那里什么都没有；全窗口统计无法区分二者：三个红绿灯按钮就占 0.05%，而 splash 的条+字也才 ~0.12%）。

**对照实验**（`git stash` 掉改动、编译旧版、同一套探针）：

| | 旧版本 | 修复后 |
|---|---|---|
| 窗口出现 | **3.66s**（此前屏幕上什么都没有） | **0.26s** |
| 纯白空窗口（已存证：只有三个红绿灯按钮的白窗） | 3.66s → 4.08s | 仅首帧 ~0.1s |
| 屏幕上首次出现有意义的内容 | **4.23s**（直接跳到应用） | **0.36s**（splash） |
| 应用完全渲染 | **4.23s** | **2.22s** |

**结论**：① 白屏客观存在且已被消除；② **应用可用时间 4.23s → 2.22s，快 1.9 倍**——「主线程释放后 bundle 解析与引擎启动并行」不再是推理，是量出来的；③ 首启阶段文案在真机上逐级可见（插桩证据：`skills → engine → ready`）。

**残留（未修，已知）**：窗口出现后仍有**约 1 帧（~0.1s）纯白**，发生在 webview 首帧绘制之前。可用 Tauri 的 `window.backgroundColor` 消除，但该值是静态的，深色用户反而会吃一帧浅色——**净收益为负，故不做**。

---

## 五 未决 / 明确不做

- **假进度百分比**：不做（见 §2.3(4)）。
- **`visible: false` + 就绪后 `show()`**：**不采用**。用户点图标后若 1.5s 内什么都不出现，感知上更像「没启动成功」，比 splash 更差。
- **Vite code splitting**：可做，但独立于本方案，不阻塞（§2.3(6)）。
- **RootLayout 的 `initializing` 骨架屏**：B 方案下 splash 已覆盖该窗口期，暂不需要；若将来改走 A 方案再议。
