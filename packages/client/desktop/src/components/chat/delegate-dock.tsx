// Active-delegates dock (ADR-031 ②): the delegate tool call is BLOCKING, so
// while it runs the transcript card has no sessionId yet — a child session's
// permission.asked would hang invisibly. This dock subscribes to the global
// delegate SSE (snapshot-first), filters to the current workspace, and lets
// the user answer relayed permissions inline + watch live delegate activity.
// Renders nothing when there is no activity (zero footprint for non-users).

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Bot, Loader2, ShieldQuestion } from "lucide-react"
import { isACPAgentId } from "@agent/connector"
import type { PermissionRequest } from "@agent/api-client"
import { Button } from "@/components/ui/button"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import {
  replyAcpPermission,
  subscribeDelegateEvents,
  type DelegateRecord,
} from "@/lib/orchestration-client"

interface PendingDelegatePermission {
  delegateId: string
  sessionId: string
  request: PermissionRequest
}

export function DelegateDock({ workspacePath, sessionId }: { workspacePath: string | null; sessionId?: string }) {
  const { t } = useI18n()
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
              {
                delegateId: event.properties.delegateId,
                sessionId: event.properties.sessionId,
                request,
              },
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
  const belongs = (d: DelegateRecord) =>
    d.ownerSessionId ? d.ownerSessionId === sessionId : (!workspacePath || d.workspace === workspacePath)
  const active = useMemo(
    () => [...delegates.values()].filter((d) => d.status === "running" && belongs(d)),
    [delegates, sessionId, workspacePath],
  )
  const visiblePermissions = useMemo(
    () =>
      permissions.filter((p) => {
        const record = delegates.get(p.delegateId)
        return record ? belongs(record) : false
      }),
    [permissions, delegates, sessionId, workspacePath],
  )

  if (active.length === 0 && visiblePermissions.length === 0) return null

  const reply = async (pending: PendingDelegatePermission, choice: "once" | "always" | "reject") => {
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
  }

  return (
    <div className="w-full max-w-[860px] px-4 pt-2">
      <div className="flex flex-col gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2">
        {active.map((record) => (
          <div key={record.id} className="flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-blue-500" />
            <Bot className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
            <span className="shrink-0 font-medium text-[var(--color-fg)]">
              {t("delegate.dock.running")} → {record.agentId}
            </span>
            <span className="min-w-0 flex-1 truncate text-[var(--color-fg-muted)]">
              {record.task.split("\n")[0]}
            </span>
          </div>
        ))}
        {visiblePermissions.map((pending) => (
          <div
            key={pending.request.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-1.5"
          >
            <ShieldQuestion className="size-4 shrink-0 text-amber-500" />
            <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-fg)]">
              {pending.request.permission}
              {pending.request.patterns?.length ? ` · ${pending.request.patterns.join(", ")}` : ""}
            </span>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => void reply(pending, "once")}>
                {t("orchestration.perm.once")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void reply(pending, "always")}>
                {t("orchestration.perm.always")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void reply(pending, "reject")}>
                {t("orchestration.perm.reject")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
