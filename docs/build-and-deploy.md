# Ultrawork 桌面应用打包指南

<!-- last-synced: 2026-06-27 -->

> 目标平台：macOS (ARM64 / x86_64) · Windows (x64) · Linux (x64/ARM64)
> 技术栈：Tauri 2 + React 19 + Vite 7 + OpenCode Sidecar (Bun compiled binary)
> **想快速上手 → 直接看下面 §〇 三平台速查**。§二–§七 是 macOS 签名/公证细节，§八–§九 是交叉编译与 CI。三平台兼容背景见 ADR-037。

---

## 〇、三平台速查（dev / build / 安装包）

> 一页覆盖 macOS / Windows / Linux 的「开发模式」与「打包模式」。跨平台兼容已系统落地（ADR-037）。

### 0.1 前置依赖（每台机器装一次）

| 平台 | 必装 |
|---|---|
| **全部** | **Bun**（bun.sh）、**Rust**（rustup / cargo）、**Git** |
| **macOS** | Xcode CLT：`xcode-select --install`。Apple Silicon 要出 Universal 包另需 `rustup target add x86_64-apple-darwin`（`setup` 会自动加）。签名/公证细节见 §二–§三 |
| **Windows** | ① **Visual Studio Build Tools 2022**（勾「使用 C++ 的桌面开发」——含 MSVC 链接器 + `rc.exe`，**winres 嵌图标必需，缺了打包失败**）② **WebView2 Runtime**（Win10 1803+/Win11 内置，否则装 Evergreen）③ NSIS/WiX 由 Tauri 自动下载，无需手装 |
| **Linux**（Debian/Ubuntu） | `sudo apt update && sudo apt install -y libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf libgtk-3-dev` |

### 0.2 开发模式（dev）

**首次**（自动：检查工具 → 拉 submodule → apply patch → `bun install`(根+vendor) → 编 4 个 sidecar → 起 dev）：

| 平台 | 命令 |
|---|---|
| macOS / Linux | `./setup.sh --dev` &nbsp;或&nbsp; `bun run setup --dev` |
| Windows | `bun run setup --dev`（Windows 无 bash，必须用这个跨平台入口 `scripts/setup.ts`） |

**之后日常迭代**（sidecar 已编好）：`bun run tauri:dev`
- 改了某个 sidecar 源码 → 单独重编 `bun run build:gateway`（/`build:knowledge`/`build:acp`）；`opencode` 随 `tauri:dev` 自动增量重编
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
| **Windows** | `bun run release`（= 编 sidecar + `tauri build`，不碰 Apple 签名） | `.msi` + `*-setup.exe`(NSIS) |
| **Linux** | `bun run release` | `.deb` + `.rpm`（AppImage 暂跳过，CI 上 linuxdeploy/FUSE 不稳，见 ADR-037） |

> **A vs B**：A/`tauri:build` = 当前架构、不签名、快（日常本地验证）；B/`release` 在 mac 上是 Universal 双架构 + 可签名公证（对外分发），win/linux 上两者基本一样。`--force-build` 可强制全重编 sidecar（默认 hash 增量缓存，重跑很快）。

### 0.4 产物位置

| 入口 | 输出根目录 |
|---|---|
| `tauri:build` / `setup --build`（无 `--target`） | `packages/client/desktop/src-tauri/target/release/bundle/` |
| `release`（带 `--target`，mac 为 `universal-apple-darwin`） | `…/target/<triple>/release/bundle/` |

子目录：mac → `dmg/*.dmg`、`macos/*.app`；Windows → `msi/*.msi`、`nsis/*-setup.exe`；Linux → `deb/*.deb`、`rpm/*.rpm`（AppImage 暂跳过）。

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
# 一路过到 winres 因缺宿主 llvm-rc 停 = 正常；前面依赖/代码/codegen 全过即说明 Rust 侧 OK
```

**最省心 = 让 CI 跑**（不用自己备三台机器）：push 触发 `.github/workflows/ci.yml`（三平台 typecheck+test+`cargo test`）；打 `v*` tag 触发 `release.yml`（三平台直接产 dmg/msi/nsis/deb/rpm，下载 artifact 装机验证）。

---

## 一、前置条件

| 工具 | 最低版本 | 检查命令 |
|------|---------|---------|
| Bun | 1.3.x | `bun --version` |
| Rust + Cargo | 1.70+ | `rustc --version && cargo --version` |
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
      "icons/icon.icns",
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

1. 检查环境变量（`APPLE_SIGNING_IDENTITY` / `APPLE_ID` 等，可选）
2. 双架构编译四个 sidecar（OpenCode / Gateway / Knowledge / ACP Client）— `aarch64-apple-darwin` + `x86_64-apple-darwin`
3. `lipo -create` 合并每个 sidecar 成 universal binary（`<name>-universal-apple-darwin`），ad-hoc 重签
4. `tauri build --target universal-apple-darwin` 编译 Rust 端 + 前端 + lipo 主二进制 + 打包 `.app` + 打包 DMG
5. 验证签名 / 公证（如配置）/ stapler

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
| `--skip-sidecar` | 跳过 sidecar 编译（dev 调试 Tauri/前端时省时间） |
| `--skip-notarize` | 跳过公证（签名仍执行） |
| `--native` | 只编译当前架构（不出 Universal）。CI 调试用 |
| `--verbose` | 显示底层 tauri/cargo 输出 |

### 4.4 产物位置

```
packages/client/desktop/src-tauri/target/universal-apple-darwin/release/bundle/
├── dmg/
│   └── Ultrawork_0.1.0_universal.dmg      ← 可分发 DMG（含 arm64 + x86_64）
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
# src-tauri/target/x86_64-apple-darwin/release/bundle/dmg/Ultrawork_0.1.0_x64.dmg
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
# src-tauri/target/universal-apple-darwin/release/bundle/dmg/Ultrawork_0.1.0_universal.dmg
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
# src-tauri\target\release\bundle\msi\Ultrawork_0.1.0_x64_en-US.msi
# src-tauri\target\release\bundle\nsis\Ultrawork_0.1.0_x64-setup.exe
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

## 九、CI/CD 自动打包（可选）

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
