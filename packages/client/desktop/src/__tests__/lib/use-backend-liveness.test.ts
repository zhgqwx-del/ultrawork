// The banner tells the user either "retrying" or "restart the app", and only one
// of those is true at a time. Getting it wrong is worse than not saying it:
// telling someone to restart when the backend is fine, or telling them to wait
// for a process that will never come back.
//
// So the judgement is narrow on purpose, and these tests pin the narrowness —
// especially the cases that must NOT be read as "the process died".

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"

const cfg = vi.hoisted(() => ({
  value: { apiBaseUrl: "auto", apiUsername: "opencode", apiPassword: "pw" } as Record<string, string>,
}))
vi.mock("@/lib/config-context", () => ({ useConfig: () => ({ config: cfg.value }) }))
vi.mock("@/lib/config", () => ({ resolveApiBaseUrl: () => "http://127.0.0.1:4096" }))

import { probeBackend, useBackendLiveness } from "@/lib/use-backend-liveness"

const URL = "http://127.0.0.1:4096"
const HEADERS = { authorization: "Basic x" }

function responding(status: number) {
  return vi.fn(async () => new Response("", { status })) as unknown as typeof fetch
}
function refusing() {
  return vi.fn(async () => {
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}
/**
 * What a rejected password ACTUALLY looks like from the renderer, measured in
 * real Chrome (gotchas §20⑭): opencode's 401 carries no CORS header, so the
 * readable request throws — while a `no-cors` request still comes back opaque,
 * because the socket did answer.
 */
function corsBlockedGetButSocketAlive() {
  return vi.fn(async (_url: unknown, init?: { mode?: string }) => {
    if (init?.mode === "no-cors") return new Response("", { status: 200 })
    throw new TypeError("Failed to fetch")
  }) as unknown as typeof fetch
}
/** Never settles until aborted — a wedged server that holds the socket open. */
function hanging() {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))
    })
  }) as unknown as typeof fetch
}

beforeEach(() => vi.useRealTimers())

describe("probeBackend", () => {
  it("reads an outright connection failure as an absent process", async () => {
    expect(await probeBackend(URL, HEADERS, refusing())).toBe("absent")
  })

  it("reads a 200 as listening", async () => {
    expect(await probeBackend(URL, HEADERS, responding(200))).toBe("listening")
  })

  it("reads 401 as UNAUTHORIZED — alive, but rejecting our credentials", async () => {
    // Emphatically not a dead backend: telling the user to restart would send
    // them chasing the wrong thing. It gets its own verdict rather than being
    // folded into "listening" because it has its own cure (useCredentialResync).
    expect(await probeBackend(URL, HEADERS, responding(401))).toBe("unauthorized")
  })

  it("reads 403 the same way", async () => {
    expect(await probeBackend(URL, HEADERS, responding(403))).toBe("unauthorized")
  })

  it("reads 500 as listening — a broken server is still a running one", async () => {
    expect(await probeBackend(URL, HEADERS, responding(500))).toBe("listening")
  })

  it("reads a hung backend as UNKNOWN, never as absent", async () => {
    // A wedged single-threaded opencode holds the socket without answering. The
    // port IS open; claiming the process died would be a fabrication.
    expect(await probeBackend(URL, HEADERS, hanging())).toBe("unknown")
  }, 10_000)

  it("reads a CORS-blocked GET with a live socket as UNAUTHORIZED, not absent", async () => {
    // The real-machine failure this fixes: a stale password made the banner say
    // "the service exited, restart the app" — advice that cannot help, because
    // the bad credential lives in localStorage and survives the restart. And the
    // credential re-sync never fired, because it waits for `unauthorized`.
    expect(await probeBackend(URL, HEADERS, corsBlockedGetButSocketAlive())).toBe("unauthorized")
  })

  it("still calls a truly dead port absent — the no-cors probe fails there too", async () => {
    expect(await probeBackend(URL, HEADERS, refusing())).toBe("absent")
  })

  it("sends the fallback as no-cors, with no credentials", async () => {
    // no-cors keeps it a SIMPLE request — no preflight to be refused, and no
    // Authorization header to earn another 401.
    const f = corsBlockedGetButSocketAlive()
    await probeBackend(URL, HEADERS, f)
    const calls = (f as unknown as ReturnType<typeof vi.fn>).mock.calls
    const fallback = calls.find((c) => c[1]?.mode === "no-cors")
    expect(fallback).toBeDefined()
    expect(fallback![1].headers).toBeUndefined()
    expect(fallback![1].method).toBeUndefined()
  })

  it("never throws, whatever fetch does", async () => {
    const exploding = vi.fn(async () => {
      throw new Error("something entirely unexpected")
    }) as unknown as typeof fetch
    await expect(probeBackend(URL, HEADERS, exploding)).resolves.toBe("absent")
  })

  it("sends credentials — an unauthenticated probe would 401 on a healthy server", async () => {
    const f = responding(200)
    await probeBackend(URL, HEADERS, f)
    const init = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(init.headers).toMatchObject({ authorization: "Basic x" })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe("useBackendLiveness — the probe loop itself", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    cfg.value = { apiBaseUrl: "auto", apiUsername: "opencode", apiPassword: "pw" }
    fetchMock = vi.fn(async () => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("survives credentials btoa cannot encode", async () => {
    // Settings lets the user type anything into username/password. A non-Latin1
    // value makes btoa throw, and building the header OUTSIDE the probe's
    // try/catch turned that into an unhandled rejection that killed the loop for
    // good — the banner would then never learn anything again.
    cfg.value = { ...cfg.value, apiUsername: "用户" }
    const { result } = renderHook(() => useBackendLiveness(true))
    await waitFor(() => expect(result.current).not.toBe("unknown"))
    // Any verdict is fine; silently dying is not.
    expect(["listening", "absent", "unauthorized"]).toContain(result.current)
  })

  it("runs ONE loop, not one per config change", async () => {
    // The cancel flag used to live in a ref shared across effect runs: the new
    // run reset it to false before the old run's await resumed, so the old run
    // never learned it had been cancelled and scheduled its own next tick — a
    // timer the (already-finished) cleanup could no longer clear. Every config
    // change made while a probe was IN FLIGHT leaked another loop.
    //
    // Two things are needed to see it, and missing either hides the bug:
    //   · the probe must still be in flight when the config changes,
    //   · and the clock must advance a WHOLE interval, because a leaked loop's
    //     next tick is 10s out — a 200ms window shows nothing.
    vi.useFakeTimers()
    const slow = vi.fn(
      () => new Promise<Response>((r) => setTimeout(() => r(new Response("", { status: 200 })), 40)),
    )
    vi.stubGlobal("fetch", slow)

    const { rerender } = renderHook(() => useBackendLiveness(true))
    for (const pw of ["a", "b", "c"]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) }) // still in flight
      cfg.value = { ...cfg.value, apiPassword: pw }
      rerender()
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(200) }) // all settle
    const settled = slow.mock.calls.length

    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) }) // one interval
    // One live loop fires once. Four would fire four times.
    expect(slow.mock.calls.length - settled).toBeLessThanOrEqual(1)
    vi.useRealTimers()
  })

  it("stops probing once disabled", async () => {
    const { rerender } = renderHook(({ on }: { on: boolean }) => useBackendLiveness(on), {
      initialProps: { on: true },
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    rerender({ on: false })
    const atDisable = fetchMock.mock.calls.length
    await act(async () => { await new Promise((r) => setTimeout(r, 80)) })
    expect(fetchMock.mock.calls.length).toBe(atDisable)
  })
})
