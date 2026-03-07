import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ToolCallBlock } from "@/components/chat/tool-call-block"
import type { ToolState } from "@agent/api-client"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "message.toolCall": "Tool Call",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

describe("ToolCallBlock", () => {
  const pendingState: ToolState = {
    status: "pending",
    input: { command: "ls -la" },
  }

  const runningState: ToolState = {
    status: "running",
    input: { command: "npm install" },
    title: "Installing dependencies",
    time: { start: Date.now() },
  }

  const completedState: ToolState = {
    status: "completed",
    input: { command: "echo hello" },
    output: "hello",
    title: "Echo command",
    metadata: {},
    time: { start: Date.now() - 5000, end: Date.now() },
  }

  const errorState: ToolState = {
    status: "error",
    input: { command: "invalid-cmd" },
    error: "Command not found",
    time: { start: Date.now() - 1000, end: Date.now() },
  }

  it("renders tool name for pending state", () => {
    render(<ToolCallBlock tool="bash" state={pendingState} />)
    expect(screen.getByText(/bash/)).toBeInTheDocument()
  })

  it("renders title for running state", () => {
    render(<ToolCallBlock tool="bash" state={runningState} />)
    expect(screen.getByText(/Installing dependencies/)).toBeInTheDocument()
  })

  it("renders title for completed state", () => {
    render(<ToolCallBlock tool="bash" state={completedState} />)
    expect(screen.getByText(/Echo command/)).toBeInTheDocument()
  })

  it("renders error message for error state", () => {
    render(<ToolCallBlock tool="bash" state={errorState} />)
    // Click to expand if needed
    const header = screen.getByText(/bash/)
    fireEvent.click(header)
    expect(screen.getByText(/Command not found/)).toBeInTheDocument()
  })

  it("expands to show details on click", () => {
    render(<ToolCallBlock tool="bash" state={completedState} />)
    const header = screen.getByText(/Echo command/)
    fireEvent.click(header)
    // Should show input and output sections with their labels
    expect(screen.getByText("Input")).toBeInTheDocument()
    expect(screen.getByText("Output")).toBeInTheDocument()
  })

  it("renders without crashing for all states", () => {
    const { unmount: u1 } = render(<ToolCallBlock tool="bash" state={pendingState} />)
    u1()
    const { unmount: u2 } = render(<ToolCallBlock tool="bash" state={runningState} />)
    u2()
    const { unmount: u3 } = render(<ToolCallBlock tool="bash" state={completedState} />)
    u3()
    const { unmount: u4 } = render(<ToolCallBlock tool="bash" state={errorState} />)
    u4()
  })
})
