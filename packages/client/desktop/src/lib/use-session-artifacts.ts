import { useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import {
  classifyArtifacts,
  extractArtifacts,
  filterScanByWindows,
  mergeScannedPaths,
  sessionTurnWindows,
  type ScanHit,
} from "@/components/session/artifacts-panel"
import { attributeArtifactsToTurns } from "@/lib/turn-artifacts"

export interface SessionArtifacts {
  /** Everything, deliverables first — the order the sidebar renders, and the
   *  order the preview's prev/next navigation walks. */
  ordered: Artifact[]
  deliverables: Artifact[]
  working: Artifact[]
  /**
   * The workspace scan for this session has run to completion (or provably has
   * nothing to run). Until then `ordered` is only the tool-derived half and more
   * artifacts may still land.
   *
   * The unread badge needs this: it seeds "already seen" from the artifacts that
   * existed when you opened the session, and seeding off a half-built list would
   * mark the scan's late arrivals as new — a badge for files that were sitting
   * there all along.
   */
  settled: boolean
  /**
   * Artifacts grouped by the turn that produced them, keyed by the turn's first
   * assistant message id (== `groupIntoTurns`' render key). Drives the artifact
   * cards under each answer in the transcript.
   *
   * Derived from `ordered`, never the other way round — see `lib/turn-artifacts.ts`
   * for why the SSOT's first-wins order must stay untouched.
   */
  byTurn: Map<string, Artifact[]>
}

/**
 * Session-level artifact truth (ADR-048 D5).
 *
 * This derivation used to live inside ArtifactsPanel, which meant it only ran
 * while the right sidebar was open AND its section was expanded — so nothing
 * outside the panel could know an artifact existed. The unread badge and the
 * preview's prev/next navigation both need that knowledge regardless of sidebar
 * state, so it moved up here and the panel became a pure renderer.
 *
 * ⚠️ Cost of the move: the workspace scan below now runs on every completed turn
 * of every open session, not just when the sidebar happens to be open. It stays
 * off the hot path (idle-only, and the Rust side caps depth/entries), but it is
 * a real new steady-state cost — see ADR-048 §后果.
 */
export function useSessionArtifacts(
  messages: SendMessageResponse[],
  directory?: string,
  active?: boolean,
): SessionArtifacts {
  const toolArtifacts = useMemo(() => extractArtifacts(messages, directory), [messages, directory])

  // Baseline = the session's earliest message time. Files modified at/after it
  // were produced during this session; scanning since 0 would surface every
  // pre-existing file, so we skip the scan when no baseline is known.
  const baseline = useMemo(() => {
    let min = Infinity
    for (const m of messages) {
      const created = m.info?.time?.created
      if (typeof created === "number" && created > 0 && created < min) min = created
    }
    return Number.isFinite(min) ? min : 0
  }, [messages])

  // Identity of the scan that is valid RIGHT NOW. `settled` is derived from it
  // during render rather than kept as its own state, and that is load-bearing: a
  // separate `settled` flag reset by an effect can be READ (by another hook's
  // effect, in the same commit) before the reset effect has run — the consumer sees
  // a stale `true` and acts on a scan that belongs to the previous session/baseline.
  // A derived value cannot be stale, because it is recomputed with the render.
  const scanKey = `${directory ?? ""}|${baseline}`
  const [scanned, setScanned] = useState<{ key: string; hits: ScanHit[] } | null>(null)
  const nothingToScan = !directory || !baseline
  const settled = nothingToScan || scanned?.key === scanKey

  useEffect(() => {
    // Only scan when the agent is idle (no churn mid-turn) and a baseline exists.
    if (active || nothingToScan) return
    let cancelled = false
    invoke<ScanHit[]>("scan_workspace_changes", { dir: directory, sinceMs: baseline })
      .then((hits) => {
        if (!cancelled) setScanned({ key: scanKey, hits })
      })
      .catch(() => {
        // Non-Tauri env (tests/web) or fs error — fall back to tool-derived only,
        // but still mark this scan as done: a session that can never scan must not
        // block the unread badge's seed forever.
        if (!cancelled) setScanned({ key: scanKey, hits: [] })
      })
    return () => {
      cancelled = true
    }
  }, [active, directory, baseline, scanKey, nothingToScan, messages.length])

  // Attribute scanned files to THIS session by its turn windows, so sessions
  // sharing a workspace don't show each other's outputs (mtime baseline alone
  // can't tell them apart).
  const windows = useMemo(() => sessionTurnWindows(messages, active), [messages, active])
  // Only hits from the scan that matches the CURRENT session identity count. A
  // stale result (previous session, same workspace) is ignored by construction
  // rather than by an effect racing to clear it.
  const scannedPaths = useMemo(
    () => filterScanByWindows(scanned?.key === scanKey ? scanned.hits : [], windows),
    [scanned, scanKey, windows],
  )
  const artifacts = useMemo(
    () => mergeScannedPaths(toolArtifacts, scannedPaths, directory),
    [toolArtifacts, scannedPaths, directory],
  )

  // The hits that belong to the CURRENT session identity — same guard as
  // `scannedPaths`, but per-turn attribution needs the mtimes, which
  // `filterScanByWindows` drops on its way out.
  const hits = useMemo(
    () => (scanned?.key === scanKey ? scanned.hits : []),
    [scanned, scanKey],
  )

  const split = useMemo(() => classifyArtifacts(artifacts), [artifacts])
  const ordered = useMemo(() => [...split.deliverables, ...split.working], [split])

  /**
   * Last computed attribution, so a streaming turn doesn't recompute it per token.
   *
   * `messages` gets a new array identity on every `message.part.delta`, so a plain
   * memo here would re-derive the whole table for every token — and the table is
   * roughly as expensive as the entire pre-existing artifact pipeline (measured:
   * +105% on the per-delta cost; at 120 turns that is ~14ms of synchronous work per
   * delta, a dropped frame). All of it wasted: the strip is hidden while a turn
   * streams (AssistantTurn gates on `!streaming`), and a settled turn's artifacts
   * cannot change while a later one is still running.
   *
   * Keyed by session, because "reuse the last map" must not survive a session switch
   * mid-stream — that would hang one session's cards under another's turns.
   */
  const cache = useRef<{ key: string; map: Map<string, Artifact[]> }>({ key: "", map: new Map() })
  const sessionKey = messages[0]?.info?.sessionID ?? ""

  const byTurn = useMemo(() => {
    if (active && cache.current.key === sessionKey) return cache.current.map
    const map = attributeArtifactsToTurns({ messages, ordered, scanHits: hits, directory, active })
    cache.current = { key: sessionKey, map }
    return map
  }, [active, sessionKey, messages, ordered, hits, directory])

  return useMemo(
    () => ({ ordered, deliverables: split.deliverables, working: split.working, settled, byTurn }),
    [ordered, split, settled, byTurn],
  )
}
