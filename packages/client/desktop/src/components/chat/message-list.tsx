import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { UserMessage } from "./user-message"
import { AssistantMessage } from "./assistant-message"
import { ExecutionStatus } from "./execution-status"
import { useI18n } from "@/lib/i18n-context"

interface MessageListProps {
  messages: SendMessageResponse[]
  isLoading?: boolean
  streamingMessageId?: string | null
  stoppedAtMessageId?: string | null
  onArtifactClick?: (artifact: Artifact) => void
}

export function MessageList({ messages, isLoading = false, streamingMessageId = null, stoppedAtMessageId = null, onArtifactClick }: MessageListProps) {
  const { t } = useI18n()

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center py-12">
        <p className="text-sm text-[--color-fg-muted]">{t("placeholder.sendMessage")}</p>
      </div>
    )
  }

  return (
    <div className="max-w-full min-w-0 space-y-1">
      {messages.map((message, index) => {
        const isStreaming = message.info.id === streamingMessageId
        const isStopped = message.info.id === stoppedAtMessageId

        if (message.info.role === "user") {
          const content = message.parts
            .filter((part): part is { type: "text"; text: string; [key: string]: any } => part.type === "text" && "text" in part)
            .map((part) => part.text)
            .join("\n\n")
          return (
            <div key={message.info.id || index}>
              <UserMessage content={content} />
              {isStopped && <ExecutionStatus state="stopped" />}
            </div>
          )
        }

        return (
          <div key={message.info.id || index}>
            <AssistantMessage
              parts={message.parts}
              isStreaming={isStreaming}
              onArtifactClick={onArtifactClick}
            />
            {isStopped && <ExecutionStatus state="stopped" />}
          </div>
        )
      })}

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-sm text-[--color-fg-muted]">
            <div className="size-4 animate-spin rounded-full border-2 border-[--color-fg-muted] border-t-transparent" />
            <span>{t("message.loadingMessages")}</span>
          </div>
        </div>
      )}
    </div>
  )
}
