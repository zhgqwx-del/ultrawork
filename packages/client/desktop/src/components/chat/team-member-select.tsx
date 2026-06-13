// Card-style team-member multi-select (018 议题 B — replaces the old bare
// checkboxes). Controlled: selection state lives in the caller (Home), which
// also owns the default-all + membersTouched semantics.

import { useState } from "react"
import { Check, ChevronDown, Users } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAgents } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { AgentAvatar } from "./agent-avatar"

export function TeamMemberSelect({
  selected,
  onToggle,
  className,
}: {
  selected: ReadonlySet<string>
  onToggle: (agentId: string) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const { agents, refreshAgents } = useAgents()
  const { t } = useI18n()

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
            "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]",
            className,
          )}
        >
          <Users className="size-3" />
          <span>
            {t("team.members")} · {selected.size}
          </span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-72 p-0">
        <div className="scrollbar-soft max-h-64 overflow-y-auto py-1">
          {agents.map((agent) => {
            const isSelected = selected.has(agent.id)
            return (
              <button
                key={agent.id}
                type="button"
                onClick={() => onToggle(agent.id)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-accent)]",
                  isSelected && "bg-[var(--color-accent)]/50",
                )}
              >
                <AgentAvatar agentId={agent.id} name={agent.name} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-[var(--color-fg)]">{agent.name}</div>
                  {agent.description && (
                    <div className="truncate text-[var(--color-fg-muted)]">{agent.description}</div>
                  )}
                </div>
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
                    isSelected
                      ? "border-[var(--color-brand)] bg-[var(--color-brand)] text-white"
                      : "border-[var(--color-border)]",
                  )}
                >
                  {isSelected && <Check className="size-3" />}
                </span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
