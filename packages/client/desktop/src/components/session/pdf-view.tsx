import { useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { ExternalLink } from "lucide-react"
import * as pdfjsLib from "pdfjs-dist"
// ?worker (vs ?url) lets Vite instantiate the worker itself — more reliable in
// the Tauri webview, where loading a module worker from a plain ?url can fail to
// fetch/instantiate. No asset-protocol scope needed (the workspace can live
// anywhere on disk); bytes are read via the scope-free `read_file_bytes` command.
// A single shared workerPort is fine: pdf.js reuses it across documents and does
// not terminate an externally-provided port on loadingTask.destroy().
import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker"

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker()

/** Render PDF pages to canvases via pdf.js — no webview PDF viewer dependency. */
export function PdfView({ absPath, t }: { absPath: string; t: (key: string) => string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [errMsg, setErrMsg] = useState("")

  useEffect(() => {
    let cancelled = false
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | undefined
    setStatus("loading")
    const mount = containerRef.current
    if (mount) mount.innerHTML = ""

    async function render() {
      try {
        const buf = await invoke<ArrayBuffer>("read_file_bytes", { path: absPath })
        if (cancelled) return
        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buf) })
        const doc = await loadingTask.promise
        if (cancelled) return
        const target = containerRef.current
        if (!target) return
        // Oversample a touch for crisp text; CSS scales the canvas to fit width.
        const scale = Math.min(2, (window.devicePixelRatio || 1) * 1.2)
        for (let n = 1; n <= doc.numPages; n++) {
          if (cancelled) return
          const page = await doc.getPage(n)
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement("canvas")
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.className = "mx-auto mb-3 block h-auto max-w-full rounded shadow-sm"
          const ctx = canvas.getContext("2d")
          if (!ctx) continue
          target.appendChild(canvas)
          await page.render({ canvasContext: ctx, viewport }).promise
        }
        if (!cancelled) setStatus("ready")
      } catch (e) {
        console.error("[PdfView] render failed:", e)
        if (!cancelled) {
          setErrMsg(e instanceof Error ? e.message : String(e))
          setStatus("error")
        }
      }
    }
    render()

    return () => {
      cancelled = true
      loadingTask?.destroy()
    }
  }, [absPath])

  if (status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-[var(--color-fg-muted)]">{t("artifact.pdfError")}</p>
        {errMsg && (
          <p className="max-w-[85%] break-words text-xs text-[var(--color-fg-muted)] opacity-70">{errMsg}</p>
        )}
        <button
          onClick={() => invoke("open_file_with_system", { path: absPath }).catch(() => {})}
          className="flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
        >
          <ExternalLink className="size-3.5" />
          {t("artifact.openWithApp")}
        </button>
      </div>
    )
  }

  return (
    <div className="min-h-full bg-[var(--color-bg-subtle)] p-4">
      {status === "loading" && (
        <div className="flex items-center justify-center py-12 text-sm text-[var(--color-fg-muted)]">
          {t("artifact.loading")}
        </div>
      )}
      <div ref={containerRef} />
    </div>
  )
}
