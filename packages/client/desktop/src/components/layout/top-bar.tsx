import { cn } from "@/lib/utils"
import { PanelLeft, ChevronLeft, ChevronRight, X } from "lucide-react"
import { useSidebar } from "./sidebar-context"
import type { ReactNode } from "react"

interface TopBarProps {
  title?: string
  onClose?: () => void
  showBackForward?: boolean
  children?: ReactNode
  className?: string
}

export function TopBar({ title, onClose, showBackForward, children, className }: TopBarProps) {
  const { toggleLeft } = useSidebar()

  return (
    <header
      className={cn(
        "z-10 flex h-12 shrink-0 items-center gap-2 px-4",
        className
      )}
    >
      {/* Left: sidebar toggle + optional back/forward */}
      <div className="flex items-center gap-1">
        <button
          onClick={toggleLeft}
          aria-label="Toggle sidebar"
          className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
        >
          <PanelLeft className="size-4" />
        </button>

        {showBackForward && (
          <>
            <button
              disabled
              aria-label="Go back"
              className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] opacity-40"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              disabled
              aria-label="Go forward"
              className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] opacity-40"
            >
              <ChevronRight className="size-4" />
            </button>
          </>
        )}
      </div>

      {/* Center: title */}
      {title && (
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <h1 className="truncate text-sm font-medium text-[var(--color-fg)]">{title}</h1>
        </div>
      )}
      {!title && <div className="flex-1" />}

      {/* Right: actions */}
      <div className="flex items-center gap-1">
        {children}
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </header>
  )
}
