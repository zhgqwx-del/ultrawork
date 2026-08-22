import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { UserMessage } from "@/components/chat/user-message"
import { MessageList } from "@/components/chat/message-list"
import type { SendMessageResponse, FilePart } from "@agent/api-client"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "zh-Hans", setLanguage: vi.fn() }),
}))

// Render probe: a mock child is not memoised, so it runs once per real render of
// the bubble — which is how the memo-comparator tests below tell an actual
// re-render apart from React merely reconciling onto the same DOM node.
const { fileIconSpy } = vi.hoisted(() => ({ fileIconSpy: vi.fn() }))
vi.mock("@/components/ui/file-icon", () => ({
  FileIcon: (props: { filename: string; className?: string }) => {
    fileIconSpy(props.filename)
    return <span data-testid="file-icon" />
  },
}))

// 2026-08-22 11:16:07 local time.
const TS = new Date(2026, 7, 22, 11, 16, 7).getTime()

// ICU version differences put U+202F/U+00A0 where older data had a plain space
// (en-US AM/PM since ICU 72). The three CI platforms need not agree on ICU, so
// exact-text assertions normalise first.
const norm = (s: string | null | undefined) => s?.replace(/[\u202f\u00a0]/g, " ") ?? null

function filePart(over: Partial<FilePart>): FilePart {
  return { type: "file", mime: "image/png", url: "data:image/png;base64,AAA", ...over } as FilePart
}

function userMessage(over: Partial<SendMessageResponse["info"]> = {}): SendMessageResponse {
  return {
    info: { id: "msg-1", sessionID: "s1", role: "user", time: { created: TS }, ...over },
    parts: [{ type: "text", text: "hello" }],
  } as SendMessageResponse
}

describe("UserMessage — sent-at timestamp", () => {
  it("renders the send time, in the UI language rather than the system locale", () => {
    render(<UserMessage content="hello" createdAt={TS} />)
    const el = screen.getByTestId("message-time")
    expect(norm(el.textContent)).toBe("2026/8/22 11:16:07")
  })

  it("carries a locale-independent machine-readable dateTime", () => {
    render(<UserMessage content="hello" createdAt={TS} />)
    expect(screen.getByTestId("message-time").getAttribute("datetime")).toBe(new Date(TS).toISOString())
  })

  it("shows the time on an attachment-only turn, which has no copy button", () => {
    const file = filePart({ filename: "a.png" })
    render(<UserMessage content="" attachments={[file]} createdAt={TS} />)
    expect(screen.getByTestId("message-time")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("renders nothing rather than 1970 when the timestamp is missing or corrupt", () => {
    const { rerender } = render(<UserMessage content="hello" />)
    expect(screen.queryByTestId("message-time")).toBeNull()
    rerender(<UserMessage content="hello" createdAt={0} />)
    expect(screen.queryByTestId("message-time")).toBeNull()
    // …and the copy affordance is still there — a bad time must not eat the row.
    expect(screen.getByRole("button")).toBeTruthy()
  })
})

describe("UserMessage — memo comparator", () => {
  // The optimistic→real swap remounts the bubble (the React key is the message id),
  // so it never exercises the comparator. These drive it directly: a prop change
  // that the comparator forgets shows up as stale text, never as an error.
  it("re-renders when only createdAt changed", () => {
    const { rerender } = render(<UserMessage content="hello" createdAt={TS} />)
    expect(norm(screen.getByTestId("message-time").textContent)).toBe("2026/8/22 11:16:07")
    rerender(<UserMessage content="hello" createdAt={TS + 3600_000} />)
    expect(norm(screen.getByTestId("message-time").textContent)).toBe("2026/8/22 12:16:07")
  })

  it("re-renders when only the content changed", () => {
    const { rerender } = render(<UserMessage content="hello" createdAt={TS} />)
    rerender(<UserMessage content="goodbye" createdAt={TS} />)
    expect(screen.getByText("goodbye")).toBeTruthy()
  })

  it("re-renders when the attachments differ in content but not in length", () => {
    const a = filePart({ mime: "text/plain", url: "file:///tmp/a.md", filename: "a.md" })
    const b = filePart({ mime: "text/plain", url: "file:///tmp/b.md", filename: "b.md" })
    const { rerender } = render(<UserMessage content="x" attachments={[a]} createdAt={TS} />)
    rerender(<UserMessage content="x" attachments={[b]} createdAt={TS} />)
    expect(screen.getByText("b.md")).toBeTruthy()
  })

  it("skips the re-render when a fresh attachments array holds the same parts", () => {
    // This is the case MessageList produces on every streamed token: a new array
    // built by `parts.filter(...)` around the very same objects.
    //
    // The probe has to be a render COUNT. Asserting that the DOM node is the same
    // object proves nothing — React reconciles a re-render onto the very same
    // element, so that check passes whether or not the memo held. `fileIconSpy` is
    // an unmemoised mock child, so it is invoked once per real render.
    const a = filePart({ mime: "text/plain", url: "file:///tmp/a.md", filename: "a.md" })
    fileIconSpy.mockClear()
    const { rerender } = render(<UserMessage content="x" attachments={[a]} createdAt={TS} />)
    expect(fileIconSpy).toHaveBeenCalledTimes(1)
    rerender(<UserMessage content="x" attachments={[a]} createdAt={TS} />)
    expect(fileIconSpy).toHaveBeenCalledTimes(1)
    // Sanity: the probe does move when the memo legitimately lets a render through.
    rerender(<UserMessage content="y" attachments={[a]} createdAt={TS} />)
    expect(fileIconSpy).toHaveBeenCalledTimes(2)
  })
})

describe("MessageList → UserMessage wiring", () => {
  // `createdAt` is optional, so a missing hand-off degrades to "no timestamp"
  // rather than to a type error. This is the assertion that keeps it wired.
  it("passes info.time.created through to the bubble", () => {
    render(<MessageList messages={[userMessage()]} />)
    expect(screen.getByTestId("message-time").getAttribute("datetime")).toBe(new Date(TS).toISOString())
  })
})
