import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"

const STORAGE_KEY_PATH = "workspace_path"
const STORAGE_KEY_RECENT = "workspace_recent"
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

  const value = useMemo<WorkspaceContextValue>(() => ({
    workspacePath,
    confirmed,
    lastPath,
    recentPaths,
    setWorkspace,
    removeRecent,
  }), [workspacePath, confirmed, lastPath, recentPaths, setWorkspace, removeRecent])

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
