import { createContext, useCallback, useContext, useState, type ReactNode } from "react"

interface SidebarContextType {
  leftOpen: boolean
  toggleLeft: () => void
  setLeftOpen: (open: boolean) => void
  rightOpen: boolean
  toggleRight: () => void
  setRightOpen: (open: boolean) => void
}

const SidebarContext = createContext<SidebarContextType | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(false)

  const toggleLeft = useCallback(() => {
    setLeftOpen((prev) => !prev)
  }, [])

  const toggleRight = useCallback(() => {
    setRightOpen((prev) => !prev)
  }, [])

  return (
    <SidebarContext.Provider value={{ leftOpen, toggleLeft, setLeftOpen, rightOpen, toggleRight, setRightOpen }}>
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
