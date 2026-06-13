import { describe, it, expect, vi, afterEach } from "vitest"
import { runTurn, TurnCancelledError, TurnFailedError, TurnTimeoutError } from "../turn"
import {
  busyEvent,
  deferred,
  fakeBackend,
  finishEvent,
  idleEvent,
  makeConnector,
  sessionErrorEvent,
} from "./helpers"

const TIMEOUT = { timeoutMs: 5_000 }

afterEach(() => {
  vi.useRealTimers()
})

describe("runTurn — opencode semantics (fire-and-forget prompt + events)", () => {
  it("resolves on session.status idle after activity", async () => {
    const opencode = fakeBackend({
      kind: "opencode",
      sessionStatus: true,
      onPrompt: (sid, _text, emit) => {
        emit(busyEvent(sid))
        emit(idleEvent(sid))
      },
    })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})
    await expect(runTurn(connector, ref.id, "go", TIMEOUT)).resolves.toBeUndefined()
  })

  it("resolves on a terminal assistant finish even if idle never arrives (dual signal)", async () => {
    const opencode = fakeBackend({
      kind: "opencode",
      sessionStatus: true,
      onPrompt: (sid, _text, emit) => emit(finishEvent(sid, "stop")),
    })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})
    await expect(runTurn(connector, ref.id, "go", TIMEOUT)).resolves.toBeUndefined()
  })

  it("ignores a stale idle emitted before any activity", async () => {
    vi.useFakeTimers()
    const opencode = fakeBackend({ kind: "opencode", sessionStatus: true })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})

    const turn = runTurn(connector, ref.id, "go", { timeoutMs: 1_000 })
    const assertion = expect(turn).rejects.toThrow(TurnTimeoutError)
    // Stale idle straight after subscribe — no busy/message seen yet.
    opencode.emit(idleEvent(ref.id))
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
    expect(opencode.cancel).toHaveBeenCalledWith(ref.id)
  })

  it("does not treat the intermediate tool-calls seal as terminal", async () => {
    vi.useFakeTimers()
    const opencode = fakeBackend({
      kind: "opencode",
      sessionStatus: true,
      onPrompt: (sid, _text, emit) => emit(finishEvent(sid, "tool-calls")),
    })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})

    const turn = runTurn(connector, ref.id, "go", { timeoutMs: 1_000 })
    const assertion = expect(turn).rejects.toThrow(TurnTimeoutError)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it("accepts idle once the turn has shown activity", async () => {
    const opencode = fakeBackend({ kind: "opencode", sessionStatus: true })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})

    const turn = runTurn(connector, ref.id, "go", TIMEOUT)
    opencode.emit(idleEvent(ref.id)) // stale — ignored
    opencode.emit(busyEvent(ref.id))
    opencode.emit(idleEvent(ref.id)) // real
    await expect(turn).resolves.toBeUndefined()
  })

  it("fails when prompt submission rejects", async () => {
    const opencode = fakeBackend({
      kind: "opencode",
      sessionStatus: true,
      onPrompt: () => {
        throw new Error("503 unavailable")
      },
    })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})
    await expect(runTurn(connector, ref.id, "go", TIMEOUT)).rejects.toThrow(TurnFailedError)
  })

  it("fails on session.error", async () => {
    const opencode = fakeBackend({
      kind: "opencode",
      sessionStatus: true,
      onPrompt: (sid, _text, emit) => emit(sessionErrorEvent(sid, "model exploded")),
    })
    const connector = makeConnector([opencode])
    const ref = await connector.createSession({})
    await expect(runTurn(connector, ref.id, "go", TIMEOUT)).rejects.toThrow("model exploded")
  })
})

describe("runTurn — ACP semantics (blocking prompt)", () => {
  it("resolves when the blocking prompt resolves", async () => {
    const gate = deferred()
    const acp = fakeBackend({ kind: "acp", onPrompt: () => gate.promise })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })

    const turn = runTurn(connector, ref.id, "go", TIMEOUT)
    let settled = false
    void turn.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    gate.resolve()
    await expect(turn).resolves.toBeUndefined()
  })

  it("fails when the blocking prompt rejects", async () => {
    const acp = fakeBackend({
      kind: "acp",
      onPrompt: () => Promise.reject(new Error("agent died")),
    })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })
    await expect(runTurn(connector, ref.id, "go", TIMEOUT)).rejects.toThrow("agent died")
  })

  it("fails early on session.error while the prompt is still blocking", async () => {
    const gate = deferred()
    const acp = fakeBackend({ kind: "acp", onPrompt: () => gate.promise })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })

    const turn = runTurn(connector, ref.id, "go", TIMEOUT)
    acp.emit(sessionErrorEvent(ref.id, "boom"))
    await expect(turn).rejects.toThrow(TurnFailedError)
    gate.resolve() // late resolution is a no-op
  })

  it("times out and cancels a hung prompt", async () => {
    vi.useFakeTimers()
    const acp = fakeBackend({ kind: "acp", onPrompt: () => deferred().promise })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })

    const turn = runTurn(connector, ref.id, "go", { timeoutMs: 2_000 })
    const assertion = expect(turn).rejects.toThrow(TurnTimeoutError)
    await vi.advanceTimersByTimeAsync(2_000)
    await assertion
    expect(acp.cancel).toHaveBeenCalledWith(ref.id)
  })

  it("cancels via AbortSignal", async () => {
    const acp = fakeBackend({ kind: "acp", onPrompt: () => deferred().promise })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })

    const abort = new AbortController()
    const turn = runTurn(connector, ref.id, "go", { timeoutMs: 60_000, signal: abort.signal })
    const assertion = expect(turn).rejects.toThrow(TurnCancelledError)
    abort.abort()
    await assertion
    expect(acp.cancel).toHaveBeenCalledWith(ref.id)
  })

  it("throws immediately when the signal is already aborted", async () => {
    const acp = fakeBackend({ kind: "acp" })
    const connector = makeConnector([acp])
    const ref = await connector.createSession({ agentId: "acp:claude" })

    const abort = new AbortController()
    abort.abort()
    await expect(runTurn(connector, ref.id, "go", { timeoutMs: 1_000, signal: abort.signal })).rejects.toThrow(
      TurnCancelledError,
    )
    expect(acp.prompt).not.toHaveBeenCalled()
  })
})
