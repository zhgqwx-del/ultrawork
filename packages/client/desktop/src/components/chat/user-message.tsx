import { memo } from "react"

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[85%] rounded-2xl bg-[var(--color-accent)] px-4 py-3">
        <div className="whitespace-pre-wrap break-words text-sm text-[var(--color-fg)]">
          {content}
        </div>
      </div>
    </div>
  )
})
