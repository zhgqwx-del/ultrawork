import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ChatInput, type AttachmentSlot } from "@/components/chat/chat-input"

// ChatInput touches these Tauri surfaces on mount/interaction; stub them so the
// composer renders in jsdom. The screenshot button itself goes through the injected
// slot, not these.
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn() }) }))
vi.mock("@/components/chat/command-selector", () => ({ CommandSelector: () => null }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

function makeSlot(over: Partial<AttachmentSlot> = {}): AttachmentSlot {
  return {
    items: [],
    add: vi.fn(),
    addPaths: vi.fn(),
    remove: vi.fn(),
    blocker: null,
    screenshot: { capture: vi.fn(), available: true, busy: false },
    ...over,
  }
}

describe("ChatInput screenshot button", () => {
  beforeEach(() => {
    try {
      localStorage.clear()
    } catch {
      /* jsdom always has it */
    }
  })

  it("does not render a screenshot button when the slot has no screenshot control", () => {
    const slot = makeSlot({ screenshot: undefined })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot} placeholder="Reply..." />)
    expect(screen.queryByLabelText("screenshot.button")).not.toBeInTheDocument()
  })

  it("captures with hideWindow=true by default (飞书/微信 parity) on click", () => {
    const capture = vi.fn()
    const slot = makeSlot({ screenshot: { capture, available: true, busy: false } })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot} placeholder="Reply..." />)
    fireEvent.click(screen.getByLabelText("screenshot.button"))
    expect(capture).toHaveBeenCalledWith(true)
  })

  it("disables the button (and hides the caret) when no tool is available", () => {
    const capture = vi.fn()
    const slot = makeSlot({ screenshot: { capture, available: false, busy: false } })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot} placeholder="Reply..." />)
    const btn = screen.getByLabelText("screenshot.button")
    expect(btn).toBeDisabled()
    // Degraded hint, not the plain label.
    expect(btn).toHaveAttribute("title", "screenshot.unavailable")
    // Caret dropdown is pointless with no tool → absent.
    expect(screen.queryByLabelText("screenshot.options")).not.toBeInTheDocument()
    fireEvent.click(btn)
    expect(capture).not.toHaveBeenCalled()
  })

  it("greys out the button when the slot is disabled (ACP/Team text-only backend)", () => {
    const capture = vi.fn()
    const slot = makeSlot({ disabled: true, screenshot: { capture, available: true, busy: false } })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot} placeholder="Reply..." />)
    const btn = screen.getByLabelText("screenshot.button")
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(capture).not.toHaveBeenCalled()
  })

  it("shows a spinner and blocks clicks while a capture is in flight", () => {
    const capture = vi.fn()
    const slot = makeSlot({ screenshot: { capture, available: true, busy: true } })
    render(<ChatInput value="" onChange={vi.fn()} onSend={vi.fn()} attachments={slot} placeholder="Reply..." />)
    const btn = screen.getByLabelText("screenshot.button")
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(capture).not.toHaveBeenCalled()
  })
})
