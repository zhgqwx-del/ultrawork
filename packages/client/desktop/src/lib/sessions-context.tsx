import { createContext, useContext, type ReactNode } from "react"
import { useSessions } from "@/lib/use-sessions"
import type { Session } from "@agent/api-client"

interface SessionsContextType {
  sessions: Session[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  createSession: () => Promise<Session>
  deleteSession: (sessionId: string) => Promise<void>
  updateSession: (id: string, updates: Partial<Session>) => void
  renameSession: (sessionId: string, newTitle: string) => Promise<void>
}

const SessionsContext = createContext<SessionsContextType | null>(null)

export function SessionsProvider({ children }: { children: ReactNode }) {
  const value = useSessions()
  return (
    <SessionsContext.Provider value={value}>
      {children}
    </SessionsContext.Provider>
  )
}

export function useSessionsContext() {
  const context = useContext(SessionsContext)
  if (!context) {
    throw new Error("useSessionsContext must be used within SessionsProvider")
  }
  return context
}
