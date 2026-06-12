// Run detail: live step timeline (per-run SSE), inline permission bar for
// relayed child-session permissions, lazy-loaded child session history
// (ADR-031 D-4: MVP lazy load — no live inlining).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"
import { ChevronDown, ChevronRight, FileText, Loader2, RotateCcw, ShieldQuestion, Square } from "lucide-react"
import type { OrchestrationRun, RunStep } from "@agent/orchestrator"
import type { SendMessageResponse, PermissionRequest } from "@agent/api-client"
import {
  ACP_BACKEND_KIND,
  OPENCODE_BACKEND_KIND,
  isACPAgentId,
  type AgentBackend,
} from "@agent/connector"
import { TopBar } from "@/components/layout/top-bar"
import { Button } from "@/components/ui/button"
import { MessageList } from "@/components/chat"
import { RunStatusBadge } from "@/components/orchestration/run-status-badge"
import { useApi } from "@/lib/use-api"
import { useConnector } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import { cancelRun, createRun, getRun, replyAcpPermission, subscribeRunEvents } from "@/lib/orchestration-client"

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
  const connector = useConnector()

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

              {/* Step timeline */}
              <div className="flex flex-col gap-2">
                {run.steps.map((step, index) => (
                  <StepCard key={step.id} run={run} step={step} index={index} connector={connector} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function findStepAgent(run: OrchestrationRun | null, stepId: string): string {
  return run?.steps.find((s) => s.id === stepId)?.agentId ?? ""
}

function StepCard({
  run,
  step,
  index,
  connector,
}: {
  run: OrchestrationRun
  step: RunStep
  index: number
  connector: ReturnType<typeof useConnector>
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [messages, setMessages] = useState<SendMessageResponse[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Refetch generation — a terminal-transition refetch must beat an in-flight
  // mid-run fetch, so the LAST call wins instead of skipping while loading.
  const loadGenRef = useRef(0)

  const recipeStep = run.recipe.steps[index]
  const duration = useMemo(() => {
    if (!step.startedAt) return null
    const end = step.endedAt ?? Date.now()
    return `${Math.max(0, Math.round((end - step.startedAt) / 1000))}s`
  }, [step.startedAt, step.endedAt])

  // Lazy history load (D-4): dispatch by the step's agentId explicitly —
  // child sessions are not in the desktop BindingStore, and backendFor's
  // default-backend fallback would mis-route ACP children to opencode.
  const loadHistory = useCallback(async () => {
    if (!step.sessionId) return
    const gen = ++loadGenRef.current
    try {
      const backend = connector.getBackend<AgentBackend>(
        isACPAgentId(step.agentId) ? ACP_BACKEND_KIND : OPENCODE_BACKEND_KIND,
      )
      if (!backend) throw new Error("backend unavailable")
      const result = await backend.fetchHistory(step.sessionId)
      if (loadGenRef.current !== gen) return
      setMessages(result.messages)
      setLoadError(null)
    } catch (err) {
      if (loadGenRef.current !== gen) return
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [connector, step.sessionId, step.agentId])

  const toggle = () => {
    const next = !expanded
    setExpanded(next)
    // Always refetch on expand — the lazy snapshot may be a mid-run capture.
    if (next) void loadHistory()
  }

  // A snapshot loaded while the step was running freezes at "streaming"
  // (last message still sealed finish:"tool-calls") — refetch on terminal
  // transition so an expanded card settles itself.
  const terminalStep = !["pending", "running"].includes(step.status)
  useEffect(() => {
    if (terminalStep && expanded && messages !== null) void loadHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalStep])

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
        <span className="truncate text-xs text-[var(--color-fg-muted)]">{step.agentId}</span>
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
