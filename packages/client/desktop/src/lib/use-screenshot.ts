/**
 * In-app screenshot capture (discussions/039 §4 P2, ADR-056).
 *
 * The bytes a capture produces flow through the SAME `add(files: File[])` pipeline
 * that paste uses — downscale, model-capability gate, per-prompt budget — instead of
 * a second path. The Rust command owns everything platform-specific (the macOS TCC
 * gate, the Windows clipboard poll, the Linux tool probe) and hands back a plain
 * outcome; all this hook does is turn "captured" into a File and route the other
 * outcomes to the right piece of UI.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"

type CaptureOutcome =
  | { outcome: "captured"; path: string }
  | { outcome: "cancelled" }
  | { outcome: "needs_permission" }
  | { outcome: "unavailable" }

export interface ScreenshotControl {
  /** Take a screenshot; `hideWindow` hides our own window during the capture. */
  capture: (hideWindow: boolean) => void
  /** False only on Linux with no screenshot tool — the button degrades to a hint. */
  available: boolean
  /** A capture is in flight; the button shows a spinner and ignores further clicks. */
  busy: boolean
}

export function useScreenshot(add: (files: File[]) => void | Promise<void>): ScreenshotControl {
  const { t } = useI18n()
  const [available, setAvailable] = useState(true)
  const [busy, setBusy] = useState(false)
  // State updates are async; a ref is the authority the click handler reads
  // synchronously, so a fast double-click can never launch two selectors at once.
  const busyRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Optimistic default: a probe failure (non-Tauri host in tests, an odd shell)
    // must not grey out a button that would have worked. Only an explicit
    // available:false from Linux disables it.
    invoke<{ available: boolean }>("screenshot_capability")
      .then((r) => {
        if (!cancelled) setAvailable(r.available)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const capture = useCallback(
    (hideWindow: boolean) => {
      if (busyRef.current) return
      busyRef.current = true
      setBusy(true)
      void (async () => {
        try {
          const res = await invoke<CaptureOutcome>("capture_screenshot", { hideWindow })
          switch (res.outcome) {
            case "captured": {
              // Read the temp PNG → File → add(), then discard the temp file: it has
              // served its purpose and a screenshot lingering in temp is a needless
              // privacy footprint. Discard runs even if the read/add throws.
              try {
                const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path: res.path })
                const file = new File([bytes], pathBasename(res.path), { type: "image/png" })
                // Await it: add()'s pipeline is async, and a floated promise would let a
                // rejection escape this try/catch (no failure toast, an unhandled
                // rejection instead). The File already holds the bytes in memory, so the
                // temp file is safe to discard right after regardless.
                await add([file])
              } catch {
                toast.error(t("screenshot.failed"))
              } finally {
                await invoke("discard_temp_file", { path: res.path }).catch(() => {})
              }
              break
            }
            case "cancelled":
              // The user dismissed the selector. Nothing to say.
              break
            case "needs_permission": {
              // macOS: Screen Recording permission is missing. Offer the one-click
              // system dialog, then explain the restart macOS requires. The paste
              // path (P1) still works meanwhile, so this is a guided fallback, not a
              // dead end.
              toast(t("screenshot.needsPermission"), {
                duration: 8000,
                action: {
                  label: t("screenshot.grant"),
                  onClick: () => {
                    void invoke("request_screen_capture_access").finally(() => {
                      toast.info(t("screenshot.restartAfterGrant"))
                    })
                  },
                },
              })
              break
            }
            case "unavailable":
              // Linux with no tool. Point at the always-available paste path.
              toast.error(t("screenshot.unavailable"))
              break
          }
        } catch {
          toast.error(t("screenshot.failed"))
        } finally {
          busyRef.current = false
          setBusy(false)
        }
      })()
    },
    [add, t],
  )

  // Memoized so the object identity is stable across renders where nothing changed —
  // the pages spread this into a useMemo'd attachment slot, and a fresh object every
  // render would defeat that memo and churn the ChatInput `attachments` prop.
  return useMemo(() => ({ capture, available, busy }), [capture, available, busy])
}
