interface UserMessageProps {
  content: string
}

export function UserMessage({ content }: UserMessageProps) {
  return (
    <div className="flex justify-end py-3">
      <div className="max-w-[85%] rounded-2xl bg-[--color-accent] px-4 py-3">
        <div className="whitespace-pre-wrap break-words text-sm text-[--color-fg]">
          {content}
        </div>
      </div>
    </div>
  )
}
