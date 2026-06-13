import { useMemo } from "react"
import { FileDiff } from "lucide-react"
import type { SendMessageResponse, FilePart, PatchPart, ToolPart } from "@agent/api-client"
import type { Artifact } from "./artifact-preview"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { FileIcon } from "@/components/ui/file-icon"

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
const FILE_TOOL_SUFFIXES = ["write", "edit", "create", "patch"]

/** Tool name suffixes that produce file output via a path parameter */
const OUTPUT_TOOL_SUFFIXES = ["take_screenshot", "screenshot", "pdf_save", "save_file"]

/** Directories to exclude from artifact detection (temp/system paths) */
const TEMP_PATH_RE = /\/(var\/folders|tmp|private\/tmp|Caches|playwright-mcp-output)\//i

/** Match file paths in tool output text */
const FILE_PATH_RE = /(?:saved?\s+(?:screenshot|file|trace|report|image)\s+(?:to|as)\s+)(\S+)/gi

/** Match absolute file paths with common extensions in tool output */
const ABS_PATH_RE = /(\/[\w./-]+\.(?:png|jpe?g|gif|svg|webp|pdf|html|json|csv|txt|md|ts|js|py))\b/gi

/** Path input parameter names to check */
const PATH_PARAMS = ["filePath", "file_path", "path", "outputPath", "filename"]

/** Check if tool name ends with a known suffix (handles MCP prefix like "browser_browser_write") */
function toolEndsWith(tool: string, suffixes: string[]): boolean {
  return suffixes.some(s => tool === s || tool.endsWith("_" + s))
}

/** Check if a path looks like a real workspace artifact (not temp/system) */
function isValidArtifactPath(filePath: string, workspaceRoot?: string): boolean {
  // Reject temp/system paths
  if (TEMP_PATH_RE.test(filePath)) return false
  // Reject data URIs
  if (filePath.startsWith("data:")) return false
  // Reject paths that are too long to be meaningful file names (likely base64 or garbage)
  if (filePath.length > 500) return false
  // If workspace root is known, only accept paths within it or relative paths
  if (workspaceRoot) {
    if (filePath.startsWith("/")) {
      return filePath.startsWith(workspaceRoot)
    }
    // Relative paths are fine (e.g. "google.png")
    return true
  }
  return true
}

function addIfNew(
  path: string,
  type: Artifact["type"],
  seen: Set<string>,
  artifacts: Artifact[],
  workspaceRoot?: string,
  mime?: string,
) {
  if (!isValidArtifactPath(path, workspaceRoot)) return
  const relPath = toRelative(path, workspaceRoot)
  if (!seen.has(relPath)) {
    seen.add(relPath)
    artifacts.push({ type, path: relPath, ...(mime ? { mime } : {}) })
  }
}

export function extractArtifacts(messages: SendMessageResponse[], workspaceRoot?: string): Artifact[] {
  const seen = new Set<string>()
  const artifacts: Artifact[] = []

  for (const msg of messages) {
    if (msg.info.role !== "assistant" || !msg.parts) continue
    for (const part of msg.parts) {
      if (part.type === "file") {
        const fp = part as FilePart
        const path = fp.filename || fp.url || "unknown"
        addIfNew(path, "file", seen, artifacts, workspaceRoot, fp.mime)
      } else if (part.type === "patch") {
        const pp = part as PatchPart
        for (const file of pp.files) {
          addIfNew(file, "patch", seen, artifacts, workspaceRoot)
        }
      } else if (part.type === "tool") {
        const tp = part as ToolPart
        const input = tp.state.input as Record<string, unknown> | undefined

        // Extract file path from tool input parameters for known file/screenshot tools
        if (input && (toolEndsWith(tp.tool, FILE_TOOL_SUFFIXES) || toolEndsWith(tp.tool, OUTPUT_TOOL_SUFFIXES))) {
          for (const param of PATH_PARAMS) {
            const rawPath = input[param] as string | undefined
            if (rawPath) {
              addIfNew(rawPath, "file", seen, artifacts, workspaceRoot)
              break
            }
          }
        }

        // Delegated members write files in their own (sidebar-hidden) child
        // session, invisible to this Leader transcript. The orchestrator puts
        // those paths into the D-2 contract's `artifacts` field, so parse the
        // delegate tool's JSON output and surface them (018).
        if (tp.state.status === "completed" && tp.tool.includes("delegate") && tp.state.output) {
          try {
            const parsed = JSON.parse(tp.state.output) as { artifacts?: unknown }
            if (Array.isArray(parsed.artifacts)) {
              for (const p of parsed.artifacts) {
                if (typeof p === "string") addIfNew(p, "file", seen, artifacts, workspaceRoot)
              }
            }
          } catch {
            // Not JSON (or no artifacts) — the regex scan below still runs.
          }
        }

        // Extract file paths from tool output text
        if (tp.state.status === "completed") {
          const { output, attachments } = tp.state
          if (output) {
            let match: RegExpExecArray | null
            // "Saved screenshot to /path/file.png" pattern
            FILE_PATH_RE.lastIndex = 0
            while ((match = FILE_PATH_RE.exec(output)) !== null) {
              const filePath = match[1].replace(/[."']+$/, "")
              addIfNew(filePath, "file", seen, artifacts, workspaceRoot)
            }
            // Absolute paths with known extensions
            ABS_PATH_RE.lastIndex = 0
            while ((match = ABS_PATH_RE.exec(output)) !== null) {
              addIfNew(match[1], "file", seen, artifacts, workspaceRoot)
            }
          }
          // Collect tool attachments (skip data URIs — only show workspace files)
          if (attachments) {
            for (const att of attachments) {
              const url = att.url || ""
              if (url.startsWith("data:")) continue
              const path = att.filename || url || "unknown"
              addIfNew(path, "file", seen, artifacts, workspaceRoot, att.mime)
            }
          }
        }
      }
    }
  }
  return artifacts
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-3.5 shrink-0 text-blue-500" />
  return <FileIcon filename={artifact.path} mime={artifact.mime} size={14} />
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
