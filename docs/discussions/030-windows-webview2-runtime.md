# 030 — Windows WebView2 运行时依赖（缺失场景 / 分发形态 / 国内网络）

> 状态：**✅ 已拍板待开工**（2026-07-10 三项决策已定：D1=双包 · D2=恢复 MSI · D3=最低 Win10 1803+ → 待正式化为 ADR-046）
> 日期：2026-07-10
> 输入：用户提出——Windows 下安装/运行是否依赖 WebView2？客户机器上操作系统或浏览器版本较旧、没有 WebView2 会怎样？能否在安装流程里检测并下载安装（注意国内下载源）？装完是否要重启？同类桌面 agent 软件（hermes agent / qoderwork / manus ai / claude cowork）怎么做？
> 关联：ADR-037（跨平台三平台约束）· ADR-041（内置技能 zip 分发，MSI 禁用理由的来源）· ADR-045（动态端口，Windows 真机验证欠账可合并）· discussions/009（Tauri vs Electron）· gotchas §6（Tauri/桌面壳）· §12（跨平台）
> 范围：① Windows 侧 WebView2 依赖现状审计；② 缺失时的真实行为；③ 四种 `webviewInstallMode` 的取舍；④ 国内网络与许可合规；⑤ 同类产品横向对照；**不含** 迁移 Electron（正交议题，见 discussions/009）、Linux WebKitGTK 依赖（deb/rpm 已声明 depends）。

---

## 0. 一句话

**依赖成立，且当前配置比想象的更脆也更脏**——我们从未配置过 `bundle.windows`，因此吃的是 Tauri 默认的 `downloadBootstrapper`；它在 NSIS 侧由 `NSISdl.dll` 实现，而该插件**没有任何 TLS 能力**，会把微软的 HTTPS 重定向静默降级为**明文 HTTP 80 端口**下载一个 exe，然后不做任何哈希/签名校验就执行它（§3）。

但真正反直觉的是另外两条：**(a) 用户担心的「重启电脑」根本不需要**（§5）；**(b) 用户担心的「国内下载源」是个伪命题——正解不是换源，而是不下载**（§6）。真正该做的是把 runtime 打进安装包（许可明确允许），并把**我们自己的安装包**放到国内 CDN（我们自己的产物，100% 合规）。

顺带发现一个与本议题无关的现网欠账：**MSI 被禁用的理由大概率已经随 ADR-041 失效**（§9.2）。

---

## 1. 现状盘点

| 事实 | 出处 |
|---|---|
| **无 `bundle.windows` 配置段** → `webviewInstallMode` = 默认 `downloadBootstrapper` + `silent: true` | `packages/client/desktop/src-tauri/tauri.conf.json`（全文 60 行，`bundle` 段只有 `linux`/`macOS`） |
| Windows **只出 NSIS `-setup.exe`，MSI 被刻意禁用** | `scripts/build-release.ts:64-70` |
| `nsis.installMode` 未设 → 默认 `CurrentUser` → `RequestExecutionLevel user`（**非管理员**） | `NSISInstallerMode` 的 `Default` impl |
| v0.2.2 实际产物：`Ultrawork_0.2.2_x64-setup.exe` = **127MB**；对照 DMG 228MB | `gh release view v0.2.2` |
| Tauri 版本 `2.10.3` / wry `0.54.2` / webview2-com `0.38.2` | `src-tauri/Cargo.lock` |

只出 NSIS 是**好运气**：NSIS 是 Tauri 里 WebView2 支持最完整的路径。MSI 侧官方明说 `downloadBootstrapper` 在 Windows 7 上不工作。

> ⚠️ `build-release.ts:64-67` 禁用 MSI 的注释理由是「ppt-master 资源树 12k files / 深 icon 路径让 WiX `light.exe` 挂掉（CI 实证 2026-07-02）」。**ADR-041 已把该资源树压成 zip（4 个文件）**，此理由大概率已失效——见 §9.2。

---

## 2. 缺 WebView2 时到底会发生什么

**不是"装完白屏"，而是"装不上"。** Tauri 的 NSIS 模板里：

```
Section EarlyChecks   (527)
Section WebView2      (546)   ← 在 Install 之前
Section Install       (638)
```

`Section WebView2` 先读注册表判断是否已装：

```nsis
${If} ${RunningX64}
  ReadRegStr $4 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
${Else}
  ReadRegStr $4 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{...}" "pv"
${EndIf}
${If} $4 == ""
  ReadRegStr $4 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{...}" "pv"
${EndIf}
```

缺失则下载/释放 bootstrapper，`ExecWait "$6 /silent /install" $1`，**退出码非 0 → `Abort "Failed to install WebView2! The app can't run without it."`**。

因为 `Section WebView2` 排在 `Section Install` 之前，中止时**主程序一个文件都不会落盘**。失败是干净的——这一点比预期好。

只有把 mode 设成 `skip` 才会出现"装得上、启动崩"的坏形态。我们没设，所以不是这种。

### 2.1 装完之后仍可能缺失

安装器管不到的窗口：用户事后卸载 Edge WebView2（Clash Verge Rev #1150 真实发生过）、企业策略移除、Ghost 精简镜像。这类只能靠**应用侧首启自检**兜底（§7 P0-2）。

---

## 3. ⚠️ 默认模式在明文 HTTP 上下载并执行 bootstrapper

**本节结论未在任何公开渠道见到报告，系源码 + 实测自行推导。证据链完整，但仍需真机抓包实证（§8-2）。**

四步证据：

1. **NSISdl 没有 TLS 能力。** Tauri 工具链固定拉取 `tauri-apps/binary-releases` 的 `nsis-3.11.zip`（`tauri-bundler/src/bundle/windows/nsis/mod.rs:38`）。解包检查其 `Plugins/x86-unicode/NSISdl.dll`：导入表只有 `WSOCK32.dll` / `KERNEL32.dll` / `ADVAPI32.dll` / `USER32.dll`——**无 `wininet` / `winhttp` / `schannel` / `secur32`**。字符串里是 `GET %s HTTP/1.0`。该 zip 内也**不含** `inetc.dll` 或 `NSCurl.dll` 等有 TLS 的下载插件。

2. **NSISdl 会跟随重定向，但完全忽略 scheme。** 源码 `Contrib/NSISdl/httpget.cpp`：

   ```c
   /* httpget.cpp 行 443 —— 处理绝对 URL 形式的 Location */
   if (newloctype == GLT_ABS)
   {
     // A scheme we don't understand, let connect deal with it.
   }
   ...
   /* httpget.cpp 行 303 —— do_parse_url()：scheme 被跳过，不参与任何决策 */
   if (strstr(url,"://")) np=p=strstr(url,"://")+3;
   ...
   /* httpget.cpp 行 337 —— 没有显式端口就一律 80 */
   } else *port=80;
   ```

3. **微软的 fwlink 恰好会重定向到 https。** 实测（2026-07-10）：

   ```
   $ curl -I http://go.microsoft.com/fwlink/p/?LinkId=2124703
   HTTP/1.1 301 Moved Permanently
   Location: https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/<hash>/MicrosoftEdgeWebview2Setup.exe
   ```

4. **该 CDN 在明文 80 端口照样供包。** 实测：

   ```
   $ curl -I --http1.0 http://msedge.sf.dl.delivery.mp.microsoft.com/.../MicrosoftEdgeWebview2Setup.exe
   HTTP/1.1 200 OK
   Content-Length: 1688792
   $ curl --http1.0 -r 0-3 <同上> | xxd
   00000000: 4d5a 9000    MZ..        ← 真实 PE
   ```

**合起来**：`NSISdl::download "https://go.microsoft.com/..."` → 明文 GET :80 → 301 → 跟到 `https://msedge...` 但仍连 :80 → 明文拿到真 exe → `ExecWait` 执行，**全程无哈希校验、无签名校验**。

所以它"能用"（这正是从没人发现的原因——Win11 预装 WebView2，这段代码根本不执行）。代价是安装期的**明文下载 + 直接执行**：敌意网络（公共 WiFi、被投毒的路由/网关）可替换该 exe 获得代码执行。

**严重性定级**：因 `installMode=CurrentUser`，安装器以用户完整性运行，`ExecWait` 继承之 → 是**用户级** RCE，不是 SYSTEM/管理员级。降一档，但仍是安装期 RCE。若将来把 `installMode` 改成 `perMachine`/`both`，严重性直接升到管理员级。

**修法**：`embedBootstrapper`，+1.8MB，把这一跳彻底删掉（bootstrapper 由安装包内释放，其后续下载走微软自己的 WinHTTP + HTTPS）。**无论后续怎么选，这一步都该做。**

补充观察：NSISdl 字符串里有 `ProxyEnable` / `ProxyServer` / `/NOIEPROXY` / `Proxy-Authorization: Basic`——它会读 IE 系统代理。企业代理场景可用，但不支持 SOCKS / PAC。

---

## 4. ⚠️ 国内慢的瓶颈**不在**我们下载的那 1.6MB

Bootstrapper 实测只有 **1,688,792 字节**。真正慢的是**它自己接着去 `delivery.mp.microsoft.com` 拉 ~176MB 的完整 Runtime**——那一步在微软的 exe 内部，我们**不能换源、不能加重试、不能测速**。

> **推论（反直觉，且是社区常见误选）**：`embedBootstrapper` 对"国内下载慢"**几乎毫无帮助**，它只省掉 1.6MB 那一跳。

只有 `offlineInstaller` / `fixedVersion` 把 runtime 装进包里，才能让安装期**零网络**。

关于国内可达性（调研结论，来源为微软官方 endpoint 清单 + 中文社区反馈）：
- 不是被墙，是**慢/不稳**——恰好足以让在线安装超时失败。
- `go.microsoft.com` 只发 301、载荷极小，一般可达；真正下字节的 `*.dl.delivery.mp.microsoft.com` 吞吐差。
- 「delivery.mp 走世纪互联」的说法**大概率是错的**（混淆了微软中国主权云）；「部分边缘由网宿承载」可能为真但无硬证据。

---

## 5. 「装完要重启电脑吗」——不需要

权威结论：**安装 Evergreen Runtime 不需要重启操作系统。**

- 微软 distribution 文档描述的在线/离线两条工作流，全程**未提 OS 重启**。
- 文档中唯一提到"重启"的地方是 runtime **更新**之后：`The client uses the new version of the WebView2 Runtime when your WebView2 app is restarted` —— 重启的是**应用进程**，不是电脑。
- 社区里"WebView2 安装要求重启"的案例，微软 Q&A 明确答复：直接运行 WebView2 的 exe 不需要重启；重启是 **InstallShield 等第三方打包框架自身**的行为。

**因此：不要在安装完成页加"请重启电脑"提示。** 纯属吓用户，且不真实。我们的 NSIS 完成页直接 "Run Ultrawork" 即可。

per-machine vs per-user（影响 UAC）：
- 提权进程运行 installer → per-machine；非提权 → per-user。我们是 `CurrentUser`，所以**默认 per-user，不弹 UAC**。
- 但微软文档注明：若机器上已存在 per-machine 的 Edge Updater（装了 Edge 就有），per-user 安装会**被 per-machine 安装替换**——这一步需要提权，可能触发 UAC。属预期内。

---

## 6. 「国内镜像源」是伪命题：许可 + 现实双重否定

### 6.1 现实：没有镜像

逐个核验（2026-07-10）：阿里云 / 腾讯云 / 华为云 / USTC / 清华 TUNA / 南大 NJU / npmmirror ——**全部没有** WebView2 Runtime 镜像。它们定位是开源软件镜像，不托管微软专有 Windows 运行时（npmmirror 的 `-/binary/` 下只有 `edgedriver`，那是自动化驱动，不是运行时）。

国内能搜到的全是 CSDN / 脚本之家 / 精易论坛之类的**个人转载**，完整性与篡改风险不可控。

微软也**只给 Bootstrapper 一个稳定 fwlink**（`LinkId=2124703`）；Standalone Installer 和 Fixed Version 都是**按版本 hash 轮换的一次性 URL**，没有常青链接（社区 WebView2Feedback #3287 提过，至今没有）。这本身就否掉了"我们自己定时同步一个镜像"的低成本方案。

### 6.2 许可：明确禁止从第三方取包

WebView2 Runtime 的 License Terms（关键三条）：

| 条款 | 原文要点 | 对我们的含义 |
|---|---|---|
| **2(a)(i)** | `You may copy and distribute the object code of the software` | **随我们的应用分发 runtime = 明确允许** |
| **2(b)(iii)** | `You must acquire all code, including any code obtained from a Microsoft URL, directly from Microsoft` | **从任何第三方镜像取包再打进安装器 = 违规** |
| **2(c)(iii)** | 禁止 `provide any Microsoft download sites or shortcuts that provides access to this software to a third party` | 不能把微软下载链接/快捷方式转手给第三方 |

自建 OSS 托管一份 runtime 副本处于**灰区**：2(a)(i) 允许复制分发，但整个授权是围绕"随你的应用一起分发"设计的（2(b)(i) 还要求"add significant primary functionality"）。**不值得冒这个险，因为有一条白纸黑字允许的路。**

> 注：条款字面推断，非法律意见。若要写进正式合规文件建议法务复核。

### 6.3 正解：不下载，直接内置

把 runtime 打进我们自己的安装包 = 2(a)(i) 明确允许 + 安装期零网络 + 零 MITM 面。**"国内下载源"这个问题被整体消解掉。**

### 6.4 真正的国内瓶颈：GitHub Releases 本身

我们的安装包已经 127MB，从 GitHub Releases 下载在国内本来就痛苦；offline 变体 324MB 只会更痛苦。

**但我们自己的安装包是我们自己的产物，托管到国内对象存储 / CDN 100% 合规。** 这件事的收益大于折腾 WebView2 的源。属分发渠道议题，本讨论只记录，不展开。

---

## 7. 同类产品横向对照

用户点名的四个产品**没有一个是 Tauri**：

| 产品 | 技术栈 | 依赖 WebView2 | 可信度 |
|---|---|---|---|
| Hermes Agent (Nous Research) | Electron | 否 | ✅ 确证（`apps/desktop/electron/main.ts`） |
| Qoder | Electron / VSCode fork | 否 | 强推测 |
| Manus AI | 未知 | — | ❌ **未找到公开证据** |
| Claude Cowork | Electron（沿用 Claude Desktop 壳） | 否 | 强推测 |
| Cursor / Claude Desktop / ChatGPT Desktop / Cherry Studio / LM Studio / Ollama | 全 Electron | 否 | ✅ 确证 |
| Dify | 无官方桌面客户端 | N/A | ✅ 确证 |

Electron 自带 Chromium，**根本没有这个问题**。所以拿它们做参照几乎没有信息量——除了一条最有分量的反证：

> **Chatbox 原本用 Tauri，后主动迁回 Electron**，公开理由正是「Tauri 过度依赖用户 OS 的 WebView 运行时，生产环境不稳定不可靠」（`chatboxai/chatbox` PR #1428）。

这条与 discussions/009 §触发迁移条件 (a) 直接对应，应回填该文档。

### 7.1 真正的参照：中文 Tauri 项目

**Clash Verge Rev 与 pot-desktop 的范式高度一致**：

> 主包 `embedBootstrapper` + `silent`；CI **额外产出一个 `fixedVersion` 兜底包**给实在装不上的用户；README/FAQ 双指引。**不把主包整体做成 180MB。**

其它样本：`lencx/ChatGPT` = `embedBootstrapper`；GitButler / Kunkun = 未设置（默认 `downloadBootstrapper`）。

定性结论：**多数项目不写该字段；在意慢网/内网/老系统的项目倾向 `embedBootstrapper`；`fixedVersion` 几乎只作旁路兜底包。**

---

## 8. 体积算术：我们的权衡与常规 Tauri 项目**完全不同**

社区纠结的是「+127MB 会让 5MB 的包变成 132MB」。**我们的包已经 127MB 了**（四个 sidecar 撑的），mac 侧 DMG 更是 228MB。

| 模式 | 增量 | 我们的 setup.exe | 安装期联网 | 备注 |
|---|---|---|---|---|
| `downloadBootstrapper`（现状） | +0 | 127MB | **需要**（且明文，§3） | 默认值 |
| `embedBootstrapper` | +1.8MB | **129.2MB**（实测） | **需要**（bootstrapper 拉 176MB） | 修掉 §3，不解 §4 |
| `offlineInstaller` | **+195MB**（实测） | **324.4MB**（实测） | **不需要** | 解 §3 + §4 |
| `fixedVersion` | +~180MB（文档估） | ~307MB | 不需要 | 无安全更新，见 §10 |

> embed / offline 两行是 2026-07-10 CI 实测（下载 artifact 量得）；offline 实际比文档说的 +127MB 大得多（**+195MB**，NSIS 对 176MB 的 runtime 再压也有限），断言阈值 100MB 以巨大余量通过。fixedVersion 未实测。

**+1.8MB 对我们是白送。+195MB 也只是把包做到 DMG（228MB）之上一截。** 这个不对称是本方案的核心依据。

---

## 9. 方案

### 9.1 分期

**P0 —— 立刻做，成本极低**

1. **`webviewInstallMode` → `embedBootstrapper` + `silent: true`**（新增 `bundle.windows` 段）。消除 §3 的明文 HTTP 下载执行；顺带修掉 Win7 TLS 1.2 问题（虽然我们已放弃 Win7，见 D3）。
2. **Rust 侧首启自检 + 友好引导**。必须在 `main()` 最开头、`tauri::Builder` 之前检测——否则建 webview 直接 panic，拿不到窗口来弹提示。
   - 检测：注册表 `EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`（HKLM 的 `WOW6432Node` + HKCU 两处；`pv` 为空或 `0.0.0.0` 视为未装），或调 `GetAvailableCoreWebView2BrowserVersionString`（返回 null 即未装）。
   - 缺失 → 原生 `MessageBoxW` 引导到微软官网。
   - 覆盖 §2.1（事后卸载 / 策略移除）——安装器管不到的窗口。
   - 跨平台：整段 `if cfg!(target_os = "windows")` 运行时分支（ADR-037 / conventions §13）。

**P1 —— 解决国内 + 企业**

3. **CI 增出 offline 变体**：`Ultrawork_x.y.z_x64-offline-setup.exe`（`offlineInstaller`，~324MB，安装期零网络）。
   - 实现：Windows 上跑两次 `tauri build --bundles nsis`，第二次用 `--config` 覆盖 `webviewInstallMode`。cargo 有缓存，主要开销是重新打包。
   - `release.yml` 的 artifact / release assets 两处 glob 需加该文件名。
4. **恢复 MSI**（D2）。先在 CI 上验证 §9.2 的假设。
5. **安装包托管国内 CDN**（§6.4）。属分发渠道议题，本讨论不展开。

### 9.2 恢复 MSI 的前置验证

`build-release.ts:64-70` 当前：

```ts
// Windows: NSIS only. WiX v3 (MSI) light.exe fails outright on the
// ppt-master resource tree (12k files / deep icon paths, CI-proven
// 2026-07-02: "failed to run ...WixTools314\light.exe"); NSIS packs the
// same tree fine and *-setup.exe is the primary installer anyway.
```

**该理由大概率已失效**：ADR-041（2026-07-03）把 builtin-skills 从 12k 松散文件改成**单个 zip**，Resources 降到 4 个文件 / 10MB。注释的日期（07-02）恰好在 ADR-041 之前一天。

> **✅ 已实证（2026-07-10）**：在一次性分支 `chore/msi-probe` 上把 `--bundles nsis` 改成 `nsis msi`，`workflow_dispatch` 跑 release.yml，**Windows job 全绿且真的产出了 MSI**：
>
> ```
> Ultrawork_0.2.2_x64-setup.exe    129.18 MB
> Ultrawork_0.2.2_x64_en-US.msi    187.61 MB
> ```
>
> 假设成立，D2 落地。**顺带一个未预料的数据点：MSI 比 NSIS 胖 58MB**（同样载荷，WiX cabinet 的压缩率明显不如 NSIS 的 LZMA）。这加固了 §9.3-C 的决定——offline MSI 会到 ~380MB 量级（embed MSI 已 187.6MB），不值得。
>
> 注：`upload-artifact` 是 `if-no-files-found: warn`，所以「job 绿」不等于「出了 msi」，上面的体积是下载 artifact 开包量到的。

**MSI 的 WebView2 连带约束**：MSI 侧 `downloadBootstrapper` 走 PowerShell `Invoke-WebRequest`，官方明说在 Win7 上不工作。我们既然统一改 `embedBootstrapper`，MSI 与 NSIS 行为一致（都走 CustomAction / ExecWait 跑包内 exe），无额外风险。

> 澄清一个常见误解：「MSI 中不能嵌套调用另一个 MSI」（`_MSIExecute` 互斥）确实是真实的 Windows Installer 限制，但 **Tauri 不触发它**——WebView2 的 bootstrapper 和离线安装器都是 `.exe`（自解压），WiX 模板用 CustomAction 调 EXE 而非 `msiexec` 嵌套 MSI。

### 9.3 实现级约束（开工前补充，2026-07-10）

拍板之后逐条核 `tauri-bundler` 源码，发现五处方案原稿未覆盖、会在实施期才暴露的约束。

#### (A) ⚠️ embed / offline 把微软下载从「安装期」搬到「构建期」——引入**新的 CI 失败模式**

`downloadBootstrapper`（现状）在构建期**零网络**。改成 embed / offline 之后，`tauri build` **自己**要去微软拉包：

```rust
// crates/tauri-bundler/src/bundle/windows/util.rs:51 / :59
pub fn download_webview2_bootstrapper(base_path: &Path) -> Result<PathBuf>
pub fn download_webview2_offline_installer(base_path: &Path, arch: &str) -> Result<PathBuf>
```

三个连带事实：

1. **无哈希校验**：用的是 `download()` 而非 NSIS 工具链那套 `download_and_verify(url, sha1, ..)`。构建期走 HTTPS（`ureq`），但不 pin 哈希。
2. **URL 前缀被硬编码，且会因地域解析不同而炸**：

   ```rust
   // util.rs:22
   pub const WEBVIEW2_URL_PREFIX: &str =
     "https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/";
   // util.rs:webview2_guid_path() —— 先 HEAD fwlink，再 strip_prefix，不匹配就:
   //   "WebView2 URL prefix mismatch. Expected `{...}`, found `{final_url}`."
   ```

   而 `delivery.mp.microsoft.com` 是**按地域/CDN 负载均衡的主机族**（`.sf.dl.` / `.b.tlu.dl.` 等）。
   **⚠️ 反讽点：为解决国内网络问题而引入的 embed/offline 模式，恰恰在国内做本机 release 构建时最容易因解析到别的子域而构建失败。** 上游 tauri #13572 就是 `embedBootstrapper` 的构建期下载失败。

3. **缓存策略 = 文件存在即跳过**，落在 `tauri_tools_path`（`settings.local_tools_directory()/.tauri`，否则 `dirs::cache_dir()/tauri`）。

   → **可预置**：把 `MicrosoftEdgeWebview2Setup.exe` / `<guid>/MicrosoftEdgeWebView2RuntimeInstallerX64.exe` 手动放进该目录即可完全跳过下载。这既是国内本机构建的逃生口，也是 CI 缓存的钩子。

**落地要求**：CI 缓存 `tauri_tools_path`；`build-and-deploy.md` 记录预置逃生口；构建脚本对该失败给出可读提示。

#### (B) ⚠️ 双包会**互相覆盖**——必须显式重命名

NSIS 输出名在 `nsis/mod.rs:652` 写死，**不可配置**：

```rust
let package_base_name = format!("{}_{}_{}-setup", product_name, version_string, arch);
```

两次 `tauri build --bundles nsis` 产出的都是 `Ultrawork_0.2.2_x64-setup.exe`，**第二次静默覆盖第一次**。必须在两次之间把产物 move 走。

产物命名定为 `Ultrawork_<ver>_x64-offline-setup.exe`——注意 `release.yml` 现有 glob `*-setup.exe` 会**同时**匹配两者，这正是期望行为（两个都上传），无需改 glob。

#### (C) MSI × offline 的组合 —— 决定：**MSI 只出 embed 一种**

否则产物矩阵变成 4 个。理由：
- WiX `light.exe` 本就有前科（§9.2），把 127MB 的 exe 塞进 MSI cabinet 风险显著更高；
- 企业走 SCCM/Intune 部署 MSI 时，WebView2 通常已由域策略预置。

**最终产物三件**：`x64-setup.exe`(embed) · `x64-offline-setup.exe`(offline) · `x64_en-US.msi`(embed)。

#### (D) 首启自检**不需要新增 winreg 依赖**

`tauri::webview_version()` 已经是现成的：

```
tauri-2.10.3/src/lib.rs:206   pub use tauri_runtime_wry::webview_version;
  → tauri-runtime-wry-2.10.1/src/lib.rs:100   pub use wry::webview_version;
    → wry-0.54.2/src/webview2/mod.rs:1830
        GetAvailableCoreWebView2BrowserVersionString(PCWSTR::null(), &mut versioninfo)
```

`fn webview_version() -> Result<String>`，**独立函数、不需要 AppHandle、可在 `tauri::Builder` 之前调用**，且在 mac/Linux 上返回 WebKit 版本（不是 Windows-only 符号）。

→ 正好满足 ADR-037「优先运行时 `if cfg!(target_os = "windows")` 分支而非 `#[cfg]` 属性」：检测函数三平台都能编译，只有「缺失即引导」的分支加运行时判断。**零新增依赖。**

唯一需要额外东西的是**弹提示**：`tauri-plugin-dialog` 的 API 要 `AppHandle`，此刻还没有。两个选择——`windows-sys` 的 `MessageBoxW`（`#[cfg(windows)]`，最小）或直接用 `rfd`（已在依赖树中，`tauri-plugin-dialog` 的底座，可独立调用）。倾向 `rfd`。

#### (E) 未覆盖：Windows ARM64

我们只构 `x86_64-pc-windows-msvc`；`download_webview2_offline_installer` 也只有 `X86`/`X64` 两个常量，无 ARM64。ARM 设备走 x64 模拟。本期不处理，记录备查。

### 9.4 已否决的替代方案

| 方案 | 否决理由 |
|---|---|
| 自建 WebView2 镜像 / 从第三方镜像取包 | 许可 2(b)(iii)「必须直接从微软获取」冲突（§6.2）；且现实中没有可用镜像（§6.1） |
| `fixedVersion` 作**主包** | 微软明确推荐 Evergreen；固定版本拿不到安全更新 = 长期债；还要管 `browserExecutableFolder` 与架构匹配；+180MB > offline 的 +127MB。仅适合做二期兜底旁路包 |
| 安装器内做 IP 归属地探测 / 多源赛马选源 | NSIS 单线程无真并发（`inetc` 多 URL 只是顺序 fallback，超时会**累加**）；且内置 runtime 之后压根没有源可选 |
| 「安装后请重启电脑」提示 | 不需要（§5），且不真实 |
| 为 Windows 7 / 8.1 付出兼容成本 | Runtime 冻结在 `109.0.1518.140`，2023-10-10 起停止安全更新（D3） |

---

## 10. 最低 Windows 版本（D3）

**正式声明最低支持 Windows 10 1803（April 2018 Update）+。**

依据：
- WebView2 在 Win7/8/8.1 上**最后支持版本是 `109.0.1518.140`**，2023-01 停止新特性，**2023-10-10 起连安全更新都停**（微软官方公告）。WebView2 SDK ≥ 1.0.1519.0 起不再支持这些系统。
- 微软对 Win10 的 Evergreen 自动投递以 **1803+** 为界（消费者 2022-06 起，托管/域加入设备 2023-01 起）。Win11 全部预装。
- Tauri 文档口径仍写 "Windows 7 and newer"，但那是**能装 ≠ 值得支持**：runtime 已冻结三年、有已知未修漏洞。

落点：`docs/build-and-deploy.md` §0.1 前置条件表、README、下载页需同步标注。

残余缺失场景（即使 1803+ 也可能没有 WebView2）：LTSC / IoT / Windows Server / S 模式 / 组策略禁用 Edge 更新 / Ghost 精简镜像。**微软仅定性表述 "a small number of Windows 10 devices don't have it"，无公开精确比例。** 这正是 P0-2 首启自检与 P1-3 offline 包存在的理由。

---

## 11. 拍板结论（2026-07-10）

| 编号 | 决策 | 结论 |
|---|---|---|
| **D1** | 单包 offline 一刀切 vs 双包？ | **双包**——主包 `embedBootstrapper`（~129MB）+ `-offline-setup.exe`（`offlineInstaller`，~324MB）。与 Clash Verge Rev / pot-desktop 范式一致 |
| **D2** | 是否恢复 MSI？ | **恢复**，前置验证见 §9.2（ADR-041 之后 WiX 失败理由大概率已消失） |
| **D3** | 最低 Windows 版本？ | **Windows 10 1803+**，明确放弃 Win7/8.1 |

衍生的无需再拍事项（记录备查）：
- `installMode` 保持 `CurrentUser`（不弹 UAC；且把 §3 的严重性压在用户级）。
- 主包不用 `fixedVersion`；是否额外出 fixedVersion 兜底包留待二期，视 offline 包的真机反馈决定。
- 完成页不加「重启电脑」提示。
- **MSI 只出 embed 一种**，不出 offline MSI（§9.3-C）。最终产物三件。
- 首启自检用 `tauri::webview_version()`，**不新增 winreg**（§9.3-D）。
- Windows ARM64 本期不处理（§9.3-E）。

开工前新增的、由 §9.3 引出的动作项：
- CI 需缓存 `tauri_tools_path`；`build-and-deploy.md` 需记录「预置 WebView2 安装器跳过构建期下载」的逃生口（§9.3-A）。
- `build-release.ts` 两次 NSIS 构建之间必须重命名产物，否则静默覆盖（§9.3-B）。

---

## 12. 实现期真机验证项（CI 测不到）

以下全部只能在 Windows 真机 / VM 上做。建议与 MEMORY「ADR-045 动态端口的 Windows/Linux 真机待验」**合并成一次 Windows 验收**。

1. **Win11 VM 卸载 WebView2** → 跑现有 `-setup.exe` → 确认 `Abort` 文案与"零文件落盘"行为（验证 §2）。
2. **同环境抓包（Wireshark / Fiddler）** → **实证 §3 的明文 HTTP 传输**。这是唯一能把 §3 从"源码推理"升级为"确证"的手段，也是 P0-1 的价值证明。
3. **断网 + offline 包** → 应成功安装并启动（验证 P1-3）。
4. **Windows LTSC / Server 2019**（WebView2 最可能缺失的环境）跑一遍全流程。
5. **MSI 恢复后**：`--bundles nsis msi` 在 CI 上是否通过（§9.2）；MSI 的 `embedBootstrapper` CustomAction 路径是否正常。
6. **P0-2 首启自检**：装好 app 后手动卸载 WebView2 → 启动应弹引导框而非 panic。
7. **构建期下载（§9.3-A）**：CI 上 embed / offline 两次构建是否都能通过 `webview2_guid_path()` 的前缀校验；国内本机 Windows 构建是否触发 `WebView2 URL prefix mismatch`（若触发，验证预置缓存文件的逃生口有效）。
8. **双包互不覆盖（§9.3-B）**：`bundle/nsis/` 下最终应同时存在 `-setup.exe` 与 `-offline-setup.exe`，且两者体积差 ≈ 127MB。
9. **跨变体升级**：offline 包装的 app，用 embed 主包覆盖升级（`$UpdateMode=1` 会整段跳过 WebView2 Section），卸载注册表键应保持一致、不残留两份。

---

## 13. 主要来源

- Tauri Windows Installer 文档：https://v2.tauri.app/distribute/windows-installer/
- `WebviewInstallMode` 枚举：https://docs.rs/tauri-utils/latest/tauri_utils/config/enum.WebviewInstallMode.html
- Tauri NSIS 模板：https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi
- Tauri WiX 模板：https://github.com/tauri-apps/tauri/blob/dev/crates/tauri-bundler/src/bundle/windows/msi/main.wxs
- NSISdl 不支持 HTTPS：https://nsis.sourceforge.io/Docs/NSISdl/ReadMe.txt
- NSISdl 源码（scheme 忽略 / 默认 80）：`kichik/nsis` → `Contrib/NSISdl/httpget.cpp`
- 微软 WebView2 分发文档（检测 / 静默命令 / per-machine vs per-user / 重启语义）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- Evergreen vs Fixed Version：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
- Win7/8.1 支持终止（v109）：https://blogs.windows.com/msedgedev/2022/12/09/microsoft-edge-and-webview2-ending-support-for-windows-7-and-windows-8-8-1/
- Win10 消费者投递：https://blogs.windows.com/msedgedev/2022/06/27/delivering-the-microsoft-edge-webview2-runtime-to-windows-10-consumers/
- Win10 托管设备投递：https://blogs.windows.com/msedgedev/2022/12/14/delivering-microsoft-edge-webview2-runtime-to-managed-windows-10-devices/
- WebView2 Runtime 许可条款：https://scancode-licensedb.aboutcode.org/ms-edge-webview2.html
- Chatbox 由 Tauri 迁回 Electron：https://github.com/chatboxai/chatbox/pull/1428
- Clash Verge Rev `tauri.windows.conf.json` / `webview2.x64.json`：https://github.com/clash-verge-rev/clash-verge-rev
