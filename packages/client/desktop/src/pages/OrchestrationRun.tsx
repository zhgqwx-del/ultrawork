// Run detail: live step timeline (per-run SSE), inline permission bar for
// relayed child-session permissions, lazy-loaded child session history
// (ADR-031 D-4: MVP lazy load — no live inlining).

import { useEffect, useMemo, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, FileText, FolderGit2, Loader2, RotateCcw, ShieldQuestion, Square } from "lucide-react"
import type { OrchestrationRun, RunStep } from "@agent/orchestrator"
import type { PermissionRequest } from "@agent/api-client"
import { isACPAgentId } from "@agent/connector"
import { TopBar } from "@/components/layout/top-bar"
import { Button } from "@/components/ui/button"
import { MessageList } from "@/components/chat"
import { RunStatusBadge } from "@/components/orchestration/run-status-badge"
import { AgentAvatar } from "@/components/chat/agent-avatar"
import { useAgents } from "@/lib/agent-context"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useChildSessionHistory } from "@/lib/use-child-session-history"
import {
  cancelRun,
  computeStepLevels,
  createRun,
  getRun,
  replyAcpPermission,
  subscribeRunEvents,
} from "@/lib/orchestration-client"

interface PendingPermission {
  stepId: string
  sessionId: string
  request: PermissionRequest
}

export function OrchestrationRunPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { t } = useI18n()
  const api = useApi()

  const [run, setRun] = useState<OrchestrationRun | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [permissions, setPermissions] = useState<PendingPermission[]>([])
  const [cancelling, setCancelling] = useState(false)

  // Live updates: snapshot-first SSE while non-terminal; one fetch otherwise.
  useEffect(() => {
    if (!id) return
    let unsubscribe: (() => void) | undefined
    getRun(id)
      .then((initial) => {
        setRun(initial)
        const terminal = !["pending", "running"].includes(initial.status)
        if (terminal) return
        unsubscribe = subscribeRunEvents(id, (event) => {
          if (event.type === "run.updated") {
            setRun(event.properties.run)
          } else if (event.type === "step.updated") {
            setRun((prev) =>
              prev
                ? { ...prev, steps: prev.steps.map((s) => (s.id === event.properties.step.id ? event.properties.step : s)) }
                : prev,
            )
          } else if (event.type === "step.permission") {
            const inner = event.properties.event
            if (inner.type === "permission.asked") {
              const request = inner.properties as PermissionRequest
              setPermissions((prev) =>
                prev.some((p) => p.request.id === request.id)
                  ? prev
                  : [...prev, { stepId: event.properties.stepId, sessionId: event.properties.sessionId, request }],
              )
            } else if (inner.type === "permission.replied") {
              const requestID = (inner.properties as { requestID?: string }).requestID
              setPermissions((prev) => prev.filter((p) => p.request.id !== requestID))
            }
          }
        })
      })
      .catch(() => setNotFound(true))
    return () => unsubscribe?.()
  }, [id])

  const terminal = run ? !["pending", "running"].includes(run.status) : false

  const onCancel = async () => {
    if (!id) return
    setCancelling(true)
    try {
      await cancelRun(id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setCancelling(false)
    }
  }

  const onRerun = async () => {
    if (!run) return
    try {
      const next = await createRun(run.recipe)
      navigate(`/orchestration/run/${next.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const replyPermission = async (pending: PendingPermission, reply: "once" | "always" | "reject") => {
    try {
      if (isACPAgentId(findStepAgent(run, pending.stepId))) {
        await replyAcpPermission(pending.sessionId, pending.request.id, reply)
      } else {
        await api.replyPermission(pending.request.id, reply)
      }
      setPermissions((prev) => prev.filter((p) => p.request.id !== pending.request.id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  if (notFound) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <TopBar title={t("orchestration.title")} onClose={() => navigate("/orchestration")} />
        <p className="py-12 text-center text-sm text-[var(--color-fg-muted)]">{t("orchestration.runNotFound")}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <TopBar title={run?.recipe.name ?? t("orchestration.title")} onClose={() => navigate("/orchestration")} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
          {!run ? (
            <div className="flex justify-center py-12">
              <Loader2 className="size-5 animate-spin text-[var(--color-fg-muted)]" />
            </div>
          ) : (
            <>
              {/* Header: status + actions */}
              <div className="flex items-center gap-3">
                <RunStatusBadge status={run.status} />
                {run.error && <span className="truncate text-xs text-red-500">{run.error}</span>}
                <div className="ml-auto flex gap-2">
                  {!terminal && (
                    <Button variant="outline" size="sm" onClick={() => void onCancel()} disabled={cancelling}>
                      <Square className="size-3.5" />
                      {t("orchestration.cancel")}
                    </Button>
                  )}
                  {terminal && (
                    <Button variant="outline" size="sm" onClick={() => void onRerun()}>
                      <RotateCcw className="size-3.5" />
                      {t("orchestration.rerun")}
                    </Button>
                  )}
                </div>
              </div>

              {/* Inline permission bar — a pending child permission would
                  otherwise hang the headless run until the deny timeout. */}
              {permissions.map((pending) => (
                <div
                  key={pending.request.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2"
                >
                  <ShieldQuestion className="size-4 shrink-0 text-amber-500" />
                  <span className="min-w-0 flex-1 truncate text-xs text-[var(--color-fg)]">
                    [{pending.stepId}] {pending.request.permission}
                    {pending.request.patterns?.length ? ` · ${pending.request.patterns.join(", ")}` : ""}
                  </span>
                  <div className="flex gap-1.5">
                    <Button size="sm" onClick={() => void replyPermission(pending, "once")}>
                      {t("orchestration.perm.once")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void replyPermission(pending, "always")}>
                      {t("orchestration.perm.always")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void replyPermission(pending, "reject")}>
                      {t("orchestration.perm.reject")}
                    </Button>
                  </div>
                </div>
              ))}

              {/* Step timeline, grouped by dependency depth — steps in the
                  same level run in parallel (Fan-out). */}
              <StepTimeline run={run} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function StepTimeline({ run }: { run: OrchestrationRun }) {
  const { t } = useI18n()
  const levels = useMemo(() => computeStepLevels(run.recipe.steps), [run.recipe.steps])
  const groups = useMemo(() => {
    const byLevel = new Map<number, number[]>()
    levels.forEach((level, index) => {
      const group = byLevel.get(level) ?? []
      group.push(index)
      byLevel.set(level, group)
    })
    return [...byLevel.entries()].sort(([a], [b]) => a - b)
  }, [levels])

  return (
    <div className="flex flex-col gap-2">
      {groups.map(([level, indices]) => (
        <div key={level} className="flex flex-col gap-2">
          {indices.length > 1 && (
            <div className="flex items-center gap-2 text-[10px] text-[var(--color-fg-muted)]">
              <span className="h-px flex-1 bg-[var(--color-border)]" />
              {t("orchestration.parallelGroup", { count: indices.length })}
              <span className="h-px flex-1 bg-[var(--color-border)]" />
            </div>
          )}
          {indices.map((index) => (
            <StepCard key={run.steps[index].id} run={run} step={run.steps[index]} index={index} />
          ))}
        </div>
      ))}
    </div>
  )
}

function findStepAgent(run: OrchestrationRun | null, stepId: string): string {
  return run?.steps.find((s) => s.id === stepId)?.agentId ?? ""
}

function StepCard({ run, step, index }: { run: OrchestrationRun; step: RunStep; index: number }) {
  const { t } = useI18n()
  const { agents } = useAgents()
  const [expanded, setExpanded] = useState(false)
  const agentName = agents.find((a) => a.id === step.agentId)?.name ?? step.agentId

  const recipeStep = run.recipe.steps[index]
  const duration = useMemo(() => {
    if (!step.startedAt) return null
    const end = step.endedAt ?? Date.now()
    return `${Math.max(0, Math.round((end - step.startedAt) / 1000))}s`
  }, [step.startedAt, step.endedAt])

  // Lazy history (D-4): expand-always-refetch + terminal refetch + generation
  // counter live in the shared hook (delegate cards reuse the same logic).
  const terminalStep = !["pending", "running"].includes(step.status)
  const { messages, loadError } = useChildSessionHistory({
    agentId: step.agentId,
    sessionId: step.sessionId,
    terminal: terminalStep,
    expanded,
  })

  const toggle = () => setExpanded((prev) => !prev)

  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
      <button onClick={toggle} className="flex w-full items-center gap-2 px-4 py-3 text-left">
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
        )}
        <RunStatusBadge status={step.status} withLabel={false} />
        <span className="text-sm font-medium text-[var(--color-fg)]">{step.id}</span>
        {/* 019 D3: agent identity = avatar + name (aligns with delegate cards). */}
        <AgentAvatar agentId={step.agentId} name={agentName} className="size-5 text-[9px]" />
        <span className="truncate text-xs text-[var(--color-fg-muted)]">{agentName}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          {duration}
        </span>
      </button>
      {step.error && <p className="px-4 pb-2 text-xs text-red-500">{step.error}</p>}
      {expanded && (
        <div className="border-t border-[var(--color-border)] px-4 py-3">
          {recipeStep?.taskPrompt && (
            <p className="mb-2 text-xs whitespace-pre-wrap text-[var(--color-fg-muted)]">{recipeStep.taskPrompt}</p>
          )}
          {step.artifactPath && (
            <p className="mb-2 flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
              <FileText className="size-3" />
              {step.artifactPath}
            </p>
          )}
          {step.worktreePath && (
            <p className="mb-2 flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
              <FolderGit2 className="size-3" />
              {t("orchestration.worktreeKept")}: {step.worktreePath}
            </p>
          )}
          {!step.sessionId ? (
            <p className="text-xs text-[var(--color-fg-muted)]">{t("orchestration.noSession")}</p>
          ) : loadError ? (
            <p className="text-xs text-red-500">{loadError}</p>
          ) : messages === null ? (
            <Loader2 className="size-4 animate-spin text-[var(--color-fg-muted)]" />
          ) : (
            <div className="max-h-[480px] overflow-y-auto">
              <MessageList messages={messages} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
