import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChatInput, type AttachmentSlot } from "@/components/chat/chat-input"
import type { Attachment } from "@/lib/attachments"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

// CommandSelector pulls in useApi → SSEProvider; irrelevant here.
vi.mock("@/components/chat/command-selector", () => ({ CommandSelector: () => null }))

const onDragDropEvent = vi.fn(async () => () => {})
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent }),
}))
const openDialog = vi.fn(async () => null)
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => openDialog() }))

function slot(over: Partial<AttachmentSlot> = {}): AttachmentSlot {
  return { items: [], add: vi.fn(), addPaths: vi.fn(), remove: vi.fn(), blocker: null, ...over }
}

const image: Attachment = {
  id: "a1",
  kind: "image",
  mime: "image/png",
  filename: "shot.png",
  wireUrl: "data:image/png;base64,AAA",
  previewUrl: "data:image/png;base64,AAA",
  size: 10,
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("ChatInput — attachments", () => {
  it("renders a thumbnail chip for an attached image and removes it on click", () => {
    const s = slot({ items: [image] })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={s} />)
    expect((screen.getByAltText("shot.png") as HTMLImageElement).src).toBe("data:image/png;base64,AAA")
    fireEvent.click(screen.getByLabelText("attachment.remove"))
    expect(s.remove).toHaveBeenCalledWith("a1")
  })

  it("enables send with an attachment and no text", () => {
    // "Paste a screenshot and hit enter" must be a complete turn.
    const onSend = vi.fn()
    render(<ChatInput value="" onChange={vi.fn()} onSend={onSend} attachments={slot({ items: [image] })} />)
    fireEvent.click(screen.getByLabelText("aria.sendMessage"))
    expect(onSend).toHaveBeenCalled()
  })

  it("keeps send disabled when there is neither text nor an attachment", () => {
    const onSend = vi.fn()
    render(<ChatInput value="" onChange={vi.fn()} onSend={onSend} attachments={slot()} />)
    fireEvent.click(screen.getByLabelText("aria.sendMessage"))
    expect(onSend).not.toHaveBeenCalled()
  })

  it("blocks send and shows the reason when the model can't read the attachment", () => {
    // Letting this through wouldn't error — the server would swap the image for an error
    // string and the model would apologise for a file the user can't see.
    const onSend = vi.fn()
    render(
      <ChatInput
        value="describe this"
        onChange={vi.fn()}
        onSend={onSend}
        attachments={slot({ items: [image], blocker: "qwen3.7-max cannot read images" })}
      />,
    )
    expect(screen.getByText("qwen3.7-max cannot read images")).toBeTruthy()
    fireEvent.click(screen.getByLabelText("aria.sendMessage"))
    expect(onSend).not.toHaveBeenCalled()
  })

  it("attaches image files pasted into the composer", () => {
    const s = slot()
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={s} />)
    const file = new File(["x"], "clip.png", { type: "image/png" })
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [file] } })
    expect(s.add).toHaveBeenCalledWith([file])
  })

  it("leaves a plain-text paste alone", () => {
    // Pasting text must still land in the textarea — only files are intercepted.
    const s = slot()
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={s} />)
    fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { files: [] } })
    expect(s.add).not.toHaveBeenCalled()
  })

  it("registers the NATIVE drag-drop listener, not an HTML5 one", () => {
    // Tauri's dragDropEnabled defaults to true, so the OS handler swallows the event and an
    // HTML5 onDrop would never fire — and only the native event carries real file paths.
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot()} />)
    expect(onDragDropEvent).toHaveBeenCalled()
  })

  it("offers no attach button when the backend is text-only (ACP/Team)", () => {
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot({ disabled: true })} />)
    expect((screen.getByLabelText("aria.attachment") as HTMLButtonElement).disabled).toBe(true)
  })

  it("refuses to send staged attachments on a text-only backend, even with text typed", () => {
    // Attach a file, THEN switch to Team mode: the ➕ goes grey but the file is still staged.
    // Sending here would drop it without a word — the same silent-drop the IM adapters shipped.
    // The pages also clear the list on switch; this asserts the invariant that makes a missed
    // clear impossible to ship, rather than trusting every page to remember.
    const onSend = vi.fn()
    render(
      <ChatInput
        value="do the thing"
        onChange={vi.fn()}
        onSend={onSend}
        attachments={slot({ items: [image], disabled: true })}
      />,
    )
    fireEvent.click(screen.getByLabelText("aria.sendMessage"))
    expect(onSend).not.toHaveBeenCalled()
  })

  it("sends normally on a text-only backend once the attachments are gone", () => {
    const onSend = vi.fn()
    render(
      <ChatInput value="do the thing" onChange={vi.fn()} onSend={onSend} attachments={slot({ disabled: true })} />,
    )
    fireEvent.click(screen.getByLabelText("aria.sendMessage"))
    expect(onSend).toHaveBeenCalled()
  })

  it("shows no attachment surface at all when the composer takes no attachments", () => {
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} />)
    expect(screen.queryByLabelText("aria.attachment")).toBeNull()
    expect(onDragDropEvent).not.toHaveBeenCalled()
  })
})
