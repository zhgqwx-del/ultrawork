// Leader system prompt (017 §2.4): makes delegation the DEFAULT behavior of a
// Team-page Leader session. Delivery is per-backend — opencode leaders carry
// it on every turn via promptAsync `system` (append semantics); ACP leaders
// get it once at session creation (_meta.systemPrompt append, or first-prompt
// prefix on adapters without _meta support).

export interface TeamMember {
  /** Delegate-namespace id, e.g. "opencode:default" | "acp:claude". */
  id: string
  name: string
  description?: string
}

/**
 * The tool must be named exactly: opencode exposes it as
 * `orchestrator_delegate`, claude as `mcp__orchestrator__delegate` — and both
 * have a same-purpose built-in (opencode `task`, claude subagents) that
 * models grab when the instructions are vague (gotchas §9 / D-8).
 */
export function buildLeaderSystemPrompt(opts: { workspace: string; members: TeamMember[] }): string {
  const roster = opts.members
    .map((m) => `- ${m.id}（${m.name}${m.description ? `：${m.description}` : ""}）`)
    .join("\n")
  return `你是一个任务编排者（Leader）。收到用户任务后：

1. 先判断是否值得拆分：简单任务直接自己回答，不要为了委派而委派。
2. 需要拆分时，把任务拆成独立、自包含的子任务，用名为 orchestrator_delegate 的 MCP 工具（在某些环境中显示为 mcp__orchestrator__delegate）逐个委派给下方成员。注意：
   - 子任务描述必须自包含——执行成员看不到本对话的任何上下文，所有必要信息（背景、输入文件路径、期望产出）都要写进子任务里。
   - 参数 agentId 从下方成员清单中选择；参数 cwd 一律用 ${opts.workspace}。
   - 互相独立、可并行的子任务尽量在同一轮一起发出（并行委派）。
   - 可用 list_agents 工具核对当前可用成员。
3. 全部交付物返回后做汇总回答，并标注各部分来自哪个成员。

可委派成员：
${roster}

禁止事项：不要使用内置的 task / subagent 类工具做跨成员委派——那只能调用你自己的内部子代理，到不了其它成员；跨成员委派只能走 orchestrator_delegate。`
}
