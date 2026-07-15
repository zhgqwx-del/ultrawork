import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { UserMessage } from "@/components/chat/user-message"
import type { FilePart } from "@agent/api-client"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))

function filePart(over: Partial<FilePart>): FilePart {
  return { type: "file", mime: "image/png", url: "data:image/png;base64,AAA", ...over } as FilePart
}

describe("UserMessage — attachments (discussions/039 §2.2)", () => {
  it("renders an attached image in the user's own bubble", () => {
    render(<UserMessage content="看这张图" attachments={[filePart({ filename: "shot.png" })]} />)
    const img = screen.getByAltText("shot.png") as HTMLImageElement
    expect(img.tagName).toBe("IMG")
    expect(img.src).toBe("data:image/png;base64,AAA")
    expect(screen.getByText("看这张图")).toBeTruthy()
  })

  it("renders an attachment-only turn without an empty text line", () => {
    const { container } = render(<UserMessage content="" attachments={[filePart({ filename: "shot.png" })]} />)
    expect(screen.getByAltText("shot.png")).toBeTruthy()
    // No text ⇒ no text node and no copy button (there is nothing to copy).
    expect(container.querySelector(".whitespace-pre-wrap")).toBeNull()
    expect(screen.queryByLabelText("message.copyMessage")).toBeNull()
  })

  it("renders a non-image attachment as a named file chip, not an <img>", () => {
    render(<UserMessage content="" attachments={[filePart({ mime: "application/pdf", filename: "spec.pdf" })]} />)
    expect(screen.getByText("spec.pdf")).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("falls back to the file:// basename when filename is absent", () => {
    render(<UserMessage content="" attachments={[filePart({ mime: "text/plain", url: "file:///tmp/a%20b/notes.md" })]} />)
    expect(screen.getByText("notes.md")).toBeTruthy()
  })

  it("behaves exactly as before when there are no attachments", () => {
    render(<UserMessage content="hello" />)
    expect(screen.getByText("hello")).toBeTruthy()
    expect(screen.queryByRole("img")).toBeNull()
  })
})
