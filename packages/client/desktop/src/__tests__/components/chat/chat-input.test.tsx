import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { ChatInput } from "@/components/chat/chat-input"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "placeholder.askAnything": "Ask anything...",
        "placeholder.reply": "Reply...",
        "home.startNow": "Start Now",
        "aria.attachment": "Add attachment",
        "aria.sendMessage": "Send message",
        "aria.stopGenerating": "Stop generating",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

// Mock CommandSelector to avoid complexity
vi.mock("@/components/chat/command-selector", () => ({
  CommandSelector: () => null,
}))

describe("ChatInput", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSend: vi.fn(),
  }

  it("renders textarea", () => {
    render(<ChatInput {...defaultProps} />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("renders with custom placeholder", () => {
    render(<ChatInput {...defaultProps} placeholder="Type here..." />)
    expect(screen.getByPlaceholderText("Type here...")).toBeInTheDocument()
  })

  it("renders default placeholder", () => {
    render(<ChatInput {...defaultProps} />)
    // Default placeholder is "Ask anything..." (hardcoded default param)
    expect(screen.getByPlaceholderText("Ask anything...")).toBeInTheDocument()
  })

  it("calls onChange when typing", () => {
    const onChange = vi.fn()
    render(<ChatInput {...defaultProps} onChange={onChange} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Hello" } })
    expect(onChange).toHaveBeenCalledWith("Hello")
  })

  it("calls onSend on Enter key (not shift)", () => {
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} value="Hello" onSend={onSend} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false })
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("does NOT call onSend on Shift+Enter", () => {
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} value="Hello" onSend={onSend} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does NOT call onSend when value is empty", () => {
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} value="" onSend={onSend} />)
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does NOT call onSend when disabled", () => {
    const onSend = vi.fn()
    render(
      <ChatInput {...defaultProps} value="Hello" onSend={onSend} disabled />
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("does NOT call onSend when loading", () => {
    const onSend = vi.fn()
    render(
      <ChatInput {...defaultProps} value="Hello" onSend={onSend} loading />
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("renders send button with aria-label in reply variant", () => {
    render(<ChatInput {...defaultProps} value="Hello" variant="reply" />)
    expect(screen.getByLabelText("Send message")).toBeInTheDocument()
  })

  it("renders CTA button for home variant with ctaLabel", () => {
    render(
      <ChatInput
        {...defaultProps}
        value="Hello"
        variant="home"
        ctaLabel="Go!"
      />
    )
    expect(screen.getByText("Go!")).toBeInTheDocument()
  })

  it("renders default ctaLabel 'Start Now' for home variant", () => {
    render(
      <ChatInput
        {...defaultProps}
        value="Hello"
        variant="home"
      />
    )
    expect(screen.getByText("Start Now")).toBeInTheDocument()
  })

  it("does NOT send during IME composition", () => {
    vi.useFakeTimers()
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} value="Hello" onSend={onSend} />)
    const textarea = screen.getByRole("textbox")

    // Start composition (IME)
    fireEvent.compositionStart(textarea)
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).not.toHaveBeenCalled()

    // End composition — compositionEnd uses setTimeout(0) to delay clearing isComposing
    fireEvent.compositionEnd(textarea)
    // Flush the setTimeout so isComposing becomes false
    act(() => { vi.runAllTimers() })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSend).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
  })

  it("renders leftSlot content in reply variant", () => {
    render(
      <ChatInput
        {...defaultProps}
        variant="reply"
        leftSlot={<span data-testid="left-slot">Model</span>}
      />
    )
    expect(screen.getByTestId("left-slot")).toBeInTheDocument()
  })

  it("click send button triggers onSend", () => {
    const onSend = vi.fn()
    render(<ChatInput {...defaultProps} value="Hello" variant="reply" onSend={onSend} />)
    const sendBtn = screen.getByLabelText("Send message")
    fireEvent.click(sendBtn)
    expect(onSend).toHaveBeenCalledTimes(1)
  })

  it("send button disabled when empty", () => {
    render(<ChatInput {...defaultProps} value="" variant="reply" />)
    const sendBtn = screen.getByLabelText("Send message")
    expect(sendBtn).toBeDisabled()
  })

  it("shows a stop button instead of send while loading with onStop", () => {
    const onStop = vi.fn()
    render(<ChatInput {...defaultProps} variant="reply" loading onStop={onStop} />)
    expect(screen.queryByLabelText("Send message")).not.toBeInTheDocument()
    const stopBtn = screen.getByLabelText("message.stopExecution")
    // pointerdown so the press always lands even if surrounding content reflows.
    fireEvent.pointerDown(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("keeps the plain loading send button when onStop is absent", () => {
    render(<ChatInput {...defaultProps} variant="reply" loading />)
    const sendBtn = screen.getByLabelText("Send message")
    expect(sendBtn).toBeDisabled()
  })
})
