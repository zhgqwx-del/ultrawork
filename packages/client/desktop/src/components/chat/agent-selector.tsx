import { useState } from "react"
import { Bot, Check, ChevronDown, Crown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAgents } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"
import type { UnifiedAgentStatus } from "@agent/connector"

interface AgentSelectorProps {
  /** Session-bound mode: read/write the binding in AgentContext. */
  sessionId?: string
  /** Controlled mode (Home: the session doesn't exist yet). */
  agentId?: string
  onAgentChange?: (agentId: string) => void
  /**
   * 档1: one session, one agent — once the conversation has messages the
   * binding is frozen (switching mid-session would split the visible history
   * between the opencode and ACP stores).
   */
  locked?: boolean
  /** Team mode (018): this picks the Leader (主控) — show the role framing. */
  leader?: boolean
  className?: string
}

const STATUS_DOT: Record<UnifiedAgentStatus, string> = {
  available: "bg-green-500",
  connected: "bg-green-500",
  connecting: "bg-yellow-500",
  disconnected: "bg-gray-400",
  error: "bg-red-500",
}

/** Per-session agent picker (ADR-027 档1: one session, one agent). */
export function AgentSelector({
  sessionId,
  agentId,
  onAgentChange,
  locked = false,
  leader = false,
  className,
}: AgentSelectorProps) {
  const [open, setOpen] = useState(false)
  const { agents, acpAvailable, refreshAgents, getSessionAgentId, bindSessionAgent } = useAgents()
  const { t } = useI18n()

  const currentId = agentId ?? getSessionAgentId(sessionId)
  const current = agents.find((a) => a.id === currentId) ?? agents[0]
  const currentName = current?.name ?? "OpenCode"

  const handleOpenChange = (next: boolean) => {
    if (locked) return
    setOpen(next)
    if (next) void refreshAgents()
  }

  return (
    <Popover open={open && !locked} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={locked}
          title={locked ? t("agent.locked") : undefined}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors",
            locked
              ? "cursor-default opacity-70"
              : "hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]",
            className
          )}
        >
          {leader ? <Crown className="size-3 text-amber-500" /> : <Bot className="size-3" />}
          <span className="max-w-[150px] truncate">
            {leader ? `${t("team.leader")} · ${currentName}` : currentName}
          </span>
          {!locked && <ChevronDown className="size-3" />}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-0">
        {leader && (
          <div className="flex items-center gap-1.5 border-b border-[var(--color-border)] px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)]">
            <Crown className="size-3 text-amber-500" />
            {t("agent.pickLeader")}
          </div>
        )}
        <div className="max-h-64 overflow-y-auto scrollbar-soft py-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                if (onAgentChange) onAgentChange(agent.id)
                else if (sessionId) bindSessionAgent(sessionId, agent.id)
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-accent)]",
                currentId === agent.id && "bg-[var(--color-accent)]/60"
              )}
            >
              <span className="relative shrink-0">
                <AgentAvatar agentId={agent.id} name={agent.name} />
                <span
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-[var(--color-bg-elevated)]",
                    STATUS_DOT[agent.status]
                  )}
                />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--color-fg)]">{agent.name}</div>
                {agent.description && (
                  <div className="truncate text-[var(--color-fg-muted)]">{agent.description}</div>
                )}
              </div>
              {currentId === agent.id && <Check className="size-3.5 shrink-0 text-[var(--color-brand)]" />}
            </button>
          ))}
        </div>
        {!acpAvailable && (
          <div className="border-t border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
            {t("agent.sidecarUnavailable")}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
