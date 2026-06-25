# ADR-035: 委派 owner-session 归属（DelegateDock 按发起会话精确过滤）

**状态**: Accepted (✅ 已实现，opencode `_meta` 运行时验证 + claude adapter 源码确证)
**日期**: 2026-06-25
**关联轮次**: discussions/022 Issue 2（team↔team 委派串显根治）

## 背景

`DelegateDock`（ADR-031 ②）展示"在跑的委派 + 中继的子会话权限"。它订阅全局委派 SSE，原先**只按 workspace 过滤**。当同一个 workspace 里有多个 Team 协作会话时：

- 已完成的 Team 会话仍显示**别的 Team 在跑**的委派（用户真机报告）；
- 两个 Team 同时活跃时互相串显对方的委派。

根因：`DelegateRecord` 没有"发起(leader)会话 id"字段，而全局委派 MCP 在协议层看不到调用方会话 → 无法按发起会话过滤。`orchestrator/delegate.ts` 里的 `parentSessionId` 只是隐藏的 `[delegates]` 父会话（让子会话不进侧栏），**不是** leader。

## 决策

给委派记录加 **`ownerSessionId`**（发起委派的 leader 会话），`DelegateDock` 按 `d.ownerSessionId === 当前会话` 精确过滤。两条后端用不同通道把 leader 会话 id 透传到委派请求：

| 后端 | 通道 | 说明 |
|------|------|------|
| **ACP leader** | per-session MCP **env** | orchestrate MCP 是 per-session 注入（`acp-connection.ts hostMcpServers`），spawn delegate-mcp 时塞 `ULTRAWORK_DELEGATE_SESSION = emitSessionId`（leader 会话）；shim 读 env。**无需 vendor patch。** |
| **opencode leader** | per-call MCP **`_meta`** | MCP 工具 execute 不传会话、orchestrate MCP 又是全局单进程 → **vendor patch**：`session/llm.ts` 把 `experimental_context:{sessionID}` 传给 streamText；`mcp/index.ts` execute 读 `options.experimental_context.sessionID` 注入 `client.callTool` 的 `_meta.ultrawork_session`；shim 读 `extra._meta`。 |

数据链：shim → `POST /orchestration/delegate` body `ownerSessionId` → `DelegateRequest.ownerSessionId` → `DelegateManager.delegate()` 拷进 `DelegateRecord.ownerSessionId` → SSE → `DelegateDock` 过滤。无 `ownerSessionId` 的记录退化为原 workspace 过滤。

**分层防御**：① `canShowDelegates` 门控（非委派会话不渲染 dock）；② `isAgentActive` 门控（idle/已完成会话隐藏 dock——委派调用阻塞 leader 回合，故有在跑委派的会话必忙）独立修好"完成态串显"、与 ownerSessionId 无关；③ `ownerSessionId` 行级过滤修"同时活跃串显"。

## 替代方案

- **仅 `isAgentActive` 门控**（中间案）：能修"完成态串显"，但两个 Team 同时活跃仍互串。不够。
- **opencode 也走 env**：opencode orchestrate MCP 是全局单进程、env 进程静态，多会话共享 → 误归属。必须 per-call `_meta`。
- **子会话 parentID 关联 leader**：orchestrator 不知 leader 会话，无从设置。

## 后果

- opencode leader 多 Team 同时跑：**完全不串**（per-call `_meta`，stub MCP 运行时实测 `extra._meta.ultrawork_session === sessionId`）。
- ACP（claude）leader 多 Team 同时跑：**完全不串**——读 `@agentclientprotocol/claude-agent-acp@0.51.0` 源码确证 `computeSessionFingerprint({cwd, mcpServers})` 含 env、`this.sessions` 按 sessionId 分键、每会话各自 spawn MCP → 不同 `ULTRAWORK_DELEGATE_SESSION` env → 独立进程独立 env（审查 M1 消解）。
- **残留（理论）**：某个不遵守 ACP per-session mcpServers 语义、跨会话复用同名 MCP 进程的第三方 adapter 才可能误归属（属 adapter bug，不可控）；`isAgentActive` 门控仍兜住其"完成态串显"。
- vendor patch 新增项：`mcp/index.ts`（_meta 注入）+ `session/llm.ts`（experimental_context），见 CLAUDE.md vendor patch 表。新增 e2e 守卫 `e2e/meta-passthrough.e2e.ts`（opencode bump 后能立刻发现 patch 失效）。

## 验证

- 全链逐环：opencode `_meta`（运行时 stub MCP）+ shim（callDelegate 单测 env/opts/absent ×3）+ orchestrator（delegate ownerSessionId 拷贝单测）+ dock（DelegateDock owner 过滤 / workspace 兜底 ×2）。
- typecheck 8/8 · acp-client 112 · orchestrator 68 · desktop 243 · 真机三场景（完成态不串 / 同时活跃不串 / 并行派发未回归）。
