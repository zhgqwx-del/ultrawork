import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ExecutionStatus } from "@/components/chat/execution-status"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "message.executionWorking": "Working on it...",
        "message.executionDone": "Execution complete",
        "message.executionError": "Execution failed",
        "message.stopExecution": "Stop",
        "message.executionStopped": "Execution stopped",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

describe("ExecutionStatus", () => {
  it("renders 'working' state with text", () => {
    render(<ExecutionStatus state="working" />)
    expect(screen.getByText("Working on it...")).toBeInTheDocument()
  })

  it("renders 'working' state with stop button when onStop provided", () => {
    const onStop = vi.fn()
    render(<ExecutionStatus state="working" onStop={onStop} />)
    // Stop button contains Square icon + "Stop" text
    const stopBtn = screen.getByText("Stop").closest("button")!
    expect(stopBtn).toBeInTheDocument()

    // pointerdown, not click: the button shifts on streaming reflows, which
    // can swallow a full click (down+up on the same element) mid-stream.
    fireEvent.pointerDown(stopBtn)
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("renders 'done' state with success text", () => {
    render(<ExecutionStatus state="done" />)
    expect(screen.getByText("Execution complete")).toBeInTheDocument()
  })

  it("renders 'error' state with default error text", () => {
    render(<ExecutionStatus state="error" />)
    expect(screen.getByText("Execution failed")).toBeInTheDocument()
  })

  it("renders 'error' state with custom error message", () => {
    render(
      <ExecutionStatus state="error" errorMessage="API connection timeout" />
    )
    expect(screen.getByText("API connection timeout")).toBeInTheDocument()
  })

  it("renders 'stopped' state with stopped text", () => {
    render(<ExecutionStatus state="stopped" />)
    expect(screen.getByText("Execution stopped")).toBeInTheDocument()
  })

  it("does not show stop button when onStop not provided", () => {
    render(<ExecutionStatus state="working" />)
    // Only "Working on it..." text, no button
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
