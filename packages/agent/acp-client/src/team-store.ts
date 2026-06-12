// Team-session registry (017 Team 页): which sessions are Leader sessions,
// who leads, who the members are. One JSON file — server-side so the history
// list survives a cleared WebView localStorage (the batch-2 binding lesson).
// The conversations themselves live in their native stores (opencode session /
// ACP session-store); this registry only carries Team metadata.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export interface TeamSessionEntry {
  /** The Leader's opencode session id (opencode leader) or its twin (ACP leader) — the desktop chat key. */
  id: string
  workspace: string
  /** Delegate-namespace agent id: "opencode:default" | "acp:claude" | ... */
  leaderAgentId: string
  /** Member agent ids offered in the Leader's system prompt (prompt-level constraint, 017 拍板 #3). */
  members: string[]
  title?: string
  createdAt: number
}

interface TeamSessionsFile {
  version: 1
  sessions: TeamSessionEntry[]
}

// Read lazily so tests can point at a tmp file after module load.
function storePath(): string {
  if (process.env.TEAM_SESSIONS_FILE) return process.env.TEAM_SESSIONS_FILE
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdgData, "ultrawork", "team-sessions.json")
}

export function loadTeamSessions(): TeamSessionEntry[] {
  const path = storePath()
  if (!existsSync(path)) return []
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as TeamSessionsFile
    if (parsed.version === 1 && Array.isArray(parsed.sessions)) return parsed.sessions
  } catch (err) {
    console.error(`[acp] skipping unreadable team-sessions file:`, err)
  }
  return []
}

export function saveTeamSessions(sessions: TeamSessionEntry[]): void {
  const path = storePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, sessions } satisfies TeamSessionsFile, null, 2) + "\n")
}
