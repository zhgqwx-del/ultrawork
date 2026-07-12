import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { extractArtifacts, toRelative, TURN_GRACE_MS, type ScanHit } from "@/components/session/artifacts-panel"

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
  let open = false
  // An empty interval: nothing can fall inside it. A turn whose messages all lack a
  // usable timestamp keeps these, so it claims no scanned file — while still keeping
  // its anchor and messages, which is what tool-derived attribution runs on.
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  let anchorId: string | null = null
  let turnMessages: SendMessageResponse[] = []

  const stamp = (m: SendMessageResponse): number | undefined => {
    const c = m.info?.time?.created
    return typeof c === "number" && c > 0 ? c : undefined
  }
  const flush = (streaming: boolean) => {
    if (!open) return
    const windowEnd = streaming
      ? Number.POSITIVE_INFINITY
      : end === Number.NEGATIVE_INFINITY
        ? end
        : end + TURN_GRACE_MS
    windows.push({ start, end: windowEnd, anchorId, messages: turnMessages })
  }

  // Grouping is driven by ROLE alone, never by the timestamp — that is the whole
  // point. `groupIntoTurns` doesn't look at time, so if a message with a missing
  // `time.created` were skipped here, the grouping would silently diverge: the
  // anchor could end up being the turn's SECOND assistant message while the
  // transcript still keys the turn on its first, and the entire turn's cards would
  // vanish. Timestamps only ever widen a window; they never decide membership.
  for (const m of messages) {
    const created = stamp(m)
    if (m.info.role === "user") {
      flush(false)
      open = true
      start = created ?? Number.POSITIVE_INFINITY
      end = created ?? Number.NEGATIVE_INFINITY
      anchorId = null
      turnMessages = []
    } else {
      open = true
      // First assistant message after this user message == groupIntoTurns' turnKey.
      if (anchorId === null) anchorId = m.info.id
      turnMessages.push(m)
      if (created !== undefined) {
        if (created < start) start = created
        const done = m.info?.time?.completed ?? created
        if (done > end) end = done
      }
    }
  }
  flush(!!active)
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
  const inside = (w: TurnWindow) => mtimeMs >= w.start && mtimeMs <= w.end
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].anchorId !== null && inside(windows[i])) return i
  }
  // Nothing real contains it — but a GHOST window might, and the session-level
  // filter counts ghosts (it asks "any window?", and a ghost is a window). Dropping
  // it here would put the file in the sidebar and nowhere in the transcript: one
  // dataset, two views, silently disagreeing. Hand it to the most recent real turn
  // that had already started when the file appeared.
  if (!windows.some((w) => w.anchorId === null && inside(w))) return -1
  for (let i = windows.length - 1; i >= 0; i--) {
    if (windows[i].anchorId !== null && windows[i].start <= mtimeMs) return i
  }
  return -1
}

/**
 * Whether a raw path off a message part names the same file as an Artifact's
 * workspace-relative path.
 *
 * Exact, via the same `toRelative` the extractor used to produce `rel` in the first
 * place — NOT a suffix match. A suffix match looks right and quietly conflates two
 * different files: `/ws/proj/sub/report.md` ends with `/report.md`, so a FileBlock
 * for the one in `sub/` would suppress the card for the one at the workspace root.
 * The failure is invisible — a card that simply isn't there.
 */
export function samePath(raw: string, rel: string, directory?: string): boolean {
  return toRelative(raw, directory) === rel
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

  // Session order, which is already `[...deliverables, ...working]` — so sorting by
  // it puts deliverables first for free.
  //
  // Deliberately NOT `classifyArtifacts`: its "promote working files when there are
  // no deliverables" rule is a property of the SET, not of the file, so per turn the
  // same `gen.py` would read as a deliverable in the turn that only wrote scripts and
  // as a working file in the turn that also produced a PDF. Ordering says the same
  // thing without contradicting itself across turns.
  for (const list of byTurn.values()) {
    list.sort((a, b) => (rank.get(a.path) ?? 0) - (rank.get(b.path) ?? 0))
  }
  return byTurn
}
