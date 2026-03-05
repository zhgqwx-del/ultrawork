import { User } from "lucide-react"

interface UserMessageProps {
  content: string
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="flex gap-3 py-4">
      {/* Avatar */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[--color-primary] text-white">
        <User className="size-4" />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-2 pt-1">
        <div className="whitespace-pre-wrap break-words text-sm text-[--color-fg]">{content}</div>
      </div>
    </div>
  )
}
