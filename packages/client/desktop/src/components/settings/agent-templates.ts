// Preset templates for the "Add Agent" form: one-click fill of the verified
// command/args/env for first-batch ACP agents, replacing fully manual entry.
// UX-layer only — the sidecar's DEFAULT_AGENTS (agents-config.ts) stays
// claude-only; whether a binary exists varies per machine.

export interface AgentTemplate {
  key: "claude" | "gemini" | "qoder"
  id: string
  label: string
  description: string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Placeholder hint for the env field (not pre-filled). */
  envHint?: string
}

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    key: "claude",
    id: "claude",
    label: "Claude Code",
    description: "Claude Code via @agentclientprotocol/claude-agent-acp",
    command: "bunx",
    args: ["--bun", "@agentclientprotocol/claude-agent-acp"],
    // Thinking on by default, mirroring the sidecar's DEFAULT_AGENTS.
    env: { MAX_THINKING_TOKENS: "8192" },
  },
  {
    key: "gemini",
    id: "gemini",
    label: "Gemini CLI",
    description: "Gemini CLI via --experimental-acp",
    // Verified without --bun: credentials come from ~/.gemini/ (Google login).
    command: "bunx",
    args: ["@google/gemini-cli", "--experimental-acp"],
  },
  {
    key: "qoder",
    id: "qoder",
    label: "Qoder CLI",
    description: "Qoder CLI via qodercli --acp",
    // The binary is qodercli (no `qoder` alias); ACP entry is the --acp flag.
    command: "qodercli",
    args: ["--acp"],
    envHint: "QODER_PERSONAL_ACCESS_TOKEN=...",
  },
]
