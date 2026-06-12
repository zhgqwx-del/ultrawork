// Thin client for the in-sidecar orchestrator (:4099 /orchestration/*).
// Plain fetch + native EventSource — the ACP sidecar needs no auth headers,
// so the sse-transport machinery would be dead weight here.

import { ACP_DEFAULT_BASE_URL } from "@agent/connector"
import type { OrchestrationRun, OrchestratorEvent, PipelineRecipe } from "@agent/orchestrator"

const BASE = ACP_DEFAULT_BASE_URL

async function expectOk<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export async function createRun(recipe: PipelineRecipe): Promise<OrchestrationRun> {
  const res = await fetch(`${BASE}/orchestration/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe }),
  })
  return (await expectOk<{ run: OrchestrationRun }>(res)).run
}

export async function listRuns(): Promise<OrchestrationRun[]> {
  const res = await fetch(`${BASE}/orchestration/runs`)
  return (await expectOk<{ runs: OrchestrationRun[] }>(res)).runs
}

export async function getRun(runId: string): Promise<OrchestrationRun> {
  const res = await fetch(`${BASE}/orchestration/runs/${encodeURIComponent(runId)}`)
  return (await expectOk<{ run: OrchestrationRun }>(res)).run
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${BASE}/orchestration/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })
  await expectOk<{ ok: boolean }>(res)
}

/**
 * Per-run SSE. The first frame is always a full run.updated snapshot, so the
 * caller needs no separate initial fetch to avoid missed events.
 */
export function subscribeRunEvents(runId: string, handler: (event: OrchestratorEvent) => void): () => void {
  const source = new EventSource(`${BASE}/orchestration/runs/${encodeURIComponent(runId)}/events`)
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as { type: string; properties: unknown }
      if (event.type === "heartbeat") return
      handler(event as OrchestratorEvent)
    } catch {
      // malformed frame — skip
    }
  }
  return () => source.close()
}

/** Reply to a relayed ACP child-session permission (existing sidecar endpoint). */
export async function replyAcpPermission(
  sessionId: string,
  permissionId: string,
  reply: "once" | "always" | "reject",
): Promise<void> {
  const res = await fetch(`${BASE}/acp/session/${encodeURIComponent(sessionId)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissionId, reply }),
  })
  await expectOk<{ ok: boolean }>(res)
}
