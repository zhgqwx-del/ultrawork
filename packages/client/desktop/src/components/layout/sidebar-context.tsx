import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"

/**
 * Artifact preview state (ADR-048). The preview and the right sidebar are
 * MUTUALLY EXCLUSIVE: they used to be siblings in the same flex row alongside
 * the chat column, where `50% + 50% + 288px` overflowed by the sidebar's width
 * and — because only the chat column was shrinkable — the chat silently ate the
 * whole overflow (down to ~300px on a 1440px window, collapsing the 860px prose
 * column). Making them exclusive means the three columns can never add up to
 * more than 100% by construction, rather than by tuning numbers.
 *
 * - `half` — chat and preview split the main area.
 * - `full` — preview takes the whole main area; the transcript hides but the
 *   composer stays, so the user can keep talking while reading (see Session.tsx).
 */
export type PreviewMode = "closed" | "half" | "full"

/**
 * Below this main-area width a half split leaves both columns too narrow to be
 * worth it, so the preview opens `full` instead. Only evaluated at open time — a
 * later resize never yanks the layout out from under the user.
 *
 * Calibrate against the DEFAULT window, not a big one. `tauri.conf.json` ships
 * 1200×800, which leaves a ~940px main area — the first version of this used
 * 1100px and therefore sent *every* artifact click on a fresh install straight to
 * full-screen, wiping the conversation off screen. Real usage caught that in
 * about a minute; a 1440px e2e viewport never would. At 940px each side gets
 * ~470px: tight, but usable — and maximize is one click away regardless.
 */
const NARROW_MAIN_PX = 800

interface SidebarContextType {
  leftOpen: boolean
  toggleLeft: () => void
  setLeftOpen: (open: boolean) => void
  rightOpen: boolean
  toggleRight: () => void
  setRightOpen: (open: boolean) => void
  previewMode: PreviewMode
  /**
   * Open the preview: collapses the right sidebar (remembering its state) and
   * picks `half`/`full` by available width. No-op if already open.
   *
   * `mainWidth` is the MEASURED width of the area the preview will share with the
   * chat. Callers pass what they actually rendered — deriving it here from
   * `window.innerWidth` minus an assumed sidebar width means duplicating layout
   * constants that then drift (and silently mis-deciding when they do).
   */
  openPreview: (mainWidth?: number) => void
  /** Close the preview and restore the right sidebar to its pre-preview state —
   *  unless the user has since touched the sidebar by hand, which voids the
   *  snapshot ("manual wins"). */
  closePreview: () => void
  /** Toggle `half` ⇄ `full`. No-op while closed. */
  togglePreviewMaximized: () => void
  /**
   * Return path for closing the Settings page: the last route the user was on
   * before entering `/settings`. Lets Settings return to where it came from
   * (Home / a session / orchestration) instead of always jumping to `/`.
   */
  getReturnPath: () => string
}

const SidebarContext = createContext<SidebarContextType | null>(null)

/** Single source of truth for "is this the Settings route". Used both to derive
 *  the forced-collapsed sidebar and to skip recording the return path, so the two
 *  never drift (e.g. if a `/settings-*` sibling route is added later). */
export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/")
}

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(false)

  // Track the last non-settings location so Settings can return to it on close.
  const location = useLocation()
  const lastMainPathRef = useRef("/")
  useEffect(() => {
    if (!isSettingsPath(location.pathname)) {
      lastMainPathRef.current = location.pathname + location.search
    }
  }, [location.pathname, location.search])
  const getReturnPath = useCallback(() => lastMainPathRef.current, [])

  const [previewMode, setPreviewMode] = useState<PreviewMode>("closed")
  /** The right sidebar's state at the moment the preview took it over, so closing
   *  the preview can put it back. `null` = nothing to restore (either no preview
   *  is open, or the user has since overridden us by hand). */
  const rightSnapshot = useRef<boolean | null>(null)

  const toggleLeft = useCallback(() => {
    setLeftOpen((prev) => !prev)
  }, [])

  const toggleRight = useCallback(() => {
    const next = !rightOpen
    // Opening the sidebar by hand while a preview is up: the two are mutually
    // exclusive, so the preview yields. The snapshot dies with it — restoring it
    // later would undo the very action the user just took.
    if (next && previewMode !== "closed") {
      setPreviewMode("closed")
    }
    rightSnapshot.current = null
    setRightOpen(next)
  }, [rightOpen, previewMode])

  const openPreview = useCallback((mainWidth?: number) => {
    if (previewMode !== "closed") return
    rightSnapshot.current = rightOpen
    setRightOpen(false)
    // `mainWidth` is the row that holds chat / preview / sidebar. The sidebar is a
    // child of it, so collapsing the sidebar doesn't change that row's width —
    // what the caller measures now is exactly what chat and preview will share.
    // Unknown width (no measurement yet) ⇒ assume roomy: `half` is the mode that
    // keeps the conversation on screen, so it's the safe default.
    const available = mainWidth ?? Number.POSITIVE_INFINITY
    setPreviewMode(available < NARROW_MAIN_PX ? "full" : "half")
  }, [previewMode, rightOpen])

  const closePreview = useCallback(() => {
    setPreviewMode("closed")
    if (rightSnapshot.current !== null) {
      setRightOpen(rightSnapshot.current)
      rightSnapshot.current = null
    }
  }, [])

  const togglePreviewMaximized = useCallback(() => {
    setPreviewMode((prev) => (prev === "half" ? "full" : prev === "full" ? "half" : prev))
  }, [])

  return (
    <SidebarContext.Provider
      value={{
        leftOpen,
        toggleLeft,
        setLeftOpen,
        rightOpen,
        toggleRight,
        setRightOpen,
        previewMode,
        openPreview,
        closePreview,
        togglePreviewMaximized,
        getReturnPath,
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within SidebarProvider")
  }
  return context
}
