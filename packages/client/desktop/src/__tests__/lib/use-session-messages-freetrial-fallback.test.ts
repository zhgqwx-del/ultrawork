/** Real hook + SSE ordering regressions for free-model failures and request-level replay. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { StrictMode } from "react"
import type { MessageInfo, MessagePart, SendMessageResponse } from "@agent/api-client"
import type { PromptOptions, SSEEvent } from "@agent/connector"
import { toast } from "sonner"

vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (key: string) => key }) }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), message: vi.fn(), info: vi.fn() } }))

const activeIds = new Set<string>()
const markSessionIdle = vi.fn((id: string) => { activeIds.delete(id) })
const markSessionActive = vi.fn((id: string) => { activeIds.add(id) })
const updateSession = vi.fn()
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({ sessions: [], activeSessionIds: activeIds, updateSession, markSessionActive, markSessionIdle }),
}))

let supportsModel = true
let hasSessionStatus = true
const connector = {
  capabilitiesOf: () => ({ sessionStatus: hasSessionStatus, globalEvents: true, revert: true, model: supportsModel }),
  fetchHistory: vi.fn(async () => ({ messages: [], cursor: undefined, hasMore: false })),
  cancel: vi.fn(async () => undefined),
  revert: vi.fn(async () => undefined),
  prompt: vi.fn(async (_sessionId: string, _text: string, _options?: PromptOptions) => undefined),
}
let handler: ((event: SSEEvent) => void) | undefined
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => connector,
  useSessionSubscribe: (_id: string | undefined, callback: (event: SSEEvent) => void) => { handler = callback },
  useSSEReconnectEpoch: () => 0,
}))

const firstModel = "opencode/big-pickle"
const secondModel = "opencode/mimo-v2.6-flash-free"
const thirdModel = "opencode/deepseek-v4.1-flash-free"
const modelState = { currentModel: firstModel, freeTrialConsent: true }
const advanceFreeTrialModel = vi.fn(async (_failed: string, _attempted?: readonly string[]): Promise<string | null> => secondModel)
vi.mock("@/lib/model-context", () => ({
  useModelOptional: () => ({ ...modelState, getCurrentModel: () => modelState.currentModel, advanceFreeTrialModel }),
}))

import { useSessionMessages, __resetMessageCache, applyMessageEventToCache } from "@/lib/use-session-messages"
import { beginPromptAttempt, forgetPromptAttempt, getPromptAttempt } from "@/lib/prompt-attempt"

function errorEvent(error: unknown, sessionID = "s1"): SSEEvent {
  return { type: "session.error", properties: { sessionID, error } }
}
const authError = () => errorEvent({ name: "AuthError", data: { message: "Missing API key." } })
const unavailable = () => errorEvent({ name: "APIError", data: { statusCode: 400, message: "Request failed", responseBody: JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Model is unavailable." } }) } })
const idle = (sessionID = "s1"): SSEEvent => ({ type: "session.status", properties: { sessionID, status: { type: "idle" } } })
const userInfo = (id = "user1", created = Date.now()): MessageInfo => ({ id, sessionID: "s1", role: "user", time: { created } })
const assistantInfo = (id = "assistant1", parentID = "user1", model = firstModel, created = Date.now()): MessageInfo => ({
  id, sessionID: "s1", role: "assistant", parentID,
  providerID: model.split("/")[0], modelID: model.split("/").slice(1).join("/"), time: { created },
})
const completedWrite = (messageID = "assistant1"): MessagePart => ({
  type: "tool", id: `write-${messageID}`, messageID, sessionID: "s1", callID: `call-${messageID}`, tool: "write",
  state: { status: "completed", input: { filePath: "report.txt" }, output: "written", title: "write", metadata: {}, time: { start: 1, end: 2 } },
})
async function emit(...events: SSEEvent[]) {
  await act(async () => { for (const event of events) handler!(event) })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
async function mount(options?: Parameters<typeof useSessionMessages>[1]) {
  const hook = renderHook(() => useSessionMessages("s1", options))
  await waitFor(() => expect(hook.result.current.loading).toBe(false))
  return hook
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetMessageCache()
  activeIds.clear()
  forgetPromptAttempt("s1")
  forgetPromptAttempt("s2")
  handler = undefined
  modelState.currentModel = firstModel
  modelState.freeTrialConsent = true
  supportsModel = true
  hasSessionStatus = true
  advanceFreeTrialModel.mockReset().mockResolvedValue(secondModel)
})
afterEach(() => {
  forgetPromptAttempt("s1")
  forgetPromptAttempt("s2")
  vi.restoreAllMocks()
})

describe("free-model fallback dispatch", () => {
  it("waits for backend idle before sending the next candidate", async () => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(authError())
    expect(advanceFreeTrialModel).toHaveBeenCalledWith(firstModel, [firstModel])
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    await emit(idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })

  it("replays the complete Home request, including document notes, materialized attachments and Team options", async () => {
    const text = "Analyze these files\n[Attached document: report.docx]"
    const options: PromptOptions = {
      model: firstModel,
      directory: "C:\\Workspace\\客户项目",
      system: "Lead this Team and preserve the member roster.",
      tools: { task: false, orchestrator_delegate: true },
      attachments: [
        { mime: "image/png", filename: "image.png", url: "data:image/png;base64,AQID" },
        { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "report.docx", url: "file:///C:/Workspace/report.docx" },
      ],
    }
    beginPromptAttempt("s1", text, options)
    // Home dispatches before the Session hook mounts, unlike the composer sendMessage path.
    await connector.prompt("s1", text, options)
    await mount({ initialSending: true, initialMessageText: "Analyze these files" })
    await emit(authError(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1]).toEqual(["s1", text, { ...options, model: secondModel }])
  })

  it("still replays when idle arrives before asynchronous candidate resolution", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(authError(), idle())
    expect(result.current.sending).toBe(false)
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    await act(async () => { next.resolve(secondModel) })
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })

  it("advances on a structured model-unavailable 400", async () => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: "invalid parameters", error: { name: "APIError", data: { statusCode: 400, message: "Invalid model parameter: max_tokens" } } },
    { name: "context overflow", error: { data: { message: "context length exceeded" } } },
    { name: "ordinary transient 429", error: { name: "APIError", data: { statusCode: 429, message: "Too Many Requests", responseBody: '{"error":{"type":"server_error","message":"Rate limit exceeded"}}' } } },
  ])("does not switch models for $name", async ({ error }) => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(errorEvent(error), idle())
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("shows a free-access restriction for manually selected free models without rotating candidates", async () => {
    modelState.freeTrialConsent = false
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(errorEvent({ name: "APIError", data: { statusCode: 429, message: "Too Many Requests", responseBody: '{"error":{"type":"FreeUsageLimitError","message":"Free usage limit reached"}}', responseHeaders: { "retry-after": "69553" } } }), idle())
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith("freeTrial.quotaExceeded")
    expect(getPromptAttempt("s1")).toBeUndefined()
  })

  it("consumes repeated error/idle events only once while preparing a candidate", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(authError(), authError(), idle(), idle())
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(1)
    await act(async () => { next.resolve(secondModel) })
    expect(connector.prompt).toHaveBeenCalledTimes(2)
  })

  it("caps a turn at three total model attempts", async () => {
    advanceFreeTrialModel.mockResolvedValueOnce(secondModel).mockResolvedValueOnce(thirdModel)
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(unavailable(), idle())
    await emit(unavailable(), idle())
    await emit(unavailable(), idle())
    expect(connector.prompt.mock.calls.map((call) => call[2]?.model)).toEqual([firstModel, secondModel, thirdModel])
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(2)
    expect(toast.error).toHaveBeenCalledWith("freeTrial.unavailable")
  })
})

describe("replay cancellation", () => {
  it.each(["text delta", "text snapshot", "file", "patch", "tool"])("never replays after assistant %s output", async (output) => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    // Echo the real user first, matching server persistence before the assistant starts.
    await emit(
      { type: "message.updated", properties: { info: userInfo() } },
      { type: "message.part.updated", properties: { part: { type: "text", id: "user-part", messageID: "user1", sessionID: "s1", text: "hello" } } },
      { type: "message.updated", properties: { info: assistantInfo() } },
    )
    if (output === "text delta") {
      await emit({ type: "message.part.delta", properties: { sessionID: "s1", messageID: "assistant1", partID: "part1", field: "text", delta: "Started answering" } })
    } else if (output === "text snapshot") {
      await emit({ type: "message.part.updated", properties: { part: { type: "text", id: "part1", messageID: "assistant1", sessionID: "s1", text: "Started answering" } } })
    } else if (output === "file") {
      await emit({ type: "message.part.updated", properties: { part: { type: "file", id: "part1", messageID: "assistant1", sessionID: "s1", mime: "image/png", url: "data:image/png;base64,AQID" } } })
    } else if (output === "patch") {
      await emit({ type: "message.part.updated", properties: { part: { type: "patch", id: "part1", messageID: "assistant1", sessionID: "s1", hash: "change1", files: ["answer.txt"] } } })
    } else {
      await emit({ type: "message.part.updated", properties: { part: { type: "tool", id: "part1", messageID: "assistant1", sessionID: "s1", callID: "tool1", tool: "bash", state: { status: "running", input: { command: "echo hello" }, time: { start: 1 } } } } })
    }
    await emit(authError(), idle())
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("does not mistake the user's attachment echo for assistant output", async () => {
    const { result } = await mount()
    const attachments = [{ mime: "image/png", filename: "input.png", url: "data:image/png;base64,AQID" }]
    act(() => result.current.sendMessage("", firstModel, attachments))
    await emit(
      { type: "message.updated", properties: { info: userInfo() } },
      { type: "message.part.updated", properties: { part: { ...attachments[0], type: "file", id: "user-part", messageID: "user1", sessionID: "s1" } } },
    )
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.attachments).toEqual(attachments)
  })

  it("cancels a pending fallback when the user stops", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    await emit(authError())
    act(() => result.current.stopGeneration())
    await act(async () => { next.resolve(secondModel) })
    await emit(idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(connector.cancel).toHaveBeenCalledWith("s1")
  })

  it("cancels a pending fallback after navigating to another session", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const hook = renderHook(({ id }) => useSessionMessages(id), { initialProps: { id: "s1" } })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    act(() => hook.result.current.sendMessage("hello", firstModel))
    await emit(authError())
    hook.rerender({ id: "s2" })
    await act(async () => { next.resolve(secondModel) })
    await emit(idle("s1"))
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("cancels a pending fallback after unmount", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello", firstModel))
    await emit(authError(), idle())
    hook.unmount()
    await act(async () => { next.resolve(secondModel) })
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("does not overwrite a newer global model selection with an old fallback", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello", firstModel))
    await emit(authError())
    modelState.currentModel = "anthropic/claude-sonnet-5"
    hook.rerender()
    await act(async () => { next.resolve(secondModel) })
    await emit(idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(modelState.currentModel).toBe("anthropic/claude-sonnet-5")
  })
})

describe("failure and retry state", () => {
  it("settles a Home ACP send without assistant output while global idle independently unlocks the session", async () => {
    supportsModel = false
    hasSessionStatus = false
    beginPromptAttempt("s1", "hello ACP", {})
    await connector.prompt("s1", "hello ACP", {})
    const hook = await mount({ initialSending: true, initialMessageText: "hello ACP" })
    // ACP emits user parts before their metadata; this activity cancels the Home
    // safety timeout. Its lifecycle idle is global, not on this subscription.
    await emit(
      { type: "message.part.updated", properties: { part: {
        type: "text", id: "acp-user-text", sessionID: "s1", messageID: "acp-user", text: "hello ACP",
      } } },
      { type: "message.updated", properties: { info: userInfo("acp-user") } },
      errorEvent("Missing API key (offline ACP fixture)"),
    )
    expect(hook.result.current.sending).toBe(false)
    expect(hook.result.current.streamingMessageId).toBeNull()
    expect(toast.error).toHaveBeenCalledWith("Missing API key (offline ACP fixture)")
    expect(activeIds.has("s1")).toBe(true)
    // Home owns the blocking prompt's promise and catch. The local error must
    // preserve the global busy lock until the independent global idle arrives.
    act(() => hook.result.current.sendMessage("Too early"))
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(markSessionIdle).not.toHaveBeenCalled()
    await act(async () => { activeIds.delete("s1"); hook.rerender() })
    expect(hook.result.current.sending).toBe(false)
    act(() => hook.result.current.sendMessage("Next request"))
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
  })

  it("keeps a healthy Home ACP send active until its blocking turn supplies terminal output", async () => {
    supportsModel = false
    hasSessionStatus = false
    beginPromptAttempt("s1", "hello ACP", {})
    const hook = await mount({ initialSending: true, initialMessageText: "hello ACP" })
    await emit(
      { type: "message.part.updated", properties: { part: {
        type: "text", id: "acp-user-text", sessionID: "s1", messageID: "acp-user", text: "hello ACP",
      } } },
      { type: "message.updated", properties: { info: userInfo("acp-user") } },
    )
    // An empty app-level map cannot complete an accepted Home handoff before
    // the actual blocking prompt has supplied a terminal signal.
    await act(async () => { activeIds.delete("s1"); hook.rerender() })
    expect(hook.result.current.sending).toBe(true)
    await emit({ type: "message.updated", properties: { info: {
      ...assistantInfo("acp-assistant", "acp-user"), finish: "stop",
    } } })
    expect(hook.result.current.sending).toBe(false)
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
  })

  it("does not replay an ACP authentication failure through Zen candidates", async () => {
    supportsModel = false
    const { result } = await mount()
    act(() => result.current.sendMessage("hello ACP", firstModel))
    await emit(authError(), idle())
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("updates the fallback gate when session binding hydrates to an ACP backend", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello ACP", firstModel))
    supportsModel = false
    hook.rerender()
    await emit(authError(), idle())
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("discards a pending Zen candidate if binding hydration selects ACP before it resolves", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello ACP", firstModel))
    await emit(authError())
    supportsModel = false
    hook.rerender()
    await act(async () => { next.resolve(secondModel) })
    await emit(idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(toast.message).not.toHaveBeenCalled()
  })

  it("cancels a Home attachment-only request before any message echo arrives", async () => {
    beginPromptAttempt("s1", "", { model: firstModel, attachments: [{ mime: "image/png", url: "data:image/png;base64,AA==" }] })
    const { result } = await mount({ initialSending: true, initialMessageText: "" })
    expect(result.current.allMessages).toEqual([])
    act(() => result.current.stopGeneration())
    expect(connector.cancel).toHaveBeenCalledWith("s1")
    expect(getPromptAttempt("s1")).toBeUndefined()
    await emit(authError(), idle())
    expect(connector.prompt).not.toHaveBeenCalled()
  })

  it("returns retry details and clears them at idle", async () => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    const retry = { type: "retry" as const, attempt: 2, message: "Provider is overloaded", next: Date.now() + 2000 }
    await emit({ type: "session.status", properties: { sessionID: "s1", status: retry } })
    expect(result.current.retry).toEqual({ attempt: retry.attempt, message: retry.message, next: retry.next })
    expect(result.current.sending).toBe(true)
    await emit(idle())
    expect(result.current.retry).toBeUndefined()
    expect(result.current.sending).toBe(false)
  })

  it("retains a terminal assistant error even when its parts are empty", async () => {
    const { result } = await mount()
    act(() => result.current.sendMessage("hello", firstModel))
    const error = { name: "APIError", data: { statusCode: 429, message: "Too Many Requests", responseBody: '{"error":{"type":"FreeUsageLimitError"}}' } }
    await emit({ type: "message.updated", properties: { info: { id: "assistant-error", sessionID: "s1", role: "assistant", providerID: "opencode", modelID: "big-pickle", error, time: { created: 1, completed: 2 } } } }, idle())
    expect(result.current.allMessages.find((message) => message.info.id === "assistant-error")).toMatchObject({ info: { error }, parts: [] })
  })
})

describe("navigation and backend event interleavings", () => {
  it("recognizes a Home user echo whose metadata arrived before Session registered its cache", async () => {
    beginPromptAttempt("s1", "hello", { model: firstModel })
    await connector.prompt("s1", "hello", { model: firstModel })
    // Home starts the request before Session mounts; only the app-level subscriber
    // receives the user's initial metadata, and no message cache is registered yet.
    applyMessageEventToCache({ type: "message.updated", properties: { info: userInfo() } })
    await mount({ initialSending: true, initialMessageText: "hello" })
    await emit({ type: "message.part.updated", properties: { part: {
      type: "text", id: "user-text", messageID: "user1", sessionID: "s1", text: "hello",
    } } }, unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })

  it("keeps the output barrier for tools executed on the global stream while the page is unmounted", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    await emit({ type: "message.updated", properties: { info: userInfo() } })
    hook.unmount()

    // use-sessions keeps folding these events even though no Session hook is mounted.
    applyMessageEventToCache({ type: "message.updated", properties: { info: assistantInfo() } })
    applyMessageEventToCache({ type: "message.part.updated", properties: { part: completedWrite() } })
    expect(getPromptAttempt("s1")?.hasOutput).toBe(true)

    await mount()
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
  })

  it("restores the output barrier from the current turn's history after missing background events", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    const user = userInfo()
    await emit({ type: "message.updated", properties: { info: user } })
    hook.unmount()

    const messages: SendMessageResponse[] = [
      { info: user, parts: [{ type: "text", text: "Write a report" }] },
      { info: assistantInfo(), parts: [completedWrite()] },
    ]
    // No global output event arrived; the server's persisted snapshot is the only evidence.
    connector.fetchHistory.mockResolvedValueOnce({ messages, cursor: undefined, hasMore: false } as any)
    await mount()
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(advanceFreeTrialModel).not.toHaveBeenCalled()
  })

  it("waits for slow navigation hydration before replaying and honors tools returned by the snapshot", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    const user = userInfo()
    await emit({ type: "message.updated", properties: { info: user } })
    hook.unmount()

    const history = deferred<{ messages: SendMessageResponse[]; cursor: undefined; hasMore: boolean }>()
    connector.fetchHistory.mockReturnValueOnce(history.promise as any)
    const reopened = renderHook(() => useSessionMessages("s1"))
    expect(reopened.result.current.loading).toBe(true)
    // The candidate is ready and the backend is idle, but the snapshot proving
    // whether this turn already executed a tool is still in flight.
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)

    await act(async () => { history.resolve({
      messages: [
        { info: user, parts: [{ type: "text", text: "Write a report" }] },
        { info: assistantInfo(), parts: [completedWrite()] },
      ], cursor: undefined, hasMore: false,
    }) })
    expect(reopened.result.current.loading).toBe(false)
    expect(connector.prompt).toHaveBeenCalledTimes(1)
  })

  it("does not blindly replay when navigation hydration fails after a candidate becomes ready", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    await emit({ type: "message.updated", properties: { info: userInfo() } })
    hook.unmount()

    const history = deferred<{ messages: SendMessageResponse[]; cursor: undefined; hasMore: boolean }>()
    connector.fetchHistory.mockReturnValueOnce(history.promise as any)
    const reopened = renderHook(() => useSessionMessages("s1"))
    expect(reopened.result.current.loading).toBe(true)
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(1)

    await act(async () => { history.reject(new Error("History is unavailable")) })
    expect(reopened.result.current.loading).toBe(false)
    expect(connector.prompt).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith("error.loadMessages")
  })

  it("does not apply a previous turn's hydrated tools to the current request", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("New request", firstModel))
    const currentUser = userInfo()
    await emit({ type: "message.updated", properties: { info: currentUser } })
    hook.unmount()

    const oldCreated = Date.now() - 60_000
    const messages: SendMessageResponse[] = [
      { info: userInfo("old-user", oldCreated), parts: [{ type: "text", text: "Old request" }] },
      { info: { ...assistantInfo("old-assistant", "old-user", firstModel, oldCreated), finish: "stop" }, parts: [completedWrite("old-assistant")] },
      { info: currentUser, parts: [{ type: "text", text: "New request" }] },
      { info: assistantInfo(), parts: [] },
    ]
    connector.fetchHistory.mockResolvedValueOnce({ messages, cursor: undefined, hasMore: false } as any)
    await mount()
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })

  it("does not restore an old failed model when its final assistant metadata arrives after fallback dispatch", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello", firstModel))
    const oldAssistant = assistantInfo()
    await emit(
      { type: "message.updated", properties: { info: userInfo() } },
      { type: "message.updated", properties: { info: oldAssistant } },
      unavailable(), idle(),
    )
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(getPromptAttempt("s1")?.options.model).toBe(secondModel)

    await emit({ type: "message.updated", properties: { info: {
      ...oldAssistant, error: { name: "AuthError", data: { message: "Missing API key." } },
      time: { ...oldAssistant.time, completed: Date.now() },
    } } })
    expect(getPromptAttempt("s1")?.options.model).toBe(secondModel)
    // The next model's own failure must be classified against that dispatch's model.
    advanceFreeTrialModel.mockImplementationOnce(async (failed, attempted) => {
      expect(failed).toBe(secondModel)
      expect([...attempted!]).toEqual([firstModel, secondModel])
      return thirdModel
    })
    await emit(unavailable(), idle())
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[2][2]?.model).toBe(thirdModel)
  })

  it("does not discard a newer turn's fallback when the previous turn repeats its terminal metadata", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Previous request", firstModel))
    const oldAssistant = { ...assistantInfo("old-assistant", "old-user"), finish: "stop" }
    await emit(
      { type: "message.updated", properties: { info: userInfo("old-user") } },
      { type: "message.updated", properties: { info: oldAssistant } },
      idle(),
    )
    act(() => hook.result.current.sendMessage("New request", firstModel))
    await emit(
      { type: "message.updated", properties: { info: userInfo() } },
      { type: "message.updated", properties: { info: assistantInfo() } },
      { type: "message.updated", properties: { info: oldAssistant } },
    )
    expect(getPromptAttempt("s1")?.text).toBe("New request")
    expect(hook.result.current.sending).toBe(true)
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(3)
    expect(connector.prompt.mock.calls[2][2]?.model).toBe(secondModel)
  })

  it("keeps fallback pending across the route's duplicate ProviderModelNotFoundError", async () => {
    const next = deferred<string | null>()
    advanceFreeTrialModel.mockReturnValueOnce(next.promise)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("hello", firstModel))
    // getModel publishes a helpful error, Runner publishes idle, and prompt_async's
    // catch publishes the NamedError.message (= its name) after the runner rejects.
    await emit(
      errorEvent({ name: "UnknownError", data: { message: "Model not found: opencode/big-pickle." } }),
      idle(),
      errorEvent({ name: "UnknownError", data: { message: "ProviderModelNotFoundError" } }),
    )
    await act(async () => { next.resolve(secondModel) })
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })

  it("keeps the fallback user's identity when an earlier candidate repeats its user metadata", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    const firstUser = userInfo("user-a")
    await emit({ type: "message.updated", properties: { info: firstUser } }, unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)

    await emit(
      { type: "message.updated", properties: { info: userInfo("user-b") } },
      { type: "message.updated", properties: { info: firstUser } },
      { type: "message.updated", properties: { info: assistantInfo("assistant-b", "user-b", secondModel) } },
      { type: "message.part.updated", properties: { part: completedWrite("assistant-b") } },
    )
    expect(getPromptAttempt("s1")?.userMessageId).toBe("user-b")
    expect(getPromptAttempt("s1")?.hasOutput).toBe(true)
    await emit(authError(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(1)
  })

  it("does not replace an observed fallback user with an older history snapshot containing only the first candidate", async () => {
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Write a report", firstModel))
    const firstUser = userInfo("user-a")
    await emit({ type: "message.updated", properties: { info: firstUser } }, unavailable(), idle())
    await emit({ type: "message.updated", properties: { info: userInfo("user-b") } })
    hook.unmount()

    const messages: SendMessageResponse[] = [
      { info: firstUser, parts: [{ type: "text", text: "Write a report" }] },
      { info: assistantInfo("assistant-a", "user-a"), parts: [] },
    ]
    connector.fetchHistory.mockResolvedValueOnce({ messages, cursor: undefined, hasMore: false } as any)
    await mount()
    expect(getPromptAttempt("s1")?.userMessageId).toBe("user-b")
    await emit(
      { type: "message.updated", properties: { info: assistantInfo("assistant-b", "user-b", secondModel) } },
      { type: "message.part.updated", properties: { part: completedWrite("assistant-b") } },
      authError(), idle(),
    )
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(advanceFreeTrialModel).toHaveBeenCalledTimes(1)
  })

  it("keeps a new turn when a previous user and terminal assistant repeat within the same clock millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000)
    const hook = await mount()
    act(() => hook.result.current.sendMessage("Previous request", firstModel))
    const oldUser = userInfo("old-user")
    const oldAssistant = { ...assistantInfo("old-assistant", "old-user"), finish: "stop" }
    await emit(
      { type: "message.updated", properties: { info: oldUser } },
      { type: "message.updated", properties: { info: oldAssistant } },
      idle(),
    )

    act(() => hook.result.current.sendMessage("New request", firstModel))
    await emit(
      { type: "message.updated", properties: { info: userInfo("new-user") } },
      { type: "message.updated", properties: { info: oldUser } },
      { type: "message.updated", properties: { info: oldAssistant } },
    )
    expect(getPromptAttempt("s1")?.text).toBe("New request")
    expect(getPromptAttempt("s1")?.userMessageId).toBe("new-user")
    expect(hook.result.current.sending).toBe(true)
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(3)
    expect(connector.prompt.mock.calls[2][2]?.model).toBe(secondModel)
  })

  it("consumes a Home handoff only once under StrictMode's effect remount", async () => {
    beginPromptAttempt("s1", "hello", { model: firstModel })
    await connector.prompt("s1", "hello", { model: firstModel })
    const hook = renderHook(() => useSessionMessages("s1", { initialSending: true, initialMessageText: "hello" }), { wrapper: StrictMode })
    await waitFor(() => expect(hook.result.current.loading).toBe(false))
    await emit(unavailable(), idle())
    expect(connector.prompt).toHaveBeenCalledTimes(2)
    expect(connector.prompt.mock.calls[1][2]?.model).toBe(secondModel)
  })
})
