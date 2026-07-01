import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"

interface SidebarContextType {
  leftOpen: boolean
  toggleLeft: () => void
  setLeftOpen: (open: boolean) => void
  rightOpen: boolean
  toggleRight: () => void
  setRightOpen: (open: boolean) => void
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

  const toggleLeft = useCallback(() => {
    setLeftOpen((prev) => !prev)
  }, [])

  const toggleRight = useCallback(() => {
    setRightOpen((prev) => !prev)
  }, [])

  return (
    <SidebarContext.Provider
      value={{ leftOpen, toggleLeft, setLeftOpen, rightOpen, toggleRight, setRightOpen, getReturnPath }}
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
