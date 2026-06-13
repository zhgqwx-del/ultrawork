import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SendMessageResponse } from "@agent/api-client"
import { DelegateManager, DelegateRequestError } from "../delegate"
import { Orchestrator } from "../orchestrator"
import { RunStore } from "../run-store"
import type { DelegateEvent } from "../delegate"
import { deferred, fakeBackend, finishEvent, idleEvent, makeConnector, permissionAskedEvent, type FakeBackendOptions } from "./helpers"

function assistantMessage(
  text: string | undefined,
  extra: { tokens?: { input?: number; output?: number }; cost?: number } = {},
): SendMessageResponse {
  return {
    info: {
      id: "m1",
      sessionID: "s1",
      role: "assistant",
      time: { created: 1 },
      tokens: extra.tokens,
      cost: extra.cost,
    },
    parts: text ? [{ type: "text", text } as any] : [],
  } as SendMessageResponse
}

function toolMessage(tool: string, input: Record<string, unknown>): SendMessageResponse {
  return {
    info: { id: "m2", sessionID: "s1", role: "assistant", time: { created: 1 } },
    parts: [{ type: "tool", tool, state: { status: "completed", input } } as any],
  } as SendMessageResponse
}

describe("DelegateManager", () => {
  let workspace: string
  let hiddenDir: string
  let storeDir: string

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), "dlg-ws-")))
    hiddenDir = realpathSync(mkdtempSync(join(tmpdir(), "dlg-hidden-")))
    storeDir = mkdtempSync(join(tmpdir(), "dlg-store-"))
  })

  afterEach(() => {
    for (const dir of [workspace, hiddenDir, storeDir]) rmSync(dir, { recursive: true, force: true })
  })

  function build(opts: { opencode?: Partial<FakeBackendOptions>; acp?: Partial<FakeBackendOptions> } = {}) {
    const opencode = fakeBackend({ kind: "opencode", sessionStatus: true, ...opts.opencode })
    const acp = fakeBackend({ kind: "acp", ...opts.acp })
    const connector = makeConnector([opencode, acp])
    const orchestrator = new Orchestrator({
      connectorFor: () => connector,
      store: new RunStore(storeDir),
      hiddenParentWorkspace: hiddenDir,
    })
    const delegates = new DelegateManager({
      orchestrator,
      connectorFor: () => connector,
      hiddenParentWorkspace: hiddenDir,
    })
    return { opencode, acp, connector, orchestrator, delegates }
  }

  it("returns the D-2 contract: last assistant text + summed tokens/cost", async () => {
    const { acp, delegates } = build({})
    acp.fetchHistory = vi.fn(async () => ({
      hasMore: false,
      messages: [
        assistantMessage("intermediate", { tokens: { input: 5, output: 7 }, cost: 0.002 }),
        assistantMessage(undefined),
        assistantMessage("final deliverable", { tokens: { input: 10, output: 20 }, cost: 0.01 }),
      ],
    }))

    const result = await delegates.delegate({ agentId: "acp:claude", task: "write the report", workspace })
    expect(result.status).toBe("completed")
    expect(result.deliverable).toBe("final deliverable")
    expect(result.tokens).toEqual({ input: 15, output: 27 })
    expect(result.cost).toBeCloseTo(0.012)
    expect(result.sessionId).toBeTruthy()
  })

  it("omits tokens/cost when the backend reports none (ACP without usage)", async () => {
    const { acp, delegates } = build({})
    acp.fetchHistory = vi.fn(async () => ({ hasMore: false, messages: [assistantMessage("done")] }))
    const result = await delegates.delegate({ agentId: "acp:claude", task: "t", workspace })
    expect(result.deliverable).toBe("done")
    expect(result.tokens).toBeUndefined()
    expect(result.cost).toBeUndefined()
    expect(result.artifacts).toBeUndefined()
  })

  it("collects the child's written files into the D-2 artifacts field (018)", async () => {
    const { acp, delegates } = build({})
    acp.fetchHistory = vi.fn(async () => ({
      hasMore: false,
      messages: [
        toolMessage("write", { filePath: "/ws/flappy-bird.html" }),
        toolMessage("edit", { file_path: "/ws/flappy-bird.html" }), // same file → deduped
        toolMessage("read", { path: "/ws/notes.txt" }), // read is not a write → ignored
        assistantMessage("done — created flappy-bird.html"),
      ],
    }))
    const result = await delegates.delegate({ agentId: "acp:claude", task: "build flappy bird", workspace })
    expect(result.artifacts).toEqual(["/ws/flappy-bird.html"])
  })

  it("reuses ONE hidden parent across opencode delegates and titles children", async () => {
    const { opencode, delegates } = build({
      opencode: {
        onPrompt: (sid, _text, emit) => {
          emit(finishEvent(sid))
          emit(idleEvent(sid))
        },
      },
    })
    await delegates.delegate({ agentId: "opencode:default", task: "first", workspace })
    await delegates.delegate({ agentId: "opencode:default", task: "second", workspace })

    // parent + 2 children
    expect(opencode.createdSessions).toHaveLength(3)
    const [parent, child1, child2] = opencode.createdSessions
    expect(parent.title).toBe("[delegates]")
    expect(parent.parentSessionId).toBeUndefined()
    expect(child1.parentSessionId).toBeDefined()
    expect(child2.parentSessionId).toBe(child1.parentSessionId)
    expect(child1.title).toBe("[delegate] first")
  })

  it("maps a timed-out child turn to status timeout", async () => {
    const { delegates } = build({ acp: { onPrompt: () => deferred().promise } })
    const result = await delegates.delegate({ agentId: "acp:claude", task: "hang", workspace, timeoutMs: 30 })
    expect(result.status).toBe("timeout")
    expect(result.error).toContain("timed out")
    expect(result.deliverable).toBeUndefined()
  })

  it("relays child permission events as delegate.permission", async () => {
    const gate = deferred()
    const { acp, delegates } = build({
      acp: {
        onPrompt: () => gate.promise,
      },
    })
    acp.fetchHistory = vi.fn(async () => ({ hasMore: false, messages: [assistantMessage("ok")] }))
    const events: DelegateEvent[] = []
    delegates.subscribe((event) => events.push(event))

    const pending = delegates.delegate({ agentId: "acp:claude", task: "needs perms", workspace })
    await vi.waitFor(() => {
      const running = delegates.list().find((r) => r.status === "running")
      expect(running?.sessionId).toBeTruthy()
    })
    const sessionId = delegates.list()[0].sessionId!
    acp.emit(permissionAskedEvent(sessionId))
    gate.resolve()
    await pending

    const perm = events.find((e) => e.type === "delegate.permission")
    expect(perm).toBeDefined()
    expect((perm as any).properties.sessionId).toBe(sessionId)
    expect((perm as any).properties.workspace).toBe(workspace)

    // record lifecycle was broadcast too: running (no session) → running (session) → completed
    const updates = events.filter((e) => e.type === "delegate.updated") as Extract<
      DelegateEvent,
      { type: "delegate.updated" }
    >[]
    expect(updates[updates.length - 1].properties.delegate.status).toBe("completed")
  })

  it("settles the record as failed when spawn infrastructure throws", async () => {
    const { acp, delegates } = build({})
    acp.createSession = vi.fn(async () => {
      throw new Error("spawn exploded")
    })
    await expect(delegates.delegate({ agentId: "acp:claude", task: "t", workspace })).rejects.toThrow("spawn exploded")
    expect(delegates.list()[0]).toMatchObject({ status: "failed", error: "spawn exploded" })
  })

  it("validates the request shape", async () => {
    const { delegates } = build({})
    await expect(delegates.delegate({ agentId: "", task: "t", workspace })).rejects.toThrow(DelegateRequestError)
    await expect(delegates.delegate({ agentId: "acp:claude", task: " ", workspace })).rejects.toThrow(
      DelegateRequestError,
    )
    await expect(
      delegates.delegate({ agentId: "acp:claude", task: "t", workspace: join(tmpdir(), "missing-dir-xyz") }),
    ).rejects.toThrow(DelegateRequestError)
  })

  it("prunes terminal records beyond the keep window but keeps running ones", async () => {
    const { acp, delegates } = build({})
    acp.fetchHistory = vi.fn(async () => ({ hasMore: false, messages: [assistantMessage("ok")] }))
    for (let i = 0; i < 53; i++) {
      await delegates.delegate({ agentId: "acp:claude", task: `t${i}`, workspace })
    }
    const records = delegates.list()
    expect(records).toHaveLength(50)
    // newest first — the oldest three were pruned
    expect(records[0].task).toBe("t52")
    expect(records.some((r) => r.task === "t0")).toBe(false)
  })
})
