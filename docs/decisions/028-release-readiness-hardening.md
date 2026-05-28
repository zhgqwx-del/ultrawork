# ADR-028: 发布前 Readiness 硬化 — sidecar 副本 / 凭证随机化 / 安全收紧 / MCP 启动性能

**状态**: Accepted
**日期**: 2026-05-28
**关联**: ADR-002 (OpenCode Sidecar)、ADR-013 (Channel Gateway Sidecar)、ADR-020 (Config 隔离)、ADR-026 (知识库架构)

## 背景

`chore/release-readiness-review` 分支系统过了一遍发布前 readiness review，跨 4 个独立 Explore agent 维度（macOS 打包兼容性、运行时稳定性、首次启动体验、依赖与安全）共找出 14 项已知问题，加上自审 + 端到端测试又暴露出 9 项，合计 23 项。

很多发现单独看是小修小补，但有几条触及架构层的决策需要落 ADR 留档，否则后续维护时容易"为什么这么做？"。本 ADR 把这些**架构性决策**集中记录。零散的实现细节归 CHANGELOG 不入 ADR。

## 决策一：Sidecar 副本到用户级目录（Option C）

### 问题

Tauri 的 macOS bundler 把 externalBin 拷到 `<App>/Contents/MacOS/<name>`（去 arch 后缀）。把 sidecar 路径直接写入 `~/.config/ultrawork/opencode.json` 的 MCP 配置后，遇到以下场景路径会失效：

1. 用户拖动 `.app` 到不同目录后启动
2. dev 模式跑过、再装 DMG 同机迁移
3. Migration Assistant 跨机器拷贝 `~/.config/`
4. macOS LaunchServices 路径解析异常

我们尝试过 `repair_sidecar_mcp_paths` 启动期自愈，但本质是"出问题再补"。

### 备选方案对比

| 方案 | 说明 | 用户体验 | 复杂度 |
|------|------|---------|--------|
| **A. 直接从 `.app` 运行** | sidecar binary 留在 .app 内，MCP 路径写 `.app/Contents/MacOS/<name>` | 路径随 .app 移动失效，需自愈 | 小 |
| **B. 按需下载** | sidecar 不打包进 DMG，首次使用时下载到 `~/.ultrawork/` | 首次启动需网络 + 等待下载 | 中 |
| **C. 打包进 DMG + 启动期复制** | DMG 含 sidecar binary，首次启动复制到 `~/.ultrawork/sidecars/<name>` 后再写入 MCP path | 首启快（本地拷贝几秒），路径稳定 | 中 |

C 兼具"首启即可用"和"路径稳定"，选 C。

### 实现

1. **`ensure_sidecar_copies()`**（lib.rs）在 Tauri `setup()` 早期跑，跨 `KNOWN_SIDECAR_NAMES = ["knowledge-sidecar"]` 把每个 sidecar 从源（`.app/Contents/MacOS/<name>` 生产 / `src-tauri/binaries/<name>-<target>` 开发）复制到 `~/.ultrawork/sidecars/<name>`。

2. **幂等检测**：marker 文件 `~/.ultrawork/sidecars/.<name>.source` 存源文件 `size:mtime-ns`。下次启动 token 一致就跳过拷贝；app 升级后 source 变化触发覆盖。

3. **`canonicalize_sidecar_mcp_paths()`**：迁移旧用户的 opencode.json 中 sidecar 路径到新位置。识别两种 basename：dev 风格 `<name>-<target>` 和生产风格裸 `<name>`。

4. **`resolve_sidecar_path()`** 返回 canonical 路径（`~/.ultrawork/sidecars/<name>`），fallback 到源。Tauri command `get_sidecar_path` 给前端 MCP 注册用。

### 影响

- DMG 体积约 +133 MB（Universal sidecar），磁盘上额外占用一份用户级副本约 64-130 MB
- MCP child 进程从 `~/.ultrawork/sidecars/` 启动而非 `.app` 内，签名隔离（用户级文件可被本地用户改）
- 升级路径：app 更新后 source 变 → 启动期自动覆盖用户级副本
- 极端场景：用户手动改了 `~/.ultrawork/sidecars/<name>`，marker 不会触发覆盖（仅检测 source 端变化）—— 这是 feature，方便高级用户替换调试

## 决策二：Sidecar 凭证随机化

### 问题

历史代码硬编码 OpenCode sidecar 的 basic auth 凭证为 `opencode:test123`，多处引用：
- `lib.rs:1072` HTTP health check `Authorization` header
- `lib.rs:1075` `OPENCODE_SERVER_PASSWORD` env 传给 sidecar
- `config.ts:11` 前端 `DEFAULT_CONFIG.apiPassword`
- `bridge.ts:7` Channel Gateway 调 OpenCode 的凭证（v0.1 才发现）

威胁模型：sidecar 绑 127.0.0.1，攻击面仅同机其他用户进程。但发布前应"按生产标准"处理。

### 决策

每个安装**首次启动**时随机生成 32 字节 hex（256-bit）密码，持久化到 `~/.config/ultrawork/sidecar-auth.json`：

```rust
load_or_create_sidecar_credentials() -> Result<SidecarCredentials, String>
```

- 优先级：env `ULTRAWORK_SIDECAR_PASSWORD` > 已持久化文件 > 首启生成
- 文件创建使用 `OpenOptions::mode(0o600)` 直接建（避免 `std::fs::write` 用 umask 后再 `set_permissions` 的微秒窗口）
- 前端通过 Tauri command `get_sidecar_credentials` 拿到凭证，旧 `test123` 默认自动迁移
- Gateway 通过 spawn env `OPENCODE_SERVER_PASSWORD` 拿到，bridge.ts 改 lazy 读 env

### 影响

- macOS 单用户环境基本无攻击面变化；多用户/共享 Mac 场景从"任意进程都能访问"提升到"仅 owner 用户能访问凭证文件"
- 升级路径：旧 dev 用户 localStorage 里残留 `test123` 会被自动检测 + 替换
- 测试场景：unit test 不受影响（mock api-client）；E2E / curl 需读 `~/.config/ultrawork/sidecar-auth.json` 或设 env

## 决策三：MCP 启动性能 — `CONNECT_TIMEOUT` + 急切 warm-up

### 问题

OpenCode 的 MCP `InstanceState` 是 lazy init：第一次调 `MCP.tools()` 或 `MCP.status()` 时才 spawn 所有配置的 MCP 子进程。`Effect.forEach(..., { concurrency: "unbounded" })` 虽然并行 spawn，但要等**所有任务完成**才 resolve —— 因此 init 总耗时 = 最慢 MCP 的耗时。

我们的用户实测：配了一个坏的 12306 MCP，首次发"你好"被卡 30 秒。原因是 `DEFAULT_TIMEOUT = 30_000` 全局默认导致单个坏 MCP 拖垮整体。

### 决策

**3a. Vendor patch：拆分 connect / runtime 超时**

`vendor/opencode/.../mcp/index.ts`：
```typescript
const DEFAULT_TIMEOUT = 30_000   // 保留，runtime tool 调用合理
const CONNECT_TIMEOUT = 5_000    // 新增，专给 MCP 启动连接
```

`mcp.timeout ?? CONNECT_TIMEOUT` 用在两处 connectTransport 调用（line 320, 403）。listTools / tool 执行保持 30s 不变。

收益：坏 MCP 最长拖 5s 而非 30s；健康 MCP（典型 <1s）几乎无影响。

**3b. Tauri 端 eager warm-up**

`warm_opencode_mcp(port, auth_header)` 在 OpenCode `/global/health` 通过后启 background 线程，500ms 延时后 fire 一次 `GET /mcp` 触发服务端 `InstanceState.get` 急切 init。

`InstanceState` 是 per-directory（`ScopedCache` 用 `Instance.directory` 当 key），warm 目标必须匹配用户实际进入的工作区，否则 cache key 不对失败：
- 选 `~/.ultrawork/workspace/`（首次安装的默认 workspace，也是返回用户找不到记录时的 fallback）
- 自定义 workspace 用户依赖前端 `getMCP` 触发 init，patch B 已经把 cold init 控制在 sub-second

### 影响

- 第一次发消息体感时延（健康配置）：实测从 3-5s 降到 <1s
- 一个坏 MCP 不再拖 30s，最多 5s（可被 mcp 配置里的 `timeout` 字段进一步覆盖）
- 用户级 workspace 变化时仍可能有 sub-second 冷启动，前端 fetchMCP 重试逻辑（2/4/8s 三轮）兜住

## 决策四：MCP 配置写入路径收敛

### 问题

`use-knowledge-base.ts` 的 `ensureMCPRegistered` 之前同时调：

1. `invoke("write_mcp_config")` → 写全局 `~/.config/ultrawork/opencode.json` ✅ 符合 ADR-020 原则
2. `api.patchConfig` → 走 OpenCode `PATCH /config`，**把同样配置写到工作区 opencode.json**

第 2 步违反 ADR-020 "MCP 配置统一全局化"。每个工作区被污染一份重复 MCP 条目；切换工作区时配置散落多处。

### 决策

删除 `api.patchConfig` 调用。保留 `api.createMCP`（POST /mcp 仅运行时注册，不持久化），用于运行 OpenCode 不重启就能加载新 MCP。

### 影响

- workspace `opencode.json` 不再被写 MCP 段；保留 `model` / `provider` / `skills`（per-workspace 合理设置）
- 老用户的 workspace opencode.json 残留 MCP 条目不影响功能（OpenCode 合并 global + workspace 配置），可手动清理

## 决策五：网络与权限收紧

### 决策

1. **Bun.serve 显式 hostname**：Gateway / Knowledge sidecar 从默认 0.0.0.0 改为显式 `hostname: "127.0.0.1"`，关闭 LAN 暴露
2. **Tauri capability 去过宽权限**：default.json 去掉 `shell:default` / `shell:allow-spawn` / `shell:allow-execute` 及全部 `fs:*`（前端 grep 验证不直接调用对应 plugin）。保留 `core:default` / `dialog:default` / `dialog:allow-open` / `opener:default` / `core:window:allow-start-dragging`
3. **opencode.json 原子写 + Mutex**：跨进程拷贝时 tmp 文件名带 pid + nanos，rename(2) 同盘原子。Process 内 `OPENCODE_JSON_LOCK` 串行化 RMW 流程

### 影响

- sidecar 不再暴露给同 LAN 其他主机
- 前端只能通过我们显式定义的 Tauri command 调系统能力（最小权限）
- MCP 配置并发更新不再损坏 JSON 或丢更新

## 决策六：sidecar 健康检查失败显式反馈

`start_sidecar` 健康检查超时（15s）以前静默返回 Ok。改为：

- 主动 `kill` 残留 pid + 从 `SIDECAR_REGISTRY` 移除
- 返回 Err
- 非关键 sidecar（Gateway / Knowledge）发 `sidecar-startup-failed` Tauri event，前端可监听（监听器留 v1.1）
- 关键 sidecar（OpenCode）保留之前的 blocking dialog 行为

## Universal DMG 构建链路

不算架构决策，但本轮新增的工程能力值得记录：

1. `build-gateway.ts` / `build-knowledge.ts` / `build-opencode.ts` 都接受 `--target=<triple>` 参数，跨编译当前不在的架构
2. Vendor patch 让 OpenCode build 支持 `--target=<os>-<arch>` 单 target 模式（避免跨编译时跑 native smoke test 失败连累整体）
3. `build-release.ts` 在 macOS 默认 `universal-apple-darwin` 目标，调 `lipo -create` 把双架构 sidecar 合并成 universal 二进制再 ad-hoc 签名
4. `--unsigned` 模式：跳过 Apple Developer ID 检查，产物 ad-hoc 签名；用户端解 quarantine 后可装
5. `setup.sh` 在 Apple Silicon 主机首启自动 `rustup target add x86_64-apple-darwin`

## 已知遗留 / v1.1+

- **未真正 Intel Mac 测试**：交叉编译产物只在 Apple Silicon 主机上 build 验证过，没在真 Intel 上跑
- **Apple Developer ID + Notarization**：build-release.ts 流程齐备，但实际签名链路需要付费账号，目前用 `--unsigned`
- **xlsx 0.18.5 依赖漏洞**：SheetJS 已停止 npm 发布，需切换 exceljs 或从官方 CDN 安装
- **Provider 配置全局化**：当前 model-dialog.tsx 仍走 `api.patchConfig` 写工作区。讨论后留观察期再处理
- **MCP InstanceState 真并行**：当前 lazy init 仍阻塞首请求；patch B + warm-up 已把延时降到可接受。彻底并行需重写 OpenCode `MCP.tools()` 设计

## 关联 commit（按修复合并顺序）

```
6a707aa build: macOS Universal DMG support — cross-compile sidecars for arm64 + x86_64
0670289 feat: randomize sidecar credentials — replace hardcoded opencode:test123
1530714 chore: release-readiness backend hardening
a0d4a82 docs+chore: README cleanup checklist, locale detection, drop stray file
1c0dbc9 fix: post-review follow-ups — gateway creds, atomic write, perm race
11bd285 fix: poll WeChat channel status after add so UI catches the connect
79307c0 fix: WeChat adapter — flip to "connected" before first getUpdates returns
177989a fix: dev test scripts read sidecar-auth.json instead of hardcoded test123
832a025 fix: stop duplicating MCP config to workspace + heal stale sidecar paths
a1cc4ca fix: actually produce a working universal DMG
89b088b chore: rename bundle identifier + auto-install Rust x86_64 target
119e0ff refactor: copy sidecars to ~/.ultrawork/sidecars (Option C)
bef9b07 fix: MCP panel — show enabled MCPs optimistically + retry on startup race
6a52d2e fix: cap MCP connect timeout to 5s so one broken server doesn't stall init
5a92e92 fix: warm up OpenCode MCP from Tauri so first prompt isn't slow
93ed5d2 fix: warm the default workspace, not home, since MCP state is per-dir
```
