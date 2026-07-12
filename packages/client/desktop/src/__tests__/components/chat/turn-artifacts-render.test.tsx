import { describe, it, expect, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { SendMessageResponse } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { AssistantTurn } from "@/components/chat/assistant-turn"

// Stub i18n to echo keys verbatim — avoids the ConfigProvider chain (the repo
// convention for render tests, see artifacts-panel-render.test.tsx).
vi.mock("@/lib/i18n-context", () => ({
  useI18n: () => ({ t: (k: string) => k, language: "en", setLanguage: () => {} }),
}))

function file(path: string, mime?: string): Artifact {
  return { type: "file", path, ...(mime ? { mime } : {}) }
}

function turn(parts: any[] = []): SendMessageResponse[] {
  return [
    {
      info: { id: "a1", sessionID: "s", role: "assistant", time: { created: 1, completed: 2 }, finish: "stop" },
      parts: [{ type: "text", text: "done" }, ...parts],
    } as unknown as SendMessageResponse,
  ]
}

function renderTurn(props: Partial<Parameters<typeof AssistantTurn>[0]> = {}) {
  return render(<AssistantTurn messages={turn()} {...props} />)
}

describe("TurnArtifacts in the transcript", () => {
  it("shows a card per artifact the turn produced", () => {
    renderTurn({ artifacts: [file("report.pdf"), file("chart.png")] })
    expect(screen.getByTestId("turn-artifacts")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /report\.pdf/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /chart\.png/ })).toBeInTheDocument()
  })

  it("routes a click into the same preview entry point the sidebar uses", async () => {
    const onArtifactClick = vi.fn()
    const artifact = file("report.pdf")
    renderTurn({ artifacts: [artifact], onArtifactClick })

    await userEvent.click(screen.getByRole("button", { name: /report\.pdf/ }))
    expect(onArtifactClick).toHaveBeenCalledWith(artifact)
  })

  // microsoft/vscode#261081: past 4–5 entries the file list stops summarising the
  // turn and starts burying it.
  it("folds beyond four, one click deep", async () => {
    const many = ["a.pdf", "b.pdf", "c.pdf", "d.pdf", "e.pdf", "f.pdf"].map((p) => file(p))
    renderTurn({ artifacts: many })

    expect(screen.queryByRole("button", { name: /e\.pdf/ })).toBeNull()
    expect(screen.queryByRole("button", { name: /f\.pdf/ })).toBeNull()

    await userEvent.click(screen.getByRole("button", { name: "artifact.moreCount" })) // "+2 more"
    expect(screen.getByRole("button", { name: /e\.pdf/ })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /f\.pdf/ })).toBeInTheDocument()
  })

  it("does not fold at four or fewer", () => {
    renderTurn({ artifacts: ["a.pdf", "b.pdf", "c.pdf", "d.pdf"].map((p) => file(p)) })
    expect(screen.getByRole("button", { name: /d\.pdf/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "artifact.moreCount" })).toBeNull()
  })

  // The scan that finds most artifacts only runs on idle, so mid-stream the list is
  // both incomplete and still moving — cards would appear and then jump to another
  // turn once the window closes.
  it("stays hidden while the turn is still streaming", () => {
    renderTurn({ artifacts: [file("report.pdf")], isStreaming: true })
    expect(screen.queryByTestId("turn-artifacts")).toBeNull()
  })

  it("renders nothing when the turn produced no artifacts", () => {
    renderTurn({ artifacts: [] })
    expect(screen.queryByTestId("turn-artifacts")).toBeNull()
  })

  // A `file` part in the answer already renders its own FileBlock immediately above
  // the strip. The same file twice, adjacent, is worse than not showing it.
  it("drops an artifact the answer already renders as a FileBlock", () => {
    const messages = turn([{ type: "file", filename: "/ws/project/chart.png", mime: "image/png", url: "" }])
    render(
      <AssistantTurn
        messages={messages}
        workspaceDir="/ws/project"
        artifacts={[file("chart.png", "image/png"), file("report.pdf")]}
      />
    )
    // report.pdf still gets a card; chart.png does not (the FileBlock has it).
    expect(screen.getByRole("button", { name: /report\.pdf/ })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /chart\.png/ })).toBeNull()
  })

  // The suffix match this replaced said "same file" for two different ones, and the
  // symptom was a card that simply wasn't there.
  it("keeps the card when the answer's FileBlock is a DIFFERENT file with the same basename", () => {
    const messages = turn([{ type: "file", filename: "/ws/project/sub/report.md", mime: "text/markdown", url: "" }])
    render(<AssistantTurn messages={messages} workspaceDir="/ws/project" artifacts={[file("report.md")]} />)
    expect(screen.getByRole("button", { name: /report\.md/ })).toBeInTheDocument()
  })
})
