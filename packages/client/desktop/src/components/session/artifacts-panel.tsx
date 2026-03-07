import { useMemo } from "react"
import { FileText, FileDiff, FileImage, File } from "lucide-react"
import type { SendMessageResponse, FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "./artifact-preview"
import { useI18n } from "@/lib/i18n-context"

interface ArtifactsPanelProps {
  messages: SendMessageResponse[]
  onArtifactClick?: (artifact: Artifact) => void
  selectedPath?: string
}

function extractArtifacts(messages: SendMessageResponse[]): Artifact[] {
  const seen = new Set<string>()
  const artifacts: Artifact[] = []

  for (const msg of messages) {
    if (msg.info.role !== "assistant" || !msg.parts) continue
    for (const part of msg.parts) {
      if (part.type === "file") {
        const fp = part as FilePart
        const path = fp.filename || fp.url || "unknown"
        if (!seen.has(path)) {
          seen.add(path)
          artifacts.push({ type: "file", path, mime: fp.mime })
        }
      } else if (part.type === "patch") {
        const pp = part as PatchPart
        for (const file of pp.files) {
          if (!seen.has(file)) {
            seen.add(file)
            artifacts.push({ type: "patch", path: file })
          }
        }
      }
    }
  }
  return artifacts
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-3.5 shrink-0 text-blue-500" />
  if (artifact.mime?.startsWith("image/")) return <FileImage className="size-3.5 shrink-0 text-purple-500" />
  if (artifact.mime?.includes("pdf") || artifact.path.endsWith(".pdf")) return <FileText className="size-3.5 shrink-0 text-red-500" />
  return <File className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
}

function basename(path: string): string {
  return path.split("/").pop() || path
}

export function ArtifactsPanel({ messages, onArtifactClick, selectedPath }: ArtifactsPanelProps) {
  const { t } = useI18n()
  const artifacts = useMemo(() => extractArtifacts(messages), [messages])

  if (artifacts.length === 0) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("message.noArtifacts")}</p>
  }

  return (
    <div className="space-y-1">
      {artifacts.map((artifact) => (
        <div
          key={artifact.path}
          onClick={() => onArtifactClick?.(artifact)}
          className={`flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-[var(--color-accent)] ${
            onArtifactClick ? "cursor-pointer" : ""
          } ${selectedPath === artifact.path ? "bg-[var(--color-accent)]" : ""}`}
        >
          <ArtifactIcon artifact={artifact} />
          <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]" title={artifact.path}>
            {basename(artifact.path)}
          </span>
          {artifact.type === "patch" && (
            <span className="shrink-0 text-[10px] text-blue-500">{t("artifact.diff")}</span>
          )}
        </div>
      ))}
    </div>
  )
}
