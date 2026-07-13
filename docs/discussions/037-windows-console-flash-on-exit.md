# 037 — Windows 退出时闪现多个 PowerShell 控制台窗口

- 状态：根因已确认（源码级），方案待实施
- 日期：2026-07-13
- 触发：真机反馈——「在 Windows 上关闭退出时，跳出多次 PowerShell 窗口，做了一些收尾，然后都自动关闭」
- 相关：ADR-037（跨平台）· ADR-045（sidecar 端口/关停）· gotchas §12

---

## 1. 症状

Windows 上退出 Ultrawork（打包版）时，屏幕上连续闪现**多个**控制台窗口（PowerShell 外观），每个一闪即关。功能上没有报错，但观感像是程序崩溃或在偷偷执行脚本。

## 2. 根因（已确认，非推测）

### 2.1 机制

Release 构建是 **GUI 子系统**程序：

```rust
// src-tauri/src/main.rs:1
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
```

GUI 子系统进程**自身不持有控制台**。当它 `CreateProcess` 一个控制台程序（`taskkill` / `netstat` / `tasklist` / `powershell`）而**没有传 `CREATE_NO_WINDOW`（0x0800_0000）**时，Windows 会为该子进程**新建一个可见的控制台窗口**，子进程退出后窗口销毁 —— 即"闪一下自动关掉"。

这不是新发现。代码里已有专门治这个症状的辅助函数，注释写得很明确：

```rust
// src-tauri/src/lib.rs:1152
/// Suppress the console window a child process would otherwise flash on
/// Windows release builds (`windows_subsystem = "windows"`). No-op elsewhere.
fn no_window(cmd: &mut Command) { ... }

// src-tauri/src/lib.rs:1163
/// ... a bare `.output()` flashes a visible console for the probe's lifetime
```

**问题在于覆盖率**：`no_window()` 全仓只在 **5 处**被调用（curl 探针 1170、`run_probe` 3259、tar 4110、lark config 4541、parked device flow 4673），而**整条退出清理路径一处都没调**。

### 2.2 退出时到底起了哪些进程

`shutdown_sidecars()`（`lib.rs:626`，由 `RunEvent::Exit` 触发，`lib.rs:5667`）在 Windows 上依次执行：

| # | 调用 | 位置 | 进程 | 退出时次数 |
|---|------|------|------|-----------|
| 1 | `kill_pid()` | `lib.rs:555` | `taskkill /F /PID` | 每个带 pid 的 sidecar 一次（opencode / gateway / knowledge / acp，**最多 4**） |
| 2 | `kill_port_listeners()` → `listening_pids_on_port()` | `lib.rs:463` | `netstat -ano -p tcp` | 仅当端口未及时释放 |
| 3 | ↳ `process_exe_name()` | `lib.rs:529` | `tasklist` | 同上，每个残留 pid 一次 |
| 4 | **`kill_browser_mcp_processes()`** | `lib.rs:2013` | **`powershell`** | **固定 4 次**（见下） |

**第 4 项是"多个 PowerShell"的直接来源**：

```rust
// src-tauri/src/lib.rs:2008-2018
for needle in &["chrome-devtools-mcp", "playwright-mcp", "@playwright/mcp", "chrome-profile"] {
    let ps = format!("Get-CimInstance Win32_Process -Filter \"CommandLine LIKE '%{}%'\" | \
                      ForEach-Object {{ taskkill /F /T /PID $_.ProcessId 2>$null }}", needle);
    Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .output()   // ← 无 no_window
        .ok();
}
```

四个 needle = **四个独立的 powershell.exe 进程** = 四个窗口。

而且它在 `shutdown_sidecars()` 里是**无条件调用**的（`lib.rs:671`）：**即使用户从未启用过浏览器 MCP、机器上一个 Chrome 都没有，每次退出照样弹 4 次。**

### 2.3 反向佐证：为什么四个 sidecar 本身不闪窗

Sidecar 是走 `tauri-plugin-shell` 启动的，而该插件**默认就加了这个标志**：

```rust
// tauri-plugin-shell-2.3.5/src/process/mod.rs:20,173
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
command.creation_flags(CREATE_NO_WINDOW);
```

所以四个 sidecar 的启停全程无窗。**这把嫌疑范围干净地收敛到"我们自己写的 `std::process::Command`"**，与症状（只在收尾阶段出现）完全吻合。

### 2.4 次要影响：退出变慢

`Get-CimInstance Win32_Process` 带 `CommandLine LIKE` 过滤是 **WMI 全进程表扫描**，本就慢；再叠加 PowerShell 冷启动（数百 ms 起），×4 串行执行。这解释了为什么窗口是**一个接一个**出现而非瞬间掠过 —— 退出路径上有可观的额外耗时。

## 3. 同类缺陷的其他触发点（同一根因，本次一并修）

不止退出：

| 路径 | 位置 | 何时触发 |
|------|------|---------|
| `prepare_port` → `netstat` + `tasklist` | `lib.rs:463`, `529` | **启动时**端口被占用 |
| `where node` | `lib.rs:1929` | 浏览器 MCP 环境探测 |
| `node --version` | `lib.rs:1563`, `1943` | 同上 |
| `npm install` | `lib.rs:2139` | 浏览器 MCP 安装 |
| `curl` / `tar`（下载内嵌 Node） | `lib.rs:1446`, `1459`, `1463` | 同上 |

（办公 CLI 那条线**是干净的** —— 它全部经 `run_probe` / `run_probe_capture` / `start_parked_device_flow`，都调了 `no_window`。）

## 4. 方案

### P0 — 补齐 `CREATE_NO_WINDOW` 覆盖（必做，零行为变更）

把所有 Windows 可达的 `Command` 收敛到**一个恒定加标志的构造器**，而不是逐个补 `no_window()` 调用 —— 后者下次新增一处又会漏（本 bug 正是这么来的）。

- 行为影响：**无**。stdout/stderr 照常 pipe；Unix 上是 no-op；dev 构建（有控制台）本就不弹窗，加了也无害。
- 风险：接近零。同一手法已在 curl / tar / 办公 CLI 三条路径上长期运行。
- 单这一条就能**让用户报告的症状完全消失**。

**配套源码级守卫（关键）**：加一个读 `lib.rs` 自身源码、断言不存在裸 `Command::new(` 的单测。

> 为什么必须是源码级：这个 bug 的性质决定了**没有任何自动化手段能"看见"一个窗口闪过** —— CI 三平台只跑编译和单测，e2e 够不着原生窗口（与 ADR-047/048 记录的同一笔基建欠账）。唯一能在 CI 里守住的层面就是源码。

### P1 — PowerShell：4 次合并为 1 次，且**只枚举、不杀进程**

4 次 WMI 全表扫描 + 4 次冷启动 → 1 次（`OR` 拼四个 `LIKE`）。

但**合并本身不够 —— 对抗审查在这里抓出两个 HIGH，其中一个是 P0 自己引入的回归**：

**(a) 隐藏 PowerShell 会把窗口转嫁给它的子进程。** 加了 `CREATE_NO_WINDOW` 之后 PowerShell **自己也没有控制台**了，而原命令是 `... | ForEach-Object { taskkill /F /T /PID ... }` —— 按 §2.1 那条规则（无控制台的父进程派生控制台子进程 ⇒ 系统新建窗口），**每个被杀的进程都会换来一个 `taskkill` 窗口**。Chrome 的 helper 进程全都带 `--user-data-dir=…\chrome-profile`，都会命中 needle ⇒ 可能是**几十个窗口**，比原 bug 更糟。
> 这条规则写在 P0 的注释里，却没有被应用到 P0 自己的改动上 —— 典型的"规则写对了、没往下推一层"。

**(b) 这条 PowerShell 命令会杀死它自己（既有缺陷，被合并放大）。** 命令行里**字面包含那四个 needle**，所以 powershell.exe 自身的 `Win32_Process.CommandLine` **满足查询条件** ⇒ 它把自己的 PID 喂给 `taskkill /F` ⇒ 管道中途被杀，**尚未枚举到的 PID 一个都不会被清理**。WMI 的枚举顺序未定义，所以这是不确定性失败 —— **意味着 Windows 上的浏览器清理很可能从来就没可靠工作过**。原先 4 次独立调用尚有冗余（一次自杀还剩三次），合并成一次后变成**单点故障**。

**最终修法（同时消解 a 与 b）**：PowerShell **降级为纯枚举器**，杀进程回到 Rust：

```
Get-CimInstance Win32_Process -Filter "<OR 链>"
  | Where-Object { $_.ProcessId -ne $PID }     # ← 排除自己（b）
  | ForEach-Object { $_.ProcessId }            # ← 只打印 PID，不派生任何进程（a）
```

Rust 侧读回 PID，逐个 `kill_process_tree()` → `taskkill /F /T` 由 **GUI 主进程直接派生**，走 `sys_cmd` ⇒ 自带 `CREATE_NO_WINDOW` ⇒ **零窗口**。

两条性质都已钉进测试（`enum_command_spawns_nothing_and_excludes_self`），并做过 A/B 反证：撤掉任一条，测试变红。

注：needle 均不含 `\ % _ '`，WQL `LIKE` 无需转义 —— 由 `browser_mcp_needles_need_no_wql_escaping` 断言，将来加了需转义的 needle 会直接失败。

### P2 — 暂不做

**按需跳过 `kill_browser_mcp_processes`**（"没用过浏览器就别清理"）：直觉上省事，但该函数存在的理由是防 Chrome "session locked"。**门控判断一旦判错就是漏杀，症状会以更难查的形式回来。** P0 后闪窗已消失、P1 后开销已可接受，不值得为省这点开销引入正确性风险。

**用 `sysinfo` crate 取代 shell-out**（原生读进程命令行，顺带统一 Unix 的 `pgrep` 路径）：是根治方向，但属独立重构，不应与本 bugfix 混做。

## 4.5 已知残余风险：`npm install` 的孙进程（D3，未修）

同一条"转嫁"规则还剩一个落点：`npm_install_in`（`lib.rs`，浏览器 MCP 安装路径）现在也隐藏了 npm 自身的控制台，而 npm 若在安装期派生控制台孙进程（postinstall 脚本、git、node-gyp），**那些孙进程可能各自弹一个窗口**。

**刻意不修**，理由：① 我们控制不了 npm 如何 spawn 它的子进程；② 相对现状是**不劣化**的 —— 今天这条路径本来就会弹一个 npm 控制台窗口、且持续整个安装过程；③ 属用户主动触发的一次性路径，不是每次退出都撞。

**列为 Windows 真机观察项**：装一次浏览器 MCP，看是否闪窗。若确实闪，正解是把内嵌 Node 的调用换成 API 而非 CLI，或接受它。

## 5. 待观察（未确认，不在本次范围）

**sidecar 派生的子进程可能是第三类闪窗源。** Sidecar 自身被 plugin-shell 以 `CREATE_NO_WINDOW` 启动 ⇒ **它们也没有控制台** ⇒ 它们再 spawn 控制台程序时同样会自建窗口，而 Rust 侧的 `no_window()` 完全够不着这一层。

- `acp-client` 用 `Bun.spawn` 起 claude/gemini（`acp-connection.ts:248`），**未传 `windowsHide`**。Bun 类型里 `windowsHide?: boolean` 存在但**未标注默认值**（Node 的默认是 `false`）。
- vendor 的 opencode 起 MCP server（bunx）同理，且改动需走 vendor patch。

**为何不并入本次**：预期症状是「**启动 ACP 会话 / MCP 时**闪窗」，与本次报告的「**退出时**闪窗」是不同现象，用户未报告，且 mac 上无法证实。传 `windowsHide: true` 本身是零风险的一行改动，但在真机观察到之前，不应把它当作"已确认缺陷的修复"来记账。

**验法**：Windows 真机上启动一个 Claude/Gemini ACP 会话，观察是否闪窗。

## 6. 验证计划

| 层面 | 手段 | 能否在 mac 上做 |
|------|------|----------------|
| 源码不再有裸 `Command::new` | 新增单测，CI 三平台跑 | ✅ |
| 编译 / 现有行为不回归 | `cargo test` + `turbo run typecheck` | ✅ |
| **窗口真的不再闪** | Windows 真机（v0.2.7 正式包） | ✅ **已验证通过（2026-07-13）** |
| 浏览器 MCP 后退出 = 零窗口 + Chrome 清干净 | Windows 真机 | ✅ **已验证通过（2026-07-13）**，顺带坐实 §4 P1-(b) 的自杀缺陷 |
| 起 ACP 会话是否闪窗（§5 待观察项） | Windows 真机 | ⛔ **无法验证** —— 该机器未装 Claude/Gemini |

**诚实边界**：闪窗只在 Windows **release** 包上出现（dev 构建自带控制台，子进程复用它，不弹新窗口）。所以本次修复在 mac 上**只能验证"不回归"，无法验证"症状消失"**。最终验收挂到既有的 Windows 真机欠账（ADR-045 / ADR-046 §12）一起做。


## 7. 真机验收结果（2026-07-13，v0.2.7）

**通过。** 用正式 Release 的 `Ultrawork_0.2.7_x64-setup.exe` 验收：

1. **启动 → 退出 = 零窗口闪现**（主症状消失）。
2. **用浏览器 MCP 后退出 = 零窗口，且 Chrome 被清理干净** —— 这条同时坐实了 §4 P1-(b)：旧代码那条会杀死自己的 PowerShell 确实让清理夭折过。
3. 「起 ACP 会话是否闪窗」**无法验证** —— 该 Windows 机器未安装 Claude/Gemini。仍是未确认项（§5）。

发包前的防假绿措施（在 mac 上做的）：从正式 Release 的安装器里解出 `ultrawork.exe`，双向探针确认 **新枚举命令在 / 旧的管道内 `taskkill` 已消失 / PE 子系统 = 2 (WINDOWS_GUI)**。三条分别堵死「测到旧包」「旧逻辑残留」「测到自带控制台的构建（那种通过是假的）」。
