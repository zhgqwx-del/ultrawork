# Ultrawork 桌面应用打包指南

<!-- last-synced: 2026-10-30 -->

> 目标平台：macOS (ARM64 / x86_64) · Windows (x64) · Linux (x64/ARM64)
> 技术栈：Tauri 2 + React 19 + Vite 7 + OpenCode Sidecar (Bun compiled binary)
> **想快速上手 → 直接看下面 §〇 三平台速查**。§二–§七 是 macOS 签名/公证细节，§八–§九 是交叉编译与 CI。三平台兼容背景见 ADR-037。

---

## 〇、三平台速查（dev / build / 安装包）

> 一页覆盖 macOS / Windows / Linux 的「开发模式」与「打包模式」。跨平台兼容已系统落地（ADR-037）。

### 0.1 前置依赖（每台机器装一次）

| 平台 | 必装 |
|---|---|
| **全部** | **Bun ≥ 1.3.12**（bun.sh）、**Rust ≥ 1.89**（rustup / cargo；品牌数据租约使用标准库文件锁）、**Git** |
| **macOS** | Xcode CLT：`xcode-select --install`。Apple Silicon 要出 Universal 包另需 `rustup target add x86_64-apple-darwin`（`setup` 会自动加）。签名/公证细节见 §二–§三 |
| **Windows** | ① **Visual Studio Build Tools 2022**（勾「使用 C++ 的桌面开发」——含 MSVC 链接器 + `rc.exe`，**winres 嵌图标必需，缺了打包失败**）② **WebView2 Runtime**（**最低支持 Win10 1803+**〔ADR-046 D3〕，Win10 1803+/Win11 内置；构建机需能访问微软 fwlink——`embedBootstrapper`/`offlineInstaller` 在构建期从微软拉 bootstrapper/runtime，**国内网络易触发 `WebView2 URL prefix mismatch`**，逃生口=预置安装器到 `%LOCALAPPDATA%\tauri`，见 gotchas §12）③ NSIS/WiX 由 Tauri 自动下载，无需手装 |
| **Linux**（Debian/Ubuntu） | `sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf libgtk-3-dev` |

### 0.2 开发模式（dev）

**首次**（自动：检查工具 → 拉 submodule → apply patch → `bun install`(根+vendor) → 编 4 个 sidecar → 起 dev）：

| 平台 | 命令 |
|---|---|
| macOS / Linux | `./setup.sh --dev` &nbsp;或&nbsp; `bun run setup --dev` |
| Windows | `bun run setup --dev`（Windows 无 bash，必须用这个跨平台入口 `scripts/setup.ts`） |

**之后日常迭代**（sidecar 已编好）：`bun run tauri:dev`
- 改了某个 sidecar 源码或其 workspace 依赖 → 单独重编对应的 `bun run build:opencode`、`bun run build:gateway`、`bun run build:knowledge` 或 `bun run build:acp`，或重新执行 `bun run setup --dev`；公共入口会拒绝过期二进制。
- 改了 `vendor/opencode` → `bun run build:opencode`
- 端口：Vite 1420 / OpenCode 4096 / Gateway 4097 / Knowledge 4098 / ACP 4099

### 0.3 打包模式（build / 安装包）

两条路径，按需选：

**A. 一键打包（最简单，各平台通用）**
```bash
bun run setup --build           # 任意平台：编 sidecar + tauri build（当前架构，bundle.targets:"all" 自动产平台安装包）
# macOS/Linux 亦可： ./setup.sh --build
```

**B. 发布级打包（`bun run release`，`scripts/build-release.ts`）**——Win/Linux 与 A 基本等价，macOS 额外做 Universal + 签名/公证：

| 平台 | 命令 | 产出 |
|---|---|---|
| **macOS** | `bun run release`（需 `APPLE_SIGNING_IDENTITY` 等做签名/公证，见 §三）<br>`bun run release --unsigned`（免签，本地用，Universal） | `.dmg` + `.app`（Universal） |
| **Windows** | `bun run release`（= 编 sidecar + `tauri build` **跑两次**出双包，不碰 Apple 签名） | 三件（ADR-046）：`*-setup.exe`（NSIS embed，~129MB，默认，装机联网拉 runtime）+ `*-offline-setup.exe`（NSIS offline，~324MB，安装期零网络，给国内/内网）+ `*_en-US.msi`（embed，~188MB，企业部署）。MSI 已恢复（ADR-041 zip 化后 WiX v3 前提消失，CI 实证）；offline MSI 刻意不出（太大） |
| **Linux** | `bun run release` | `.deb` + `.rpm`（AppImage 暂跳过，CI 上 linuxdeploy/FUSE 不稳，见 ADR-037） |

> **A vs B**：A/`tauri:build` = 当前架构、不签名、快（日常本地验证）；B/`release` 在 mac 上是 Universal 双架构 + 可签名公证（对外分发），win/linux 上两者基本一样。`--force-build` 可强制全重编 sidecar（默认 hash 增量缓存，重跑很快）。

### 0.4 产物位置

| 入口 | 输出根目录 |
|---|---|
| `tauri:build` / `setup --build`（无 `--target`） | `packages/client/desktop/src-tauri/target/release/bundle/` |
| `release`（带 `--target`，mac 为 `universal-apple-darwin`） | `…/target/<triple>/release/bundle/` |
| 自定义品牌 | `.brand-build/<brandId>/target/` 下对应 `release/bundle/` 或 `<triple>/release/bundle/` |

子目录：mac → `dmg/*.dmg`、`macos/*.app`；Windows → `nsis/*-setup.exe` + `nsis/*-offline-setup.exe` + `msi/*_en-US.msi`（ADR-046 双包 + MSI）；Linux → `deb/*.deb`、`rpm/*.rpm`（AppImage 暂跳过）。

默认品牌若显式设置 `CARGO_TARGET_DIR`，输出根跟随该值。成功生成安装包后，公开入口还会将本次品牌产物与校验清单导出到 `.brand-build/artifacts/<brandId>/<platform>-<arch>/`；只构建 `.app`（`--bundles app`）时不导出安装包清单。

### 0.5 在其他平台验证打包（干净环境完备步骤）

```bash
git clone --recursive <repo>        # 必须 --recursive 带 submodule（漏了就 git submodule update --init --recursive 补）
cd ultrawork
# 装好 §0.1 对应平台前置依赖
bun run setup --build               # 一条命令：编 sidecar + 打包
# 去 target/release/bundle/ 取安装包，装机试运行
```

**Mac 上静态预检 Windows 代码能否编译**（不真打包）：
```bash
rustup target add x86_64-pc-windows-msvc
cd packages/client/desktop/src-tauri && cargo check --target x86_64-pc-windows-msvc
# ⚠️ 只做到这一步会停在 build.rs（缺 Windows sidecar 二进制 → 缺宿主 llvm-rc），此时
#    只有【依赖】被检查过，我们自己的 crate 还没开始编译 ⇒ 不能据此说「Rust 侧 OK」。
#    要真检查到 lib.rs / background.rs 的 Windows 分支，补两样（2026-09-15 实测 Finished）：
#    ① 4 个空文件 binaries/{opencode-server,channel-gateway,knowledge-sidecar,acp-client}-x86_64-pc-windows-msvc.exe
#       （binaries/ 已 gitignore，查完删）
#    ② PATH 里放一个 llvm-rc 假脚本：`/?` 时打印 no-preprocess，其余情况 touch `/fo` 后面的路径并 exit 0
#       （winres 只在链接期需要真 .res；cargo check 不链接）
```

**最省心 = 让 CI 跑**（不用自己备三台机器）：push 触发 `.github/workflows/ci.yml`（三平台 typecheck+test+`cargo test`）；打 `v*` tag 触发 `release.yml`（默认 Ultrawork/MyWork × 三平台，六个任务产 dmg / nsis〔含 offline〕/ msi / deb / rpm，全部成功且清单校验通过后统一创建 GitHub Release；workflow_dispatch 可选 all/default/mywork，仅出验证 artifact）。

### 0.6 独立品牌发行版（ADR-075）

无品牌参数时仍编译默认 **Ultrawork**，即使本地自定义预置、账本或旧 manifest 损坏，也不影响默认入口；显式选择自定义品牌仍严格校验。需要 MyWork 时，从仓库根目录使用预置配置：

```bash
# 只读检查派生身份、包名与图标输入，不生成安装包或登记身份
bun run brand:inspect --brand branding/mywork/brand.json

# 首次准备依赖和四个 sidecar，然后构建当前架构安装包
bun run setup --build --brand branding/mywork/brand.json

# 已准备 sidecar 后的日常入口
bun run tauri:dev --brand branding/mywork/brand.json
bun run tauri:build --brand branding/mywork/brand.json

# 发布级构建；macOS 默认 Universal，需要签名身份
bun run release --brand branding/mywork/brand.json

# macOS 本机开发验包：当前架构、ad-hoc 签名，显示为 MyWork Dev
bun run release --brand branding/mywork/brand.json --native --unsigned
```

配置文件示例（素材路径相对配置文件；MyWork 的真实预置见 [brand.json](../branding/mywork/brand.json)）：

```json
{
  "schemaVersion": 1,
  "brandId": "mywork",
  "productName": "MyWork",
  "icon": "./assets/meiyou-app-rounded.png",
  "trayIcon": "./assets/meiyou-tray.png"
}
```

临时参数同样支持检查、setup、dev、build、release：

```bash
bun run brand:inspect --brand-id demo-work --name "DemoWork" --icon ./branding/mywork/assets/meiyou-app-rounded.png
bun run setup --build --brand-id demo-work --name "DemoWork" --icon ./branding/mywork/assets/meiyou-app-rounded.png
```

| 输入 | 规则 |
|---|---|
| `--brand <file>` | JSON 配置；未知字段、错误 schema、缺少素材直接失败 |
| `--brand-id <id>` | 2–32 位非保留的小写 ASCII 标识，字母开头、可用连字符分段；长期发行须显式固定。无配置且省略时，由 ASCII 名称派生 |
| `--name <name>` | 覆盖 productName；当前发行构建只接受 ASCII 且须能派生合法 Linux 包名，例如 MyWork；拒绝 DMG 模板会插值的 `$` / `@`。不能与默认/其他品牌及其 Dev 名称冲突 |
| `--icon <path>` | PNG 或 SVG 应用图标，必须正方形；构建生成 macOS/Windows/Linux 图标 |
| `--ui-logo <path>` | 可选 PNG/SVG，默认使用应用图标 |
| `--tray-icon <path>` | 可选透明 PNG；省略时生成名称首字母的托盘模板图 |

临时参数优先于配置中的名称和素材，但不能覆盖配置已有的稳定 brandId。CLI 素材路径相对调用时的目录；只有名称或只有图标不构成完整自定义品牌。不要直接修改 `tauri.conf.json` 或源码 icons 作为品牌切换方式。

`setup.sh`（macOS/Linux）原样转发到上述跨平台 setup 入口，品牌参数、参数顺序及相对路径语义一致，例如 `./setup.sh --build --brand branding/mywork/brand.json`。Windows 使用 `bun run setup`。setup 遇到开发端口占用时不再按端口杀进程，应先关闭自己拥有的开发实例。

MyWork 保留美柚官方 1024px 原图，以默认 Ultrawork 主图的 alpha 通道生成 `meiyou-app-rounded.png`，两者圆角、透明边界和各原生尺寸一致。可用 `bun run --bun scripts/gen-mywork-icon.ts --check` 检查派生资产，或去掉 `--check` 重新生成；不同画面压缩后的文件字节数不要求相同。

macOS Dock/Finder 另用专用 `icon-macos.icns`，两预置采用 1024px 画布、824px 主体和四边100px透明留白。默认资产通过 `bun run --bun scripts/gen-macos-icon.ts` 生成（`--check` 只读核验），自定义品牌在 staging 内自动生成；已适当留白的输入不重复缩小。通用 PNG/ICO、应用内 Logo 和托盘不受此 macOS 适配影响。dev 与安装包读取同一类 ICNS，Tauri dev 没有额外放大；Cargo 显式跟踪最终 ICNS 路径，算法内容也纳入品牌 digest。

图标修复后需完整退出旧 dev 会话再重启：在原开发终端按 Ctrl+C；若应用仍驻留，则从应用/托盘菜单退出（关闭窗口只会隐藏），之后重新执行对应的 `./setup.sh --dev` 命令。已运行的品牌 wrapper 持有旧 overlay，刷新 WebView 不会重新准备图标；不要先清系统图标缓存或强杀 Dock。

**身份与升级**：MyWork 固定为 `brandId/namespace/mainBinaryName = mywork`、`identifier = com.ultrawork.mywork`，Linux 包名为 `my-work`，Windows MSI upgradeCode 属于独立升级家族。默认保留 `com.ultrawork.desktop` 与既有主程序名。预置 `identity.json`、本地 `.brand-build/identity-ledger.json` 及成功构建的 manifest 会阻止同一 brandId 后续改名或碰撞其他品牌。首次准备临时构建即登记本地身份，即使后续编译失败也保留；`brand:inspect` 只读。正式发行应提交身份快照，不能靠清空 `.brand-build` 绕过已发布身份。

身份校验还比较 macOS single-instance 插件把点/连接符归一后的 socket 键，避免看似不同的 identifier 实际互相聚焦。Linux 自定义包的四个 externalBin 在包内使用 namespace 前缀，例如 `mywork-opencode-server`，避免两个 deb/rpm 覆盖共享 `/usr/bin/opencode-server`；默认版及 macOS/Windows 保留内部原名。Linux 构建后用 `dpkg-deb`/`rpm` 读取真实安装文件清单，缺资源、漏前缀或覆盖默认目录均失败，检查结果写入 manifest；Linux 构建机须安装这两个工具。

**构建互斥与缓存**：同一 checkout 的 setup/dev/build/release 共用 `.brand-build/build-lock.sqlite` 的 OS 锁，dev 持锁到退出；另一个会话会明确失败，并行构建须使用另一 checkout。自定义图标、Tauri overlay、技能物化目录和 Cargo target 放在 `.brand-build/<brandId>/`，不改写默认配置或源码图标。技能先在临时目录完整复制和改写，再原子发布；source 外的完成标记匹配才复用，构建中断留下的半成品会重建。

四个 sidecar 是共享内部组件。公共 dev/build/release 入口除 target、协议和二进制 SHA-256 外，还按各自 builder 的当前源码/依赖指纹校验新鲜度；`--skip-sidecar` 仅跳过编译，不能放行仍兼容协议但包含旧逻辑的二进制。可用 `bun run --bun scripts/build-acp.ts --check`（或其它 builder，支持 `--target <triple>`）只读检查，不编译或下载；过期时重编对应的 `build:opencode/gateway/knowledge/acp`。Universal 同时核验两架构及其合并来源，不能只凭旧 Universal metadata 打包。OpenCode vendor build 的版本探针使用独立应用 home/XDG，避免构建时初始化或清理用户缓存；工具链 HOME 保持原有语义。

**依赖冻结**：setup 和 CI 使用根锁冻结安装；vendor 的统一入口为 `bun run --bun scripts/vendor-dependencies.ts`，先补齐累计 patch，再冻结安装所有 OS/CPU 的可选依赖。OpenCode 构建始终传上游已有 `--skip-install`，其缓存指纹覆盖 vendor 锁与全部 workspace manifests。缺锁、patch 冲突或安装失败须修复后重试，不能以普通安装绕过；损坏/过期 metadata 或被改写的二进制会自动重编。固定版本及补丁维护见 [vendor 工作流](./vendor-patch-workflow.md)。

**运行目录**：三平台继续使用现有 home/XDG 约定；下表默认值以用户 home 为基准，Windows 的 `~` 同样指实际用户 home。每个品牌独立保存配置、凭证、历史、渠道与技能，不自动导入 Ultrawork 数据。

| 根 | 默认 Ultrawork | MyWork | XDG 覆盖 |
|---|---|---|---|
| appRoot | `~/.ultrawork` | `~/.mywork` | 无 |
| configRoot | `~/.config/ultrawork` | `~/.config/mywork` | `XDG_CONFIG_HOME/<namespace>` |
| dataRoot | `~/.local/share/ultrawork` | `~/.local/share/mywork` | `XDG_DATA_HOME/<namespace>` |
| cacheRoot | `~/.cache/ultrawork` | `~/.cache/mywork` | `XDG_CACHE_HOME/<namespace>` |
| stateRoot | `~/.local/state/ultrawork` | `~/.local/state/mywork` | `XDG_STATE_HOME/<namespace>` |
| skillsRoot | `~/.config/ultrawork/skills` | `~/.config/mywork/skills` | 跟随 configRoot |
| 运行上下文/端口 | `~/.ultrawork/run/` | `~/.mywork/run/` | 跟随 appRoot |

XDG 覆盖必须是绝对路径；默认 Ultrawork 显式设置空 `XDG_DATA_HOME` 会被阻断，需 unset 或指定绝对根，避免旧版本空值语义造成目录误接管。Rust 在任何业务初始化前校验目录身份并取得 `<appRoot>/.brand.lock` 租约；自定义品牌遇到无标记非空目录、错误标记、别名冲突或同品牌正在运行，会显示启动阻断页。不要删除身份标记来强制接管目录。品牌 Dev/正式版共用同品牌数据和租约，切换前须退出另一个实例。

宿主读取 OpenCode PATCH 生成的 JSONC（注释、尾逗号、BOM）后更新受管 MCP 路径并清除旧品牌/端口 environment，保留其余用户字段；配置读取或解析失败会在业务写入前阻断，不能以空配置继续。delegate stdio MCP 在每次工具调用解析当前实例的动态 ACP 路由，预热握手不固定尚未就绪的端口。

**签名与分发**：品牌资源在签名前生成，改名/换图标后重新走完整打包签名链。macOS 正式包仍需 Developer ID 签名、公证、staple 与 DMG 布局校验；证书可沿用同一发布主体，TCC/通知等权限要按品牌重新验收。`release --unsigned` 的 bundle identifier 加 `.dev`、名称加 ` Dev`，并由 Tauri 使用 `signingIdentity="-"` 在封装前进行 ad-hoc 签名，封装后只校验，避免外部 `.app` 与 DMG 内副本签名不一致。它不能作为正式签名验收。Windows 继续由已有 Tauri/CI 签名配置决定，本次未新增 Windows 签名服务；Linux 包/仓库签名也需按分发渠道配置。`v*` tag 同版本发布默认 Ultrawork 与 MyWork 的三平台安装包，macOS 两品牌均须正式签名/公证；workflow_dispatch 可选 `all`、`default` 或 `mywork`，仅出验证 artifact。

tag 的六个构建任务使用独立的品牌/平台 artifact 与 manifest，发布 job 收齐后校验每份清单列出的文件大小和 SHA-256，并拒绝同名安装包，再将两品牌安装包附到同一个 Release。`ALLOW_UNSIGNED_RELEASE` 不允许正式 tag 绕过签名；只有显式 dispatch 验包可按该变量选择 `.dev` 产物。发布前须以本次 run 的签名、公证、staple 日志和最终产物为依据，不能只看旧版本已配置过 Secret 或某个 job 显示绿色。

本次公共入口已完成默认 → MyWork → 默认的 macOS `.app` 连续构建。中文进程路径、JSONC 重启与 delegate 动态路由修复后，默认 ARM64 DMG、基础 identifier 的 MyWork ARM64 app 与 MyWork Universal Dev DMG 均已按最新源码重建和复验；MyWork 宿主及四个 sidecar 均包含 ARM64/x86_64，名称、identifier、可执行文件、图标、技能包和真实 DMG 布局已核对，包内 ad-hoc 完整性通过。将包复制到中文/空格客户路径后，签名保持有效；269 个包内文本资源未引用本 checkout，5 个 Mach-O 只依赖相对或系统 dylib；搬迁后的真实 sidecar 在 ARM64 上通过单 Agent/Team/Pipeline、重启恢复及真实 OpenCode 本地 SSE 工具循环 **12 项**。客户配置/数据根由该机器的 home/XDG 解析，不把编译机素材绝对路径当作运行输入；release 缺少包内 sidecar 会失败，源码目录 fallback 仅限 debug。

Rust **185 项**、delegate **33 项**、品牌 integration **3 项**、全工作区 test **13 个任务**及 9 包 typecheck 均通过。Chrome/WebKit 各 **30** 个品牌启动场景及主要浏览器业务回归通过；最新 macOS 包的两个真实 Dev 宿主在独立中文/空格 HOME（`客户 Home`）与 XDG、C locale 中完成并行、同 identifier 重复启动、Dev/基础身份租约互斥、崩溃/重启回收、JSONC 全局配置/MCP 重启恢复及退出互不干扰 **9 项**。JSONC 检查先在旧包上真实检出 stale environment，最新包保留用户字段、清除旧受管环境，Knowledge/delegate MCP 均 connected。Windows/Linux 原生构建安装、Intel Mac 运行、跨版本升级卸载、Developer ID 正式签名/公证与真实系统授权仍需相应平台及凭证；本机没有有效 Apple 签名身份及公证配置，不能将本机 ad-hoc 或本地模型 fixture 的通过作为这些项目的证明。详细证据、复验命令及剩余项见 [testing §16](./testing.md#16-独立品牌发行版的验证adr-075)，架构取舍见 [ADR-075](./decisions/075-independent-brand-releases.md)。

已安装默认构建与当前构建（版本号均为 0.3.9）的受测数据前向读取也已通过：仅在独立文件写入沙箱和临时 home 中由真实 sidecar 写入/读回配置、会话、渠道、Agent、知识源，MyWork 不暴露默认记录。此结果不代替跨版本安装器升级或降级；复验脚本及精确边界仍以 testing §16 为准。

---

## 一、前置条件

| 工具 | 最低版本 | 检查命令 |
|------|---------|---------|
| Bun | 1.3.x | `bun --version` |
| Rust + Cargo | 1.89+ | `rustc --version && cargo --version` |
| Xcode CLI Tools | - | `xcode-select -p` |
| Apple Developer 账号 | -（签名+公证可选，不签名分发参考 §5）| [developer.apple.com](https://developer.apple.com) |
| Rust target `x86_64-apple-darwin` | Apple Silicon 主机必装 | `rustup target list --installed` |

```bash
# 确认工具链
bun --version        # 1.3.12+
rustc --version
cargo --version
xcode-select -p      # /Library/Developer/CommandLineTools

# Apple Silicon 上额外需要 x86_64 target（Universal DMG 必需）
rustup target add x86_64-apple-darwin
```

> `setup.sh` 第 1 步会在 Apple Silicon 主机上自动检测 + 安装 `x86_64-apple-darwin` target（幂等）。

---

## 二、签名证书配置（防止"已损坏"提示）

macOS Gatekeeper 会拦截未签名的应用。需要以下两步：**代码签名** + **公证 (Notarization)**。

### 2.1 创建 Developer ID 证书

1. 登录 [Apple Developer - Certificates](https://developer.apple.com/account/resources/certificates/list)
2. 点击 `+` → 选择 **Developer ID Application**
3. 按提示在 Keychain Access 中生成 CSR（Certificate Signing Request）：
   - 打开 Keychain Access → 菜单 → Certificate Assistant → Request a Certificate from a Certificate Authority
   - 填写邮箱、名称，选择 **Saved to disk**
4. 上传 CSR → 下载 `.cer` 文件 → **双击安装到 Keychain**

### 2.2 验证证书已安装

```bash
security find-identity -v -p codesigning
```

应显示类似：
```
1) ABCDEF1234... "Developer ID Application: Your Name (TEAM_ID)"
   1 valid identities found
```

记下 **签名身份字符串**（引号内完整内容）和 **Team ID**（括号内 10 位字符）。

### 2.3 创建 App 专用密码（用于公证）

1. 访问 [appleid.apple.com](https://appleid.apple.com) → 登录 → App-Specific Passwords
2. 生成一个专用密码，记下密码值

### 2.4 将凭据存入 Keychain（推荐）

```bash
# 存储公证凭据到 Keychain（只需执行一次）
xcrun notarytool store-credentials "ultrawork-notarize" \
  --apple-id "你的AppleID邮箱" \
  --team-id "你的TEAM_ID" \
  --password "App专用密码"
```

---

## 三、配置 Tauri 签名

### 3.1 修改 tauri.conf.json

编辑 `packages/client/desktop/src-tauri/tauri.conf.json`，在 `bundle` 中添加 macOS 签名配置：

```json
{
  "bundle": {
    "active": true,
    "targets": ["dmg", "app"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon-macos.icns",
      "icons/icon.ico"
    ],
    "externalBin": [
      "binaries/opencode-server",
      "binaries/channel-gateway",
      "binaries/knowledge-sidecar",
      "binaries/acp-client"
    ],
    "macOS": {
      "signingIdentity": null,
      "minimumSystemVersion": "10.15"
    }
  }
}
```

> `signingIdentity: null` 表示 Tauri 自动从 Keychain 取 "Developer ID Application" 证书。
> 也可以显式指定：`"signingIdentity": "Developer ID Application: Your Name (TEAM_ID)"`

### 3.2 设置环境变量（打包时）

Tauri 2 使用环境变量控制签名和公证：

```bash
# 代码签名（必须）
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"

# 公证（必须，三选一方式）
# 方式 A：使用 Keychain 存储的凭据（推荐，已在 2.4 配置）
export APPLE_KEYCHAIN_PROFILE="ultrawork-notarize"

# 方式 B：直接设置环境变量
# export APPLE_ID="你的AppleID邮箱"
# export APPLE_PASSWORD="App专用密码"
# export APPLE_TEAM_ID="你的TEAM_ID"
```

---

## 四、完整打包步骤

`bun run release` 是发布构建的唯一入口（脚本：`scripts/build-release.ts`）。会自动跑以下流程：

1. 内置技能 zip 打包（`scripts/pack-builtin-skills.ts`，按内容 hash 惰性、已新鲜则瞬时跳过；`tauri build` 的 beforeBuildCommand 也会跑，双保险，ADR-041）
2. 检查环境变量（`APPLE_SIGNING_IDENTITY` / `APPLE_ID` 等，可选）
3. 双架构编译四个 sidecar（OpenCode / Gateway / Knowledge / ACP Client）— `aarch64-apple-darwin` + `x86_64-apple-darwin`
4. `lipo -create` 合并每个 sidecar 成 universal binary（`<name>-universal-apple-darwin`），ad-hoc 重签
5. `tauri build --target universal-apple-darwin` 编译 Rust 端 + 前端 + lipo 主二进制 + 打包 `.app` + 打包 DMG
6. 验证签名 / 公证（如配置）/ stapler

### 4.1 签名 + 公证（正式发布）

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/ultrawork

# 必需：签名身份
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"

# 可选：公证凭证（缺则跳过公证，只签名）
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # https://appleid.apple.com 生成
export APPLE_TEAM_ID="TEAMID"

bun run release
```

### 4.2 未签名构建（内部测试 / 本地分发）

```bash
bun run release -- --unsigned
```

- 不需要 Apple Developer 账号
- 产物 ad-hoc 签名，可在本机运行
- 对方机器装上后**必须解 quarantine**，详见 §5

### 4.3 其他 flag

| flag | 作用 |
|------|------|
| `--skip-sidecar` | 跳过 sidecar 编译，仍检查当前源码新鲜度、协议和文件完整性；过期须先重编 |
| `--skip-notarize` | 跳过公证（签名仍执行） |
| `--native` | 只编译当前架构（不出 Universal）。CI 调试用 |
| `--verbose` | 显示底层 tauri/cargo 输出 |

### 4.3.1 DMG 安装窗口布局

DMG 里图标的摆放（`Ultrawork.app` 在左、`Applications` 在右）存在 `.DS_Store` 中，由 `bundle_dmg` 驱动 Finder 的 AppleScript 写入。tauri-bundler 见到 `CI=true` 会跳过这段脚本，导致 Finder 按文件名排序、`Applications` 跑到左边；`build-release.ts` 因此设置 `TAURI_BUNDLER_DMG_IGNORE_CI=true`，并在公证前跑 `scripts/verify-dmg-layout.ts` 断言布局。详见 [`gotchas.md §7`](./gotchas.md)。

单独校验任意 DMG（校验器 fail-closed：解析不出坐标 = 报错，不会静默放过）：

```bash
bun run --bun scripts/verify-dmg-layout.ts path/to/Ultrawork.dmg
```

真正的校验需要一个已构建的 DMG，只在发版时才跑；`--self-test`（CI 三平台每次 PR 都跑）补上这个盲区——它验解析器，并断言 `build-release.ts` 仍然默认开启该 env、仍然调用校验：

```bash
bun run --bun scripts/verify-dmg-layout.ts --self-test
```

**应急逃生阀**：若 GitHub runner 的 Finder 自动化再次回归（[tauri-action#1091](https://github.com/tauri-apps/tauri-action/issues/1091)：`AppleEvent timed out -1712`），用 `TAURI_BUNDLER_DMG_IGNORE_CI=false` + `--allow-bad-dmg-layout` 放行一次发布——两个都要给，任一单独给都不会静默出坏包。代价是该 DMG 图标按名排序。

### 4.4 产物位置

```
packages/client/desktop/src-tauri/target/universal-apple-darwin/release/bundle/
├── dmg/
│   └── Ultrawork_<版本>_universal.dmg      ← 可分发 DMG（含 arm64 + x86_64）
└── macos/
    └── Ultrawork.app/                       ← 独立 .app 应用包
        └── Contents/MacOS/
            ├── ultrawork                    ← 主二进制（Universal）
            ├── opencode-server              ← Sidecar 二进制（Universal，~248MB）
            ├── channel-gateway              ← Sidecar 二进制（Universal，~124MB）
            └── knowledge-sidecar            ← Sidecar 二进制（Universal，~133MB）
```

### 4.5 Sidecar 副本机制（运行时）

应用启动期间，`ensure_sidecar_copies()` 会把 `Contents/MacOS/<name>` 复制到 `~/.ultrawork/sidecars/<name>`（详见 ADR-028）。MCP 注册的路径指向用户级副本，不随 `.app` 移动或升级失效。Marker 文件 `~/.ultrawork/sidecars/.<name>.source` 存源端 `size:mtime-ns`，app 升级后源端 size 变化自动触发覆盖。

---

## 五、不签名时的临时方案

未签名的 `.app` 被 macOS Gatekeeper 拦截（"无法打开 - 来自身份不明的开发者"）。对方电脑需要：

```bash
# 解 quarantine 后正常打开（推荐，一行搞定）
xattr -dr com.apple.quarantine /Applications/Ultrawork.app
```

或：

```bash
# 在系统设置 → 隐私与安全性 → 滚到底部点"仍要打开"
```

> **注意**：未签名 DMG 适合内部分发 / 朋友圈测试。**公开分发应使用 Apple Developer ID 签名 + 公证**，否则对方每次升级都要手动绕过 Gatekeeper，体验差。

### `--unsigned` 产物是独立身份：`Ultrawork Dev` + `com.ultrawork.desktop.dev`（2026-08-19 起）

`bun run release --unsigned` 打出来的产物是 **`Ultrawork Dev.app`** / **`Ultrawork Dev_<版本>_<arch>.dmg`**，identifier 是 **`com.ultrawork.desktop.dev`**（`build-release.ts` 通过 `tauri build --config` 同时覆盖 `identifier` 与 `productName`，仅 macOS 分支）。

> 改名不只是好看：系统设置的隐私列表里两条都叫「Ultrawork」时，**你分不清哪条属于哪个构建**——而这正是陈旧授权长期不被诊断出来的原因。⚠️ 下游一切按覆盖值推导，不能读 `tauri.conf.json`（覆盖不写回文件）：`appPath` / `dmgPrefix` / 传给 `verify-dmg-layout.ts` 的第二个参数都是如此，否则会去找一个本次构建根本没产出的 bundle。

**为什么**：macOS 的隐私授权（屏幕录制、通知……）按 **bundle id + 授权当时那个二进制的代码签名要求（csreq）** 记录，而 ad-hoc 签名没有稳定身份、每次重编 cdhash 都变。只要给本地 ad-hoc 包授过一次权，就会在系统里留下一条**正式签名版永远满足不了**的记录：tccd 报 `Failed to match existing code requirement`，而系统设置里那个开关**看上去still是开的**，重新拨动也只改授权值、不重写签名要求。真实发生过（2026-08-19，v0.3.7 用户的截图按钮完全不可用，只能手工删记录才恢复）。详见 `gotchas.md §6`。

**要预期的行为差异（不是 bug）**：本地 `--unsigned` 包对 macOS 而言是**另一个 app** —— 权限要单独授、WebView 存储（localStorage/cookie）与正式版分开。⚠️ **因此任何"权限形状"的真机验收（屏幕录制、通知、麦克风…）必须在正式签名的包上做**，在 `--unsigned` 包上验到的绿不代表正式版。

---

## 六、验证签名和公证

```bash
# 检查代码签名
codesign -dvv /path/to/Ultrawork.app

# 验证签名完整性
codesign --verify --deep --strict /path/to/Ultrawork.app

# 检查公证状态（Gatekeeper 评估）
spctl -a -vvv /path/to/Ultrawork.app
# 应输出：accepted / source=Notarized Developer ID

# 检查 Sidecar 也被签名
codesign -dvv /path/to/Ultrawork.app/Contents/MacOS/opencode-server-aarch64-apple-darwin
```

---

## 七、常见问题

### Q1: `bun run build:opencode` 失败
```bash
# 确保 vendor submodule 已初始化
git submodule update --init --recursive
# 进入 opencode 目录手动构建验证
cd vendor/opencode/packages/opencode && bun run build --single
```

### Q2: Tauri 编译报错找不到 sidecar
```bash
# 确保二进制名匹配 Tauri target triple
ls packages/client/desktop/src-tauri/binaries/
# 应存在: opencode-server-aarch64-apple-darwin（ARM Mac）
#        opencode-server-x86_64-apple-darwin（Intel Mac）
```

### Q3: 签名失败 "no identity found"
```bash
# 检查 Keychain 中的证书
security find-identity -v -p codesigning
# 确保证书未过期，且私钥存在
# 如果证书刚安装，可能需要重启终端
```

### Q4: 公证失败
```bash
# 手动公证（排查错误）
xcrun notarytool submit /path/to/Ultrawork.dmg \
  --keychain-profile "ultrawork-notarize" \
  --wait

# 查看公证日志
xcrun notarytool log <submission-id> \
  --keychain-profile "ultrawork-notarize"
```

### Q5: 打包后 App 无法启动，Sidecar 权限问题
```bash
# 确保 sidecar 在打包前有执行权限
chmod +x packages/client/desktop/src-tauri/binaries/opencode-server-*
```

### Q6: DMG 体积过大
- OpenCode sidecar 二进制 ~114MB，是体积主因
- 可考虑 UPX 压缩：`upx --best opencode-server-aarch64-apple-darwin`（但可能影响签名）

---

## 八、跨平台打包

本项目打包涉及两个二进制：**Sidecar**（Bun 编译）+ **Tauri Shell**（Rust 编译），两者都需要匹配目标平台。

### 8.0 各平台可行性总结

| 构建机 → 目标 | Sidecar | Tauri Rust | 总体可行性 |
|-------------|---------|-----------|----------|
| Mac ARM → **Mac ARM** | ✅ 原生 | ✅ 原生 | ✅ 直接构建 |
| Mac ARM → **Mac x86** | ✅ Bun 交叉编译 | ✅ Rust 交叉编译 | ✅ 可行 |
| Mac ARM → **Mac Universal** | ✅ 两架构各编译 | ✅ `universal-apple-darwin` | ✅ 推荐分发 |
| Mac → **Windows** | ✅ Bun 交叉编译 | ❌ Rust 无法交叉 | ❌ 需 Windows 机器/CI |
| Mac → **Linux** | ✅ Bun 交叉编译 | ❌ 需交叉工具链 | ⚠️ 不推荐，用 CI |

> **结论**：在你的 Mac 上可以直接产出 Mac ARM + Mac Intel + Mac Universal 三种包。
> Windows 和 Linux 包需在对应系统上构建（物理机/VM 用 `bun run setup --build`，或推荐走 CI）。
> 速查命令见 §〇；CI 已落地为 `.github/workflows/{ci,release}.yml`，push/tag 即自动构建三平台。

---

### 8.1 Mac Intel (x86_64) — 从 ARM Mac 交叉编译

```bash
# ---- Step 1: 安装 Rust x86_64 目标 ----
rustup target add x86_64-apple-darwin

# ---- Step 2: 构建 x86_64 Sidecar ----
bun run build:opencode -- --target x86_64-apple-darwin
# 产物：binaries/opencode-server-x86_64-apple-darwin

# ---- Step 3: 打包 Tauri (指定 target) ----
cd packages/client/desktop
bun run --bun tauri build --target x86_64-apple-darwin

# ---- 产物 ----
# src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Ultrawork_<版本>_x64.dmg
```

### 8.2 Mac Universal Binary (ARM64 + x86_64) — 推荐分发

Universal Binary 同时包含 ARM 和 Intel 代码，一个 `.app` 在所有 Mac 上原生运行。

```bash
# ---- Step 1: 安装 Rust 双目标 ----
rustup target add x86_64-apple-darwin
rustup target add aarch64-apple-darwin  # 你已有

# ---- Step 2: 构建两个架构的 Sidecar ----
bun run build:opencode                                    # ARM64 (默认)
bun run build:opencode -- --target x86_64-apple-darwin    # x86_64
# 此时 binaries/ 下应有两个文件：
#   opencode-server-aarch64-apple-darwin
#   opencode-server-x86_64-apple-darwin

# ---- Step 3: 打包 Universal ----
cd packages/client/desktop
bun run --bun tauri build --target universal-apple-darwin

# ---- 产物 ----
# src-tauri/target/universal-apple-darwin/release/bundle/dmg/Ultrawork_<版本>_universal.dmg
# Tauri 会自动用 lipo 合并两个架构的二进制
```

> **注意**：Universal 打包要求 `binaries/` 目录下同时存在 `opencode-server-aarch64-apple-darwin` 和 `opencode-server-x86_64-apple-darwin`。Tauri 会自动选择匹配的 sidecar 嵌入。

### 8.3 Windows (x64) — 需要 Windows 环境

Tauri 的 Rust 编译依赖 MSVC 工具链，**无法在 macOS 上交叉编译到 Windows**。有两个方案：

#### 方案 A：Windows 物理机或虚拟机

```powershell
# 前置条件见 §0.1（Bun / Rust / VS Build Tools C++ / WebView2）

# 推荐一键：编 sidecar + 打包
bun run setup --build
#   或手动等价：
#   bun install; cd vendor/opencode; bun install; cd ../..
#   bun run build:opencode; bun run build:gateway; bun run build:knowledge; bun run build:acp
#   bun run tauri:build

# 产物：
# src-tauri\target\release\bundle\msi\Ultrawork_<版本>_x64_en-US.msi
# src-tauri\target\release\bundle\nsis\Ultrawork_<版本>_x64-setup.exe
```

> **无需再手改 `bundle.targets`**——已设为 `"all"`（ADR-037），Tauri 在 Windows 上自动产 `msi` + `nsis`。

#### 方案 B：GitHub Actions CI（已落地为真实文件）

> 下面的 yaml 仅作说明；仓库已提交可用的 `.github/workflows/ci.yml`（push/PR 三平台校验）与 `release.yml`（tag `v*` 触发三平台出安装包）。直接 push/tag 即可，无需手抄。

```yaml
# .github/workflows/build.yml 中添加 job:
  build-windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12
      - uses: dtolnay/rust-toolchain@stable
      - run: bun install
      - run: bun run build:opencode
      - run: bun run tauri:build
      - uses: actions/upload-artifact@v4
        with:
          name: ultrawork-windows
          path: |
            packages/client/desktop/src-tauri/target/release/bundle/msi/*.msi
            packages/client/desktop/src-tauri/target/release/bundle/nsis/*.exe
```

### 8.4 Linux (x64) — 需要 Linux 环境

本地（装好 §0.1 Linux 依赖后）：`bun run setup --build` → 产 `.deb` + `.rpm`（AppImage 暂跳过）。或推荐用 CI：

```yaml
  build-linux:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12
      - uses: dtolnay/rust-toolchain@stable
      - name: Install Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
            librsvg2-dev patchelf libssl-dev libgtk-3-dev
      - run: bun install
      - run: bun run build:opencode
      - run: bun run tauri:build
      - uses: actions/upload-artifact@v4
        with:
          name: ultrawork-linux
          path: |
            packages/client/desktop/src-tauri/target/release/bundle/appimage/*.AppImage
            packages/client/desktop/src-tauri/target/release/bundle/deb/*.deb
```

> Linux 打包前需修改 `tauri.conf.json` 的 `bundle.targets`：
> ```json
> "targets": ["appimage", "deb"]
> ```

---

### 8.5 多平台一体 CI（完整示例）

```yaml
# .github/workflows/release.yml
name: Release
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            target: aarch64-apple-darwin
            name: macos-arm64
          - os: macos-latest
            target: x86_64-apple-darwin
            name: macos-x64
          - os: windows-latest
            target: x86_64-pc-windows-msvc
            name: windows-x64
          - os: ubuntu-22.04
            target: x86_64-unknown-linux-gnu
            name: linux-x64

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12

      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target }}

      - name: Install Linux deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
            librsvg2-dev patchelf libssl-dev libgtk-3-dev

      - name: Import Apple certificate
        if: startsWith(matrix.os, 'macos')
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
          security create-keychain -p "" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "" build.keychain
          security import certificate.p12 -k build.keychain \
            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple: \
            -s -k "" build.keychain

      - run: bun install

      - name: Build sidecar
        run: bun run build:opencode -- --target ${{ matrix.target }}

      - name: Build Tauri
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          cd packages/client/desktop
          bun run --bun tauri build --target ${{ matrix.target }}

      - uses: actions/upload-artifact@v4
        with:
          name: ultrawork-${{ matrix.name }}
          path: |
            packages/client/desktop/src-tauri/target/*/release/bundle/**/*.dmg
            packages/client/desktop/src-tauri/target/*/release/bundle/**/*.app
            packages/client/desktop/src-tauri/target/release/bundle/**/*.dmg
            packages/client/desktop/src-tauri/target/release/bundle/**/*.msi
            packages/client/desktop/src-tauri/target/release/bundle/**/*.exe
            packages/client/desktop/src-tauri/target/release/bundle/**/*.AppImage
            packages/client/desktop/src-tauri/target/release/bundle/**/*.deb
```

---

## 九、CI/CD 自动打包（已落地 + macOS 签名）

> 仓库使用 `.github/workflows/release.yml`：tag `v*` 为默认 Ultrawork/MyWork 各构建三平台安装包，全部成功及清单校验通过后统一创建 Release。既有 macOS 签名+公证链路自 v0.3.3 起打通（ADR-069）；每次两品牌发行仍需分别检查本次 run 的证据。下面是权威说明；本节末尾的 yaml 仅为历史示例，以真实文件为准。

### 9.1 macOS 签名：6 个仓库级 Secret

在 `Settings → Secrets and variables → Actions` 配置（[配置页](https://github.com/zhgqwx-del/ultrawork/settings/secrets/actions)）：

| Secret | 内容 | 来源 |
|---|---|---|
| `APPLE_CERTIFICATE` | `.p12` 的 base64（`base64 -i certificate.p12 \| pbcopy`，别 print 到终端） | 本机合成 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 | 本机自设 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <名字> (<TEAMID>)` | 证书 subject CN |
| `APPLE_ID` | 开发者 Apple ID 邮箱 | — |
| `APPLE_PASSWORD` | App 专用密码（**非**登录密码，appleid.apple.com 生成） | Apple ID |
| `APPLE_TEAM_ID` | 10 位 Team ID | 证书 / Membership |

### 9.2 一次性生成 `.p12`（本机，openssl 全命令行）

```bash
mkdir -p ~/ultrawork-signing && cd ~/ultrawork-signing
# 1. 私钥 + CSR
openssl req -new -newkey rsa:2048 -nodes -keyout devid.key -out devid.csr \
  -subj "/emailAddress=you@example.com/CN=Your Name/C=CN"
chmod 600 devid.key
# 2. 上传 devid.csr 到 developer.apple.com → Certificates → + → Developer ID Application
#    下载 developerID_application.cer 放进本目录
# 3. 转格式 + 下载 Apple Developer ID G2 中间证书（补全链，公证必需）
openssl x509 -inform DER -in developerID_application.cer -out devid_leaf.pem
curl -fsSL -o DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
openssl x509 -inform DER -in DeveloperIDG2CA.cer -out devid_intermediate.pem
# 4. 读出签名身份字符串（= APPLE_SIGNING_IDENTITY）
openssl x509 -in devid_leaf.pem -noout -subject
# 5. 合成 .p12（LibreSSL 默认即 legacy 格式，别加 -legacy 会报 unknown option）
openssl pkcs12 -export -inkey devid.key -in devid_leaf.pem \
  -certfile devid_intermediate.pem -name "Developer ID Application: ..." -out certificate.p12
chmod 600 certificate.p12
```

### 9.3 CI 里如何用（release.yml `Import Apple Developer ID certificate` 步骤）

`APPLE_CERTIFICATE` base64 解码 → `security create-keychain` 建一次性 keychain（随机密码）→ `security import` → **`security set-key-partition-list -S apple-tool:,apple:`**（放行 codesign 免交互取私钥，缺了会挂）→ 加入搜索列表。两个 macOS 品牌任务各自使用 runner 上的一次性 keychain。正式 tag 缺少签名材料或验证失败时终止发布；只有 workflow_dispatch 验包在显式 `ALLOW_UNSIGNED_RELEASE=true` 时可以走 `.dev` ad-hoc 路径，其产物不自动发布为 Release。

⚠️ **验证是否真签了，查事实不查 job 颜色**：正式 tag 的两个 mac job 均须核对证书导入、Developer ID Authority、`Notarization approved ✓` 和 `stapler validate` 通过；发布前再核对本次安装包 manifest 的身份、大小和摘要。dispatch 的绿色 ad-hoc 验包不能替代正式签名结果。详见 gotchas §7。

2026-10-30 的 `v0.3.12` 已在合并提交 `1dbc6c1b` 上完成两品牌正式发行：[main CI 16/16](https://github.com/zhgqwx-del/ultrawork/actions/runs/41071866006)、[Release CI 8/8](https://github.com/zhgqwx-del/ultrawork/actions/runs/41073963883)，[12 个安装包](https://github.com/zhgqwx-del/ultrawork/releases/tag/v0.3.12) 已发布。两个 macOS 作业的实际公证/staple 日志和公开下载 DMG 的摘要、Developer ID、Gatekeeper、Universal 架构、名称/图标均复核通过；不把它外推为所有系统的安装升级或权限验收。完整证据与剩余项见 [testing §16](./testing.md#16-独立品牌发行版的验证adr-075)。

### 9.4 历史示例（以真实 release.yml 为准）

GitHub Actions 示例：

```yaml
# .github/workflows/build.yml
name: Build Desktop App
on:
  push:
    tags: ['v*']

jobs:
  build-macos:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.12

      - uses: dtolnay/rust-toolchain@stable

      - name: Install dependencies
        run: bun install

      - name: Build sidecar
        run: bun run build:opencode

      - name: Import certificate
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          echo $APPLE_CERTIFICATE | base64 --decode > certificate.p12
          security create-keychain -p "" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "" build.keychain
          security import certificate.p12 -k build.keychain \
            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple: \
            -s -k "" build.keychain

      - name: Build Tauri
        env:
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: bun run tauri:build

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ultrawork-macos
          path: |
            packages/client/desktop/src-tauri/target/release/bundle/dmg/*.dmg
```

---

## 十、快速参考

```bash
# ===== 本机 ARM Mac 打包（含签名）=====
export APPLE_SIGNING_IDENTITY="Developer ID Application: ..."
export APPLE_KEYCHAIN_PROFILE="ultrawork-notarize"
bun install && bun run build:opencode && bun run tauri:build

# ===== 本机 ARM Mac 打包（不签名，开发用）=====
bun install && bun run build:opencode && bun run tauri:build

# ===== 交叉编译 Mac Intel =====
rustup target add x86_64-apple-darwin
bun run build:opencode -- --target x86_64-apple-darwin
cd packages/client/desktop && bun run --bun tauri build --target x86_64-apple-darwin

# ===== Universal Binary（ARM + Intel）=====
rustup target add x86_64-apple-darwin
bun run build:opencode
bun run build:opencode -- --target x86_64-apple-darwin
cd packages/client/desktop && bun run --bun tauri build --target universal-apple-darwin

# ===== 验证产物 =====
ls packages/client/desktop/src-tauri/target/release/bundle/dmg/
codesign --verify --deep --strict /path/to/Ultrawork.app
spctl -a -vvv /path/to/Ultrawork.app
```
