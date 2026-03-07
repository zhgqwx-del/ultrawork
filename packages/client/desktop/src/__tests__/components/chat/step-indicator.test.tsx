import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import { StepIndicator } from "@/components/chat/step-indicator"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "message.tokensInput": "In",
        "message.tokensOutput": "Out",
        "message.tokensReasoning": "Reasoning",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

describe("StepIndicator", () => {
  it("returns null when no stats available", () => {
    const { container } = render(<StepIndicator />)
    expect(container.firstChild).toBeNull()
  })

  it("displays input and output token counts", () => {
    render(
      <StepIndicator
        tokens={{ input: 500, output: 200, reasoning: 0 }}
      />
    )
    // Format is "In: 500"
    expect(screen.getByText("In: 500")).toBeInTheDocument()
    expect(screen.getByText("Out: 200")).toBeInTheDocument()
  })

  it("formats large token counts with 'k' suffix", () => {
    render(
      <StepIndicator
        tokens={{ input: 1500, output: 2300, reasoning: 0 }}
      />
    )
    expect(screen.getByText("In: 1.5k")).toBeInTheDocument()
    expect(screen.getByText("Out: 2.3k")).toBeInTheDocument()
  })

  it("shows reasoning tokens when > 0", () => {
    render(
      <StepIndicator
        tokens={{ input: 100, output: 50, reasoning: 300 }}
      />
    )
    expect(screen.getByText("Reasoning: 300")).toBeInTheDocument()
  })

  it("does not show reasoning when = 0", () => {
    render(
      <StepIndicator
        tokens={{ input: 100, output: 50, reasoning: 0 }}
      />
    )
    expect(screen.queryByText(/Reasoning/)).not.toBeInTheDocument()
  })

  it("displays cost with 4 decimal places", () => {
    render(
      <StepIndicator
        tokens={{ input: 100, output: 50, reasoning: 0 }}
        cost={0.0015}
      />
    )
    expect(screen.getByText("$0.0015")).toBeInTheDocument()
  })

  it("shows cache tokens when present", () => {
    render(
      <StepIndicator
        tokens={{
          input: 100,
          output: 50,
          reasoning: 0,
          cache: { read: 500, write: 100 },
        }}
      />
    )
    expect(screen.getByText("Cache: 500r/100w")).toBeInTheDocument()
  })

  it("shows reason when not 'stop'", () => {
    render(
      <StepIndicator
        reason="end_turn"
        tokens={{ input: 100, output: 50, reasoning: 0 }}
      />
    )
    expect(screen.getByText("(end_turn)")).toBeInTheDocument()
  })

  it("hides reason when it is 'stop'", () => {
    render(
      <StepIndicator
        reason="stop"
        tokens={{ input: 100, output: 50, reasoning: 0 }}
      />
    )
    expect(screen.queryByText(/\(stop\)/)).not.toBeInTheDocument()
  })

  it("renders with only cost (no tokens)", () => {
    render(<StepIndicator cost={0.005} />)
    expect(screen.getByText("$0.0050")).toBeInTheDocument()
  })
})
