# ADR-020: Ultrawork 与 OpenCode 配置隔离
**状态**: Accepted
**日期**: 2026-04-20
**最后更新**: 2026-05-28（发布前 readiness review：sidecar 凭证随机化 + 工作区 opencode.json 不再被 MCP 写入）
**关联**: ADR-002 (OpenCode Sidecar), ADR-028 (release-readiness 硬化)

## 2026-05-28 更新（详见 ADR-028）

> **Sidecar 凭证随机化**：之前硬编码 `opencode:test123`（多处引用：lib.rs basic auth header + `OPENCODE_SERVER_PASSWORD` env + 前端 `DEFAULT_CONFIG` + Gateway bridge.ts），现在改首启随机生成 32 字节 hex，持久化到 `~/.config/ultrawork/sidecar-auth.json`（Unix 0600 权限）。前端通过 `get_sidecar_credentials` Tauri command 读取，旧 `test123` 自动迁移。`ULTRAWORK_SIDECAR_PASSWORD` env 可覆盖（不持久化）。
>
> **MCP 配置写入路径收敛**：本 ADR 已声明"MCP 配置只读写全局 opencode.json"，但 `useKnowledgeBase.ensureMCPRegistered` 之前仍调 `api.patchConfig` 把 MCP 写到工作区 opencode.json（违反约定）。已删除该调用，仅保留 `write_mcp_config` 全局写入 + `api.createMCP` 运行时注册。老用户工作区 opencode.json 残留 MCP 段不影响功能（OpenCode 合并 global + workspace），可手动清理。

## 背景

Ultrawork 使用 vendor/opencode 作为核心 sidecar 服务。OpenCode 遵循 XDG Base Directory 规范管理全局配置、数据、缓存和状态，app 名称硬编码为 `"opencode"`（`global/index.ts:7`）。

这意味着同一台机器上，**任何使用 OpenCode 的客户端（CLI、Ultrawork、其他集成）都读写同一组文件**。当用户在 OpenCode CLI 中配置了 provider、MCP 服务、skills 等，Ultrawork 会直接看到这些配置——反之亦然。

### 共享路径清单

| 分类 | macOS 默认路径 | 关键文件 |
|------|---------------|---------|
| config | `~/.config/opencode/` | `opencode.json`、`config.json`、`opencode.jsonc`、`AGENTS.md`、TUI 配置 |
| data | `~/.local/share/opencode/` | `opencode.db`（SQLite）、`auth.json`（Provider 认证）、`mcp-auth.json`（MCP OAuth）、`snapshot/`、`plans/`、`worktree/`、`storage/`、`tool-output/`、`log/` |
| cache | `~/.cache/opencode/` | `models.json`、`skills/`、`bin/`（下载的二进制） |
| state | `~/.local/state/opencode/` | `plugin-meta.json`、`locks/`（文件锁） |
| home | `~/.opencode/` | `agents/`、`commands/`、`modes/`、`plugins/`、`opencode.json`、`opencode.jsonc` |
| managed (macOS) | `/Library/Application Support/opencode/` | 企业 MDM 推送配置 |
| MDM plist | `/Library/Managed Preferences/ai.opencode.managed.plist` | macOS .mobileconfig 部署 |

### 影响

1. **Provider 泄漏**：CLI 中配置的 API Key / Provider 会出现在 Ultrawork 的模型列表中
2. **MCP 冲突**：CLI 注册的 MCP 服务会出现在 Ultrawork 中（可能启动失败或行为异常）
3. **Skills 混入**：CLI 安装的 skills 会出现在 Ultrawork 的命令列表中
4. **数据库共享**：Session、消息历史混在一起
5. **锁文件冲突**：两个实例竞争同一 `locks/` 目录，可能导致死锁
6. **认证混乱**：`auth.json` 和 `mcp-auth.json` 中的凭证互相覆盖

### 代码路径全景扫描

除了通过 `Global.Path.*` 引用的路径外，vendor 源码中还存在以下**不走 `Global.Path` 的硬编码 `"opencode"` / `".opencode"` 引用**：

#### A. 不走 `Global.Path` 的系统级路径

| 文件 | 行号 | 代码 | 说明 |
|------|------|------|------|
| `config/config.ts` | 65-69 | `"/Library/Application Support/opencode"` 等 | `systemManagedConfigDir()` — 企业 MDM 目录 |

#### B. 工作区 / 项目级 `.opencode` 引用（属于项目，有意共享）

| 文件 | 行号 | 代码 | 说明 |
|------|------|------|------|
| `session/index.ts` | 240 | `path.join(Instance.worktree, ".opencode", "plans")` | 工作区 plans 目录 |
| `project/project.ts` | 158, 225 | `pathSvc.join(dir, "opencode")` / `path.join(worktree, ".git", "opencode")` | `.git/opencode` 缓存文件 |
| `plugin/install.ts` | 337 | `path.join(root, ".opencode")` | 本地插件安装目录（root = worktree） |
| `cli/cmd/agent.ts` | 90 | `path.join(Instance.worktree, ".opencode")` | Agent scope 定义 |
| `cli/cmd/mcp.ts` | 388 | `path.join(baseDir, ".opencode", "opencode.json")` | MCP 配置发现 |
| `agent/agent.ts` | 137 | `path.join(".opencode", "plans", "*.md")` | 权限规则 |
| `cli/cmd/tui/plugin/runtime.ts` | 163, 754 | `.opencode/themes`、`.opencode/tui.json` | TUI 主题/配置（CLI only） |

这些都以 `Instance.worktree`（工作区根目录）为基准，属于**项目级配置**，多客户端共享是正确行为，**不需要隔离**。

#### C. Home 目录 `.opencode` 引用

| 文件 | 行号 | 代码 | 说明 |
|------|------|------|------|
| `config/paths.ts` | 27-33 | `Filesystem.up({ targets: [".opencode"], start: Global.Path.home, ... })` | 搜索 `~/.opencode/` |

这是**用户级**配置（全局 agents/commands/modes/plugins），需要隔离。

#### D. `.opencode` 字符串匹配 / 过滤条件

| 文件 | 行号 | 代码 | 说明 |
|------|------|------|------|
| `config/config.ts` | 1351 | `if (dir.endsWith(".opencode") \|\| dir === Flag.OPENCODE_CONFIG_DIR)` | 决定是否从目录加载 `opencode.json` |
| `config/tui.ts` | 102, 119 | `if (!dir.endsWith(".opencode") && dir !== Flag.OPENCODE_CONFIG_DIR) continue` | TUI 配置目录过滤 |
| `file/ripgrep.ts` | 295 | `if (file.includes(".opencode")) continue` | ripgrep 搜索排除 |
| `cli/cmd/tui/plugin/runtime.ts` | 161 | `if (path.basename(source_dir) === ".opencode")` | TUI 插件目录判断 |
| `cli/cmd/uninstall.ts` | 218, 269-301 | `.opencode/bin` 相关检测 | CLI 卸载逻辑 |

---

## 方案分析

### 方案 A：设置 XDG 环境变量（零 vendor 改动）

**原理**：Sidecar 是独立进程。在 spawn 时注入自定义 XDG 环境变量，将所有路径重定向到 Ultrawork 专属目录。

**Rust 侧改动**（`lib.rs` sidecar 启动处）：
```rust
&[
    ("OPENCODE_SERVER_PASSWORD", "test123"),
    ("XDG_CONFIG_HOME", "~/.ultrawork/xdg/config"),
    ("XDG_DATA_HOME",   "~/.ultrawork/xdg/data"),
    ("XDG_CACHE_HOME",  "~/.ultrawork/xdg/cache"),
    ("XDG_STATE_HOME",  "~/.ultrawork/xdg/state"),
]
```

**隔离效果**：
- Config → `~/.ultrawork/xdg/config/opencode/`
- Data → `~/.ultrawork/xdg/data/opencode/`
- Cache → `~/.ultrawork/xdg/cache/opencode/`
- State → `~/.ultrawork/xdg/state/opencode/`

**评估**：

| 维度 | 评价 |
|------|------|
| vendor 改动 | ✅ 零改动 |
| 隔离完整性 | ⚠️ `~/.opencode/`（home 目录 agents/plugins）未覆盖 |
| 路径语义 | ⚠️ 路径冗余（`~/.ultrawork/xdg/config/opencode/`，多一层 `opencode/`） |
| 副作用 | ⚠️ XDG 变量影响 sidecar 进程内所有 XDG 库（虽然目前只有 opencode 使用） |
| 升级兼容 | ✅ 无 merge 冲突 |
| `~/.opencode/` 处理 | 需额外设 `OPENCODE_DISABLE_PROJECT_CONFIG=true`，但这也会禁掉工作区 `opencode.json` 加载（副作用过大） |

### 方案 B：Patch `app` 名称为环境变量可配置（最小 vendor 改动）

**原理**：在 `global/index.ts` 中让 `app` 名称通过 `OPENCODE_APP_NAME` 环境变量覆盖。Sidecar 启动时注入 `OPENCODE_APP_NAME=ultrawork`。

**Vendor patch（1 行）**：
```typescript
// vendor/opencode/packages/opencode/src/global/index.ts:7
// 改前
const app = "opencode"
// 改后
const app = process.env.OPENCODE_APP_NAME || "opencode"
```

**隔离效果**：
- Config → `~/.config/ultrawork/`
- Data → `~/.local/share/ultrawork/`
- Cache → `~/.cache/ultrawork/`
- State → `~/.local/state/ultrawork/`

**评估**：

| 维度 | 评价 |
|------|------|
| vendor 改动 | ⚠️ 1 行（`global/index.ts`），但 `systemManagedConfigDir` 和 `paths.ts` 中的 `.opencode` 硬编码未覆盖 |
| 隔离完整性 | ⚠️ 覆盖 XDG 下所有路径，但 `~/.opencode/` 和 managed dir 需额外处理 |
| 路径语义 | ✅ 干净（`~/.config/ultrawork/`） |
| 副作用 | ✅ 仅影响 opencode 自身路径 |
| 升级兼容 | ✅ 冲突概率极低（变量赋值行） |

### 方案 C：仅用现有环境变量（`OPENCODE_CONFIG_DIR` + `OPENCODE_DB`）

**原理**：利用 OpenCode 已提供的配置覆盖机制。

**环境变量**：
```
OPENCODE_CONFIG_DIR=~/.ultrawork/config
OPENCODE_DB=~/.ultrawork/data/opencode.db
```

**评估**：

| 维度 | 评价 |
|------|------|
| vendor 改动 | ✅ 零改动 |
| 隔离完整性 | ❌ **严重不足** — 仅控制配置文件加载和数据库路径 |
| 未覆盖 | `auth.json`、`mcp-auth.json`、`snapshot/`、`plans/`、`worktree/`、`skills/` 缓存、`locks/`、`plugin-meta.json`、`tool-output/`、`log/` 全部仍走共享路径 |
| 可维护性 | ❌ OpenCode 未来新增路径引用时自动漏掉 |

**结论**：方案 C 隔离不完整，不推荐。

### 方案对比总结

| | 方案 A (XDG env) | 方案 B (patch app) | 方案 C (现有 env) |
|---|---|---|---|
| Vendor 改动量 | 0 行 | 1 行 | 0 行 |
| 隔离完整性 | 90%（缺 `~/.opencode/`） | 85%（缺 managed dir + `~/.opencode/`） | 30%（仅 config + DB） |
| 路径美观 | ⚠️ 冗余 | ✅ 干净 | N/A |
| 副作用风险 | ⚠️ 全局 XDG 覆盖 | ✅ 精确控制 | ✅ 无 |
| 未来兼容性 | ✅ 新路径自动跟随 | ✅ 新路径自动跟随 | ❌ 需逐个添加 |

---

## 决策

**采用方案 B 增强版**：以 `OPENCODE_APP_NAME` 环境变量为核心，补齐 managed dir 和 home dot-dir 两个遗漏点。

### 设计原则

1. **一个 env var 控制全局**：`OPENCODE_APP_NAME` 作为唯一隔离开关
2. **不设则不变**：env var 未设时所有行为退回 `"opencode"`，对 CLI 用户零影响
3. **工作区配置有意共享**：`{workspace}/opencode.json` 和 `{workspace}/.opencode/` 不隔离——它们属于项目，不属于客户端
4. **MDM plist 暂不改**：`ai.opencode.managed` 是企业管理场景，Ultrawork 当前不涉及

---

## 改动清单

### Vendor patch（4 处，~12 行）

#### Patch 1：`vendor/opencode/packages/opencode/src/global/index.ts:7`

`app` 名称从硬编码改为读取 `OPENCODE_APP_NAME` 环境变量。

```typescript
// 改前
const app = "opencode"

// 改后
const app = process.env.OPENCODE_APP_NAME || "opencode"
```

**影响范围**：所有通过 `Global.Path.*` 引用的路径自动切换命名空间。包括：
- `Global.Path.config`（config 目录）
- `Global.Path.data`（data 目录 — DB、auth、snapshots 等）
- `Global.Path.cache`（cache 目录 — models、skills、bin）
- `Global.Path.state`（state 目录 — plugin-meta、locks）
- `Global.Path.log`（log 目录）
- `Global.Path.bin`（bin 目录）

#### Patch 2：`vendor/opencode/packages/opencode/src/config/config.ts:62-71`

`systemManagedConfigDir()` 函数不走 `Global.Path`，独立硬编码了 `"opencode"`，需同步修改。

```typescript
// 改前
function systemManagedConfigDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/opencode"
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", "opencode")
    default:
      return "/etc/opencode"
  }
}

// 改后
function systemManagedConfigDir(): string {
  const name = process.env.OPENCODE_APP_NAME || "opencode"
  switch (process.platform) {
    case "darwin":
      return `/Library/Application Support/${name}`
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", name)
    default:
      return `/etc/${name}`
  }
}
```

#### Patch 3：`vendor/opencode/packages/opencode/src/config/paths.ts:15-36`

home 目录搜索需要隔离。**原方案是将搜索目标改为 `.ultrawork`，但 review 发现存在问题**（见下方"Review 发现的问题"），改为：当 `OPENCODE_APP_NAME` 设置时**跳过 home 目录搜索**。

```typescript
// 改前
export async function directories(directory: string, worktree: string) {
  return [
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".opencode"],
            start: directory,
            stop: worktree,
          }),
        )
      : []),
    ...(await Array.fromAsync(
      Filesystem.up({
        targets: [".opencode"],
        start: Global.Path.home,
        stop: Global.Path.home,
      }),
    )),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ]
}

// 改后
export async function directories(directory: string, worktree: string) {
  return [
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".opencode"],
            start: directory,
            stop: worktree,
          }),
        )
      : []),
    // When running as an embedded app (OPENCODE_APP_NAME set), skip home
    // directory search — the app manages agents/plugins through its own UI,
    // and reusing ~/.opencode/ would leak CLI user configurations.
    ...(!process.env.OPENCODE_APP_NAME
      ? await Array.fromAsync(
          Filesystem.up({
            targets: [".opencode"],
            start: Global.Path.home,
            stop: Global.Path.home,
          }),
        )
      : []),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ]
}
```

#### Patch 4：`vendor/opencode/packages/opencode/src/config/config.ts:1351`（新增）

`endsWith(".opencode")` 过滤条件需要同步考虑 `OPENCODE_APP_NAME` 场景。虽然 Patch 3 改为跳过 home 搜索后此处不会收到 `~/.ultrawork`，但工作区 `.opencode/` 目录仍然会命中此过滤。如果未来 Patch 3 策略调整（比如恢复为搜索 `~/.ultrawork/`），此处就会成为隐患。**为防御性目的，同步修改**：

```typescript
// 改前
if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {

// 改后
if (dir.endsWith(".opencode") ||
    (process.env.OPENCODE_APP_NAME && dir.endsWith(`.${process.env.OPENCODE_APP_NAME}`)) ||
    dir === Flag.OPENCODE_CONFIG_DIR) {
```

> **Note**：`config/tui.ts:102,119` 中有类似的 `endsWith(".opencode")` 过滤条件，但 TUI 是 CLI-only 功能，Ultrawork 以 server 模式运行，不走 TUI 代码路径，**无需修改**。

### 自有代码改动（2 处，~5 行）

#### 改动 5：`packages/client/desktop/src-tauri/src/lib.rs` — sidecar 启动注入 env var

在文件顶部新增常量，sidecar 启动时传入：

```rust
// 文件顶部（与 OPENCODE_PORT 并列）
const OPENCODE_APP_NAME: &str = "ultrawork";

// lib.rs:849 — sidecar env_vars 参数
// 改前
&[("OPENCODE_SERVER_PASSWORD", "test123")],

// 改后
&[
    ("OPENCODE_SERVER_PASSWORD", "test123"),
    ("OPENCODE_APP_NAME", OPENCODE_APP_NAME),
],
```

#### 改动 6：`packages/client/desktop/src-tauri/src/lib.rs:733-738` — `global_config_dir()` 对齐

前端通过 `invoke("get_global_config_dir")` 调用此函数（Browser MCP 写全局配置用），必须与 sidecar 看到的路径一致。

```rust
// 改前
fn global_config_dir() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(val) if !val.is_empty() => PathBuf::from(val).join("opencode"),
        _ => dirs::home_dir().unwrap().join(".config").join("opencode"),
    }
}

// 改后
fn global_config_dir() -> PathBuf {
    match std::env::var("XDG_CONFIG_HOME") {
        Ok(val) if !val.is_empty() => PathBuf::from(val).join(OPENCODE_APP_NAME),
        _ => dirs::home_dir().unwrap().join(".config").join(OPENCODE_APP_NAME),
    }
}
```

### 无需改动的部分

| 位置 | 原因 |
|------|------|
| `session/instruction.ts:29` — `AGENTS.md` 搜索 | 使用 `Global.Path.config`，Patch 1 后自动指向新路径 |
| `storage/db.ts:33` — 数据库路径 | 使用 `Global.Path.data`，Patch 1 后自动指向新路径 |
| `auth/index.ts:10` — `auth.json` | 使用 `Global.Path.data`，同上 |
| `mcp/auth.ts:34` — `mcp-auth.json` | 使用 `Global.Path.data`，同上 |
| `config/config.ts:1234-1236` — 全局配置加载 | 使用 `Global.Path.config`，同上 |
| `config/config.ts:79` — MDM plist domain | `ai.opencode.managed` 是系统级 MDM 标识符，Ultrawork 不涉及 MDM，暂不改 |
| `config/tui.ts:102,119` — TUI 目录过滤 | CLI-only 的 TUI 代码路径，server 模式不执行 |
| `file/ripgrep.ts:295` — `.opencode` 排除 | ripgrep 搜索在工作区范围内，`~/.ultrawork/` 不在搜索范围内 |
| `cli/cmd/uninstall.ts` — `.opencode/bin` 检测 | CLI 卸载逻辑，server 模式不执行 |
| `session/index.ts:240` — 工作区 `.opencode/plans` | 工作区级，有意共享 |
| `project/project.ts:158,225` — `.git/opencode` 缓存 | Git 内部缓存，项目级 |
| `plugin/install.ts:337` — 本地 `.opencode` 目录 | 工作区级插件安装，有意共享 |
| `agent/agent.ts:137` — `.opencode/plans` 权限规则 | 工作区级权限，有意共享 |
| `cli/cmd/agent.ts:90`、`cli/cmd/mcp.ts:388` | CLI 命令，server 模式不执行 |
| `use-browser-mcp.ts:59` — 前端全局配置目录 | 通过 `invoke("get_global_config_dir")` 获取，改动 6 后自动对齐 |
| Channel Gateway | 独立配置体系（`~/.ultrawork/channels.json`），不受影响 |
| 工作区 `opencode.json` | 有意共享，属于项目而非客户端 |
| 工作区 `.opencode/` 目录 | 有意共享，`paths.ts` 中工作区搜索未改 |

---

## Review 发现的问题

### 问题 1：`config.ts:1351` 的 `endsWith(".opencode")` 隐藏依赖

**发现**：`config/config.ts:1350-1360` 对 `directories()` 返回的目录列表进行遍历时，有一个过滤条件：

```typescript
for (const dir of unique(directories)) {
  if (dir.endsWith(".opencode") || dir === Flag.OPENCODE_CONFIG_DIR) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      // 只有匹配 .opencode 的目录，才会从中加载 opencode.json
    }
  }
  // 下面的 loadCommand / loadAgent / loadMode / loadPlugin 对所有目录执行
}
```

原方案 Patch 3 将 home 搜索目标从 `.opencode` 改为 `.ultrawork`，但返回的 `~/.ultrawork/` 不会匹配 `endsWith(".opencode")`，导致 `~/.ultrawork/opencode.json` **不会被加载**（agents/commands/plugins 仍会加载）。

**解决**：将 Patch 3 改为：当 `OPENCODE_APP_NAME` 设���时直接跳过 home 目录搜索，而非替换搜索目标。原因：
1. Ultrawork 作为桌面 App，用户不会手动在 home 目录放 agents/plugins 文件（通过 UI 管理）
2. 避免 `~/.ultrawork/` 目录被当作配置目录（该目录已有 `channels.json`、`workspace/` 等其他用途），`installDependencies()` 会在该目录执行 npm 操作，产生意外的 `node_modules/`
3. 全局配置通过 `Global.Path.config`（`~/.config/ultrawork/`）管理，已足够

同时新增 Patch 4 作为防御性修改，确保即使未来策略调整（恢复 home 搜索），`endsWith` 过滤也能正确匹配。

### 问题 2：`~/.ultrawork/` 目录双重用途风险

**发现**：`~/.ultrawork/` 已被 Ultrawork 用于存放 `channels.json`、`session-map.json`、`workspace/`、`node/`、`mcp/`、`chrome-profile/`、`browser-mode.json` 等文件。

如果将 `~/.ultrawork/` 作为 home 配置搜索目标（原方案 Patch 3），`config.ts:1362-1368` 会在该目录执行 `installDependencies()`：

```typescript
const dep = iife(async () => {
  await installDependencies(dir)  // dir = ~/.ultrawork/
})
```

这会在 `~/.ultrawork/` 下产生 `package.json` 和 `node_modules/`，与现有文件混杂。

**解决**：已在问题 1 中通过跳过 home 搜索解决。

---

## 隔离效果

### 路径对照表

| 资源 | OpenCode CLI | Ultrawork | 隔离 |
|------|-------------|-----------|------|
| 全局配置 (provider/MCP/skills) | `~/.config/opencode/opencode.json` | `~/.config/ultrawork/opencode.json` | ✅ |
| 数据库 (sessions/messages) | `~/.local/share/opencode/opencode.db` | `~/.local/share/ultrawork/opencode.db` | ✅ |
| Provider 认证 | `~/.local/share/opencode/auth.json` | `~/.local/share/ultrawork/auth.json` | ✅ |
| MCP OAuth 凭证 | `~/.local/share/opencode/mcp-auth.json` | `~/.local/share/ultrawork/mcp-auth.json` | ✅ |
| Skills 缓存 | `~/.cache/opencode/skills/` | `~/.cache/ultrawork/skills/` | ✅ |
| 下载的二进制 | `~/.cache/opencode/bin/` | `~/.cache/ultrawork/bin/` | ✅ |
| Models 缓存 | `~/.cache/opencode/models.json` | `~/.cache/ultrawork/models.json` | ✅ |
| Snapshots | `~/.local/share/opencode/snapshot/` | `~/.local/share/ultrawork/snapshot/` | ✅ |
| Plans | `~/.local/share/opencode/plans/` | `~/.local/share/ultrawork/plans/` | ✅ |
| Worktree | `~/.local/share/opencode/worktree/` | `~/.local/share/ultrawork/worktree/` | ✅ |
| Plugin metadata | `~/.local/state/opencode/plugin-meta.json` | `~/.local/state/ultrawork/plugin-meta.json` | ✅ |
| File locks | `~/.local/state/opencode/locks/` | `~/.local/state/ultrawork/locks/` | ✅ |
| 日志 | `~/.local/share/opencode/log/` | `~/.local/share/ultrawork/log/` | ✅ |
| 用户 agents/plugins (home) | `~/.opencode/` | N/A（跳过搜索） | ✅ 隔离 |
| Managed dir (MDM) | `/Library/Application Support/opencode/` | `/Library/Application Support/ultrawork/` | ✅ |
| MDM plist domain | `ai.opencode.managed` | `ai.opencode.managed` | ❌ 共享（有意） |
| 工作区 `opencode.json` | `{workspace}/opencode.json` | `{workspace}/opencode.json` | ❌ 共享（有意） |
| 工作区 `.opencode/` | `{workspace}/.opencode/` | `{workspace}/.opencode/` | ❌ 共享（有意） |

### 并行运行安全性

改动完成后，同一台机器上同时运行 OpenCode CLI 和 Ultrawork：
- ✅ 不同的配置目录 → provider/MCP/skills 互不影响
- ✅ 不同的数据库文件 → session/消息历史独立
- ✅ 不同的锁文件目录 → 无竞争死锁风险
- ✅ 不同的认证凭证 → auth token 互不覆盖
- ✅ home 目录 `~/.opencode/` 仅 CLI 使用 → 不会泄漏到 Ultrawork

---

## 现有用户数据迁移

> **⚠️ 已移除（2026-06-14）**：本节描述的 `migrate_from_opencode()` / `copy_if_exists()` 一次性迁移逻辑已从 `lib.rs` 删除。
> 决策变更：不再从老 `~/.config/opencode/`、`~/.local/share/opencode/` 自动复制数据。老 opencode 用户首启 ultrawork 将是全新空环境（不继承历史会话/凭证/数据库）。
> **配置隔离机制本身（`OPENCODE_APP_NAME` 常量 + `global_config_dir()` + sidecar env 注入 + 4 处 vendor patch）保持不变**，隔离效果不受影响。
> 本节及下方「实现位置 / 迁移流程图 / 迁移不执行的场景」等内容仅作历史记录保留。

### 问题

已安装 Ultrawork 的老用户，数据全部存储在 `~/.config/opencode/`、`~/.local/share/opencode/` 等共享路径下。升级后 sidecar 改读 `~/.config/ultrawork/` 等新路径，如果不做迁移，用户会丢失：

| 数据 | 旧路径 | 影响 |
|------|--------|------|
| Provider 配置 + API Key | `~/.config/opencode/opencode.json` | 模型列表为空，需重新配置 |
| Provider 认证 token | `~/.local/share/opencode/auth.json` | 需重新登录 provider |
| MCP OAuth 凭证 | `~/.local/share/opencode/mcp-auth.json` | MCP 连接失败 |
| 会话历史 + 消息 | `~/.local/share/opencode/opencode-.db` (+shm, +wal) | 所有聊天记录消失 |
| Models 缓存 | `~/.cache/opencode/models.json` | 首次启动需重新拉取（~1.7MB），轻微延迟 |

### 迁移策略：首次启动自动复制

**时机**：在 `lib.rs` 的 `setup()` 中，**sidecar 启动之前**执行。sidecar 启动后会立即读取新路径，所以迁移必须在此之前完成。

**触发条件**：`~/.config/ultrawork/opencode.json` **不存在** 且 `~/.config/opencode/opencode.json` **存在**。

> 只检查 config 目录作为 sentinel——如果 config 存在，data/cache 大概率也存在。如果 config 不存在（纯新用户），跳过迁移。如果 `~/.config/ultrawork/` 已存在（已迁移过），也跳过。

**操作：复制（非移动）**

复制而非移动，原因：
- 用户可能同时使用 OpenCode CLI，移动会破坏 CLI
- 复制后两者独立，符合隔离目标
- 即使用户不用 CLI，旧数据留着也无害

### 迁移文件清单

#### 必须迁移（影响功能）

| 源文件 | 目标文件 | 说明 |
|--------|---------|------|
| `~/.config/opencode/opencode.json` | `~/.config/ultrawork/opencode.json` | Provider 配置、MCP 配置、模型选择 |
| `~/.local/share/opencode/auth.json` | `~/.local/share/ultrawork/auth.json` | Provider 认证 token |
| `~/.local/share/opencode/mcp-auth.json` | `~/.local/share/ultrawork/mcp-auth.json` | MCP OAuth 凭证 |
| `~/.local/share/opencode/opencode*.db*` | `~/.local/share/ultrawork/opencode*.db*` | SQLite 数据库（含 -shm、-wal） |

#### 不迁移但无影响的缓存

| 源文件 | 说明 |
|--------|------|
| `~/.cache/opencode/models.json` | 模型列表缓存（~1.7MB）。**不迁移**——因为 sidecar 启动时 `global/index.ts` 有 `CACHE_VERSION` 机制，新目录中 version 文件不存在会触发清空整个 cache 目录，迁移过去也会被立即删除。sidecar 启动后会自动重新拉取，仅首次启动多等 1-2 秒 |

#### 不迁移

| 路径 | 原因 |
|------|------|
| `~/.config/opencode/node_modules/`、`package.json`、`bun.lock` | 插件依赖，目标目录会自动重新安装 |
| `~/.config/opencode/config.json` | 旧格式配置，`opencode.json` 已包含所有配置 |
| `~/.local/share/opencode/snapshot/` | 快照数据量大且与旧 session 绑定，新环境无需 |
| `~/.local/share/opencode/storage/` | JSON 迁移中间产物 |
| `~/.local/share/opencode/tool-output/` | 临时工具输出 |
| `~/.local/share/opencode/log/` | 旧日志，无需保留 |
| `~/.local/share/opencode/bin/` | 下载的二进制工具，会按需重新下载 |
| `~/.cache/opencode/` 其余 | 缓存可再生 |
| `~/.local/state/opencode/` | locks（临时）和 plugin-meta（会重建） |

### SQLite 迁移注意事项

SQLite WAL 模式下数据库由三个文件组成：
- `opencode-.db`（主数据库）
- `opencode-.db-shm`（共享内存）
- `opencode-.db-wal`（预写日志）

**必须三个文件一起复制**，否则数据可能不完整或损坏。

此外需注意：
- 迁移时 sidecar 尚未启动，不存在数据库锁竞争
- 文件名中的 `-` 后缀来自 `db.ts` 的 channel 逻辑（`opencode-${channel}.db`），当前 channel 为空串，所以文件名是 `opencode-.db`
- 迁移时用 glob 匹配 `opencode*.db*` 以覆盖所有可能的 channel 变体

### 实现位置

改动 7（新增）：`packages/client/desktop/src-tauri/src/lib.rs` — 新增 `migrate_from_opencode()` 函数

```rust
/// One-time migration: copy essential data from shared opencode paths to
/// isolated ultrawork paths. Runs before sidecar startup.
/// Trigger: ~/.config/ultrawork/opencode.json does NOT exist
///      AND ~/.config/opencode/opencode.json DOES exist.
fn migrate_from_opencode() {
    let new_config = global_config_dir(); // ~/.config/ultrawork/
    let sentinel = new_config.join("opencode.json");
    if sentinel.exists() {
        return; // Already migrated or fresh config exists
    }

    let home = dirs::home_dir().unwrap();
    let old_config = match std::env::var("XDG_CONFIG_HOME") {
        Ok(val) if !val.is_empty() => PathBuf::from(val).join("opencode"),
        _ => home.join(".config").join("opencode"),
    };
    let old_sentinel = old_config.join("opencode.json");
    if !old_sentinel.exists() {
        return; // No old data to migrate (fresh install)
    }

    println!("[migration] Migrating data from opencode → ultrawork...");

    let old_data = home.join(".local/share/opencode");
    let new_data = home.join(".local/share").join(OPENCODE_APP_NAME);
    // Ensure target directories exist
    let _ = std::fs::create_dir_all(&new_config);
    let _ = std::fs::create_dir_all(&new_data);

    // Config: opencode.json only (skip node_modules, package.json, etc.)
    copy_if_exists(&old_config.join("opencode.json"), &sentinel);

    // Data: auth + mcp-auth + database files
    copy_if_exists(
        &old_data.join("auth.json"),
        &new_data.join("auth.json"),
    );
    copy_if_exists(
        &old_data.join("mcp-auth.json"),
        &new_data.join("mcp-auth.json"),
    );
    // SQLite: copy all opencode*.db* files (main + shm + wal)
    if let Ok(entries) = std::fs::read_dir(&old_data) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with("opencode") && name_str.contains(".db") {
                copy_if_exists(&entry.path(), &new_data.join(&name));
            }
        }
    }

    // NOTE: Cache (models.json etc.) is NOT migrated — sidecar's CACHE_VERSION
    // mechanism clears the entire cache dir on first launch anyway.
    // Models will be re-fetched automatically (~1-2s delay).

    println!("[migration] Migration complete.");
}

fn copy_if_exists(src: &PathBuf, dst: &PathBuf) {
    if src.exists() {
        match std::fs::copy(src, dst) {
            Ok(_) => println!("[migration]   {} → {}", src.display(), dst.display()),
            Err(e) => eprintln!("[migration]   WARN: failed to copy {}: {}", src.display(), e),
        }
    }
}
```

**调用位置**：在 `setup()` 中、sidecar 启动之前：

```rust
.setup(|app| {
    // ── Migration (before sidecar starts) ──
    migrate_from_opencode();

    // ── Start Channel Gateway sidecar ──
    // ...existing code...
```

### 迁移流程图

```
App 启动
  │
  ├─ ~/.config/ultrawork/opencode.json 存在?
  │   └─ 是 → 跳过迁移（已迁移或新配置）
  │
  ├─ ~/.config/opencode/opencode.json 存在?
  │   └─ 否 → 跳过迁移（全新安装）
  │
  └─ 执行迁移（复制）
      ├─ config: opencode.json
      ├─ data: auth.json, mcp-auth.json, opencode*.db*
      └─ 完成 → 继续启动 sidecar
```

### 迁移不执行的场景

| 场景 | sentinel 状态 | 行为 |
|------|-------------|------|
| 全新安装（从未用过 Ultrawork 或 OpenCode） | 新旧都不存在 | 跳过，正常首次启动 |
| 已迁移过的老用户（第二次启动） | 新存在 | 跳过 |
| 老用户首次升级 | 新不存在，旧存在 | **执行迁移** |
| 用户手动在新路径创建了配置 | 新存在 | 跳过（尊重用户手动配置） |

### 风险与回退

- **失败容忍**：每个文件的 copy 独立 try，单个失败不阻塞其他文件和 app 启动
- **不可逆性**：复制操作无风险——原文件不动，新文件是新建的。最坏情况：部分文件未复制成功，用户手动重新配置
- **日志可追踪**：所有复制操作打印到 stdout（Tauri 日志），便于排查

---

## 边界情况

### Vendor patch 维护成本

4 处 patch 均为变量赋值 / 条件判断处添加 `process.env.OPENCODE_APP_NAME` 分支：
- 改动极小（总计 ~12 行），upstream merge 冲突概率极低
- 对 upstream 行为零影响（env var 未设时完全退回原逻辑）
- 建议每次更新 vendor submodule 时检查这 4 个文件是否冲突

### `opencode.json` 文件名保持不变

工作区下的配置文件名仍叫 `opencode.json`（不是 `ultrawork.json`），因为：
- OpenCode 服务端搜索文件名是硬编码的（`config.ts:1332`：`ConfigPaths.projectFiles("opencode", ...)`）
- 改文件名需要大量 vendor patch，且收益不大
- 工作区级配置本就应该跟项目走，不跟客户端走

### `OPENCODE_DB` 无需单独设置

`db.ts:33` 使用 `Global.Path.data` 拼接路径，Patch 1 改完后数据库自然位于 `~/.local/share/ultrawork/opencode.db`。

### Channel Gateway 不受影响

Gateway 有独立的配置体系（`~/.ultrawork/channels.json`、`~/.ultrawork/session-map.json`），不使用 OpenCode 的 `Global.Path.*`。

### `~/.opencode/` 用户 agents/plugins 不可达

Patch 3 跳过 home 目录搜索后，CLI 用户在 `~/.opencode/` 放置的自定义 agents、commands、modes、plugins 不会被 Ultrawork 加载。这是有意为之——Ultrawork 通过 UI 管理这些资源。如果未来需要支持用户全局 agents，可通过 `OPENCODE_CONFIG_DIR` 或 `~/.config/ultrawork/` 下的 agents/ 目录实现。

### 工作区 `.opencode/` 仍然共享

工作区级的 `.opencode/` 目录（agents、commands、plugins、plans）在 CLI 和 Ultrawork 之间共享。这是正确行为——工作区配置属于项目。但需注意：
- 如果用户在 CLI 中为某个项目安装了 plugin（`plugin/install.ts:337` → `{worktree}/.opencode/`），Ultrawork 打开同一项目时也会加载该 plugin
- 这通常是期望的，但可能导致困惑。可在文档中说明

---

## 改动总表

| # | 类型 | 文件 | 改动内容 | 行数 |
|---|------|------|---------|------|
| Patch 1 | vendor | `vendor/.../global/index.ts:7` | `app` 名称可配置化 | ~1 |
| Patch 2 | vendor | `vendor/.../config/config.ts:62-71` | managed config dir 对齐 | ~3 |
| Patch 3 | vendor | `vendor/.../config/paths.ts:15-36` | 跳过 home 目录搜索 | ~6 |
| Patch 4 | vendor | `vendor/.../config/config.ts:1351` | endsWith 过滤防御性修改 | ~2 |
| 改动 5 | 自有 | `lib.rs` 顶部 + sidecar 启动处 | 新增 `OPENCODE_APP_NAME` 常量 + 注入 env var | ~4 |
| 改动 6 | 自有 | `lib.rs:733-738` | `global_config_dir()` 对齐 | ~2 |
| 改动 7 | 自有 | `lib.rs` 新增函数 + setup() 调用 | `migrate_from_opencode()` 首次启动数据迁移 | ~50 |

**总计**：vendor ~12 行 + 自有 ~56 行

---

## 实施计划

```
Phase 1 — Vendor patch（4 个文件）
  ├─ global/index.ts         — app 名称可配置化（Patch 1）
  ├─ config/config.ts:62     — managed config dir 对齐（Patch 2）
  ├─ config/paths.ts:15      — 跳过 home 目录搜索（Patch 3）
  └─ config/config.ts:1351   — endsWith 过滤防御性修改（Patch 4）

Phase 2 — 自有代码（1 个文件 lib.rs）
  ├─ 新增 OPENCODE_APP_NAME 常量 + sidecar env var 注入（改动 5）
  ├─ global_config_dir() 路径对齐（改动 6）
  └─ migrate_from_opencode() 迁移函数 + setup() 调用（改动 7）

Phase 3 — 重编译 & 验证
  ├─ bun run --bun scripts/build-opencode.ts
  │
  ├─ 验证迁移（模拟老用户升级）
  │   ├─ 确保 ~/.config/opencode/opencode.json 存在（当前状态）
  │   ├─ 删除 ~/.config/ultrawork/（如已存在）
  │   ├─ 启动 app
  │   ├─ 检查日志中出现 "[migration] Migrating data..."
  │   ├─ 检查 ~/.config/ultrawork/opencode.json 内容与旧文件一致
  │   ├─ 检查 ~/.local/share/ultrawork/auth.json 已复制
  │   ├─ 检查 ~/.local/share/ultrawork/opencode-.db* 已复制
  │   └─ 确认 ~/.config/opencode/ 原文件未被删除或修改
  │
  ├─ 验证隔离
  │   ├─ 在 Ultrawork 中修改 provider 配置
  │   ├─ 确认修改写入 ~/.config/ultrawork/opencode.json
  │   ├─ 确认 ~/.config/opencode/opencode.json 未受影响
  │   └─ 同时运行 opencode CLI，确认两者配置独立
  │
  ├─ 验证新路径
  │   ├─ DB 路径：~/.local/share/ultrawork/opencode-.db
  │   ├─ 锁文件路径：~/.local/state/ultrawork/locks/
  │   └─ 日志路径：~/.local/share/ultrawork/log/
  │
  ├─ 验证跳过场景
  │   ├─ 第二次启动不再执行迁移（日志中无 migration 输出）
  │   ├─ 全新安装（无旧数据）时不执行迁移
  │   └─ 验证 ~/.opencode/ 下的 agents 不出现在 Ultrawork 中
  │
  └─ 验证工作区配置仍正常加载

Phase 4 — 文档更新
  └─ 更新 MEMORY.md、CHANGELOG.md
```

---

## 后果

**正面**：
- Ultrawork 与 OpenCode CLI 完全隔离，互不影响
- 用户可以在同一台机器上同时使用两者，配置独立
- 老用户升级无感——首次启动自动迁移配置、凭证和会话历史
- vendor patch 极小（~12 行），维护成本低
- 对 upstream OpenCode 零影响（env var 未设时退回原行为）

**负面**：
- 需维护 4 处 vendor patch（但改动极小且集中）
- 迁移后两份数据独立，后续在 CLI 或 Ultrawork 一侧的配置变更不会同步到另一侧（这是隔离的设计目标，但用户可能初期不习惯）
- 工作区级 `opencode.json` 仍然共享（有意设计，但用户可能困惑）
- `~/.opencode/` 下的用户全局 agents/plugins 不会被 Ultrawork 加载（有意设计，可通过 `~/.config/ultrawork/` 替代）
