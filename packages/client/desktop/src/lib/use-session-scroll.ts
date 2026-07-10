import { useCallback, useEffect, useRef, useState } from "react"
import { useStickToBottom } from "use-stick-to-bottom"

const TOP_THRESHOLD = 200 // px from top to trigger backfill

interface UseSessionScrollOptions {
  /** Called when the user scrolls near the top (history backfill) */
  onScrollNearTop: () => void
  /** Session ID — scroll state resets on change */
  sessionId: string | undefined
}

/**
 * Stick-to-bottom for the session transcript.
 *
 * Two non-obvious constraints this hook depends on, both measured (ADR-047):
 *
 * 1. The element `contentRef` lands on MUST NOT be a stretched flex item. A flex
 *    item's cross size is the flex line's, so it stays pinned at the container's
 *    inner height no matter how tall its children grow — its ResizeObserver then
 *    fires exactly once, at mount, and never again. Auto-scroll silently degrades
 *    to "only works while a spring animation happens to still be running", and any
 *    async growth after that (image, font, code block, tool result) strands the
 *    view thousands of px above the bottom. Session.tsx therefore gives the scroll
 *    container `display: block` and centres the column with `mx-auto`.
 *
 * 2. Nothing inside the transcript may carry `content-visibility: auto`. A skipped
 *    subtree reports its `contain-intrinsic-size` instead of its real height, so
 *    `scrollHeight` under-reports and the "bottom" we scroll to is not the bottom.
 *    Worse, the resulting scrollTop clamp reads as a user scroll-up and silently
 *    escapes the lock.
 *
 * Everything else — position-based escape detection (a scrollbar drag or PageUp
 * emits no wheel event), text-selection guarding, spring-chasing a target that is
 * still growing — comes from use-stick-to-bottom.
 */
export function useSessionScroll({ onScrollNearTop, sessionId }: UseSessionScrollOptions) {
  // `resize` stays on the library's spring. Forcing it to "instant" makes the hook
  // write scrollTop on every growth frame, which overwrites a scroll the user just
  // performed — they physically cannot drag away from the bottom mid-stream.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom, escapedFromLock } = useStickToBottom({
    initial: "instant",
  })

  // `scrollRef` is a ref callback; mirror the element into state so the backfill
  // listener below can re-attach if the node ever changes.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const attachScrollRef = useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef(el)
      setScrollEl(el)
    },
    [scrollRef],
  )

  // --- Reset on session change: land at the bottom instantly, drop any escape ---
  useEffect(() => {
    if (!sessionId) return
    scrollToBottom({ animation: "instant", ignoreEscapes: true })
  }, [sessionId, scrollToBottom])

  // --- Near-top detection (history backfill), fires once per entry into the zone ---
  const firedRef = useRef(false)
  const onNearTopRef = useRef(onScrollNearTop)
  onNearTopRef.current = onScrollNearTop

  useEffect(() => {
    if (!scrollEl) return
    const handle = () => {
      if (scrollEl.scrollTop < TOP_THRESHOLD) {
        if (!firedRef.current) {
          firedRef.current = true
          onNearTopRef.current()
        }
      } else {
        firedRef.current = false
      }
    }
    scrollEl.addEventListener("scroll", handle, { passive: true })
    return () => scrollEl.removeEventListener("scroll", handle)
  }, [scrollEl])

  /** Force the view to the bottom, overriding a user scroll-up (used on send). */
  const forceScrollToBottom = useCallback(() => {
    scrollToBottom({ animation: "instant", ignoreEscapes: true })
  }, [scrollToBottom])

  /** The "jump to bottom" affordance: smooth, and it re-arms the lock. */
  const jumpToBottom = useCallback(() => {
    scrollToBottom({ ignoreEscapes: true })
  }, [scrollToBottom])

  return {
    scrollRef: attachScrollRef,
    contentRef,
    /** Whether the transcript is pinned to the bottom right now. */
    isAtBottom,
    /** The user deliberately scrolled away from the bottom. */
    escapedFromLock,
    forceScrollToBottom,
    jumpToBottom,
  }
}
