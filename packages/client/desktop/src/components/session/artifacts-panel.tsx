import { useState } from "react"
import { FileDiff, ChevronRight } from "lucide-react"
import type { SendMessageResponse, FilePart, PatchPart, ToolPart } from "@agent/api-client"
import type { Artifact } from "./artifact-preview"
import { useI18n } from "@/lib/i18n-context"
import { cn } from "@/lib/utils"
import { pathBasename, isAbsolutePath } from "@/lib/path-utils"
import { FileIcon } from "@/components/ui/file-icon"

interface ArtifactsPanelProps {
  /** True outputs, front and centre. From `useSessionArtifacts`. */
  deliverables: Artifact[]
  /** Scripts/config the agent wrote on the way — demoted into a collapsed group. */
  working: Artifact[]
  onArtifactClick?: (artifact: Artifact) => void
  selectedPath?: string
}

/** Convert absolute path to relative by stripping workspace root prefix */
function toRelative(filePath: string, workspaceRoot?: string): string {
  if (!workspaceRoot || !filePath.startsWith(workspaceRoot)) return filePath
  let rel = filePath.slice(workspaceRoot.length)
  rel = rel.replace(/^[\\/]+/, "")
  return rel || filePath
}

/** File-modifying tool names whose filePath input should be tracked as artifacts */
const FILE_TOOL_SUFFIXES = ["write", "edit", "create", "patch"]

/** Tool name suffixes that produce file output via a path parameter */
const OUTPUT_TOOL_SUFFIXES = ["take_screenshot", "screenshot", "pdf_save", "save_file"]

/** Directories to exclude from artifact detection (temp/system paths). Tolerates both separators + Windows temp. */
const TEMP_PATH_RE = /[\\/](var[\\/]folders|tmp|private[\\/]tmp|Caches|playwright-mcp-output|AppData[\\/]Local[\\/]Temp)[\\/]/i

/** Match file paths in tool output text */
const FILE_PATH_RE = /(?:saved?\s+(?:screenshot|file|trace|report|image)\s+(?:to|as)\s+)(\S+)/gi

/** Match absolute file paths with common extensions in tool output (POSIX `/…` or Windows `C:\…`) */
const ABS_PATH_RE = /((?:\/|[A-Za-z]:[\\/])[\w./\\-]+\.(?:png|jpe?g|gif|svg|webp|pdf|html|json|csv|txt|md|ts|js|py))\b/gi

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
    if (isAbsolutePath(filePath)) {
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

/**
 * Merge filesystem-scanned paths (from `scan_workspace_changes`) into the
 * tool-derived artifact list. The scan catches outputs produced by bash/script
 * side-effects that no write/edit tool call ever named (the main reason real
 * deliverables went missing). Reuses the same validation/dedupe/relative-path
 * pipeline so scanned and tool-derived entries are indistinguishable downstream.
 */
export function mergeScannedPaths(base: Artifact[], paths: string[], workspaceRoot?: string): Artifact[] {
  const seen = new Set(base.map((a) => a.path))
  const merged = [...base]
  for (const p of paths) {
    if (!isValidArtifactPath(p, workspaceRoot)) continue
    const rel = toRelative(p, workspaceRoot)
    if (seen.has(rel)) continue
    seen.add(rel)
    merged.push({ type: "file", path: rel })
  }
  return merged
}

/** One file the workspace scan reported, with its mtime (epoch ms). */
export interface ScanHit {
  path: string
  mtimeMs: number
}

/** Grace appended to a turn's end so a file flushed just after the turn's last
 * message still counts as that turn's output (clock/fs-mtime skew). */
const TURN_GRACE_MS = 5000

/**
 * Time windows (epoch ms) during which THIS session was actively running a turn.
 * A turn opens at each user message and ends at its last assistant message's
 * completion (+grace); the final turn stays open (Infinity) while the agent is
 * active. Used to attribute scanned files to this session — a file written while
 * a DIFFERENT session ran (same workspace) falls outside every window, so the
 * panel no longer shows other sessions' files (the cross-session-leak fix). The
 * mtime baseline alone can't do this: many sessions share one workspace.
 */
export function sessionTurnWindows(messages: SendMessageResponse[], active?: boolean): Array<[number, number]> {
  const windows: Array<[number, number]> = []
  let start: number | null = null
  let end = 0
  for (const m of messages) {
    const t = m.info?.time
    const created = t?.created
    if (typeof created !== "number" || created <= 0) continue
    if (m.info.role === "user") {
      if (start !== null) windows.push([start, end + TURN_GRACE_MS])
      start = created
      end = created
    } else {
      if (start === null) start = created
      const done = t?.completed ?? created
      if (done > end) end = done
    }
  }
  if (start !== null) windows.push([start, active ? Number.POSITIVE_INFINITY : end + TURN_GRACE_MS])
  return windows
}

/** Keep only scanned files whose mtime falls inside one of this session's turn windows. */
export function filterScanByWindows(hits: ScanHit[], windows: Array<[number, number]>): string[] {
  if (windows.length === 0) return []
  return hits.filter((h) => windows.some(([s, e]) => h.mtimeMs >= s && h.mtimeMs <= e)).map((h) => h.path)
}

/**
 * Code/scripts/config extensions treated as "working files" (scaffolding) — kept
 * visible but demoted below true deliverables so an intermediate script (the .py
 * the agent wrote then ran) never masquerades as the product. Anything NOT here
 * (pdf/docx/xlsx/pptx/html/csv/md/images/archives/…) is a deliverable, since the
 * deliverable space is open-ended while working files are a bounded set.
 */
const WORKING_EXTS = new Set([
  "py", "pyw", "pyi",
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "sh", "bash", "zsh", "fish",
  "rb", "go", "rs", "java", "kt", "c", "cc", "cpp", "h", "hpp", "cs", "php", "pl", "lua", "r", "scala", "swift",
  "sql", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
])

function extOf(path: string): string {
  const base = pathBasename(path)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** A file is "working" if it's a script/code/config artifact. Patches stay deliverables. */
function isWorkingFile(a: Artifact): boolean {
  return a.type === "file" && WORKING_EXTS.has(extOf(a.path))
}

/**
 * Split artifacts into deliverables (front-and-centre) and working files
 * (demoted, collapsible). If there are NO deliverables, working files are
 * promoted into the deliverable slot so a pure-code task still shows its output
 * rather than an empty panel.
 */
export function classifyArtifacts(artifacts: Artifact[]): { deliverables: Artifact[]; working: Artifact[] } {
  const deliverables: Artifact[] = []
  const working: Artifact[] = []
  for (const a of artifacts) {
    if (isWorkingFile(a)) working.push(a)
    else deliverables.push(a)
  }
  if (deliverables.length === 0) return { deliverables: working, working: [] }
  return { deliverables, working }
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-3.5 shrink-0 text-blue-500" />
  return <FileIcon filename={artifact.path} mime={artifact.mime} size={14} />
}

function basename(path: string): string {
  return pathBasename(path)
}

function ArtifactRow({
  artifact,
  onArtifactClick,
  selectedPath,
  t,
}: {
  artifact: Artifact
  onArtifactClick?: (a: Artifact) => void
  selectedPath?: string
  t: (key: string) => string
}) {
  return (
    <div
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
  )
}

/**
 * Pure renderer (ADR-048 D5). The derivation it used to own — tool extraction,
 * the idle workspace scan, turn-window attribution, deliverable/working split —
 * now lives in `useSessionArtifacts` at the Session level, because the unread
 * badge and the preview's prev/next navigation need artifacts even while this
 * panel is unmounted (sidebar closed).
 */
export function ArtifactsPanel({ deliverables, working, onArtifactClick, selectedPath }: ArtifactsPanelProps) {
  const { t } = useI18n()
  const [workingOpen, setWorkingOpen] = useState(false)

  if (deliverables.length === 0 && working.length === 0) {
    return <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("message.noArtifacts")}</p>
  }

  // Only label the deliverables group when there's a separate working group to
  // distinguish it from — otherwise it's just "the artifacts".
  const showGroupLabel = working.length > 0

  return (
    <div data-testid="artifacts-panel" className="space-y-1">
      {showGroupLabel && (
        <div className="px-1 pt-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
          {t("artifact.groupDeliverables")}
        </div>
      )}
      {deliverables.map((artifact) => (
        <ArtifactRow
          key={artifact.path}
          artifact={artifact}
          onArtifactClick={onArtifactClick}
          selectedPath={selectedPath}
          t={t}
        />
      ))}

      {working.length > 0 && (
        <div className="pt-1">
          <button
            onClick={() => setWorkingOpen((v) => !v)}
            className="flex w-full items-center gap-1 px-1 py-1 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
          >
            <ChevronRight className={cn("size-3 transition-transform", workingOpen && "rotate-90")} />
            {t("artifact.groupWorking")}
            <span className="ml-0.5 normal-case opacity-70">({working.length})</span>
          </button>
          {workingOpen &&
            working.map((artifact) => (
              <ArtifactRow
                key={artifact.path}
                artifact={artifact}
                onArtifactClick={onArtifactClick}
                selectedPath={selectedPath}
                t={t}
              />
            ))}
        </div>
      )}
    </div>
  )
}
