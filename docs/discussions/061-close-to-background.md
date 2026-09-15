# 061 — 关窗口不退出：隐藏到后台 + 托盘 / 菜单栏常驻

> 状态：**已实现（2026-09-15，ADR-074），mac 真机 9 步全过；Windows/Linux 真机待验** —— 验证记录见 §八
> 日期：2026-09-15
> 触发：用户对照 QoderWork / WorkBuddy（均为 Electron）——它们在 macOS 点 X 只关窗口、进程与服务仍在；Ultrawork 点 X 是整个 app 退出、4 个 sidecar 全杀。Windows 同样。
> 用户拍板（2026-09-15）：① Linux 一起做，三平台一致 ② macOS 加菜单栏图标 ③ **不做**「关闭时隐藏/退出」设置项（对照产品没有，不给用户多一步）④ 首次隐藏弹一次托盘气泡（Win/Linux）⑤ 启动失败态关窗直接退出 ⑥ 菜单栏模板图先用现有 icon 转灰度占位

---

## 一、现状（源码事实，非推断）

| 层 | 事实 | 出处 |
|---|---|---|
| Rust 壳 | `run()` 只注册 `RunEvent::Exit → shutdown_sidecars()`；**无 `on_window_event`、无 `ExitRequested`/`Reopen` 处理、无托盘**（`tray-icon` feature 未开） | `lib.rs` `run()` |
| Tauri 默认链 | X → `CloseRequested`（无人 `prevent_close`）→ `Destroyed` → 窗口表为空 → `ExitRequested{code:None}`（无人 `prevent_exit`）→ `ControlFlow::Exit` → `RunEvent::Exit` → 杀 sidecar | `tauri-runtime-wry-2.10.1/src/lib.rs:4171-4185` |
| 三平台 | Windows/Linux 原生标题栏的 X 走同一条链，行为一致 | 同上 |
| 已知未做 | gotchas §6 早已记「关窗口 == 退出 app（macOS 无窗口仍驻留 Dock 需显式处理，本项目没有）」；discussions/002 第 72 行列「System Tray 常驻 — 关窗口不能死进程，尤其 IM 消息场景」 | — |
| 对照产品 | 两者都是 Electron；Electron 模板默认 `window-all-closed` 时 `if (platform !== 'darwin') app.quit()` ⇒ mac 关窗不退是生态惯例 | `/Applications/*.app/Contents/Frameworks` |

**不是回归，是从未实现。** 对本项目尤其重要：关窗口杀掉的是 gateway（IM bot 全体下线）、knowledge sidecar、跑到一半的 agent 会话。

## 二、机制地基（读 tauri 2.10.3 / tauri-runtime-wry 2.10.1 / tao 0.34.6 / wry 源码确认）

1. **隐藏 ≠ 销毁**：`window.hide()` 只 `SW_HIDE`/`orderOut`，窗口仍在 `windows` 表 ⇒ 永不触发「表空 → ExitRequested」；事件循环、WebView 实例（React 状态、SSE、草稿）全部保留。
2. **`WindowEvent::CloseRequested { api }` 可 `api.prevent_close()`**，Rust 侧 `Builder::on_window_event` 即可，**不需要新 capability 权限**（JS `onCloseRequested` 才需要）。
3. **Cmd+Q 与 X 走完全不同的路**：默认菜单 Quit = muda `sel!(terminate:)`（`muda/platform_impl/macos/mod.rs:911`）→ NSApp 终止 → tao `applicationWillTerminate` → `LoopDestroyed` → `RunEvent::Exit`。**不经过 `CloseRequested`/`ExitRequested`** ⇒ 拦 X 不会误拦 Cmd+Q。
4. **macOS 点 Dock**：tao 把 `applicationShouldHandleReopen` 转成 `RunEvent::Reopen { has_visible_windows }`，且**向 AppKit 返回 `has_visible_windows`**（无可见窗口时返回 NO ⇒ AppKit 不做默认处理，必须我们自己 show）。最小化窗口也算「不可见」⇒ handler 要 `unminimize + show + set_focus`。
5. **Windows 关机/注销**：tao 对 `WM_ENDSESSION` 直接 `loop_destroyed()`（`tao/platform_impl/windows/event_loop.rs:2384`），不走 `WM_CLOSE` ⇒ 拦 X 不阻塞关机，sidecar 清理照常。
6. **托盘**：Tauri 内置 `tray-icon` feature（`tray-icon 0.21.3` 已在依赖树，未启用）。`linux-libxdo` 是独立 feature，我们不开 ⇒ 不新增 `libxdo` 链接依赖。
7. **Linux 托盘库是运行时 dlopen**（`libappindicator-sys` 依次找 `libayatana-appindicator3.so.1` / `libappindicator3.so.1`），CI 已装 `libappindicator3-dev` ⇒ 编译零成本；**但缺库时是 `panic!`**（`libappindicator-sys-0.9.0/src/lib.rs:44`），且 `Lazy` poison 后再碰仍 panic。
8. **`window.hide()` 不碰 WebView2 的 `IsVisible`**：`WindowMessage::Hide` 只 `tao.set_visible(false)`（`tauri-runtime-wry:3359`）；wry 只在 `Webview::hide` 时 `SetIsVisible(false)`（`wry/webview2/mod.rs:1475`）。WebView2 不会自己察觉父窗口隐藏 ⇒ Windows 必须连 webview 一起 hide，否则隐藏后 Chromium 照常离屏合成。
9. **通知点击不会唤回窗口（确定的限制）**：tao 的 app delegate 只挂 7 个 selector，无 `applicationDidBecomeActive`；`tauri-plugin-notification` 桌面端走 `notify-rust` 发完即忘，`mac-notification-sys` 的 `rust_notification_activated` 未暴露到插件。
10. **已有免费兜底**：`tauri-plugin-single-instance` 回调已是 `unminimize/show/set_focus` ⇒ 隐藏后再启动一次即唤回，三平台通用。

## 三、定稿方案

**统一规则**：X / Cmd+W / Alt+F4 → `prevent_close()` + 隐藏；真正退出只走：Cmd+Q（mac 菜单 / Dock 右键）、托盘/菜单栏「退出」、系统关机/注销、SIGTERM。**不加设置项。**

| | macOS | Windows | Linux |
|---|---|---|---|
| X 后 | 隐藏；Dock 常驻（ActivationPolicy 保持 Regular） | 隐藏（任务栏消失）+ **webview 一起 hide** | 隐藏；**托盘创建失败则退回关 = 退** |
| 唤回 | Dock（`Reopen`）/ 菜单栏图标 / 再启动 | 托盘左键 / 再启动 | 托盘 / 再启动 |
| 退出 | Cmd+Q / Dock 右键 / 菜单栏「退出」 | 托盘「退出」/ `WM_ENDSESSION` | 托盘「退出」/ SIGTERM |
| 托盘菜单 | 「打开 Ultrawork」「退出」 | 同 | 同 |
| 首次隐藏提示 | 无（Dock 图标即提示） | 托盘气泡一次 | 托盘气泡一次 |

### 决策细则

- **D1 关窗决策抽成纯函数**：`close_action(platform, tray_ready, boot_stage) -> Hide | Quit`，配单测。规则：`boot_stage == failed` ⇒ Quit（引擎起不来没有值得常驻的东西，隐藏一个坏实例只会让「重开」拿到同一个坏实例）；**非 mac** 且 `!tray_ready` ⇒ Quit（Windows/Linux 没有 Dock，用户不能失去唯一可见入口；实现时从「仅 Linux」放宽到「非 mac」）；其余 Hide。
- **D2 托盘只创建一次**，结果存 `TRAY_READY: AtomicBool`；Linux 用 `catch_unwind(AssertUnwindSafe)` 包住（panic 不能带崩启动）。在 `setup()` 里建（瞬时操作，符合 ADR-055 约束；tray 与 GTK 都要求主线程）。
- **D3 `restore_main_window(app)` 一个 helper**：`unminimize → show → [windows: webview.show] → set_focus`，single-instance / `Reopen` / 托盘左键 / 托盘菜单四处共用。
- **D4 macOS 原生全屏下的 X**：先 `set_fullscreen(false)` 再隐藏（全屏窗口占独立 Space，直接 hide 留空 Space）。Tauri 无 `leave-fullscreen` 事件 ⇒ 退全屏后延迟隐藏或等下一个 `Resized`，**时序真机定**。
- **D5 托盘文案跟随应用语言**：Rust 不知道 renderer locale ⇒ 托盘先用英文默认值（实现时放弃了「首帧按系统语言判」：renderer 两秒内必然覆盖，不值得为此在 Rust 侧加 locale 探测），`I18nProvider` 在 `t` 变化时 `invoke("set_tray_labels", { open, quit, tooltip, hintTitle, hintBody })` 覆盖，切语言自动再调。
- **D6 图标**：Windows/Linux 用现有 icon；macOS 菜单栏用 `icon_as_template(true)`，需纯 alpha 单色图（22×22 @1x/@2x）——**先由现有 icon 转灰度占位**（构建期或资源目录加 `icons/tray-template.png`），用户后续出正式图替换。
- **D7 Linux 打包**：`tauri.conf.json` deb `depends` 加 `libayatana-appindicator3-1`、rpm 加 `libayatana-appindicator-gtk3`（与现有 `curl`/`lsof` 并列）。AppImage 是否内置该 `.so` 未知（`@tauri-apps/cli` 是编译二进制查不到）⇒ 靠 release CI 产物检查（见验收清单）。
- **D8 Windows webview 隐藏**：`CloseRequested` 里 `if cfg!(windows) { webview.hide() }`，唤回时 `show()`；mac/Linux 不需要（WKWebView / WebKitGTK 随窗口自动挂起）。

### 改动面

- `Cargo.toml`：`tauri = { features = ["tray-icon"] }`
- `tauri.conf.json`：deb/rpm depends；tray 图标资源
- `lib.rs`：`on_window_event`（CloseRequested）· `RunEvent::Reopen`（mac）· 托盘构建 + 菜单事件 · `set_tray_labels` 命令 · `restore_main_window` helper · `close_action` 纯函数 + 单测，约 150–200 行，全部集中在 `run()` 附近，**不碰 sidecar 生命周期代码**
- renderer：locale 就绪后一处 `invoke`（约 20 行），不改状态管理、不改 IPC 契约
- 文档：本文 · ADR-074 · gotchas §6「关窗口 == 退出」改写 · requirements · getting-started 加「`tauri dev` 关窗不退，Ctrl+C 退」

## 四、代价

| 项 | 量 |
|---|---|
| 实现 | 半天量级（Rust ~200 行 + renderer ~20 行 + 配置 2 处） |
| 资产 | 1 张 mac 模板图（占位灰度先顶） |
| 验证 | mac 真机约 2h（含 30min 隐藏 soak）；**Win/Linux 全部挂真机欠账**（托盘、任务栏消失、WebView2 隐藏后 CPU、GNOME 托盘可见性、AppImage 内置库） |
| 基线 | `cargo test` 155 → +3~5 |

## 五、副作用清单

**确定会发生（产品语义变化，已接受）**
1. **「关掉重开」不再是重启**：再开 = single-instance 唤回同一实例，sidecar 原样。真正重启要走托盘「退出」。ADR-071 自愈兜大部分；D1 的失败态直接退出也是为此。要写进 FAQ。
2. **常驻资源**：4 sidecar + WebView 在用户以为「关了」之后继续占几百 MB。对照产品接受了同样代价。
3. **升级/卸载遇到常驻进程**：NSIS 提示先关闭；mac 覆盖 `.app` 时旧进程跑旧二进制直到退出。
4. **renderer 生命周期从「小时」变「天」**：以前被退出掩盖的内存泄漏会可见 ⇒ 验收加隐藏 24h 内存曲线。
5. 开发流程：`tauri dev` 关窗不退，要 Ctrl+C（e2e harness 按 pid kill，不受影响）。
6. **通知点击不唤回窗口**（§二·9，确定）：mac 上只让 Dock 图标高亮，用户再点 Dock/菜单栏。

**可能发生、只能真机定**
7. 隐藏态定时器节流（WebView2 隐藏 5 分钟后链式 timer 降到 1/min；WKWebView 对齐 ≥1s）。已扫 renderer 定时器（`use-backend-liveness` 10s 探活、`use-session-permission` 3s 轮询、SSE 30s 心跳看门狗、`fetchWithTimeout`）全是「延迟触发」语义，节流只会变慢不会误判断线；SSE 是 fetch reader 不受 timer 节流。**这是推理，靠 soak 证实。**
8. D4 全屏→隐藏时序。
9. GNOME 无 AppIndicator 扩展时托盘创建成功但不显示（兜底 = 再启动一次）。
10. Windows toast 点击走 AUMID 拉起快捷方式 → 可能触发第二实例 → single-instance 唤回（若成立则 Windows 反而比 mac 好）。
11. 隐藏期间 sidecar 崩溃：断线 banner 没人看见，自愈失败时用户唤回才看到——可接受。

**确认不冲突**：Cmd+Q / `WM_ENDSESSION` / SIGTERM 三条退出路径都不经过 `CloseRequested`；`shutdown_sidecars()` 幂等；截图的 hide/show（`capture_screenshot`）与本方案共用 API 互不干扰。

## 六、验收清单

**mac 真机（本机可做）**
1. 关 X → 进程在、4 个 sidecar pid 与端口不变（`lsof -i :端口`）、Dock 图标在、菜单栏图标在。
2. 点 Dock / 菜单栏「打开」/ 再启动一次 → 窗口回来，会话状态、草稿原样（不重载）。
3. 最小化后点 Dock → 回来（`Reopen` 的 `has_visible_windows=false` 分支）。
4. 原生全屏下按 X → 退全屏并隐藏，无空 Space / 黑屏。
5. Cmd+Q / Dock 右键退出 / 菜单栏「退出」三条 → `[shutdown]` 日志、`lsof` 零残留、`ports.json` 已删。
6. **隐藏 30 分钟 + 活跃 IM 渠道 + 跑中会话** → IM 消息不丢、唤回后无断线 banner、会话结果完整（验 §五·7）。
7. 隐藏 24h 内存曲线（验 §五·4）。
8. 隐藏态收到通知：横幅弹、Dock 跳；点横幅确认为「只高亮不唤回」（记录，非缺陷）。
9. 启动失败态（可用 `ULTRAWORK_*` 指坏端口或删 sidecar 二进制制造）按 X → 直接退出。
10. `tauri dev` 下关窗不退，Ctrl+C 清理干净。

**CI / 产物（Win/Linux 本机做不了）**
11. 三平台 `cargo test` 绿（含 `close_action` 单测）。
12. 解 release CI 的 AppImage 看 `usr/lib` 是否含 `libayatana-appindicator3.so.1`；deb/rpm control 里 depends 已加。

**Win/Linux 真机欠账（并入 MEMORY 的 Windows 欠账批次）**
13. Windows：X → 任务栏消失、托盘在；托盘左键唤回；「退出」零残留；隐藏后任务管理器 WebView2 CPU 接近 0（验 D8）；首次隐藏气泡一次且仅一次；toast 点击行为（§五·10）；关机不被阻塞。
14. Linux（Ubuntu GNOME + 一个 KDE）：有/无 AppIndicator 扩展各一次；缺 `libayatana-appindicator3` 的环境启动不崩且关 = 退（验 D2）。

## 七、排除项（查证后不是问题）

- 只有一个 `main` 窗口，无对话框窗口 ⇒ 无多窗口计数问题。
- 无自动更新插件、无 `app.restart()` 使用。
- `titleBarStyle: Overlay` + 隐藏/唤回：窗口未销毁，位置尺寸原样。
- renderer 的通知决策显式不依赖 `document.visibilityState`（`notify-decide.ts`），隐藏态 `isFocused()=false` ⇒ 响铃与横幅按既有逻辑触发。

## 八、验证记录（2026-09-15，实现当天）

门禁：`cargo test` 155→**160**（`close_action` 平台矩阵 3 条 + `TrayLabels` 反序列化/默认 2 条）· desktop vitest 910→**917**（`tray-labels.test.ts`：三语言键完整性 + camelCase 载荷 + 无桥 no-op + 有桥 invoke + 拒绝吞掉）· typecheck 8/8 · `check-docs` 绿。

**mac 真机（`tauri dev`）**：全部用 AX 脚本驱动**原生**窗口（`System Events` 点 AXCloseButton / Dock 图标 / 菜单栏 status item / 键入 Cmd+W·Cmd+Q），断言取自 `pgrep`、`lsof -sTCP:LISTEN`、AX 窗口数、`com.apple.spaces` —— 不是看截图。

| # | 步骤 | 结果 |
|---|---|---|
| 1 | 点 X | app pid 不变、4 个 sidecar pid/端口不变、AX 窗口 1→0、日志零 `[shutdown]` ✅ |
| 2 | 点 Dock（`Reopen`） | 窗口回来、`frontmost` ✅ |
| 3 | Cmd+W → 菜单栏菜单 | 读到「打开 Ultrawork / 退出 Ultrawork」（中文 ⇒ renderer 已推文案）；「打开」唤回 ✅ |
| 4 | 最小化 → 点 Dock | `AXMinimized` true→false ✅ |
| 5 | 原生全屏 → Cmd+W | **初版（900ms 定时隐藏）手工过、门禁 3/3 红**：窗口以全屏态被藏起来，唤回后 `AXFullScreen=true`。改 styleMask 轮询又 3/3 红（位在退出开始就清）。改「只退全屏不隐藏 + 以 AppKit styleMask 为准 + 直接 `toggleFullScreen:` + 1.5s 静默期只拒绝不动作」后，门禁仍 ~50% 红：toggle 被吞、**连 AX 点绿色按钮都退不出，而键盘 ⌃⌘F 每次都行** ⇒ 怀疑尺子 ⇒ 换 CGEvent 真实鼠标点绿色按钮 + 真实 Cmd+W：**同步 toggle 8/8、推迟一 run loop 的版本 8/8** ⇒ 保留同步版。门禁改用真实输入后三轮 35/35 ✅ |
| 6 | Cmd+Q | `[shutdown] Killing` ×4、0 监听、`ports.json` 已删、1420 无 vite 孤儿 ✅ |
| 7 | 隐藏后再启动一次 | single-instance 唤回，`pgrep` 实例数 1 ✅ |
| 8 | 托盘「退出」 | 与 #6 相同的干净退出 ✅ |
| 9 | `python3 -m http.server 4096` 占端口制造 `BOOT_STAGE_FAILED` → 点 X | 2s 内退出、其余 sidecar 清理 ✅ |
| 10 | 隐藏 10 分钟 soak（无 IM 渠道） | 4 个 sidecar pid 不变；app RSS 95→77MB、CPU 0.1%；Dock 唤回后**无断线 banner**、会话列表/模型选择原样 ✅。⚠️ 两个尺子坑：① soak 期间改了一行 Rust ⇒ `tauri dev` 热重建静默换了实例（第一轮作废）；② 显示器睡眠后 AX 读到 `windows=0`、截图全黑，`caffeinate -u` 唤醒即正常 —— 别把它读成「唤回失败」 |

菜单栏图标实拍：立方体剪影按系统模板色渲染（深色菜单栏下为白）。

**门禁固化**：`scripts/verify-close-to-background-macos.sh`（35 条断言，含反向臂与全屏快速连按，三轮全绿）+ `scripts/macos-hid.swift`（CGEvent 真实输入）—— 尺子坑五条见 `docs/testing.md §14`。

**独立 code review（`/code-review high`）三条**：① Windows 合作式 `WM_CLOSE`（taskkill / 任务管理器 / 安装器）会被当成 X ⇒ 隐藏，随后强杀走既有孤儿自愈路径 —— Electron 同款语义，记入 ADR 后果；② 定时隐藏可被 0.9s 内的唤回打断后再次消失 —— 随 D4 改契约一并消灭；③ 非 mac 目标 `app_handle` 未用警告 —— 已修。

**未验（欠账，并入 MEMORY 的 Windows 批次）**：§六 #13–#14 全部 · 30 分钟带 IM 渠道 soak · 24h 内存曲线 · AppImage 内置库检查（release CI 产物）。

