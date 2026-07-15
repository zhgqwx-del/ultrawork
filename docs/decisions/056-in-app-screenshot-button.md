# ADR-056：应用内截图按钮（借系统截图工具，不自绘框选）

- 状态：已接受（macOS 真机验收 A/B/C/D 全通过，含打包 `.app` 真身份下的 TCC 授权引导；**Windows/Linux 真机待验**）
- 日期：2026-07-15
- 背景讨论：`docs/discussions/039-multimodal-input-attachments.md` §4 P2 + §5（探针实测）
- 相关：ADR-037（跨平台）· ADR-054（`sys_cmd()` / Windows 闪窗）· ADR-055（启动前阻塞死锁教训）· gotchas §1/§6/§12

## 背景

P1 的粘贴已让「系统快捷键截图 → `Cmd+V`」完全可用（零权限、零平台代码）。P2 把截图做成输入框工具条上的一级剪刀按钮（对齐飞书/微信），只省用户一次快捷键，代价是三平台各一套原生代码 + macOS 的屏幕录制（TCC）授权引导。产品判断：现在做、三平台都做。

## 决策

- **D1 借系统截图工具，不自绘框选覆盖窗口。** 多显示器 / HiDPI / Esc 取消系统工具全都自带，且是用户已熟悉的交互；自绘（xcap + 冻屏 overlay）要 +2~3d 且得自己处理这些。
- **D2 产出字节复用已建好的 `add(File[])` 管道**（读临时 PNG → `File` → `add` → `discard_temp_file`），不另起炉灶——降采样、模型能力门控、单轮预算全部继承。三平台统一返回契约：成功都落一个临时 PNG 路径 + `{outcome: captured|cancelled|needs_permission|unavailable}` 枚举。
- **D3 macOS：`screencapture -i -x`。** 必须先 `CGPreflightScreenCaptureAccess()` 门控——未授权直接返回 `needs_permission`、**绝不 spawn**（否则静默截出壁纸假图，退出码还是 0）；未授权时 `CGRequestScreenCaptureAccess()` 一键拉起系统框，授权后 macOS 要求**重启**才生效（做引导态而非假装能立即用）。成功信号 = 授权已过闸 **且** 文件非空，**绝不看退出码**（探针实测退出码恒 0，看它必假绿）。CoreGraphics FFI 用 `#[cfg(target_os="macos")]` module 双定义（符号在 Win/Linux 不存在，无法运行时分支——ADR-037 的合法 FFI 例外），业务门控逻辑留在命令的运行时 `if cfg!` 分支保持可 `cargo check`。
- **D4 Windows：`ms-screenclip:`** 经 `tauri-plugin-opener` 的 Rust API 唤起（**不能** `cmd /c start`——ADR-054 闪窗 + 元字符注入）；它只写剪贴板 ⇒ `clipboard-manager` 读图 + 指纹变化有界轮询（60s）+ `png` crate 编码回文件。**抢到冻结快照后即恢复窗口**——Windows 唯一取消信号是轮询超时，否则取消一次截图主窗会隐藏满 60s（像卡死）。运行时行为无 Windows 真机不可验（探针 4，并入欠账）。
- **D5 Linux：** 按序 PATH **纯扫描**探测 `gnome-screenshot / spectacle / grim+slurp / import`，都没有则**按钮禁用 + 提示用系统快捷键**；**不给 deb/rpm 加 depends**（gotchas 教训：假设工具存在会致静默降级）。
- **通用硬约束：** 所有 `Command::new` 走 `sys_cmd()`（ADR-054 源码守卫）；hide→capture→show 在事件循环**运行后**的 command 里执行（非 ADR-055 的启动前阻塞，无死锁）；capture 前 `remove_file` 目标路径（防 pid 复用下陈旧 PNG 被「文件非空」误判为新截图）；「截图时隐藏窗口」开关默认开、localStorage 持久化。

## 验证

- desktop **585** 测试 · Rust **142** 测试 · typecheck 全绿；`discard_temp_file` 守卫与关键修复经 A/B 证伪。
- **两轮对抗审查抓 6 个真缺陷全部修复重验**（Windows 60s 隐藏窗、mac/linux 陈旧 PNG 误判、Linux `#[cfg]` 违反 ADR-037、capability 过度授权、`add` 未 await、hook 返回值未 memo）。
- 硬编码审计干净（`temp_dir()` 非 `/tmp`、无 dev 路径、全 `sys_cmd()`）→ 可在客户机正常工作。
- **macOS 真机 A/B/C/D 全过**：A 主路径（截图→缩略图→发送→模型看见）· B 授权引导（打包 `.app` 真身份下 `去授权` 弹系统框）· C 隐藏窗口开关持久化 · D 边界（Esc 取消/多张/Team 置灰）。

## 教训（已固化到 gotchas §12）

- **byte-scan 不能当「命令是否注册」的 oracle**：Tauri 打包把 webview 资源压缩嵌入，命令名 `grep` 不到 ≠ 没注册；命令注册是**编译期保证**。曾据此误判「release 把命令 strip 了」并做了无效"修复"，被打包 .app 上的真实 B 流程当场证伪。
- **`tauri dev` 借的是终端的 TCC 身份**：dev 二进制无独立身份，屏幕录制权限归到父进程（终端）。所以 TCC 类功能**必须打包成 `.app` 从 Finder/Dock 启动**才测得准，从 dev 里测的是终端的权限。

## 非目标

P3（IM 渠道入站图片，仍静默丢弃）· 出站发图 · ACP/Team 会话附件。
