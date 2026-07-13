# ADR-055：启动搬离主线程（boot coordinator）+ 内联 splash，消除启动白屏

- 状态：已接受（macOS 真机像素级验收通过，2026-07-13；**Windows/Linux 真机待验**）
- 日期：2026-07-13
- 背景讨论：`docs/discussions/038-startup-white-screen.md`
- 相关：ADR-037（跨平台）· ADR-045（动态端口 / sidecar 关停）· ADR-054（Windows 闪窗）· gotchas §6/§12

## 背景

启动 app 后，主界面出现之前有一段明显白屏，且期间窗口无响应。

根因（Tauri 源码级确认，`tauri-2.10.3/src/app.rs:2370-2383`）：Tauri 先按 `tauri.conf.json` 创建窗口（未设 `visible: false` ⇒ 默认可见），**之后**才调用我们的 `setup()` 钩子；而整个 `setup()` 跑在 `app.run()` 启动事件循环**之前**。我们的 `setup()` 在主线程上同步启动 sidecar，其中 `start_sidecar("opencode-server")` 是四个里**唯一没丢进后台线程的**（gateway/knowledge/acp 都在 `thread::spawn` 里且注释写着 "don't block UI"），它靠 `thread::sleep` 轮询健康检查、最长阻塞 45s。

主线程一停，runloop 就不转，WebView **一帧都画不出来**。所以白屏期间窗口是"僵"的：不是渲染慢，是根本没在渲染。

真机测量（截取原生窗口逐帧数像素）：窗口 3.66s 才出现，纯白到 4.08s，应用 4.23s 才渲染完。

## 决策

### D1：`setup()` 只留信号处理器，其余全部移入 `boot_sidecars()` 协调线程

顺序一字不改（技能要先于 opencode 首次扫描落地、孤儿要先于选端口回收、凭证要先于任何 sidecar 生成），只是不再占着主线程。`setup()` 立即返回 ⇒ 事件循环启动 ⇒ WebView 可绘制。

**副作用（正面）**：主线程释放后，WebView 解析 2.4MB bundle 与 opencode 启动**天然并行**。总时长从"相加"变"取大"——真机实测应用可用时间 **4.23s → 2.22s**。

### D2：渲染门 = 引擎健康，不是端口选定

`main.tsx` 在首次渲染前 await `get_sidecar_ports()`，据此让所有 base-URL helper 保持同步、没有 Provider 需要建模"后端还没起来"。这个契约以前免费成立（setup 阻塞时后端必已就绪）。现在两者并发，所以该 command 改为 async + `spawn_blocking`，park 到协调线程放行为止——**而放行发生在 opencode 健康之后**。

**明确否决的替代方案**：端口一选定就放行（几十毫秒 vs 1.3 秒）。那样 UI 会渲染到一个还没人监听的端口上，每个 Provider 的首次 fetch 都会失败，改动面扩散到业务组件。并行收益不需要靠它——它来自主线程被释放。

### D3：splash 放在 `index.html` 里，纯 HTML/CSS 内联

**前置事实**：只要主线程还堵着，任何 splash 都画不出来——包括静态 HTML。所以"解阻塞"和"加 loading"不是两件事，是一件事的两半。

splash 零 JS 依赖（WebView 首帧即可绘制），阶段文案由 Rust 经 `boot-progress` 事件驱动，**不做假百分比**：真正慢的是装完第一次启动（拷 124MB sidecar + 解压 12165 个技能文件，实测 2s+），一个卡在 90% 的假进度条在那里比诚实的阶段名更伤。

顺带修掉深色模式启动闪浅色（内联脚本在 body 存在前就解析主题）。

### D4：停机用「屏障 + spawn 锁」双重握手

`setup()` 变非阻塞后，**「启动中途退出」从不可达变为可达**，而且窗口比听起来宽得多：gateway/knowledge/acp 在 opencode 健康**之后**才派生，也就是主界面刚出现那会儿——用户在窗口弹出后一秒按 Cmd-Q 就落进去。

- **屏障**（`SHUTTING_DOWN`）定所有权：`shutdown_sidecars` 抽空注册表前置位，spawner 见到就拒绝启动。
- **spawn 锁**（`SPAWN_LOCK`）定时序：光有屏障不够——两条退出路径都在 `shutdown_sidecars()` 一返回就销毁进程（信号路径直接 `process::exit`；`RunEvent::Exit` 返回即由 tao 终止），**没有任何东西等协调线程**。一个卡在 `spawn_sidecar` 里的线程不是"晚了一步"，而是**即将连同它欠下的 `kill_pid` 一起被销毁**；那个子进程既不在被抽空的注册表里、也不在已被删除的 `ports.json` 里 ⇒ 下次启动的 `reap_orphaned_sidecars` 也找不到它 ⇒ **永久孤儿**。锁把「查屏障→spawn→登记」和「升屏障→抽空」变成互斥的原子步骤。

## 后果

### 正面

- 白屏消除（真机像素级验证），启动**快 1.9 倍**。
- **顺带修好一个既存的启动死锁**：`tauri-plugin-dialog` 的 `blocking_show` 内部靠 `run_on_main_thread` 把弹窗投递给事件循环、再阻塞等回调。旧 `setup()` 跑在事件循环启动**之前**并阻塞主线程 ⇒ 那个闭包永远不会被执行 ⇒ **OpenCode 启动失败时 app 永久冻死**。不是"弹窗没弹出来"，是死锁。
- 深色模式不再闪浅色（含 Toaster / CodeMirror 的 `resolvedTheme` 初值）。

### 负面 / 代价

- 引入了两个新的同步原语（屏障 + spawn 锁）和一条新的失败路径（协调线程 panic ⇒ `catch_unwind` 兜成"引擎未起"的降级态）。这是把「启动」从"不可并发"变成"可并发"的必付代价。
- 窗口出现后仍有约 1 帧（~0.1s）纯白，发生在 WebView 首帧绘制之前。可用 Tauri 的 `window.backgroundColor` 消除，但该值静态、深色用户反而会吃一帧浅色 ⇒ **净收益为负，不做**。

### 自动化边界（诚实记录）

**Playwright 结构上验不了白屏**——它驱动浏览器里的 `localhost:1420`，而白屏是原生窗口在主线程被堵住时画不出东西，浏览器里没有那个主线程。本次改用 `CGWindowListCopyWindowInfo` 取窗口 ID + `screencapture -l` 逐帧截原生窗口、数中心区像素，并与 `git stash` 出来的旧版本做对照实验。这是继 ADR-047/048/051/054 之后，第一次真正翻过"原生窗口自动化"这堵墙——但**手段是 macOS 专有的**，Windows/Linux 仍是欠账。
