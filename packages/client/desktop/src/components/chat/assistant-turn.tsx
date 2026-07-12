import { memo, useMemo, useState, useEffect } from "react"
import { XCircle } from "lucide-react"
import type { SendMessageResponse, MessageInfo, MessagePart, ToolPart, FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { MarkdownContent, FileBlock, PatchBlock } from "./message-parts"
import { ExecutionFlow } from "./execution-flow"
import { TurnArtifacts } from "./turn-artifacts"
import { CopyButton } from "./copy-button"
import { useI18n } from "@/lib/i18n-context"
import { samePath } from "@/lib/turn-artifacts"

/** Stable identity so the `turnArtifacts` memo doesn't churn on every render. */
const EMPTY_ARTIFACTS: Artifact[] = []

/** Human-readable text for a message-level error (provider APIError / moderation
 * / etc.). opencode uses `{ name, data: { message } }`; others may use a string. */
function messageErrorText(error: MessageInfo["error"]): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  return error.data?.message ?? error.message ?? error.name
}

interface AssistantTurnProps {
  /** All assistant messages produced by a single user turn, in order. */
  messages: SendMessageResponse[]
  isStreaming?: boolean
  isStopped?: boolean
  onArtifactClick?: (artifact: Artifact) => void
  /** Artifacts this turn produced (from `useSessionArtifacts().byTurn`). */
  artifacts?: Artifact[]
}

const OUTPUT_TYPES = new Set(["text", "file", "patch"])
// Parts that render as a visible row inside the execution flow.
const VISIBLE_FLOW_TYPES = new Set(["reasoning", "tool", "text", "file", "patch"])

function isOutputPart(part: MessagePart): boolean {
  return OUTPUT_TYPES.has(part.type)
}

function fmtTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface TurnModel {
  process: MessagePart[]
  answer: MessagePart[]
  stepCount: number
  tokens: { input: number; output: number; reasoning: number }
  cache: { read: number; write: number }
  cost: number
  durationMs?: number
  /** Turn start (first message created, ms epoch) — drives the live timer. */
  startedAt?: number
  /** Last message completion time (ms epoch), for the turn footer timestamp. */
  completedAt?: number
  /** Model id used for this turn (from message info). */
  modelID?: string
  hasError: boolean
  /** Message-level error text (provider/turn failure), if any — distinct from a
   * tool-part error. Drives the error notice (errored turns have empty parts). */
  errorText?: string
  visibleProcessCount: number
}

export function buildTurnModel(messages: SendMessageResponse[], isStreaming: boolean): TurnModel {
  const lastMsg = messages[messages.length - 1]
  const lastId = lastMsg?.info.id
  // The final answer step never contains tool calls (the loop only exits once a
  // step produces no tools). So if the last message still has a tool part, it is
  // an in-flight tool step, not the answer — keep everything as process until the
  // real answer message arrives. This avoids briefly showing mid-step narration
  // text as the final answer during streaming.
  const lastIsAnswerStep = !!lastMsg && !lastMsg.parts.some((p) => p.type === "tool")

  const process: MessagePart[] = []
  const answer: MessagePart[] = []

  for (const msg of messages) {
    const isLast = msg.info.id === lastId
    for (const part of msg.parts) {
      // The final answer is the set of output parts in the last message of the turn.
      // Everything else (earlier messages, plus the last message's reasoning/steps) is process.
      if (isLast && lastIsAnswerStep && isOutputPart(part)) {
        answer.push(part)
      } else {
        process.push(part)
      }
    }
  }

  // Aggregate token usage / cost from message-level info; fall back to step-finish parts.
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0
  let cost = 0
  for (const msg of messages) {
    const tk = msg.info.tokens
    if (tk) {
      input += tk.input ?? 0
      output += tk.output ?? 0
      reasoning += tk.reasoning ?? 0
      cacheRead += tk.cache?.read ?? 0
      cacheWrite += tk.cache?.write ?? 0
    }
    if (typeof msg.info.cost === "number") cost += msg.info.cost
  }
  // Fallbacks sum across ALL step-finish parts (message-level info may be absent
  // on optimistic / streaming-synthesized messages).
  if (input + output + reasoning === 0) {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "step-finish" && part.tokens) {
          input += part.tokens.input ?? 0
          output += part.tokens.output ?? 0
          reasoning += part.tokens.reasoning ?? 0
          cacheRead += part.tokens.cache?.read ?? 0
          cacheWrite += part.tokens.cache?.write ?? 0
        }
      }
    }
  }
  if (cost === 0) {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type === "step-finish" && typeof part.cost === "number") cost += part.cost
      }
    }
  }

  // Model id + completion timestamp for the turn footer (prefer the last message).
  let modelID: string | undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].info.modelID) {
      modelID = messages[i].info.modelID
      break
    }
  }
  const completedAt = lastMsg?.info.time?.completed ?? lastMsg?.info.time?.created

  // Wall-clock duration: first message created → last message completed.
  const firstCreated = messages[0]?.info.time?.created
  const lastCompleted = lastMsg?.info.time?.completed
  const durationMs =
    !isStreaming && firstCreated != null && lastCompleted != null && lastCompleted > firstCreated
      ? lastCompleted - firstCreated
      : undefined

  // Error if any tool ended in error, OR the turn itself failed (message-level
  // info.error: provider APIError / content moderation / …). The latter is a
  // TERMINAL state even though `finish` stays undefined — capture its text so
  // the turn shows why it stopped instead of an empty/blank turn.
  let hasError = false
  let errorText: string | undefined
  for (const msg of messages) {
    const msgErr = messageErrorText(msg.info.error)
    if (msgErr) {
      hasError = true
      errorText = msgErr // last error wins (the turn-ending one)
    }
    for (const part of msg.parts) {
      if (part.type === "tool" && (part as ToolPart).state?.status === "error") {
        hasError = true
      }
    }
  }

  const visibleProcessCount = process.filter((p) => VISIBLE_FLOW_TYPES.has(p.type)).length

  return {
    process,
    answer,
    stepCount: messages.length,
    tokens: { input, output, reasoning },
    cache: { read: cacheRead, write: cacheWrite },
    cost,
    durationMs,
    startedAt: firstCreated,
    completedAt,
    modelID,
    hasError,
    errorText,
    visibleProcessCount,
  }
}

// opencode emits trailing/duplicate SSE events around a turn's terminal
// `finish` (a late message.part.updated can re-set streamingMessageId, a
// duplicate finish re-fires) which makes `isStreaming` flicker false→true→false
// for a few hundred ms at step/turn boundaries. Reacting to that flicker
// directly flashes the "done" appearance (green check + collapsed flow + stats
// footer) mid-turn — the "假完成/突变" report. Stabilize it: become "streaming"
// immediately, but only drop to "settled" after streaming has stayed false for
// SETTLE_MS continuously. A brief flip back to true clears the pending timer, so
// transient dips never collapse the flow. The real end (streaming stays false)
// settles after one short beat.
export const SETTLE_MS = 600
export function useStableStreaming(streaming: boolean): boolean {
  const [stable, setStable] = useState(streaming)
  useEffect(() => {
    if (streaming) {
      setStable(true)
      return
    }
    const id = setTimeout(() => setStable(false), SETTLE_MS)
    return () => clearTimeout(id)
  }, [streaming])
  return stable
}

export const AssistantTurn = memo(function AssistantTurn({
  messages,
  isStreaming = false,
  isStopped = false,
  onArtifactClick,
  artifacts,
}: AssistantTurnProps) {
  const { t } = useI18n()
  // Debounced streaming flag drives the "done" visuals (footer / collapse /
  // typing dots) so a sub-second SSE flicker can't flash a premature completed
  // state. Duration/token math still uses the raw flag (values, not appearance).
  const streaming = useStableStreaming(isStreaming)
  const model = useMemo(() => buildTurnModel(messages, isStreaming), [messages, isStreaming])

  // A `file`/`patch` part in the answer already renders its own FileBlock/PatchBlock
  // right above the cards. Showing the same file twice, adjacent, is worse than not
  // showing it at all — drop it from the strip. (Answer parts carry the raw path;
  // artifacts carry the workspace-relative one, hence `samePath` rather than `===`.)
  const turnArtifacts = useMemo(() => {
    if (!artifacts?.length) return EMPTY_ARTIFACTS
    const shown: string[] = []
    for (const p of model.answer) {
      if (p.type === "file") {
        const fp = p as FilePart
        shown.push(fp.filename || fp.url || "")
      } else if (p.type === "patch") {
        shown.push(...(p as PatchPart).files)
      }
    }
    if (shown.length === 0) return artifacts
    return artifacts.filter((a) => !shown.some((raw) => raw && samePath(raw, a.path)))
  }, [artifacts, model.answer])

  const hasAnswerText = model.answer.some((p) => p.type === "text" && (p as { text?: string }).text?.trim())
  // Raw markdown of the final answer only (excludes the execution flow / tool
  // narration) — what the copy affordance writes to the clipboard.
  const answerText = model.answer
    .filter((p) => p.type === "text")
    .map((p) => (p as { text?: string }).text || "")
    .join("\n\n")
    .trim()

  // Turn footer: timestamp · tokens · cache · cost · model — shown once the turn
  // has finished (mirrors the per-step stats line of the pre-execution-flow UI).
  const totalTokens = model.tokens.input + model.tokens.output + model.tokens.reasoning
  const footerItems: string[] = []
  if (!streaming && (totalTokens > 0 || model.completedAt != null)) {
    if (model.completedAt != null) footerItems.push(new Date(model.completedAt).toLocaleString())
    footerItems.push(`${t("message.tokensInput")}: ${fmtTok(model.tokens.input)}`)
    footerItems.push(`${t("message.tokensOutput")}: ${fmtTok(model.tokens.output)}`)
    if (model.tokens.reasoning > 0) footerItems.push(`${t("message.tokensReasoning")}: ${fmtTok(model.tokens.reasoning)}`)
    if (model.cache.read > 0 || model.cache.write > 0)
      footerItems.push(`${t("message.cache")}: ${fmtTok(model.cache.read)}r/${fmtTok(model.cache.write)}w`)
    if (model.cost > 0) footerItems.push(`$${model.cost.toFixed(4)}`)
    if (model.modelID) footerItems.push(`${t("message.model")}: ${model.modelID}`)
  }

  return (
    <div className="group py-3">
      {model.visibleProcessCount > 0 && (
        <ExecutionFlow
          parts={model.process}
          stepCount={model.stepCount}
          tokens={model.tokens}
          cost={model.cost}
          durationMs={model.durationMs}
          startedAt={model.startedAt}
          isStreaming={streaming}
          hasError={model.hasError}
          isStopped={isStopped}
          onArtifactClick={onArtifactClick}
        />
      )}

      <div className="space-y-0">
        {model.answer.map((part, i) => {
          const key = "id" in part && part.id ? (part.id as string) : `answer-${i}`
          switch (part.type) {
            case "text":
              return <MarkdownContent key={key} text={(part as { text?: string }).text || ""} />
            case "file":
              return <FileBlock key={key} part={part as FilePart} onArtifactClick={onArtifactClick} />
            case "patch":
              return <PatchBlock key={key} part={part as PatchPart} onArtifactClick={onArtifactClick} />
            default:
              return null
          }
        })}
      </div>

      {!streaming && answerText && (
        <div className="mt-0.5 flex opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton
            text={answerText}
            ariaLabel={t("message.copyAnswer")}
            className="rounded p-1.5 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            iconClassName="size-3.5"
          />
        </div>
      )}

      {/* Only once the turn has settled. The workspace scan that finds most
          artifacts runs on idle, so mid-stream the list is both incomplete and
          still moving (the open window swallows everything) — cards would appear,
          then re-attribute and jump to another turn. */}
      {!streaming && turnArtifacts.length > 0 && (
        <TurnArtifacts artifacts={turnArtifacts} onArtifactClick={onArtifactClick} />
      )}

      {!streaming && model.errorText && (
        <div className="mt-1 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
          <XCircle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium">{t("message.turnError")}</span>
            <span className="ml-1 break-words whitespace-pre-wrap">{model.errorText}</span>
          </div>
        </div>
      )}

      {streaming && !hasAnswerText && (
        <div className="flex items-center gap-2 py-2">
          <div className="flex items-center gap-1">
            <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
            <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.2s]" />
            <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.4s]" />
          </div>
          <span className="text-xs text-[var(--color-fg-muted)]">{t("message.aiTyping")}</span>
        </div>
      )}

      {footerItems.length > 0 && (
        <div className="mt-2 flex items-center gap-3 text-[10px] text-[var(--color-fg-muted)]">
          <div className="h-px flex-1 bg-[var(--color-border)]" />
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center">
            {footerItems.join("  ·  ")}
          </div>
          <div className="h-px flex-1 bg-[var(--color-border)]" />
        </div>
      )}
    </div>
  )
},
// Custom comparison: groupIntoTurns rebuilds the `messages` array each render, but
// the underlying message objects keep their identity unless that specific message
// changed (use-session-messages swaps only the updated one). Comparing element
// references lets historical turns skip re-render/recompute while the streaming
// turn (whose last message object changes each token) still updates.
function turnPropsEqual(prev: AssistantTurnProps, next: AssistantTurnProps): boolean {
  if (
    prev.isStreaming !== next.isStreaming ||
    prev.isStopped !== next.isStopped ||
    prev.onArtifactClick !== next.onArtifactClick ||
    prev.messages.length !== next.messages.length
  ) {
    return false
  }
  // `artifacts` comes out of a Map that is rebuilt on every render, so its array
  // identity always differs. Comparing by reference here would defeat this memo for
  // EVERY turn on every token — exactly the long-session cost ADR-021/047 exist to
  // avoid — so compare the content instead.
  const pa = prev.artifacts
  const na = next.artifacts
  if ((pa?.length ?? 0) !== (na?.length ?? 0)) return false
  if (pa && na) {
    for (let i = 0; i < pa.length; i++) {
      if (pa[i].path !== na[i].path || pa[i].type !== na[i].type) return false
    }
  }
  for (let i = 0; i < prev.messages.length; i++) {
    if (prev.messages[i] !== next.messages[i]) return false
  }
  return true
})
