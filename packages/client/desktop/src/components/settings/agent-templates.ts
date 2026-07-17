// Preset templates for the "Add Agent" form: one-click fill of the verified
// command/args/env for first-batch ACP agents, replacing fully manual entry.
// UX-layer only — the sidecar's DEFAULT_AGENTS (agents-config.ts) stays
// claude-only; whether a binary exists varies per machine.

export interface AgentTemplate {
  key: "claude" | "gemini" | "qoder" | "hermes" | "codex"
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
  {
    key: "hermes",
    id: "hermes",
    label: "Hermes",
    description: "NousResearch Hermes Agent via hermes acp",
    // Python/uvx package (not a node binary): the `hermes` launcher lands on
    // PATH at ~/.local/bin (already in acp-connection's EXTRA_PATH_DIRS), and
    // `hermes acp` is the ACP-stdio entry. --accept-hooks auto-approves unseen
    // shell hooks without a TTY (the headless gate, like gemini's interactive
    // shell). Protocol v1, plain shape — verified branch A, no bespoke quirks.
    // Auth comes from ~/.hermes (custom endpoint / `hermes model` / `hermes acp
    // --setup`); no env needed by default.
    command: "hermes",
    args: ["acp", "--accept-hooks"],
  },
  {
    key: "codex",
    id: "codex",
    label: "Codex CLI",
    description: "OpenAI Codex via @agentclientprotocol/codex-acp",
    // Codex CLI speaks MCP, not ACP natively (openai/codex#9085) — the official
    // npm bridge wraps the codex runtime as an ACP-stdio agent. No --bun: the
    // bridge bundles @openai/codex (heavy runtime), same call as gemini.
    // Verified (ADR-060, 5 spike rounds): our 0.25 client negotiates protocol
    // v1 with the 1.x-SDK bridge; auth reuses the local ~/.codex login (ChatGPT
    // or API key) — no key needed here.
    command: "bunx",
    args: ["@agentclientprotocol/codex-acp"],
    // NO_BROWSER: never pop a browser login from the headless sidecar (auth
    // comes from ~/.codex; run `codex login` in a terminal first if unset).
    // INITIAL_AGENT_MODE=agent: workspace-write sandbox + on-request approval —
    // in-workspace edits auto-run, out-of-sandbox/network actions escalate to
    // Ultrawork's permission prompt (proven round-trip) or are sandbox-blocked.
    // Change INITIAL_AGENT_MODE to read-only in this field to gate every file
    // write behind an approval prompt (ADR-060 follow-up: a mode selector).
    env: { NO_BROWSER: "1", INITIAL_AGENT_MODE: "agent" },
  },
]
