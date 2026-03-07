import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { PermissionDock } from "@/components/chat/permission-dock"
import type { PermissionRequest } from "@agent/api-client"

// Mock i18n
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "permission.title": "Permission Required",
        "permission.description": "The agent needs your permission to proceed.",
        "permission.allowOnce": "Allow Once",
        "permission.allowAlways": "Always Allow",
        "permission.reject": "Reject",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

const mockRequest: PermissionRequest = {
  id: "perm-1",
  sessionID: "s1",
  permission: "bash",
  patterns: ["rm -rf /tmp/*"],
  metadata: {},
  always: [],
}

describe("PermissionDock", () => {
  it("renders permission title with label", () => {
    render(<PermissionDock request={mockRequest} onReply={vi.fn()} />)
    // Title is "Permission Required — Bash Command" (combined in one span)
    expect(screen.getByText(/Permission Required/)).toBeInTheDocument()
    expect(screen.getByText(/Bash Command/)).toBeInTheDocument()
  })

  it("renders permission description", () => {
    render(<PermissionDock request={mockRequest} onReply={vi.fn()} />)
    expect(
      screen.getByText("The agent needs your permission to proceed.")
    ).toBeInTheDocument()
  })

  it("renders patterns as code", () => {
    render(<PermissionDock request={mockRequest} onReply={vi.fn()} />)
    expect(screen.getByText("rm -rf /tmp/*")).toBeInTheDocument()
  })

  it("calls onReply with 'once' when Allow Once clicked", () => {
    const onReply = vi.fn()
    render(<PermissionDock request={mockRequest} onReply={onReply} />)
    fireEvent.click(screen.getByText("Allow Once"))
    expect(onReply).toHaveBeenCalledWith("once")
  })

  it("calls onReply with 'always' when Always Allow clicked", () => {
    const onReply = vi.fn()
    render(<PermissionDock request={mockRequest} onReply={onReply} />)
    fireEvent.click(screen.getByText("Always Allow"))
    expect(onReply).toHaveBeenCalledWith("always")
  })

  it("calls onReply with 'reject' when Reject clicked", () => {
    const onReply = vi.fn()
    render(<PermissionDock request={mockRequest} onReply={onReply} />)
    fireEvent.click(screen.getByText("Reject"))
    expect(onReply).toHaveBeenCalledWith("reject")
  })

  it("renders three action buttons", () => {
    render(<PermissionDock request={mockRequest} onReply={vi.fn()} />)
    expect(screen.getByText("Reject")).toBeInTheDocument()
    expect(screen.getByText("Always Allow")).toBeInTheDocument()
    expect(screen.getByText("Allow Once")).toBeInTheDocument()
  })

  it("renders multiple patterns", () => {
    const multiPatternRequest: PermissionRequest = {
      ...mockRequest,
      patterns: ["pattern1", "pattern2", "pattern3"],
    }
    render(<PermissionDock request={multiPatternRequest} onReply={vi.fn()} />)
    expect(screen.getByText("pattern1")).toBeInTheDocument()
    expect(screen.getByText("pattern2")).toBeInTheDocument()
    expect(screen.getByText("pattern3")).toBeInTheDocument()
  })

  it("uses permission string for unknown permission type", () => {
    const unknownRequest: PermissionRequest = {
      ...mockRequest,
      permission: "custom_perm",
    }
    render(<PermissionDock request={unknownRequest} onReply={vi.fn()} />)
    expect(screen.getByText(/custom_perm/)).toBeInTheDocument()
  })
})
