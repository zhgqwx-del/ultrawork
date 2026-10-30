/** Local OpenAI-compatible fixture: drives the real OpenCode tool loop offline. */
import assert from "node:assert/strict"

/** Inspect the wire prompt, not a fixture's generated answer. */
export function assertModelBrandIdentity(messages: Array<{ role: string; content?: unknown }>, namespace: string): string {
  assert(namespace === "ultrawork" || namespace === "mywork", "Unknown offline model namespace")
  const name = namespace === "mywork" ? "MyWork" : "Ultrawork"
  const system = messages.filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n")
  const identities = [...system.matchAll(/<identity>([\s\S]*?)<\/identity>/g)]
  assert.equal(identities.length, 1, "The model must receive exactly one product identity block")
  assert(identities[0]![1]!.includes(JSON.stringify(name)), `The model received the wrong ${name} identity`)
  assert(!/UltraWork/.test(identities[0]![1]!), "The legacy hardcoded identity reached the model")
  const foreign = namespace === "mywork" ? "Ultrawork" : "MyWork"
  assert(!identities[0]![1]!.includes(foreign), "Another brand's identity reached the model")
  assert(!system.includes("You are powered by the model named "), "A model self-declaration conflicts with the host identity")
  assert(!/\bYou are [Oo]pen[Cc]ode[,.]/.test(system), "A stock upstream self-declaration conflicts with the host identity")
  return name
}

export function brandModelFixture(workspaceFor: (namespace: string) => string) {
  const requests: Array<{ namespace: string; productName: string; team: boolean; tools: string[]; toolResults: number; called?: string }> = []
  const failures: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "offline", object: "model" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("offline")
      try {
        const namespace = url.pathname.split("/")[1]
        const body = await request.json() as {
          messages?: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string; function: { name: string } }>; tool_call_id?: string }>
          tools?: Array<{ function: { name: string } }>
        }
        const productName = assertModelBrandIdentity(body.messages ?? [], namespace)
        const teamPrompt = body.messages?.some((message) => message.role === "user" && JSON.stringify(message.content).includes("probe:opencode-team")) ?? false
        const results = body.messages?.filter((message) => message.role === "tool") ?? []
        const tools = body.tools?.map((tool) => tool.function.name) ?? []
        // OpenCode also asks its small model for titles/summaries using the
        // transcript but without tools. Those requests are not the agent turn.
        const team = teamPrompt && tools.length > 0
        let call: { name: string; args: Record<string, unknown> } | undefined
        if (team && results.length < 2) {
          const suffix = results.length ? "_delegate" : "_list_agents"
          const name = tools.find((tool) => tool.endsWith(suffix))
          assert(name, `Real OpenCode did not expose the managed ${suffix} MCP tool`)
          call = { name, args: results.length
            ? { agentId: "acp:brand-member", task: "probe:member-answer", cwd: workspaceFor(namespace), timeoutMs: 15_000 }
            : { cwd: workspaceFor(namespace) } }
        }
        if (team && results.length >= 2) {
          const text = JSON.stringify(results.at(-1)?.content)
          assert(text.includes("completed") && text.includes(`brand_probe_${namespace}`), "OpenCode delegate result did not come from its brand's actual member")
          assert(!text.includes(`brand_probe_${namespace === "mywork" ? "ultrawork" : "mywork"}`), "OpenCode received the other brand's result")
        }
        requests.push({ namespace, productName, team, tools, toolResults: results.length, ...(call ? { called: call.name } : {}) })
        const frames = call ? [
          { choices: [{ index: 0, delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${results.length}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ] : [
          { choices: [{ index: 0, delta: { role: "assistant", content: teamPrompt && !tools.length ? "Offline title" : `${namespace}-opencode-${team ? "team" : "single"}-ok` }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
        ]
        return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        })
      } catch (error) {
        failures.push(String(error))
        console.error(`Offline model fixture rejected a request: ${String(error)}`)
        return Response.json({ error: { message: String(error) } }, { status: 400 })
      }
    },
  })
  return { server, requests, failures }
}
