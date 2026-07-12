import { memo, useState } from "react"
import { FileDiff } from "lucide-react"
import type { Artifact } from "@/components/session/artifact-preview"
import { FileIcon, getFileTypeLabel } from "@/components/ui/file-icon"
import { useI18n } from "@/lib/i18n-context"
import { pathBasename } from "@/lib/path-utils"

/**
 * Past roughly four entries a per-turn file list stops being a summary and starts
 * being the message — VS Code hit exactly this with Copilot's "N files changed"
 * panel (microsoft/vscode#261081: at 4–5 files it takes over the chat pane and
 * pushes the conversation out of view). Fold beyond that, but keep the fold one
 * click deep: Cursor shipped a collapsed-by-default diff and had to walk it back.
 */
const MAX_VISIBLE = 4

function ArtifactCard({ artifact, onClick }: { artifact: Artifact; onClick?: (a: Artifact) => void }) {
  const label = artifact.type === "patch" ? "DIFF" : getFileTypeLabel(artifact.path)
  return (
    <button
      type="button"
      onClick={() => onClick?.(artifact)}
      title={artifact.path}
      className="flex min-w-0 max-w-[240px] items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-2 py-1.5 text-xs transition-colors hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-accent)]"
    >
      {artifact.type === "patch" ? (
        <FileDiff className="size-3.5 shrink-0 text-blue-500" />
      ) : (
        <FileIcon filename={artifact.path} mime={artifact.mime} size={14} />
      )}
      <span className="min-w-0 truncate text-[var(--color-fg)]">{pathBasename(artifact.path)}</span>
      {label && <span className="shrink-0 text-[10px] text-[var(--color-fg-muted)]">{label}</span>}
    </button>
  )
}

/**
 * The files one turn produced, as cards under its answer.
 *
 * The card is a handle, not the artifact — clicking routes into the same
 * `onArtifactClick` the sidebar uses, so the preview behaves identically wherever
 * you came from. It deliberately does NOT open the preview by itself: an artifact
 * arriving is passive information, and auto-opening a panel over the conversation
 * is the single most complained-about thing about ChatGPT's Canvas.
 */
export const TurnArtifacts = memo(function TurnArtifacts({
  artifacts,
  onArtifactClick,
}: {
  artifacts: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
}) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)

  if (artifacts.length === 0) return null

  const visible = expanded ? artifacts : artifacts.slice(0, MAX_VISIBLE)
  const hidden = artifacts.length - visible.length

  return (
    <div data-testid="turn-artifacts" className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
        {t("artifact.turnOutputs")}
      </span>
      {visible.map((artifact) => (
        <ArtifactCard key={artifact.path} artifact={artifact} onClick={onArtifactClick} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-md border border-dashed border-[var(--color-border)] px-2 py-1.5 text-xs text-[var(--color-fg-muted)] transition-colors hover:border-[var(--color-primary)]/40 hover:text-[var(--color-fg)]"
        >
          {t("artifact.moreCount").replace("{n}", String(hidden))}
        </button>
      )}
    </div>
  )
})
