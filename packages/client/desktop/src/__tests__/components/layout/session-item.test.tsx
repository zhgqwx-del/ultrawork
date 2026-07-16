import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"

import { SessionItem } from "@/components/layout/left-sidebar"

// SessionItem takes `t` as a prop and uses no context hooks, so it renders in
// isolation. This `t` returns templates for the relative-time keys so we can
// assert the exact tooltip text.
const t = (key: string): string => {
  const map: Record<string, string> = {
    "time.justNow": "just now",
    "time.mAgo": "{n}m ago",
    "time.hAgo": "{n}h ago",
    "time.dAgo": "{n}d ago",
  }
  return map[key] ?? key
}

const baseProps = {
  isUnread: false,
  isActive: false,
  isRunning: false,
  isPinned: false,
  onNavigate: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onTogglePin: vi.fn(),
  t,
}

function makeSession(title: string, minutesAgo = 5) {
  const updated = Date.now() - minutesAgo * 60_000
  return { id: "sess-abcdef12", title, time: { created: updated, updated } }
}

describe("SessionItem", () => {
  it("renders a single line — the relative time is NOT shown as visible text", () => {
    render(<SessionItem session={makeSession("My session")} {...baseProps} />)
    // Title is visible…
    expect(screen.getByText("My session")).toBeInTheDocument()
    // …but the old second-line relative time is gone from the visible DOM.
    expect(screen.queryByText("5m ago")).toBeNull()
  })

  it("exposes the full title + relative time on the row's hover tooltip", () => {
    const { container } = render(<SessionItem session={makeSession("My session")} {...baseProps} />)
    const row = container.firstChild as HTMLElement
    expect(row.getAttribute("title")).toBe("My session\n5m ago")
  })

  it("caps a very long title in the tooltip so it stays readable on hover", () => {
    const longTitle = "x".repeat(100)
    const { container } = render(<SessionItem session={makeSession(longTitle)} {...baseProps} />)
    const row = container.firstChild as HTMLElement
    const tooltip = row.getAttribute("title") ?? ""
    // First line is capped to 60 chars + ellipsis (not the full 100)…
    expect(tooltip).toBe(`${"x".repeat(60)}…\n5m ago`)
    expect(tooltip).not.toContain("x".repeat(61))
    // …while the visible title element still carries the full string (CSS truncates it).
    expect(screen.getByText(longTitle)).toBeInTheDocument()
  })

  it("keeps the team leader badge on the (single) title line", () => {
    render(
      <SessionItem
        session={makeSession("Team lead")}
        teamEntry={{ title: "Team lead", members: [{ id: "a" }, { id: "b" }] } as never}
        {...baseProps}
      />,
    )
    expect(screen.getByText("team.badge")).toBeInTheDocument()
    expect(screen.getByText("Team lead")).toBeInTheDocument()
  })
})
