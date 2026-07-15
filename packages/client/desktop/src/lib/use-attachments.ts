/**
 * Composer attachment state: the three entry points (picker / drag-drop / paste), the
 * model-capability gate, and the mapping to prompt parts at send time.
 *
 * See docs/discussions/039-multimodal-input-attachments.md.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { imageCapableModels, modelInputSupport } from "@/lib/model-capabilities"
import { isAbsolutePath, pathBasename } from "@/lib/path-utils"
import {
  AttachmentRejected,
  classify,
  inlineBytesOf,
  mimeOfDataUrl,
  MAX_BYTES,
  MAX_INLINE_PDF_PAGES,
  MAX_INLINE_TOTAL_BYTES,
  nextAttachmentId,
  rejectionOf,
  toDataUrl,
  toFileUrl,
  wireMime,
  type Attachment,
} from "@/lib/attachments"
import type { PromptAttachment } from "@agent/connector"

/**
 * Deliberately a dynamic import.
 *
 * NOT for code-splitting — `artifact-preview` statically imports `PdfView`, so pdf.js sits in
 * the main chunk regardless (verified against a real `vite build`; claiming otherwise would be
 * a comment that lies). It is dynamic so a module that merely HAS a composer doesn't pull
 * `pdfjs-dist/…?worker` into its import graph, which is also what lets the unit tests render
 * Home without vitest having to resolve `?worker`. The worker itself is created lazily inside
 * @/lib/pdfjs, so no worker thread is spawned until a PDF is actually touched.
 *
 * Returns null when the page count is UNKNOWN — the PDF is encrypted or corrupt, or pdf.js
 * cannot run at all (it needs `Promise.withResolvers`: Safari 17.4+ / WebKitGTK 2.44+).
 * Callers must not read null as "0 pages" or as "too long": it is a third outcome and it
 * gets its own message.
 */
async function pdfPageCount(bytes: ArrayBuffer): Promise<number | null> {
  try {
    const { countPdfPages } = await import("@/lib/pdfjs")
    return await countPdfPages(bytes)
  } catch {
    return null
  }
}

interface UseAttachmentsResult {
  items: Attachment[]
  add: (files: File[]) => Promise<void>
  addPaths: (paths: string[]) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  /** Non-null when the selected model can't accept what's attached — blocks send. */
  blocker: string | null
  /**
   * The capability gate is still resolving. Send must wait for it: the gate awaits a 4 MB
   * GET /provider, and pasting an image then hitting Enter immediately would otherwise sail
   * past a `blocker` that had not been computed yet — the check would exist and never run.
   */
  checking: boolean
  /**
   * Turn the attachment list into what `sendMessage` needs. Documents are copied into the
   * session workspace HERE, not at attach time: on the Home page no session exists yet, so
   * there is nowhere to copy them to until the turn is actually sent.
   */
  materialize: (
    sessionId: string,
    directory: string | undefined,
  ) => Promise<{ attachments: PromptAttachment[]; noteText: string }>
}

export function useAttachments(model: string | null | undefined): UseAttachmentsResult {
  const api = useApi()
  const { t } = useI18n()
  const [items, setItems] = useState<Attachment[]>([])
  const [blocker, setBlocker] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  // itemsRef is the AUTHORITY for the caps, and it is updated synchronously on accept — not
  // from render. add()/addPaths() await on every file, so two overlapping calls (dragging a
  // batch, pasting while it runs) would otherwise both read the same stale list, each conclude
  // it was under the limit, and land 20 attachments against a cap of 10 at twice the budget.
  const itemsRef = useRef<Attachment[]>([])
  const setBoth = useCallback((next: Attachment[]) => {
    itemsRef.current = next
    setItems(next)
  }, [])

  // …and a synchronous ref still can't order two interleaved async loops, so the loops
  // themselves are serialised through a promise chain.
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const serialize = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(fn, fn)
    queue.current = run.catch(() => {})
    return run
  }, [])

  // Re-evaluate the gate whenever the attachments or the selected model change — switching the
  // model is the user's fix for "this model can't see images", so the warning has to clear the
  // moment they do it.
  useEffect(() => {
    let cancelled = false
    const needsImage = items.some((a) => a.kind === "image")
    const needsPdf = items.some((a) => a.kind === "pdf")
    if (!needsImage && !needsPdf) {
      setBlocker(null)
      setChecking(false)
      return
    }
    setChecking(true)
    void (async () => {
      try {
      const support = await modelInputSupport(api, model).catch(() => null)
      if (cancelled) return
      // Unknown model (a custom definition not in the catalogue) ⇒ let the server decide rather
      // than blocking a model that may well be fine.
      if (!support) {
        setBlocker(null)
        return
      }
      const missing = (needsImage && !support.image) || (needsPdf && !support.pdf)
      if (!missing) {
        setBlocker(null)
        return
      }
      const alternatives = await imageCapableModels(api).catch(() => [])
      if (cancelled) return
      setBlocker(
        alternatives.length > 0
          ? t("attachment.modelUnsupportedTry")
              .replace("{model}", model ?? "")
              .replace("{alternatives}", alternatives.join(", "))
          : t("attachment.modelUnsupported").replace("{model}", model ?? ""),
      )
      } finally {
        if (!cancelled) setChecking(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [items, model, api, t])

  /**
   * Report a rejected file. EVERY rejection path goes through here: a file dropped without a
   * word is the failure the IM adapters shipped for months (the agent appears to ignore what
   * you sent), and it is the bug this whole feature exists to stop repeating.
   */
  const reject = useCallback(
    (key: string, params: Record<string, string | number> = {}) => {
      let msg = t(key)
      for (const [k, v] of Object.entries(params)) msg = msg.replace(`{${k}}`, String(v))
      toast.error(msg)
    },
    [t],
  )

  /** Accept one attachment if it fits the per-prompt inline budget; toast and drop if not. */
  const accept = useCallback(
    (candidate: Attachment): void => {
      const used = itemsRef.current.reduce((n, a) => n + inlineBytesOf(a), 0)
      if (used + inlineBytesOf(candidate) > MAX_INLINE_TOTAL_BYTES) {
        reject("attachment.budgetExceeded", {
          name: candidate.filename,
          max: Math.round(MAX_INLINE_TOTAL_BYTES / 1024 / 1024),
        })
        return
      }
      // Raise the capability gate SYNCHRONOUSLY, in the same commit as the item — not only in
      // the post-commit effect below. Otherwise there is a paint→passive-effect window where
      // the chip is visible but `checking` is still false and `blocker` still null, and a fast
      // paste-then-Enter sails through ungated (send re-checks `checking` at call time), landing
      // an image on a model that can't see it — the exact "model silently apologises" failure the
      // gate exists to prevent. The effect then owns clearing it once /provider resolves.
      if (candidate.kind === "image" || candidate.kind === "pdf") setChecking(true)
      setBoth([...itemsRef.current, candidate])
    },
    [reject, setBoth],
  )

  /** Files carrying their own bytes: paste. */
  const add = useCallback(
    (files: File[]) =>
      serialize(async () => {
        for (const file of files) {
          const kind = classify(file.name, file.type)
          const rejection = rejectionOf(file, kind, itemsRef.current.length)
          if (rejection) {
            reject(rejection.key, rejection.params ?? {})
            continue
          }
          if (kind === "document") {
            // No source path (these bytes came off the clipboard), so there is nothing to copy
            // into the workspace and nothing for the agent to open. Refuse honestly.
            reject("attachment.documentNeedsFile", { name: file.name })
            continue
          }
          if (kind === "pdf") {
            const bytes = await file.arrayBuffer().catch(() => null)
            const pages = bytes ? await pdfPageCount(bytes) : null
            if (pages === null) {
              // Unparseable — NOT the same as "too long". Telling someone their 3-page PDF is
              // too long would be a lie, and lies are how "it silently didn't work" starts.
              reject("attachment.pdfUnreadable", { name: file.name })
              continue
            }
            if (pages > MAX_INLINE_PDF_PAGES) {
              // Pasted bytes have no source path, so there is nothing to copy into the
              // workspace — the ➕ route is the one that can take a long PDF.
              reject("attachment.pdfTooLongPaste", { name: file.name, pages, max: MAX_INLINE_PDF_PAGES })
              continue
            }
          }
          let dataUrl: string
          try {
            dataUrl = await toDataUrl(file, kind, file.name)
          } catch (err) {
            if (err instanceof AttachmentRejected) reject(err.key, err.params)
            else reject("attachment.readFailed", { name: file.name })
            continue
          }
          accept({
            id: nextAttachmentId(),
            kind,
            // Read the mime off what we PRODUCED, not off the filename: downscaling re-encodes
            // (a .webp comes out PNG), and persisting the guess would put a lie in the record.
            mime: mimeOfDataUrl(dataUrl) ?? wireMime(kind, file.type, file.name),
            filename: file.name,
            wireUrl: dataUrl,
            previewUrl: kind === "image" ? dataUrl : undefined,
            size: file.size,
          })
        }
      }),
    [serialize, reject, accept],
  )

  /** Absolute paths: Tauri drag-drop and the native file dialog. */
  const addPaths = useCallback(
    (paths: string[]) =>
      serialize(async () => {
        for (const path of paths) {
          // On Linux, wry hands us whatever the drag carried: dragging an image out of a
          // BROWSER yields `https://…`, and wry passes it through as if it were a path.
          // Unfiltered, a text-ish URL would sail down the no-read branch and become
          // `file:///https:/example.com/a.md` — an attachment that looks attached and is not.
          if (!isAbsolutePath(path)) {
            reject("attachment.notAFile", { name: path.slice(0, 60) })
            continue
          }

          const name = pathBasename(path)
          const kind = classify(name)

          // A stat that FAILS must reject, never default to 0: `?? 0` would switch off every
          // size cap for exactly the files we cannot inspect (broken network mounts, denied
          // parents), and on macOS it is how a .key/.app BUNDLE (a directory) used to enter the
          // list and only blow up at send time.
          let size: number
          try {
            size = await invoke<number>("file_size", { path })
          } catch {
            reject("attachment.readFailed", { name })
            continue
          }

          const rejection = rejectionOf({ name, size }, kind, itemsRef.current.length)
          if (rejection) {
            // A pdf that only trips the (inline) SIZE cap is NOT rejected: over the inline cap it
            // degrades to a document — copied into the workspace, path handed to the agent — the
            // same fallback as a long or unparseable pdf (a 12 MB report must be attachable, just
            // not inlined). It is also too big to safely slurp into memory to count pages, so skip
            // the count and route it straight there. Reject only if it also blows the far larger
            // document cap, or for any other rejection (count cap, or a non-pdf that's too large).
            const pdfDegradesToDocument =
              kind === "pdf" &&
              rejection.key === "attachment.tooLarge" &&
              size <= MAX_BYTES.document
            if (!pdfDegradesToDocument) {
              reject(rejection.key, rejection.params ?? {})
              continue // never `break` — a silent drop is the failure mode we are here to kill
            }
            toast.info(
              t("attachment.pdfTooBigLazy")
                .replace("{name}", name)
                .replace("{max}", String(Math.round(MAX_BYTES.pdf / 1024 / 1024))),
            )
            accept({
              id: nextAttachmentId(),
              kind: "document",
              mime: wireMime("document", "", name),
              filename: name,
              wireUrl: "",
              size,
              srcPath: path,
            })
            continue
          }

          if (kind === "pdf") {
            // Bytes say nothing about a PDF's cost — a 2 MB file can be 300 pages, and the
            // server inlines PDFs whole with NO truncation. Count pages and route: short ones
            // stay multimodal (the model sees layout, charts, scans); long ones become
            // documents — copied into the workspace, path handed over, read on demand.
            const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path }).catch(() => null)
            const pages = bytes ? await pdfPageCount(bytes) : null
            if (pages !== null && pages <= MAX_INLINE_PDF_PAGES) {
              accept({
                id: nextAttachmentId(),
                kind,
                mime: wireMime(kind, "", name),
                filename: name,
                // file:// — the server reads it off disk instead of us shipping the bytes back
                // out through the request body. It still costs the model every one of them,
                // which is exactly what inlineBytesOf now charges for.
                wireUrl: toFileUrl(path),
                size,
                srcPath: path,
              })
              continue
            }
            // Too long, or unparseable. Both route to the workspace — but say WHICH.
            if (pages === null) reject("attachment.pdfUnreadableLazy", { name })
            else
              toast.info(
                t("attachment.pdfTooLongLazy")
                  .replace("{name}", name)
                  .replace("{pages}", String(pages))
                  .replace("{max}", String(MAX_INLINE_PDF_PAGES)),
              )
            accept({
              id: nextAttachmentId(),
              kind: "document",
              mime: wireMime("document", "", name),
              filename: name,
              wireUrl: "",
              size,
              srcPath: path,
            })
            continue
          }

          if (kind === "document") {
            // Copied into the workspace at send time (materialize) — there may be no session
            // yet. Carry the source path until then.
            accept({
              id: nextAttachmentId(),
              kind,
              mime: wireMime(kind, "", name),
              filename: name,
              wireUrl: "",
              size,
              srcPath: path,
            })
            continue
          }

          if (kind === "image") {
            // Read + downscale + inline. We need the bytes for the thumbnail anyway, and
            // file:// would make the server read the ORIGINAL, full-size image.
            const bytes = await invoke<ArrayBuffer>("read_file_bytes", { path }).catch(() => null)
            if (!bytes) {
              reject("attachment.readFailed", { name })
              continue
            }
            let dataUrl: string
            try {
              dataUrl = await toDataUrl(new Blob([bytes]), kind, name)
            } catch (err) {
              if (err instanceof AttachmentRejected) reject(err.key, err.params)
              else reject("attachment.readFailed", { name })
              continue
            }
            accept({
              id: nextAttachmentId(),
              kind,
              mime: mimeOfDataUrl(dataUrl) ?? wireMime(kind, "", name),
              filename: name,
              wireUrl: dataUrl,
              previewUrl: dataUrl,
              size: bytes.byteLength,
              srcPath: path,
            })
            continue
          }

          // text: file:// with mime text/plain. The server's Read tool inlines at most 50 KB /
          // 2000 lines and tells the model "use offset=N to continue" — so a 20 MB log costs one
          // bounded preview, and the agent pages through the rest only if it needs to.
          accept({
            id: nextAttachmentId(),
            kind,
            mime: wireMime(kind, "", name),
            filename: name,
            wireUrl: toFileUrl(path),
            size,
            srcPath: path,
          })
        }
      }),
    [serialize, reject, accept, t],
  )

  const remove = useCallback(
    (id: string) => setBoth(itemsRef.current.filter((a) => a.id !== id)),
    [setBoth],
  )

  const clear = useCallback(() => setBoth([]), [setBoth])

  const materialize = useCallback(
    async (sessionId: string, directory: string | undefined) => {
      const attachments: PromptAttachment[] = []
      const copied: string[] = []
      // Failures have to end up in the SAME medium as the damage. A toast is a 4-second
      // out-of-band signal; the transcript and the model's prompt are the permanent record.
      // Dropping a file with only a toast means that three days later the session reads as a
      // coherent story that is missing a file — and the model was never told either. That is
      // structurally the same lie the IM adapters told, just with a toast on top.
      const failed: string[] = []

      for (const a of itemsRef.current) {
        if (a.kind === "document") {
          if (!directory) {
            reject("attachment.noWorkspace", { name: a.filename })
            failed.push(a.filename)
            continue
          }
          const dest = await invoke<string>("copy_attachment_into_workspace", {
            workspace: directory,
            sessionId,
            src: a.srcPath,
          }).catch((err: unknown) => {
            console.error("copy_attachment_into_workspace failed:", err)
            reject("attachment.copyFailed", { name: a.filename })
            return null
          })
          if (dest) copied.push(dest)
          else failed.push(a.filename)
          continue
        }

        // A file:// attachment is a PROMISE about a file on disk, made when it was attached and
        // only redeemed when the user hits send. In between, the DMG gets ejected, the file gets
        // moved, the log rotates. The server's failure to read a missing file:// part is an
        // `Effect.die` DEFECT, not an error it reports — so re-check here, while we can still
        // tell the user, rather than letting the turn blow up server-side.
        if (a.wireUrl.startsWith("file://") && a.srcPath) {
          const size = await invoke<number>("file_size", { path: a.srcPath }).catch(() => null)
          if (size === null) {
            reject("attachment.vanished", { name: a.filename })
            failed.push(a.filename)
            continue
          }
          if (size !== a.size) {
            // It grew or shrank (a rotating log, a report still being written). The page count
            // and size caps were decided against the old file; do not silently ship the new one.
            reject("attachment.changed", { name: a.filename })
            failed.push(a.filename)
            continue
          }
        }

        attachments.push({ mime: a.mime, filename: a.filename, url: a.wireUrl })
      }

      // Documents can't be inlined — the agent has to open them itself, so tell it where.
      let noteText =
        copied.length > 0
          ? "\n\n" + t("attachment.documentNote") + "\n" + copied.map((p) => `- ${p}`).join("\n")
          : ""
      if (failed.length > 0) {
        noteText +=
          "\n\n" + t("attachment.failedNote") + "\n" + failed.map((f) => `- ${f}`).join("\n")
      }

      return { attachments, noteText }
    },
    [t, reject],
  )

  return { items, add, addPaths, remove, clear, blocker, checking, materialize }
}
