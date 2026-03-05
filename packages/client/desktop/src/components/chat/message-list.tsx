import type { SendMessageResponse } from "@agent/api-client"
import { UserMessage } from "./user-message"
import { AssistantMessage } from "./assistant-message"

interface MessageListProps {
  messages: SendMessageResponse[]
  isLoading?: boolean
}

export function MessageList({ messages, isLoading = false }: MessageListProps) {
  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center py-12">
        <p className="text-sm text-[--color-fg-muted]">Send a message to start chatting</p>
      </div>
    )
  }

  return (
    <div className="max-w-full min-w-0 space-y-0 divide-y divide-[--color-border]">
      {messages.map((message, index) => {
        // Combine all text parts into a single content string
        const content = message.parts
          .filter((part) => part.type === "text" && part.text)
          .map((part) => part.text)
          .join("\n\n")

        if (message.info.role === "user") {
          return <UserMessage key={message.info.id || index} content={content} />
        }

        return (
          <AssistantMessage
            key={message.info.id || index}
            content={content}
            isStreaming={!message.info.time.completed}
          />
        )
      })}

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-sm text-[--color-fg-muted]">
            <div className="size-4 animate-spin rounded-full border-2 border-[--color-fg-muted] border-t-transparent" />
            <span>Loading messages...</span>
          </div>
        </div>
      )}
    </div>
  )
}
