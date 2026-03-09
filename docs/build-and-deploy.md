# Ultrawork 桌面应用打包指南

> 目标平台：macOS (ARM64 / x86_64) · Windows (x64) · Linux (x64/ARM64)
> 技术栈：Tauri 2 + React 19 + Vite 7 + OpenCode Sidecar (Bun compiled binary)

---

## 一、前置条件

| 工具 | 最低版本 | 检查命令 |
|------|---------|---------|
| Bun | 1.3.x | `bun --version` |
| Rust + Cargo | 1.70+ | `rustc --version && cargo --version` |
| Xcode CLI Tools | - | `xcode-select -p` |
| Apple Developer 账号 | - | [developer.apple.com](https://developer.apple.com) |

```bash
# 确认工具链
bun --version        # 1.3.10
rustc --version      # 1.94.0
cargo --version      # 1.94.0
xcode-select -p      # /Library/Developer/CommandLineTools
```

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
      "binaries/opencode-server"
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

### 4.1 一键打包（推荐）

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/ultrawork

# Step 1: 安装依赖
bun install

# Step 2: 构建 OpenCode Sidecar 二进制
bun run build:opencode

# Step 3: 设置签名环境变量
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"
export APPLE_KEYCHAIN_PROFILE="ultrawork-notarize"

# Step 4: 打包 Tauri 应用（含前端构建 + Rust 编译 + 签名 + 公证）
bun run tauri:build
```

### 4.2 分步执行（排查问题用）

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/ultrawork

# ---- Step 1: 安装依赖 ----
bun install

# ---- Step 2: 构建 Sidecar ----
bun run build:opencode
# 验证：
ls -lh packages/client/desktop/src-tauri/binaries/opencode-server-aarch64-apple-darwin
# 应为 ~114MB

# ---- Step 3: 构建前端 ----
cd packages/client/desktop
bun run build
# 验证：
ls dist/index.html  # 应存在
cd ../../..

# ---- Step 4: TypeCheck（可选但推荐）----
bun run --bun turbo run typecheck

# ---- Step 5: Tauri 编译打包 ----
cd packages/client/desktop
bun run --bun tauri build
# 首次编译 Rust 较慢（5-10分钟），后续增量编译 ~1分钟

# ---- Step 6: 验证产物 ----
ls -lh src-tauri/target/release/bundle/dmg/
ls -lh src-tauri/target/release/bundle/macos/
```

### 4.3 产物位置

```
packages/client/desktop/src-tauri/target/release/bundle/
├── dmg/
│   └── Ultrawork_0.1.0_aarch64.dmg      ← 可分发 DMG 安装包
└── macos/
    └── Ultrawork.app/                     ← 独立 .app 应用包
```

---

## 五、不签名时的临时方案

如果暂时不配置证书，未签名的 `.app` 会被 Gatekeeper 拦截。用户需要：

```bash
# 方式 1：移除 quarantine 属性（开发测试用）
xattr -cr /Applications/Ultrawork.app

# 方式 2：在 System Preferences → Privacy & Security → 点击 "仍要打开"
```

> 注意：这只适用于你自己的机器。**分发给他人必须签名+公证。**

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
> Windows 和 Linux 包建议通过 GitHub Actions CI 在对应系统上构建。

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
# 在 Windows 上：
# 前置条件：安装 Rust、Bun、Visual Studio Build Tools (C++ workload)

bun install
bun run build:opencode
cd packages/client/desktop
bun run --bun tauri build

# 产物：
# src-tauri\target\release\bundle\msi\Ultrawork_0.1.0_x64_en-US.msi
# src-tauri\target\release\bundle\nsis\Ultrawork_0.1.0_x64-setup.exe
```

> Windows 打包前需修改 `tauri.conf.json` 的 `bundle.targets`：
> ```json
> "targets": ["msi", "nsis"]
> ```

#### 方案 B：GitHub Actions CI（推荐）

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
          bun-version: 1.3.10
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

类似 Windows，推荐用 CI：

```yaml
  build-linux:
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.10
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
          bun-version: 1.3.10

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
          bun-version: 1.3.10

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
