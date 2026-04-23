import { useEffect, useState, useCallback } from "react"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useSSESubscribe } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import type { PermissionRequest, QuestionRequest } from "@agent/api-client"
import type { SSEEvent } from "@/lib/sse-client"

export function useSessionPermission(
  sessionId: string | undefined,
  /** Whether the agent is currently active (sending or streaming) */
  isAgentActive: boolean,
) {
  const api = useApi()
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

  useSSESubscribe(handleSSEEvent)

  // --- Polling fallback: catch permission/question events missed by SSE ---
  useEffect(() => {
    if (!sessionId || !isAgentActive || pendingPermission || pendingQuestion) return

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
  }, [sessionId, isAgentActive, pendingPermission, pendingQuestion, api])

  // --- Actions ---
  const replyPermission = useCallback(
    (reply: "once" | "always" | "reject") => {
      if (!pendingPermission) return
      const perm = pendingPermission
      setPendingPermission(null)
      api.replyPermission(perm.id, reply).catch((err: Error) => {
        console.error("Failed to reply permission:", err)
        setPendingPermission(perm)
        toast.error(t("error.replyPermission"))
      })
    },
    [pendingPermission, api, t]
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
