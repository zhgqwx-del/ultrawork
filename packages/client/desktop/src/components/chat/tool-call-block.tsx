import { useState } from "react"
import { ChevronRight, ChevronDown, Loader2, Check, XCircle, Circle, Wrench } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import type { ToolState } from "@agent/api-client"

interface ToolCallBlockProps {
  tool: string
  state: ToolState
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 animate-spin text-orange-500" />
    case "completed":
      return <Check className="size-4 text-green-500" />
    case "error":
      return <XCircle className="size-4 text-red-500" />
    default:
      return <Circle className="size-4 text-[--color-fg-muted]" />
  }
}

function getTitle(state: ToolState): string | undefined {
  if (state.status === "running" || state.status === "completed") return state.title
  return undefined
}

function getDuration(state: ToolState): number | undefined {
  if ((state.status === "completed" || state.status === "error") && state.time) {
    return state.time.end - state.time.start
  }
  return undefined
}

export function ToolCallBlock({ tool, state }: ToolCallBlockProps) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()

  const title = getTitle(state)
  const displayName = title || tool || t("message.toolCall")
  const duration = getDuration(state)
  const hasInput = state.input && Object.keys(state.input).length > 0
  const hasOutput = state.status === "completed" && state.output
  const hasError = state.status === "error" && state.error
  const hasDetails = hasInput || hasOutput || hasError

  return (
    <div className="my-1.5 rounded-lg border border-[--color-border] bg-[--color-bg-subtle]">
      <button
        onClick={() => hasDetails && setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs text-[--color-fg] transition-colors hover:bg-[--color-accent]"
      >
        <StatusIcon status={state.status} />
        <Wrench className="size-3.5 text-[--color-fg-muted]" />
        <span className="font-medium">{displayName}</span>
        {duration != null && (
          <span className="text-[--color-fg-muted]">
            {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`}
          </span>
        )}
        {hasDetails && (
          <span className="ml-auto">
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </span>
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-[--color-border] px-3 py-2">
          {hasInput && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-[--color-fg-muted]">Input</p>
              <pre className="overflow-x-auto rounded bg-[--color-accent] p-2 text-[11px] text-[--color-fg]">
                {JSON.stringify(state.input, null, 2)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-[--color-fg-muted]">Output</p>
              <pre className="max-h-40 overflow-auto rounded bg-[--color-accent] p-2 text-[11px] text-[--color-fg]">
                {state.status === "completed" && state.output.length > 500
                  ? state.output.slice(0, 500) + "..."
                  : state.status === "completed" ? state.output : ""}
              </pre>
            </div>
          )}
          {hasError && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-red-500">Error</p>
              <pre className="overflow-x-auto rounded bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950 dark:text-red-400">
                {state.status === "error" ? state.error : ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
