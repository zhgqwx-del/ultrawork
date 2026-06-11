# Agent OS — 开发启动指引（Kickoff）

> **用途**：换窗口 / 换电脑 / 换项目时，直接取用的启动方式与首条 prompt，免回翻对话。
> **配套**：架构以 [agent-os-target-architecture.md](./agent-os-target-architecture.md) 为唯一事实源；决策见 [ADR-027](./decisions/027-acp-multi-agent-backend.md)/[030](./decisions/030-agent-connector-control-layer.md)/[031](./decisions/031-multi-agent-orchestration.md)；调研见 [discussions/013](./discussions/013-agent-os-acp-multi-backend.md)（可行性）/[015](./discussions/015-backend-taxonomy-non-acp.md)（backend 分类法）/[016](./discussions/016-aionui-multi-agent-competitor.md)（AionUi 竞品+参考）。
> **状态**：阶段0-1-2 已全部落地（三 agent 真机 + W4b 历史持久化 + @agent/connector 控制统一 + 绑定 sidecar 持久化，见 ADR-027/030 状态行与 CHANGELOG）。**剩余**：阶段3 编排（ADR-031）。新窗口的首条 prompt 按 MEMORY「Current Status → 下一步」出题即可；下方 §1 的原始 prompt 是阶段0 起步用的，**已完成、仅留档**。

---

## 0. 启动前必读顺序（最小集）
1. `agent-os-target-architecture.md` §0 决策基线、§3.1-3.3 分层、**§3.6 对现有 UX 影响与共存策略**、§8 开发起点。
2. ADR-027 实现章节 + `discussions/014`（阶段1 file:line 级底稿）。
3. `docs/gotchas.md` 的 OpenCode / MCP / 构建章节。
> `015/016` 等到接其它 backend、做档2 编排时再读。

---

## 1. 同一个 ultrawork，新窗口启动开发

```bash
cd /Users/zhangguoqiang/ai-workspace/claude-workspace/ultrawork01/ultrawork
claude
```
自动加载 CLAUDE.md + AGENTS.md + MEMORY.md（含 Current Status，指向目标架构 §0）。

**首条 prompt（直接贴）**：
```
启动 Agent OS 开发。先读：
- docs/agent-os-target-architecture.md（§0 决策基线、§3.1-3.3 分层、§3.6 对现有 UX 影响与共存策略、§8 开发起点）
- ADR-027 实现章节、docs/discussions/014（阶段1 file:line 级底稿）
- docs/gotchas.md 的 OpenCode/MCP/构建章节

按 §8 从阶段0 起步：当前 main 上「参考重写」feat/acp-support 的 ACP Client
Sidecar(:4099)/UnifiedAgent/agents.json（不 cherry-pick 旧渲染器，保留 ADR-029），
首批只做 claude + opencode。

第一步聚焦最高风险点 W1 turn 整形：做一个最小 spike——sidecar 把 claude 的
session/update 整形成 opencode SSE 形状（过程 message + 独立答案 message +
finish 终态），端到端验证 buildTurnModel 正确切 process/answer，再铺开其余归一化。

先给实现计划，我确认后再写代码（可用 plan mode）。
```

**安全网（§3.6）**：档1 原地增量、档2 独立 opt-in 面；唯二回归风险区 = **W1 turn 整形质量**（仅影响非-opencode 会话）+ **connector 迁移回归**（影响现有 opencode）。

---

## 2. 换电脑 / 另一个类似项目，参考本架构

### 2.1 哪些随 git 走、哪些不走
| | 内容 | 在哪 |
|---|------|------|
| ✅ 随 git（已 push main） | target-arch、ADR-027/030/031、discussions 011-016、AGENTS.md、CLAUDE.md、gotchas/conventions | 仓库，clone 即得 |
| ❌ 不随 git | **MEMORY.md**（`.claude/memory/`，gitignore、本机私有） | 留本机——但它是**瞬时状态**，非设计；durable 知识按 SSOT 都在 git 文档 |

→ 架构设计**完整在 git**，换电脑/换项目都拿得到；MEMORY 丢失不影响（只是环境/进度便签）。

### 2.2 场景 A：同一个 ultrawork、换台电脑
```bash
git clone <repo> && cd ultrawork && ./setup.sh   # submodule init + patch apply + build 全自动
claude
```
然后用 §1 的首条 prompt。（MEMORY 不在，新机重建 Current Status，无碍。）

### 2.3 场景 B：另一个类似项目，参考本架构做开发
docs 是「独立完备」蓝图，但有 **ultrawork 专属假设**需先映射：

| 可直接移植（与栈无关） | 需为新项目重定（ultrawork 专属） |
|---|---|
| 三档模型、**backend 分类法 D-8**（协议族 × adapter）、ACP 归一化放 sidecar(D-3)、connector 控制层、档2 经宿主 MCP delegate、否决对等换手、AionUi 参考/共存范式 | **默认后端**（ultrawork=opencode REST；新项目自定）、ADR-029 渲染器、Tauri 壳、opencode 深度集成、包结构、`/session/:id` 等路由 |

**启动 prompt（在新项目里贴，或让新项目 Claude 读本仓库）**：
```
参考这套 Agent OS 架构（来自 ultrawork 项目）为本项目做设计：
- 先读 docs/agent-os-target-architecture.md + ADR-027/030/031 + discussions/013/015/016。
- 这套设计基于 opencode(REST 默认后端) + ADR-029 渲染器 + Tauri，请逐条甄别：
  哪些是与栈无关的可移植决策（三档模型 / backend 分类法 D-8 / sidecar 归一化 /
  connector / 档2 host-MCP delegate / 否决对等换手），哪些是 ultrawork 专属需替换
  （默认后端、渲染器、桌面壳、包结构）。
- 据本项目的栈/默认后端/UI 重映射后，给一份适配版目标架构 + 分阶段计划。
先讨论适配方案，不写代码。
```

### 2.4 法律
本仓库文档是你自己的。若参考/copy 了 [AionUi](https://github.com/iOfficeAI/AionUi)（**Apache-2.0**）的代码片段，需保留版权/NOTICE 归属；多数情况是**模式参考**而非 1:1 搬运（Tauri vs Electron、SSE vs IPC），且其编排 handler 源不公开须自研（[016](./discussions/016-aionui-multi-agent-competitor.md) §9）。

---

## 3. 一句话
**设计可移植、且已全在 git。** 同项目换机：clone + `./setup.sh` + §1 prompt；新项目参考：读 docs + 把「ultrawork 专属」那列换成新项目对应物（§2.3）。开发第一步永远是 **阶段0 重写 + W1 turn 整形 spike**。
