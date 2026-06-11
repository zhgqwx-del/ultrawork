import { useEffect, useState, useCallback } from "react"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useConnector, useSSESubscribe } from "@/lib/sse-context"
import { useI18n } from "@/lib/i18n-context"
import { useAgents } from "@/lib/agent-context"
import { isACPAgentId } from "@/lib/agent-types"
import { replyACPPermission } from "@/lib/agent-router"
import { useACPSSE } from "@/lib/use-acp-sse"
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
  const { getSessionAgentId } = useAgents()
  const isACP = isACPAgentId(getSessionAgentId(sessionId))

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
  // ACP-bound sessions: permission.asked/replied arrive on the sidecar stream
  // (shared EventSource with the message hook).
  useACPSSE(isACP ? sessionId : undefined, handleSSEEvent)

  // --- Polling fallback: catch permission/question events missed by SSE ---
  // ACP sessions skip it: the sidecar is local-only SSE and the opencode
  // /permission list knows nothing about ACP requests.
  useEffect(() => {
    if (!sessionId || isACP || !isAgentActive || pendingPermission || pendingQuestion) return

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
  }, [sessionId, isACP, isAgentActive, pendingPermission, pendingQuestion, api])

  // --- Actions ---
  const replyPermission = useCallback(
    (reply: "once" | "always" | "reject") => {
      if (!pendingPermission || !sessionId) return
      const perm = pendingPermission
      setPendingPermission(null)
      const send = isACP
        ? replyACPPermission(sessionId, perm.id, reply)
        : connector.replyPermission(sessionId, perm.id, reply)
      send.catch((err: Error) => {
        console.error("Failed to reply permission:", err)
        setPendingPermission(perm)
        toast.error(t("error.replyPermission"))
      })
    },
    [pendingPermission, sessionId, isACP, connector, t]
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
