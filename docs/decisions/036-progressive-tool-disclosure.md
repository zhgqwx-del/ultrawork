# ADR-036: 渐进式工具披露（Progressive Tool Disclosure）

**状态**: Accepted (✅ 已实现，单 agent + team 真机验收 + 全套件回归)
**日期**: 2026-06-26
**关联**: discussions/023（完整调研 + 设计 + 验证记录）· ADR-034（同为 `session/llm.ts` vendor patch 区）· ADR-030/031 + discussions/022（委派/delegate）

## 背景

每次 LLM 请求都要带上所有可用工具的 JSON schema。接入多个 MCP server 后，这部分线性膨胀：实测桌面 app 一句 `hi` 输入 **17.9k token**，其中工具 schema 占 ~73%（内置工具 49% + browser MCP 29 工具 24%）。这是业界公认的 "too many tools problem"，代价是三重的——**成本、首字节延迟、以及工具选择准确率**（Anthropic 自评 eval：开 Tool Search 后准确率 49%→74%，>30–50 工具后明显退化）。MCP 协议层不解决（全量列出、无 `tools/search`），必须由平台层实现。

对照组 JVS Copilot（同用 opencode）走 **代理模式**（3 个 `list/get_schema/run_mcp_tool` 泛型工具），虽收了 MCP 维度但牺牲原生 tool-call 准确率。

## 决策

实现「**搜索-提升为原生**」式渐进披露（架构 A，对齐 Claude Code harness / Anthropic Tool Search，**非** JVS 泛型代理）：

1. **接缝钩子**（最小 vendor patch）：opencode `session/prompt.ts` 每 step `resolveTools` 后 fire 新钩子 `experimental.chat.tools.transform`（`@opencode-ai/plugin` 加类型），把最终工具表 + `usedToolIds`（历史中被调用过的工具）交给插件改写。因 `resolveTools` 每 step 重跑 → 工具集可在回合内增长。
2. **披露引擎**（internal plugin `tool-disclosure.ts`）：
   - 折叠低频工具（所有 MCP + 情境内置 `skill/question/webfetch/…`），从 `tools` 数组删除；
   - 被折叠工具以 **name-only 名录**注入 system prompt（复用既有 `experimental.chat.system.transform`；AI SDK 数组无 name-only 态）；**静态名录**（恒列全部可披露工具，不随 fetch 收缩）以保 system 前缀缓存；
   - 注入单一 `tool_search` 工具（关键字 / `select:<name>`）；模型调用后，命中工具加入 per-session fetched 集，**下一步恢复真实原生 schema**（复用已 wire 好 execute 的 AITool，非泛型派发）。
3. **EAGER 硬约束**：编码核心（`read/write/edit/bash/grep/glob`）+ 委派工具（`task` + `orchestrator_*`）+ `todowrite`（opencode 规划工具）+ 合成工具永不折叠。委派工具折叠会破坏 delegation（oh-my-openagent #3592 实锤）。
4. **配置**：`experimental.tool_disclosure`（**默认 ON / opt-out**；`false` 关）+ `tool_disclosure_debug`；env `ULTRAWORK_TOOL_DISCLOSURE=0` 强制关、`=1` 强制开（A/B 逃生口）。
5. **健壮性**：per-session 状态经 `session.deleted` 事件 + TTL + LRU 清理；grace 窗口后降级未用工具，但**绝不降级被历史引用的工具**（否则悬空 tool-call → provider 报错）。

## 替代方案

- **B 通用代理（JVS / mcpproxy）**：`run_mcp_tool` 泛型派发。否决——掉准确率（与本能力主诉相悖）、每调用 2-3 跳。
- **等上游**：opencode 上游 #9461「Claude-style Tool Search」open 但维护者无承诺、零实现。否决——不阻塞在不确定时间表上；自建并保留向上游提窄钩子 PR 的可能。
- **外置 plugin**：把引擎挪出 vendor、做成 app 随包 config-loaded plugin，只留钩子在 patch。暂缓——首发保持 internal（已测、最简），作后续 patch 维护优化。

## 后果

- ✅ 一句 `hi` 输入 19k→~11.7k（todowrite eager 前 −38%，eager 后 −26%）；工具维度收掉，准确率受益。
- ✅ 折叠工具按需自动提升为原生、可发现可达；编码/委派核心零额外往返。
- ⚠️ **首次用某折叠工具多一次模型往返**（一个 step）；高频工具标 eager 规避。
- ⚠️ **Anthropic 系 provider**：其 tools 参数会进 prompt cache，动态改工具有 cache churn（openai-compatible/qwen 的 tools 不缓存、无此问题）。引擎照常工作，但 Claude 模型的最优路径是原生 `defer_loading`——列为已知边界，后续接入。
- ⚠️ 内置工具 id 集是 v1.3.13 实测硬编码（EAGER/COLLAPSE 两表），**vendor bump 后需复核**。
- 实现契约坑：hook 注入工具的 execute 必须返回 opencode 形状 `{output,title,metadata}`（processor 读 `value.output.output`），裸字符串会让多步 replay 报 schema 错（已固化 gotchas）。

验证：22+1 综合单测 + 3 生命周期 + 真模型 e2e（webfetch/todowrite/EAGER-only）+ 单 agent 1–8 + team 委派真机 + opencode 回归 100/0 + 3 门控单测。详见 discussions/023 §6。
