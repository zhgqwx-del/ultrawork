// The one HTTP client for the knowledge sidecar.
//
// There used to be two copies of this — one in `use-knowledge-base.ts`, a private
// one in `add-source-dialog.tsx`. When the sidecar's port became dynamic and its
// routes required Basic auth, only the first copy was updated, and every
// add-source flow started returning 401 against a hardcoded :4098. One client.

import { knowledgeBaseUrl } from "@/lib/sidecar-ports"
import { sidecarAuthHeaders } from "@/lib/sidecar-auth"

/** `path` is relative to `/kb` (e.g. `/sources`). */
export async function kbFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${knowledgeBaseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...sidecarAuthHeaders(), ...options?.headers },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`KB ${resp.status}: ${body}`)
  }
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

/** SSE URL for index progress. The transport supplies the auth headers itself. */
export function kbEventsUrl(): string {
  return `${knowledgeBaseUrl()}/sources/events`
}
