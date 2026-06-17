import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// vi.mock factories are hoisted above top-level vars, so the mock state lives
// in a vi.hoisted() block that the factories can safely reference.
const h = vi.hoisted(() => ({
  setModel: vi.fn(),
  currentModel: { value: "" },
  getProviders: vi.fn(),
  getProviderAuth: vi.fn(),
  putProviderAuth: vi.fn(() => Promise.resolve()),
  patchConfig: vi.fn(() => Promise.resolve()),
  clearModelCache: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock("@/lib/model-context", () => ({
  useModel: () => ({ currentModel: h.currentModel.value, setModel: h.setModel }),
}))
vi.mock("@/lib/use-api", () => ({
  useApi: () => ({
    getProviders: h.getProviders,
    getProviderAuth: h.getProviderAuth,
    putProviderAuth: h.putProviderAuth,
    patchConfig: h.patchConfig,
  }),
}))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
// Mock the model-selector module so importing ModelsSection does not pull in the
// radix Popover; we only assert that clearModelCache fires on save.
vi.mock("@/components/chat/model-selector", () => ({ clearModelCache: h.clearModelCache }))
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }))

import { ModelsSection } from "@/components/settings/models-section"

const PROVIDERS = [
  {
    id: "openai",
    name: "OpenAI",
    env: ["OPENAI_API_KEY"],
    connected: ["gpt-4"],
    models: [{ id: "gpt-4", name: "GPT-4", cost: { input: 5, output: 15 } }],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    env: ["ANTHROPIC_API_KEY"],
    connected: [], // not connected → hidden from the list view
    models: [{ id: "claude", name: "Claude" }],
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  h.currentModel.value = ""
  h.getProviders.mockResolvedValue(PROVIDERS)
  h.getProviderAuth.mockResolvedValue([{ id: "openai", name: "OpenAI", set: true }])
})

describe("ModelsSection", () => {
  it("does not flash the empty state before the first fetch resolves", async () => {
    // Regression: `loading` must start true, otherwise the empty ("no providers")
    // state renders for one frame on mount.
    render(<ModelsSection />)
    expect(screen.queryByText("model.noProviders")).toBeNull()
    // let the mount fetch settle so the update is flushed inside act()
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
  })

  it("renders connected providers and hides providers with no connected models", async () => {
    render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    // Anthropic has connected: [] → filtered out of the list view
    expect(screen.queryByText("Anthropic")).toBeNull()
  })

  it("selecting a model calls setModel with the full provider/model id", async () => {
    render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    // Provider rows start collapsed — expand by clicking the header
    fireEvent.click(screen.getByText("OpenAI"))
    fireEvent.click(await screen.findByText("GPT-4"))
    expect(h.setModel).toHaveBeenCalledWith("openai/gpt-4")
  })

  it("configure flow saves a provider's API key and invalidates the model cache", async () => {
    const { container } = render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())

    // Enter the configure view via the header button
    fireEvent.click(screen.getByRole("button", { name: /model\.configureProvider/ }))

    // Step 1: pick a provider from the full registry (Anthropic is selectable here)
    fireEvent.click(await screen.findByText("Anthropic"))

    // Step 2: fill the API key and save
    const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement
    expect(keyInput).not.toBeNull()
    fireEvent.change(keyInput, { target: { value: "sk-test-123" } })
    fireEvent.click(screen.getByRole("button", { name: "button.save" }))

    await waitFor(() => expect(h.putProviderAuth).toHaveBeenCalledWith("anthropic", "sk-test-123"))
    expect(h.clearModelCache).toHaveBeenCalled()
    // After a successful save we return to the list view
    await waitFor(() => expect(screen.getByText("model.dialogTitle")).toBeInTheDocument())
  })

  it("does not write a base URL when the field is left empty", async () => {
    const { container } = render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /model\.configureProvider/ }))
    fireEvent.click(await screen.findByText("Anthropic"))
    const keyInput = container.querySelector('input[type="password"]') as HTMLInputElement
    fireEvent.change(keyInput, { target: { value: "sk-only-key" } })
    fireEvent.click(screen.getByRole("button", { name: "button.save" }))
    await waitFor(() => expect(h.putProviderAuth).toHaveBeenCalled())
    expect(h.patchConfig).not.toHaveBeenCalled()
  })
})
