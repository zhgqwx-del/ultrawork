// migrateLegacyClaudeAdapter: configs written with the renamed claude adapter
// package are rewritten on load (exact token match; explicit pins respected).

import { describe, it, expect } from "bun:test"
import { migrateLegacyClaudeAdapter } from "../agents-config.js"
import type { AgentsFile } from "../types.js"

const LEGACY = "@zed-industries/claude-code-acp"
const CURRENT = "@agentclientprotocol/claude-agent-acp"

type AgentEntry = NonNullable<AgentsFile["agents"]>[string]

function legacyClaude(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    label: "Claude Code",
    description: `Claude Code via ${LEGACY}`,
    command: "bunx",
    args: ["--bun", LEGACY],
    env: { MAX_THINKING_TOKENS: "8192" },
    ...overrides,
  }
}

describe("migrateLegacyClaudeAdapter", () => {
  it("rewrites the bare legacy package name and the default description", () => {
    const file: AgentsFile = { agents: { claude: legacyClaude() }, default: "claude" }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.claude?.args).toEqual(["--bun", CURRENT])
    expect(file.agents?.claude?.description).toBe(`Claude Code via ${CURRENT}`)
  })

  it("leaves an explicit version pin alone", () => {
    const file: AgentsFile = {
      agents: { claude: legacyClaude({ args: ["--bun", `${LEGACY}@0.16.2`] }) },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(false)
    expect(file.agents?.claude?.args).toEqual(["--bun", `${LEGACY}@0.16.2`])
  })

  it("keeps a custom description even when args are migrated", () => {
    const file: AgentsFile = {
      agents: { claude: legacyClaude({ description: "my tuned claude" }) },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.claude?.args).toEqual(["--bun", CURRENT])
    expect(file.agents?.claude?.description).toBe("my tuned claude")
  })

  it("does not touch the legacy default description of an unmigrated agent", () => {
    const file: AgentsFile = {
      agents: {
        claude: legacyClaude(),
        other: legacyClaude({ args: ["some-other-agent"] }),
      },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(true)
    expect(file.agents?.other?.description).toBe(`Claude Code via ${LEGACY}`)
    expect(file.agents?.other?.args).toEqual(["some-other-agent"])
  })

  it("reports no change for current configs and unrelated agents", () => {
    const file: AgentsFile = {
      agents: {
        claude: legacyClaude({ args: ["--bun", CURRENT], description: `Claude Code via ${CURRENT}` }),
        gemini: { label: "Gemini", command: "gemini", args: ["acp"] },
      },
    }
    expect(migrateLegacyClaudeAdapter(file)).toBe(false)
  })

  it("tolerates empty/missing agents", () => {
    expect(migrateLegacyClaudeAdapter({ agents: {} })).toBe(false)
    expect(migrateLegacyClaudeAdapter({} as AgentsFile)).toBe(false)
  })
})
