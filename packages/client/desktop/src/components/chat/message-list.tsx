import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { UserMessage } from "./user-message"
import { AssistantTurn } from "./assistant-turn"
import { ExecutionStatus } from "./execution-status"
import { useI18n } from "@/lib/i18n-context"

// A render unit: either a single user message, or one assistant "turn"
// (the consecutive run of assistant messages a single user prompt produces —
// one message per step of the tool-calling loop).
type RenderGroup =
  | { kind: "user"; message: SendMessageResponse }
  | { kind: "assistant"; messages: SendMessageResponse[] }

export function groupIntoTurns(messages: SendMessageResponse[]): RenderGroup[] {
  const groups: RenderGroup[] = []
  for (const message of messages) {
    if (message.info.role === "user") {
      groups.push({ kind: "user", message })
    } else {
      const last = groups[groups.length - 1]
      if (last && last.kind === "assistant") last.messages.push(message)
      else groups.push({ kind: "assistant", messages: [message] })
    }
  }
  return groups
}

// Stable style object — created once to avoid breaking React shallow comparison on every render.
const CONTENT_VISIBILITY_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 500px',
}

interface MessageListProps {
  messages: SendMessageResponse[]
  isLoading?: boolean
  streamingMessageId?: string | null
  stoppedAtMessageId?: string | null
  onArtifactClick?: (artifact: Artifact) => void
  /** Whether there are older messages available (cached or server-side) */
  showLoadEarlier?: boolean
  /** Whether older messages are currently being fetched */
  historyLoading?: boolean
  /** Callback to load earlier messages */
  onLoadEarlier?: () => void
}

export function MessageList({
  messages,
  isLoading = false,
  streamingMessageId = null,
  stoppedAtMessageId = null,
  onArtifactClick,
  showLoadEarlier = false,
  historyLoading = false,
  onLoadEarlier,
}: MessageListProps) {
  const { t } = useI18n()

  if (messages.length === 0 && !isLoading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center py-12">
        <p className="text-sm text-[var(--color-fg-muted)]">{t("placeholder.sendMessage")}</p>
      </div>
    )
  }

  const groups = groupIntoTurns(messages)

  return (
    <div className="max-w-full min-w-0 space-y-1">
      {/* Load earlier messages button */}
      {showLoadEarlier && (
        <div className="flex justify-center py-3">
          <button
            onClick={onLoadEarlier}
            disabled={historyLoading}
            className="text-sm text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)] disabled:opacity-50"
          >
            {historyLoading ? t("message.loadingMessages") : t("message.loadEarlier")}
          </button>
        </div>
      )}

      {groups.map((group, index) => {
        if (group.kind === "user") {
          const message = group.message
          const isStopped = message.info.id === stoppedAtMessageId
          const content = message.parts
            .filter((part): part is { type: "text"; text: string; [key: string]: any } => part.type === "text" && "text" in part)
            .map((part) => part.text)
            .join("\n\n")
          return (
            <div key={message.info.id || index} style={CONTENT_VISIBILITY_STYLE}>
              <UserMessage content={content} />
              {isStopped && <ExecutionStatus state="stopped" />}
            </div>
          )
        }

        const turnMessages = group.messages
        const isStopped = turnMessages.some((m) => m.info.id === stoppedAtMessageId)
        // A turn is "streaming" for the whole multi-step run, not just while a part
        // is arriving: between steps streamingMessageId briefly becomes null and tool
        // execution can take seconds. Derive it from the last message's finish state
        // instead, so the execution flow doesn't collapse/flicker mid-turn.
        // Terminal finish (e.g. "stop") that isn't "tool-calls" means the turn is done.
        const lastInfo = turnMessages[turnMessages.length - 1]?.info
        const isTerminal = !!lastInfo?.finish && lastInfo.finish !== "tool-calls"
        const containsStreaming = turnMessages.some((m) => m.info.id === streamingMessageId)
        const isLastGroup = index === groups.length - 1
        const isStreaming = !isStopped && (containsStreaming || (isLastGroup && !isTerminal))
        const turnKey = turnMessages[0]?.info.id || `turn-${index}`

        // content-visibility: auto lets the browser skip layout/paint for off-screen turns.
        // The streaming turn is excluded so its content renders in real time.
        const contentVisibilityStyle = isStreaming ? undefined : CONTENT_VISIBILITY_STYLE

        return (
          <div key={turnKey} style={contentVisibilityStyle}>
            <AssistantTurn
              messages={turnMessages}
              isStreaming={isStreaming}
              isStopped={isStopped}
              onArtifactClick={onArtifactClick}
            />
            {isStopped && <ExecutionStatus state="stopped" />}
          </div>
        )
      })}

      {isLoading && (
        <div className="flex items-center justify-center py-8">
          <div className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
            <div className="size-4 animate-spin rounded-full border-2 border-[var(--color-fg-muted)] border-t-transparent" />
            <span>{t("message.loadingMessages")}</span>
          </div>
        </div>
      )}
    </div>
  )
}
