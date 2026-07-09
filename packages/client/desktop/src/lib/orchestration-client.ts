// Thin client for the in-sidecar orchestrator (ACP sidecar, /orchestration/*).
// Plain fetch + native EventSource — the ACP sidecar needs no auth headers,
// so the sse-transport machinery would be dead weight here.

import { acpBaseUrl } from "@/lib/sidecar-ports"
import type {
  DelegateEvent,
  DelegateRecord,
  OrchestrationRun,
  OrchestratorEvent,
  PipelineRecipe,
  RecipeStep,
} from "@agent/orchestrator"

export type { DelegateEvent, DelegateRecord }

async function expectOk<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export async function createRun(recipe: PipelineRecipe): Promise<OrchestrationRun> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ recipe }),
  })
  return (await expectOk<{ run: OrchestrationRun }>(res)).run
}

export async function listRuns(): Promise<OrchestrationRun[]> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/runs`)
  return (await expectOk<{ runs: OrchestrationRun[] }>(res)).runs
}

export async function getRun(runId: string): Promise<OrchestrationRun> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/runs/${encodeURIComponent(runId)}`)
  return (await expectOk<{ run: OrchestrationRun }>(res)).run
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })
  await expectOk<{ ok: boolean }>(res)
}

/**
 * Per-run SSE. The first frame is always a full run.updated snapshot, so the
 * caller needs no separate initial fetch to avoid missed events.
 */
export function subscribeRunEvents(runId: string, handler: (event: OrchestratorEvent) => void): () => void {
  const source = new EventSource(`${acpBaseUrl()}/orchestration/runs/${encodeURIComponent(runId)}/events`)
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
  const res = await fetch(`${acpBaseUrl()}/orchestration/delegates`)
  return (await expectOk<{ delegates: DelegateRecord[] }>(res)).delegates
}

/** Global delegate SSE. First frame is a delegate.snapshot — no initial fetch needed. */
export function subscribeDelegateEvents(handler: (event: DelegateEvent) => void): () => void {
  const source = new EventSource(`${acpBaseUrl()}/orchestration/delegates/events`)
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

// --- Team sessions (017 Team 页) ---

export interface TeamSessionEntry {
  /** The Leader's opencode session id (or its twin for ACP leaders) — the chat key. */
  id: string
  workspace: string
  leaderAgentId: string
  members: string[]
  title?: string
  createdAt: number
}

export async function createTeamSession(opts: {
  workspace: string
  leaderAgentId: string
  members: string[]
  systemPrompt?: string
  title?: string
}): Promise<TeamSessionEntry> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/team/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  })
  return (await expectOk<{ session: TeamSessionEntry }>(res)).session
}

export async function listTeamSessions(workspace?: string): Promise<TeamSessionEntry[]> {
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ""
  const res = await fetch(`${acpBaseUrl()}/orchestration/team/sessions${query}`)
  return (await expectOk<{ sessions: TeamSessionEntry[] }>(res)).sessions
}

export async function deleteTeamSession(id: string): Promise<void> {
  const res = await fetch(`${acpBaseUrl()}/orchestration/team/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  })
  await expectOk<{ ok: boolean }>(res)
}

/** Reply to a relayed ACP child-session permission (existing sidecar endpoint). */
export async function replyAcpPermission(
  sessionId: string,
  permissionId: string,
  reply: "once" | "always" | "reject",
): Promise<void> {
  const res = await fetch(`${acpBaseUrl()}/acp/session/${encodeURIComponent(sessionId)}/permission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ permissionId, reply }),
  })
  await expectOk<{ ok: boolean }>(res)
}
