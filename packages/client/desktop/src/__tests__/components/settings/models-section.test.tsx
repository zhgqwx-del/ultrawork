import { describe, it, expect, vi, beforeEach } from "vitest"
import { StrictMode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// vi.mock factories are hoisted above top-level vars, so the mock state lives
// in a vi.hoisted() block that the factories can safely reference.
const h = vi.hoisted(() => ({
  setModel: vi.fn(),
  currentModel: { value: "" },
  workingDirectory: { value: "/ws" as string | undefined },
  getProviders: vi.fn(),
  getProviderAuth: vi.fn(),
  putProviderAuth: vi.fn(() => Promise.resolve()),
  patchConfig: vi.fn(() => Promise.resolve()),
  upsertCustomProvider: vi.fn(() => Promise.resolve()),
  deleteProviderAuth: vi.fn(() => Promise.resolve()),
  setProviderDisabled: vi.fn(() => Promise.resolve()),
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
    upsertCustomProvider: h.upsertCustomProvider,
    deleteProviderAuth: h.deleteProviderAuth,
    setProviderDisabled: h.setProviderDisabled,
    getWorkingDirectory: () => h.workingDirectory.value,
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
  h.workingDirectory.value = "/ws"
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

  // --- Custom provider ---

  const openCustomForm = async () => {
    fireEvent.click(screen.getByRole("button", { name: /model\.configureProvider/ }))
    fireEvent.click(await screen.findByRole("button", { name: /model\.customProvider\.add/ }))
  }

  it("saves a custom provider via upsertCustomProvider with the OpenAI protocol mapping", async () => {
    const { container } = render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    await openCustomForm()

    const inputs = container.querySelectorAll('input[type="text"]')
    // [0] provider id, [1] display name, [2] base url
    fireEvent.change(inputs[0], { target: { value: "my-llm" } })
    fireEvent.change(inputs[1], { target: { value: "My LLM" } })
    fireEvent.change(inputs[2], { target: { value: "https://api.example.com/v1" } })
    // model row: [3] model id, [4] model name
    fireEvent.change(inputs[3], { target: { value: "m1" } })

    fireEvent.click(screen.getByRole("button", { name: "button.save" }))

    await waitFor(() => expect(h.upsertCustomProvider).toHaveBeenCalled())
    const def = (h.upsertCustomProvider.mock.calls[0] as unknown[])[0] as {
      id: string; name: string; protocol: string; baseURL: string; models: Array<{ id: string }>
    }
    expect(def).toMatchObject({ id: "my-llm", name: "My LLM", protocol: "openai", baseURL: "https://api.example.com/v1" })
    expect(def.models[0].id).toBe("m1")
    expect(h.clearModelCache).toHaveBeenCalled()
  })

  it("rejects an invalid provider id and does not call upsertCustomProvider", async () => {
    const { container } = render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    await openCustomForm()
    const inputs = container.querySelectorAll('input[type="text"]')
    // leave id blank, fill the rest
    fireEvent.change(inputs[1], { target: { value: "My LLM" } })
    fireEvent.change(inputs[2], { target: { value: "https://api.example.com/v1" } })
    fireEvent.change(inputs[3], { target: { value: "m1" } })
    fireEvent.click(screen.getByRole("button", { name: "button.save" }))
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("model.customProvider.err.id"))
    expect(h.upsertCustomProvider).not.toHaveBeenCalled()
  })

  it("under StrictMode, save still completes the success path + clears the spinner (mountedRef reset)", async () => {
    // Regression: React StrictMode runs effects setup→cleanup→setup in dev. If the
    // mounted-guard effect only resets the ref in cleanup, the ref stays false after
    // mount → the post-await `if (!mountedRef.current) return` fires and setSaving(false)
    // is skipped → spinner spins forever. The effect setup must reset the ref to true.
    const { container } = render(
      <StrictMode>
        <ModelsSection />
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /model\.configureProvider/ }))
    fireEvent.click(await screen.findByRole("button", { name: /model\.customProvider\.add/ }))
    const inputs = container.querySelectorAll('input[type="text"]')
    fireEvent.change(inputs[0], { target: { value: "sm-llm" } })
    fireEvent.change(inputs[1], { target: { value: "SM LLM" } })
    fireEvent.change(inputs[2], { target: { value: "https://api.example.com/v1" } })
    fireEvent.change(inputs[3], { target: { value: "m1" } })
    fireEvent.click(screen.getByRole("button", { name: "button.save" }))
    // success toast only fires if the post-await guard passed (mountedRef === true)
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalled())
  })

  it("rejects a model with only context (or only output) set — requires both or neither", async () => {
    const { container } = render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    await openCustomForm()
    const texts = container.querySelectorAll('input[type="text"]')
    fireEvent.change(texts[0], { target: { value: "my-llm" } })
    fireEvent.change(texts[1], { target: { value: "My LLM" } })
    fireEvent.change(texts[2], { target: { value: "https://api.example.com/v1" } })
    fireEvent.change(texts[3], { target: { value: "m1" } }) // model id
    // fill context only, leave output empty
    const nums = container.querySelectorAll('input[type="number"]')
    fireEvent.change(nums[0], { target: { value: "8192" } })
    fireEvent.click(screen.getByRole("button", { name: "button.save" }))
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("model.customProvider.err.limitPair"))
    expect(h.upsertCustomProvider).not.toHaveBeenCalled()
  })

  it("disables the custom-provider entry when there is no active workspace", async () => {
    h.workingDirectory.value = undefined
    render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    fireEvent.click(screen.getByRole("button", { name: /model\.configureProvider/ }))
    const addBtn = await screen.findByRole("button", { name: /model\.customProvider\.add/ })
    expect(addBtn).toBeDisabled()
  })

  it("removing a custom provider needs inline confirm, then disables it and clears its key", async () => {
    h.getProviders.mockResolvedValue([
      ...PROVIDERS,
      { id: "my-llm", name: "My LLM", source: "config", env: [], connected: ["m1"], models: [{ id: "m1", name: "M1" }] },
    ])
    render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("My LLM")).toBeInTheDocument())
    // First click arms the inline confirm; nothing destructive yet.
    // (findByRole tolerates the mock's fetch-on-rerender loading flicker.)
    fireEvent.click(await screen.findByRole("button", { name: "model.customProvider.delete" }))
    expect(h.setProviderDisabled).not.toHaveBeenCalled()
    // Confirm (the Check button reuses the delete title) → performs the delete.
    fireEvent.click(await screen.findByRole("button", { name: "model.customProvider.delete" }))
    await waitFor(() => expect(h.setProviderDisabled).toHaveBeenCalledWith("my-llm", true))
    expect(h.deleteProviderAuth).toHaveBeenCalledWith("my-llm")
    expect(h.clearModelCache).toHaveBeenCalled()
  })

  it("does NOT show a delete button for a built-in provider with a baseURL override (source=config but env present)", async () => {
    h.getProviders.mockResolvedValue([
      // built-in openai given a base URL → source=config but retains models.dev env
      { id: "openai", name: "OpenAI", source: "config", env: ["OPENAI_API_KEY"], connected: ["gpt-4"], models: [{ id: "gpt-4", name: "GPT-4" }] },
    ])
    render(<ModelsSection />)
    await waitFor(() => expect(screen.getByText("OpenAI")).toBeInTheDocument())
    expect(screen.queryByRole("button", { name: "model.customProvider.delete" })).toBeNull()
    expect(screen.queryByText("model.customProvider.badge")).toBeNull()
  })
})
