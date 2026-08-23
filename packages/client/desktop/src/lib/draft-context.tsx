import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { Attachment } from "@/lib/attachments"

/**
 * Composer drafts that survive a route change (discussions/060).
 *
 * WHY A PROVIDER AND NOT sessionStorage: attachments have to survive too, and an
 * attachment is a `data:` URL that can run to megabytes (`attachments.ts` inlines and
 * downscales, but MAX_INLINE_TOTAL_BYTES is 15 MB) — well past the ~5 MB a Storage
 * gives us. Splitting it (text in storage, attachments in memory) would produce the
 * worst state of all: the text comes back and the files silently don't. So one
 * mechanism holds both, in memory, mounted OUTSIDE RouterProvider — which is exactly
 * what makes it immune to the unmount that loses the draft today. The cost is that a
 * full reload drops everything, which is the trade the user asked for ("切页面够用").
 *
 * WHY TWO CONTEXTS: LeftSidebar is permanently mounted and needs the dispatch half
 * (deleting a session drops its bucket). With a single context it would consume the
 * state too and re-render on EVERY KEYSTROKE anywhere in the app. The dispatch value
 * is referentially frozen, so the sidebar subscribes to something that never changes.
 */

export type TaskMode = "single" | "team"

export interface DraftBucket {
  text: string
  attachments: Attachment[]
  /** Home bucket only — the task's birth configuration (018 A-2). */
  mode?: TaskMode
  agentId?: string
  memberIds?: string[]
  /** Home bucket only: has the user edited the member picker? See Home.tsx's default-selection effect. */
  membersTouched?: boolean
}

export const HOME_DRAFT_KEY = "home"
export const sessionDraftKey = (id: string | undefined) => `session:${id ?? ""}`

/**
 * Referentially stable so a consumer with no bucket yet doesn't get a fresh object
 * every render (which would defeat every downstream useMemo keyed on it).
 */
const EMPTY_BUCKET: DraftBucket = Object.freeze({ text: "", attachments: [] as Attachment[] })

/**
 * How many buckets may hold ATTACHMENTS at once.
 *
 * Text is kept forever — a draft is a few KB. Attachments are not: each bucket can hold
 * up to MAX_INLINE_TOTAL_BYTES (15 MB) of base64, and there is one bucket per session,
 * so "keep everything" has no upper bound at all. Evicting the attachments of the
 * least-recently-touched bucket keeps the text (the part users would have to retype)
 * and drops the part they can re-attach in two clicks.
 */
const MAX_ATTACHMENT_BUCKETS = 5

type Buckets = Record<string, DraftBucket>

export interface DraftDispatch {
  /** Merge a partial bucket. Unknown keys are created. */
  patchDraft: (key: string, patch: Partial<DraftBucket>) => void
  /** Wipe a bucket back to empty — use after a draft has actually been SENT. */
  clearDraft: (key: string) => void
  /** Forget a bucket entirely — use when its session is deleted. */
  dropDraft: (key: string) => void
}

const DraftStateContext = createContext<Buckets | null>(null)
const DraftDispatchContext = createContext<DraftDispatch | null>(null)

export function DraftProvider({ children }: { children: ReactNode }) {
  const [buckets, setBuckets] = useState<Buckets>({})
  /** Most-recently-touched first. Only consulted for attachment eviction. */
  const order = useRef<string[]>([])

  const patchDraft = useCallback((key: string, patch: Partial<DraftBucket>) => {
    setBuckets((prev) => {
      const next: Buckets = { ...prev, [key]: { ...(prev[key] ?? EMPTY_BUCKET), ...patch } }

      order.current = [key, ...order.current.filter((k) => k !== key)]

      // Evict attachments (never text) from buckets past the cap, oldest first.
      const withFiles = order.current.filter((k) => (next[k]?.attachments.length ?? 0) > 0)
      for (const stale of withFiles.slice(MAX_ATTACHMENT_BUCKETS)) {
        next[stale] = { ...next[stale], attachments: [] }
      }
      return next
    })
  }, [])

  const clearDraft = useCallback((key: string) => {
    setBuckets((prev) => (prev[key] ? { ...prev, [key]: EMPTY_BUCKET } : prev))
  }, [])

  const dropDraft = useCallback((key: string) => {
    order.current = order.current.filter((k) => k !== key)
    setBuckets((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }, [])

  // Frozen for the lifetime of the app — this is what keeps the sidebar out of the
  // keystroke re-render path.
  const dispatch = useMemo(
    () => ({ patchDraft, clearDraft, dropDraft }),
    [patchDraft, clearDraft, dropDraft],
  )

  return (
    <DraftDispatchContext.Provider value={dispatch}>
      <DraftStateContext.Provider value={buckets}>{children}</DraftStateContext.Provider>
    </DraftDispatchContext.Provider>
  )
}

/** The bucket for `key`, or a stable empty one. */
export function useDraftBucket(key: string): DraftBucket {
  const buckets = useContext(DraftStateContext)
  if (!buckets) throw new Error("useDraftBucket must be used within DraftProvider")
  return buckets[key] ?? EMPTY_BUCKET
}

export function useDraftDispatch(): DraftDispatch {
  const dispatch = useContext(DraftDispatchContext)
  if (!dispatch) throw new Error("useDraftDispatch must be used within DraftProvider")
  return dispatch
}
