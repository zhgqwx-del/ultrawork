import { isACPAgentId } from "@agent/connector"
import type { Command } from "@agent/api-client"

/**
 * Pure helpers shared by the `/` command menu (chat composer) and the skills
 * settings page. Kept free of React/Tauri imports on purpose: the composer
 * fetches its list lazily (first `/` keystroke) and must not be forced to pull
 * in `useSkills`, which fires three requests on mount and would put them back
 * on the startup path (ADR-055 took startup 4.23s → 2.22s).
 *
 * Discussion: docs/discussions/056.
 */

export type SkillSource = "command" | "mcp" | "skill"

/** Display order for source groups. */
export const GROUP_ORDER: SkillSource[] = ["command", "mcp", "skill"]

/**
 * Built-in OpenCode commands that are developer-oriented and not useful for end
 * users. Single source of truth — this used to be copied verbatim into
 * command-selector.tsx, which is exactly the kind of duplicate that drifts.
 */
export const HIDDEN_BUILTIN_COMMANDS = new Set(["init", "review"])

/** `source` is optional upstream; an absent one means a plain config command. */
export function isHiddenBuiltinCommand(name: string, source?: string): boolean {
  return HIDDEN_BUILTIN_COMMANDS.has(name) && (source === "command" || !source)
}

/**
 * Whether the `/` menu should be offered for the agent that will RECEIVE the
 * message. The list always comes from the OpenCode backend, so on an ACP-bound
 * session it would advertise commands that never reach the agent.
 *
 * Pass the *receiving* agent: for a Team session that is the leader
 * (`teamEntry.leaderAgentId`), not the session's binding — `bindLeaders` fills
 * the binding in only on registry load, so reading the binding alone falls back
 * to the opencode default for the first frames of an ACP-led team session.
 */
export function commandsAvailableFor(agentId: string | undefined): boolean {
  return !isACPAgentId(agentId)
}

export interface CommandMenuEntry {
  name: string
  description: string
  source: SkillSource
}

const KNOWN_SOURCES = new Set<string>(GROUP_ORDER)

/**
 * `source` is a plain string on the wire. An unrecognised one must not reach the
 * UI: the group label is looked up as `command.group.<source>`, so an unknown
 * value would render the raw i18n key to the user. Anything unexpected is
 * treated as a plain command, which is also what an absent source means.
 */
export function normalizeSource(source?: string): SkillSource {
  return source && KNOWN_SOURCES.has(source) ? (source as SkillSource) : "command"
}

export function toMenuEntries(commands: Command[]): CommandMenuEntry[] {
  const seen = new Set<string>()
  const entries: CommandMenuEntry[] = []
  for (const cmd of commands) {
    if (seen.has(cmd.name)) continue
    if (isHiddenBuiltinCommand(cmd.name, cmd.source)) continue
    seen.add(cmd.name)
    entries.push({
      name: cmd.name,
      description: cmd.description ?? "",
      source: normalizeSource(cmd.source),
    })
  }
  return entries
}

export interface SourceGroup {
  key: SkillSource
  items: CommandMenuEntry[]
}

/** Group by source in GROUP_ORDER, skipping empty groups. */
export function groupBySource(entries: CommandMenuEntry[]): SourceGroup[] {
  const map = new Map<SkillSource, CommandMenuEntry[]>()
  for (const entry of entries) {
    const list = map.get(entry.source) ?? []
    list.push(entry)
    map.set(entry.source, list)
  }
  return GROUP_ORDER.filter((key) => map.has(key)).map((key) => ({ key, items: map.get(key)! }))
}

/**
 * Description matching is deliberately gated on query length. Skill descriptions
 * are written for the model's routing decision, not for a list label — the nine
 * built-ins run 163–605 chars — so a one-letter substring match hits everything
 * (measured: `/d`, `/p`, `/s`, `/w`, `/m`, `/f` each matched 9 of 9) and the
 * filter stops narrowing anything at all.
 */
export const MIN_DESCRIPTION_QUERY_LENGTH = 2

/** Lower is better. 0/1 are name hits, 2 is a description-only hit. */
export const RANK_NAME_PREFIX = 0
export const RANK_NAME_SUBSTRING = 1
export const RANK_DESCRIPTION = 2

export interface RankedEntry extends CommandMenuEntry {
  rank: number
}

export interface RankedResult {
  entries: RankedEntry[]
  /**
   * Index of the first description-only hit, or -1. The renderer draws a
   * labelled divider there so a weak description match never looks like a name
   * match.
   */
  descriptionMatchStart: number
}

/**
 * Rank, don't filter-out: `/ppt` → deckcraft and `/md` → markdown-exporter are
 * description-only hits that users genuinely want, so they stay in the list —
 * just below every name hit, and behind a divider. Ordering is stable within a
 * rank, so the incoming order (GROUP_ORDER when the caller pre-sorted) is kept.
 *
 * The contract the send path depends on: `entries[0]` is always the best match,
 * so Enter can never pick a weak description hit over a perfect name prefix.
 */
export function rankEntries(entries: CommandMenuEntry[], rawQuery: string): RankedResult {
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return { entries: entries.map((e) => ({ ...e, rank: RANK_NAME_PREFIX })), descriptionMatchStart: -1 }
  }

  const ranked: RankedEntry[] = []
  for (const entry of entries) {
    const name = entry.name.toLowerCase()
    if (name.startsWith(query)) {
      ranked.push({ ...entry, rank: RANK_NAME_PREFIX })
    } else if (name.includes(query)) {
      ranked.push({ ...entry, rank: RANK_NAME_SUBSTRING })
    } else if (
      query.length >= MIN_DESCRIPTION_QUERY_LENGTH &&
      entry.description.toLowerCase().includes(query)
    ) {
      ranked.push({ ...entry, rank: RANK_DESCRIPTION })
    }
  }

  // Stable: Array.prototype.sort is spec-stable, so equal ranks keep input order.
  ranked.sort((a, b) => a.rank - b.rank)
  const descriptionMatchStart = ranked.findIndex((e) => e.rank === RANK_DESCRIPTION)
  return { entries: ranked, descriptionMatchStart }
}
