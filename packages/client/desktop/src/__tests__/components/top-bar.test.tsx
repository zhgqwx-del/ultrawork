import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

vi.mock("@/components/layout/sidebar-context", () => ({
  useSidebar: () => ({ toggleLeft: vi.fn() }),
}))
vi.mock("@/components/layout/drag-region", () => ({ handleDrag: vi.fn() }))

import { TopBar } from "@/components/layout/top-bar"

describe("TopBar back button", () => {
  it("renders a Back button only when onBack is provided and fires it on click", () => {
    const onBack = vi.fn()
    render(<TopBar title="Settings" onBack={onBack} onClose={vi.fn()} hideSidebarToggle />)

    const back = screen.getByLabelText("Back")
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it("omits the Back button when onBack is absent", () => {
    render(<TopBar title="Settings" onClose={vi.fn()} hideSidebarToggle />)
    expect(screen.queryByLabelText("Back")).toBeNull()
  })
})
