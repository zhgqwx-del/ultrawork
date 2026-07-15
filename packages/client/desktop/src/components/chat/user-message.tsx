import { memo } from "react"
import { CopyButton } from "./copy-button"
import { FileIcon } from "@/components/ui/file-icon"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"
import type { FilePart } from "@agent/api-client"

interface UserMessageProps {
  content: string
  /** Attachments the user sent with this turn (images, PDFs, text files). */
  attachments?: FilePart[]
}

function attachmentLabel(part: FilePart): string {
  // `filename` is optional on the wire; fall back to the tail of the URL, which for a
  // `file://` attachment is the real path. A `data:` URL has no path — hence the mime.
  if (part.filename) return part.filename
  if (part.url.startsWith("file://")) return pathBasename(decodeURIComponent(part.url.slice(7)))
  return part.mime
}

export const UserMessage = memo(function UserMessage({ content, attachments }: UserMessageProps) {
  const { t } = useI18n()
  const images = (attachments ?? []).filter((a) => a.mime.startsWith("image/"))
  const files = (attachments ?? []).filter((a) => !a.mime.startsWith("image/"))

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
      {content && (
        <CopyButton
          text={content}
          ariaLabel={t("message.copyMessage")}
          className="mt-1 rounded p-1.5 text-[var(--color-fg-muted)] opacity-0 transition-opacity hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] group-hover:opacity-100 focus-visible:opacity-100"
          iconClassName="size-3.5"
        />
      )}
    </div>
  )
})
