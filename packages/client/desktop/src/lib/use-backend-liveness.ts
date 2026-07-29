import { useEffect, useState } from "react"
import { useConfig } from "./config-context"
import { resolveApiBaseUrl } from "./config"

/**
 * Is the opencode process still there, given that its event stream is down?
 *
 * - `listening` — something answered on the port, so the process is alive and the
 *   stream is what broke. Retrying is genuine advice.
 * - `unauthorized` — it answered 401/403: alive, but rejecting OUR credentials.
 *   A distinct verdict because it has a distinct cure (re-read them from the
 *   host) and because calling it "listening" would hide a recoverable fault.
 * - `absent`    — nothing is listening. Nothing restarts a sidecar after boot
 *   (ADR-071), so retrying is a lie and relaunching is the only fix.
 * - `unknown`   — not probed yet, or the answer was ambiguous.
 *
 * The judgement is deliberately narrow: a live backend must never be accused of
 * having died. A timeout proves nothing (the port may be open with a wedged
 * server), so it stays `unknown`.
 *
 * Two requests, because one cannot answer both halves. opencode runs its
 * basic-auth middleware BEFORE its CORS middleware, so a 401 goes out with no
 * `Access-Control-Allow-Origin` and the browser refuses to hand it to us — a
 * rejected password is indistinguishable, from `fetch`, from a dead port
 * (verified against the real sidecar; gotchas §20⑭). Judging on the GET alone
 * therefore reported "the service exited, restart the app" to someone whose
 * only problem was a stale password — advice that cannot possibly help, since
 * the bad credential is in localStorage and survives the restart.
 *
 * OPTIONS settles it: the server explicitly lets preflight through unauthenticated
 * (`if (c.req.method === "OPTIONS") return next()`), so it reaches the CORS
 * middleware and comes back readable. If OPTIONS answers while the GET did not,
 * something is listening and refusing us — which is exactly `unauthorized`.
 *
 * Known limit: in `vite dev` the request goes through the dev-server proxy, which
 * answers 500 when the target refuses. That reads as `listening`, so the
 * distinction is production-only. Dev still gets the generic banner, which is
 * what it got before — no regression, just no upgrade.
 */
export type BackendLiveness = "unknown" | "listening" | "unauthorized" | "absent"

/** Re-probe while the stream stays down; a dead sidecar can't come back, but a
 *  blocked network can, and the banner should follow. */
const PROBE_INTERVAL_MS = 10_000
/** A hung backend must not hold the probe open until the next interval. */
const PROBE_TIMEOUT_MS = 3_000

/**
 * One probe, mapped to a verdict. Never throws.
 *
 * URL and headers are passed in rather than read from `sidecar-auth`: the point
 * is to reproduce what the OPENCODE CLIENT experiences, and that client
 * authenticates with the credentials in app config, which can drift from the
 * host's file (see useCredentialResync). Probing with a different credential
 * than the app uses would answer a question nobody asked.
 */
export async function probeBackend(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<BackendLiveness> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    try {
      const res = await fetchImpl(`${url}/global/health`, {
        headers,
        signal: controller.signal,
      })
      // A readable response of ANY status proves a process is listening. 401/403
      // is singled out only because it is separately fixable.
      return res.status === 401 || res.status === 403 ? "unauthorized" : "listening"
    } catch {
      if (controller.signal.aborted) return "unknown"
      // Either nothing is listening, or the answer was withheld by CORS. Only
      // OPTIONS can tell those apart.
    }

    await fetchImpl(`${url}/global/health`, {
      method: "OPTIONS",
      signal: controller.signal,
    })
    // Preflight got through but the GET did not: someone is home and turning us
    // away.
    return "unauthorized"
  } catch {
    if (controller.signal.aborted) return "unknown"
    return "absent"
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Basic-auth header, or none.
 *
 * `btoa` throws on anything outside Latin-1 and Settings lets the user type
 * whatever they like into username/password. Building the header outside the
 * probe's try/catch turned that into an unhandled rejection that killed the
 * polling loop for good — the banner would then never learn anything again.
 *
 * A credential that cannot even be encoded cannot authenticate either, so going
 * out bare is not a loss: the server answers 401 and `unauthorized` is truthful.
 */
function basicAuth(username: string, password: string): Record<string, string> {
  try {
    return { authorization: "Basic " + btoa(`${username}:${password}`) }
  } catch {
    return {}
  }
}

/**
 * Probe while `enabled`; report `unknown` when not. Enable this only once the
 * stream has actually been down for a while — probing a healthy app would be
 * pure noise.
 */
export function useBackendLiveness(enabled: boolean): BackendLiveness {
  const { config } = useConfig()
  const [liveness, setLiveness] = useState<BackendLiveness>("unknown")

  useEffect(() => {
    if (!enabled) {
      setLiveness("unknown")
      return
    }
    // Per-effect flag, NOT a ref: a ref is shared across effect runs, so the next
    // run resets it to false before the previous run's await resumes — the old
    // run then believes it is still current and schedules another tick, one the
    // finished cleanup can no longer clear. Every config change made mid-probe
    // leaked another polling loop.
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const run = async () => {
      const verdict = await probeBackend(
        resolveApiBaseUrl(config.apiBaseUrl),
        basicAuth(config.apiUsername || "opencode", config.apiPassword),
      )
      if (cancelled) return
      setLiveness(verdict)
      timer = setTimeout(run, PROBE_INTERVAL_MS)
    }
    void run()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [enabled, config.apiBaseUrl, config.apiUsername, config.apiPassword])

  return liveness
}
