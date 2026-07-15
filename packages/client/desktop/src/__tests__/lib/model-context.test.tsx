/**
 * Integration test for the free-trial consent flow wired through the real ModelProvider
 * (ADR-057 P3). The pure decision logic is covered in free-model.test.ts / free-trial.test.ts;
 * this exercises the actual provider: gate → card → enable → seed → auto-resume, plus revoke.
 * Boundaries (api-client, Tauri invoke, i18n, the dialog's Radix internals) are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"

const h = vi.hoisted(() => ({
  getConfig: vi.fn(),
  patchConfig: vi.fn(() => Promise.resolve({})),
  getProviders: vi.fn(),
  patchGlobalConfig: vi.fn(() => Promise.resolve({})),
  getGlobalConfig: vi.fn(() => Promise.resolve({})),
  invoke: vi.fn(),
  navigate: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}))

// Return a STABLE object (like the real useApi, whose ref only changes on config/workspace
// change) — a fresh object each render would make ModelProvider's `[api]` mount effect thrash
// and re-fetch consent, masking real behavior.
const apiStub = {
  getConfig: h.getConfig,
  patchConfig: h.patchConfig,
  getProviders: h.getProviders,
  patchGlobalConfig: h.patchGlobalConfig,
  getGlobalConfig: h.getGlobalConfig,
}
vi.mock("@/lib/use-api", () => ({ useApi: () => apiStub }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("sonner", () => ({ toast: { error: h.toastError, info: h.toastInfo, success: vi.fn(), message: vi.fn() } }))
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }))
// Dynamic import target for "use my own key" navigation.
vi.mock("@/router", () => ({ router: { navigate: h.navigate } }))
// Replace the Radix dialog with a minimal double exposing the two actions when open.
vi.mock("@/components/chat/free-trial-consent-dialog", () => ({
  FreeTrialConsentDialog: ({ open, onEnable, onUseOwnKey }: { open: boolean; onEnable: () => void; onUseOwnKey: () => void }) =>
    open ? (
      <div data-testid="card">
        <button data-testid="enable" onClick={onEnable}>enable</button>
        <button data-testid="ownkey" onClick={onUseOwnKey}>ownkey</button>
      </div>
    ) : null,
}))

import { ModelProvider, useModel } from "@/lib/model-context"

const retry = vi.fn()

function Harness() {
  const { currentModel, freeTrialConsent, maybeOfferFreeTrial, revokeFreeTrial } = useModel()
  return (
    <div>
      <div data-testid="model">{currentModel}</div>
      <div data-testid="consent">{String(freeTrialConsent)}</div>
      <button data-testid="gate" onClick={() => { void maybeOfferFreeTrial(retry) }}>gate</button>
      <button data-testid="revoke" onClick={() => { void revokeFreeTrial() }}>revoke</button>
    </div>
  )
}

function zenFreeProviders() {
  return [{ id: "opencode", name: "OpenCode Zen", connected: ["big-pickle"], models: [{ id: "big-pickle", name: "Big Pickle", cost: { input: 0 } }] }]
}

async function renderProvider() {
  const r = render(<ModelProvider><Harness /></ModelProvider>)
  // Let the mount effects (getConfig / getConsent) settle.
  await act(async () => { await Promise.resolve() })
  return r
}

beforeEach(() => {
  vi.clearAllMocks()
  h.getConfig.mockResolvedValue({})
  h.getGlobalConfig.mockResolvedValue({})
  h.patchGlobalConfig.mockResolvedValue({})
  h.patchConfig.mockResolvedValue({})
  // Default consent flag = not consented.
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "get_free_trial_consent") return Promise.resolve({ consented: false })
    return Promise.resolve(undefined)
  })
})

describe("ModelProvider free-trial gate", () => {
  it("opens the consent card on a fresh install and does NOT dispatch", async () => {
    h.getProviders.mockResolvedValue(zenFreeProviders())
    await renderProvider()

    fireEvent.click(screen.getByTestId("gate"))
    await waitFor(() => expect(screen.getByTestId("card")).toBeTruthy())
    expect(retry).not.toHaveBeenCalled() // dispatch was aborted
  })

  it("does not open the card when a real (non-free) provider is connected", async () => {
    h.getProviders.mockResolvedValue([
      ...zenFreeProviders(),
      { id: "anthropic", name: "Anthropic", connected: ["claude-sonnet-5"], models: [{ id: "claude-sonnet-5", name: "Claude", cost: { input: 3 } }] },
    ])
    await renderProvider()

    fireEvent.click(screen.getByTestId("gate"))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId("card")).toBeNull()
  })

  it("does not open the card once already consented", async () => {
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "get_free_trial_consent" ? Promise.resolve({ consented: true, seededModel: "opencode/big-pickle" }) : Promise.resolve(undefined),
    )
    h.getProviders.mockResolvedValue(zenFreeProviders())
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId("consent").textContent).toBe("true"))

    fireEvent.click(screen.getByTestId("gate"))
    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId("card")).toBeNull()
  })

  it("enabling seeds model + small_model, records consent, and resumes the send", async () => {
    h.getProviders.mockResolvedValue(zenFreeProviders())
    await renderProvider()

    fireEvent.click(screen.getByTestId("gate"))
    await waitFor(() => screen.getByTestId("card"))
    await act(async () => { fireEvent.click(screen.getByTestId("enable")) })

    await waitFor(() => {
      expect(h.patchGlobalConfig).toHaveBeenCalledWith({ model: "opencode/big-pickle", small_model: "opencode/big-pickle" })
    })
    expect(h.invoke).toHaveBeenCalledWith("set_free_trial_consent", { seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" })
    expect(retry).toHaveBeenCalledTimes(1) // auto-resume
    await waitFor(() => expect(screen.getByTestId("model").textContent).toBe("opencode/big-pickle"))
    expect(screen.queryByTestId("card")).toBeNull()
  })

  it("post-consent retry re-enters the gate WITHOUT re-opening the card (stale-closure regression)", async () => {
    // The real retry closure re-invokes maybeOfferFreeTrial from a render captured BEFORE consent.
    // If the gate read state instead of refs, it would still see ""/false and re-open the card,
    // and the first message would never send. Here the retry re-enters the gate and we assert it
    // now returns false (lets the send through).
    h.getProviders.mockResolvedValue(zenFreeProviders())
    let gate: ((r: () => void) => Promise<boolean>) | null = null
    let reentryResult: boolean | null = null
    function Capture() {
      const { maybeOfferFreeTrial } = useModel()
      gate = maybeOfferFreeTrial
      return null
    }
    render(<ModelProvider><Capture /><Harness /></ModelProvider>)
    await act(async () => { await Promise.resolve() })

    // Open the card; the retry simulates handleSend re-entering the same gate closure.
    await act(async () => {
      await gate!(() => { void gate!(() => {}).then((r) => { reentryResult = r }) })
    })
    await waitFor(() => screen.getByTestId("card"))

    // Click enable → seeds, syncs refs, fires retry → retry re-enters gate.
    await act(async () => { fireEvent.click(screen.getByTestId("enable")) })

    await waitFor(() => expect(reentryResult).toBe(false)) // gate let the send through, no re-open
    expect(screen.queryByTestId("card")).toBeNull()
  })

  it("'use my own key' closes the card and navigates to Settings → Models", async () => {
    h.getProviders.mockResolvedValue(zenFreeProviders())
    await renderProvider()
    fireEvent.click(screen.getByTestId("gate"))
    await waitFor(() => screen.getByTestId("card"))

    await act(async () => { fireEvent.click(screen.getByTestId("ownkey")) })
    await waitFor(() => expect(h.navigate).toHaveBeenCalledWith("/settings", { state: { section: "models" } }))
    expect(retry).not.toHaveBeenCalled()
    expect(screen.queryByTestId("card")).toBeNull()
  })
})

describe("ModelProvider revoke (with protection)", () => {
  it("clears the seeded default only when it is still ours", async () => {
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "get_free_trial_consent"
        ? Promise.resolve({ consented: true, seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" })
        : Promise.resolve(undefined),
    )
    h.getGlobalConfig.mockResolvedValue({ model: "opencode/big-pickle", small_model: "opencode/big-pickle" })
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId("consent").textContent).toBe("true"))

    await act(async () => { fireEvent.click(screen.getByTestId("revoke")) })

    await waitFor(() => expect(h.patchGlobalConfig).toHaveBeenCalledWith({ model: "", small_model: "" }))
    expect(h.invoke).toHaveBeenCalledWith("clear_free_trial_consent")
    await waitFor(() => expect(screen.getByTestId("consent").textContent).toBe("false"))
  })

  it("preserves a model the user has since chosen", async () => {
    h.invoke.mockImplementation((cmd: string) =>
      cmd === "get_free_trial_consent"
        ? Promise.resolve({ consented: true, seededModel: "opencode/big-pickle", seededSmallModel: "opencode/big-pickle" })
        : Promise.resolve(undefined),
    )
    // User later picked their own model.
    h.getGlobalConfig.mockResolvedValue({ model: "anthropic/claude-sonnet-5", small_model: "opencode/big-pickle" })
    await renderProvider()
    await waitFor(() => expect(screen.getByTestId("consent").textContent).toBe("true"))

    await act(async () => { fireEvent.click(screen.getByTestId("revoke")) })

    // Only the still-ours small_model is cleared; the user's model is untouched.
    await waitFor(() => expect(h.patchGlobalConfig).toHaveBeenCalledWith({ small_model: "" }))
    expect(h.patchGlobalConfig).not.toHaveBeenCalledWith(expect.objectContaining({ model: "" }))
  })
})
