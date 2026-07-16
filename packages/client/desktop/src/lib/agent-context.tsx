// Agent registry + per-session agent binding (ADR-027 档1: one session, one
// agent). The opencode default binding leaves the existing flow untouched.
//
// Bindings live in the Connector's BindingStore (ADR-030): localStorage is a
// warm cache, hydrated from the ACP sidecar's persisted sessions at launch so
// cleared WebView data / another device no longer orphans ACP sessions.

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  ACPBackend,
  ACP_BACKEND_KIND,
  OPENCODE_DEFAULT_AGENT_ID,
  makeAgentId,
  toBindingEntries,
  type ACPAgentInfo,
  type UnifiedAgent,
} from "@agent/connector"
import { useConnector, useSSEConnected } from "./sse-context"

const OPENCODE_AGENT: UnifiedAgent = {
  id: OPENCODE_DEFAULT_AGENT_ID,
  name: "OpenCode",
  source: "opencode",
  // Placeholder; the live status is derived from the global SSE heartbeat in
  // the provider (the opencode backend has no per-agent health endpoint).
  status: "disconnected",
}

// ── Self-healing ACP availability poll (discussions/042) ──────────────
//
// `acpAvailable` used to be set by a single mount-time probe. But the ACP
// sidecar (:4099) is spawned in a non-blocking background thread AFTER the
// renderer gate opens (opencode-gated, not acp-gated — src-tauri lib.rs), so at
// cold boot that one probe reliably loses the race to the sidecar's `listen()`,
// `acpAvailable` stays false, and nothing re-probes — Team mode is wrongly
// disabled until the user manually opens the agent dropdown. A single
// self-scheduling loop fixes both directions: it retries fast (geometric
// backoff from BOOT_RETRY_MS) while unreachable so a still-booting sidecar is
// picked up within a second or two, and it downgrades (debounced) if a
// once-healthy sidecar dies. Same shape as `nextChannelPollDelay`.

/** Steady cadence once ACP is reachable — refreshes per-agent status dots. */
const STEADY_MS = 4_000
/** First retry after a failure. The sidecar is spawned non-blocking after the
 *  renderer gate, so the first probe reliably beats it to `listen()`; retrying
 *  from 1s (not straight to STEADY_MS) means a still-booting sidecar is picked
 *  up within a second or two, so Team mode enables promptly. */
const BOOT_RETRY_MS = 1_000
/** Cap for the geometric backoff. Unlike the IM gateway (which most users never
 *  configure, hence a 5min cap), the ACP sidecar is spawned by `boot_sidecars`
 *  on every launch and is expected to be present — an unreachable one means it
 *  crashed / failed to spawn (rare). So the cap is a much tighter 30s: fast
 *  recovery, while still not hammering a genuinely-dead sidecar forever. */
const MAX_BACKOFF_MS = 30_000
/** Consecutive steady-state failures before flipping `acpAvailable` false. A
 *  single transient `listAgents()` blip must not flicker Team mode off; two in
 *  a row (~1-2s apart) is a real disconnect. The UP direction has no threshold
 *  — the first successful probe enables immediately (cold-boot fast path). */
const DOWN_THRESHOLD = 2

/** Next poll delay given the count of consecutive failures. No failures → steady
 *  {@link STEADY_MS}. Otherwise a geometric retry from {@link BOOT_RETRY_MS}
 *  (1s, 2s, 4s…) capped at {@link MAX_BACKOFF_MS}. Extracted (and exported) so the
 *  cadence can be locked deterministically without driving the async timer loop. */
export function nextAgentPollDelay(failures: number): number {
  if (failures <= 0) return STEADY_MS
  return Math.min(BOOT_RETRY_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
}

export interface AcpPollState {
  available: boolean
  failures: number
}

/** Pure transition for one background poll outcome (`ok` = the probe succeeded).
 *  A success connects immediately (no threshold — the cold-boot fast path); a
 *  failure bumps the streak and only downgrades an already-connected sidecar
 *  after {@link DOWN_THRESHOLD} consecutive failures, so a single transient blip
 *  never flickers Team mode off. Extracted so the state machine is locked by
 *  unit tests rather than the async timer loop. Manual `refreshAgents()` is
 *  intentionally NOT routed through this — an explicit user action reflects the
 *  health result immediately, undebounced. */
export function reduceAcpPoll(state: AcpPollState, ok: boolean): AcpPollState {
  if (ok) return { available: true, failures: 0 }
  const failures = state.failures + 1
  return { available: state.available && failures < DOWN_THRESHOLD, failures }
}

function toUnifiedAcpAgents(acpAgents: ACPAgentInfo[]): UnifiedAgent[] {
  return acpAgents.map(
    (a): UnifiedAgent => ({
      id: makeAgentId("acp", a.id),
      name: a.label,
      description: a.description,
      source: "acp",
      status: a.status,
      error: a.error,
    }),
  )
}

interface AgentContextValue {
  /** opencode default + ACP agents (when the sidecar is reachable). */
  agents: UnifiedAgent[]
  /** False when the ACP sidecar (:4099) is unreachable. */
  acpAvailable: boolean
  refreshAgents: () => Promise<void>
  /** Agent bound to a session (defaults to opencode). */
  getSessionAgentId: (sessionId: string | undefined) => string
  bindSessionAgent: (sessionId: string, agentId: string) => void
}

const AgentContext = createContext<AgentContextValue | null>(null)

export function AgentProvider({ children }: { children: ReactNode }) {
  const connector = useConnector()
  const sseConnected = useSSEConnected()
  const [agents, setAgents] = useState<UnifiedAgent[]>([OPENCODE_AGENT])
  const [acpAvailable, setAcpAvailable] = useState(false)
  const refreshing = useRef(false)
  // Shared truth for the poll loop and manual refreshAgents (discussions/042).
  const availableRef = useRef(false)
  const failuresRef = useRef(0)

  const setAvailable = useCallback((next: boolean) => {
    availableRef.current = next
    setAcpAvailable(next)
  }, [])

  // 019 D5b: the opencode default agent's health = the global SSE heartbeat
  // (useSSEConnected), not a hardcoded "available". ACP agents keep their own
  // status from listAgents(). The connection signal surfaces on the
  // AgentSelector trigger chip, replacing the footer WiFi banner.
  const liveAgents = useMemo<UnifiedAgent[]>(
    () =>
      agents.map((a) =>
        a.id === OPENCODE_DEFAULT_AGENT_ID
          ? { ...a, status: sseConnected ? "connected" : "disconnected" }
          : a,
      ),
    [agents, sseConnected],
  )

  const hydrateBindings = useCallback(
    async (acp: ACPBackend) => {
      // Hydrate session↔agent bindings from the sidecar's persisted sessions
      // (sidecar wins over the localStorage cache; best-effort).
      try {
        connector.bindings.hydrate(toBindingEntries(await acp.http.listSessions()))
      } catch (err) {
        console.debug("ACP binding hydration failed:", err)
      }
    },
    [connector],
  )

  // Manual probe — used by the agent dropdown / settings. It only ever UPGRADES
  // availability (connect on success); downgrades are left exclusively to the
  // debounced background loop, so a single transient health() blip during a
  // dropdown-open can never flicker Team mode off. On failure it just nudges the
  // loop to re-check soon (failures ≥ 1 → fast backoff).
  const refreshAgents = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const acp = connector.getBackend<ACPBackend>(ACP_BACKEND_KIND)
      const healthy = acp ? await acp.http.health() : false
      if (!healthy || !acp) {
        failuresRef.current = Math.max(failuresRef.current, 1)
        if (!availableRef.current) setAgents([OPENCODE_AGENT])
        return
      }
      // Populate the roster BEFORE claiming availability: if listAgents() throws
      // transiently we must not end up available===true with an empty roster (F1).
      const acpAgents = await acp.http.listAgents()
      setAgents([OPENCODE_AGENT, ...toUnifiedAcpAgents(acpAgents)])
      setAvailable(true)
      failuresRef.current = 0
      await hydrateBindings(acp)
    } catch {
      // Transient listAgents/hydrate failure. Never strip a roster we're still
      // connected to (F1); only clear when we were not connected to begin with.
      if (!availableRef.current) setAgents([OPENCODE_AGENT])
    } finally {
      refreshing.current = false
    }
  }, [connector, setAvailable, hydrateBindings])

  // discussions/042: a single self-scheduling loop replaces the old one-shot
  // mount probe + the `acpAvailable`-gated status poll. While unreachable it
  // (re)probes health with geometric backoff so a still-booting sidecar is
  // picked up automatically (no manual dropdown open needed); while reachable it
  // refreshes per-agent status dots via listAgents() — a success doubles as the
  // health signal — and downgrades after DOWN_THRESHOLD consecutive failures.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>

    const tick = async () => {
      try {
        const acp = connector.getBackend<ACPBackend>(ACP_BACKEND_KIND)
        const wasAvailable = availableRef.current

        // Probe: while connected, listAgents() success doubles as the liveness
        // signal; while disconnected, a cheap explicit health() gate first.
        let ok = false
        let fresh: ACPAgentInfo[] | null = null
        if (acp) {
          try {
            if (wasAvailable) {
              fresh = await acp.http.listAgents()
              ok = true
            } else if (await acp.http.health()) {
              fresh = await acp.http.listAgents()
              ok = true
            }
          } catch {
            ok = false
          }
        }
        if (cancelled) return

        const next = reduceAcpPoll({ available: wasAvailable, failures: failuresRef.current }, ok)
        failuresRef.current = next.failures
        if (next.available !== wasAvailable) setAvailable(next.available)

        if (ok && fresh) {
          if (wasAvailable) {
            // Steady: reconcile the WHOLE roster (adds / removes / status), not a
            // status-only merge — so a roster transiently stripped while available
            // (F1) or a server-side add/remove (F2) is reflected next tick instead
            // of sticking until a manual dropdown open. Returns prev unchanged when
            // nothing differs, so an idle sidecar triggers no re-render.
            const nextAcp = toUnifiedAcpAgents(fresh)
            setAgents((prev) => {
              const prevAcp = prev.filter((a) => a.source === "acp")
              const same =
                prevAcp.length === nextAcp.length &&
                prevAcp.every((a, i) => {
                  const n = nextAcp[i]
                  return (
                    a.id === n.id &&
                    a.name === n.name &&
                    a.description === n.description &&
                    a.status === n.status &&
                    a.error === n.error
                  )
                })
              return same ? prev : [OPENCODE_AGENT, ...nextAcp]
            })
          } else {
            // Just (re)connected: populate the full ACP roster + hydrate bindings.
            setAgents([OPENCODE_AGENT, ...toUnifiedAcpAgents(fresh)])
            await hydrateBindings(acp!)
          }
        } else if (wasAvailable && !next.available) {
          // Just downgraded past the debounce: drop the now-unreachable ACP agents.
          setAgents([OPENCODE_AGENT])
        }
      } finally {
        // Always reschedule (unless torn down) — this loop is the recovery
        // mechanism, so an unexpected throw must never silently stall it (F3).
        if (!cancelled) timer = setTimeout(tick, nextAgentPollDelay(failuresRef.current))
      }
    }

    void tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [connector, setAvailable, hydrateBindings])

  // Mirror binding changes into React (stable snapshot via version counter)
  const bindingsVersion = useSyncExternalStore(
    useCallback((cb) => connector.bindings.onChange(cb), [connector]),
    () => connector.bindings.version,
  )

  const getSessionAgentId = useCallback(
    (sessionId: string | undefined) => connector.bindings.get(sessionId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connector, bindingsVersion],
  )

  const bindSessionAgent = useCallback(
    (sessionId: string, agentId: string) => connector.bindings.bind(sessionId, agentId),
    [connector],
  )

  return (
    <AgentContext.Provider
      value={{ agents: liveAgents, acpAvailable, refreshAgents, getSessionAgentId, bindSessionAgent }}
    >
      {children}
    </AgentContext.Provider>
  )
}

export function useAgents(): AgentContextValue {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error("useAgents must be used within AgentProvider")
  return ctx
}
