# ADR-069：CI macOS 代码签名 —— openssl 自签 CSR + 一次性 keychain 导入

- 状态：已接受（**CI 端到端验证通过**，2026-07-26 / v0.3.3：`Notarization approved ✓` + `Stapled ✓`）
- 日期：2026-07-26
- 相关：ADR-037（跨平台）· ADR-046（Windows 打包）· gotchas §7 · build-and-deploy §九

## 背景

`release.yml` 早已在 macOS 构建步骤设了 `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 四个环境变量，并按 `APPLE_SIGNING_IDENTITY` 是否非空来决定走 `bun run release`（签名）还是 `bun run release --unsigned`。

**但从未把 `.p12` 证书导入 runner 的 keychain。** GitHub runner 是干净机器，keychain 里没有 Developer ID 证书 —— `codesign`（由 tauri 调用）查不到签名身份，签名必然失败或静默退回 unsigned。也就是说：**即使把四个 secret 全配上，这份 workflow 也签不出签名包。** 文档 §8.5 / §九 里那段 `Import Apple certificate` 示例从未同步进真实的 `release.yml`（文档与实现漂移）。

## 决策

### D1：openssl 全命令行签发证书，而非钥匙串 GUI

本机生成私钥 + CSR（`openssl req -new -newkey rsa:2048 -nodes`），上传 Apple 门户换 `Developer ID Application` 证书，再用 `openssl pkcs12 -export` 把「叶子 + 私钥 + Developer ID G2 中间证书」合成一个 `certificate.p12`。

为什么不走钥匙串 Certificate Assistant：openssl 路径下私钥是一个受控文件，能直接打进 `.p12` 喂 CI；GUI 路径要先入钥匙串再导出，多一层且不可脚本化。**中间证书必须打进 `.p12`**（`-certfile DeveloperIDG2CA.pem`），否则 CI 上证书链不完整、公证会失败。

### D2：CI 里导入一次性 keychain，而非污染 login keychain

新增 `Import Apple Developer ID certificate` 步骤：`APPLE_CERTIFICATE`（base64 的 `.p12`）base64 解码 → `security create-keychain` 建临时 keychain（随机密码 `openssl rand`）→ `security import` → **`security set-key-partition-list -S apple-tool:,apple:`**（放行 codesign 免交互取私钥，缺了会在签名时挂起/失败）→ `security list-keychains -s` 把它加进搜索列表（保留原有项）。`set-keychain-settings -lut 21600` 保证 6h 不自动上锁，跨到后续构建步骤仍可用。

secret 缺失时脚本 `exit 0` no-op，构建退回 `--unsigned`，与既有分支逻辑一致 —— 不破坏无 secret 的 fork / workflow_dispatch 验证构建。

### D3：不用 tauri-action

项目发布走自研 `scripts/build-release.ts`（Universal lipo + 双架构 sidecar + DMG 布局守卫 + 公证/stapler），已深度定制。tauri-action 会另起一套构建流程、与现有脚本冲突，收益仅是省掉这段导入脚本 —— 不划算。

## 凭据与 Secret（6 个，仓库级）

| Secret | 内容 | 来源 |
|---|---|---|
| `APPLE_CERTIFICATE` | `.p12` 的 base64（`base64 -i certificate.p12`） | 本机合成 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设的密码 | 本机自设 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: <名字> (<TEAMID>)` | 证书 subject CN |
| `APPLE_ID` | 开发者 Apple ID 邮箱 | — |
| `APPLE_PASSWORD` | App 专用密码（**非** Apple ID 登录密码） | appleid.apple.com |
| `APPLE_TEAM_ID` | 10 位 Team ID | 证书 subject / Membership |

## 明确不做

- **Windows 签名**：2023 年 6 月 CA/B 新规后 OV 证书必须驻留硬件令牌 / 云 HSM，不能作为文件塞进 GitHub secret。CI 签 Windows 的现实路线是 Azure Trusted Signing（云签名，~$9.99/月，官方 Action）。留待第二阶段。Windows 不签名不是硬门槛（SmartScreen「更多信息 → 仍要运行」可点过），不像 mac Gatekeeper 硬拦。
- **App Store Connect API Key 公证**：notarytool 也支持 API Key 方式，但 App 专用密码路径更简单且已验证，暂不切换。

## 已知残余

- **证书 5 年后过期**（本张到 2031-07-27）：到期需重新签发 + 更新 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` 两个 secret。
- **改 Apple ID 登录密码会作废全部 App 专用密码**：公证会 401，需重新生成并更新 `APPLE_PASSWORD`（其他 secret 不受影响）。
- **Node.js 20 弃用告警**：`actions/checkout@v4` 等被强制跑在 Node 24，暂不影响；GitHub 将来移除 Node20 时需升 action 版本。

## 验证（v0.3.3，CI 实测）

逐条查**事实本身**（非只看 job 绿 —— unsigned 回退也会绿）：

- 导入步骤真实输出 `1 valid identities found`（走了签名分支）
- `bun run release` 分支执行，`APPLE_SIGNING_IDENTITY` 已传入
- `📤 Submitting for notarization: Ultrawork_0.3.3_universal.dmg`
- `Notarization approved ✓` · `Stapled ✓` · `The staple and validate action worked!`
- Release 页面（非草稿）挂上 6 个安装包，含已签名+公证的 `Ultrawork_0.3.3_universal.dmg`

含义：下载即可打开，无需 `xattr -dr com.apple.quarantine`。secret 长期保留，此后打 `v*` tag 即自动出签名包（前提：secret 在、证书未过期、App 专用密码有效）。
