import { Loader2, Check, XCircle, Circle, CircleDashed } from "lucide-react"
import type { PlanStep } from "@agent/api-client"
import { useI18n } from "@/lib/i18n-context"

interface PlanPanelProps {
  steps: PlanStep[]
  /** Backend-truth "turn in flight" (ADR-038 / discussions/022). When false,
   *  a lingering in_progress step is the model forgetting to mark it done —
   *  shown statically (not spinning) rather than implying live work. */
  active: boolean
}

function PlanStepIcon({ status, active }: { status: string; active: boolean }) {
  switch (status) {
    case "in_progress":
      return active ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-orange-500" />
      ) : (
        // Turn ended but step never marked complete — static, not a spinner.
        <CircleDashed className="size-3.5 shrink-0 text-orange-500" />
      )
    case "completed":
      return <Check className="size-3.5 shrink-0 text-green-500" />
    case "cancelled":
      return <XCircle className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
    default:
      return <Circle className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
  }
}

export function PlanPanel({ steps, active }: PlanPanelProps) {
  const { t } = useI18n()

  if (steps.length === 0) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("message.noPlan")}</p>
  }

  const completed = steps.filter((s) => s.status === "completed" || s.status === "cancelled").length
  // Turn finished yet a step is still in_progress → model didn't close it out.
  const hasStuck = !active && steps.some((s) => s.status === "in_progress")

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium text-[var(--color-fg-muted)]">
          {completed} / {steps.length}
        </span>
      </div>
      <div className="space-y-1">
        {steps.map((step: PlanStep, i) => (
          <div key={`${i}-${step.content}`} className="flex items-start gap-2 rounded px-1 py-1 text-xs">
            <PlanStepIcon status={step.status} active={active} />
            <span
              className={
                step.status === "completed" || step.status === "cancelled"
                  ? "min-w-0 flex-1 text-[var(--color-fg-muted)] line-through"
                  : "min-w-0 flex-1 text-[var(--color-fg)]"
              }
            >
              {step.content}
            </span>
          </div>
        ))}
      </div>
      {hasStuck && (
        <p className="mt-2 text-[10px] text-[var(--color-fg-muted)]">{t("message.turnEnded")}</p>
      )}
    </div>
  )
}
