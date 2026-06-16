import { memo } from "react"
import { CopyButton } from "./copy-button"
import { useI18n } from "@/lib/i18n-context"

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const { t } = useI18n()
  return (
    <div className="group flex flex-col items-end py-3">
      <div className="max-w-[85%] rounded-2xl bg-[var(--color-accent)] px-4 py-3">
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--color-fg)]">
          {content}
        </div>
      </div>
      <CopyButton
        text={content}
        ariaLabel={t("message.copyMessage")}
        className="mt-1 rounded p-1.5 text-[var(--color-fg-muted)] opacity-0 transition-opacity hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] group-hover:opacity-100 focus-visible:opacity-100"
        iconClassName="size-3.5"
      />
    </div>
  )
})
