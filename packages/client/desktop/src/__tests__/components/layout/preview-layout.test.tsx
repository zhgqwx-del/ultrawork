/**
 * The preview/sidebar layout state machine (ADR-048 D2).
 *
 * The bug this replaces: preview (`w-1/2`), sidebar (`w-72`) and chat (`w-1/2`)
 * were siblings in one flex row, so all three open summed to `100% + 288px` and
 * the chat — the only shrinkable column — silently ate the overflow. Mutual
 * exclusion makes that impossible by construction, so these tests guard the
 * exclusion itself, not any particular pixel width.
 */
import { describe, it, expect } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { SidebarProvider, useSidebar } from "@/components/layout/sidebar-context"
import type { ReactNode } from "react"

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <SidebarProvider>{children}</SidebarProvider>
  </MemoryRouter>
)

/** Roomy enough for a split — callers pass a MEASURED row width, not window.innerWidth. */
const WIDE = 1344

describe("preview ⇄ right sidebar (mutual exclusion)", () => {
  it("opening the preview collapses an open sidebar, and closing restores it", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.toggleRight()) // user opens the sidebar
    expect(result.current.rightOpen).toBe(true)

    act(() => result.current.openPreview(WIDE))
    expect(result.current.previewMode).toBe("half")
    expect(result.current.rightOpen).toBe(false) // never coexist

    act(() => result.current.closePreview())
    expect(result.current.previewMode).toBe("closed")
    expect(result.current.rightOpen).toBe(true) // put back the way we found it
  })

  it("a sidebar that was closed stays closed after the preview closes", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    expect(result.current.rightOpen).toBe(false)

    act(() => result.current.openPreview(WIDE))
    act(() => result.current.closePreview())
    expect(result.current.rightOpen).toBe(false) // no spontaneous reveal
  })

  it("opening the sidebar by hand while previewing closes the preview and voids the snapshot", () => {
    // The counter-example that makes "restore on close" dangerous: if we blindly
    // replayed the snapshot, closing the preview later would undo the very thing
    // the user just did by hand. Manual wins (VS Code Agents Window rule).
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.openPreview(WIDE)) // snapshot = closed
    expect(result.current.previewMode).toBe("half")

    act(() => result.current.toggleRight()) // user pulls the sidebar open
    expect(result.current.rightOpen).toBe(true)
    expect(result.current.previewMode).toBe("closed") // preview yields — exclusive

    // The stale snapshot ("was closed") must not resurface and shut the sidebar.
    act(() => result.current.closePreview())
    expect(result.current.rightOpen).toBe(true)
  })
})

describe("preview width modes", () => {
  it("opens half at the DEFAULT window size — the regression real usage caught", () => {
    // tauri.conf.json ships 1200×800, leaving a ~940px main area. The first
    // threshold (1100px) meant every artifact click on a fresh install jumped
    // straight to full-screen and swept the conversation off screen. A 1440px e2e
    // viewport never saw it; the first minute of real clicking did.
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.openPreview(944))
    expect(result.current.previewMode).toBe("half")
  })

  it("opens full only when the row is genuinely too narrow to split", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.openPreview(700)) // 350px a side — neither is usable
    expect(result.current.previewMode).toBe("full")
  })

  it("assumes roomy when the width is unknown — half keeps the conversation on screen", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.openPreview(undefined))
    expect(result.current.previewMode).toBe("half")
  })

  it("toggles half ⇄ full, and is a no-op while closed", () => {
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.togglePreviewMaximized())
    expect(result.current.previewMode).toBe("closed") // nothing to maximize

    act(() => result.current.openPreview(WIDE))
    act(() => result.current.togglePreviewMaximized())
    expect(result.current.previewMode).toBe("full")
    act(() => result.current.togglePreviewMaximized())
    expect(result.current.previewMode).toBe("half")
  })

  it("openPreview on an already-maximized preview does not knock it back to half", () => {
    // Clicking another artifact in the preview's own nav must not resize the panel.
    const { result } = renderHook(() => useSidebar(), { wrapper })
    act(() => result.current.openPreview(WIDE))
    act(() => result.current.togglePreviewMaximized())
    expect(result.current.previewMode).toBe("full")

    act(() => result.current.openPreview())
    expect(result.current.previewMode).toBe("full")
  })
})
