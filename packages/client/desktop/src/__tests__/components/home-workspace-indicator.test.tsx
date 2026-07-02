import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"

// HomePage pulls in the whole app context graph — stub everything except the
// workspace indicator under test (real CopyButton, real path-utils).
const navigateSpy = vi.fn()
let workspacePath: string | null = null

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigateSpy,
  useLocation: () => ({ state: null }),
}))
vi.mock("@/lib/sessions-context", () => ({
  useSessionsContext: () => ({ createSession: vi.fn() }),
}))
vi.mock("@/lib/sse-context", () => ({
  useConnector: () => ({ prompt: vi.fn() }),
}))
vi.mock("@/lib/model-context", () => ({
  useModel: () => ({ currentModel: null, setModel: vi.fn() }),
}))
// The value must be referentially stable: HomePage has an effect keyed on
// `agents` — a fresh array per render would loop setState → render forever.
vi.mock("@/lib/agent-context", () => {
  const value = { agents: [], acpAvailable: false, bindSessionAgent: () => {} }
  return { useAgents: () => value }
})
vi.mock("@/lib/use-api", () => ({ useApi: () => ({}) }))
vi.mock("@/lib/team-sessions-context", () => ({
  useTeamSessions: () => ({ addEntry: vi.fn() }),
}))
vi.mock("@/lib/workspace-context", () => ({
  useWorkspace: () => ({ workspacePath }),
}))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (key: string) => key, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("@/components/layout/top-bar", () => ({ TopBar: () => null }))
// Mock the chat barrel WITHOUT importOriginal — evaluating the real index
// drags in the whole markdown/highlight stack. Only CopyButton stays real.
vi.mock("@/components/chat", async () => ({
  CopyButton: (await import("@/components/chat/copy-button")).CopyButton,
  ChatInput: () => null,
  ModelSelector: () => null,
  AgentSelector: () => null,
  TeamMemberSelect: () => null,
}))

import { HomePage } from "@/pages/Home"

const writeText = vi.fn(() => Promise.resolve())

beforeEach(() => {
  navigateSpy.mockClear()
  writeText.mockClear()
  Object.assign(navigator, { clipboard: { writeText } })
})

describe("HomePage workspace indicator", () => {
  it("is hidden when no workspace is confirmed", () => {
    workspacePath = null
    render(<HomePage />)
    expect(screen.queryByLabelText("home.workspace.copyHint")).toBeNull()
    expect(screen.queryByText("home.workspace.switch")).toBeNull()
  })

  it("shows the shortened path but copies the FULL path on click", async () => {
    workspacePath = "/Users/alice/ai-workspace/claude-workspace/ultrawork01/ultrawork"
    render(<HomePage />)

    // Display is folded by shortenPath (home → ~, middle segments elided)…
    const row = screen.getByLabelText("home.workspace.copyHint")
    expect(row.textContent).toBe("~/ai-workspace/.../ultrawork")
    // …and the full path is available on hover.
    expect(row).toHaveAttribute("title", workspacePath)

    // Whole-row click writes the untruncated path.
    fireEvent.click(row)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(workspacePath))
  })

  it("navigates to the workspace selector via the switch entry", () => {
    workspacePath = "/Users/alice/projects/repo"
    render(<HomePage />)
    fireEvent.click(screen.getByText("home.workspace.switch"))
    expect(navigateSpy).toHaveBeenCalledWith("/workspace")
  })
})
