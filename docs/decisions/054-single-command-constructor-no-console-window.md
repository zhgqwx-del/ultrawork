# ADR-054：所有子进程走单一构造器 `sys_cmd()`，杜绝 Windows 控制台窗口闪现

- 状态：已接受（**Windows 真机验收通过**，2026-07-13 / v0.2.7）
- 日期：2026-07-13
- 背景讨论：`docs/discussions/037-windows-console-flash-on-exit.md`
- 相关：ADR-037（跨平台）· ADR-045（sidecar 关停）· gotchas §12

## 背景

Windows 真机反馈：退出 app 时连续闪现多个 PowerShell 控制台窗口。

根因（源码级确认）：release 构建是 GUI 子系统程序（`windows_subsystem = "windows"`），**自身没有控制台**。这种进程每派生一个控制台程序（`taskkill` / `netstat` / `tasklist` / `powershell`），若未传 `CREATE_NO_WINDOW`，Windows 就会**为子进程新建一个可见控制台窗口**。

退出清理路径 `shutdown_sidecars()` 上，四个 sidecar 各一次 `taskkill`，外加 `kill_browser_mcp_processes()` **无条件**按 needle 循环起 **4 个 PowerShell** —— 用户从没开过浏览器 MCP 也照弹。

关键背景：项目里**早就有**一个 `no_window()` 辅助函数，注释准确描述了这个症状，但它只被 5/35 处调用点使用，整条退出路径一处都没用。

## 决策

### D1：单一构造器，而非逐个补调用

全部 35 处 `Command::new` 归一到 `sys_cmd(program) -> Command`，它恒定设置 `CREATE_NO_WINDOW`（非 Windows 上是普通 `Command::new`）。删除 `no_window()`。

**理由**：这个 bug 的成因就是"有一个辅助函数，但要求每个调用点记得调它"。把同样的结构再补一遍，只是把下一次遗漏推迟。构造器把"记得调"变成"绕不过"。

### D2：源码级守卫，而非依赖 CI

`no_bare_command_new` 单测递归扫描整个 `src/`，禁止裸 `Command::new`（GUI 子进程可用同行 `allow-bare-command: <理由>` 豁免，如 `explorer`）。

**理由**：**CI 里没有任何东西能"看见"一个窗口闪过**。三平台矩阵只跑编译和单测，e2e 够不着原生窗口（与 ADR-047/048 记录的是同一笔自动化欠账）。源码是唯一守得住的层面。守卫遍历目录而非维护文件清单——否则它会以完全相同的方式（"漏了一个"）失效。

### D3：PowerShell 只枚举，杀进程回到 Rust

```
Get-CimInstance Win32_Process -Filter "<OR 链>"
  | Where-Object { $_.ProcessId -ne $PID }   # 排除自己
  | ForEach-Object { $_.ProcessId }          # 只打印 PID，不派生任何进程
```
Rust 读回 PID → `kill_process_tree()` → `taskkill /F /T` 由 GUI 主进程经 `sys_cmd` 直接派生。

**理由（两条，都是对抗审查抓出来的）**：

1. **规则会转嫁。** 给 PowerShell 加了 flag 之后**它自己也没有控制台**了 ⇒ 它管道里派生的每个 `taskkill` 都会被系统分配一个新窗口。Chrome 的 helper 进程全带 `--user-data-dir=…\chrome-profile`、全命中 needle ⇒ **可能几十个窗口，比原 bug 更糟**。这条规则写在 D1 的注释里，却没有被应用到 D1 自己的改动上。

2. **旧命令会杀死自己。** 查询串里的 needle **字面写在 powershell.exe 的命令行里**，所以 `Win32_Process.CommandLine` **匹配到它自己** ⇒ 把自身 PID 喂给 `taskkill /F` ⇒ 中途自杀、尚未枚举到的 PID 一个都不清理。WMI 枚举顺序未定义 ⇒ 不确定性失败。**这意味着 Windows 上的浏览器进程清理很可能从来就没可靠工作过**（既有缺陷，非本次引入；但把 4 次独立调用合并成 1 次会把它从"有冗余"变成"单点故障"，所以必须一并修）。

顺带：4 次 WMI 全进程表扫描 + 4 次 PowerShell 冷启动 → 1 次，退出更快。

## 明确不做

- **按需跳过 `kill_browser_mcp_processes`**（"没用过浏览器就别清理"）：该函数存在的理由是防 Chrome "session locked"，**门控判错就是漏杀**，症状会以更难查的形式回来。D1 后闪窗已消失、D3 后开销已可接受，不值得为省这点开销引入正确性风险。
- **用 `sysinfo` crate 取代 shell-out**：是根治方向（顺带能统一 Unix 的 `pgrep` 路径），但属独立重构，不与本 bugfix 混做。

## 已知残余

- **`npm install` 的孙进程**（同一条转嫁规则）：npm 自身的控制台已隐藏，但它派生的 postinstall / git / node-gyp 可能各自弹窗。我们控制不了 npm 怎么 spawn，且相对现状**不劣化**（今天这条路径本就弹一个 npm 窗口且持续整个安装），列为真机观察项。
- **`Bun.spawn` 未传 `windowsHide`**（`acp-client` 起 claude/gemini）：sidecar 自身被 plugin-shell 以 `CREATE_NO_WINDOW` 启动 ⇒ **它也没有控制台** ⇒ 它的子进程理论上会自建窗口。**未确认**——预期症状是"启动 ACP 会话时闪窗"，与本次报告的"退出时闪窗"不是同一现象，mac 上无法证实，故不并入本次修复。

## 验证

- Rust 单测 **132**（基线 127 + 5 个守卫），clippy 零新增警告，typecheck 8/8。
- **每个守卫都做过 A/B 反证**：注入裸 `Command::new`（含新建模块）→ 红并精确报行；把 `taskkill` 塞回 PowerShell 管道 → 红；撤掉 `$PID` 自排除 → 红。
- `sys_cmd` 的 `#[cfg(windows)]` 块已单独对 `x86_64-pc-windows-msvc` 交叉编译通过（整个 `lib.rs` 里该属性只此一处，其余 Windows 逻辑全是 `if cfg!(...)` 运行时分支 ⇒ **本次没有一行代码是编译器没看过的**）。
- **✅ Windows 真机验收通过（2026-07-13，v0.2.7 正式 Release 包）**：① 启动 → 退出 = **零窗口闪现**（主症状消失）；② 用浏览器 MCP 后退出 = **零窗口** 且 Chrome 清理干净（**顺带坐实 D3-②**：旧代码那条自杀的 PowerShell 确实让清理夭折过）。发包前已从正式 Release 的安装器里解出 `ultrawork.exe` 做**双向探针**——新枚举命令在 / 旧的管道内 `taskkill` 已消失 / PE 子系统 = 2 (WINDOWS_GUI)，三条堵死「测到旧包」和「测到自带控制台的构建」两种假绿。
- **未验证项**：「起 ACP 会话是否闪窗」（`Bun.spawn` 未传 `windowsHide`）—— 该 Windows 机器**未安装 Claude/Gemini**，结构上无法验证。见下方「已知残余」。
