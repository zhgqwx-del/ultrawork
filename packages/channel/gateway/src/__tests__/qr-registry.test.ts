import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { QRRegistry, type QRProvider, type QRPollResult } from "../qr-registry.js"
import type { ChannelManager } from "../channel-manager.js"
import type { ChannelConfig } from "../types.js"

/** Deterministic provider whose poll pops scripted results (last one repeats). */
function makeProvider(overrides: Partial<QRProvider> = {}, script: (() => Promise<QRPollResult>)[] = []) {
  let calls = 0
  const provider: QRProvider & { pollCalls: () => number } = {
    type: "fake",
    pollIntervalMs: 5,
    start: vi.fn(async () => ({ upstreamToken: "up_1", qrContent: "https://qr.example/1" })),
    poll: vi.fn(async () => {
      const step = script[Math.min(calls, script.length - 1)]
      calls++
      return step()
    }),
    pollCalls: () => calls,
    ...overrides,
  }
  return provider
}

function makeManager() {
  return {
    addChannel: vi.fn(async (_config: ChannelConfig) => {}),
    // undefined = config not persisted (registry uses this to distinguish
    // persist failure from auto-connect failure)
    getConfig: vi.fn(() => undefined),
  } as unknown as ChannelManager & { addChannel: ReturnType<typeof vi.fn>; getConfig: ReturnType<typeof vi.fn> }
}

const REQUEST = { name: "n", workspaceDir: "/ws", autoConnect: true }

const authorized = (): Promise<QRPollResult> =>
  Promise.resolve({
    state: "authorized",
    buildConfig: (base) => ({
      id: base.id,
      type: "wechat",
      name: base.name,
      botToken: "secret-token",
      ilinkBotId: "bot1",
      ilinkUserId: "",
      baseUrl: "https://example",
      workspaceDir: base.workspaceDir,
      autoConnect: base.autoConnect,
    }),
  })

const pending = (): Promise<QRPollResult> => Promise.resolve({ state: "pending" })

async function waitFor(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe("QRRegistry", () => {
  let manager: ReturnType<typeof makeManager>
  let registry: QRRegistry

  beforeEach(() => {
    manager = makeManager()
    registry = new QRRegistry(manager)
  })

  afterEach(() => {
    registry.stopAll()
  })

  it("persists the channel the moment credentials arrive — without any status read", async () => {
    const provider = makeProvider({}, [authorized])
    registry.registerProvider(provider)
    const session = await registry.start("fake", REQUEST)
    expect(session.state).toBe("pending")
    expect(session.qrContent).toBe("https://qr.example/1")

    // No getSnapshot call at all — the background loop alone must persist.
    await waitFor(() => manager.addChannel.mock.calls.length === 1)
    const config = manager.addChannel.mock.calls[0][0] as ChannelConfig & { botToken: string }
    expect(config.botToken).toBe("secret-token")
    expect(config.name).toBe("n")
    expect(config.id).toMatch(/^ch_/)

    await waitFor(() => registry.getSnapshot(session.token)?.state === "authorized")
    expect(registry.getSnapshot(session.token)?.channelId).toBe(config.id)
    // One-shot secret: upstream polled exactly once past authorization
    expect(provider.pollCalls()).toBe(1)
  })

  it("reports error (not authorized) when persistence fails after credential delivery", async () => {
    manager.addChannel.mockRejectedValueOnce(new Error("disk full"))
    registry.registerProvider(makeProvider({}, [authorized]))
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(session.token)?.state === "error")
    expect(registry.getSnapshot(session.token)?.error).toContain("disk full")
  })

  it("walks pending → scanned → authorized", async () => {
    registry.registerProvider(
      makeProvider({}, [pending, () => Promise.resolve({ state: "scanned" }), authorized]),
    )
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(session.token)?.state === "scanned")
    await waitFor(() => registry.getSnapshot(session.token)?.state === "authorized")
  })

  it("reuses an in-flight session for an identical request (StrictMode double-mount)", async () => {
    const provider = makeProvider({}, [pending])
    registry.registerProvider(provider)
    const a = await registry.start("fake", REQUEST)
    const b = await registry.start("fake", REQUEST)
    expect(b.token).toBe(a.token)
    expect(provider.start).toHaveBeenCalledTimes(1)

    // ...but a different request gets its own session
    const c = await registry.start("fake", { ...REQUEST, name: "other" })
    expect(c.token).not.toBe(a.token)
  })

  it("cancel stops the poll loop and forgets the session", async () => {
    const provider = makeProvider({}, [pending])
    registry.registerProvider(provider)
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => provider.pollCalls() >= 1)
    expect(registry.cancel(session.token)).toBe(true)
    expect(registry.getSnapshot(session.token)).toBeUndefined()
    const callsAtCancel = provider.pollCalls()
    await new Promise((r) => setTimeout(r, 50))
    // At most one in-flight poll may straggle past cancel; the loop is dead.
    expect(provider.pollCalls()).toBeLessThanOrEqual(callsAtCancel + 1)
    expect(registry.cancel(session.token)).toBe(false)
  })

  it("terminal upstream states land as expired / denied", async () => {
    registry.registerProvider(makeProvider({}, [() => Promise.resolve({ state: "expired" })]))
    const s1 = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(s1.token)?.state === "expired")

    const registry2 = new QRRegistry(manager)
    registry2.registerProvider(
      makeProvider({}, [() => Promise.resolve({ state: "denied", error: "org policy" })]),
    )
    const s2 = await registry2.start("fake", REQUEST)
    await waitFor(() => registry2.getSnapshot(s2.token)?.state === "denied")
    expect(registry2.getSnapshot(s2.token)?.error).toBe("org policy")
    registry2.stopAll()
  })

  it("locally expires a session once the provider deadline passes", async () => {
    registry.registerProvider(
      makeProvider({
        start: vi.fn(async () => ({ upstreamToken: "up", qrContent: "qr", expiresInMs: 20 })),
      }, [pending]),
    )
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(session.token)?.state === "expired")
  })

  it("retries transient poll errors, then fails after 3 consecutive", async () => {
    const boom = (): Promise<QRPollResult> => Promise.reject(new Error("network"))
    // 2 failures then success → survives
    registry.registerProvider(makeProvider({}, [boom, boom, authorized]))
    const ok = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(ok.token)?.state === "authorized")

    // 3 consecutive failures → error state
    const registry2 = new QRRegistry(manager)
    registry2.registerProvider(makeProvider({}, [boom]))
    const bad = await registry2.start("fake", REQUEST)
    await waitFor(() => registry2.getSnapshot(bad.token)?.state === "error")
    expect(registry2.getSnapshot(bad.token)?.error).toBe("network")
    registry2.stopAll()
  })

  it("rejects unknown provider types", async () => {
    await expect(registry.start("nope", REQUEST)).rejects.toThrow(/No QR provider/)
  })

  // ---- regression locks for the 2026-07-08 review findings ----

  it("dedups CONCURRENT starts across the begin network round-trip (review R1)", async () => {
    const provider = makeProvider({
      start: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 30)) // simulate network latency
        return { upstreamToken: "up_c", qrContent: "qr_c" }
      }),
    }, [pending])
    registry.registerProvider(provider)
    const [a, b] = await Promise.all([registry.start("fake", REQUEST), registry.start("fake", REQUEST)])
    expect(a.token).toBe(b.token)
    expect(provider.start).toHaveBeenCalledTimes(1)
  })

  it("does NOT merge requests that differ only in autoConnect (review R5)", async () => {
    const provider = makeProvider({}, [pending])
    registry.registerProvider(provider)
    const a = await registry.start("fake", REQUEST)
    const b = await registry.start("fake", { ...REQUEST, autoConnect: false })
    expect(b.token).not.toBe(a.token)
  })

  it("still persists a one-shot credential that lands while cancelled (review R3)", async () => {
    let resolvePoll: ((r: QRPollResult) => void) | null = null
    const provider = makeProvider({}, [
      () => new Promise<QRPollResult>((resolve) => { resolvePoll = resolve }),
    ])
    registry.registerProvider(provider)
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => resolvePoll !== null)
    // cancel while the authorizing poll is in flight
    registry.cancel(session.token)
    resolvePoll!(await authorized())
    await waitFor(() => manager.addChannel.mock.calls.length === 1)
  })

  it("treats a persisted-but-connect-failed channel as authorized (review R4)", async () => {
    manager.addChannel.mockRejectedValueOnce(new Error("WS connect refused"))
    manager.getConfig.mockImplementation((id: string) => ({ id })) // persisted
    registry.registerProvider(makeProvider({}, [authorized]))
    const session = await registry.start("fake", REQUEST)
    await waitFor(() => registry.getSnapshot(session.token)?.state === "authorized")
    expect(registry.getSnapshot(session.token)?.channelId).toMatch(/^ch_/)
  })

  it("never kills a live session before its own deadline via cleanup (review R2)", async () => {
    const provider = makeProvider({
      start: vi.fn(async () => ({ upstreamToken: "up_l", qrContent: "qr_l", expiresInMs: 7_200_000 })),
    }, [pending])
    registry.registerProvider(provider)
    const long = await registry.start("fake", REQUEST)
    // age it past the old global 15-min cutoff; its own deadline is 2h away
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (registry as any).sessions.get(long.token)
    internal.createdAt = Date.now() - 16 * 60 * 1000
    await registry.start("fake", { ...REQUEST, name: "other" }) // triggers cleanup()
    expect(registry.getSnapshot(long.token)?.state).toBe("pending")
  })

  it("stopAll() during an in-flight begin does not spawn a live session (review R7)", async () => {
    let started = 0
    const provider = makeProvider({
      start: vi.fn(async () => { started++; await new Promise((r) => setTimeout(r, 40)); return { upstreamToken: "u", qrContent: "q" } }),
    }, [pending])
    registry.registerProvider(provider)
    const startP = registry.start("fake", REQUEST)
    registry.stopAll()
    await expect(startP).rejects.toThrow(/stopped/)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((registry as any).sessions.size).toBe(0)
    expect(started).toBe(1)
  })

  it("sanitizes non-finite intervals/expiries from drifting upstream contracts (review R6)", async () => {
    const provider = makeProvider({
      start: vi.fn(async () => ({
        upstreamToken: "up_n",
        qrContent: "qr_n",
        expiresInMs: Number.NaN,
        pollIntervalMs: Number.NaN,
      })),
    }, [pending])
    registry.registerProvider(provider)
    const session = await registry.start("fake", REQUEST)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const internal = (registry as any).sessions.get(session.token)
    expect(Number.isFinite(internal.pollIntervalMs)).toBe(true)
    expect(Number.isFinite(internal.expiresAt)).toBe(true)
  })
})
