import { useMemo } from "react"
import { FileText, FileDiff, FileImage, File } from "lucide-react"
import type { SendMessageResponse, FilePart, PatchPart, ToolPart } from "@agent/api-client"
import type { Artifact } from "./artifact-preview"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"

interface ArtifactsPanelProps {
  messages: SendMessageResponse[]
  /** Workspace root directory — used to convert absolute tool paths to relative */
  directory?: string
  onArtifactClick?: (artifact: Artifact) => void
  selectedPath?: string
}

/** Convert absolute path to relative by stripping workspace root prefix */
function toRelative(filePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) return filePath
  let rel = filePath.slice(workspaceRoot.length)
  if (rel.startsWith("/")) rel = rel.slice(1)
  return rel || filePath
}

/** File-modifying tool names whose filePath input should be tracked as artifacts */
const FILE_TOOLS = new Set(["write", "edit", "create", "patch"])

function extractArtifacts(messages: SendMessageResponse[], workspaceRoot?: string): Artifact[] {
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
      } else if (part.type === "tool") {
        const tp = part as ToolPart
        if (!FILE_TOOLS.has(tp.tool)) continue
        const input = tp.state.input as Record<string, unknown> | undefined
        if (input) {
          // OpenCode tools use camelCase `filePath` for the file path parameter
          const rawPath = (input.filePath || input.file_path || input.path) as string | undefined
          if (rawPath) {
            // Convert to relative path for API compatibility (server resolves via header)
            const relPath = toRelative(rawPath, workspaceRoot)
            if (!seen.has(relPath)) {
              seen.add(relPath)
              artifacts.push({ type: "file", path: relPath })
            }
          }
        }
      }
    }
  }
  return artifacts
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-3.5 shrink-0 text-blue-500" />
  if (artifact.mime?.startsWith("image/") || IMAGE_EXTS.test(artifact.path)) return <FileImage className="size-3.5 shrink-0 text-purple-500" />
  if (artifact.mime?.includes("pdf") || artifact.path.endsWith(".pdf")) return <FileText className="size-3.5 shrink-0 text-red-500" />
  return <File className="size-3.5 shrink-0 text-[var(--color-fg-muted)]" />
}

function basename(path: string): string {
  return path.split("/").pop() || path
}

export function ArtifactsPanel({ messages, directory, onArtifactClick, selectedPath }: ArtifactsPanelProps) {
  const { t } = useI18n()
  const artifacts = useMemo(() => extractArtifacts(messages, directory), [messages, directory])

  if (artifacts.length === 0) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("message.noArtifacts")}</p>
  }

  return (
    <div className="space-y-1">
      {artifacts.map((artifact) => (
        <div
          key={artifact.path}
          onClick={() => onArtifactClick?.(artifact)}
          className={cn(
            "flex items-center gap-2 rounded px-1 py-1 text-xs transition-colors hover:bg-[var(--color-accent)]",
            onArtifactClick && "cursor-pointer",
            selectedPath === artifact.path && "bg-[var(--color-accent)]"
          )}
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
