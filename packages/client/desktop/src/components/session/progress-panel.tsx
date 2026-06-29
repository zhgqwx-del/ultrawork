import { Loader2, Check, XCircle, Circle } from "lucide-react"
import type { SendMessageResponse, ToolPart } from "@agent/api-client"
import { useI18n } from "@/lib/i18n-context"

interface ActivityPanelProps {
  messages: SendMessageResponse[]
}

interface ToolStep {
  tool: string
  title: string
  status: string
  error?: string
}

function extractToolSteps(messages: SendMessageResponse[]): ToolStep[] {
  const steps: ToolStep[] = []
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const part of msg.parts) {
      if (part.type === "tool") {
        const tp = part as ToolPart
        const status = tp.state?.status || "pending"
        let title = tp.tool || "Tool call"
        if ((status === "running" || status === "completed") && tp.state && "title" in tp.state && tp.state.title) {
          title = tp.state.title
        }
        steps.push({
          tool: tp.tool,
          title,
          status,
          error: status === "error" && tp.state && "error" in tp.state ? tp.state.error : undefined,
        })
      }
    }
  }
  return steps
}

function StepIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-3.5 shrink-0 animate-spin text-orange-500" />
    case "completed":
      return <Check className="size-3.5 shrink-0 text-green-500" />
    case "error":
      return <XCircle className="size-3.5 shrink-0 text-red-500" />
    default:
      return <Circle className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
  }
}

/**
 * "Activity" view (ADR-038 方案 B, 次级区): the flat tool-call timeline that
 * used to mislabel itself as "Plan Progress". Keeps observability of what the
 * agent is doing; the structured task plan now lives in PlanPanel.
 */
export function ActivityPanel({ messages }: ActivityPanelProps) {
  const { t } = useI18n()
  const steps = extractToolSteps(messages)
  const completed = steps.filter((s) => s.status === "completed").length

  if (steps.length === 0) {
    return (
      <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("message.noSteps")}</p>
    )
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] font-medium text-[var(--color-fg-muted)]">
          {completed} / {steps.length}
        </span>
      </div>
      <div className="space-y-1">
        {steps.map((step, i) => (
          <div key={`${step.tool}-${i}`} className="flex items-start gap-2 rounded px-1 py-1 text-xs">
            <StepIcon status={step.status} />
            <div className="min-w-0 flex-1">
              <span className="text-[var(--color-fg)]">{step.title}</span>
              {step.error && (
                <p className="mt-0.5 truncate text-[10px] text-red-500">{step.error}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
