import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"

const STORAGE_KEY_PATH = "workspace_path"
const STORAGE_KEY_RECENT = "workspace_recent"
const STORAGE_KEY_SESSION_MAP = "session_dir_map"
const MAX_RECENT = 5

interface WorkspaceContextValue {
  /** Current workspace path, null if not yet confirmed this session */
  workspacePath: string | null
  /** Whether workspace has been confirmed for this app session */
  confirmed: boolean
  /** Last used workspace path from localStorage (for display in selector) */
  lastPath: string | null
  /** Recently used workspace paths (most recent first) */
  recentPaths: string[]
  /** Set workspace path, mark as confirmed, and update recent list */
  setWorkspace: (path: string) => void
  /** Remove a path from the recent list */
  removeRecent: (path: string) => void
  /** Get the shortId for a session, or undefined if not mapped */
  getSessionShortId: (sessionId: string) => string | undefined
  /** Store a session → shortId mapping */
  setSessionShortId: (sessionId: string, shortId: string) => void
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null)

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_RECENT)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveRecent(paths: string[]) {
  localStorage.setItem(STORAGE_KEY_RECENT, JSON.stringify(paths))
}

function loadSessionMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_SESSION_MAP)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveSessionMap(map: Record<string, string>) {
  localStorage.setItem(STORAGE_KEY_SESSION_MAP, JSON.stringify(map))
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // confirmed = false on fresh app start; becomes true after user confirms in WorkspaceSelector
  const [confirmed, setConfirmed] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [recentPaths, setRecentPaths] = useState<string[]>(loadRecent)

  // Last persisted path (for display in selector, not for auto-entering)
  const lastPath = useMemo(() => localStorage.getItem(STORAGE_KEY_PATH), [])

  const setWorkspace = useCallback((path: string) => {
    setWorkspacePath(path)
    setConfirmed(true)
    localStorage.setItem(STORAGE_KEY_PATH, path)

    // Update recent list: add to front, deduplicate, cap at MAX_RECENT
    setRecentPaths((prev) => {
      const updated = [path, ...prev.filter((p) => p !== path)].slice(0, MAX_RECENT)
      saveRecent(updated)
      return updated
    })
  }, [])

  const removeRecent = useCallback((path: string) => {
    setRecentPaths((prev) => {
      const updated = prev.filter((p) => p !== path)
      saveRecent(updated)
      return updated
    })
  }, [])

  const getSessionShortId = useCallback((sessionId: string): string | undefined => {
    return loadSessionMap()[sessionId]
  }, [])

  const setSessionShortId = useCallback((sessionId: string, shortId: string) => {
    const map = loadSessionMap()
    map[sessionId] = shortId
    saveSessionMap(map)
  }, [])

  const value = useMemo<WorkspaceContextValue>(() => ({
    workspacePath,
    confirmed,
    lastPath,
    recentPaths,
    setWorkspace,
    removeRecent,
    getSessionShortId,
    setSessionShortId,
  }), [workspacePath, confirmed, lastPath, recentPaths, setWorkspace, removeRecent, getSessionShortId, setSessionShortId])

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  )
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext)
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider")
  return ctx
}
