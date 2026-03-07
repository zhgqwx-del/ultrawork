import { useState } from "react"
import { ChevronRight, ChevronDown, Brain } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"

interface ReasoningBlockProps {
  text: string
}

export function ReasoningBlock({ text }: ReasoningBlockProps) {
  const [open, setOpen] = useState(false)
  const { t } = useI18n()

  return (
    <div className="my-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)]">
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
      >
        <Brain className="size-3.5 text-purple-500" />
        <span>{t("message.reasoning")}</span>
        {open ? <ChevronDown className="ml-auto size-3.5" /> : <ChevronRight className="ml-auto size-3.5" />}
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)] px-3 py-2">
          <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-[var(--color-fg-muted)]">
            {text}
          </p>
        </div>
      )}
    </div>
  )
}
