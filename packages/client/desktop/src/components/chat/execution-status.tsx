import { Loader2, Check, XCircle, Square } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"

type ExecutionState = "working" | "done" | "error" | "stopped"

interface ExecutionStatusProps {
  state: ExecutionState
  errorMessage?: string
  onStop?: () => void
}

export function ExecutionStatus({ state, errorMessage, onStop }: ExecutionStatusProps) {
  const { t } = useI18n()

  return (
    <div className="flex items-center gap-2 py-2 text-xs">
      {state === "working" && (
        <>
          <Loader2 className="size-3.5 animate-spin text-orange-500" />
          <span className="text-[--color-fg-muted]">{t("message.executionWorking")}</span>
          {onStop && (
            <button
              onClick={onStop}
              className="ml-2 flex items-center gap-1 rounded-md border border-[--color-border] px-2 py-0.5 text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-[--color-fg]"
            >
              <Square className="size-3" />
              <span>{t("message.stopExecution")}</span>
            </button>
          )}
        </>
      )}
      {state === "done" && (
        <>
          <Check className="size-3.5 text-green-500" />
          <span className="text-green-600 dark:text-green-400">{t("message.executionDone")}</span>
        </>
      )}
      {state === "error" && (
        <>
          <XCircle className="size-3.5 text-red-500" />
          <span className="text-red-600 dark:text-red-400">
            {errorMessage || t("message.executionError")}
          </span>
        </>
      )}
      {state === "stopped" && (
        <>
          <Square className="size-3.5 text-orange-400" />
          <span className="text-orange-500 dark:text-orange-400">{t("message.executionStopped")}</span>
        </>
      )}
    </div>
  )
}
