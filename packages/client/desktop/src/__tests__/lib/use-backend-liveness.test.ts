// The banner tells the user either "retrying" or "restart the app", and only one
// of those is true at a time. Getting it wrong is worse than not saying it:
// telling someone to restart when the backend is fine, or telling them to wait
// for a process that will never come back.
//
// So the judgement is narrow on purpose, and these tests pin the narrowness —
// especially the cases that must NOT be read as "the process died".

import { describe, it, expect, vi, beforeEach } from "vitest"

import { probeBackend } from "@/lib/use-backend-liveness"

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
