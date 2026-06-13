// Delegate tool card (ADR-031 D-7): a `delegate` MCP tool call rendered as a
// dedicated row inside the ExecutionFlow — target agent + task summary, and
// once the blocking call returns, the child session expandable via lazy load.
//
// Detection covers both injection paths:
// - opencode: MCP tool key is exactly "orchestrator_delegate"
//   (sanitize(server)+"_"+sanitize(tool)).
// - ACP: the shaped tool part's `tool` field is the KIND (not the name), so
//   match on the rawInput shape — delegate is the only tool whose input is
//   { agentId, task } (真机校准 M7: adjust if claude's title/kind differs).

import { lazy, memo, Suspense, useState } from "react"
import { Bot, ChevronDown, ChevronRight, Loader2 } from "lucide-react"
import type { ToolPart } from "@agent/api-client"
import type { DelegateResult } from "@agent/orchestrator"
import { useI18n } from "@/lib/i18n-context"
import { useChildSessionHistory } from "@/lib/use-child-session-history"

// Lazy: a static import would close the cycle ExecutionFlow → DelegateRow →
// MessageList → AssistantTurn → ExecutionFlow.
const LazyMessageList = lazy(() =>
  import("./message-list").then((m) => ({ default: m.MessageList })),
)

export function isDelegatePart(part: ToolPart): boolean {
  if (part.tool === "orchestrator_delegate") return true
  const input = part.state?.input as Record<string, unknown> | undefined
  return !!input && typeof input.agentId === "string" && typeof input.task === "string"
}

/**
 * The shim returns the D-2 contract as JSON tool-result text; hosts may wrap
 * it (MCP content envelopes), so fall back to the first {...} block.
 */
export function parseDelegateResult(output: string | undefined): DelegateResult | null {
  if (!output) return null
  for (const candidate of [output, output.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate) as DelegateResult
      if (parsed && typeof parsed === "object" && "sessionId" in parsed) return parsed
    } catch {
      // try the next candidate
    }
  }
  return null
}

export const DelegateRow = memo(function DelegateRow({ part, live }: { part: ToolPart; live: boolean }) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const { state } = part
  const input = (state.input ?? {}) as { agentId?: string; task?: string }
  const output = state.status === "completed" ? state.output : undefined
  const result = parseDelegateResult(output)
  const running = state.status === "pending" || state.status === "running"
  const failed = state.status === "error" || (!!result && result.status !== "completed")
  const taskFirstLine = (input.task ?? "").split("\n")[0]

  const { messages, loadError } = useChildSessionHistory({
    agentId: input.agentId ?? "",
    sessionId: result?.sessionId,
    terminal: !running,
    expanded: expanded && !!result?.sessionId,
  })

  return (
    <div className="py-0.5">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="-mx-1 flex w-[calc(100%+0.5rem)] items-center gap-2 rounded-md px-1 py-1 text-left text-xs transition-colors hover:bg-[var(--color-accent)]"
      >
        {running && live ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--color-fg-muted)]" />
        ) : (
          <Bot className={`size-3.5 shrink-0 ${failed ? "text-red-500" : "text-blue-500"}`} />
        )}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 font-medium text-[var(--color-fg)]">
            {t("delegate.title")} → {input.agentId ?? "?"}
          </span>
          <span className="truncate text-[var(--color-fg-muted)]">{taskFirstLine}</span>
        </span>
        <span className="ml-auto shrink-0 text-[var(--color-fg-muted)]">
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 ml-5 flex flex-col gap-2 border-l border-[var(--color-border)] pl-3">
          {input.task && (
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-[var(--color-fg-muted)]">{input.task}</p>
          )}
          {state.status === "error" && (
            <pre className="overflow-x-auto rounded bg-red-50 p-2 text-[11px] text-red-600 dark:bg-red-950 dark:text-red-400">
              {state.error}
            </pre>
          )}
          {result?.deliverable && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-fg-muted)]">
                {t("delegate.deliverable")}
              </p>
              <pre className="max-h-40 overflow-auto rounded bg-[var(--color-accent)] p-2 text-[11px] whitespace-pre-wrap text-[var(--color-fg)]">
                {result.deliverable}
              </pre>
            </div>
          )}
          {result?.sessionId && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase text-[var(--color-fg-muted)]">
                {t("delegate.childSession")}
              </p>
              {loadError ? (
                <p className="text-xs text-red-500">{loadError}</p>
              ) : messages === null ? (
                <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
              ) : (
                <div className="max-h-[360px] overflow-y-auto rounded border border-[var(--color-border)]">
                  <Suspense fallback={<Loader2 className="m-2 size-4 animate-spin" />}>
                    {/* Child history is lazy-loaded, never live-streamed here:
                        an interrupted/errored child renders settled (its error
                        state), not a perpetual spinner. */}
                    <LazyMessageList messages={messages} sessionActive={false} />
                  </Suspense>
                </div>
              )}
            </div>
          )}
          {running && <p className="text-xs text-[var(--color-fg-muted)]">{t("delegate.running")}</p>}
        </div>
      )}
    </div>
  )
})
