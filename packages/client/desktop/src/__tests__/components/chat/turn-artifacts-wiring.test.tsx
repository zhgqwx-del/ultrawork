import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, cleanup, within } from "@testing-library/react"
import type { SendMessageResponse } from "@agent/api-client"
import { MessageList } from "@/components/chat/message-list"
import { useSessionArtifacts } from "@/lib/use-session-artifacts"

const invokeMock = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: any[]) => invokeMock(...args) }))
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: () => {} }),
}))

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

const WS = "/ws/project"

function user(id: string, created: number): SendMessageResponse {
  return {
    info: { id, sessionID: "s", role: "user", time: { created } },
    parts: [{ type: "text", text: "go" }],
  } as unknown as SendMessageResponse
}

function assistant(id: string, created: number, completed: number): SendMessageResponse {
  return {
    info: { id, sessionID: "s", role: "assistant", time: { created, completed }, finish: "stop" },
    parts: [{ type: "text", text: `answer ${id}` }],
  } as unknown as SendMessageResponse
}

/**
 * The real pairing the Session page mounts: the hook derives, MessageList renders.
 *
 * The unit tests call `attributeArtifactsToTurns` directly, which means they would
 * stay green if the hook stopped returning `byTurn` or MessageList stopped passing
 * it down. This drives the actual chain — Session's two lines of wiring included —
 * so a broken hand-off shows up as a missing card rather than a silent pass.
 */
function Transcript({ messages }: { messages: SendMessageResponse[] }) {
  const { byTurn } = useSessionArtifacts(messages, WS, false)
  return <MessageList messages={messages} artifactsByTurn={byTurn} />
}

describe("transcript artifact cards — end-to-end wiring", () => {
  it("puts a bash-produced file (found only by the fs scan) under the turn that wrote it", async () => {
    const messages = [
      user("u1", 1000),
      assistant("a1", 1100, 2000),
      user("u2", 10000),
      assistant("a2", 10100, 11000),
    ]
    // Neither file is named by any tool call — only the workspace scan sees them.
    // This is the common case: ADR-048 added the scan precisely because most real
    // deliverables are bash side-effects no write/edit tool ever mentions.
    invokeMock.mockResolvedValue([
      { path: `${WS}/first.pdf`, mtimeMs: 1500 }, // during turn 1
      { path: `${WS}/second.pdf`, mtimeMs: 10500 }, // during turn 2
    ])

    render(<Transcript messages={messages} />)

    await waitFor(() => expect(screen.getAllByTestId("turn-artifacts")).toHaveLength(2))
    const [firstStrip, secondStrip] = screen.getAllByTestId("turn-artifacts")

    expect(within(firstStrip).getByRole("button", { name: /first\.pdf/ })).toBeInTheDocument()
    expect(within(firstStrip).queryByRole("button", { name: /second\.pdf/ })).toBeNull()
    expect(within(secondStrip).getByRole("button", { name: /second\.pdf/ })).toBeInTheDocument()
  })

  it("shows no cards before the scan has run", () => {
    invokeMock.mockReturnValue(new Promise(() => {})) // never resolves
    render(<Transcript messages={[user("u1", 1000), assistant("a1", 1100, 2000)]} />)
    expect(screen.queryByTestId("turn-artifacts")).toBeNull()
  })

  it("moves a rewritten file's card to the later turn", async () => {
    const messages = [
      user("u1", 1000),
      assistant("a1", 1100, 2000),
      user("u2", 10000),
      assistant("a2", 10100, 11000),
    ]
    // One file, written in turn 1 and rewritten in turn 2 — the scan only ever
    // reports its LATEST mtime, which is the whole basis of last-wins.
    invokeMock.mockResolvedValue([{ path: `${WS}/report.pdf`, mtimeMs: 10500 }])

    render(<Transcript messages={messages} />)

    await waitFor(() => expect(screen.getAllByTestId("turn-artifacts")).toHaveLength(1))
    const strip = screen.getByTestId("turn-artifacts")
    expect(within(strip).getByRole("button", { name: /report\.pdf/ })).toBeInTheDocument()

    // It hangs off the SECOND turn: the preview opens what is on disk now, so the
    // card must sit next to the answer that produced that content.
    const turns = screen.getAllByText(/^answer /)
    const secondTurn = turns[1].closest("div.group")
    expect(secondTurn).toContainElement(strip)
  })
})
