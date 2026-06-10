# 015 · Backend 接入分类法 —「支持 ACP 非二元」与非-ACP/HTTP 后端（openclaw vs hermes 文档/资料级调研）

> **状态**：调研记录（openclaw/hermes ACP 实现的**文档/资料级**调研——官方文档为主、个别点据第三方，**非运行实测、非直接读源码**）+ 讨论中（据此提出的 backend 分类法 / 选型决策树，待评审后修订 ADR-030）
> **日期**：2026-06-09
> **范围**：纯调研 + 分析，**不修改代码**。
> **缘起**：[ADR-027](../decisions/027-acp-multi-agent-backend.md)/[030](../decisions/030-agent-connector-control-layer.md)/[031](../decisions/031-multi-agent-orchestration.md) + [agent-os-target-architecture.md](../agent-os-target-architecture.md) 已把多后端架构定型为「opencode(REST) + ACP(多 agent)」双 backend。现要把「opencode / claude code 这类」推广到**也想接 openclaw / hermes 这类**——但它们对 ACP 的支持程度存疑（可能只擅长暴露 HTTP）。本文调研两者，回答「能否被 ACP 客户端调用、调用得好不好」，并据此完善 backend 接入抽象。
> **承接**：[013](./013-agent-os-acp-multi-backend.md)（Agent OS 可行性）· [011](./011-architecture-comparison.md)（横向对标 openclaw/hermes/opencode desktop）。
> **置信度**：本文是 desk research。hermes 侧主要据官方 ACP Internals 文档（描述 `acp_adapter/` 源码结构，较权威）；openclaw 侧据官方 CLI/Gateway 文档 + 一篇第三方博客（个别**代码级**断言仅第三方单一来源，已就地标注）。**真·实测（spawn agent、观察 `session/update`）是落地前待做项**，见 §11 信息缺口。
> **现网佐证（2026-06-10）**：竞品 AionUi 代码 `NON_ACP_BACKENDS = {aionrs, openclaw-gateway, nanobot, remote}` else `acp`——**独立印证本文的「ACP vs product-native 两族」分类法 + openclaw 走 gateway(WebSocket) 非 ACP**。详见 [016](./016-aionui-multi-agent-competitor.md)。

---

## TL;DR

1. **「支持 ACP」不是二元的**——这是本文核心结论。同样一句「支持 ACP」，实现质量可以天差地别。openclaw 与 hermes 恰好是两个极端，提供了完美对照。
2. **openclaw**：对外三条面——**ACP server（`openclaw acp`，最差**：Gateway 薄桥，缺权限/丢 MCP/无 diff·plan、loadSession 空线程）< OpenAI HTTP（中）< **WebSocket Gateway（native + 最富**：streamed agent events + tool results + approvals + sessions，第一方客户端全走它）。「走 native/最富」= WebSocket Gateway，但它是 openclaw **私有协议**，仍是 product-native bespoke（branch C）。
3. **hermes**：✅ 有 ACP server（`hermes acp`），且是 **原生实现**（直接包 `AIAgent` 执行循环）——**权限 / file diffs / plan / 每 token 流式全有**，与 claude/gemini 同级。
4. **架构含义**：backend 接入按「**传输族 × adapter 粒度**」两轴建模；选 backend 走「**该 agent 干净/原生的那条路**」而非看它「号称支持什么」。→ **hermes / qoder 落 branch A**（acp-stdio 通用 adapter，近零增量）；**openclaw 落 branch C**（黑盒二等后端、capabilities 降级、低优先；接入路径「acp-stdio 降级 vs rest-http bespoke」待定）。
5. **opencode 保持特权**：泛化抽象是「加宽 backend 类」而非「拉平 opencode」——opencode 是 `rest-http` 的 **default + reference**（公共事件模型即其 SSE 形状）。
6. **落地**：据本文修订 ADR-030（`BackendKind` 开放化 + 传输族 + 选型决策树 + 黑盒 capabilities 降级），并同步目标架构 §3.3/图。**主架构（分层/connector/orchestrator）不变。**

---

## 1. 问题：能把 openclaw/hermes「看成一类」接入吗？

目标架构当前只设两类 backend：`opencode`（REST）与 `acp`（多 agent）。用户希望把可接入范围推广到 openclaw / hermes 这类——但担心它们「不能很好支持 ACP，可能只能暴露 HTTP」。这引出两个必须用一手资料回答的问题：

1. **它们能否作为「被 ACP 客户端调用的 agent」**（即暴露 ACP server）？
2. 若能，**调用得好不好**（保真度——权限 / 工具 diff / plan / 流式 / 历史是否齐）？

下面 §3/§4 分别实测，§2 先给出从结论抽象出的心智模型。

---

## 2. 核心洞察：「支持 ACP 非二元」+ 传输族 × adapter 两轴

### 2.1「支持 ACP」是一个谱，不是开关
ACP 是协议契约，但 agent 可以**用任意方式实现它**：
- **原生**：直接把 agent 执行循环包成 ACP server，`session/update` 忠实反映内部状态（hermes、claude、gemini）。
- **薄桥 / 二次组装**：把 ACP 转译到自己另一套内部协议（openclaw：ACP→WebSocket Gateway），转译层会**漏掉**原协议表达不了或没接的能力（权限、MCP、diff…）。

→ **判断一个 agent 能否「像 opencode/claude 一样接」，不能只看它声称支持 ACP，要看它的 ACP（或 HTTP）面实际吐出什么。**

### 2.2 backend 接入两轴
把当前封闭的 `BackendKind = "opencode" | "acp"`（混了「具体 agent」与「协议」两个层级）升级为两轴：

**真正的轴是「协议族」不是「线缆」**：ACP 标准 vs 产品自有协议。线缆（stdio / HTTP+SSE / WebSocket）是 adapter 内部细节，**不改变 adapter 复用粒度**。两族**对等并列**（无主从），agent 按其支持情况分布其上：

| 轴 | 取值 | 说明 |
|----|------|------|
| **协议族（传输）** | `acp-stdio` / `product-native` / `acp-remote`(WIP) | ACP 标准 vs 产品自有；两族对等 |
| **adapter 粒度** | acp 一族**共用一个**通用 adapter；product-native **每产品一个** bespoke adapter | 决定接入边际成本 |

- `acp-stdio`：ACP 标准、stdio。**一个通用 adapter 接 N 个 agent**（claude/qoder/gemini/hermes…），边际成本≈配置 + per-agent 怪癖。**最省。**
- `product-native`：产品自有协议，**线缆 = HTTP+SSE 或 WebSocket**（opencode=HTTP+SSE，default+reference；openclaw=**WebSocket Gateway**；hermes-HTTP=HTTP+SSE）。每产品一个 bespoke adapter，各写各的归一化。**贵。**
- `acp-remote`：ACP over HTTP/WS，仍 WIP；价值是补 ACP 接不了远程 agent 的短板。

> **线缆 vs 协议族**：WebSocket / HTTP+SSE 都只是 `product-native` 族内部的线缆选择，**不单列成对等族**——因为它们都「每产品一个 adapter」，经济性一样。决定 adapter 复用粒度的是「ACP 标准 vs 产品自有」，不是「http vs ws」。

---

## 3. openclaw 调研（文档/资料级）

### 3.1 既是 ACP client，也是 ACP server
- **client**：`acpx`（独立仓库）= headless ACP client，驱动 claude/codex/opencode 等（[013](./013-agent-os-acp-multi-backend.md) §4 已述）。
- **server**：`openclaw acp` —— 官方文档原文「OpenClaw acts as an ACP server; an IDE or ACP client connects to OpenClaw; OpenClaw forwards that work into a **Gateway session**」。→ **它能被我们（ACP client）调用。**

### 3.2 但 ACP server 是 Gateway 的薄桥（印证「二次组装」）
链路：`IDE/Client → ACP over stdio → OpenClaw Bridge → WebSocket → Gateway → Agent`。文档：「This command speaks ACP over stdio for IDEs and forwards prompts to the Gateway over WebSocket. It keeps ACP sessions mapped to Gateway session keys.」ACP 只是它内部 WebSocket Gateway 协议的**转译层**，非原生。

### 3.3 缺口（对 Ultrawork 致命的两条加粗）

| ACP 能力 | openclaw 桥的表现（来源） | 对 Ultrawork |
|---------|------------------------------|--------------|
| `request_permission` | **从不发权限请求**，Gateway 侧直接执行（官方文档 + 第三方） | **打穿档1 W3 权限归一化**（permission-dock 无效） |
| `session/new` MCP servers | **静默丢弃**；官方文档「Bridge mode rejects per-session MCP server requests」，第三方称代码 log「ignoring N MCP servers」（⚠️代码级断言仅第三方单一来源） | **打穿档1 W4 宿主 MCP 注入**（知识库 RAG 进不去） |
| plan / thought | 不发，仅 output text + tool status | 无推理/计划渲染 |
| tool_call 富内容 | 只 status + raw output，**无 diff / locations / content blocks**，follow-along best-effort | ADR-029 渲染器只能画影子 |
| `loadSession` 历史重放 | 非桥创建会话返回**空线程**，否则 ledger 回放 | 跨重启恢复破 |
| StopReason | error 误报为 refusal，无 `max_turn_requests` | 状态失真 |
| usage | 近似、无 cost、仅 Gateway 标记 fresh 时发 | token/cost 页脚不可靠 |
| ✅ 可用 | 基本 prompt-response 流式、图片、slash 命令广告 | — |

### 3.4 另两条面：OpenAI 兼容 HTTP + WebSocket Gateway（后者才是 native）
openclaw 对外其实有**三条面**，ACP 桥（§3.2/3.3）只是其一且最差：
- **OpenAI 兼容 HTTP**：`POST /v1/chat/completions`（默认关）：`model:"openclaw/<agentId>"`、`stream:true` SSE、Bearer；**只回最终答案 + tool_calls 决策，不暴露中间推理**。粗，但是有文档的标准契约。
- **WebSocket Gateway（native，最富）**：官方文档「Gateway WS protocol is the **single control plane transport**；**ALL clients (CLI / web UI / macOS / iOS·Android / headless) connect over WebSocket**」。challenge-response 握手 + 协议版本协商 + `OPENCLAW_GATEWAY_TOKEN`/device token + loopback :18789。Chat/agent API：`chat.history/send/inject`，**streamed agent events + tool-call results（需 `operator.read`）+ approvals + sessions**。schema `packages/gateway-protocol/src/schema.ts`。→ **这才是 openclaw 的 native 线缆，第一方客户端全走它**；它**有 approvals/agent events**，比 ACP 桥（丢权限）富。

> **openclaw 定性（修正）**：它是**编排平台**，对外三条面优劣分明——**WebSocket Gateway = native + 最富**（agent events + approvals + sessions）> OpenAI HTTP（中）> ACP 桥（最差，丢权限/MCP/diff）。所以「走原生/最富」的那条是 **WebSocket Gateway**，但它是 openclaw **私有协议**（非 ACP/非 opencode 形状），走它仍是 **product-native bespoke adapter（branch C）**——要实现其握手 + 归一化其 agent 事件。**接入路径 open sub-decision**（见 §10-2）：(a) 复用通用 acp-stdio adapter（最省，但走最差的 ACP 桥，丢权限/有 bug）；(b) **WebSocket Gateway bespoke**（贵，但 native + 保真最高，diff/plan 粒度待验）；(c) OpenAI HTTP bespoke（中）。仍是**黑盒二等后端 + 私有协议**，capabilities 视所选面而定。

---

## 4. 原生富 ACP agent 调研 — hermes 与 qoder（branch A）

### 4.1 原生 ACP server（不是桥）
`hermes acp` 子命令「runs the agent in a fundamentally different I/O mode (JSON-RPC over stdio) and **wraps the AIAgent execution loop** with protocol-specific message framing, capability negotiation, and session lifecycle management」。`acp_adapter/server.py` 直接实现 ACP agent 协议（stdout 走 JSON-RPC，日志走 stderr）——**直接包自己的 agent loop，无内部协议转译。**

### 4.2 保真度：openclaw 缺的，hermes 全有

| ACP 能力 | hermes（据官方 ACP Internals 文档对 `acp_adapter/` 的描述） |
|---------|------------------------------|
| 权限 | `permissions.py` 把危险终端审批**映射成 ACP `request_permission`**；allow_once/always/reject + 第三档「Allow for session」全有 |
| 工具富内容 | `tools.py` 映射 tool kinds：**patch/write_file → file diffs**、terminal → shell 文本、read/search → text preview |
| 流式 | **每 token chunk + 每 tool call + plan update** 实时 `session/update` |
| 会话 | new / load / resume / **fork** / list / cancel 全套 |
| 事件桥 | AIAgent 跑 worker 线程，ACP I/O 在主 loop，用 `run_coroutine_threadsafe`；**FIFO 跟踪 tool ID** 防 completion 串台 |

### 4.3 per-agent 怪癖 + 备选 HTTP
- 以 `acp.run_agent(agent, use_unstable_protocol=True)` 跑——**unstable protocol 标志，需复核版本协商**。
- Python 入口（`hermes acp` / `python -m acp_adapter`），env 读 `~/.hermes/.env`。
- **也有** OpenAI 兼容 HTTP API（:8642，`API_SERVER_ENABLED` + `API_SERVER_KEY`，`/v1/chat/completions`、`/v1/models`、`/health`）——**但其 ACP 已是富流，无须退到 HTTP**（与 openclaw 相反）。

> **hermes 定性**：原生富 ACP，与 claude/gemini 同级。**branch A**——acp-stdio 通用 adapter 直接覆盖，**不必写 bespoke backend**，近零增量（仅配置 + unstable-protocol 怪癖）。

### 4.4 qoder-cli（阿里 Qoder CLI，branch A 第二例）
**原生 ACP agent**（非桥）：Zed ACP agent 注册页定性为「A full-featured CLI coding agent with **ACP support**」，列能力「**Subagent / MCP server integration / Slash commands(/init,/review) / Permission configuration / Multimodal input**」——即权限 + MCP + 多模态齐，与 claude/gemini/hermes 同级。

- **落档**：**branch A**（acp-stdio 通用 adapter，零增量），与 hermes 同。Qoder CLI「implements this protocol standard to integrate with any client that implements the ACP protocol」。
- **⚠️启动命令两源不一（必实测）**：
  - **Zed agent 页**：command `qoder`，args `["acp"]` → `qoder acp`。
  - **Qoder 官方 CLI 文档 + acpx adapter**：command `qodercli`，args `["--acp"]` → `qodercli --acp`（acpx 内置映射 `qoder → qodercli --acp`）。
  - → **二进制名（`qoder` vs `qodercli`）与 flag（子命令 `acp` vs `--acp`）都有歧义**，落地前以实机 `--version`/`--help` 探测确认（这正是 [013](./013-agent-os-acp-multi-backend.md) 信息缺口里那条，现缩小但未完全消除）。
- **认证**：`QODER_PERSONAL_ACCESS_TOKEN` env，启动自动登录（Zed/acpx 均在 agent server env 注入）。
- **per-agent 怪癖**：acpx 已知 **启动 ~750ms + benign stdout 过滤**（见 [014](./014-stage1-acp-normalization-plan.md) W5）；另有第三方报告 **slash 命令经 ACP 在某些 client 不可用**（JetBrains YouTrack LLM-25183），落地前验证 `/init`、`/review` 透传。

> **qoder 定性**：原生富 ACP（权限/MCP/多模态齐），**branch A 零增量**；唯一注意点是**启动命令/flag 需实测锁定** + slash 命令透传待验。国内场景值得作 claude/opencode 之后的优先验证项。

---

## 5. 两极对照（本文核心论据）

| 维度 | openclaw | hermes |
|------|----------|--------|
| ACP 实现 | 薄桥（ACP→WebSocket Gateway 二次组装） | 原生（直接包 agent loop） |
| 权限 | ❌ 从不发 | ✅ 原生 request_permission |
| MCP 注入 | ❌ 静默丢弃 | ✅（标准 ACP） |
| 工具 diff/plan/thought | ❌ 无 | ✅ 全有 |
| loadSession | ❌ 空线程 | ✅ resume/fork |
| 落档 | **C → 黑盒二等后端，低优先**（降级 acp-stdio vs product-native WS bespoke 待定，§10-2） | **A → acp-stdio 通用，零增量** |
| 「支持 ACP」 | 名义支持、实为有损 | 名实相符 |

> 本表对照的是**两者的 ACP 面**（论证「支持 ACP 非二元」）。注意 openclaw 另有更富的 **WebSocket Gateway native 面**（§3.4，有 approvals/agent events）——它仍是 branch C 私有协议 bespoke，但保真度未必如其 ACP 面那么差。

**结论**：同一句「支持 ACP」，hermes 的 ACP 面直接可复用通用 adapter，openclaw 的 ACP 面接了只是二等黑盒（且其真正 native 面是 WebSocket，不是 ACP）。**「支持 ACP 非二元」被实证。**

---

## 6. backend 分类法 + 选型决策树（提案）

### 6.1 分类表
| 传输族 | adapter 粒度 | 成员 | 归一化成本 |
|--------|-------------|------|-----------|
| **acp-stdio** | 一个通用 adapter 接 N agent | claude / qoder / gemini / **hermes** / opencode-acp… | 最省（配置 + per-agent 怪癖） |
| **product-native**（HTTP+SSE / WebSocket） | 每产品一个 bespoke adapter | **opencode（HTTP+SSE，default + reference）** · **openclaw（native = WebSocket Gateway；或降级走 acp-stdio，§10-2）** · hermes-HTTP（不需要） | 高（各自从头归一化） |
| **acp-remote**(WIP) | 同 acp 通用 | 远程可达 ACP agent | 补远程短板 |

### 6.2 选型决策树（按 agent 原生/干净 + 保真 + 性能选，不看「号称支持什么」）
```
A. 原生 stdio ACP 且富保真          → acp-stdio（通用 adapter，最省）   例：claude / gemini / hermes / qoder
B. 产品自有协议是其主路径且深度够   → product-native bespoke（HTTP+SSE / WS）  例：opencode（HTTP+SSE，default）
C. 名义支持 ACP 但实为有损桥 / 本质是产品平台
       → 黑盒二等后端 + capabilities 降级；选「最省」还是「最 native/最富」按保真+性能权衡：
         降级 acp-stdio（复用通用 adapter，省，但走最差面）vs product-native bespoke
         （走其 native 线缆——openclaw 即 WebSocket Gateway——保真最高但贵）= open（§10-2）   例：openclaw
D. 仅远程可达                       → acp-remote(WIP) 或其 HTTP API
```
> **多面取舍**：一个 agent 暴露多条面时，**选 native + 保真最高 + 性能最优**的（如 openclaw 选 WebSocket Gateway 而非 ACP 桥），除非成本不划算才退而求其次。

---

## 7. opencode 的特权（承接补充1）
泛化抽象**不降级 opencode**。它在 `rest-http` 族里是：
- **default**：connector `defaultBackend = opencode`，新会话不选就是它（Ultrawork 现状即如此）。
- **reference**：ADR-030 C3「公共事件模型 == opencode SSE 形状」——所有 backend 归一化的**标尺**就是 opencode。
- **最深集成**：ADR-027 D-1，REST 路径承载 permission/question/file 深度。

→ 抽象是「加宽 backend 类」，opencode 仍是一等公民 + 基准。

---

## 8. 黑盒 backend 的 capabilities 降级（机制已就位）
openclaw 这类只能用 ADR-030 D-5 的 `capabilities` 声明兜住——精确 false 清单（源级实测得出）：
```
capabilities(openclaw): {
  permissions: false,      // 不发 request_permission
  mcpInjection: false,     // session/new MCP 被丢弃
  fileDiffs: false,        // tool_call 无 diff/locations
  plan: false, reasoning: false,
  historyReplay: false,    // loadSession 空线程
  usageCost: false,
}
```
UI 按 capabilities 条件渲染 + 诚实标注「该后端只回成果，无权限/无知识库注入」（同档2 delegate 保真度边界话术）。**档2 orchestrator 可 delegate 给 openclaw 当强力叶子，但不内省/steer 其内部 agent——不做 orchestrator 联邦。**

> **回扣 ADR-030**：无论走降级 acp-stdio 还是 rest-http bespoke，openclaw backend 都 `implements AgentBackend`（`createSession/prompt/cancel/subscribe` + `capabilities`），只是底层传输与能力声明不同——**不是另起炉灶的并行客户端**，仍统一在 connector 后。

---

## 9. 对现有文档的影响（✅ 已落地，2026-06-09）

| 文档 | 修订点 | 状态 |
|------|--------|------|
| **ADR-030 D-8** | `BackendKind` 开放化（封闭 union → 协议族 + adapter 注册）；传输族分类法（§6.1，`acp-stdio` / `product-native`(HTTP+SSE/WebSocket) / `acp-remote`）+ 选型决策树（§6.2）；opencode default/reference 特权；黑盒 capabilities 降级（§8） | ✅ 已就地修订 |
| **agent-os-target-architecture.md** | §0 加 C4（分类法）/C5（openclaw·hermes·qoder 接入）；§3.3 标注「backend 类开放、传输族、未来扩展」 | ✅ 已同步 |
| **gotchas.md**（可选） | openclaw ACP 桥的缺口（丢 MCP / 无权限）作为「接入坑点」备查 | 待定 |

---

## 10. 待决策 / 待实测
1. **落地方式**：~~就地修订 ADR-030 vs 新立 ADR-032~~ → ✅ **已定：就地修订 ADR-030 D-8**（2026-06-09 落地）。
2. **openclaw 要不要真接 + 走哪条面**：架构上能，但私有协议 bespoke + IM channel 与护城河竞合（[013](./013-agent-os-acp-multi-backend.md) §8）+ 投入产出比低 → 建议**可选低优先，不进首批**（首批仍 claude + opencode）。若接，**面未定**：降级 acp-stdio（复用通用 adapter，最省，但走最差的 ACP 桥）vs **WebSocket Gateway bespoke**（native + 最富，但实现其私有握手/协议、贵）vs OpenAI HTTP bespoke（中）——落地前据真·实测的保真度排序再定。
3. **hermes 接入排期**：落 branch A 零增量，但非首批；档1 通用 acp adapter 做扎实后顺带验证（含 unstable-protocol 复核）。
4. **acp-remote**：等 ACP 远程传输 GA 再纳入；当前远程需求走 HTTP。

---

## 11. 信息缺口 / 置信度（落地前需补）

本文是 **desk research**，非运行实测、非直接读源码。下列项在据本文修订 ADR-030 / 真正接入前必须补齐：

- **openclaw 源码未直读**：缺口表依赖官方 CLI/Gateway 文档 + **单一第三方博客**；「ignoring N MCP servers」等**代码级**断言仅第三方来源，须读 `openclaw acp` 桥源码核验。
- **hermes 据官方文档（描述源码），非直读码**：`acp_adapter/{server,tools,permissions}.py` 的行为按官方 ACP Internals 描述采信；`use_unstable_protocol=True` 的**具体协议版本 / 协商行为未定**，落地前须实测 `initialize` 结果。
- **真·实测全部待做**：两者都未 spawn 运行、未观察真实 `session/update`。openclaw 缺口、hermes 富保真都需运行验证后才能从「调研结论」升级为「实测结论」。
- **qoder 启动命令仍有歧义**：本文已调研定性为 branch A 原生富 ACP（§4.4），但**启动命令两源不一**（Zed 页 `qoder acp` vs Qoder 文档/acpx `qodercli --acp`，含二进制名 `qoder` vs `qodercli`）+ slash 命令经 ACP 透传，须实机 `--version`/`--help` 探测锁定（缩小了 013 缺口但未完全消除）。
- **openclaw 各面的渲染粒度未验**：WebSocket Gateway 是**已证实的对外客户端协议**（官方文档），其 `streamed agent events` 是否含 diff/plan/locations 等细粒度（供 ADR-029 渲染器用）未实测；OpenAI HTTP 的 tool_call 细节同样未验。三条面的真实保真度排序需运行后才能锁定。

---

### 来源
- **openclaw**：[`openclaw acp` CLI 文档（ACP server + Gateway 桥 + 限制）](https://docs.openclaw.ai/cli/acp) · [ACP protocol gaps 逐条](https://shashikantjagtap.net/openclaw-acp-what-coding-agent-users-need-to-know-about-protocol-gaps/) · [Gateway WebSocket Protocol（native 客户端协议，chat/agent/approvals）](https://docs.openclaw.ai/gateway/protocol) · [Gateway OpenAI 兼容 HTTP API](https://docs.openclaw.ai/gateway/openai-http-api) · [acpx 仓库（ACP client）](https://github.com/openclaw/acpx) · [ACP agents 文档](https://docs.openclaw.ai/tools/acp-agents)
- **hermes**：[ACP Internals（acp_adapter/server·tools·permissions）](https://hermes-agent.nousresearch.com/docs/developer-guide/acp-internals) · [ACP Server Mode Issue #569](https://github.com/NousResearch/hermes-agent/issues/569) · [DeepWiki: ACP Server & IDE Integration](https://deepwiki.com/NousResearch/hermes-agent/10.6-acp-server-and-ide-integration) · [HTTP API Server 文档](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server/)
- **qoder**：[Qoder CLI ACP 文档](https://docs.qoder.com/cli/acp) · [Zed ACP agent 页（qoder-cli，能力/命令）](https://zed.dev/acp/agent/qoder-cli) · [acpx（qoder→qodercli --acp 映射）](https://acpx.sh/) · [JetBrains YouTrack LLM-25183（qoder/opencode slash 命令问题）](https://youtrack.jetbrains.com/issue/LLM-25183)
- **内部**：[013 Agent OS 可行性](./013-agent-os-acp-multi-backend.md) · [ADR-027](../decisions/027-acp-multi-agent-backend.md) / [ADR-030](../decisions/030-agent-connector-control-layer.md) / [ADR-031](../decisions/031-multi-agent-orchestration.md) · [agent-os-target-architecture.md](../agent-os-target-architecture.md)
