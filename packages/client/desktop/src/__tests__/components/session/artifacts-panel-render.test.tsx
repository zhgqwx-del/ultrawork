// Render-level UX walkthrough for the artifacts panel (headless equivalent of a
// GUI走查 — plain-Chrome Playwright can't exercise these because the workspace
// scan goes through Tauri `invoke`, which has no bridge outside the real app, so
// we mock invoke and drive the component directly in jsdom).
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react"
import { ArtifactsPanel } from "@/components/session/artifacts-panel"
import type { SendMessageResponse } from "@agent/api-client"

const invokeMock = vi.fn()
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: any[]) => invokeMock(...args) }))
// Stub i18n to return keys verbatim — avoids the ConfigProvider chain; we assert
// on the raw i18n keys for group labels.
vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: () => {} }) }))

const WORKING_LABEL = "artifact.groupWorking"

function userMsg(created: number): SendMessageResponse {
  return { info: { id: `u${created}`, sessionID: "s", role: "user", time: { created } }, parts: [] } as SendMessageResponse
}
function assistant(parts: any[], created: number, completed?: number): SendMessageResponse {
  return { info: { id: `m${created}`, sessionID: "s", role: "assistant", time: { created, completed } }, parts } as SendMessageResponse
}
const writeTool = (filePath: string) => ({ type: "tool", tool: "write", state: { status: "completed", input: { filePath } } })
// A scanned file produced during a turn around t (within the turn window).
const hit = (path: string, mtimeMs: number) => ({ path, mtimeMs })

afterEach(() => {
  cleanup()
  invokeMock.mockReset()
})

describe("ArtifactsPanel — UX walkthrough", () => {
  it("across multiple turns: bash-produced file (scan) + doc are deliverables, the .py script is a collapsed working file", async () => {
    const WS = "/ws"
    invokeMock.mockResolvedValue([hit(`${WS}/report.pdf`, 1500)]) // bash side-effect during turn 1
    render(
      <ArtifactsPanel
        messages={[
          userMsg(1000),
          assistant([writeTool(`${WS}/gen.py`)], 1100, 2000), // turn 1: wrote a script
          userMsg(2500),
          assistant([writeTool(`${WS}/notes.md`)], 2600, 3000), // turn 2: wrote a doc
        ]}
        directory={WS}
        active={false}
      />,
    )

    await waitFor(() => expect(screen.getByText("report.pdf")).toBeTruthy())
    expect(screen.getByText("notes.md")).toBeTruthy()
    expect(screen.queryByText("gen.py")).toBeNull() // demoted to collapsed working group
    expect(screen.getByText(WORKING_LABEL)).toBeTruthy()
  })

  it("excludes files modified outside this session's turn windows (another session sharing the workspace)", async () => {
    const WS = "/ws"
    invokeMock.mockResolvedValue([
      hit(`${WS}/mine.csv`, 1500), // written during my turn → keep
      hit(`${WS}/other-session.pdf`, 9_000_000), // written long after my turn → another session → drop
    ])
    render(<ArtifactsPanel messages={[userMsg(1000), assistant([], 1100, 2000)]} directory={WS} active={false} />)

    await waitFor(() => expect(screen.getByText("mine.csv")).toBeTruthy())
    expect(screen.queryByText("other-session.pdf")).toBeNull()
  })

  it("expands the working-files group on click", async () => {
    const WS = "/ws"
    invokeMock.mockResolvedValue([])
    render(
      <ArtifactsPanel
        messages={[userMsg(1000), assistant([writeTool(`${WS}/a.pdf`), writeTool(`${WS}/b.py`)], 1100, 2000)]}
        directory={WS}
        active={false}
      />,
    )

    await waitFor(() => expect(screen.getByText("a.pdf")).toBeTruthy())
    expect(screen.queryByText("b.py")).toBeNull()
    fireEvent.click(screen.getByText(WORKING_LABEL))
    expect(screen.getByText("b.py")).toBeTruthy()
  })

  it("drops the previous session's scanned files when the workspace/session changes", async () => {
    invokeMock
      .mockResolvedValueOnce([hit("/wsA/out_A.csv", 1500)])
      .mockResolvedValueOnce([hit("/wsB/out_B.csv", 2500)])
    const { rerender } = render(
      <ArtifactsPanel messages={[userMsg(1000), assistant([], 1100, 2000)]} directory="/wsA" active={false} />,
    )
    await waitFor(() => expect(screen.getByText("out_A.csv")).toBeTruthy())

    // Same component instance (SessionPage isn't keyed) → different session/workspace.
    rerender(<ArtifactsPanel messages={[userMsg(2200), assistant([], 2300, 3000)]} directory="/wsB" active={false} />)
    await waitFor(() => expect(screen.getByText("out_B.csv")).toBeTruthy())
    expect(screen.queryByText("out_A.csv")).toBeNull() // no stale leak
  })

  it("Team: member D-2 artifacts classify into deliverables vs collapsed working files", async () => {
    const WS = "/ws"
    invokeMock.mockResolvedValue([]) // no fs hits — Team member files arrive via D-2 JSON
    // A Leader turn that delegated to two members; each member's files come back
    // in the delegate tool's D-2 `artifacts[]` (the Team data path, no invoke).
    const delegate = (artifacts: string[]) => ({
      type: "tool",
      tool: "orchestrator_delegate",
      state: { status: "completed", input: { agentId: "acp:x", task: "t" }, output: JSON.stringify({ artifacts }) },
    })
    render(
      <ArtifactsPanel
        messages={[
          userMsg(1000),
          assistant([delegate([`${WS}/gen_alpha.py`, `${WS}/alpha.csv`]), delegate([`${WS}/gen_beta.py`, `${WS}/beta.csv`])], 1100, 2000),
        ]}
        directory={WS}
        active={false}
      />,
    )

    // CSVs are deliverables (visible); the .py scripts are demoted to the collapsed group.
    await waitFor(() => expect(screen.getByText("alpha.csv")).toBeTruthy())
    expect(screen.getByText("beta.csv")).toBeTruthy()
    expect(screen.queryByText("gen_alpha.py")).toBeNull()
    expect(screen.queryByText("gen_beta.py")).toBeNull()
    expect(screen.getByText(WORKING_LABEL)).toBeTruthy()
    // Expand → both scripts appear.
    fireEvent.click(screen.getByText(WORKING_LABEL))
    expect(screen.getByText("gen_alpha.py")).toBeTruthy()
    expect(screen.getByText("gen_beta.py")).toBeTruthy()
  })

  it("does not scan while the agent is active (defers to idle)", async () => {
    invokeMock.mockResolvedValue([])
    render(<ArtifactsPanel messages={[userMsg(1000), assistant([], 1100)]} directory="/ws" active={true} />)
    await Promise.resolve() // let effects flush
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
