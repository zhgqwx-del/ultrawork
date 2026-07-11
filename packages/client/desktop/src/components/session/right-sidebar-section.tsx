import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { UnreadBadge } from "@/components/ui/unread-badge"

/**
 * One collapsible section of the session's right sidebar.
 *
 * Lifted out of Session.tsx so the awareness rules it encodes (ADR-048 D1) —
 * auto-open, badge suppression, "a hand-collapse wins" — can be tested on their
 * own instead of only through the whole page.
 */
export function RightSidebarSection({
  title,
  placeholder,
  children,
  defaultOpen = false,
  autoOpen = false,
  badge = 0,
  onOpen,
}: {
  title: string
  placeholder?: string
  children?: React.ReactNode
  defaultOpen?: boolean
  /**
   * Open the section when this becomes true — even if it mounted closed.
   *
   * `defaultOpen` alone is not enough for artifacts, and the gap is exactly the
   * blindness ADR-048 set out to kill: a plan usually lands BEFORE any file is
   * written, so the plan auto-reveal opens the sidebar at a moment when there are
   * zero artifacts. `useState(defaultOpen)` reads its argument once, so the
   * Artifacts section would mount collapsed and stay collapsed for the whole turn,
   * however many files the agent then produced.
   *
   * A hand-collapse still wins: once the user closes the section themselves, we
   * stop re-opening it.
   */
  autoOpen?: boolean
  /** Unread count shown next to the title; suppressed while the section is open. */
  badge?: number
  /** Fired when the section becomes visible (mounted-open or expanded by the
   *  user) — that's when its contents count as seen. */
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [userCollapsed, setUserCollapsed] = useState(false)

  useEffect(() => {
    if (autoOpen && !userCollapsed) setOpen(true)
  }, [autoOpen, userCollapsed])

  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  // Also fires when the count moves while the section is already open: those
  // artifacts are on screen, so they're seen — otherwise the badge would come
  // back the moment the user collapsed the sidebar.
  useEffect(() => {
    if (open) onOpenRef.current?.()
  }, [open, badge])

  const toggle = () => {
    setOpen((prev) => {
      if (prev) setUserCollapsed(true)
      return !prev
    })
  }

  return (
    <div className="border-b border-[var(--color-border)] last:border-b-0">
      <button
        onClick={toggle}
        className="flex w-full items-center gap-2 py-3 text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-fg)]"
      >
        {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        {title}
        {!open && <UnreadBadge count={badge} />}
      </button>
      {open && (
        <div className="pb-3 text-xs text-[var(--color-fg-muted)]">
          {children || placeholder}
        </div>
      )}
    </div>
  )
}
