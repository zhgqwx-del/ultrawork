import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { MessageInfo, SendMessageResponse } from "@agent/api-client"
import { en, zhHans, type Language } from "@/lib/i18n-translations"
import { zhHant } from "@/lib/i18n-zh-hant.generated"
import { formatDateTime } from "@/lib/format-time"
import { AssistantTurn } from "@/components/chat/assistant-turn"
import { modelErrorMessage } from "@/lib/model-error-message"

const h = vi.hoisted(() => ({ language: "zh-Hans" as "en" | "zh-Hans" | "zh-Hant", navigate: vi.fn() }))
const dictionaries: Record<Language, Record<string, string>> = { en, "zh-Hans": zhHans, "zh-Hant": zhHant }
function translator(language: Language) {
  return (key: string, params?: Record<string, string | number>): string => {
    let value = dictionaries[language][key] ?? key
    for (const [name, replacement] of Object.entries(params ?? {})) value = value.split(`{${name}}`).join(String(replacement))
    return value
  }
}
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ language: h.language, t: translator(h.language) }) }))
vi.mock("@/router", () => ({ router: { navigate: h.navigate } }))
// The parent remains the real component; unrelated answer/flow renderers are outside this fixture.
vi.mock("@/components/chat/message-parts", () => ({
  MarkdownContent: ({ text }: { text: string }) => <p>{text}</p>,
  FileBlock: () => null,
  PatchBlock: () => null,
}))
vi.mock("@/components/chat/execution-flow", () => ({ ExecutionFlow: () => null }))
vi.mock("@/components/chat/turn-artifacts", () => ({ TurnArtifacts: () => null }))

const completedAt = Date.UTC(2026, 10, 3, 4)
const retryDelaySeconds = 69_553
function freeError(withRetry = true): MessageInfo["error"] {
  return {
    name: "APIError",
    data: {
      statusCode: 429,
      message: "Too Many Requests",
      responseBody: JSON.stringify({ error: { type: "FreeUsageLimitError", message: "Free usage limit reached. Free models work in OpenCode." } }),
      ...(withRetry ? { responseHeaders: { "retry-after": String(retryDelaySeconds) } } : {}),
    },
  }
}
function failedMessage(error: MessageInfo["error"], providerID = "opencode", modelID = "big-pickle"): SendMessageResponse {
  return {
    info: { id: "failed-assistant", sessionID: "s1", role: "assistant", providerID, modelID, time: { created: completedAt - 1000, completed: completedAt }, error },
    parts: [],
  }
}

beforeEach(() => { h.language = "zh-Hans"; vi.clearAllMocks() })
afterEach(() => { vi.restoreAllMocks() })

describe("AssistantTurn free-access error notice", () => {
  it.each(["en", "zh-Hans", "zh-Hant"] as const)("renders an empty-parts free failure and suggested time in %s", (language) => {
    h.language = language
    const t = translator(language)
    const { container } = render(<AssistantTurn messages={[failedMessage(freeError())]} />)
    const notice = screen.getByTestId("assistant-turn")
    expect(notice.textContent).toContain(t("message.turnError"))
    expect(notice.textContent).toContain(t("freeTrial.quotaExceeded"))
    expect(notice.textContent).toContain(t("freeTrial.retryAt", { time: formatDateTime(completedAt + retryDelaySeconds * 1000, language)! }))
    expect(screen.getByRole("button", { name: t("freeTrial.configureModels") })).toBeTruthy()
    expect(notice.textContent).not.toContain("Too Many Requests")
    expect(container.querySelector(".animate-spin")).toBeNull()
  })

  it("opens model settings from the persistent error notice", async () => {
    render(<AssistantTurn messages={[failedMessage(freeError())]} />)
    fireEvent.click(screen.getByRole("button", { name: zhHans["freeTrial.configureModels"] }))
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/settings", { state: { section: "models" } }))
  })

  it("does not invent a suggested time when the upstream omitted one", () => {
    render(<AssistantTurn messages={[failedMessage(freeError(false))]} />)
    expect(screen.getByTestId("assistant-turn").textContent).toContain(zhHans["freeTrial.quotaExceeded"])
    expect(screen.getByTestId("assistant-turn").textContent).not.toContain("上游建议重试时间")
  })

  it("preserves a paid OpenAI quota failure without an OpenCode free-tier explanation", () => {
    const message = "You exceeded your current quota, please check your plan and billing details."
    const error = { name: "APIError", data: { statusCode: 429, message, responseBody: '{"error":{"type":"insufficient_quota"}}' } }
    render(<AssistantTurn messages={[failedMessage(error, "openai", "gpt-5.4")]} />)
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByTestId("assistant-turn").textContent).not.toContain(zhHans["freeTrial.quotaExceeded"])
    expect(screen.queryByRole("button", { name: zhHans["freeTrial.configureModels"] })).toBeNull()
  })

  it("keeps an ordinary parameter 400 visible verbatim", () => {
    const message = "Invalid value for max_tokens: expected a positive integer."
    render(<AssistantTurn messages={[failedMessage({ name: "APIError", data: { statusCode: 400, message } })]} />)
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByTestId("assistant-turn").textContent).not.toContain(zhHans["freeTrial.modelUnavailable"])
  })
  it("does not label another provider's free-tier restriction as OpenCode", () => {
    const message = "This provider's free tier is unavailable."
    const error = { name: "APIError", data: { statusCode: 403, message, responseBody: '{"error":{"type":"FreeTierError"}}' } }
    render(<AssistantTurn messages={[failedMessage(error, "openrouter", "example-free")]} />)
    expect(screen.getByText(message)).toBeTruthy()
    expect(screen.getByTestId("assistant-turn").textContent).not.toContain(zhHans["freeTrial.quotaExceeded"])
    expect(screen.queryByRole("button", { name: zhHans["freeTrial.configureModels"] })).toBeNull()
  })
})

describe("history and language consistency", () => {
  it("anchors a relative retry header to the historical failure time across later reads", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(completedAt + 2 * 3600_000)
    const t = translator("en")
    const firstRead = modelErrorMessage(freeError(), t, "en", completedAt)
    now.mockReturnValue(completedAt + 3 * 24 * 3600_000)
    const laterRead = modelErrorMessage(freeError(), t, "en", completedAt)
    expect(laterRead).toBe(firstRead)
    expect(laterRead).toContain(t("freeTrial.retryAt", { time: formatDateTime(completedAt + retryDelaySeconds * 1000, "en")! }))
  })

  it.each(["en", "zh-Hans", "zh-Hant"] as const)("contains all added error/retry keys in %s", (language) => {
    for (const key of ["freeTrial.quotaExceeded", "freeTrial.modelUnavailable", "freeTrial.retryAt", "freeTrial.configureModels", "message.retrying"]) {
      expect(dictionaries[language][key]?.trim()).toBeTruthy()
    }
    expect(dictionaries[language]["freeTrial.retryAt"]).toContain("{time}")
    expect(dictionaries[language]["message.retrying"]).toContain("{attempt}")
  })
})
