// Team members bar under the TopBar (018 议题 B). Leader chip + stacked
// member avatars with hover details, plus a LIVE activity ring per member:
// the global delegate SSE says which agents are currently running a
// delegated task in this workspace.

import { useEffect, useState } from "react"
import { Crown } from "lucide-react"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useAgents } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "@/components/chat/agent-avatar"
import {
  subscribeDelegateEvents,
  type DelegateRecord,
  type TeamSessionEntry,
} from "@/lib/orchestration-client"

export function TeamHeader({ entry }: { entry: TeamSessionEntry }) {
  const { agents } = useAgents()
  const { t } = useI18n()
  const [activeAgentIds, setActiveAgentIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const records = new Map<string, DelegateRecord>()
    const recompute = () => {
      const next = new Set<string>()
      for (const d of records.values()) {
        if (d.status === "running" && d.workspace === entry.workspace) next.add(d.agentId)
      }
      setActiveAgentIds(next)
    }
    return subscribeDelegateEvents((event) => {
      if (event.type === "delegate.snapshot") {
        records.clear()
        for (const d of event.properties.delegates) records.set(d.id, d)
      } else if (event.type === "delegate.updated") {
        const d = event.properties.delegate
        records.set(d.id, d)
      } else {
        return
      }
      recompute()
    })
  }, [entry.workspace])

  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name ?? id
  const descOf = (id: string) => agents.find((a) => a.id === id)?.description

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] px-4 py-1.5">
        {/* Leader chip (birth-locked, 018 A-2) */}
        <span
          title={t("team.leader")}
          className="flex items-center gap-1.5 rounded-full border border-[var(--color-border)] py-0.5 pl-0.5 pr-2 text-xs text-[var(--color-fg)]"
        >
          <AgentAvatar agentId={entry.leaderAgentId} name={nameOf(entry.leaderAgentId)} className="size-5" />
          <Crown className="size-3 text-amber-500" />
          {nameOf(entry.leaderAgentId)}
        </span>

        {/* Member avatar group with live delegate activity */}
        <div className="flex items-center">
          {entry.members.map((memberId, i) => {
            const isActive = activeAgentIds.has(memberId)
            return (
              <Tooltip key={memberId}>
                <TooltipTrigger asChild>
                  <span className={cn("relative inline-flex", i > 0 && "-ml-1.5")}>
                    <AgentAvatar
                      agentId={memberId}
                      name={nameOf(memberId)}
                      className={cn(
                        "ring-2 ring-[var(--color-bg)]",
                        isActive && "ring-[var(--color-brand)]",
                      )}
                    />
                    {isActive && (
                      <span className="absolute -right-0.5 -top-0.5 size-2 animate-pulse rounded-full bg-[var(--color-brand)]" />
                    )}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-60">
                  <p className="font-medium">
                    {nameOf(memberId)}
                    {isActive && ` · ${t("delegate.dock.running")}`}
                  </p>
                  {descOf(memberId) && (
                    <p className="text-[var(--color-fg-muted)]">{descOf(memberId)}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>

        <span className="text-xs text-[var(--color-fg-muted)]">
          {entry.members.length} {t("team.membersCount")}
        </span>
      </div>
    </TooltipProvider>
  )
}
