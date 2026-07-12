import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import {
  extractArtifacts,
  isWorkingFile,
  toRelative,
  TURN_GRACE_MS,
  type ScanHit,
} from "@/components/session/artifacts-panel"

/**
 * Per-turn artifact attribution (discussions/035).
 *
 * Deliberately a DERIVED table sitting on top of the session-level artifact SSOT
 * (`useSessionArtifacts`), not a change to that SSOT. `extractArtifacts` stays
 * first-wins and its output order stays exactly as it is today, because three
 * consumers depend on it — the sidebar's row order, the preview's prev/next
 * counter, and the deliverable/working split — and none of them wants last-wins.
 * Making `extractArtifacts` last-wins to serve the transcript would have silently
 * broken two of them: the retained entry's metadata flips to the LAST occurrence,
 * losing `mime` (a `file` part carries it, the `write` tool that later rewrites the
 * file does not) and flipping `patch` to `file` (which drops a diff-tagged
 * deliverable into the collapsed working-files group, i.e. it vanishes from the
 * list). Nothing in the suite catches either — verified by running all 479 tests
 * against a last-wins shim: all green.
 */

/** One turn's time window plus the identity the transcript renders it under. */
export interface TurnWindow {
  start: number
  end: number
  /**
   * The turn's FIRST assistant message id — byte-for-byte the `turnKey` that
   * `groupIntoTurns` uses as its render key, so the table keys and the rendered
   * turns line up by construction.
   *
   * `null` = a "ghost" window: a user message that produced no assistant message
   * (the user sent two messages in a row). `sessionTurnWindows` emits a window for
   * it, but `groupIntoTurns` emits no assistant turn — so the window count and the
   * turn count diverge and any index-based pairing is off by one from there on.
   * Ghost windows are dropped rather than numbered around.
   */
  anchorId: string | null
  /** The assistant messages of this turn (same grouping as `groupIntoTurns`). */
  messages: SendMessageResponse[]
}

/**
 * Turn windows carrying their anchor id and messages.
 *
 * Mirrors `sessionTurnWindows` (same boundaries, same grace) but keeps the two
 * things that function throws away and per-turn attribution cannot work without:
 * which turn a window belongs to, and that turn's messages.
 */
export function buildTurnWindows(messages: SendMessageResponse[], active?: boolean): TurnWindow[] {
  const windows: TurnWindow[] = []
  let start: number | null = null
  let end = 0
  let anchorId: string | null = null
  let turnMessages: SendMessageResponse[] = []

  const flush = (windowEnd: number) => {
    if (start === null) return
    windows.push({ start, end: windowEnd, anchorId, messages: turnMessages })
  }

  for (const m of messages) {
    const created = m.info?.time?.created
    if (typeof created !== "number" || created <= 0) continue
    if (m.info.role === "user") {
      flush(end + TURN_GRACE_MS)
      start = created
      end = created
      anchorId = null
      turnMessages = []
    } else {
      if (start === null) start = created
      // First assistant message after this user message == groupIntoTurns' turnKey.
      if (anchorId === null) anchorId = m.info.id
      turnMessages.push(m)
      const done = m.info?.time?.completed ?? created
      if (done > end) end = done
    }
  }
  flush(active ? Number.POSITIVE_INFINITY : end + TURN_GRACE_MS)
  return windows
}

/**
 * Which turn a scanned file belongs to, or -1.
 *
 * Windows OVERLAP, routinely — a turn's window ends at its last message's
 * `completed`, while the next window starts at the next user message's `created`,
 * and typing the next message while the answer is still streaming is normal use.
 * (The grace period is a rounding error next to that; measured overlaps run to
 * tens of seconds.) The session-level filter doesn't care because it only asks
 * "any window at all?" — per-turn attribution has to pick one, so it picks the
 * LAST match: the most recent turn that could have written the file.
 */
function turnIndexForMtime(windows: TurnWindow[], mtimeMs: number): number {
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i]
    if (w.anchorId !== null && mtimeMs >= w.start && mtimeMs <= w.end) return i
  }
  return -1
}

/** Whether a raw (possibly absolute) path names the same file as a workspace-relative one. */
export function samePath(raw: string, rel: string): boolean {
  return raw === rel || raw.endsWith("/" + rel) || raw.endsWith("\\" + rel)
}

/**
 * Map each turn (by its anchor message id) to the artifacts that turn produced.
 *
 * Last-wins: a file rewritten across several turns belongs to the LAST turn that
 * wrote it, so the card sits next to the answer whose content the preview will
 * actually show. Applied here, on the derived table — never to the SSOT.
 *
 * The Artifact objects handed back are the ones from `ordered`, so they keep the
 * richer first-wins metadata (`mime`, `patch` type) rather than whatever the last
 * write happened to carry.
 */
export function attributeArtifactsToTurns(opts: {
  messages: SendMessageResponse[]
  /** Session-level artifact list (first-wins, rich metadata). */
  ordered: Artifact[]
  scanHits: ScanHit[]
  directory?: string
  active?: boolean
}): Map<string, Artifact[]> {
  const { messages, ordered, scanHits, directory, active } = opts
  const windows = buildTurnWindows(messages, active)
  const byPath = new Map(ordered.map((a) => [a.path, a]))
  const rank = new Map(ordered.map((a, i) => [a.path, i]))

  /** path → index of the last turn that wrote it. */
  const owner = new Map<string, number>()
  const claim = (path: string, idx: number) => {
    const prev = owner.get(path)
    if (prev === undefined || idx > prev) owner.set(path, idx)
  }

  // Tool/part-derived: re-run the existing extractor per turn, so every regex,
  // temp-path rejection and relative-path rule is reused rather than reimplemented.
  windows.forEach((w, i) => {
    if (w.anchorId === null) return
    for (const a of extractArtifacts(w.messages, directory)) claim(a.path, i)
  })

  // Scan-derived: mtime is the ground truth of "who wrote this last", so it may
  // move a file to a later turn than the tool call that first created it (e.g. a
  // bash step rewrote it). It never moves one earlier — hence `claim`'s max.
  for (const hit of scanHits) {
    const idx = turnIndexForMtime(windows, hit.mtimeMs)
    if (idx < 0) continue
    claim(toRelative(hit.path, directory), idx)
  }

  const byTurn = new Map<string, Artifact[]>()
  for (const [path, idx] of owner) {
    const artifact = byPath.get(path)
    // Not in `ordered` => the session-level pipeline rejected it (temp path, out of
    // workspace, …). The transcript must not show what the sidebar refuses to.
    if (!artifact) continue
    const anchorId = windows[idx].anchorId
    if (!anchorId) continue
    const list = byTurn.get(anchorId)
    if (list) list.push(artifact)
    else byTurn.set(anchorId, [artifact])
  }

  // Deliverables first, then session order. NOT `classifyArtifacts` — its "promote
  // working files when there are no deliverables" rule is a property of the SET, not
  // of the file, so per turn the same `gen.py` would read as a deliverable in the
  // turn that only wrote scripts and as a working file in the turn that also
  // produced a PDF. Ordering conveys the same thing without the contradiction.
  for (const list of byTurn.values()) {
    list.sort((a, b) => {
      const w = Number(isWorkingFile(a)) - Number(isWorkingFile(b))
      return w !== 0 ? w : (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0)
    })
  }
  return byTurn
}
