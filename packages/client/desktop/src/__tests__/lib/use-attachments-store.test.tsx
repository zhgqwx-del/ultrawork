/**
 * useAttachments with an external store (discussions/060).
 *
 * `itemsRef` is the hook's synchronous authority for the caps AND the base `remove()`
 * filters from — so a ref that has drifted from the store it is supposed to mirror does
 * not just miscount, it can write one composer's list into another's bucket. SessionPage
 * is never remounted across a :id change, which is exactly when that drift happens.
 */
import { describe, it, expect, vi } from "vitest"
import { renderHook, act } from "@testing-library/react"
import type { Attachment } from "@/lib/attachments"

vi.mock("@/lib/use-api", () => ({ useApi: () => ({ getProviders: async () => [] }) }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))

import { useAttachments, type AttachmentStore } from "@/lib/use-attachments"

// `text` kind on purpose: it needs no capability gate, so nothing here depends on a
// provider fetch resolving.
const file = (id: string): Attachment => ({
  id,
  kind: "text",
  mime: "text/plain",
  filename: `${id}.txt`,
  wireUrl: "data:text/plain;base64,AAAA",
  size: 4,
})

describe("useAttachments external store", () => {
  it("re-seeds its bookkeeping when the composer switches buckets without remounting", () => {
    const writes: Record<string, Attachment[]> = {}
    const storeFor = (key: string, items: Attachment[]): AttachmentStore => ({
      key,
      items,
      setItems: (next) => {
        writes[key] = next
      },
    })

    const { result, rerender } = renderHook(
      ({ store }: { store: AttachmentStore }) => useAttachments("openai/gpt-5", store),
      { initialProps: { store: storeFor("session:A", [file("a1"), file("a2")]) } },
    )
    // Measured something: the hook really is reading the store.
    expect(result.current.items.map((a) => a.id)).toEqual(["a1", "a2"])

    // Same hook instance, different bucket — this is a :id change in SessionPage.
    rerender({ store: storeFor("session:B", [file("b1")]) })
    expect(result.current.items.map((a) => a.id)).toEqual(["b1"])

    // remove() filters from the ref. With a stale ref this writes A's files into B.
    act(() => result.current.remove("b1"))
    expect(writes["session:B"]).toEqual([])
    expect(writes["session:A"]).toBeUndefined()
  })

  it("keeps the bucket's contents when the hook is re-created (remount on the same bucket)", () => {
    const items = [file("a1"), file("a2"), file("a3")]
    const writes: Attachment[][] = []
    const store: AttachmentStore = { key: "home", items, setItems: (n) => writes.push(n) }

    // A fresh hook over a bucket that already holds files — Home after coming back from
    // another page. Seeding the ref from [] here would let 10 more files in on top.
    const { result } = renderHook(() => useAttachments("openai/gpt-5", store))
    expect(result.current.items).toHaveLength(3)

    act(() => result.current.remove("a2"))
    expect(writes.at(-1)!.map((a) => a.id)).toEqual(["a1", "a3"])
  })
})
