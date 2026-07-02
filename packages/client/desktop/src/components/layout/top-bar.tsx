import { cn } from "@/lib/utils"
import { PanelLeft, ChevronLeft, ChevronRight, X } from "lucide-react"
import { useSidebar } from "./sidebar-context"
import { handleDrag } from "./drag-region"
import type { ReactNode } from "react"

interface TopBarProps {
  title?: string
  onClose?: () => void
  /** Show a back button on the left (e.g. on Settings, so you can dismiss
   *  without reaching for the top-right close button). */
  onBack?: () => void
  showBackForward?: boolean
  /** Hide the sidebar collapse toggle (e.g. on Settings, where the sidebar is
   *  route-locked collapsed and toggling it would only affect after you leave). */
  hideSidebarToggle?: boolean
  children?: ReactNode
  className?: string
}

export function TopBar({ title, onClose, onBack, showBackForward, hideSidebarToggle, children, className }: TopBarProps) {
  const { toggleLeft } = useSidebar()

  return (
    <header
      onMouseDown={handleDrag}
      className={cn(
        "z-10 flex h-12 shrink-0 items-center gap-2 px-4",
        className
      )}
    >
      {/* Left: sidebar toggle + optional back/forward */}
      <div className="flex items-center gap-1">
        {onBack && (
          <button
            onClick={onBack}
            aria-label="Back"
            className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <ChevronLeft className="size-4" />
          </button>
        )}

        {!hideSidebarToggle && (
          <button
            onClick={toggleLeft}
            aria-label="Toggle sidebar"
            className="flex size-8 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <PanelLeft className="size-4" />
          </button>
        )}

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
