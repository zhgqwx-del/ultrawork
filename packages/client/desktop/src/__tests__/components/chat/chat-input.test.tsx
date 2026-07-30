import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { useState } from "react"
import { ChatInput } from "@/components/chat/chat-input"

// Mock i18n. `t` must honour params — `placeholder.withKeyHint` interpolates the
// base placeholder, and a params-ignoring stub would leave a literal "{base}" in
// the assertions instead of failing loudly.
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) => {
      const map: Record<string, string> = {
        "placeholder.askAnything": "Ask anything...",
        "placeholder.reply": "Reply...",
        "placeholder.withKeyHint": "{base} (Shift+Enter for a new line)",
        "home.startNow": "Start Now",
        "aria.attachment": "Add attachment",
        "aria.sendMessage": "Send message",
        "aria.sendMessageHint": "Send (Enter) · Shift+Enter for a new line",
        "aria.stopGenerating": "Stop generating",
      }
      let out = map[key] || key
      for (const [k, v] of Object.entries(params ?? {})) {
        out = out.split(`{${k}}`).join(String(v))
      }
      return out
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

// Mock CommandSelector to avoid complexity
vi.mock("@/components/chat/command-selector", () => ({
  CommandSelector: () => null,
}))

/** A real controlled host: `defaultProps` pins `value`, so any test that needs the
 *  textarea's contents to actually change (i.e. anything about default editing
 *  behaviour) has to go through this instead. */
function Controlled({ onSend = vi.fn(), ...rest }: Partial<React.ComponentProps<typeof ChatInput>>) {
  const [value, setValue] = useState("")
  return <ChatInput placeholder="Reply..." {...rest} value={value} onChange={setValue} onSend={onSend} />
}

describe("ChatInput", () => {
  const defaultProps = {
    value: "",
    onChange: vi.fn(),
    onSend: vi.fn(),
    placeholder: "Ask anything...",
  }

  it("renders textarea", () => {
    render(<ChatInput {...defaultProps} />)
    expect(screen.getByRole("textbox")).toBeInTheDocument()
  })

  it("renders with custom placeholder", () => {
    // Default variant is "reply", which appends the newline hint.
    render(<ChatInput {...defaultProps} placeholder="Type here..." />)
    expect(screen.getByPlaceholderText(/^Type here\.\.\./)).toBeInTheDocument()
  })

  it("appends the newline hint in the reply variant", () => {
    render(<ChatInput {...defaultProps} variant="reply" placeholder="Reply..." />)
    expect(screen.getByPlaceholderText("Reply... (Shift+Enter for a new line)")).toBeInTheDocument()
  })

  // The negative half of the pair above, and the only thing enforcing it: Home's
  // empty state is deliberately kept free of keyboard mechanics. Without this a
  // one-line change could put the hint back on the front door unnoticed.
  it("does NOT append the newline hint in the home variant", () => {
    render(<ChatInput {...defaultProps} variant="home" placeholder="Ask anything..." />)
    expect(screen.getByPlaceholderText("Ask anything...")).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Shift\+Enter/)).not.toBeInTheDocument()
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

  // The promise the reply placeholder makes ("Shift+Enter for a new line") only holds
  // if a bare Enter NEVER inserts one — including in the states where it can't send.
  // This has to be userEvent: fireEvent.keyDown performs no default editing in jsdom,
  // so the same assertion written with it passes even with the preventDefault deleted
  // (measured — it leaves the value untouched either way).
  it("bare Enter never inserts a newline, sendable or not", async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement

    // Not sendable (empty) — Enter is swallowed, and must not leave a blank line behind.
    await user.type(textarea, "{Enter}")
    expect(textarea.value).toBe("")

    // Sendable — sends, still no newline.
    await user.type(textarea, "hi{Enter}")
    expect(textarea.value).toBe("hi")
  })

  it("Shift+Enter does insert a newline", async () => {
    const user = userEvent.setup()
    render(<Controlled />)
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement
    await user.type(textarea, "a{Shift>}{Enter}{/Shift}b")
    expect(textarea.value).toBe("a\nb")
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
