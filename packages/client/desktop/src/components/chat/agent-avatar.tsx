// Initial-letter agent avatar (018 议题 B). No avatar art exists for agents,
// so identity = first letter + a deterministic palette color from the id.
// Shared by the Home member picker and the Session team header.

import { cn } from "@/lib/utils"

const PALETTE = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-violet-500",
  "bg-rose-500",
  "bg-cyan-600",
  "bg-indigo-500",
  "bg-teal-500",
]

export function agentColor(agentId: string): string {
  let hash = 0
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) | 0
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

export function AgentAvatar({
  agentId,
  name,
  className,
}: {
  agentId: string
  name: string
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white",
        agentColor(agentId),
        className,
      )}
    >
      {(name || agentId).charAt(0).toUpperCase()}
    </span>
  )
}
