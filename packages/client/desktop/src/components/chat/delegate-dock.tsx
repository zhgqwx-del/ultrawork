// Active-delegates dock (ADR-031 ②): the delegate tool call is BLOCKING, so
// while it runs the transcript card has no sessionId yet — a child session's
// permission.asked would hang invisibly. This dock shows relayed child
// permissions inline + live delegate activity.
// Renders nothing when there is no activity (zero footprint for non-users).
//
// PURE RENDERER (ADR-048). The SSE subscription and the pending-permission state
// live in `useDelegateRows` at session level, because the maximized preview
// re-parents this dock (chat column ⇄ bottom bar) and React treats a move between
// branches as unmount + remount. Owning the state here meant a remount silently
// dropped every pending permission: the delegate SSE replays a snapshot of the
// DELEGATES but never re-sends pending permission requests, so a child agent that
// had asked for permission would block until its sidecar timed out — nothing on
// screen, nothing to click.

import { Bot, Loader2, ShieldQuestion } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n-context"
import type { DelegateRows } from "@/lib/use-delegate-rows"

export function DelegateDock({ rows }: { rows: DelegateRows }) {
  const { t } = useI18n()
  const { active, permissions: visiblePermissions, reply } = rows

  if (active.length === 0 && visiblePermissions.length === 0) return null

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
