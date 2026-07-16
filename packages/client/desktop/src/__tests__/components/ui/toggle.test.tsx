import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { Toggle } from "@/components/ui/toggle"

// ADR-058 D1: boolean settings render as role="switch" (not checkbox).
describe("Toggle", () => {
  it("exposes switch semantics reflecting checked", () => {
    render(<Toggle checked onChange={() => {}} aria-label="sound" />)
    const sw = screen.getByRole("switch")
    expect(sw).toHaveAttribute("aria-checked", "true")
  })

  it("fires onChange with the flipped value on click", () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} aria-label="sound" />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("does not fire onChange when disabled", () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled aria-label="sound" />)
    fireEvent.click(screen.getByRole("switch"))
    expect(onChange).not.toHaveBeenCalled()
  })
})
