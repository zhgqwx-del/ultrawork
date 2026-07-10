# ADR-046: Windows WebView2 运行时依赖 —— 双安装包 + 恢复 MSI + 首启自检 + 最低 Win10 1803+

- 状态：Accepted（✅ 已实现 + CI 实证 2026-07-10；Windows 真机验收待做，见 §已知边界）
- 日期：2026-07-10
- 关联：discussions/030（尽调与拍板 SSOT）· ADR-037（跨平台三平台约束）· ADR-041（内置技能 zip 分发 —— MSI 复活的前提）· ADR-045（动态端口 —— Windows 真机验证欠账可合并）· discussions/009（Tauri vs Electron）· gotchas §6（首启自检）/ §12（打包坑）· conventions §13

## 背景

Windows 不随 app 带 webview——二进制链接系统的 Evergreen WebView2 运行时。项目从未配置 `bundle.windows`，因此吃的是 Tauri 默认 `webviewInstallMode = downloadBootstrapper`：安装时联网下载 bootstrapper 再执行。这暴露三个问题：

1. **安全**：`downloadBootstrapper` 在 NSIS 侧由 `NSISdl.dll` 实现，而该插件**零 TLS 能力**（导入表只有 WSOCK32、字符串 `GET %s HTTP/1.0`），`httpget.cpp:337` 忽略 URL scheme 一律连 :80。实测微软 fwlink 会 301 到 `https://msedge.sf.dl.delivery.mp.microsoft.com/...`，而该 CDN 在明文 80 端口照样返回真实 PE（1,688,792B）→ 安装期「明文下载 exe + 零校验 + `ExecWait` 执行」。Win11 预装 WebView2 使这段代码在多数机器上不执行，故一直未被发现。
2. **可用性**：缺 runtime 且缺网/慢网的机器装不上（国内尤甚——真正慢的是 bootstrapper 内部去拉的 ~176MB runtime，我们干预不了）。
3. **韧性**：安装器管不到「装完之后用户/组策略卸了 WebView2」（clash-verge-rev#1150 形态），缺 runtime 时应用启动即 abort、且 release 构建无控制台 → 表现为「双击没反应」。

尽调（discussions/030）另有两条反直觉结论：**装 runtime 不需要重启电脑**（微软文档只要求重启 app 进程）；**「国内下载源」是伪命题**——七大镜像站均无 WebView2，且许可 2(b)(iii) 要求「必须直接从微软获取」，正解是把 runtime 打进安装包（2(a)(i) 明确允许）而非换源。同类 AI agent 产品（hermes/qoder/manus/cowork）无一 Tauri，最强参照是中文 Tauri 项目 Clash Verge Rev / pot-desktop 的「embed 主包 + offline 兜底」范式。

## 决策

1. **D1 双安装包**：Windows 产出两个 NSIS 安装器——
   - `*-setup.exe`（`embedBootstrapper` + `silent`，129MB 实测，默认）：内嵌 1.8MB bootstrapper，消除问题 1 的明文下载执行；装机时仍联网拉 runtime。
   - `*-offline-setup.exe`（`offlineInstaller`，324MB 实测）：内嵌完整 runtime，**安装期零网络**，给国内/内网/受控机器。
2. **D2 恢复 MSI**（embed 一种）：企业 SCCM/Intune 部署诉求。**不出 offline MSI**（embed MSI 已 187.6MB、比 NSIS 胖 58MB，offline MSI 会到 ~380MB，不值）。
3. **D3 最低 Windows 10 1803+**：正式放弃 Win7/8.1（其 WebView2 冻结在 `109.0.1518.140`，2023-10-10 起停安全更新）。
4. **首启运行时自检**：`main()` 里、`tauri::Builder` 之前用 `tauri::webview_version()` 检测，缺失弹 `rfd` 引导框到微软官网下载页（微软官方推荐的兜底之一），再 `exit(1)`。覆盖问题 3。

## 关键实现约束（踩过的坑）

- **NSIS 产物名写死**：`nsis/mod.rs:652` 硬编码 `{product}_{ver}_{arch}-setup.exe`，两次 `tauri build --bundles nsis` 会静默覆盖。`build-release.ts` 的 `buildWindowsInstallers()` 先出 embed+msi、临时改名 `.embed-stash`、再出 offline 改名 `-offline-setup.exe`、恢复 embed 名。构建顺序 embed 先 offline 后——offline 是最脆的一步（见下），可靠的先落地。
- **`webviewInstallMode` 配错不报错**：只静默退回默认行为，唯一症状是包变小（同 v0.2.2 DMG 布局那类）。末尾 fail-closed 断言 offline 比 embed 大 ≥100MB（实测差 195MB）。
- **构建期下载的 URL 前缀断言**：embed/offline 把微软下载从安装期搬到**构建期**，`tauri-bundler/util.rs` 的 `webview2_guid_path()` 每次构建先 HEAD fwlink、再 `strip_prefix` 断言重定向落在硬编码 CDN 主机——而 `delivery.mp` 是地域均衡主机族，**国内本机构建最易触发 `WebView2 URL prefix mismatch`**。逃生口=预置安装器到 `%LOCALAPPDATA%\tauri`（缓存判据只是「文件存在」）。offline 构建失败已翻译成指向该逃生口的可读提示。
- **检测免 winreg**：`tauri::webview_version()` 是独立自由函数、不需 `AppHandle`、三平台都能编译（合 ADR-037 运行时 `cfg!` 偏好），Windows 上静态链接 loader、不需 COM/消息循环，进程早期调用安全返回 `Err`。
- **rfd 依赖**：作 windows-only 依赖 `default-features = false`（默认 features 是 Linux 专用，会拖进 17 个 crate）。`common-controls-v6` 由 `tauri-plugin-dialog` 全局 union 强开、下游关不掉，故实走 `TaskDialogIndirect`——用 `MessageButtons::YesNo`（两条后端都成立）。

## 后果

- **正向**：明文下载执行链路消除；国内/内网有零网络安装路径；企业有 MSI；装完卸载 WebView2 的机器有友好引导而非「双击没反应」。体积代价对我们特别小——包本就 127MB（四 sidecar），embed +1.8MB 白送，offline 到 324MB 也只在 DMG（228MB）量级之上一截。
- **负向 / 已知代价**：见 §已知边界的供应链一条。
- **CI 实证（2026-07-10）**：三轮 release workflow_dispatch 全绿；Windows job 打印 `📏 129.2MB / 324.4MB (+195.2MB) · WebView2 offline runtime ✓`；下载 artifact 开包验证三产物齐全、bootstrapper（1,688,792B，与微软 CDN 实测字节一致）确被嵌入；MSI 探针独立验证 187.6MB msi 可出。

## 已否决的替代方案

- **自建 WebView2 镜像 / 从第三方镜像取包**：许可 2(b)(iii)「必须直接从微软获取」冲突；且现实中七大镜像站均无。
- **`fixedVersion` 作主包**：微软明确推荐 Evergreen；固定版本拿不到安全更新 = 长期债；+180MB。仅适合二期兜底旁路包。
- **安装器内做 IP 归属地探测 / 多源赛马选源**：NSIS 单线程无真并发（`inetc` 多 URL 只是顺序 fallback、超时累加）；且内置 runtime 之后没有源可选。
- **「安装后请重启电脑」提示**：不需要（微软文档只要求重启 app 进程），且吓用户。

## 已知边界

- **供应链（本次引入的代价，待跟进）**：embed/offline 让 `tauri-bundler` 在构建期用不校验哈希的 `download()`（HTTPS 但不 pin）拉微软 exe 打进包；且 Windows 安装包**尚未代码签名**（`release.yml` 只签 macOS）。两者叠加是「构建机 MITM/投毒 → 全体用户」的面。P0 修掉了更常发的「用户机明文下载」，但净防御取决于构建环境可信度。缓解路径：给构建期 exe 加哈希 pin（预置已知哈希文件走逃生口顺带当锚点）+ 上 Windows 代码签名证书。**待专项决策。**
- **Windows 真机验收未做**（CI 只保证编译 + 打包，不跑安装/运行）：discussions/030 §12 九项——尤其抓包实证 §3 明文 HTTP（把「源码推理」升级成「确证」）、断网装 offline 包、LTSC/Server 环境、缺 runtime 弹引导框而非 panic、跨变体覆盖升级。建议与 ADR-045 的 Windows 真机欠账合并一次。
- **Windows ARM64 不处理**：只构 x64；`download_webview2_offline_installer` 也只有 X86/X64 常量。ARM 设备走 x64 模拟。
