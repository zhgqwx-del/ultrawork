// Thin client for the in-sidecar orchestrator (:4099 /orchestration/*).
// Plain fetch + native EventSource — the ACP sidecar needs no auth headers,
// so the sse-transport machinery would be dead weight here.

import { ACP_DEFAULT_BASE_URL } from "@agent/connector"
import type {
  DelegateEvent,
  DelegateRecord,
  OrchestrationRun,
  OrchestratorEvent,
  PipelineRecipe,
  RecipeStep,
} from "@agent/orchestrator"

export type { DelegateEvent, DelegateRecord }

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

// --- agent-driven delegates (ADR-031 ②, DelegateDock) ---

export async function listDelegates(): Promise<DelegateRecord[]> {
  const res = await fetch(`${BASE}/orchestration/delegates`)
  return (await expectOk<{ delegates: DelegateRecord[] }>(res)).delegates
}

/** Global delegate SSE. First frame is a delegate.snapshot — no initial fetch needed. */
export function subscribeDelegateEvents(handler: (event: DelegateEvent) => void): () => void {
  const source = new EventSource(`${BASE}/orchestration/delegates/events`)
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as { type: string; properties: unknown }
      if (event.type === "heartbeat") return
      handler(event as DelegateEvent)
    } catch {
      // malformed frame — skip
    }
  }
  return () => source.close()
}

/**
 * Dependency depth per step (0 = roots), for grouping parallel steps in the
 * run timeline. Inputs are validated to reference earlier steps, so a single
 * forward pass resolves every level.
 */
export function computeStepLevels(steps: Pick<RecipeStep, "id" | "inputs">[]): number[] {
  const levelById = new Map<string, number>()
  return steps.map((step) => {
    const inputs = step.inputs ?? []
    const level = inputs.length === 0 ? 0 : 1 + Math.max(...inputs.map((id) => levelById.get(id) ?? 0))
    levelById.set(step.id, level)
    return level
  })
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
