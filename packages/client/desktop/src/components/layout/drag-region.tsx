import { getCurrentWindow } from "@tauri-apps/api/window"
import type { MouseEvent } from "react"

/** Start window dragging on mousedown. Skips interactive elements.
 *  Workaround for data-tauri-drag-region not working with titleBarStyle: Overlay (tauri-apps/tauri#9503). */
export function handleDrag(e: MouseEvent) {
  if (e.button !== 0) return
  const target = e.target as HTMLElement
  if (target.closest("button, a, input, select, textarea")) return
  e.preventDefault()
  getCurrentWindow().startDragging()
}

/** Invisible bar at top of window for pages without a TopBar (loading, workspace selector). */
export function DragRegion() {
  return (
    <div
      onMouseDown={handleDrag}
      className="fixed top-0 left-0 right-0 h-8 z-50"
    />
  )
}
