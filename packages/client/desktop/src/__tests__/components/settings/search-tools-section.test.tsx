import { describe, it, expect, vi, beforeEach } from "vitest"
import { StrictMode } from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// vi.mock factories are hoisted; mock state lives in vi.hoisted() (stable refs —
// a per-render fresh object would loop effects, gotchas §13).
const h = vi.hoisted(() => ({
  getGlobalConfig: vi.fn(),
  getAuthStatus: vi.fn(),
  putProviderAuth: vi.fn(() => Promise.resolve()),
  deleteProviderAuth: vi.fn(() => Promise.resolve()),
  patchGlobalConfig: vi.fn(() => Promise.resolve({})),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  invoke: vi.fn(() => Promise.resolve({ ok: true, status: 200, message: "ok" })),
  openUrl: vi.fn(() => Promise.resolve()),
}))

// STABLE identities (gotchas §13): the component's `load` useCallback depends on
// [api, t] — a fresh object per render would re-run the mount fetch after every
// save and clobber optimistic state with the beforeEach mocks.
vi.mock("@/lib/use-api", () => {
  const api = {
    getGlobalConfig: h.getGlobalConfig,
    getAuthStatus: h.getAuthStatus,
    putProviderAuth: h.putProviderAuth,
    deleteProviderAuth: h.deleteProviderAuth,
    patchGlobalConfig: h.patchGlobalConfig,
  }
  return { useApi: () => api }
})
vi.mock("@/lib/i18n-context", () => {
  const i18n = { t: (k: string) => k, language: "en", setLanguage: () => {} }
  return { useI18n: () => i18n }
})
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: h.toastError } }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.openUrl }))
// Radix Select brings portal/pointer machinery jsdom chokes on — shim to inert
// divs; the default-provider tests assert item PRESENCE, not dropdown behavior.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value }: { children?: unknown; value?: string }) => (
    <div data-testid="select" data-value={value}>{children as never}</div>
  ),
  SelectTrigger: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: unknown }) => <div>{children as never}</div>,
  SelectItem: ({ value, children }: { value: string; children?: unknown }) => (
    <div data-testid={`select-item-${value}`}>{children as never}</div>
  ),
}))

import { SearchToolsSection } from "@/components/settings/search-tools-section"

beforeEach(() => {
  vi.clearAllMocks()
  h.getGlobalConfig.mockResolvedValue({})
  h.getAuthStatus.mockResolvedValue({ configured: false })
})

const renderLoaded = async () => {
  const utils = render(<SearchToolsSection />)
  await waitFor(() => expect(screen.getByText("tools.websearch.title")).toBeInTheDocument())
  return utils
}

/** password inputs render in KEY_PROVIDERS order: [0]=tavily, [1]=aliyun-iqs */
const keyInput = (container: HTMLElement, idx: number) =>
  container.querySelectorAll('input[type="password"]')[idx] as HTMLInputElement

describe("SearchToolsSection", () => {
  it("loads config + auth status for both providers", async () => {
    await renderLoaded()
    expect(h.getAuthStatus).toHaveBeenCalledWith("search-tavily")
    expect(h.getAuthStatus).toHaveBeenCalledWith("search-aliyun-iqs")
    // nothing configured → both cards show the not-configured chip
    expect(screen.getAllByText("tools.websearch.notConfigured")).toHaveLength(2)
  })

  it("saves a Tavily key under the search-tavily auth id and clears the input", async () => {
    const { container } = await renderLoaded()
    const input = keyInput(container, 0)
    fireEvent.change(input, { target: { value: "tvly-abc" } })
    fireEvent.click(screen.getAllByRole("button", { name: "button.save" })[0])
    await waitFor(() => expect(h.putProviderAuth).toHaveBeenCalledWith("search-tavily", "tvly-abc"))
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("tools.websearch.saved"))
    expect(input.value).toBe("")
    // card flips to configured without a reload
    expect(screen.getAllByText("tools.websearch.configured")).toHaveLength(1)
  })

  it("saves an IQS key under search-aliyun-iqs", async () => {
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 1), { target: { value: "iqs-key" } })
    fireEvent.click(screen.getAllByRole("button", { name: "button.save" })[1])
    await waitFor(() => expect(h.putProviderAuth).toHaveBeenCalledWith("search-aliyun-iqs", "iqs-key"))
  })

  it("test connection invokes test_search_provider with the entered key", async () => {
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 0), { target: { value: "tvly-abc" } })
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })[0])
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith("test_search_provider", { provider: "tavily", apiKey: "tvly-abc" }),
    )
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("tools.websearch.test.ok"))
  })

  it("maps an IQS auth failure to the dedicated hint (key ≠ DashScope, ~5min activation)", async () => {
    h.invoke.mockResolvedValueOnce({ ok: false, status: 401, message: "auth" })
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 1), { target: { value: "wrong" } })
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })[1])
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        expect.stringContaining("tools.websearch.test.authIqs"),
        expect.anything(),
      ),
    )
  })

  it("shows the IQS key≠DashScope hint on a NON-auth failure too (400/http), not only 401/403", async () => {
    // Aliyun may 400 a wrong-kind key; the disambiguation must still surface.
    h.invoke.mockResolvedValueOnce({ ok: false, status: 400, message: "http" })
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 1), { target: { value: "sk-dashscope-by-mistake" } })
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })[1])
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(
        expect.stringContaining("tools.websearch.test.authIqs"),
        expect.anything(),
      ),
    )
  })

  it("maps a network failure (status 0) to the network toast, not the IQS hint", async () => {
    h.invoke.mockResolvedValueOnce({ ok: false, status: 0, message: "network" })
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 1), { target: { value: "iqs-x" } })
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })[1])
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining("tools.websearch.test.network")),
    )
    expect(h.toastError).not.toHaveBeenCalledWith(
      expect.stringContaining("tools.websearch.test.authIqs"),
      expect.anything(),
    )
  })

  it("maps a Tavily http (non-auth) failure to the generic http toast", async () => {
    h.invoke.mockResolvedValueOnce({ ok: false, status: 500, message: "http" })
    const { container } = await renderLoaded()
    fireEvent.change(keyInput(container, 0), { target: { value: "tvly-x" } })
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })[0])
    await waitFor(() =>
      expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining("tools.websearch.test.http")),
    )
  })

  it("test button is disabled without a pasted key (stored keys never re-enter the renderer)", async () => {
    h.getAuthStatus.mockResolvedValue({ configured: true, type: "api" })
    await renderLoaded()
    for (const btn of screen.getAllByRole("button", { name: /tools\.websearch\.test$/ })) {
      expect(btn).toBeDisabled()
    }
  })

  it("master enable toggle patches experimental.websearch.enabled via global config", async () => {
    await renderLoaded()
    const enable = screen.getByRole("checkbox", { name: /tools\.websearch\.enable/ })
    fireEvent.click(enable)
    await waitFor(() =>
      expect(h.patchGlobalConfig).toHaveBeenCalledWith({ experimental: { websearch: { enabled: false } } }),
    )
  })

  it("exa opt-in lives behind the advanced fold and patches exa:true", async () => {
    await renderLoaded()
    // hidden until the advanced fold opens
    expect(screen.queryByText("tools.websearch.exa.title")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "tools.websearch.advanced" }))
    fireEvent.click(screen.getByRole("checkbox", { name: /tools\.websearch\.exa\.title/ }))
    await waitFor(() =>
      expect(h.patchGlobalConfig).toHaveBeenCalledWith({ experimental: { websearch: { exa: true } } }),
    )
  })

  it("unchecking Exa while it is the preferred provider resets provider to auto (no stale exa)", async () => {
    h.getGlobalConfig.mockResolvedValue({ experimental: { websearch: { exa: true, provider: "exa" } } })
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: "tools.websearch.advanced" }))
    // the checkbox is currently on (exa:true); unchecking it must also clear provider
    fireEvent.click(screen.getByRole("checkbox", { name: /tools\.websearch\.exa\.title/ }))
    await waitFor(() =>
      expect(h.patchGlobalConfig).toHaveBeenCalledWith({ experimental: { websearch: { exa: false, provider: "auto" } } }),
    )
  })

  it("unchecking Exa when it is NOT preferred leaves provider untouched", async () => {
    h.getGlobalConfig.mockResolvedValue({ experimental: { websearch: { exa: true, provider: "auto" } } })
    await renderLoaded()
    fireEvent.click(screen.getByRole("button", { name: "tools.websearch.advanced" }))
    fireEvent.click(screen.getByRole("checkbox", { name: /tools\.websearch\.exa\.title/ }))
    await waitFor(() =>
      expect(h.patchGlobalConfig).toHaveBeenCalledWith({ experimental: { websearch: { exa: false } } }),
    )
  })

  it("sidecar-down on mount → error+retry state (never a misleading interactive 'not configured' UI)", async () => {
    h.getGlobalConfig.mockRejectedValueOnce(new Error("ECONNREFUSED"))
    h.getAuthStatus.mockRejectedValue(new Error("ECONNREFUSED"))
    render(<SearchToolsSection />)
    await waitFor(() => expect(screen.getByText("tools.websearch.loadError")).toBeInTheDocument())
    // must NOT render the interactive provider cards / not-configured chips
    expect(screen.queryByText("tools.websearch.notConfigured")).toBeNull()
    // retry re-invokes load; recover on the second attempt
    h.getGlobalConfig.mockResolvedValue({})
    h.getAuthStatus.mockResolvedValue({ configured: false })
    fireEvent.click(screen.getByRole("button", { name: "tools.websearch.retry" }))
    await waitFor(() => expect(screen.getByText("tools.websearch.title")).toBeInTheDocument())
    expect(screen.getAllByText("tools.websearch.notConfigured")).toHaveLength(2)
  })

  it("removing a key needs the inline confirm, then deletes the auth entry", async () => {
    h.getAuthStatus.mockResolvedValue({ configured: true, type: "api" })
    await renderLoaded()
    fireEvent.click(screen.getAllByRole("button", { name: "tools.websearch.remove" })[0])
    expect(h.deleteProviderAuth).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "tools.websearch.removeConfirm" }))
    await waitFor(() => expect(h.deleteProviderAuth).toHaveBeenCalledWith("search-tavily"))
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("tools.websearch.removed"))
  })

  it("default-provider select only offers configured providers (+auto)", async () => {
    h.getAuthStatus.mockImplementation((id: string) =>
      Promise.resolve(id === "search-tavily" ? { configured: true, type: "api" } : { configured: false }),
    )
    await renderLoaded()
    expect(screen.getByTestId("select-item-auto")).toBeInTheDocument()
    expect(screen.getByTestId("select-item-tavily")).toBeInTheDocument()
    expect(screen.queryByTestId("select-item-aliyun-iqs")).toBeNull()
    expect(screen.queryByTestId("select-item-exa")).toBeNull()
  })

  it("shows the active chip when a key exists and enabled isn't false", async () => {
    h.getAuthStatus.mockImplementation((id: string) =>
      Promise.resolve(id === "search-tavily" ? { configured: true, type: "api" } : { configured: false }),
    )
    await renderLoaded()
    expect(screen.getByText("tools.websearch.active")).toBeInTheDocument()
  })

  it("hides the active chip when config disables the tool", async () => {
    h.getGlobalConfig.mockResolvedValue({ experimental: { websearch: { enabled: false } } })
    h.getAuthStatus.mockResolvedValue({ configured: true, type: "api" })
    await renderLoaded()
    expect(screen.queryByText("tools.websearch.active")).toBeNull()
  })

  it("opens the provider console via the system browser (openUrl, not <a>)", async () => {
    await renderLoaded()
    fireEvent.click(screen.getAllByRole("button", { name: /tools\.websearch\.getKey/ })[0])
    expect(h.openUrl).toHaveBeenCalledWith("https://app.tavily.com")
  })

  it("under StrictMode, saving still completes and re-enables the button (mountedRef reset)", async () => {
    render(
      <StrictMode>
        <SearchToolsSection />
      </StrictMode>,
    )
    await waitFor(() => expect(screen.getByText("tools.websearch.title")).toBeInTheDocument())
    const input = document.querySelectorAll('input[type="password"]')[0] as HTMLInputElement
    fireEvent.change(input, { target: { value: "tvly-abc" } })
    fireEvent.click(screen.getAllByRole("button", { name: "button.save" })[0])
    await waitFor(() => expect(h.toastSuccess).toHaveBeenCalledWith("tools.websearch.saved"))
  })

  it("reverts the optimistic config update when the PATCH fails", async () => {
    h.patchGlobalConfig.mockRejectedValueOnce(new Error("boom"))
    await renderLoaded()
    const enable = screen.getByRole("checkbox", { name: /tools\.websearch\.enable/ }) as HTMLInputElement
    expect(enable.checked).toBe(true)
    fireEvent.click(enable)
    await waitFor(() => expect(h.toastError).toHaveBeenCalledWith("tools.websearch.saveError"))
    expect((screen.getByRole("checkbox", { name: /tools\.websearch\.enable/ }) as HTMLInputElement).checked).toBe(true)
  })
})
