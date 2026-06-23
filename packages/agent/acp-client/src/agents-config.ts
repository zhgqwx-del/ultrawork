// Agent registry persistence: ~/.config/ultrawork/agents.json
// Schema carried over from feat/acp-support (ADR-027): agent name → command.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ACPAgentConfig, AgentsFile } from "./types.js"
import { configFile, resolveConfigDir } from "./config-paths.js"

const CONFIG_DIR = resolveConfigDir()
const CONFIG_PATH = configFile("agents.json")

// First-batch default (target architecture §0 B1): claude via the official
// adapter, reusing the local Claude Code login. bunx --bun, never npx —
// npx spawns extra layers that break the stdio pipe (gotchas §3).
//
// The adapter moved from @zed-industries/claude-code-acp (frozen at 0.16.2,
// no usage reporting) to @agentclientprotocol/claude-agent-acp; configs
// written with the old name are migrated on load (see
// migrateLegacyClaudeAdapter).
const LEGACY_CLAUDE_ADAPTER = "@zed-industries/claude-code-acp"
const CLAUDE_ADAPTER = "@agentclientprotocol/claude-agent-acp"
const LEGACY_CLAUDE_DESCRIPTION = `Claude Code via ${LEGACY_CLAUDE_ADAPTER}`

const DEFAULT_AGENTS: AgentsFile = {
  agents: {
    claude: {
      label: "Claude Code",
      description: `Claude Code via ${CLAUDE_ADAPTER}`,
      command: "bunx",
      args: ["--bun", CLAUDE_ADAPTER],
      // Thinking on by default so the execution flow shows reasoning steps
      // (the adapter only emits thought chunks when this is set). Remove
      // or tune the env in Settings to trade depth for speed/tokens.
      env: { MAX_THINKING_TOKENS: "8192" },
    },
  },
  default: "claude",
}

/**
 * Rewrite args still pointing at the renamed claude adapter package. Exact
 * token match only: an explicit version pin (`…@0.16.2`) is a deliberate
 * choice and is left alone. Returns whether anything changed so the caller
 * knows to persist.
 */
export function migrateLegacyClaudeAdapter(file: AgentsFile): boolean {
  let changed = false
  for (const cfg of Object.values(file.agents ?? {})) {
    if (!cfg.args) continue
    let agentChanged = false
    for (let i = 0; i < cfg.args.length; i++) {
      if (cfg.args[i] === LEGACY_CLAUDE_ADAPTER) {
        cfg.args[i] = CLAUDE_ADAPTER
        agentChanged = true
      }
    }
    if (agentChanged && cfg.description === LEGACY_CLAUDE_DESCRIPTION) {
      cfg.description = `Claude Code via ${CLAUDE_ADAPTER}`
    }
    changed ||= agentChanged
  }
  return changed
}

export function loadAgentConfigs(): ACPAgentConfig[] {
  let file: AgentsFile
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AgentsFile
      if (migrateLegacyClaudeAdapter(file)) {
        console.error(`[acp] Migrated ${CONFIG_PATH}: ${LEGACY_CLAUDE_ADAPTER} → ${CLAUDE_ADAPTER}`)
        try {
          writeFile(file)
        } catch (err) {
          console.error(`[acp] Failed to persist migrated ${CONFIG_PATH}:`, err)
        }
      }
    } catch (err) {
      console.error(`[acp] Failed to parse ${CONFIG_PATH}, using defaults:`, err)
      file = DEFAULT_AGENTS
    }
  } else {
    file = DEFAULT_AGENTS
    try {
      mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_AGENTS, null, 2) + "\n")
    } catch (err) {
      console.error(`[acp] Failed to write default ${CONFIG_PATH}:`, err)
    }
  }
  return Object.entries(file.agents ?? {}).map(([id, cfg]) => ({
    id,
    label: cfg.label ?? id,
    description: cfg.description,
    command: cfg.command,
    args: cfg.args ?? [],
    env: cfg.env,
    knowledgeMcp: cfg.knowledgeMcp ?? false,
    orchestratorMcp: cfg.orchestratorMcp ?? false,
    thoughtLevel: cfg.thoughtLevel,
  }))
}

export function agentsConfigPath(): string {
  return CONFIG_PATH
}

function readFile(): AgentsFile {
  if (!existsSync(CONFIG_PATH)) return { agents: {} }
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AgentsFile
  } catch {
    return { agents: {} }
  }
}

function writeFile(file: AgentsFile): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + "\n")
}

export function saveAgentConfig(config: ACPAgentConfig): void {
  const file = readFile()
  file.agents = file.agents ?? {}
  file.agents[config.id] = {
    label: config.label,
    description: config.description,
    command: config.command,
    args: config.args,
    env: config.env,
    knowledgeMcp: config.knowledgeMcp || undefined,
    orchestratorMcp: config.orchestratorMcp || undefined,
    thoughtLevel: config.thoughtLevel || undefined,
  }
  writeFile(file)
}

export function deleteAgentConfig(id: string): void {
  const file = readFile()
  if (file.agents) delete file.agents[id]
  if (file.default === id) delete file.default
  writeFile(file)
}
