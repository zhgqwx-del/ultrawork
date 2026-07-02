import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from "react"
import { invoke } from "@tauri-apps/api/core"

const STORAGE_KEY_PATH = "workspace_path"
const STORAGE_KEY_RECENT = "workspace_recent"
const MAX_RECENT = 5

interface WorkspaceContextValue {
  /** Current workspace path, null if not yet confirmed this session */
  workspacePath: string | null
  /** Whether workspace has been confirmed for this app session */
  confirmed: boolean
  /** Whether workspace initialization is still in progress */
  initializing: boolean
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
  const [initializing, setInitializing] = useState(true)
  const [confirmed, setConfirmed] = useState(false)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const [recentPaths, setRecentPaths] = useState<string[]>(loadRecent)
  const [lastPath, setLastPath] = useState<string | null>(() => localStorage.getItem(STORAGE_KEY_PATH))

  const setWorkspace = useCallback((path: string) => {
    setWorkspacePath(path)
    setConfirmed(true)
    localStorage.setItem(STORAGE_KEY_PATH, path)
    setLastPath(path)

    // Entering a workspace opencode hasn't seen yet creates a fresh instance,
    // whose skill scan would race on builtin-vs-user same-name duplicates if a
    // skill was installed mid-session (gotchas §10). Reconcile shadowing
    // best-effort before that scan can happen; harmless no-op otherwise.
    invoke("refresh_builtin_skills").catch(() => {})

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

  // Auto-restore last workspace or create default on first launch
  useEffect(() => {
    async function autoInit() {
      try {
        const saved = localStorage.getItem(STORAGE_KEY_PATH)

        if (saved) {
          // Returning user: verify the directory still exists
          const exists = await invoke<boolean>("check_directory_exists", { path: saved })
          if (exists) {
            setWorkspace(saved)
            return
          }
          // Directory gone — clear stale record
          localStorage.removeItem(STORAGE_KEY_PATH)
          setLastPath(null)
        }

        // First launch (or stale path cleared): create default workspace
        const defaultPath = await invoke<string>("ensure_default_workspace")
        setWorkspace(defaultPath)
      } catch (err) {
        console.error("Workspace auto-init failed:", err)
        // Fall through to manual selection
      } finally {
        setInitializing(false)
      }
    }
    autoInit()
  }, [setWorkspace])

  const value = useMemo<WorkspaceContextValue>(() => ({
    workspacePath,
    confirmed,
    initializing,
    lastPath,
    recentPaths,
    setWorkspace,
    removeRecent,
  }), [workspacePath, confirmed, initializing, lastPath, recentPaths, setWorkspace, removeRecent])

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
