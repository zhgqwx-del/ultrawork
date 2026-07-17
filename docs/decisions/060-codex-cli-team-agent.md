# ADR-060：Team 外部 Agent 接入 OpenAI Codex CLI（经 ACP 桥）

- 状态：已实现（Accepted）—— typecheck 8/8 + desktop **664**（含 3 例新 codex fixture shaping）+ 5 轮真机 spike；真机观感 / Team 视觉待用户
- 日期：2026-07-17
- 相关：ADR-027（ACP 多 Agent 后端，本 ADR 的地基）· gotchas §8（ACP 实测坑点 SSOT）· discussions/013-014（ACP 探索）
- 关联轮次：外部 Agent 扩容（claude/gemini/qoder/hermes → +codex）

## 背景

Team 协作模式（外部 Agent，`@agent/acp-client` sidecar :4099）已支持 claude / gemini / qoder / hermes，本质是一个**协议无关的 ACP-over-stdio 注册表**：每个 agent = `{label, command, args, env}` 三元组，`ACPConnection` 直接 `Bun.spawn` 走 JSON-RPC stdio（`acp-connection.ts`）。本机已安装 OpenAI Codex CLI（`~/.local/bin/codex`，`codex-cli 0.144.5`，`~/.codex/auth.json` 已登录 ChatGPT），需求是把它纳入外部 Agent。

**协议现实**：Codex CLI **原生不说 ACP**（只原生支持 MCP；OpenAI issue #9085 仍在 tracking）。因此不能像 gemini 那样 `--experimental-acp` 直接上，必须经一个 ACP 桥。

## 决策

**D1 采用官方 npm 桥 `@agentclientprotocol/codex-acp`，走既有 bunx 路径接入，不引入二进制分发。**

接入三元组（已真机验证）：

```
id: "codex"   label: "Codex CLI"
command: "bunx"   args: ["@agentclientprotocol/codex-acp"]   # 不带 --bun（桥自带 @openai/codex 重运行时；与 gemini 同）
env: { NO_BROWSER: "1", INITIAL_AGENT_MODE: "agent" }         # headless 不弹浏览器；认证复用 ~/.codex；默认 workspace-write 沙箱
```

- 桥 `1.1.4` 依赖 `@agentclientprotocol/sdk@^1.2.1`，与本机 `@openai/codex@^0.144.4`（≈本机 0.144.5）对齐。
- 认证**零配置复用** `~/.codex/auth.json`（本机 ChatGPT 登录），无需 API key。首次未登录者需先 `codex login`（与 claude/gemini 复用本地登录同款前置）。

**D2 桥选型：npm 桥 over Rust 桥。** `zed-industries/codex-acp`（Rust）需 `cargo build`/管二进制；npm 桥与现有 claude 适配器（`@agentclientprotocol/claude-agent-acp`）**完全同构**，三平台一致、零二进制负担。

**D3 v1 采用 Codex 默认 Agent 模式（`workspace-write` + `on-request`）；Ultrawork 权限门对 codex 通用生效，codex escalate 时照常浮到弹窗，无死锁风险。**

澄清（曾误述为"不接管权限 UI"，实测纠正）：Ultrawork 的 `requestPermission` 处理器（`acp-connection.ts:717-748`）**协议级、与 agent 无关**——任何 ACP agent escalate 都会发出 `permission.asked`（Team 权限弹窗为其通用渲染，与 claude/gemini 同一条事件），无人应答则 300s 自动拒绝（`:728`）。已实测往返打通（见契约 §5）。

三种 session mode（桥经 `INITIAL_AGENT_MODE` 选，源码 25665）在"放行 / escalate / 硬拒"上权衡不同：

| 模式（INITIAL_AGENT_MODE） | 审批策略 | 沙箱 | v1 行为 |
|---|---|---|---|
| `agent`（**v1 默认**） | on-request | workspace-write | 工作区内自动放行；越界/风险动作**部分 escalate 到弹窗、部分被沙箱硬拒**；网络关 |
| `read-only` | on-request | read-only | **任何写都 escalate 到弹窗**（parity 最高，但提示最多） |
| `agent-full-access` | never | danger-full-access | 全放行、无沙箱（不用） |

v1 选 `agent`：与 codex 自身默认一致、弹窗噪声低、危险动作由沙箱兜底且可 escalate 的会浮到 UI。用户可在「设置 → 外部 Agent」的 env 字段把 `INITIAL_AGENT_MODE` 改成 `read-only`（模板代码注释有提示）。**取舍**：默认 Agent 模式下，越界 `apply_patch` 类写会被 codex **硬拒**（用户看到"被拦"、但无"允许"按钮可放行）——这是 UX 短板、**非死锁**（turn 干净结束）。要"每个写都可由用户放行"改用 `read-only`；模式选择器留 follow-up。

**D4 首版 UI 改动最小化：仅扩模板 + 联合类型，sidecar 注册表无需改动。**

### 精确改动清单（v1，已落地）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `packages/client/desktop/src/components/settings/agent-templates.ts` | `AgentTemplate.key` 联合类型加 `"codex"`；`AGENT_TEMPLATES` 加 codex 条目（command/args/env + envHint 如上） |
| 2 | `packages/agent/acp-client/scripts/spike-codex.ts` | spike 脚本归档进仓库（与 spike-claude/hermes 同款留存，供 follow-up 复验；含 tool/escape/perm 三模式） |
| 3 | `packages/client/desktop/src/__tests__/fixtures/acp-codex-turn.json` | spike `tool` 模式产出的真实事件流 fixture（默认 agent 模式，38 events） |
| 4 | `packages/client/desktop/src/__tests__/components/chat/acp-turn-shaping.test.ts` | +3 例 codex shaping 测试（工具步骤入过程消息 + 末条纯文本答案 + 终态 finish，镜像 hermes 块） |
| 5 | `docs/decisions/060-*.md` + `README.md` 索引 | 本 ADR |
| 6 | `docs/gotchas.md` §8 | Codex 契约；`CHANGELOG.md` [Unreleased] Added |

**注意**：`DEFAULT_AGENTS`（`agents-config.ts`）保持 claude-only 不动——沿用既有约定（二进制是否存在因机而异，模板是一键填充、非默认注册）。用户在「设置 → 外部 Agent」一键添加 codex。

### 实测契约（→ gotchas §8）

5 轮真机 spike 确证：

1. **协议**：npm 桥（sdk 1.2.x）与本仓库 `@agentclientprotocol/sdk@0.25.0` 客户端**协商到 protocol v1**，干净握手。**wire 协议整数与 npm 包版本号解耦**——无需 bump 本仓库 SDK，也无需钉旧桥。
2. **认证**：`NO_BROWSER=1` + 零 env key，直接复用 `~/.codex/auth.json` 跑出真实 GPT-5 回答 + token 计数。`NO_BROWSER` 只隐藏浏览器登录法的广告，不影响已缓存登录。
3. **能力**：`loadSession:true`（会话恢复）、`image`+`embeddedContext`（多模态输入）、reasoning 流可渲染（`agent_thought_chunk`）。工具流 shaping 与 claude 一致（过程消息带 tool parts、末条纯文本答案、`finish=stop`）。
4. **沙箱（行为实证）**：默认 workspace-write —— cwd 内写文件放行且真落盘；cwd **外** `apply_patch` 写被 Codex 硬拒、文件未创建、`stopReason=end_turn`（无挂起）。三种 session mode 由桥定义（源码核验 25585-25670），经 `INITIAL_AGENT_MODE` 选。
5. **审批往返（行为实证，perm 轮）**：`INITIAL_AGENT_MODE=read-only` + shell 写 → codex 经 `session/request_permission` **escalate** → 我方 `requestPermission` 发出 `permission.asked`（kind=`bash`）→ 回 `replyPermission("once")`（accepted=true）→ `permission.replied` → bash 工具 `completed` → **`codex-perm.txt`=`ok` 真落盘**（read-only 沙箱本会拦，批准确实解锁）→ `end_turn`。**证明权限门对 codex 通用生效、可应答、批准回传解锁、全程无死锁。**
6. **无死锁（结构保证）**：① 默认模式 codex 多数自决（放行/硬拒即时返回，无挂起）；② 若 escalate，通用处理器发 `permission.asked`（现有 UI 渲染）；③ 无人应答 300s 自动拒绝 + idle 看门狗在工具相位解除（不误杀合法等待）。最坏 = 卡 300s 后静默拒绝，非无限等待。

## 考虑过的替代方案

- **Rust 桥 `zed-industries/codex-acp`**：需 cargo 构建 / 预编译二进制分发，与三平台打包体系耦合，运维成本高。npm 桥零二进制负担且与现有 claude 适配器同构 → 弃。
- **等 Codex 原生 ACP（issue #9085）**：无时间表，且会阻塞需求 → 弃。
- **走 Codex 原生 MCP 而非 ACP**：MCP 是"给 agent 挂工具"，不是"把 Codex 当成一个可被调度的 agent"；与外部 Agent 的 ACP 编排模型不匹配 → 弃。
- **首版默认用 `read-only` 模式追求权限弹窗最大 parity**：每个文件写都弹窗，噪声过高、打断 Team 流 → 弃；用默认 `agent`，escalate 的动作照样浮到 UI，其余由沙箱兜底。模式选择器留 follow-up。
- **首版直接用 AgentFullAccess 模式**：`never` 审批 + 无沙箱，安全语义比默认 Agent 差 → 弃，用默认 workspace-write。

## 影响面

- **纯接入 + renderer 改动**，不碰后端数据层 / Tauri；三平台一致（bunx 路径与 claude 同）。
- 单会话不受影响；Team 会话把 codex 当作又一个可选 agent。
- 复用全部既有通用能力：权限循环骨架、两级 idle 看门狗、三段式优雅关闭、session/load 失败回退、`_meta.systemPrompt` 探测回退、EXTRA_PATH_DIRS（含 `~/.local/bin`，正是本机 codex 所在）。
- **安全**：codex 自带 workspace-write 沙箱是**行为验证过的真边界**（越界/联网被拦），比 IM 渠道当前"无沙箱 + 无条件放行"更安全。

## 验证（已执行）

- 5 轮真机 spike（no-tool 协议+认证 / tool 工具流 / workspace-write 与 read-only CODEX_CONFIG / escape 越界写硬拒 / **perm read-only escalate→批准→解锁往返**）+ 桥源码核验（审批映射 23960-24030、session mode 25585-25670、`INITIAL_AGENT_MODE` 25665）。产出 `acp-codex-turn.json` fixture。
- `turbo run typecheck` **8/8 绿**；`cd packages/client/desktop && bun run --bun test` **664 passed**（基线 661 + 3 codex shaping）。
- 待用户：真机在「设置 → 外部 Agent」一键添加 codex → Team 发一轮带工具消息走查；真机观感 / Team 视觉。

## 非目标 / 权衡（v1 明确不做）

- **不做 session mode 选择器**（follow-up）：v1 固定默认 `agent` 模式（可经模板 env 手改）。权衡：默认模式下越界 `apply_patch` 写被 codex 硬拒、用户无"允许"按钮放行（非死锁，见 D3）；需要"每写可批"的用户暂时无法在 UI 切 `read-only`。
- **不改 `DEFAULT_AGENTS`**：codex 仍是"一键添加"而非默认注册。
- **不做 codex 专属 quirks 代码**（`applyCodexQuirks`）：v1 靠模板 env 的 `NO_BROWSER` + `INITIAL_AGENT_MODE` 即可，默认 session mode 已合适。
- **Windows/Linux 真机未验**：本机为 macOS；并入既有跨平台欠账批次（bunx 路径与 claude 同构，风险低）。

## 使用提示：单 agent vs Team（验收期发现）

**⚠️ 权限弹窗有两个正交来源，勿混淆**：
- **(A) 沙箱层**（codex 自己）= `INITIAL_AGENT_MODE`：`agent`（v1 默认，workspace-write）工作区内写大多直接执行、不逐次弹；`read-only` 每次写都弹。控制的是"codex 动文件/命令要不要弹"。
- **(B) 编排层**（Team Leader）= codex 作 Leader 调 `orchestrator_delegate` 委派 MCP 触发的权限，与 codex 沙箱无关、任何 agent 作 Leader 都一样。
- **后果**：即便选 `agent`（顺滑、少弹窗），Team-Leader 场景仍会因**委派**看到弹窗——那来自 (B) 不是 (A)。要观察 (A) 的"写文件不弹窗"须在**单 agent 模式**下看。

- **codex 既可作单 agent、也可作 Team Leader**（同一注册表条目，两模式共用 `ACPConnection`）。
- **只配 codex 一个成员的 Team 是退化配置**：Team Leader 会话被注入"只管委派、不要自己动手"的 system prompt（`team-leader-prompt.ts`）+ `orchestrator_delegate` 委派 MCP（`team-routes.ts:66` `orchestrate:true`）。若团队里只有 codex，Leader 要么把活委派给一个 codex 子会话（多一层 + 委派 MCP 调用的权限确认弹窗），要么干脆自己写——都绕远。这是既有编排行为，与 codex 接入本身无关（任何 agent 单独组队都退化）。
- **建议**：想让 codex **直接执行**任务 → 用**单 agent 模式**（把会话直接绑到 codex），单体 codex 工作区内写不弹窗、直接跑（spike 反复验证）。**Team 模式留给多成员场景**（codex 当 Leader 分派给 claude/opencode 等）。
- 真机验收观察到：codex 作 Leader、单成员团队跑"创建文件"任务时出现一次权限确认弹窗，批准后文件正常创建。**最可能**是 Leader 调 `orchestrator_delegate` 委派时的 MCP 工具权限（代码确证 Leader 走委派 + perm 轮确证 codex 会为工具调用发 `permission.asked`），但**未在裸 spike 独立复现**（委派需完整运行的编排栈才有真工具）——记为待坐实观察项，非阻塞。

## Follow-up（另立任务，非 v1）

1. **session mode 选择器**：把 `read-only / agent / agent-full-access` 暴露到「外部 Agent」设置（经模板 env `INITIAL_AGENT_MODE`，或引入 `applyCodexQuirks` + ACP session/set_mode）。选 `read-only` 即达到"每个文件写都可由用户在弹窗放行"的最高 parity（perm 轮已实测该路径通）。默认仍 `agent`。
2. **默认模式硬拒的 UX 打磨**：默认 `agent` 下越界 `apply_patch` 写被硬拒且无放行入口——评估是否默认改 `read-only`、或提示用户可切模式。
3. **thought_level / reasoning effort**：codex 有 reasoning effort，确认是否经 ACP session config option 暴露（`applyThoughtLevel` 可复用）。
4. **Windows/Linux 真机验收**。
