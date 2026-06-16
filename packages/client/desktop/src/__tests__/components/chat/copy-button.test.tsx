import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { CopyButton } from "@/components/chat/copy-button"
import { UserMessage } from "@/components/chat/user-message"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => (key === "message.copyMessage" ? "Copy message" : key),
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  writeText.mockClear()
  Object.assign(navigator, { clipboard: { writeText } })
})

describe("CopyButton", () => {
  it("writes the given text to the clipboard on click", async () => {
    render(<CopyButton text="hello world" ariaLabel="Copy" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("hello world"))
  })

  it("renders an optional label and swaps to copiedLabel after click", async () => {
    render(<CopyButton text="x" label="Copy" copiedLabel="Copied!" />)
    expect(screen.getByText("Copy")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button"))
    await waitFor(() => expect(screen.getByText("Copied!")).toBeInTheDocument())
  })

  it("is icon-only (no label text) when label is absent", () => {
    render(<CopyButton text="x" ariaLabel="Copy" />)
    const btn = screen.getByRole("button", { name: "Copy" })
    expect(btn.querySelector("span")).toBeNull()
  })
})

describe("UserMessage copy", () => {
  it("copies the message content verbatim", async () => {
    render(<UserMessage content="please summarize this" />)
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("please summarize this"))
  })
})
