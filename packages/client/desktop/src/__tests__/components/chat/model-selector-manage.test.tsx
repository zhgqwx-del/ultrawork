import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"

const h = vi.hoisted(() => ({ getProviders: vi.fn(() => Promise.resolve([])) }))

vi.mock("@/lib/use-api", () => ({ useApi: () => ({ getProviders: h.getProviders }) }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))

import { ModelSelector, clearModelCache } from "@/components/chat/model-selector"

beforeEach(() => {
  vi.clearAllMocks()
  clearModelCache() // reset the module-level TTL cache between tests
})

describe("ModelSelector manage entry (deep-link wiring)", () => {
  it("invokes onOpenModelDialog when the manage button is clicked", async () => {
    const onOpenModelDialog = vi.fn()
    render(
      <ModelSelector
        currentModel="openai/gpt-4"
        onModelChange={vi.fn()}
        onOpenModelDialog={onOpenModelDialog}
      />
    )
    // Open the popover (the manage button lives in the popover content)
    fireEvent.click(screen.getByRole("button"))
    const manage = await screen.findByText("model.manage")
    fireEvent.click(manage)
    expect(onOpenModelDialog).toHaveBeenCalledTimes(1)
  })

  it("omits the manage button when no onOpenModelDialog is provided", async () => {
    render(<ModelSelector currentModel="openai/gpt-4" onModelChange={vi.fn()} />)
    fireEvent.click(screen.getByRole("button"))
    // wait for the popover to settle on its empty state, then assert no manage entry
    await screen.findByText("model.noModels")
    expect(screen.queryByText("model.manage")).toBeNull()
  })
})
