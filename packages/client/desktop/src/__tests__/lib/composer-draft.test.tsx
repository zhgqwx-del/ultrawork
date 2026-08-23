/**
 * Composer drafts survive a route change (discussions/060).
 *
 * Every case here is written so that reverting to the old implementation (local
 * `useState` in the page) turns it RED — an assertion that would also pass against a
 * composer that throws its draft away is not evidence of anything. Where a case could
 * silently measure nothing (element missing, list empty), it first asserts that it
 * measured something at all.
 */
import React from "react"
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route, Outlet, useNavigate, useParams } from "react-router-dom"
import type { Attachment } from "@/lib/attachments"

// ---------------------------------------------------------------------------------
// HomePage pulls in the whole app context graph; stub everything except the draft
// plumbing under test. Same approach as home-workspace-indicator.test.tsx.
// ---------------------------------------------------------------------------------
const createSession = vi.fn(async () => ({ id: "new-session", directory: "/ws" }))
const promptSpy = vi.fn(async () => {})
let agents: { id: string; name: string }[] = []
let acpAvailable = false
/** What the (otherwise real) attachment pipeline yields at send time. */
let materializeResult: { attachments: unknown[]; noteText: string } = { attachments: [], noteText: "" }

vi.mock("@/lib/sessions-context", () => ({ useSessionsContext: () => ({ createSession }) }))
vi.mock("@/lib/sse-context", () => ({ useConnector: () => ({ prompt: promptSpy }) }))
vi.mock("@/lib/model-context", () => ({
  useModel: () => ({ currentModel: "openai/gpt-5", setModel: vi.fn(), maybeOfferFreeTrial: vi.fn(async () => false) }),
}))
vi.mock("@/lib/agent-context", () => ({
  useAgents: () => ({ agents, acpAvailable, bindSessionAgent: vi.fn() }),
}))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({}) }))
vi.mock("@/lib/team-sessions-context", () => ({ useTeamSessions: () => ({ addEntry: vi.fn() }) }))
vi.mock("@/lib/workspace-context", () => ({ useWorkspace: () => ({ workspacePath: "/ws" }) }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: vi.fn() }),
}))
vi.mock("@/components/layout/top-bar", () => ({ TopBar: () => null }))
vi.mock("@/lib/notifications/notify-registry", () => ({
  markLocallyPrompted: vi.fn(),
  forgetLocallyPrompted: vi.fn(),
}))
interface TeamArgs {
  workspace: string
  leaderAgentId: string
  members: string[]
  systemPrompt: string
}
const createTeamSession = vi.fn(async (_opts: TeamArgs) => ({
  id: "team-session",
  workspace: "/ws",
  leaderAgentId: "build",
  members: ["build"],
}))
vi.mock("@/lib/orchestration-client", () => ({
  createTeamSession: (opts: TeamArgs) => createTeamSession(opts),
}))
vi.mock("@/lib/orchestrator-mcp", () => ({ ensureOrchestratorMcp: vi.fn(async () => {}) }))
vi.mock("@/lib/use-screenshot", () => {
  const stable = {}
  return { useScreenshot: () => stable }
})
// The attachment hook keeps its REAL storage contract (it reads and writes the injected
// store, i.e. the draft bucket) — only `materialize`, which needs a live workspace and a
// filesystem, is faked. That keeps the store wiring under test instead of stubbed out.
vi.mock("@/lib/use-attachments", () => ({
  useAttachments: (_model: unknown, store?: { items: Attachment[]; setItems: (n: Attachment[]) => void }) => ({
    items: store?.items ?? [],
    add: vi.fn(),
    addPaths: vi.fn(),
    remove: (id: string) => store?.setItems((store?.items ?? []).filter((a) => a.id !== id)),
    clear: () => store?.setItems([]),
    blocker: null,
    checking: false,
    materialize: async () => materializeResult,
  }),
}))
// Controlled composer: value/onChange come from the page, so what this renders IS the
// page's draft state.
vi.mock("@/components/chat", () => ({
  ChatInput: ({
    value,
    onChange,
    onSend,
    attachments,
    topSlot,
    leftSlot,
  }: {
    value: string
    onChange: (v: string) => void
    onSend: () => void
    attachments?: { items: Attachment[] }
    topSlot?: React.ReactNode
    leftSlot?: React.ReactNode
  }) => (
    <div>
      <textarea data-testid="composer" value={value} onChange={(e) => onChange(e.target.value)} />
      <button onClick={onSend}>send</button>
      <span data-testid="attach-count">{attachments?.items.length ?? 0}</span>
      {topSlot}
      {leftSlot}
    </div>
  ),
  CopyButton: () => null,
  ModelSelector: () => null,
  AgentSelector: ({ agentId }: { agentId?: string }) => <span data-testid="agent-id">{agentId}</span>,
  TeamMemberSelect: ({ selected }: { selected: Set<string> }) => (
    <span data-testid="members">{[...selected].sort().join(",")}</span>
  ),
}))

import { OPENCODE_DEFAULT_AGENT_ID } from "@agent/connector"
import { HomePage } from "@/pages/Home"
import {
  DraftProvider,
  HOME_DRAFT_KEY,
  sessionDraftKey,
  useDraftBucket,
  useDraftDispatch,
} from "@/lib/draft-context"

const fakeAttachment = (id: string): Attachment => ({
  id,
  kind: "image",
  mime: "image/png",
  filename: `${id}.png`,
  wireUrl: "data:image/png;base64,AAAA",
  size: 4,
})

function Nav() {
  const navigate = useNavigate()
  return (
    <div>
      <button onClick={() => navigate("/")}>go-home</button>
      <button onClick={() => navigate("/settings")}>go-settings</button>
      <Outlet />
    </div>
  )
}

function renderApp(seed?: (patch: ReturnType<typeof useDraftDispatch>["patchDraft"]) => void) {
  let patchRef: ReturnType<typeof useDraftDispatch>["patchDraft"] | null = null
  function Capture() {
    patchRef = useDraftDispatch().patchDraft
    return null
  }
  const utils = render(
    <DraftProvider>
      <Capture />
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route element={<Nav />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/settings" element={<div data-testid="settings">settings</div>} />
            <Route path="/session/:id" element={<div data-testid="session">session</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </DraftProvider>,
  )
  if (seed) act(() => seed(patchRef!))
  return utils
}

const composer = () => screen.getByTestId("composer") as HTMLTextAreaElement
const leaveAndReturn = () => {
  fireEvent.click(screen.getByText("go-settings"))
  expect(screen.getByTestId("settings")).toBeTruthy()
  // The page really unmounted — otherwise "the draft survived" would be vacuous.
  expect(screen.queryByTestId("composer")).toBeNull()
  fireEvent.click(screen.getByText("go-home"))
}

beforeEach(() => {
  agents = [
    { id: "build", name: "Build" },
    { id: "plan", name: "Plan" },
  ]
  acpAvailable = true
  materializeResult = { attachments: [], noteText: "" }
  createSession.mockClear()
  promptSpy.mockClear()
  createTeamSession.mockClear()
})

describe("Home draft survives navigation", () => {
  it("keeps the typed text across a route change", () => {
    renderApp()
    fireEvent.change(composer(), { target: { value: "写一份季度报告" } })
    expect(composer().value).toBe("写一份季度报告") // measured something

    leaveAndReturn()
    expect(composer().value).toBe("写一份季度报告")
  })

  it("keeps attachments across a route change", () => {
    renderApp((patch) => patch(HOME_DRAFT_KEY, { attachments: [fakeAttachment("a"), fakeAttachment("b")] }))
    expect(screen.getByTestId("attach-count").textContent).toBe("2")

    leaveAndReturn()
    expect(screen.getByTestId("attach-count").textContent).toBe("2")
  })

  it("keeps the task's birth configuration (mode / agent / members)", () => {
    renderApp((patch) =>
      patch(HOME_DRAFT_KEY, {
        mode: "team",
        agentId: "plan",
        memberIds: ["plan"],
        membersTouched: true,
      }),
    )
    expect(screen.getByTestId("agent-id").textContent).toBe("plan")
    expect(screen.getByTestId("members").textContent).toBe("plan")

    leaveAndReturn()
    expect(screen.getByTestId("agent-id").textContent).toBe("plan")
    // The [agents] effect used to reset this to "everyone" on every mount; `membersTouched`
    // is what stops it from swallowing the restored selection.
    expect(screen.getByTestId("members").textContent).toBe("plan")
  })
})

describe("Home reconciles a restored draft against the live world", () => {
  it("falls back to the default agent when the stored one is gone", () => {
    renderApp((patch) => patch(HOME_DRAFT_KEY, { agentId: "ghost-agent" }))
    // AgentSelector would DISPLAY agents[0] regardless; what matters is the id the page
    // would actually dispatch with, which is the one it hands the selector.
    expect(screen.getByTestId("agent-id").textContent).not.toBe("ghost-agent")
    expect(screen.getByTestId("agent-id").textContent).toBe(OPENCODE_DEFAULT_AGENT_ID)
  })

  it("drops members that no longer exist", () => {
    renderApp((patch) =>
      patch(HOME_DRAFT_KEY, { mode: "team", memberIds: ["build", "ghost-agent"], membersTouched: true }),
    )
    expect(screen.getByTestId("members").textContent).toBe("build")
  })

  it("does not erase a stored selection during the first frames, when agents is empty", () => {
    agents = []
    renderApp((patch) =>
      patch(HOME_DRAFT_KEY, { mode: "team", memberIds: ["build"], membersTouched: true }),
    )
    expect(screen.getByTestId("members").textContent).toBe("build")
  })
})

describe("Home clears the bucket only when the draft was actually sent", () => {
  it("clears after a successful send", async () => {
    renderApp()
    fireEvent.change(composer(), { target: { value: "hello" } })
    fireEvent.click(screen.getByText("send"))

    await waitFor(() => expect(promptSpy).toHaveBeenCalled())
    fireEvent.click(screen.getByText("go-home"))
    expect(composer().value).toBe("")
  })

  it("keeps the draft when nothing could be materialised (the early return)", async () => {
    // Attachment-only turn whose files all fail to materialise: the page toasts and returns
    // BEFORE clearing. Clearing here would eat the user's work in exactly the case they
    // most need it back.
    renderApp((patch) => patch(HOME_DRAFT_KEY, { attachments: [fakeAttachment("a")] }))
    expect(screen.getByTestId("attach-count").textContent).toBe("1")

    fireEvent.click(screen.getByText("send"))
    await waitFor(() => expect(createSession).toHaveBeenCalled())
    expect(promptSpy).not.toHaveBeenCalled()
    expect(screen.getByTestId("attach-count").textContent).toBe("1")
  })
})

describe("Team mode uses the same bucket as single-agent mode", () => {
  it("keeps mode, leader and members across a route change, then clears on send", async () => {
    renderApp((patch) =>
      patch(HOME_DRAFT_KEY, {
        mode: "team",
        agentId: "plan",
        memberIds: ["build", "plan"],
        membersTouched: true,
        text: "帮我做一个季度复盘",
      }),
    )
    // Team-only control is on screen ⇒ the page really is in team mode, not just storing it.
    expect(screen.getByTestId("members").textContent).toBe("build,plan")
    expect(screen.getByTestId("agent-id").textContent).toBe("plan")
    expect(composer().value).toBe("帮我做一个季度复盘")

    leaveAndReturn()
    expect(screen.getByTestId("members").textContent).toBe("build,plan")
    expect(screen.getByTestId("agent-id").textContent).toBe("plan")
    expect(composer().value).toBe("帮我做一个季度复盘")

    // The Team send path is a different function from the single-agent one — it has to
    // clear the same bucket.
    fireEvent.click(screen.getByText("send"))
    await waitFor(() => expect(createTeamSession).toHaveBeenCalled())
    // The leader roster it dispatched with is the restored one, not a default.
    expect(createTeamSession.mock.calls[0][0]).toMatchObject({
      leaderAgentId: "plan",
      members: ["build", "plan"],
    })
    fireEvent.click(screen.getByText("go-home"))
    expect(composer().value).toBe("")
  })

  it("falls back to single agent when ACP went away while the user was on another page", () => {
    acpAvailable = false
    renderApp((patch) => patch(HOME_DRAFT_KEY, { mode: "team", text: "x" }))
    // The Team-only member picker is gone ⇒ the page is in single mode, so handleTeamSend
    // (which would fail without ACP) can never be reached.
    expect(screen.queryByTestId("members")).toBeNull()
    // …and the text is still there: the fallback must not cost the draft.
    expect(composer().value).toBe("x")
  })
})

// ---------------------------------------------------------------------------------
// Per-session buckets. SessionPage itself needs ~30 mocked modules to render, so this
// binds the CONTRACT it relies on — `sessionDraftKey(id)` under a real router — rather
// than SessionPage's own wiring, which typecheck and review cover.
// ---------------------------------------------------------------------------------
function MiniSession() {
  const { id } = useParams()
  const key = sessionDraftKey(id)
  const draft = useDraftBucket(key)
  const { patchDraft } = useDraftDispatch()
  return (
    <div>
      <span data-testid="sid">{id}</span>
      <textarea
        data-testid="composer"
        value={draft.text}
        onChange={(e) => patchDraft(key, { text: e.target.value })}
      />
    </div>
  )
}

describe("Session drafts are per-session", () => {
  function SessionNav() {
    const navigate = useNavigate()
    return (
      <div>
        <button onClick={() => navigate("/session/A")}>to-A</button>
        <button onClick={() => navigate("/session/B")}>to-B</button>
        <button onClick={() => navigate("/settings")}>to-settings</button>
        <Outlet />
      </div>
    )
  }

  const renderSessions = () =>
    render(
      <DraftProvider>
        <MemoryRouter initialEntries={["/session/A"]}>
          <Routes>
            <Route element={<SessionNav />}>
              <Route path="/session/:id" element={<MiniSession />} />
              <Route path="/settings" element={<div data-testid="settings">s</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </DraftProvider>,
    )

  it("does not follow the user from session A into session B", () => {
    renderSessions()
    fireEvent.change(composer(), { target: { value: "draft-for-A" } })
    expect(composer().value).toBe("draft-for-A")

    // react-router reuses the element across a :id change (NO remount) — this is exactly
    // where a component-local draft leaked into the next session.
    fireEvent.click(screen.getByText("to-B"))
    expect(screen.getByTestId("sid").textContent).toBe("B")
    expect(composer().value).toBe("")
  })

  it("gives each session its draft back", () => {
    renderSessions()
    fireEvent.change(composer(), { target: { value: "draft-for-A" } })
    fireEvent.click(screen.getByText("to-B"))
    fireEvent.change(composer(), { target: { value: "draft-for-B" } })

    fireEvent.click(screen.getByText("to-A"))
    expect(composer().value).toBe("draft-for-A")

    // …and across a real unmount too (route change, not just a param change).
    fireEvent.click(screen.getByText("to-settings"))
    expect(screen.queryByTestId("composer")).toBeNull()
    fireEvent.click(screen.getByText("to-B"))
    expect(composer().value).toBe("draft-for-B")
  })
})

describe("DraftProvider bookkeeping", () => {
  function Probe({ id }: { id: string }) {
    const draft = useDraftBucket(id)
    return <span data-testid={`t-${id}`}>{`${draft.text}|${draft.attachments.length}`}</span>
  }
  function Harness({ ids }: { ids: string[] }) {
    return (
      <>
        {ids.map((i) => (
          <Probe key={i} id={i} />
        ))}
      </>
    )
  }

  it("isolates buckets by key", () => {
    let patch: ReturnType<typeof useDraftDispatch>["patchDraft"]
    function Capture() {
      patch = useDraftDispatch().patchDraft
      return null
    }
    render(
      <DraftProvider>
        <Capture />
        <Harness ids={[sessionDraftKey("A"), sessionDraftKey("B")]} />
      </DraftProvider>,
    )
    act(() => patch!(sessionDraftKey("A"), { text: "for-A" }))
    expect(screen.getByTestId(`t-${sessionDraftKey("A")}`).textContent).toBe("for-A|0")
    expect(screen.getByTestId(`t-${sessionDraftKey("B")}`).textContent).toBe("|0")
  })

  it("drops a bucket entirely when its session is deleted", () => {
    let patch: ReturnType<typeof useDraftDispatch>["patchDraft"]
    let drop: ReturnType<typeof useDraftDispatch>["dropDraft"]
    function Capture() {
      const d = useDraftDispatch()
      patch = d.patchDraft
      drop = d.dropDraft
      return null
    }
    render(
      <DraftProvider>
        <Capture />
        <Harness ids={[sessionDraftKey("A")]} />
      </DraftProvider>,
    )
    act(() => patch!(sessionDraftKey("A"), { text: "x", attachments: [fakeAttachment("a")] }))
    expect(screen.getByTestId(`t-${sessionDraftKey("A")}`).textContent).toBe("x|1")

    act(() => drop!(sessionDraftKey("A")))
    expect(screen.getByTestId(`t-${sessionDraftKey("A")}`).textContent).toBe("|0")
  })

  it("evicts attachments (never text) from the least-recently-touched buckets", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"].map(sessionDraftKey)
    let patch: ReturnType<typeof useDraftDispatch>["patchDraft"]
    function Capture() {
      patch = useDraftDispatch().patchDraft
      return null
    }
    render(
      <DraftProvider>
        <Capture />
        <Harness ids={ids} />
      </DraftProvider>,
    )
    // Six buckets, each with text AND a file; the cap on attachment-holding buckets is 5.
    ids.forEach((id, n) =>
      act(() => patch!(id, { text: `t${n}`, attachments: [fakeAttachment(`a${n}`)] })),
    )
    // Oldest loses its file…
    expect(screen.getByTestId(`t-${ids[0]}`).textContent).toBe("t0|0")
    // …but keeps the text, which is the part a user would have to retype.
    expect(screen.getByTestId(`t-${ids[1]}`).textContent).toBe("t1|1")
    expect(screen.getByTestId(`t-${ids[5]}`).textContent).toBe("t5|1")
  })
})
