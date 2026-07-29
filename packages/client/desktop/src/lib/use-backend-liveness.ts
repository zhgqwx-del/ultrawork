import { useEffect, useRef, useState } from "react"
import { opencodeBaseUrl } from "./sidecar-ports"
import { sidecarAuthHeaders } from "./sidecar-auth"

/**
 * Is the opencode process still there, given that its event stream is down?
 *
 * - `listening` — something answered on the port, so the process is alive and the
 *   stream is what broke. Retrying is genuine advice.
 * - `absent`    — nothing is listening. Nothing restarts a sidecar after boot
 *   (ADR-071), so retrying is a lie and relaunching is the only fix.
 * - `unknown`   — not probed yet, or the answer was ambiguous.
 *
 * The judgement is deliberately narrow: ONLY an outright connection failure is
 * read as `absent`. Any HTTP response at all — including 401 or 500 — proves a
 * process is there, and a timeout proves nothing, so both stay `listening` /
 * `unknown` rather than accusing a live backend of having died.
 *
 * Known limit: in `vite dev` the request goes through the dev-server proxy, which
 * answers 500 when the target refuses. That reads as `listening`, so the
 * distinction is production-only. Dev still gets the generic banner, which is
 * what it got before — no regression, just no upgrade.
 */
export type BackendLiveness = "unknown" | "listening" | "absent"

/** Re-probe while the stream stays down; a dead sidecar can't come back, but a
 *  blocked network can, and the banner should follow. */
const PROBE_INTERVAL_MS = 10_000
/** A hung backend must not hold the probe open until the next interval. */
const PROBE_TIMEOUT_MS = 3_000

/** Exported for tests: one probe, mapped to a verdict. Never throws. */
export async function probeBackend(
  fetchImpl: typeof fetch = fetch,
): Promise<BackendLiveness> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    await fetchImpl(`${opencodeBaseUrl()}/global/health`, {
      headers: sidecarAuthHeaders(),
      signal: controller.signal,
    })
    // Reached here = an HTTP response came back. Status is irrelevant: 401 and
    // 500 both prove something is listening, which is the whole question.
    return "listening"
  } catch (err) {
    // Our own timeout aborted it: the port may well be open with a wedged
    // server, so this is NOT evidence of absence.
    if (controller.signal.aborted) return "unknown"
    return "absent"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe while `enabled`; report `unknown` when not. Enable this only once the
 * stream has actually been down for a while — probing a healthy app would be
 * pure noise.
 */
export function useBackendLiveness(enabled: boolean): BackendLiveness {
  const [liveness, setLiveness] = useState<BackendLiveness>("unknown")
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setLiveness("unknown")
      return
    }
    cancelledRef.current = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = async () => {
      const verdict = await probeBackend()
      if (cancelledRef.current) return
      setLiveness(verdict)
      timer = setTimeout(run, PROBE_INTERVAL_MS)
    }
    void run()

    return () => {
      cancelledRef.current = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled])

  return liveness
}
