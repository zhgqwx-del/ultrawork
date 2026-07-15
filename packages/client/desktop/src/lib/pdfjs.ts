/**
 * The one pdf.js instance in the app.
 *
 * `GlobalWorkerOptions.workerPort` is global: whoever sets it last wins, and setting it from
 * two modules just spawns a second worker for nothing. Both consumers — the artifact preview
 * and the composer's PDF page count — go through `getPdfjs()`.
 *
 * The worker is created on FIRST USE, not at import. `artifact-preview` statically imports
 * `PdfView`, so this module is in the main chunk no matter what — but a module-level
 * `new PdfjsWorker()` would also spawn a worker thread on every session load, for the large
 * majority of sessions that never open a PDF.
 *
 * `?worker` (not `?url`) lets Vite instantiate the worker itself; loading a module worker
 * from a plain `?url` can fail to fetch inside the Tauri webview (see pdf-view.tsx history).
 */
import * as pdfjsLib from "pdfjs-dist"
import PdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker"

/** pdf.js, with its worker guaranteed to exist. Call this instead of importing pdfjsLib. */
export function getPdfjs(): typeof pdfjsLib {
  if (!pdfjsLib.GlobalWorkerOptions.workerPort) {
    pdfjsLib.GlobalWorkerOptions.workerPort = new PdfjsWorker()
  }
  return pdfjsLib
}

/**
 * Page count, or null when the PDF can't be parsed (encrypted, corrupt, not really a PDF).
 *
 * Null means "we don't know" and callers must NOT read it as "small": an unknown-size PDF is
 * routed the safe way (path only), because the failure being guarded against — inlining a
 * 200-page document straight into the prompt — is expensive and unrecoverable.
 */
export async function countPdfPages(bytes: ArrayBuffer): Promise<number | null> {
  const task = getPdfjs().getDocument({ data: new Uint8Array(bytes) })
  try {
    const doc = await task.promise
    const pages = doc.numPages
    await doc.destroy()
    return pages
  } catch {
    return null
  }
}
