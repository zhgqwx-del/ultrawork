import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import type { Connector, ConnectorEvent, Unsubscribe } from "@agent/connector"
import { parseAgentId } from "@agent/connector"
import type { SendMessageResponse } from "@agent/api-client"
import type { Orchestrator } from "./orchestrator"
import type { TaskStatus } from "./types"

// Agent-driven delegate (ADR-031 ②, D-1/D-2): the host MCP shim calls
// POST /orchestration/delegate, which lands here. Blocking semantics by
// decision (2026-06-12): the call resolves with the deliverable contract
// { deliverable, sessionId, tokens, cost } — opencode `task` 同构. The shim
// keeps the MCP call alive with progress notifications meanwhile.
//
// Recursion guard is at the INJECTION side (ACP children get no mcpServers
// entry; opencode children get the orchestrator_* tool deny) — if a child
// ever reached this endpoint anyway (vendor behavior change), depth would
// restart at 0. Accepted residual risk; the injection guards are the fence.

export interface DelegateRequest {
  /** Namespaced target agent id: "opencode:default" | "acp:claude" | ... */
  agentId: string
  /** Self-contained subtask prompt (D-2: never the parent transcript). */
  task: string
  /** Absolute workspace the child session runs in. */
  workspace: string
  model?: string
  timeoutMs?: number
}

export type DelegateStatus = "running" | TaskStatus

export interface DelegateRecord {
  id: string
  agentId: string
  task: string
  workspace: string
  status: DelegateStatus
  sessionId?: string
  startedAt: number
  endedAt?: number
  error?: string
}

/** D-2 deliverable contract — the JSON the MCP tool result carries back. */
export interface DelegateResult {
  status: TaskStatus
  sessionId: string
  deliverable?: string
  tokens?: { input: number; output: number }
  cost?: number
  error?: string
}

export type DelegateEvent =
  /** Route-level SSE first frame (composed from list()); the manager itself never emits it. */
  | { type: "delegate.snapshot"; properties: { delegates: DelegateRecord[] } }
  | { type: "delegate.updated"; properties: { delegate: DelegateRecord } }
  /** permission.asked/replied from the child session, relayed for the DelegateDock. */
  | {
      type: "delegate.permission"
      properties: { delegateId: string; workspace: string; sessionId: string; event: ConnectorEvent }
    }

export type DelegateEventHandler = (event: DelegateEvent) => void

export class DelegateRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DelegateRequestError"
  }
}

export interface DelegateManagerDeps {
  orchestrator: Orchestrator
  connectorFor(workspace: string): Connector
  /** Same non-workspace dir the pipeline uses; unset disables hidden-parent creation. */
  hiddenParentWorkspace?: string
  now?: () => number
}

/** Terminal records kept for the dock/inspection beyond the active set. */
const KEEP_TERMINAL = 50
const TITLE_MAX = 48

export class DelegateManager {
  private records = new Map<string, DelegateRecord>()
  private handlers = new Set<DelegateEventHandler>()
  /** One long-lived hidden opencode parent shared by ALL delegate children (sidebar guard). */
  private hiddenParentId: Promise<string> | undefined
  private readonly now: () => number

  constructor(private deps: DelegateManagerDeps) {
    this.now = deps.now ?? Date.now
  }

  async delegate(req: DelegateRequest): Promise<DelegateResult> {
    if (!req?.agentId?.trim()) throw new DelegateRequestError("agentId is required")
    if (!req.task?.trim()) throw new DelegateRequestError("task is required")
    if (!req.workspace?.trim()) throw new DelegateRequestError("workspace is required")
    let workspace: string
    try {
      workspace = realpathSync(req.workspace)
    } catch {
      throw new DelegateRequestError(`workspace does not exist: ${req.workspace}`)
    }

    const record: DelegateRecord = {
      id: `dlg_${randomUUID()}`,
      agentId: req.agentId,
      task: req.task,
      workspace,
      status: "running",
      startedAt: this.now(),
    }
    this.records.set(record.id, record)
    this.emitUpdated(record)

    try {
      const parentSessionId =
        parseAgentId(req.agentId).source === "opencode" ? await this.ensureHiddenParent() : undefined
      const handle = await this.deps.orchestrator.spawn({
        agentId: req.agentId,
        task: req.task,
        workspace,
        model: req.model,
        timeoutMs: req.timeoutMs,
        parentSessionId,
        title: `[delegate] ${req.task.slice(0, TITLE_MAX)}`,
        onEvent: (event) => {
          if (event.type === "permission.asked" || event.type === "permission.replied") {
            this.emit({
              type: "delegate.permission",
              properties: {
                delegateId: record.id,
                workspace,
                sessionId: (event.properties as Record<string, any>)?.sessionID ?? "",
                event,
              },
            })
          }
        },
      })
      record.sessionId = handle.sessionId
      this.emitUpdated(record)

      const result = await handle.done
      record.status = result.status
      record.endedAt = this.now()
      record.error = result.error
      this.emitUpdated(record)
      this.prune()

      if (result.status !== "completed") {
        return { status: result.status, sessionId: handle.sessionId, error: result.error }
      }
      const { deliverable, tokens, cost } = await this.collectDeliverable(workspace, handle.sessionId)
      return { status: "completed", sessionId: handle.sessionId, deliverable, tokens, cost }
    } catch (err) {
      // GovernanceError (depth) propagates for a 4xx; infrastructure errors
      // settle the record so the dock never shows a stuck "running".
      record.status = "failed"
      record.endedAt = this.now()
      record.error = err instanceof Error ? err.message : String(err)
      this.emitUpdated(record)
      this.prune()
      throw err
    }
  }

  list(): DelegateRecord[] {
    // Map preserves insertion (= creation) order; reverse for newest-first.
    // startedAt can tie within one ms, so sorting on it would be unstable.
    return [...this.records.values()].reverse()
  }

  subscribe(handler: DelegateEventHandler): Unsubscribe {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  // --- internals ---

  /**
   * The deliverable is the final assistant text (D-2): walk history from the
   * end to the last assistant message that carries text. Tokens/cost are
   * best-effort sums over assistant messages (ACP backends may not report
   * cost — omitted when nothing is reported).
   */
  private async collectDeliverable(
    workspace: string,
    sessionId: string,
  ): Promise<{ deliverable?: string; tokens?: { input: number; output: number }; cost?: number }> {
    let messages: SendMessageResponse[]
    try {
      const result = await this.deps.connectorFor(workspace).fetchHistory(sessionId)
      messages = result.messages
    } catch (err) {
      console.error(`[delegate] fetchHistory failed for ${sessionId}:`, err)
      return {}
    }

    let deliverable: string | undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const { info, parts } = messages[i]
      if (info?.role !== "assistant") continue
      const text = (parts ?? [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim()
      if (text) {
        deliverable = text
        break
      }
    }

    let input = 0
    let output = 0
    let cost = 0
    let sawUsage = false
    for (const { info } of messages) {
      if (info?.role !== "assistant") continue
      if (info.tokens?.input || info.tokens?.output) {
        input += info.tokens.input ?? 0
        output += info.tokens.output ?? 0
        sawUsage = true
      }
      if (info.cost) cost += info.cost
    }
    return {
      deliverable,
      tokens: sawUsage ? { input, output } : undefined,
      cost: cost > 0 ? cost : undefined,
    }
  }

  private ensureHiddenParent(): Promise<string> | undefined {
    const dir = this.deps.hiddenParentWorkspace
    if (!dir) return undefined
    if (!this.hiddenParentId) {
      this.hiddenParentId = this.deps
        .connectorFor(dir)
        .createSession({ backend: "opencode", title: "[delegates]" })
        .then((ref) => ref.id)
      // A failed creation must not poison every later delegate.
      this.hiddenParentId.catch(() => {
        this.hiddenParentId = undefined
      })
    }
    return this.hiddenParentId
  }

  private prune(): void {
    const terminal = this.list().filter((r) => r.status !== "running")
    for (const record of terminal.slice(KEEP_TERMINAL)) {
      this.records.delete(record.id)
    }
  }

  private emitUpdated(record: DelegateRecord): void {
    this.emit({ type: "delegate.updated", properties: { delegate: { ...record } } })
  }

  private emit(event: DelegateEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event)
      } catch (err) {
        console.error("[delegate] event handler threw:", err)
      }
    }
  }
}
