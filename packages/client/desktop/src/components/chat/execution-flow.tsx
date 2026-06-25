import { memo, useEffect, useRef, useState } from "react"
import {
  ChevronRight,
  ChevronDown,
  Loader2,
  Check,
  CheckCircle2,
  XCircle,
  Circle,
  CircleStop,
  Brain,
  Wrench,
  MessageSquare,
  FileText,
  FileDiff,
} from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import type { MessagePart, ToolPart, ToolState, ReasoningPart, TextPart, FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { DelegateRow, isDelegatePart } from "./delegate-row"

interface ExecutionFlowProps {
  /** Process parts of the whole turn, concatenated in order (reasoning/tool/narration text/step-*). */
  parts: MessagePart[]
  /** Number of logical steps (assistant messages) in the turn. */
  stepCount: number
  /** Aggregated token usage across the turn. */
  tokens?: { input: number; output: number; reasoning: number }
  /** Aggregated cost across the turn (USD). */
  cost?: number
  /** Wall-clock duration of the turn in ms (created → completed). */
  durationMs?: number
  /** Turn start (first message created, ms epoch) — drives the live timer while streaming. */
  startedAt?: number
  /** True while the turn is still being generated. */
  isStreaming?: boolean
  /** True if any step ended in an error. */
  hasError?: boolean
  /** True if the turn was stopped by the user. */
  isStopped?: boolean
  onArtifactClick?: (artifact: Artifact) => void
}

// --- formatting helpers ---

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function fmtStepDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function fmtTotalDuration(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

function toolDuration(state: ToolState): number | undefined {
  if ((state.status === "completed" || state.status === "error") && state.time) {
    return state.time.end - state.time.start
  }
  return undefined
}

function partDuration(time?: { start: number; end?: number }): number | undefined {
  if (time?.start != null && time.end != null) return time.end - time.start
  return undefined
}

/**
 * Re-render clock for live durations: ticks while `active`, freezes otherwise.
 * Ticking is confined to the row/header that is actually in progress, so
 * historical turns never re-render from it.
 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [active])
  return now
}

function ToolStatusIcon({ status, live = true }: { status: string; live?: boolean }) {
  switch (status) {
    case "running":
      // A genuinely terminal/restored turn can carry a tool whose last reported
      // state is "running" (errored mid-tool, or restored history with no terminal
      // tool update). The turn is not live, so the spinner must NOT run forever —
      // show a neutral indeterminate marker instead (discussions/022 §6).
      return live ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-orange-500" />
      ) : (
        <Circle className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
      )
    case "completed":
      return <Check className="size-3.5 shrink-0 text-green-500" />
    case "error":
      return <XCircle className="size-3.5 shrink-0 text-red-500" />
    default:
      return <Circle className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
  }
}

// --- generic collapsible row ---

interface FlowRowProps {
  icon: React.ReactNode
  label: React.ReactNode
  duration?: number
  expandable?: boolean
  onClick?: () => void
  children?: React.ReactNode // expanded detail
}

function FlowRow({ icon, label, duration, expandable = false, onClick, children }: FlowRowProps) {
  const [open, setOpen] = useState(false)
  const interactive = expandable || !!onClick
  return (
    <div>
      <button
        type="button"
        disabled={!interactive}
        onClick={() => {
          if (onClick) onClick()
          else if (expandable) setOpen((o) => !o)
        }}
        className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs text-[var(--color-fg)] transition-colors ${
          interactive ? "hover:bg-[var(--color-accent)]" : "cursor-default"
        }`}
      >
        {icon}
        {/* Mirrors the header layout: content · duration, chevron right after —
            nothing pinned to the far right. */}
        <span className="min-w-0 truncate">{label}</span>
        {duration != null && (
          <span className="shrink-0 text-[10px] tabular-nums text-[var(--color-fg-muted)]">
            {fmtStepDuration(duration)}
          </span>
        )}
        {expandable && (
          <span className="shrink-0 text-[var(--color-fg-muted)]">
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </span>
        )}
      </button>
      {expandable && open && children != null && <div className="px-1.5 pb-2 pl-4">{children}</div>}
    </div>
  )
}

// --- per-part row renderers ---

const ReasoningRow = memo(function ReasoningRow({ part, live }: { part: ReasoningPart; live: boolean }) {
  const { t } = useI18n()
  const text = part.text || ""
  // In-progress reasoning (started, not yet ended) gets a subtle pulse.
  const thinking = part.time?.start != null && part.time?.end == null
  // Live only while the turn streams — a dangling start in a restored/stopped
  // turn must not tick forever.
  const ticking = live && thinking
  const now = useNow(ticking)
  const duration = ticking && part.time?.start != null ? Math.max(0, now - part.time.start) : partDuration(part.time)
  return (
    <FlowRow
      icon={<Brain className={`size-3.5 shrink-0 text-purple-500 ${thinking ? "animate-pulse" : ""}`} />}
      label={t("message.deepThinking")}
      duration={duration}
      expandable={!!text.trim()}
    >
      <p className="whitespace-pre-wrap text-xs italic leading-relaxed text-[var(--color-fg-muted)]">{text}</p>
    </FlowRow>
  )
})

const ToolRow = memo(function ToolRow({ part, live }: { part: ToolPart; live: boolean }) {
  const { t } = useI18n()
  const { state } = part
  const title =
    (state.status === "running" || state.status === "completed") && state.title
      ? state.title
      : part.tool || t("message.toolCall")
  const hasInput = state.input && Object.keys(state.input).length > 0
  const hasOutput = state.status === "completed" && !!state.output
  const hasError = state.status === "error" && !!state.error
  const expandable = hasInput || hasOutput || hasError
  // Live only while the turn streams — a restored turn stuck at "running"
  // must not tick forever.
  const ticking = live && state.status === "running"
  const now = useNow(ticking)
  const duration =
    ticking && state.status === "running" ? Math.max(0, now - state.time.start) : toolDuration(state)
  return (
    <FlowRow
      icon={<ToolStatusIcon status={state.status} live={live} />}
      label={
        <span className="flex min-w-0 items-center gap-1.5">
          <Wrench className="size-3 shrink-0 text-[var(--color-fg-muted)]" />
          <span className="truncate font-medium">{title}</span>
        </span>
      }
      duration={duration}
      expandable={expandable}
    >
      <div className="space-y-2">
        {hasInput && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-fg-muted)]">Input</p>
            <pre className="overflow-x-auto rounded bg-[var(--color-accent)] p-2 text-[11px] text-[var(--color-fg)]">
              {JSON.stringify(state.input, null, 2)}
            </pre>
          </div>
        )}
        {hasOutput && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-fg-muted)]">Output</p>
            <pre className="max-h-40 overflow-auto rounded bg-[var(--color-accent)] p-2 text-[11px] text-[var(--color-fg)]">
              {state.status === "completed" && state.output.length > 500
                ? state.output.slice(0, 500) + "..."
                : state.status === "completed"
                  ? state.output
                  : ""}
            </pre>
          </div>
        )}
        {hasError && (
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase text-red-500">Error</p>
            <pre className="overflow-x-auto rounded bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950 dark:text-red-400">
              {state.status === "error" ? state.error : ""}
            </pre>
          </div>
        )}
      </div>
    </FlowRow>
  )
})

const NarrationRow = memo(function NarrationRow({ part }: { part: TextPart }) {
  const text = part.text || ""
  const firstLine = text.split("\n")[0]
  return (
    <FlowRow
      icon={<MessageSquare className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />}
      label={<span className="text-[var(--color-fg-muted)]">{firstLine}</span>}
      expandable={text.length > firstLine.length || text.length > 80}
    >
      <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-fg-muted)]">{text}</p>
    </FlowRow>
  )
})

function ArtifactRow({
  icon,
  name,
  onClick,
}: {
  icon: React.ReactNode
  name: string
  onClick?: () => void
}) {
  return <FlowRow icon={icon} label={name} onClick={onClick} />
}

// --- header status icon ---

function HeaderIcon({ isStreaming, hasError, isStopped }: { isStreaming: boolean; hasError: boolean; isStopped: boolean }) {
  if (isStreaming) return <Loader2 className="size-4 shrink-0 animate-spin text-[var(--color-primary)]" />
  if (isStopped) return <CircleStop className="size-4 shrink-0 text-[var(--color-fg-muted)]" />
  if (hasError) return <XCircle className="size-4 shrink-0 text-red-500" />
  return <CheckCircle2 className="size-4 shrink-0 text-green-500" />
}

export const ExecutionFlow = memo(function ExecutionFlow({
  parts,
  stepCount,
  tokens,
  cost,
  durationMs,
  startedAt,
  isStreaming = false,
  hasError = false,
  isStopped = false,
  onArtifactClick,
}: ExecutionFlowProps) {
  const { t } = useI18n()

  // Total duration ticks live while streaming; buildTurnModel supplies the
  // final created→completed value once the turn ends.
  const headerTicking = isStreaming && startedAt != null
  const now = useNow(headerTicking)
  // Prefer the finalized duration once the turn has actually ended (durationMs is
  // set by buildTurnModel on the RAW !isStreaming). isStreaming here is debounced
  // (useStableStreaming), so without this the live timer keeps ticking through the
  // ~600ms settle window and then snaps backward to durationMs. Showing durationMs
  // as soon as it exists avoids that overshoot/snap.
  const shownDurationMs = durationMs != null ? durationMs : headerTicking ? Math.max(0, now - startedAt) : undefined

  // Expanded while streaming; auto-collapse when the turn finishes.
  // A manual toggle is respected until the streaming state flips again.
  const [open, setOpen] = useState(isStreaming)
  const prevStreaming = useRef(isStreaming)
  useEffect(() => {
    if (prevStreaming.current !== isStreaming) {
      setOpen(isStreaming)
      prevStreaming.current = isStreaming
    }
  }, [isStreaming])

  const totalTokens = tokens ? tokens.input + tokens.output + tokens.reasoning : 0

  return (
    <div className="mt-2 mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1 text-xs transition-colors hover:bg-[var(--color-accent)]"
      >
        <HeaderIcon isStreaming={isStreaming} hasError={hasError} isStopped={isStopped} />
        <span className="font-medium text-[var(--color-fg)]">{t("message.executionFlow")}</span>
        <span className="flex items-center gap-2 text-[10px] text-[var(--color-fg-muted)]">
          <span>
            {stepCount}&nbsp;{t("message.steps")}
          </span>
          {shownDurationMs != null && shownDurationMs > 0 && <span>· {fmtTotalDuration(shownDurationMs)}</span>}
          {totalTokens > 0 && <span>· {fmtTokens(totalTokens)} tok</span>}
          {cost != null && cost > 0 && <span>· ${cost.toFixed(4)}</span>}
        </span>
        {/* Chevron right after the content, mirroring the rows. */}
        <span className="shrink-0 text-[var(--color-fg-muted)]">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {open && (
        // Single continuous timeline rail (ml aligns it under the header status icon).
        <div className="mt-0.5 ml-[7px] border-l border-[var(--color-border)] pl-3">
          {parts.map((part, i) => {
            const key = "id" in part && part.id ? (part.id as string) : `flow-${i}`
            switch (part.type) {
              case "reasoning":
                return <ReasoningRow key={key} part={part as ReasoningPart} live={isStreaming} />
              case "tool": {
                const tp = part as ToolPart
                // Delegate calls get a dedicated card with the child session
                // expandable inside (ADR-031 D-7).
                if (isDelegatePart(tp)) return <DelegateRow key={key} part={tp} live={isStreaming} />
                return <ToolRow key={key} part={tp} live={isStreaming} />
              }
              case "text":
                return <NarrationRow key={key} part={part as TextPart} />
              case "file": {
                const fp = part as FilePart
                const name = fp.filename || fp.url.split("/").pop() || "file"
                return (
                  <ArtifactRow
                    key={key}
                    icon={<FileText className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />}
                    name={name}
                    onClick={
                      onArtifactClick
                        ? () => onArtifactClick({ type: "file", path: fp.filename || fp.url || "unknown", mime: fp.mime })
                        : undefined
                    }
                  />
                )
              }
              case "patch": {
                const pp = part as PatchPart
                const name = `${pp.files.length} ${t("workspace.filesChanged")}`
                return (
                  <ArtifactRow
                    key={key}
                    icon={<FileDiff className="size-3.5 shrink-0 text-blue-500" />}
                    name={name}
                    onClick={
                      onArtifactClick && pp.files.length > 0
                        ? () => onArtifactClick({ type: "patch", path: pp.files[0] })
                        : undefined
                    }
                  />
                )
              }
              default:
                return null
            }
          })}
        </div>
      )}
    </div>
  )
})
