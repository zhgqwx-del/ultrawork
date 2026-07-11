import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { isACPAgentId } from "@agent/connector"
import type { PermissionRequest } from "@agent/api-client"
import { useApi } from "@/lib/use-api"
import { replyAcpPermission, subscribeDelegateEvents, type DelegateRecord } from "@/lib/orchestration-client"

export interface PendingDelegatePermission {
  delegateId: string
  sessionId: string
  request: PermissionRequest
}

export interface DelegateRows {
  /** Delegates of THIS session that are currently running. */
  active: DelegateRecord[]
  /** Relayed child permission requests awaiting an answer. */
  permissions: PendingDelegatePermission[]
  reply: (pending: PendingDelegatePermission, choice: "once" | "always" | "reject") => Promise<void>
}

/**
 * Delegate activity + relayed child permissions, held at SESSION level (ADR-048).
 *
 * This state used to live inside DelegateDock. That was fine while the dock had a
 * single, permanent home — but the maximized preview re-parents it (chat column ⇄
 * bottom bar), and React treats a move between branches as unmount + remount. The
 * remount silently dropped every pending permission, because the delegate SSE
 * replays only a `delegate.snapshot` of the delegates themselves — **pending
 * permission requests are never re-sent**. A child agent that had asked for
 * permission would then block until its sidecar timed out, with nothing on screen
 * and nothing to click.
 *
 * Subscribing here, above the layout, means the dock can be moved (or unmounted
 * entirely) without losing what the child is waiting on.
 */
export function useDelegateRows(sessionId: string | undefined, workspacePath: string | null): DelegateRows {
  const api = useApi()
  const [delegates, setDelegates] = useState<Map<string, DelegateRecord>>(new Map())
  const [permissions, setPermissions] = useState<PendingDelegatePermission[]>([])

  useEffect(() => {
    return subscribeDelegateEvents((event) => {
      if (event.type === "delegate.snapshot") {
        setDelegates(new Map(event.properties.delegates.map((d) => [d.id, d])))
      } else if (event.type === "delegate.updated") {
        const record = event.properties.delegate
        setDelegates((prev) => new Map(prev).set(record.id, record))
        if (record.status !== "running") {
          // A settled delegate's permissions are moot (sidecar auto-cancels).
          setPermissions((prev) => prev.filter((p) => p.delegateId !== record.id))
        }
      } else if (event.type === "delegate.permission") {
        const inner = event.properties.event as { type: string; properties: unknown }
        if (inner.type === "permission.asked") {
          const request = inner.properties as PermissionRequest
          setPermissions((prev) => {
            if (prev.some((p) => p.request.id === request.id)) return prev
            return [
              ...prev,
              { delegateId: event.properties.delegateId, sessionId: event.properties.sessionId, request },
            ]
          })
        } else if (inner.type === "permission.replied") {
          const props = inner.properties as { requestID?: string; id?: string }
          const replied = props.requestID ?? props.id
          setPermissions((prev) => prev.filter((p) => p.request.id !== replied))
        }
      }
    })
  }, [])

  // A delegate belongs to THIS session when its owner (leader) session matches —
  // scopes the dock per-session so two teams in one workspace never cross-show
  // (discussions/022). Delegates without an ownerSessionId (a future backend that
  // can't supply it) fall back to the original workspace scope.
  const belongs = useCallback(
    (d: DelegateRecord) =>
      d.ownerSessionId ? d.ownerSessionId === sessionId : !workspacePath || d.workspace === workspacePath,
    [sessionId, workspacePath],
  )

  const active = useMemo(
    () => [...delegates.values()].filter((d) => d.status === "running" && belongs(d)),
    [delegates, belongs],
  )

  const visiblePermissions = useMemo(
    () =>
      permissions.filter((p) => {
        const record = delegates.get(p.delegateId)
        return record ? belongs(record) : false
      }),
    [permissions, delegates, belongs],
  )

  const reply = useCallback(
    async (pending: PendingDelegatePermission, choice: "once" | "always" | "reject") => {
      const record = delegates.get(pending.delegateId)
      try {
        if (record && isACPAgentId(record.agentId)) {
          await replyAcpPermission(pending.sessionId, pending.request.id, choice)
        } else {
          await api.replyPermission(pending.request.id, choice)
        }
        setPermissions((prev) => prev.filter((p) => p.request.id !== pending.request.id))
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    },
    [delegates, api],
  )

  return { active, permissions: visiblePermissions, reply }
}
