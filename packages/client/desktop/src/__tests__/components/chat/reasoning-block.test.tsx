import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ReasoningBlock } from "@/components/chat/reasoning-block"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "message.reasoning": "Thought Process",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

describe("ReasoningBlock", () => {
  const sampleText = "I need to think about this problem carefully..."

  it("renders the header with Brain icon and label", () => {
    render(<ReasoningBlock text={sampleText} />)
    expect(screen.getByText("Thought Process")).toBeInTheDocument()
  })

  it("starts collapsed - content not visible", () => {
    render(<ReasoningBlock text={sampleText} />)
    expect(screen.queryByText(sampleText)).not.toBeInTheDocument()
  })

  it("expands on click to show reasoning text", () => {
    render(<ReasoningBlock text={sampleText} />)
    const header = screen.getByText("Thought Process")
    fireEvent.click(header)
    expect(screen.getByText(sampleText)).toBeInTheDocument()
  })

  it("collapses again on second click", () => {
    render(<ReasoningBlock text={sampleText} />)
    const header = screen.getByText("Thought Process")

    // Expand
    fireEvent.click(header)
    expect(screen.getByText(sampleText)).toBeInTheDocument()

    // Collapse
    fireEvent.click(header)
    expect(screen.queryByText(sampleText)).not.toBeInTheDocument()
  })

  it("renders multiline text correctly", () => {
    const multiline = "Line 1\nLine 2\nLine 3"
    render(<ReasoningBlock text={multiline} />)
    const header = screen.getByText("Thought Process")
    fireEvent.click(header)
    // Text is rendered in a <p> with whitespace-pre-wrap
    expect(screen.getByText(/Line 1/)).toBeInTheDocument()
    expect(screen.getByText(/Line 2/)).toBeInTheDocument()
    expect(screen.getByText(/Line 3/)).toBeInTheDocument()
  })
})
