import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))

// Mock sonner toast
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { useChannels } from "@/lib/use-channels"
import { toast } from "sonner"

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal("fetch", mockFetch)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function mockFetchOk(data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status,
    text: () => Promise.resolve(JSON.stringify(data)),
  })
}

function mockFetchError(status = 500, body = "Server Error") {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  })
}

describe("useChannels", () => {
  describe("initial fetch", () => {
    it("fetches channels on mount", async () => {
      mockFetchOk({ channels: [], configs: [] })
      const { result } = renderHook(() => useChannels())

      expect(result.current.loading).toBe(true)

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.channels).toEqual([])
      expect(result.current.configs).toEqual([])
      expect(result.current.error).toBe(false)
    })

    it("sets error on fetch failure", async () => {
      mockFetchError()
      const { result } = renderHook(() => useChannels())

      await waitFor(() => {
        expect(result.current.loading).toBe(false)
      })

      expect(result.current.error).toBe(true)
    })

    it("populates channels and configs from response", async () => {
      const data = {
        channels: [{ id: "ch_1", type: "dingtalk", name: "Test", state: "connected" }],
        configs: [{ id: "ch_1", type: "dingtalk", name: "Test", clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: true }],
      }
      mockFetchOk(data)
      const { result } = renderHook(() => useChannels())

      await waitFor(() => {
        expect(result.current.channels).toHaveLength(1)
      })

      expect(result.current.channels[0].state).toBe("connected")
      expect(result.current.configs[0].clientId).toBe("c")
    })
  })

  describe("handleAdd", () => {
    it("adds a channel and refreshes", async () => {
      // Initial fetch
      mockFetchOk({ channels: [], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      // Add channel POST
      mockFetchOk({ id: "ch_new", name: "New" }, 201)
      // Refresh GET
      mockFetchOk({
        channels: [{ id: "ch_new", type: "dingtalk", name: "New", state: "connected" }],
        configs: [{ id: "ch_new", type: "dingtalk", name: "New", clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: true }],
      })

      await act(async () => {
        await result.current.handleAdd({
          type: "dingtalk",
          name: "New",
          clientId: "c",
          clientSecret: "s",
          workspaceDir: "/w",
          autoConnect: true,
        })
      })

      expect(result.current.channels).toHaveLength(1)
      expect(result.current.channels[0].name).toBe("New")
    })

    it("sets actionLoading to __add__ during add", async () => {
      mockFetchOk({ channels: [], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      let resolvePost: (v: any) => void
      mockFetch.mockReturnValueOnce(
        new Promise((r) => { resolvePost = r }),
      )

      let addPromise: Promise<void>
      act(() => {
        addPromise = result.current.handleAdd({
          type: "dingtalk", name: "X", clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: true,
        })
      })

      expect(result.current.actionLoading).toBe("__add__")

      // Resolve post
      resolvePost!({ ok: true, status: 201, text: () => Promise.resolve('{"id":"ch_1"}') })
      // Need refresh response
      mockFetchOk({ channels: [], configs: [] })

      await act(async () => { await addPromise! })
      expect(result.current.actionLoading).toBeNull()
    })

    it("shows toast error on add failure and re-throws", async () => {
      mockFetchOk({ channels: [], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockFetchError(400, "bad request")

      let threw = false
      try {
        await act(async () => {
          await result.current.handleAdd({
            type: "dingtalk", name: "X", clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: true,
          })
        })
      } catch {
        threw = true
      }

      expect(threw).toBe(true)
      expect(toast.error).toHaveBeenCalledWith("channel.error.add")
      expect(result.current.actionLoading).toBeNull()
    })
  })

  describe("handleRemove", () => {
    it("removes channel optimistically", async () => {
      mockFetchOk({
        channels: [{ id: "ch_1", type: "dingtalk", name: "T", state: "disconnected" }],
        configs: [{ id: "ch_1", type: "dingtalk", name: "T", clientId: "c", clientSecret: "s", workspaceDir: "/w", autoConnect: false }],
      })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.channels).toHaveLength(1))

      // DELETE response
      mockFetchOk({ ok: true })

      await act(async () => {
        await result.current.handleRemove("ch_1")
      })

      expect(result.current.channels).toHaveLength(0)
      expect(result.current.configs).toHaveLength(0)
    })

    it("shows toast on remove failure", async () => {
      mockFetchOk({ channels: [{ id: "ch_1", state: "disconnected" }], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockFetchError(404)

      await act(async () => {
        await result.current.handleRemove("ch_1")
      })

      expect(toast.error).toHaveBeenCalledWith("channel.error.remove")
    })
  })

  describe("handleConnect", () => {
    it("updates channel status on connect", async () => {
      mockFetchOk({
        channels: [{ id: "ch_1", type: "dingtalk", name: "T", state: "disconnected" }],
        configs: [],
      })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.channels).toHaveLength(1))

      mockFetchOk({ id: "ch_1", type: "dingtalk", name: "T", state: "connected" })

      await act(async () => {
        await result.current.handleConnect("ch_1")
      })

      expect(result.current.channels[0].state).toBe("connected")
    })

    it("shows toast on connect failure", async () => {
      mockFetchOk({ channels: [{ id: "ch_1", state: "disconnected" }], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockFetchError(500)

      await act(async () => {
        await result.current.handleConnect("ch_1")
      })

      expect(toast.error).toHaveBeenCalledWith("channel.error.connect")
    })
  })

  describe("handleDisconnect", () => {
    it("updates channel status on disconnect", async () => {
      mockFetchOk({
        channels: [{ id: "ch_1", type: "dingtalk", name: "T", state: "connected" }],
        configs: [],
      })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.channels).toHaveLength(1))

      mockFetchOk({ id: "ch_1", type: "dingtalk", name: "T", state: "disconnected" })

      await act(async () => {
        await result.current.handleDisconnect("ch_1")
      })

      expect(result.current.channels[0].state).toBe("disconnected")
    })

    it("shows toast on disconnect failure", async () => {
      mockFetchOk({ channels: [{ id: "ch_1", state: "connected" }], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockFetchError(500)

      await act(async () => {
        await result.current.handleDisconnect("ch_1")
      })

      expect(toast.error).toHaveBeenCalledWith("channel.error.disconnect")
    })
  })

  describe("refresh", () => {
    it("re-fetches channel data", async () => {
      mockFetchOk({ channels: [], configs: [] })
      const { result } = renderHook(() => useChannels())
      await waitFor(() => expect(result.current.loading).toBe(false))

      mockFetchOk({
        channels: [{ id: "ch_1", type: "dingtalk", name: "New", state: "connected" }],
        configs: [],
      })

      await act(async () => {
        await result.current.refresh()
      })

      expect(result.current.channels).toHaveLength(1)
      expect(result.current.error).toBe(false)
    })
  })
})
