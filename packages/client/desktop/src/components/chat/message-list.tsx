import type { SendMessageResponse, MessageInfo } from "@agent/api-client"
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

// A turn is finished when its last message reached a terminal state. That means
// either a terminal `finish` (anything other than "tool-calls", which signals
// the loop continues), OR a message-level `error` (provider APIError / content
// moderation / …) — an errored turn ends with `finish` left undefined, so error
// must count as terminal or it would be misread as "still streaming".
export function isTurnTerminal(lastInfo: MessageInfo | undefined): boolean {
  return !!lastInfo?.error || (!!lastInfo?.finish && lastInfo.finish !== "tool-calls")
}

// Whether a turn should render as actively streaming (spinner + live timer).
// Between tool steps `streamingMessageId` briefly goes null while the turn
// continues, so the last group falls back to "non-terminal last message".
// That inference ONLY holds while the session is genuinely live (sessionActive):
// a reopened/historical session whose last turn ended without a terminal finish
// (errored or interrupted) must render settled, never spin forever.
export function isTurnStreaming(opts: {
  turnMessages: SendMessageResponse[]
  isLastGroup: boolean
  isStopped: boolean
  sessionActive: boolean
  streamingMessageId: string | null
}): boolean {
  const { turnMessages, isLastGroup, isStopped, sessionActive, streamingMessageId } = opts
  if (isStopped) return false
  const containsStreaming = turnMessages.some((m) => m.info.id === streamingMessageId)
  const lastInfo = turnMessages[turnMessages.length - 1]?.info
  return containsStreaming || (isLastGroup && !isTurnTerminal(lastInfo) && sessionActive)
}

// NOTE: turns deliberately carry NO `content-visibility: auto`.
// A skipped subtree reports its `contain-intrinsic-size` instead of its real height,
// so `scrollHeight` under-reports and "scroll to the bottom" lands nowhere near it.
// The transcript is already windowed to TURN_INIT turns (use-session-messages) and
// every turn is memoised (turnPropsEqual), so the layout cost this saved was small
// and the correctness cost was not. See ADR-047 / gotchas.md.

interface MessageListProps {
  messages: SendMessageResponse[]
  isLoading?: boolean
  streamingMessageId?: string | null
  stoppedAtMessageId?: string | null
  /**
   * Whether this session currently has a request in flight. The "infer
   * streaming from a non-terminal last message" fallback (isLastGroup &&
   * !isTerminal) only holds while the session is genuinely live — without this
   * gate, a reopened/historical session whose last turn ended without a
   * terminal `finish` (errored or interrupted) would spin forever. Children
   * rendered from lazy history pass false. Defaults to false (historical).
   */
  sessionActive?: boolean
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
  sessionActive = false,
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
            <div key={message.info.id || index}>
              <UserMessage content={content} />
              {isStopped && <ExecutionStatus state="stopped" />}
            </div>
          )
        }

        const turnMessages = group.messages
        const isStopped = turnMessages.some((m) => m.info.id === stoppedAtMessageId)
        const isLastGroup = index === groups.length - 1
        const isStreaming = isTurnStreaming({
          turnMessages,
          isLastGroup,
          isStopped,
          sessionActive,
          streamingMessageId,
        })
        const turnKey = turnMessages[0]?.info.id || `turn-${index}`

        return (
          <div key={turnKey}>
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
