import { useEffect, useRef } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useConfig } from "./config-context"
import { isAutoApiBaseUrl } from "./config"
import type { BackendLiveness } from "./use-backend-liveness"

/**
 * Recover from a stale cached sidecar password.
 *
 * The host generates a per-install password into `sidecar-auth.json` and the app
 * copies it into local config on first launch — after which it is never re-read
 * (`config-context.tsx`: "already has a password" short-circuits the fetch).
 * Delete `~/.config/ultrawork/` to "reset the app" and the two diverge: the host
 * hands the sidecars a fresh password while the app keeps offering the old one,
 * so every single request 401s, forever, with no way back short of clearing
 * localStorage by hand.
 *
 * That failure is worth catching precisely because of how it LOOKS: a permanent
 * "disconnected" banner with a retry that never works — indistinguishable, from
 * the outside, from the reconnect bug ADR-071 exists to fix.
 *
 * Deliberately narrow. Two guards, both load-bearing:
 *
 *  1. Only on a 401/403 that we actually observed. A dropped socket says nothing
 *     about credentials, and re-reading them on every disconnect would be noise.
 *  2. Only when the base URL is `auto` — i.e. the local sidecar, whose password
 *     the host owns. A user who pointed Settings at their own opencode owns
 *     those credentials, and silently replacing them with the local ones would
 *     destroy a deliberate configuration to fix a problem they do not have.
 */
export function useCredentialResync(liveness: BackendLiveness): void {
  const { config, updateConfig } = useConfig()
  // Passwords already re-read and found unhelpful. Without this, a genuinely
  // wrong password (user typo on a custom endpoint that later flips to auto)
  // would re-invoke the host on every probe tick.
  const triedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (liveness !== "unauthorized") return
    if (!isAutoApiBaseUrl(config.apiBaseUrl)) return
    if (triedRef.current.has(config.apiPassword)) return
    triedRef.current.add(config.apiPassword)

    let cancelled = false
    invoke<unknown>("get_sidecar_credentials")
      .then((resolved) => {
        if (cancelled) return
        const creds = resolved as { username?: unknown; password?: unknown } | null
        if (!creds || typeof creds.password !== "string" || !creds.password) return
        // Same password ⇒ the host agrees with us and 401 means something else.
        // Writing it back would only churn the connector for nothing.
        if (creds.password === config.apiPassword) return
        console.warn("[auth] sidecar password changed on disk; re-reading it")
        updateConfig({
          apiPassword: creds.password,
          apiUsername: typeof creds.username === "string" ? creds.username : "opencode",
        })
      })
      .catch((err) => {
        // Outside Tauri, or the host refused. Nothing to recover with.
        console.error("[auth] failed to re-read sidecar credentials:", err)
      })
    return () => {
      cancelled = true
    }
  }, [liveness, config.apiBaseUrl, config.apiPassword, updateConfig])
}
