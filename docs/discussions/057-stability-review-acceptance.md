# 057 — 稳定性 review：真机验收清单

> 配套本轮稳定性 review 的 9 项修复（F1–F11）。**自动化测试覆盖不到的部分全在这里**，
> 逐条勾选即可。所有能机器验的都已进 CI（Rust 154 / desktop 809 / turbo test 11 job）。

## 为什么需要这份清单

三类东西测试验不了，必须真机：

1. **进程边界**——Tauri 的 `AppHandle` emit、sidecar 子进程的 stdout 管道，
   单测里传的是 `None`/mock。
2. **视觉与观感**——横幅的配色、出现时机、是否碍事。
3. **Tauri 原生窗口**——Playwright 驱动的是 Chrome + Vite，不是打包后的 WebView。

已经**不需要**手工验的（都用真实后端自动化了）：

| 覆盖 | 手段 |
|------|------|
| `/session/status` 的「缺席即 idle」契约 | 真实 opencode sidecar 实测 |
| 杀进程 → 61s 断流 → 重启 → 自动恢复 | 真实 opencode sidecar 实测 |
| REST 超时打到真实 socket | 真实 opencode sidecar 实测 |
| 会话分页 + 服务端搜索（E 组） | `e2e/session-reachability.e2e.ts` |

---

## A. sidecar 日志落盘（F11）

**为什么重要**：这三个自研 sidecar 的 153 处 `console.*` 此前全部被丢弃。
它是「后面所有问题还能不能被诊断」的前提。

- [ ] **A1** 启动 app 后：
      ```
      ls -la ~/.local/share/ultrawork/log/sidecar/
      ```
      应有 4 个 `.log`（opencode-server / channel-gateway / knowledge-sidecar /
      acp-client），且**非空**。
- [ ] **A2** 任取一个 `tail -5`，确认每行形如
      `2026-07-29T12:34:56.789Z [out] ...`，时间戳与当前时间对得上（UTC，不是本地时区）。
- [ ] **A3** 正常退出 app，日志末尾应有 `=== <name> exited (code ..., signal ...) ===`。
- [ ] **A4**（可选，验轮转）持续用一段时间后确认单个文件 < 4MB，
      且最多只有 `<name>.log` + `<name>.1.log` 两代。

## B. sidecar 死亡提示（F3）

- [ ] **B1** app 运行中，手动杀掉一个 sidecar：
      ```
      lsof -ti :4097 | xargs kill      # channel-gateway
      ```
      不应有任何界面变化（gateway 不喂全局流）。日志里应出现 `exited`。
- [ ] **B2** 杀掉 opencode：
      ```
      lsof -ti :4096 | xargs kill
      ```
      顶部应出现琥珀色横幅「已与 Agent 服务断开」+「重新连接」。
      ⚠️ **已知误导**：点「重新连接」对已退出的 sidecar 没用（没有任何东西会
      重启它）。原本有一条独立文案区分这两种死法，但其 Rust 侧实现会让
      Windows 的 `cargo test` 二进制加载不起来，已撤下 —— ADR-071 §Windows
      加载失败 · gotchas §20⑪。

## C. 断连横幅与恢复（F2 / F5）

- [ ] **C1** 用防火墙/断网工具阻断 4096 端口（**不要杀进程**，那会走 B2 分支），
      约 4 秒后应出现横幅「已与 Agent 服务断开」+「重新连接」按钮。
- [ ] **C2** 恢复连通后，横幅应**自动消失**，无需点任何东西
      —— 这是本轮的核心修复：此前会永久放弃，只能重启 app。
- [ ] **C3** 断开状态下点「重新连接」：应立刻尝试（不等 15 秒后台间隔）。
- [ ] **C4** 观感判断（**你的领域**）：横幅高度/配色是否碍事？4 秒宽限是否合适？
      普通的秒级抖动**不应该**看到横幅。

## D. 卡死的「运行中」是否真的解开了（F1）

这是整轮 review 最核心的修复，也最值得亲手验一次。

- [ ] **D1** 发一条会跑较久的消息（比如让 agent 读几个文件）。
- [ ] **D2** 趁它在跑，阻断 4096 端口 **≥ 70 秒**（实测到 `gave-up` 是 61 秒，
      不是延迟相加的 31 秒——30 秒时心跳看门狗会重置一轮重试预算），
      期间那一轮会在后端正常结束。
- [ ] **D3** 恢复连通。**预期**：侧栏的转圈停止，输入框恢复可用。
      **修复前**：会永远转圈 + 输入框永久锁死，只能切工作区或重启。
- [ ] **D4** 已知未做：断流窗口里流过的**正文**仍会缺一段（切走再切回可全量重取）。
      这是有意留下的 F1b，不算 bug 复现。

## E. 会话可达性（F6）— **已自动化，无需手工验**

`e2e/session-reachability.e2e.ts` 用 130 个真实会话 + 真实 opencode + 真实 Chrome
把 E1–E3 全跑过了（含服务端 `?search=` 契约本身）。跑法：

```
cd packages/client/desktop && bun run --bun e2e/session-reachability.e2e.ts
```

- [ ] **E0**（可选）在你自己的 `workspace2`（140 个会话）上顺手确认一次观感。

## F. 停止生成（F10）

- [ ] **F1** 正常点停止：应安静停下，**不弹任何 toast**。
- [ ] **F2**（需要造错）停止时若后端不可达，应弹「停止失败，Agent 可能仍在运行」，
      且界面不冻结（后续输出仍可见）。
      —— 修复前是静默的：界面装作停了，agent 继续跑继续烧 token。

## G. 产物扫描（F7）

- [ ] **G1** 在一个**文件很多**的工作区里（几万个文件）让 agent 生成一个产物，
      确认产物卡片出现。修复前这依赖遍历顺序的运气。

## H. 知识库大批量变更（F9）

> 需要你已经在知识库里添加过文件夹，否则不触发。

- [ ] **H1** 在被索引的文件夹里一次性产生大量变更（`git checkout` 一个大分支）。
      **预期**：sidecar 日志出现
      `[watcher] N files changed in ... — escalating to a full re-index`，
      且**只跑一次**顺序全量索引，而不是几千个并发。

---

## 跨平台欠账

本轮改动全部走了跨平台 API（`PathBuf::join` / 无 unix-only 命令），
CI 三平台 typecheck + test + `cargo test` 已过。但以下只在 macOS 真机验过：

- [ ] Windows：A1 的日志路径（`~/.local/share/...` 在 Windows 上是
      `%USERPROFILE%\.local\share\...`——**与 acp-sessions 现有落点一致**，
      刻意保持一致而非改用 `%APPDATA%`）
- [ ] Windows / Linux：B2 的 sidecar 退出事件
