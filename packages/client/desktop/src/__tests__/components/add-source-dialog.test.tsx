// Regression: AddSourceDialog used to carry its own private `kbFetch` with a
// hardcoded `http://localhost:4098/kb` and no Authorization header. When the
// knowledge sidecar's port became dynamic and its routes required Basic auth
// (ADR-045), only `use-knowledge-base.ts` was migrated — so every "add knowledge
// source" flow started 401-ing against a port that may not even exist.
//
// Both copies now share `lib/kb-client.ts`. These tests drive the dialog's real
// network path and assert it goes through that client, credentials and all.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))

import { AddSourceDialog } from "@/components/knowledge/add-source-dialog"
import { __setSidecarCredentialsForTest } from "@/lib/sidecar-auth"
import { __resetSidecarPortsForTest } from "@/lib/sidecar-ports"

const CREDS = { username: "opencode", password: "s3cret" }
const EXPECTED = `Basic ${btoa("opencode:s3cret")}`

const fetchMock = vi.fn()

function renderDialog() {
  return render(
    <AddSourceDialog open onOpenChange={() => {}} onAdded={() => {}} onAddLocalFolder={() => {}} />,
  )
}

describe("AddSourceDialog — knowledge sidecar client", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 1, ok: true }),
    })
    vi.stubGlobal("fetch", fetchMock)
    __resetSidecarPortsForTest()
    __setSidecarCredentialsForTest(CREDS)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    __setSidecarCredentialsForTest(null)
  })

  /** Walk to the IMA credential step and hit "test connection". */
  async function triggerImaRequest() {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByText("knowledge.imaKnowledge"))
    // The apiKey field is a password input, so it has no `textbox` role.
    await waitFor(() => expect(document.querySelectorAll("input").length).toBeGreaterThanOrEqual(2))
    const inputs = Array.from(document.querySelectorAll("input"))
    await user.type(inputs[0], "client-id")
    await user.type(inputs[1], "api-key")
    await user.click(screen.getByText("knowledge.testConnection"))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  }

  it("sends Authorization on the source it creates", async () => {
    await triggerImaRequest()
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe(EXPECTED)
  })

  // The port half of the regression: it must resolve through sidecar-ports, not a
  // hardcoded :4098. (DEV → the relative Vite proxy path.)
  it("targets the resolved knowledge base URL, never a hardcoded port", async () => {
    await triggerImaRequest()
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe("/kb/sources")
    expect(url).not.toContain("4098")
  })

  // The negative direction: a client that always attached some header would pass above.
  it("omits Authorization when no credential is loaded", async () => {
    __setSidecarCredentialsForTest(null)
    await triggerImaRequest()
    const [, init] = fetchMock.mock.calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})
