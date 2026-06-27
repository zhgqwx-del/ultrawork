# ADR-037: 跨平台兼容（macOS / Windows / Linux）作为持续开发约束

**状态**: Accepted (✅ 代码 + CI 已落地；macOS 本机 typecheck/test/`cargo test` 全绿；Windows/Linux 由 CI 矩阵验证)
**日期**: 2026-06-27
**关联**: conventions.md §13（正向模式）· gotchas.md §12（反向坑）· quality-gates.md §2（自检项）· `.github/workflows/ci.yml` + `release.yml`

## 背景

项目此前主要在 macOS 上开发，目标是在 Windows（及 Linux）下也能打包出可直接安装使用的软件，并且**后续所有迭代都持续保持三平台兼容**。需要解决两件事：

1. **把跨平台作为开发/测试约束固化**，否则单平台开发会持续引入只在某 OS 失效的回退（硬编码 `/`、`$HOME`、unix-only 命令…）。
2. **系统 review 存量代码**的不兼容点并修复。

系统调研（3 路并行）确认存量问题分三类，性质/风险差异大：① 纯路径/字符串机械替换（零逻辑）；② 进程/信号/开文件等需平台分支实现；③ 打包/构建 glue（让 Windows 能出安装包）。

## 决策

**全做 ①②③ + 文档约束 + CI 三平台矩阵**。关键工程取舍：

- **强制层是 CI，不是文档自觉**。`.github/workflows/ci.yml` 在 mac/win/linux 跑 `turbo typecheck` + `turbo test` + `cargo test`(src-tauri)，回退被 CI 抓。文档（conventions §13 / gotchas §12 / quality-gates §2）是写代码时的提醒。
- **Rust 优先运行时 `if cfg!(target_os=…)` 分支，而非 `#[cfg]` 属性门控**。因为本机（macOS）`cargo check` 只编译当前 target，`#[cfg(windows)]` 分支本机完全不参与编译——用 `cfg!()`（编译期 bool）让所有分支都在本机编译/类型检查，把「写错 Windows 分支」的发现时机从 CI 提前到本机。仅平台专属 API/crate（`std::os::unix`、`signal_hook`）才用 `#[cfg]` 属性 + 另一侧 no-op。
- **Renderer 路径工具集中化**。`.tsx` 跑在 WebView 无 `node:path` → 新增 `@/lib/path-utils` 的 `pathBasename`/`isAbsolutePath`/`shortenPath`（同吃 `/` 和 `\`），18+ 处 `split("/").pop()` 收敛到它。URL / model-id 的 `/` 不动。
- **打包用 Tauri 既有能力**。`bundle.targets:"all"` 让 Tauri 按平台产对应安装包；`build-release.ts` 非 macOS 走「构建 sidecar + `tauri build`」分支（不碰 Apple 签名）；新增跨平台 `scripts/setup.ts`（Bun API，替代只能在 Unix 跑的 `setup.sh`）。

## 具体改动

| 类别 | 改动 |
|------|------|
| ① 机械替换 | knowledge sidecar `HOME`→`os.homedir()`；renderer 18+ 处 basename 走 `path-utils`；sidecar(node) 用 `node:path`；`acp-connection` basename + 条件 unix PATH dirs；Rust `/tmp`→`temp_dir()`、PATH `:`→`PATH_LIST_SEP` |
| ② 运行时分支 | lib.rs `pids_on_port`(lsof/netstat)+`kill_pid`(kill/taskkill) helper（杀进程统一走它）；`port_listener_orphaned`/`process_ppid` Windows 短路；`install_signal_handlers` `#[cfg(unix)]`+no-op（signal-hook 移 unix-only dep）；`open_file_with_system`/`reveal_file_in_finder` **改用 `tauri-plugin-opener`**（避免 cmd 注入）；`detect_chrome`(+%LOCALAPPDATA%)/system-node `which`→`where` 三平台分支；curl `/dev/null`→`nul`；`probe_bins` PATHEXT |
| ③ 打包 glue | `tauri.conf bundle.targets:"all"`；`build-opencode.ts` chmod 守卫；`build-release.ts` 非 mac 分支；`scripts/setup.ts` + `setup` script；turbo `test` task |
| 约束/CI | conventions §13 + gotchas §12 + quality-gates §2；`ci.yml`(push/PR 三平台 typecheck+test+cargo test) + `release.yml`(tag 三平台出安装包) |

## 验证

- **macOS 本机**：`turbo run typecheck` 8/8；`turbo run test` 11 包全绿（desktop 255，含新增 `path-utils` 10 用例 + `isBuiltinLocation` Windows 用例）；`cargo test`(src-tauri) 16/16；`cargo check` 通过（运行时 `cfg!` 分支全编译）。
- **Windows 交叉编译（本机最强验证）**：`rustup target add x86_64-pc-windows-msvc` + 在 `binaries/` touch 占位 sidecar 后 `cargo check --target x86_64-pc-windows-msvc` → 成功通过**依赖编译 + tauri-codegen + externalBin 解析**（顺带证实 `generate_context!` 确实编译期校验 externalBin 存在 → ci.yml 的 stub 步骤必需），仅卡在 `tauri-winres` 需宿主 `llvm-rc`（嵌图标，cross 限制、非代码缺陷）。所有 `cfg!()` 运行时分支本机即编译，真正只在 Windows 编译的仅两个 trivial `#[cfg(not(unix))]` 空函数。
- **Windows / Linux 完整**：由 CI 矩阵承担。`ci.yml` 的 `rust` job 在 windows-latest 上 `cargo test` 首次真编 winres + 两个 cfg 空函数 + 跑单测；`node` job 验 TS 跨平台逻辑。

## 四视角对抗审查（2026-06-27，review 后修正）

落地后做了四路独立对抗审查（正确性/完备性/Rust-Windows/CI-打包），抓到并已修：
- 🔴 **真 bug**：`start_sidecar` 健康检查超时仍直调 `Command::new("kill")`（重构漏一处）→ Windows 泄漏不健康子进程，改 `kill_pid()`。
- 🔴 **CI blocker**：`release.yml` macOS job 缺 `x86_64-apple-darwin` rust target（universal 构建必失败），补条件步骤。
- 🟡 **cmd 注入面**：`open_file_with_system` 原手搓 `cmd /C start` 对含 `& % ^` 的产物名有注入面 → 改用 `tauri-plugin-opener`（ShellExecute）。
- 🟡 **3 个 Rust 单测**（`skill_dep_path`/`merge_paths`/`probe_bins`）断言写死 POSIX `:`/`/usr/bin`，Windows `cargo test` 会失败 → 加 `#[cfg(unix)]`。
- 🟡 **`isBuiltinLocation`** 硬编码 `/skills/builtin/`，Windows 反斜杠误判内置技能分类 → 改正则 `[\\/]`，补 Windows 测试用例。
- 🟢 低：`detect_chrome` 补 Windows %LOCALAPPDATA% per-user 路径；netstat IPv4-only 假设写进注释。
- **完备性扫描确认干净**：gateway / connector / orchestrator / api-client / server-manager 五个包无遗留跨平台隐患（均用 `node:path` + `homedir()`/XDG，`spawn` 直调）。

## 已知边界（刻意降级，非 bug）

- **嵌入式 Node 下载 / Browser MCP / Chrome 进程清理**：Unix 取向（`get_platform_arch` 仅 darwin/linux）。Windows 上整套优雅不可用（返 Err / spawn 失败即 no-op，不崩）；Linux 走 linux 分支可用。Windows 完整支持需单独移植 node `.zip` 布局，列为后续。
- **dev/perf 一次性脚本**（`scripts/perf/health-contention/gen-tree.ts` 的 `/bin/bash`、`export-agentos-ref.ts` 的 `/tmp` 默认）：不进产品、不进常规构建，保留未改。
- **首次 CI 跑通需观察**：`ci.yml` 的 `rust` job 假设 `tauri::generate_context!` 不校验 sidecar 二进制存在（仅需前端 dist + 占位文件），`release.yml` 未本地验证——首次触发需确认。

## 备选与放弃

- **只加文档不改代码 / 只做机械替换**：被否（用户要 Windows 真能装能跑）。
- **per-platform `tauri.windows.conf.json` 多配置文件**：暂不需要，`bundle.targets:"all"` + 默认值已够；将来要 Windows 签名/MSI 定制时再加。
- **CI 每 PR 全量三平台打包**：太重。改为 PR 跑 typecheck+test+`cargo test`（快、且 cargo test 已覆盖 Windows 编译），完整出包留给 tag 触发的 `release.yml`。
