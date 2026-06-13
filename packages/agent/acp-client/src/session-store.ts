// Session persistence (W4b): clientSessionId↔acpSessionId mapping + shaped
// message history, one JSON file per session. History is stored already
// shaped (the exact {info, parts} the desktop renders) so reopening a session
// never depends on the agent being alive or supporting session/load — load
// only restores the agent's own context lazily at the next prompt.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { PersistedACPSession, UwSSEEvent, UwStoredMessage } from "./types.js"

// Session history is data, not config: it lives next to opencode's brand-
// isolated storage (~/.local/share/ultrawork, ADR-020), mirroring the vendor's
// xdgData derivation. Read lazily so tests can point at a tmp dir after
// module load.
function dataDir(): string {
  if (process.env.ACP_DATA_DIR) return process.env.ACP_DATA_DIR
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdgData, "ultrawork", "acp-sessions")
}

function sessionPath(sessionId: string): string {
  return join(dataDir(), `${encodeURIComponent(sessionId)}.json`)
}

export function loadAllSessions(): PersistedACPSession[] {
  const dir = dataDir()
  if (!existsSync(dir)) return []
  const sessions: PersistedACPSession[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as PersistedACPSession
      if (parsed.version === 1 && parsed.sessionId && parsed.acpSessionId && parsed.agentId) {
        sessions.push(parsed)
      }
    } catch (err) {
      console.error(`[acp] skipping unreadable session file ${name}:`, err)
    }
  }
  return sessions
}

export function saveSession(entry: PersistedACPSession): void {
  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(sessionPath(entry.sessionId), JSON.stringify(entry) + "\n")
}

export function deleteSessionFile(sessionId: string): void {
  rmSync(sessionPath(sessionId), { force: true })
}

/**
 * Fold one shaped SSE event into the stored message list. Mirrors the desktop
 * reducer (use-session-messages.ts): part.updated upserts by id (creating the
 * message if absent — role is corrected by the later message.updated), delta
 * appends to existing parts only, message.updated merges info.
 *
 * Mutates and returns `messages` (per-session lists are owned by the manager).
 */
export function applyEvent(messages: UwStoredMessage[], event: UwSSEEvent): UwStoredMessage[] {
  switch (event.type) {
    case "message.part.updated": {
      const part = event.properties.part
      let msg = messages.find((m) => m.info.id === part.messageID)
      if (!msg) {
        msg = {
          info: {
            id: part.messageID,
            sessionID: part.sessionID,
            role: "assistant",
            time: { created: Date.now() },
          },
          parts: [],
        }
        messages.push(msg)
      }
      const idx = msg.parts.findIndex((p) => p.id === part.id)
      if (idx >= 0) msg.parts[idx] = part
      else msg.parts.push(part)
      break
    }
    case "message.part.delta": {
      const { messageID, partID, field, delta } = event.properties
      const msg = messages.find((m) => m.info.id === messageID)
      const part = msg?.parts.find((p) => p.id === partID) as Record<string, unknown> | undefined
      if (part) part[field] = ((part[field] as string) || "") + delta
      break
    }
    case "message.updated": {
      const info = event.properties.info
      const msg = messages.find((m) => m.info.id === info.id)
      if (msg) msg.info = { ...msg.info, ...info }
      else messages.push({ info, parts: [] })
      break
    }
    default:
      break
  }
  return messages
}

/**
 * True when this event settles a message on disk: the user echo completing,
 * or an assistant message reaching a terminal finish (anything but the
 * intermediate "tool-calls" seal — "stop"/"error"/"length"/"abort").
 */
export function isPersistencePoint(event: UwSSEEvent): boolean {
  if (event.type !== "message.updated") return false
  const info = event.properties.info
  if (info.role === "user") return info.time.completed !== undefined
  return Boolean(info.finish && info.finish !== "tool-calls")
}
