// Leader system prompt content contract (017 §2.4). Other code (and the
// model) depend on the prompt naming the exact tool keys and the cwd — lock
// those in.

import { describe, it, expect } from "vitest"
import { buildLeaderSystemPrompt } from "@/lib/team-leader-prompt"

const MEMBERS = [
  { id: "opencode:default", name: "OpenCode" },
  { id: "acp:claude", name: "Claude", description: "Anthropic Claude Code" },
]

describe("buildLeaderSystemPrompt", () => {
  const prompt = buildLeaderSystemPrompt({ workspace: "/ws/project", members: MEMBERS })

  it("names the delegate tool exactly, in both namings", () => {
    expect(prompt).toContain("orchestrator_delegate")
    expect(prompt).toContain("mcp__orchestrator__delegate")
  })

  it("injects the workspace as the delegate cwd", () => {
    expect(prompt).toContain("cwd 一律用 /ws/project")
  })

  it("lists every member with id and description", () => {
    expect(prompt).toContain("- opencode:default（OpenCode）")
    expect(prompt).toContain("- acp:claude（Claude：Anthropic Claude Code）")
  })

  it("forbids the built-in task/subagent tools for cross-member delegation", () => {
    expect(prompt).toContain("task / subagent")
    expect(prompt).toContain("不要使用内置的")
  })

  it("keeps the self-contained subtask + parallel-delegation instructions", () => {
    expect(prompt).toContain("自包含")
    expect(prompt).toContain("并行")
  })

  it("makes delegation the default and forbids the Leader from executing tasks itself", () => {
    // 018 走查回归：Leader 曾自己 webfetch/search 干活而不委派
    expect(prompt).toContain("默认走委派")
    expect(prompt).toContain("webfetch")
    expect(prompt).toMatch(/不要.*代替成员|不要替成员执行/)
  })
})
