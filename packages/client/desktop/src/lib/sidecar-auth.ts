// Runtime sidecar credentials (discussions/029 §9, ADR-028).
//
// The gateway, knowledge and ACP sidecars require Basic auth on every route. The
// credential is the same per-install random password opencode already uses; the
// Tauri host generates it and hands it to each sidecar via env.
//
// Resolved once before first render (the startup gate in main.tsx), so every
// caller below stays synchronous — the same shape as `sidecar-ports.ts`.
//
// A loopback port is not a security boundary: any local process can connect, and
// `lsof` reveals a dynamic port instantly. Auth is what actually keeps another
// program on this machine from driving the agent.

import { invoke } from "@tauri-apps/api/core"

export interface SidecarCredentials {
  username: string
  password: string
}

let credentials: SidecarCredentials | null = null

function isCredentials(value: unknown): value is SidecarCredentials {
  if (typeof value !== "object" || value === null) return false
  const c = value as Record<string, unknown>
  return typeof c.username === "string" && typeof c.password === "string" && c.password.length > 0
}

/**
 * Fetch the per-install credentials from the Tauri host. Never rejects: outside
 * Tauri (vitest, e2e in a plain browser) there is nothing to fetch, and the
 * startup gate awaits this.
 *
 * Note the host answers `null` for an unknown command rather than throwing, so
 * validate the shape rather than trusting the absence of an exception.
 */
export async function loadSidecarCredentials(): Promise<SidecarCredentials | null> {
  try {
    const resolved = await invoke<unknown>("get_sidecar_credentials")
    credentials = isCredentials(resolved) ? resolved : null
    if (!credentials) throw new Error(`malformed get_sidecar_credentials response`)
  } catch (err) {
    console.warn("No sidecar credentials; requests will be unauthenticated:", err)
    credentials = null
  }
  return credentials
}

/** `{ Authorization: "Basic …" }`, or `{}` when no credential is known. */
export function sidecarAuthHeaders(): Record<string, string> {
  if (!credentials) return {}
  const token = btoa(`${credentials.username}:${credentials.password}`)
  return { Authorization: `Basic ${token}` }
}

/** Test seam. */
export function __setSidecarCredentialsForTest(next: SidecarCredentials | null): void {
  credentials = next
}
