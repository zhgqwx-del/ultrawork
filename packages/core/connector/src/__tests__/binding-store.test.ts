import { describe, it, expect, vi } from "vitest"
import { BindingStore, type BindingCache } from "../binding-store"
import { OPENCODE_DEFAULT_AGENT_ID } from "../types"

function memoryCache(initial: Record<string, string> = {}): BindingCache & { data: Record<string, string> } {
  const holder = {
    data: { ...initial },
    load: () => holder.data,
    save: (bindings: Record<string, string>) => {
      holder.data = bindings
    },
  }
  return holder
}

describe("BindingStore", () => {
  it("loads initial bindings from the injected cache", () => {
    const store = new BindingStore({ cache: memoryCache({ s1: "acp:claude" }) })
    expect(store.get("s1")).toBe("acp:claude")
  })

  it("falls back to the default agent for unbound/undefined sessions", () => {
    const store = new BindingStore()
    expect(store.get("nope")).toBe(OPENCODE_DEFAULT_AGENT_ID)
    expect(store.get(undefined)).toBe(OPENCODE_DEFAULT_AGENT_ID)
    expect(store.backendOf("nope")).toBe("opencode")
    expect(store.rawAgentIdOf("nope")).toBe("default")
  })

  it("bind persists to cache; binding to default removes the entry (legacy semantics)", () => {
    const cache = memoryCache()
    const store = new BindingStore({ cache })

    store.bind("s1", "acp:claude")
    expect(cache.data).toEqual({ s1: "acp:claude" })
    expect(store.backendOf("s1")).toBe("acp")
    expect(store.rawAgentIdOf("s1")).toBe("claude")

    store.bind("s1", OPENCODE_DEFAULT_AGENT_ID)
    expect(cache.data).toEqual({})
    expect(store.get("s1")).toBe(OPENCODE_DEFAULT_AGENT_ID)
  })

  it("remove deletes the binding and persists", () => {
    const cache = memoryCache({ s1: "acp:claude" })
    const store = new BindingStore({ cache })
    store.remove("s1")
    expect(cache.data).toEqual({})
  })

  it("survives a throwing cache without losing in-memory state", () => {
    const store = new BindingStore({
      cache: {
        load: () => {
          throw new Error("corrupt")
        },
        save: () => {
          throw new Error("quota")
        },
      },
    })
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    store.bind("s1", "acp:claude")
    expect(store.get("s1")).toBe("acp:claude")
    errSpy.mockRestore()
  })

  describe("hydrate (sidecar is source of truth)", () => {
    it("sidecar entries override cache entries", () => {
      const cache = memoryCache({ s1: "acp:old" })
      const store = new BindingStore({ cache })
      store.hydrate([{ sessionId: "s1", agentId: "acp:claude" }])
      expect(store.get("s1")).toBe("acp:claude")
      expect(cache.data["s1"]).toBe("acp:claude")
    })

    it("keeps cache-only entries (bind-before-first-prompt window)", () => {
      const store = new BindingStore({ cache: memoryCache({ fresh: "acp:gemini" }) })
      store.hydrate([{ sessionId: "s1", agentId: "acp:claude" }])
      expect(store.get("fresh")).toBe("acp:gemini")
      expect(store.get("s1")).toBe("acp:claude")
    })

    it("skips keys mutated locally after construction (race guard)", () => {
      const store = new BindingStore({ cache: memoryCache() })
      store.bind("s1", "acp:qoder")
      store.remove("s2")
      store.hydrate([
        { sessionId: "s1", agentId: "acp:claude" },
        { sessionId: "s2", agentId: "acp:claude" },
        { sessionId: "s3", agentId: "acp:gemini" },
      ])
      expect(store.get("s1")).toBe("acp:qoder") // local bind wins
      expect(store.get("s2")).toBe(OPENCODE_DEFAULT_AGENT_ID) // local remove wins
      expect(store.get("s3")).toBe("acp:gemini") // untouched key hydrates
    })

    it("works without any cache (gateway)", () => {
      const store = new BindingStore()
      store.hydrate([{ sessionId: "s1", agentId: "acp:claude" }])
      expect(store.get("s1")).toBe("acp:claude")
    })
  })

  describe("onChange", () => {
    it("notifies on bind/remove/hydrate changes, not on no-ops", () => {
      const store = new BindingStore()
      const cb = vi.fn()
      store.onChange(cb)

      store.bind("s1", "acp:claude")
      expect(cb).toHaveBeenCalledTimes(1)

      store.remove("s1")
      expect(cb).toHaveBeenCalledTimes(2)

      store.remove("never-bound")
      expect(cb).toHaveBeenCalledTimes(2)

      store.hydrate([{ sessionId: "s9", agentId: "acp:claude" }])
      expect(cb).toHaveBeenCalledTimes(3)

      store.hydrate([{ sessionId: "s9", agentId: "acp:claude" }]) // identical -> no change
      expect(cb).toHaveBeenCalledTimes(3)

      const snap = store.snapshot()
      expect(snap).toEqual({ s9: "acp:claude" })
    })
  })
})
