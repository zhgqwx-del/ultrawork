import { useEffect, useState, useCallback } from "react"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useConnector, useSessionSubscribe } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import type { PermissionRequest, QuestionRequest } from "@agent/api-client"
import type { SSEEvent } from "@agent/connector"

export function useSessionPermission(
  sessionId: string | undefined,
  /** Whether the agent is currently active (sending or streaming) */
  isAgentActive: boolean,
) {
  const api = useApi()
  const connector = useConnector()
  const { t } = useI18n()

  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null)
  const [pendingQuestion, setPendingQuestion] = useState<QuestionRequest | null>(null)

  // Reset on session change
  useEffect(() => {
    setPendingPermission(null)
    setPendingQuestion(null)
  }, [sessionId])

  // --- SSE handler (permission + question events) ---
  const handleSSEEvent = useCallback(
    (event: SSEEvent) => {
      switch (event.type) {
        case "permission.asked": {
          const perm = event.properties as PermissionRequest
          if (perm.sessionID === sessionId) {
            setPendingPermission(perm)
          }
          break
        }
        case "permission.replied": {
          const { sessionID: permSid } = event.properties as { sessionID?: string }
          if (permSid === sessionId) setPendingPermission(null)
          break
        }
        case "question.asked": {
          const q = event.properties as QuestionRequest
          if (q.sessionID === sessionId) {
            setPendingQuestion(q)
          }
          break
        }
        case "question.replied":
        case "question.rejected": {
          const { sessionID: qSid } = event.properties as { sessionID?: string }
          if (qSid === sessionId) setPendingQuestion(null)
          break
        }
      }
    },
    [sessionId]
  )

  // Dispatched by binding; ACP permission events arrive on the sidecar's
  // shared per-session stream (multiplexed with the message hook).
  useSessionSubscribe(sessionId, handleSSEEvent)

  // --- Polling fallback: catch permission/question events missed by SSE ---
  // Only backends with REST-listable interactions (capabilities.questions =
  // opencode) have /permission//question lists to poll; the ACP sidecar's
  // permission flow is SSE + suspended-RPC only.
  const pollable = connector.capabilitiesOf(sessionId).questions
  useEffect(() => {
    if (!sessionId || !pollable || !isAgentActive || pendingPermission || pendingQuestion) return

    const poll = () => {
      api.listPermissions().then((perms) => {
        const match = perms.find((p) => p.sessionID === sessionId)
        if (match) setPendingPermission(match)
      }).catch((err) => console.debug("Permission poll failed:", err))

      api.listQuestions().then((qs) => {
        const match = qs.find((q) => q.sessionID === sessionId)
        if (match) setPendingQuestion(match)
      }).catch((err) => console.debug("Question poll failed:", err))
    }

    poll()
    const timer = setInterval(poll, 3000)
    return () => clearInterval(timer)
  }, [sessionId, pollable, isAgentActive, pendingPermission, pendingQuestion, api])

  // --- Actions ---
  const replyPermission = useCallback(
    (reply: "once" | "always" | "reject") => {
      if (!pendingPermission || !sessionId) return
      const perm = pendingPermission
      setPendingPermission(null)
      connector.replyPermission(sessionId, perm.id, reply).catch((err: Error) => {
        console.error("Failed to reply permission:", err)
        setPendingPermission(perm)
        toast.error(t("error.replyPermission"))
      })
    },
    [pendingPermission, sessionId, connector, t]
  )

  const replyQuestion = useCallback(
    (answers: string[][]) => {
      if (!pendingQuestion) return
      const q = pendingQuestion
      setPendingQuestion(null)
      api.replyQuestion(q.id, answers).catch((err: Error) => {
        console.error("Failed to reply question:", err)
        setPendingQuestion(q)
        toast.error(t("error.replyQuestion"))
      })
    },
    [pendingQuestion, api, t]
  )

  const rejectQuestion = useCallback(() => {
    if (!pendingQuestion) return
    const q = pendingQuestion
    setPendingQuestion(null)
    api.rejectQuestion(q.id).catch((err: Error) => {
      console.error("Failed to reject question:", err)
      setPendingQuestion(q)
      toast.error(t("error.rejectQuestion"))
    })
  }, [pendingQuestion, api, t])

  return {
    pendingPermission,
    pendingQuestion,
    replyPermission,
    replyQuestion,
    rejectQuestion,
  }
}
