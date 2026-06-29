import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { PlanStep } from "@agent/api-client"
import { PlanPanel } from "@/components/session/plan-panel"

vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        "message.noPlan": "No task plan",
        "message.turnEnded": "Turn ended",
      }
      return map[key] || key
    },
    language: "en",
    setLanguage: vi.fn(),
  }),
}))

const steps = (s: Array<[string, PlanStep["status"]]>): PlanStep[] =>
  s.map(([content, status]) => ({ content, status }))

describe("PlanPanel (ADR-038)", () => {
  it("shows empty-state when there is no plan", () => {
    render(<PlanPanel steps={[]} active={false} />)
    expect(screen.getByText("No task plan")).toBeInTheDocument()
  })

  it("renders steps and an x/y count (completed + cancelled count as done)", () => {
    render(
      <PlanPanel
        steps={steps([
          ["a", "completed"],
          ["b", "cancelled"],
          ["c", "in_progress"],
          ["d", "pending"],
        ])}
        active
      />,
    )
    expect(screen.getByText("a")).toBeInTheDocument()
    expect(screen.getByText("d")).toBeInTheDocument()
    expect(screen.getByText("2 / 4")).toBeInTheDocument()
  })

  it("shows the 'turn ended' hint when not active but a step is still in_progress", () => {
    render(<PlanPanel steps={steps([["c", "in_progress"]])} active={false} />)
    expect(screen.getByText("Turn ended")).toBeInTheDocument()
  })

  it("does NOT show the 'turn ended' hint while the turn is active", () => {
    render(<PlanPanel steps={steps([["c", "in_progress"]])} active />)
    expect(screen.queryByText("Turn ended")).not.toBeInTheDocument()
  })

  it("does NOT show the hint when nothing is in_progress, even if idle", () => {
    render(<PlanPanel steps={steps([["a", "completed"], ["d", "pending"]])} active={false} />)
    expect(screen.queryByText("Turn ended")).not.toBeInTheDocument()
  })
})
