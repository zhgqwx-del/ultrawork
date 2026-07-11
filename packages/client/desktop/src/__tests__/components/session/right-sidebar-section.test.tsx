/**
 * The awareness rules of a right-sidebar section (ADR-048 D1).
 *
 * The regression that motivates the `autoOpen` test is subtle and was found by
 * adversarial review, not by using the app: a plan almost always lands BEFORE the
 * agent writes any file, so the plan auto-reveal opens the sidebar at a moment
 * when there are zero artifacts. `useState(defaultOpen)` reads its argument once,
 * so with `defaultOpen` alone the Artifacts section mounts collapsed and stays
 * collapsed for the entire turn — reproducing the exact blindness ADR-048 exists
 * to remove, on the very path ADR-048 introduces.
 */
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, screen, fireEvent, cleanup } from "@testing-library/react"
import { RightSidebarSection } from "@/components/session/right-sidebar-section"

afterEach(cleanup)

describe("RightSidebarSection — auto-open", () => {
  it("opens itself when autoOpen flips true, even though it mounted collapsed", () => {
    const { rerender } = render(
      <RightSidebarSection title="Artifacts" autoOpen={false} defaultOpen={false}>
        <p>report.pdf</p>
      </RightSidebarSection>,
    )
    expect(screen.queryByText("report.pdf")).toBeNull() // no artifacts yet

    // The agent writes a file mid-turn; the sidebar was already open (plan reveal).
    rerender(
      <RightSidebarSection title="Artifacts" autoOpen defaultOpen={false}>
        <p>report.pdf</p>
      </RightSidebarSection>,
    )
    expect(screen.getByText("report.pdf")).toBeTruthy()
  })

  it("stops re-opening once the user collapses it by hand", () => {
    const { rerender } = render(
      <RightSidebarSection title="Artifacts" autoOpen>
        <p>report.pdf</p>
      </RightSidebarSection>,
    )
    expect(screen.getByText("report.pdf")).toBeTruthy()

    fireEvent.click(screen.getByText("Artifacts")) // user collapses it
    expect(screen.queryByText("report.pdf")).toBeNull()

    // More artifacts arrive — autoOpen is still true, but the user has spoken.
    rerender(
      <RightSidebarSection title="Artifacts" autoOpen>
        <p>report.pdf</p>
        <p>chart.png</p>
      </RightSidebarSection>,
    )
    expect(screen.queryByText("report.pdf")).toBeNull() // stays shut — manual wins
  })
})

describe("RightSidebarSection — badge & seen", () => {
  it("shows the badge only while collapsed, and reports 'seen' when opened", () => {
    const onOpen = vi.fn()
    render(
      <RightSidebarSection title="Artifacts" badge={3} onOpen={onOpen}>
        <p>report.pdf</p>
      </RightSidebarSection>,
    )
    expect(screen.getByText("3")).toBeTruthy() // collapsed → badge visible
    expect(onOpen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText("Artifacts"))
    expect(onOpen).toHaveBeenCalled() // contents on screen → seen
    expect(screen.queryByText("3")).toBeNull() // open → badge suppressed
  })

  it("re-reports 'seen' when the count moves while already open", () => {
    // Otherwise the badge would spring back the instant the user collapsed the
    // sidebar, for artifacts that were on screen the whole time.
    const onOpen = vi.fn()
    const { rerender } = render(
      <RightSidebarSection title="Artifacts" defaultOpen badge={0} onOpen={onOpen}>
        <p>a</p>
      </RightSidebarSection>,
    )
    onOpen.mockClear()

    rerender(
      <RightSidebarSection title="Artifacts" defaultOpen badge={2} onOpen={onOpen}>
        <p>a</p>
      </RightSidebarSection>,
    )
    expect(onOpen).toHaveBeenCalled()
  })

  it("renders no badge at zero", () => {
    render(<RightSidebarSection title="Artifacts" badge={0} />)
    expect(screen.queryByText("0")).toBeNull()
  })
})
