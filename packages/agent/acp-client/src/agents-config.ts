// Agent registry persistence: ~/.config/ultrawork/agents.json
// Schema carried over from feat/acp-support (ADR-027): agent name → command.

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ACPAgentConfig, AgentsFile } from "./types.js"

const CONFIG_DIR = join(homedir(), ".config", "ultrawork")
const CONFIG_PATH = join(CONFIG_DIR, "agents.json")

// First-batch default (target architecture §0 B1): claude via the official
// Zed adapter, reusing the local Claude Code login. bunx --bun, never npx —
// npx spawns extra layers that break the stdio pipe (gotchas §3).
const DEFAULT_AGENTS: AgentsFile = {
  agents: {
    claude: {
      label: "Claude Code",
      description: "Claude Code via @zed-industries/claude-code-acp",
      command: "bunx",
      args: ["--bun", "@zed-industries/claude-code-acp"],
    },
  },
  default: "claude",
}

export function loadAgentConfigs(): ACPAgentConfig[] {
  let file: AgentsFile
  if (existsSync(CONFIG_PATH)) {
    try {
      file = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as AgentsFile
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
  }
  writeFile(file)
}

export function deleteAgentConfig(id: string): void {
  const file = readFile()
  if (file.agents) delete file.agents[id]
  if (file.default === id) delete file.default
  writeFile(file)
}
