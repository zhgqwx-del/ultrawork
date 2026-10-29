import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { DEFAULT_BRAND } from "@agent/brand"
import { StartupBlocked } from "@/components/startup-blocked"

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(null))
vi.mock("@tauri-apps/api/core", () => ({ invoke }))

describe("blocked startup diagnostics", () => {
  beforeEach(() => { invoke.mockClear() })
  it("renders without business providers or any native call", () => {
    render(<StartupBlocked status={{ state: "blocked", brand: DEFAULT_BRAND, reason: "Another owner is active", paths: { appRoot: "/test/.ultrawork" } }} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Another owner is active")
    expect(screen.getByRole("alert")).toHaveTextContent("/test/.ultrawork")
    expect(screen.queryByRole("textbox")).toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })
  it("exits through the dedicated blocked-state command", () => {
    render(<StartupBlocked status={{ state: "blocked", brand: DEFAULT_BRAND, reason: "Identity mismatch" }} />)
    fireEvent.click(screen.getByRole("button", { name: "Quit" }))
    expect(invoke).toHaveBeenCalledExactlyOnceWith("exit_startup_blocked")
  })
  it("offers selectable diagnostics when clipboard access is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true })
    render(<StartupBlocked status={{ state: "blocked", brand: DEFAULT_BRAND, reason: "Identity mismatch" }} />)
    fireEvent.click(screen.getByRole("button", { name: "Copy diagnostics" }))
    expect(screen.getByText("Could not copy. Select the diagnostic text below.")).toBeInTheDocument()
    expect(invoke).not.toHaveBeenCalled()
  })
})
