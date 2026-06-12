import type { Connector } from "@agent/connector"

export class TurnTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnTimeoutError"
  }
}

export class TurnCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnCancelledError"
  }
}

export class TurnFailedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnFailedError"
  }
}

export interface RunTurnOptions {
  timeoutMs: number
  signal?: AbortSignal
  model?: string
  /** Session workspace, forwarded to prompt (ACP agents spawn/cwd there). */
  directory?: string
}

/**
 * One full child turn: prompt + terminal-state wait. The two backend families
 * have DIFFERENT prompt semantics (verified in stage 3 recon):
 *
 * - opencode (capabilities.sessionStatus): prompt is fire-and-forget
 *   (POST /session/:id/prompt_async → 204 ≠ turn done). Terminal state comes
 *   from events — session.status idle OR an assistant message.updated with a
 *   terminal finish (gateway's bridge needed the same dual signal because
 *   idle events occasionally go missing). A stale idle emitted before our
 *   prompt landed must not settle the turn, so idle only counts after this
 *   turn has shown activity.
 * - ACP (no sessionStatus): the sidecar blocks POST /acp/session/:id/prompt
 *   until StopReason — prompt resolution IS the terminal state. session.error
 *   fails the turn early.
 *
 * Timeout/abort both connector.cancel() the session before rejecting, so a
 * runaway child never outlives its governance window.
 */
export async function runTurn(
  connector: Connector,
  sessionId: string,
  text: string,
  opts: RunTurnOptions,
): Promise<void> {
  if (opts.signal?.aborted) {
    throw new TurnCancelledError("turn aborted before start")
  }

  const waitsForIdle = connector.backendFor(sessionId).capabilities.sessionStatus

  let settled = false
  let settle!: () => void
  let fail!: (err: Error) => void
  const outcome = new Promise<void>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  const resolveOnce = () => {
    if (!settled) {
      settled = true
      settle()
    }
  }
  const rejectOnce = (err: Error) => {
    if (!settled) {
      settled = true
      fail(err)
    }
  }

  let sawActivity = false
  const unsubscribe = connector.subscribeSession(sessionId, (event) => {
    if (event.type === "session.error") {
      const props = event.properties as Record<string, any>
      const message = props?.error?.message ?? props?.message ?? "session error"
      rejectOnce(new TurnFailedError(String(message)))
      return
    }
    if (!waitsForIdle) return
    if (event.type === "session.status") {
      const status = (event.properties as Record<string, any>)?.status
      if (status?.type === "busy") {
        sawActivity = true
      } else if (status?.type === "idle" && sawActivity) {
        resolveOnce()
      }
      return
    }
    if (event.type.startsWith("message.")) {
      sawActivity = true
      if (event.type === "message.updated") {
        const info = (event.properties as Record<string, any>)?.info
        if (info?.role === "assistant" && info?.finish && info.finish !== "tool-calls") {
          resolveOnce()
        }
      }
    }
  })

  const timer = setTimeout(() => {
    void connector.cancel(sessionId).catch(() => {})
    rejectOnce(new TurnTimeoutError(`turn timed out after ${opts.timeoutMs}ms`))
  }, opts.timeoutMs)

  const onAbort = () => {
    void connector.cancel(sessionId).catch(() => {})
    rejectOnce(new TurnCancelledError("turn cancelled"))
  }
  opts.signal?.addEventListener("abort", onAbort)

  try {
    const prompted = connector.prompt(sessionId, text, {
      model: opts.model,
      directory: opts.directory,
    })
    if (waitsForIdle) {
      // Submission errors (4xx/5xx) are the only signal this promise carries.
      prompted.catch((err) => {
        rejectOnce(new TurnFailedError(`prompt submission failed: ${err instanceof Error ? err.message : String(err)}`))
      })
    } else {
      prompted.then(resolveOnce, (err) => {
        rejectOnce(new TurnFailedError(err instanceof Error ? err.message : String(err)))
      })
    }
    await outcome
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener("abort", onAbort)
    unsubscribe()
  }
}
