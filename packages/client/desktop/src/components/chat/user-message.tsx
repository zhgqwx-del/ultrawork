import { memo, useMemo } from "react"
import { CopyButton } from "./copy-button"
import { FileIcon } from "@/components/ui/file-icon"
import { useI18n } from "@/lib/i18n-context"
import { formatDateTime, toIsoTimestamp } from "@/lib/format-time"
import { pathBasename } from "@/lib/path-utils"
import type { FilePart } from "@agent/api-client"

interface UserMessageProps {
  content: string
  /** Attachments the user sent with this turn (images, PDFs, text files). */
  attachments?: FilePart[]
  /** When the message was sent (ms epoch, `info.time.created`). */
  createdAt?: number
}

function attachmentLabel(part: FilePart): string {
  // `filename` is optional on the wire; fall back to the tail of the URL, which for a
  // `file://` attachment is the real path. A `data:` URL has no path — hence the mime.
  if (part.filename) return part.filename
  if (part.url.startsWith("file://")) return pathBasename(decodeURIComponent(part.url.slice(7)))
  return part.mime
}

export const UserMessage = memo(function UserMessage({ content, attachments, createdAt }: UserMessageProps) {
  const { t, language } = useI18n()
  const images = (attachments ?? []).filter((a) => a.mime.startsWith("image/"))
  const files = (attachments ?? []).filter((a) => !a.mime.startsWith("image/"))
  // Memoised because the transcript re-renders on every streamed token; the
  // formatter itself is cached per locale (see lib/format-time.ts).
  const [sentAt, sentAtIso] = useMemo(
    () => [formatDateTime(createdAt, language), toIsoTimestamp(createdAt)] as const,
    [createdAt, language],
  )

  return (
    <div className="group flex flex-col items-end py-3">
      <div className="flex max-w-[85%] flex-col gap-2 rounded-2xl bg-[var(--color-accent)] px-4 py-3">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <img
                key={i}
                src={img.url}
                alt={attachmentLabel(img)}
                className="max-h-48 max-w-[12rem] rounded-lg object-contain"
              />
            ))}
          </div>
        )}

        {files.map((file, i) => (
          <div
            key={i}
            className="flex items-center gap-2 rounded-lg bg-[var(--color-bg)] px-2.5 py-1.5 text-xs text-[var(--color-fg-muted)]"
          >
            <FileIcon filename={attachmentLabel(file)} className="size-3.5 shrink-0" />
            <span className="truncate">{attachmentLabel(file)}</span>
          </div>
        ))}

        {/* An attachment-only turn carries no text — don't render an empty line for it. */}
        {content && (
          <div className="whitespace-pre-wrap break-words text-sm text-[var(--color-fg)]">
            {content}
          </div>
        )}
      </div>
      {/* Sent-at (always visible) + copy (on hover). The copy button is hidden by
          opacity rather than display, so it keeps its box — the row's height is the
          same with or without the timestamp, and hovering never shifts anything.
          NOTE: the muted token measures 4.63:1 (light) / 6.11:1 (dark) against the
          page background, i.e. AA at this size — do NOT add an `opacity-*` here, which
          is exactly how the `/` command menu once fell to 2.68:1. */}
      {(sentAt || content) && (
        <div className="mt-1 flex items-center gap-1 text-[10px] text-[var(--color-fg-muted)]">
          {sentAt && (
            <time dateTime={sentAtIso} data-testid="message-time">
              {sentAt}
            </time>
          )}
          {content && (
            <CopyButton
              text={content}
              ariaLabel={t("message.copyMessage")}
              className="rounded p-1.5 opacity-0 transition-opacity hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] group-hover:opacity-100 focus-visible:opacity-100"
              iconClassName="size-3.5"
            />
          )}
        </div>
      )}
    </div>
  )
}, userMessagePropsEqual)

/**
 * `message.parts.filter(...)` in MessageList hands us a FRESH `attachments` array on
 * every render, so the default shallow compare never matched and every user bubble
 * re-rendered once per streamed token. The array is new but its elements are the
 * original part objects, so comparing element identity is both cheap and correct.
 *
 * `createdAt` MUST be part of this comparison: leave it out and a message whose
 * timestamp is corrected in place (history back-fill, an SSE update to the same id)
 * would keep rendering the stale time — silently, with nothing thrown. The
 * optimistic→real swap doesn't exercise this path (the React key changes with the
 * message id, so that bubble remounts), which is exactly why the test drives the
 * comparator directly rather than by "sending a message".
 */
function userMessagePropsEqual(prev: UserMessageProps, next: UserMessageProps): boolean {
  if (prev.content !== next.content || prev.createdAt !== next.createdAt) return false
  const pa = prev.attachments
  const na = next.attachments
  if ((pa?.length ?? 0) !== (na?.length ?? 0)) return false
  if (pa && na) {
    for (let i = 0; i < pa.length; i++) {
      if (pa[i] !== na[i]) return false
    }
  }
  return true
}
