import { useState } from "react"
import { ChevronDown, Check, Bot } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useAgent } from "@/lib/agent-context"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import type { UnifiedAgent } from "@/lib/agent-types"

interface AgentSelectorProps {
  className?: string
}

export function AgentSelector({ className }: AgentSelectorProps) {
  const [open, setOpen] = useState(false)
  const { agents, currentAgentId, currentAgent, setCurrentAgent } = useAgent()
  const { t } = useI18n()

  // Don't render if no agents available (server not ready or no primary agents)
  if (agents.length === 0) return null

  // Group agents by source
  const openCodeAgents = agents.filter((a) => a.source === "opencode")
  const acpAgents = agents.filter((a) => a.source === "acp")

  const currentLabel = currentAgent?.name ?? t("agent.noAgent")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]",
            className,
          )}
        >
          <Bot className="size-3" />
          <span className="max-w-[100px] truncate">{currentLabel}</span>
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-56 p-0">
        <div className="max-h-60 overflow-y-auto scrollbar-soft">
          {/* OpenCode built-in agents */}
          {openCodeAgents.length > 0 && (
            <AgentGroup
              label={t("agent.builtin")}
              agents={openCodeAgents}
              currentAgentId={currentAgentId}
              onSelect={(id) => {
                setCurrentAgent(id)
                setOpen(false)
              }}
            />
          )}

          {/* External ACP agents */}
          {acpAgents.length > 0 && (
            <>
              <div className="border-t border-[var(--color-border)]" />
              <AgentGroup
                label={t("agent.external")}
                agents={acpAgents}
                currentAgentId={currentAgentId}
                onSelect={(id) => {
                  setCurrentAgent(id)
                  setOpen(false)
                }}
                showStatus
              />
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** Status indicator dot for ACP agents */
function StatusDot({ status }: { status: UnifiedAgent["status"] }) {
  const colorClass =
    status === "connected" ? "bg-green-500" :
    status === "connecting" ? "bg-yellow-500 animate-pulse" :
    status === "error" ? "bg-red-500" :
    "bg-[var(--color-fg-muted)]"
  return <span className={cn("inline-block size-1.5 rounded-full shrink-0", colorClass)} />
}

function AgentGroup({
  label,
  agents,
  currentAgentId,
  onSelect,
  showStatus = false,
}: {
  label: string
  agents: UnifiedAgent[]
  currentAgentId: string
  onSelect: (id: string) => void
  showStatus?: boolean
}) {
  return (
    <div>
      <div className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
        {label}
      </div>
      {agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onSelect(agent.id)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[var(--color-accent)]",
            currentAgentId === agent.id && "bg-[var(--color-accent)]",
          )}
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              {showStatus && <StatusDot status={agent.status} />}
              <span className="truncate font-medium text-[var(--color-fg)]">{agent.name}</span>
            </div>
            {agent.description && (
              <div className="truncate text-[var(--color-fg-muted)]">{agent.description}</div>
            )}
          </div>
          {currentAgentId === agent.id && (
            <Check className="size-3 shrink-0 text-[var(--color-brand)]" />
          )}
        </button>
      ))}
    </div>
  )
}
