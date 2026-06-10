import { useState } from "react"
import { Bot, Check, ChevronDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAgents } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import type { UnifiedAgentStatus } from "@/lib/agent-types"

interface AgentSelectorProps {
  sessionId: string
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
export function AgentSelector({ sessionId, className }: AgentSelectorProps) {
  const [open, setOpen] = useState(false)
  const { agents, acpAvailable, refreshAgents, getSessionAgentId, bindSessionAgent } = useAgents()
  const { t } = useI18n()

  const currentId = getSessionAgentId(sessionId)
  const current = agents.find((a) => a.id === currentId) ?? agents[0]

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next) void refreshAgents()
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]",
            className
          )}
        >
          <Bot className="size-3" />
          <span className="max-w-[120px] truncate">{current?.name ?? "OpenCode"}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-64 p-0">
        <div className="max-h-60 overflow-y-auto scrollbar-soft py-1">
          {agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                bindSessionAgent(sessionId, agent.id)
                setOpen(false)
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-accent)]",
                currentId === agent.id && "bg-[var(--color-accent)]"
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[agent.status])} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-[var(--color-fg)]">{agent.name}</div>
                {agent.description && (
                  <div className="truncate text-[var(--color-fg-muted)]">{agent.description}</div>
                )}
              </div>
              {currentId === agent.id && <Check className="size-3 shrink-0 text-[var(--color-brand)]" />}
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
