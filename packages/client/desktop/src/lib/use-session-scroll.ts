import { useRef, useEffect, useCallback, useState } from "react"

const BOTTOM_THRESHOLD = 100  // px from bottom to consider "at bottom"
const TOP_THRESHOLD = 200     // px from top to trigger backfill
const AUTO_MARK_TTL = 1500    // ms to consider a scroll event as programmatic

interface UseSessionScrollOptions {
  /** Ref to the scroll container element */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  /** Ref to the content wrapper (observed for resize) */
  contentRef: React.RefObject<HTMLDivElement | null>
  /** Called when user scrolls near the top */
  onScrollNearTop: () => void
  /** Session ID — scroll state resets on change */
  sessionId: string | undefined
  /** Messages array reference — triggers auto-scroll when content changes */
  messages: unknown[]
}

export function useSessionScroll({
  scrollContainerRef,
  contentRef,
  onScrollNearTop,
  sessionId,
  messages,
}: UseSessionScrollOptions) {
  const [userScrolled, setUserScrolled] = useState(false)
  // Ref mirror of userScrolled — used by effects and callbacks to read
  // the latest value without stale closure issues
  const userScrolledRef = useRef(false)

  const setUserScrolledBoth = useCallback((value: boolean) => {
    userScrolledRef.current = value
    setUserScrolled(value)
  }, [])

  // --- markAuto/isAuto: distinguish programmatic scroll from user scroll ---
  const autoScrollMark = useRef<{ top: number; time: number } | null>(null)

  const markAuto = useCallback((el: HTMLElement) => {
    autoScrollMark.current = {
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      time: Date.now(),
    }
  }, [])

  const isAutoScroll = useCallback((el: HTMLElement) => {
    const mark = autoScrollMark.current
    if (!mark) return false
    if (Date.now() - mark.time > AUTO_MARK_TTL) {
      autoScrollMark.current = null
      return false
    }
    return Math.abs(el.scrollTop - mark.top) < 2
  }, [])

  // --- Raw scroll-to-bottom (no state dependency, uses ref) ---
  const doScrollToBottom = useCallback(() => {
    const el = scrollContainerRef.current
    if (!el) return
    markAuto(el)
    el.scrollTop = el.scrollHeight
  }, [scrollContainerRef, markAuto])

  // --- Public scroll to bottom ---
  const scrollToBottom = useCallback((force = false) => {
    if (!force && userScrolledRef.current) return
    if (force && userScrolledRef.current) setUserScrolledBoth(false)
    doScrollToBottom()
  }, [doScrollToBottom, setUserScrolledBoth])

  // --- Reset on session change ---
  useEffect(() => {
    setUserScrolledBoth(false)
    autoScrollMark.current = null
  }, [sessionId, setUserScrolledBoth])

  // --- Near-top detection (backfill trigger) ---
  const scrollNearTopFiredRef = useRef(false)

  // --- Scroll + wheel event listeners ---
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const handleWheel = (e: WheelEvent) => {
      // Only mark as user scroll when scrolling UP
      if (e.deltaY < 0) {
        setUserScrolledBoth(true)
      }
    }

    const handleScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop

      // Near bottom: resume auto-scroll
      if (distanceFromBottom < BOTTOM_THRESHOLD) {
        if (userScrolledRef.current) setUserScrolledBoth(false)
        return
      }

      // Ignore scroll events triggered by our own scrollToBottom
      if (!userScrolledRef.current && isAutoScroll(el)) {
        return
      }

      // Near top: trigger backfill (fire once per entry)
      if (el.scrollTop < TOP_THRESHOLD) {
        if (!scrollNearTopFiredRef.current) {
          scrollNearTopFiredRef.current = true
          onScrollNearTop()
        }
      } else {
        scrollNearTopFiredRef.current = false
      }
    }

    el.addEventListener("wheel", handleWheel, { passive: true })
    el.addEventListener("scroll", handleScroll, { passive: true })
    return () => {
      el.removeEventListener("wheel", handleWheel)
      el.removeEventListener("scroll", handleScroll)
    }
  }, [scrollContainerRef, isAutoScroll, onScrollNearTop, setUserScrolledBoth])

  // --- Auto-scroll on message changes (initial load, new messages, streaming updates) ---
  // `messages` reference changes on every SSE update (array is rebuilt).
  // requestAnimationFrame coalesces rapid updates to 1 scroll per frame.
  useEffect(() => {
    if (userScrolledRef.current) return
    requestAnimationFrame(() => {
      if (!userScrolledRef.current) doScrollToBottom()
    })
  }, [messages, doScrollToBottom])

  // --- Settle scroll after session load ---
  // content-visibility: auto elements may report estimated heights during initial
  // layout, then adjust to real heights asynchronously. This causes scrollHeight
  // to shift after the first scroll-to-bottom. Re-scroll after a short delay to
  // catch the settled layout.
  useEffect(() => {
    if (!sessionId) return
    const timers = [
      setTimeout(() => { if (!userScrolledRef.current) doScrollToBottom() }, 100),
      setTimeout(() => { if (!userScrolledRef.current) doScrollToBottom() }, 300),
    ]
    return () => timers.forEach(clearTimeout)
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- ResizeObserver: auto-scroll on content growth (streaming text within a message) ---
  useEffect(() => {
    const content = contentRef.current
    if (!content) return

    const observer = new ResizeObserver(() => {
      if (!userScrolledRef.current) {
        doScrollToBottom()
      }
    })
    observer.observe(content)
    return () => observer.disconnect()
  }, [contentRef, doScrollToBottom])

  // --- overflow-anchor: dynamic toggle ---
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.style.overflowAnchor = userScrolled ? "auto" : "none"
  }, [scrollContainerRef, userScrolled])

  return {
    userScrolled,
    scrollToBottom,
  }
}
