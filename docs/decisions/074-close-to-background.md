# ADR-074：关窗口不退出 —— 隐藏到后台，托盘 / 菜单栏常驻，退出必须显式

- 状态：已接受（2026-09-15）
- 日期：2026-09-15
- 相关：discussions/061（现状事实 + 机制地基 + 完整方案 + 验收清单）· gotchas §6 · ADR-045（single-instance）· ADR-055（`setup()` 只放瞬时操作）· ADR-071（sidecar 自愈）· ADR-037（三平台默认）

## 背景

对照 QoderWork / WorkBuddy（均为 Electron）：mac 上点 X 只关窗口，进程与服务仍在。Ultrawork 点 X 是整个 app 退出、4 个 sidecar 全杀——三平台一致。

**这不是回归，是从未实现**：`run()` 只注册了 `RunEvent::Exit → shutdown_sidecars()`，没有 `on_window_event` / `Reopen` / 托盘；X 走 Tauri 默认「最后窗口销毁 → ExitRequested → Exit」链。gotchas §6 早有记录，discussions/002 §72 也列过待办。

对本项目它比对普通 app 更要紧：关窗口杀掉的是 gateway（IM bot 全体下线）、knowledge sidecar、跑到一半的 agent 会话。

## 决策

**统一规则**：X / Cmd+W / Alt+F4 → `prevent_close()` + 隐藏；退出只走 Cmd+Q（mac）/ 托盘·菜单栏「退出」/ 系统关机 / SIGTERM。**不加设置项**（对照产品没有；退出入口已够）。

| | macOS | Windows | Linux |
|---|---|---|---|
| X 后 | 隐藏，Dock 常驻 + 菜单栏图标 | 隐藏（任务栏消失）+ **webview 一起 hide** | 隐藏；托盘创建失败则退回关 = 退 |
| 唤回 | Dock（`Reopen`）/ 菜单栏 / 再启动 | 托盘左键 / 再启动 | 托盘菜单 / 再启动 |
| 首次隐藏提示 | 无 | 托盘气泡一次 | 托盘气泡一次 |

- **D1 关窗决策是纯函数** `close_action(os, tray_ready, boot_failed)`（`background.rs`，5 个单测）。`boot_failed` ⇒ Quit：引擎起不来没有值得常驻的东西，隐藏一个坏实例只会让「重开」（single-instance）拿到同一个坏实例。非 mac 且无托盘 ⇒ Quit：用户不能失去唯一可见入口。
- **D2 托盘只在 `setup()` 试建一次**，`catch_unwind` 包住（Linux 缺 `libayatana-appindicator3` 是 `panic!` 不是 Err），结果进 `TRAY_READY` 供 D1 读。deb/rpm `depends` 加对应包。
- **D3 `restore_main_window()` 一个 helper**（`unminimize → show → [Windows: webview.show] → set_focus`），single-instance / `Reopen` / 托盘左键 / 托盘菜单四处共用。
- **D4 macOS 原生全屏下的 X**：先 `set_fullscreen(false)`，900ms 后再 hide（Tauri 无 leave-fullscreen 事件）。真机实测无残留 Space。
- **D5 托盘文案跟随应用语言**：Rust 不读 renderer 配置 ⇒ 默认英文，`I18nProvider` 在 `t` 变化时 `invoke("set_tray_labels")` 覆盖（`lib/tray-labels.ts`，7 个单测钉住 camelCase 契约）。
- **D6 mac 菜单栏图标 = 从 app icon 按亮度切出的立方体剪影**（`icons/tray-template@2x.png`，`icon_as_template(true)`），占位直到有正式设计。
- **D7 Windows 隐藏时连 webview 一起 hide**：`window.hide()` 不碰 WebView2 的 `IsVisible`，否则隐藏后 Chromium 照常离屏合成。运行时 `cfg!(windows)` 分支，三平台同编译。

## 后果

**产品语义变化（已接受）**
- **「关掉重开」不再是重启**：再开 = 唤回同一实例。真正重启走托盘「退出」。ADR-071 自愈兜大部分；D1 的失败态直接退出也是为此。
- 常驻资源：4 sidecar + WebView 在用户以为「关了」之后继续占几百 MB（对照产品同样代价）。
- 升级/卸载遇到常驻进程（NSIS 提示先关闭；mac 覆盖 `.app` 时旧进程跑旧二进制直到退出）。
- renderer 生命周期从「小时」变「天」，以前被退出掩盖的泄漏会可见。
- `tauri dev` 关窗不退，Ctrl+C / Cmd+Q 结束。

**确定的限制**
- 通知点击不唤回窗口：tao 的 app delegate 没挂 `applicationDidBecomeActive`，`tauri-plugin-notification` 桌面端发完即忘。mac 上只让 Dock 高亮，用户再点 Dock / 菜单栏。
- GNOME 无 AppIndicator 扩展时托盘创建成功但不显示 ⇒ 兜底是再启动一次。

**不冲突（读源码确认）**：Cmd+Q（`terminate:` → `LoopDestroyed`）、Windows 关机（`WM_ENDSESSION`）、SIGTERM 都不经过 `CloseRequested`；`shutdown_sidecars()` 幂等；截图的 hide/show 与本方案共用 API 互不干扰。

## 验证

- `cargo test` 155 → **160**；desktop vitest 910 → **917**；typecheck 8/8；`check-docs` 绿。
- **mac 真机（`tauri dev`，全部用 AX 脚本驱动原生窗口，断言取自 `pgrep` / `lsof` / AX 窗口数）**：
  1. 点 X → app pid 与 4 个 sidecar pid/端口一个没变，AX 窗口数 1→0，日志零 `[shutdown]` ✅
  2. 点 Dock（`Reopen`）→ 窗口回来且前台 ✅
  3. Cmd+W 隐藏 → 菜单栏菜单读到「打开 Ultrawork / 退出 Ultrawork」（中文 = renderer 已推文案）→ 「打开」唤回 ✅
  4. 最小化 → 点 Dock → 反最小化 ✅
  5. 原生全屏 → Cmd+W → 0.5s 时已退全屏、1.5s 时已隐藏；`com.apple.spaces` 里无本 pid 的全屏 Space 残留；Dock 唤回后非全屏 ✅
  6. Cmd+Q → `[shutdown]` 杀 4 sidecar、0 监听、`ports.json` 已删、1420 无 vite 孤儿 ✅
  7. 隐藏后再启动一次 → single-instance 唤回，实例数仍 1 ✅
  8. 托盘「退出」→ 与 Cmd+Q 相同的干净退出 ✅
  9. 用外来进程占住 4096 制造 `BOOT_STAGE_FAILED` → 点 X 直接退出、其余 sidecar 清理 ✅
  10. 隐藏 10 分钟 soak（无 IM 渠道）→ 见 discussions/061 §六 记录
- **未验（真机欠账）**：Windows（托盘、任务栏消失、WebView2 隐藏后 CPU、toast 点击、关机不阻塞）· Linux（有/无 AppIndicator、缺库启动不崩）· AppImage 是否内置 appindicator `.so` · 30 分钟带 IM 渠道 soak · 24h 内存曲线。
