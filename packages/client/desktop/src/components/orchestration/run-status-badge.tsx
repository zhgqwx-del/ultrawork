import { Ban, CheckCircle2, CircleDashed, Loader2, MinusCircle, XCircle, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import type { RunStatus, StepStatus } from "@agent/orchestrator"

const STYLES: Record<RunStatus | StepStatus, { icon: LucideIcon; className: string; spin?: boolean }> = {
  pending: { icon: CircleDashed, className: "text-[var(--color-fg-muted)]" },
  running: { icon: Loader2, className: "text-[var(--color-accent)]", spin: true },
  completed: { icon: CheckCircle2, className: "text-green-500" },
  failed: { icon: XCircle, className: "text-red-500" },
  cancelled: { icon: Ban, className: "text-orange-400" },
  interrupted: { icon: MinusCircle, className: "text-orange-400" },
  skipped: { icon: MinusCircle, className: "text-[var(--color-fg-muted)]" },
}

export function RunStatusBadge({ status, withLabel = true }: { status: RunStatus | StepStatus; withLabel?: boolean }) {
  const style = STYLES[status] ?? STYLES.pending
  const Icon = style.icon
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs", style.className)}>
      <Icon className={cn("size-3.5", style.spin && "animate-spin")} />
      {withLabel && status}
    </span>
  )
}
