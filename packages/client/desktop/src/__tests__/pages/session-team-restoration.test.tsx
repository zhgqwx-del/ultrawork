import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { SessionPage } from "@/pages/Session"
import { TeamSessionsProvider, useTeamSessions } from "@/lib/team-sessions-context"
import { DraftProvider, sessionDraftKey, useDraftDispatch } from "@/lib/draft-context"
import type { TeamSessionEntry } from "@/lib/orchestration-client"

let available = false
let shortcut!: () => Promise<void>
let messageOptions: { promptOptions?: { system: string; tools: Record<string, boolean> } }
let addTeam!: (entry: TeamSessionEntry) => void
const send = vi.fn(async () => true)
const bind = vi.fn()
const noOp = () => {}
const rows: never[] = []
const sidebar = { rightOpen: false, toggleRight: noOp, setRightOpen: noOp, previewMode: "closed",
  openPreview: noOp, closePreview: noOp, togglePreviewMaximized: noOp }

vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ workspacePath: "/ws" }) }))
vi.mock("@/lib/agent-context", () => ({ useAgents: () => ({ acpAvailable: available, bindSessionAgent: bind,
  agents: [{ id: "opencode:default", name: "OpenCode" }], getSessionAgentId: () => "opencode:default" }) }))
vi.mock("@/lib/sessions-context", () => ({ useSessionsContext: () => ({
  sessions: [{ id: "existing", directory: "/ws", time: {} }], activeSessionIds: new Set(),
}) }))
vi.mock("@/lib/model-context", () => ({ useModel: () => ({ currentModel: "opencode/big-pickle",
  getCurrentModel: () => "opencode/big-pickle", setModel: noOp, maybeOfferFreeTrial: async () => false }) }))
vi.mock("@/lib/sse-context", () => ({ useConnector: () => ({ capabilitiesOf: () => ({ model: true, image: true }) }) }))
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (key: string) => key, language: "en" }) }))
vi.mock("@/lib/config-context", () => ({ useConfig: () => ({ config: {} }) }))
vi.mock("@/components/layout/sidebar-context", () => ({ useSidebar: () => sidebar }))
vi.mock("@/components/layout/top-bar", () => ({ TopBar: ({ children }: { children?: ReactNode }) => children }))
vi.mock("@/lib/use-session-messages", () => ({ useSessionMessages: (_id: string, options: typeof messageOptions) => {
  messageOptions = options
  return { messages: rows, allMessages: rows, sending: false, loading: false, streamingMessageId: null,
    stopped: false, toolCompletionCount: 0, sendMessage: send, stopGeneration: noOp, loadEarlierMessages: noOp, onScrollNearTop: noOp }
} }))
vi.mock("@/lib/use-session-plan", () => ({ useSessionPlan: () => ({ steps: rows }) }))
vi.mock("@/lib/use-session-artifacts", () => ({ useSessionArtifacts: () => ({
  ordered: rows, deliverables: rows, working: rows, settled: true, byTurn: {},
}) }))
vi.mock("@/lib/use-delegate-rows", () => ({ useDelegateRows: () => rows }))
vi.mock("@/lib/use-artifact-unread", () => ({ useArtifactUnread: () => ({ unread: 0, markSeen: noOp }) }))
vi.mock("@/lib/use-session-permission", () => ({ useSessionPermission: () => ({}) }))
vi.mock("@/lib/use-session-scroll", () => ({ useSessionScroll: () => ({
  scrollRef: { current: null }, contentRef: { current: null }, isAtBottom: true, forceScrollToBottom: noOp, jumpToBottom: noOp,
}) }))
vi.mock("@/lib/use-unread", () => ({ useMarkReadWhileOpen: () => {} }))
vi.mock("@/lib/use-attachments", () => ({ useAttachments: () => ({ items: rows, add: noOp, addPaths: noOp,
  remove: noOp, clear: noOp, blocker: null, checking: false, materialize: async () => ({ attachments: [], noteText: "" }),
}) }))
vi.mock("@/lib/use-screenshot", () => ({ useScreenshot: () => ({}) }))
vi.mock("@/components/chat", () => ({
  ChatInput: ({ value, onChange, onSend, disabled, loading, placeholder }: {
    value: string; onChange: (text: string) => void; onSend: () => Promise<void>; disabled: boolean; loading: boolean; placeholder: string
  }) => {
    shortcut = onSend
    return <><textarea value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} placeholder={placeholder} />
      <span data-testid="busy">{String(loading)}</span></>
  },
  MessageList: () => null, ModelSelector: () => null, AgentSelector: () => null, AgentAvatar: () => null,
}))
vi.mock("@/components/session", () => ({ TeamHeader: () => <div>restored Team</div>, PlanPanel: () => null,
  ArtifactsPanel: () => null, WorkspacePanel: () => null, ArtifactPreview: () => null,
}))

const team: TeamSessionEntry = { id: "existing", workspace: "/ws", leaderAgentId: "opencode:default",
  members: ["opencode:default"], createdAt: 1 }
let patchDraft!: ReturnType<typeof useDraftDispatch>["patchDraft"]
function Capture() {
  patchDraft = useDraftDispatch().patchDraft
  addTeam = useTeamSessions().addEntry
  return null
}
function App() {
  return <DraftProvider><TeamSessionsProvider><Capture /><MemoryRouter initialEntries={["/session/existing"]}>
    <Routes><Route path="/session/:id" element={<SessionPage />} /></Routes>
  </MemoryRouter></TeamSessionsProvider></DraftProvider>
}
function open() {
  const view = render(<App />)
  act(() => patchDraft(sessionDraftKey("existing"), { text: "preserved task" }))
  return view
}

beforeEach(() => { available = false; send.mockClear(); bind.mockClear() })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe("Session routing while the native Team registry restores", () => {
  it("blocks a shortcut during the cold-boot gap, then sends with restored Team instructions", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("ACP still starting"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [team] })))
    const view = open()
    await act(async () => {})
    expect(screen.getByRole("textbox")).toBeDisabled()
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "session.restoringType")
    expect(screen.getByRole("textbox")).toHaveValue("preserved task")
    expect(screen.getByTestId("busy")).toHaveTextContent("false")
    // Exercise the actual page handler independently of the disabled button:
    // stale shortcuts must not dispatch a Team as a single-agent request.
    await act(() => shortcut())
    expect(send).not.toHaveBeenCalled()
    available = true
    view.rerender(<App />)
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled())
    expect(screen.getByText("restored Team")).toBeInTheDocument()
    expect(messageOptions.promptOptions?.system).toContain("Team 的 Leader")
    expect(messageOptions.promptOptions?.tools).toEqual({ task: false })
    await act(() => shortcut())
    expect(send).toHaveBeenCalledWith("preserved task", "opencode/big-pickle", [])
  })

  it("allows single-agent sending once an authoritative empty registry arrives", async () => {
    let resolve!: (value: Response) => void
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => new Promise((yes) => { resolve = yes }))
    open()
    expect(screen.getByRole("textbox")).toBeDisabled()
    await act(async () => { resolve(new Response(JSON.stringify({ sessions: [] }))) })
    expect(screen.getByRole("textbox")).toBeEnabled()
    expect(messageOptions.promptOptions).toBeUndefined()
    await act(() => shortcut())
    expect(send).toHaveBeenCalledOnce()
  })

  it("keeps an already identified newly created Team usable while older sessions restore", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise(() => {}))
    open()
    act(() => addTeam(team))
    expect(screen.getByRole("textbox")).toBeEnabled()
    expect(messageOptions.promptOptions?.system).toContain("Team 的 Leader")
    await act(() => shortcut())
    expect(send).toHaveBeenCalledOnce()
  })
})
