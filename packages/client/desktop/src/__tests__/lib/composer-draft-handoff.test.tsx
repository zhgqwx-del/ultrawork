/** Does the initialInput hand-off misbehave under StrictMode (which main.tsx uses)? */
import React from "react"
import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route, Outlet, useNavigate } from "react-router-dom"

const toastCalls: string[] = []
const undoActions: (() => void)[] = []
vi.mock("sonner", () => ({
  toast: {
    info: (msg: string, opts?: { action?: { onClick: () => void } }) => {
      toastCalls.push(`info:${msg}`)
      if (opts?.action) undoActions.push(opts.action.onClick)
    },
    error: (m: string) => toastCalls.push(`error:${m}`),
  },
}))
vi.mock("@/lib/sessions-context", () => ({ useSessionsContext: () => ({ createSession: vi.fn() }) }))
vi.mock("@/lib/sse-context", () => ({ useConnector: () => ({ prompt: vi.fn() }) }))
vi.mock("@/lib/model-context", () => ({
  useModel: () => ({ currentModel: null, setModel: vi.fn(), maybeOfferFreeTrial: vi.fn() }),
}))
vi.mock("@/lib/agent-context", () => {
  const v = { agents: [], acpAvailable: false, bindSessionAgent: () => {} }
  return { useAgents: () => v }
})
vi.mock("@/lib/use-api", () => ({ useApi: () => ({}) }))
vi.mock("@/lib/team-sessions-context", () => ({ useTeamSessions: () => ({ addEntry: vi.fn() }) }))
vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ workspacePath: "/ws" }) }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k, language: "en" }) }))
vi.mock("@/components/layout/top-bar", () => ({ TopBar: () => null }))
vi.mock("@/lib/use-screenshot", () => { const s = {}; return { useScreenshot: () => s } })
vi.mock("@/lib/use-attachments", () => ({
  useAttachments: (_m: unknown, store?: { items: unknown[]; setItems: (n: unknown[]) => void }) => ({
    items: store?.items ?? [], add: vi.fn(), addPaths: vi.fn(), remove: vi.fn(),
    clear: () => store?.setItems([]), blocker: null, checking: false,
    materialize: async () => ({ attachments: [], noteText: "" }),
  }),
}))
vi.mock("@/components/chat", () => ({
  ChatInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="composer" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
  CopyButton: () => null, ModelSelector: () => null,
  AgentSelector: () => null, TeamMemberSelect: () => null,
}))

import { HomePage } from "@/pages/Home"
import { DraftProvider } from "@/lib/draft-context"

function Nav() {
  const navigate = useNavigate()
  return (
    <div>
      <button onClick={() => navigate("/settings")}>go-settings</button>
      {/* Exactly what Settings does when you click "install skill". */}
      <button onClick={() => navigate("/", { state: { initialInput: "INSTALL PROMPT" } })}>
        hand-off
      </button>
      <Outlet />
    </div>
  )
}

describe("initialInput hand-off under StrictMode (real timing)", () => {
  it("replaces the draft, says so exactly once, and can hand it back", () => {
    render(
      <React.StrictMode>
        <DraftProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route element={<Nav />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/settings" element={<div data-testid="settings">s</div>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </DraftProvider>
      </React.StrictMode>,
    )
    const composer = () => screen.getByTestId("composer") as HTMLTextAreaElement
    fireEvent.change(composer(), { target: { value: "my typing" } })
    expect(composer().value).toBe("my typing")

    // Leave, then come back the way Settings brings you back.
    fireEvent.click(screen.getByText("go-settings"))
    expect(screen.queryByTestId("composer")).toBeNull()
    fireEvent.click(screen.getByText("hand-off"))

    console.log("TOASTS:", JSON.stringify(toastCalls))
    console.log("COMPOSER:", JSON.stringify(composer().value))
    expect(composer().value).toBe("INSTALL PROMPT")
    // StrictMode runs effects twice; the user must not see two toasts.
    expect(toastCalls.filter((c) => c.includes("replacedByHandoff"))).toHaveLength(1)
    // …and Undo must hand back the ORIGINAL draft, not the prompt that displaced it.
    expect(undoActions).toHaveLength(1)
    act(() => undoActions[0]())
    console.log("AFTER UNDO:", JSON.stringify(composer().value))
    expect(composer().value).toBe("my typing")
  })
})
