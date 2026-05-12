import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Folder, FolderOpen, ChevronRight, ChevronDown, RefreshCw, Check, Copy } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import { FileIcon } from "@/components/ui/file-icon"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { shortenPath, pathBasename } from "@/lib/path-utils"
import type { FileEntry, FileStatusEntry } from "@agent/api-client"

interface WorkspacePanelProps {
  directory?: string
  /** Changes to this value trigger a file tree refresh */
  refreshKey?: number
  /** Called when a file (not directory) is clicked in the tree */
  onFileClick?: (path: string) => void
}

function GitStatusDot({ status }: { status: string }) {
  const { t } = useI18n()
  if (status === "added") return <span className="inline-block size-2 rounded-full bg-green-500" title={t("workspace.gitAdded")} />
  if (status === "deleted") return <span className="inline-block size-2 rounded-full bg-red-500" title={t("workspace.gitDeleted")} />
  return <span className="inline-block size-2 rounded-full bg-yellow-500" title={t("workspace.gitModified")} />
}

function FileTreeItem({
  entry,
  gitStatusMap,
  depth = 0,
  onFileClick,
}: {
  entry: FileEntry
  gitStatusMap: Map<string, string>
  depth?: number
  onFileClick?: (path: string) => void
}) {
  const api = useApi()
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  const isDir = entry.type === "directory"
  const gitStatus = gitStatusMap.get(entry.path)

  const fetchIdRef = useRef(0)
  const handleClick = useCallback(async () => {
    if (!isDir) {
      onFileClick?.(entry.path)
      return
    }
    if (expanded) {
      setExpanded(false)
      return
    }
    setExpanded(true)
    if (children !== null) return
    setLoading(true)
    const fetchId = ++fetchIdRef.current
    try {
      const items = await api.getFileTree(entry.path)
      if (fetchId !== fetchIdRef.current) return // stale request
      setChildren(items.filter(f => !f.ignored).sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      }))
    } catch {
      if (fetchId === fetchIdRef.current) setChildren([])
    } finally {
      if (fetchId === fetchIdRef.current) setLoading(false)
    }
  }, [isDir, expanded, children, api, entry.path, onFileClick])

  return (
    <div>
      <div
        onClick={handleClick}
        className={`flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-[var(--color-accent)] ${isDir || onFileClick ? "cursor-pointer" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {isDir ? (
          <>
            {expanded ? <ChevronDown className="size-3 shrink-0 text-[var(--color-fg-muted)]" /> : <ChevronRight className="size-3 shrink-0 text-[var(--color-fg-muted)]" />}
            {expanded ? <FolderOpen className="size-3.5 shrink-0 text-yellow-600" /> : <Folder className="size-3.5 shrink-0 text-yellow-600" />}
          </>
        ) : (
          <>
            <span className="size-3 shrink-0" />
            <FileIcon filename={entry.name} size={14} />
          </>
        )}
        <span className="min-w-0 flex-1 truncate text-[var(--color-fg)]">{entry.name}</span>
        {gitStatus && <GitStatusDot status={gitStatus} />}
      </div>

      {expanded && isDir && (
        <div>
          {loading && (
            <div className="py-1 text-[10px] text-[var(--color-fg-muted)]" style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}>
              {t("common.loading")}
            </div>
          )}
          {children && children.length === 0 && !loading && (
            <div className="py-1 text-[10px] text-[var(--color-fg-muted)]" style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}>
              {t("workspace.emptyDir")}
            </div>
          )}
          {children?.map((child) => (
            <FileTreeItem
              key={child.path}
              entry={child}
              gitStatusMap={gitStatusMap}
              depth={depth + 1}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function WorkspacePanel({ directory, refreshKey, onFileClick }: WorkspacePanelProps) {
  const api = useApi()
  const { t } = useI18n()
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [gitStatus, setGitStatus] = useState<FileStatusEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState(false)

  const gitStatusMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of gitStatus) {
      map.set(s.path, s.status)
    }
    return map
  }, [gitStatus])

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(false)
    try {
      const [fileList, statusList] = await Promise.all([
        // Always use "." — the x-opencode-directory header sets the workspace root;
        // passing absolute paths breaks because server joins Instance.directory + path
        api.getFileTree("."),
        api.getFileStatus(),
      ])
      setFiles(fileList.filter(f => !f.ignored).sort((a, b) => {
        if (a.type !== b.type) return a.type === "directory" ? -1 : 1
        return a.name.localeCompare(b.name)
      }))
      setGitStatus(statusList)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [api]) // eslint-disable-line react-hooks/exhaustive-deps -- directory is passed via API header, not used in loadData

  const handleCopy = useCallback(() => {
    if (!directory) return
    navigator.clipboard.writeText(directory).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }).catch((e) => console.error("[WorkspacePanel] clipboard write failed:", e))
  }, [directory])

  useEffect(() => {
    loadData()
  }, [loadData, refreshKey])

  return (
    <div className="space-y-2">
      {/* Working directory header */}
      {directory && (
        <div className="flex items-center gap-2 rounded bg-[var(--color-accent)] px-2 py-1.5 text-xs">
          <button
            onClick={() => {
              invoke("reveal_file_in_finder", { path: directory }).catch((e) =>
                console.error("[WorkspacePanel] reveal_file_in_finder failed:", e),
              )
            }}
            className="shrink-0 rounded p-0.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            title={t("workspace.openInFinder")}
          >
            <Folder className="size-3.5" />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium text-[var(--color-fg)]">{pathBasename(directory)}</p>
            <p
              className="cursor-pointer truncate text-[10px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              title={directory}
              onClick={handleCopy}
            >
              {shortenPath(directory)}
            </p>
          </div>
          <button
            onClick={handleCopy}
            className="shrink-0 rounded p-0.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            title={copied ? t("common.copied") : directory}
          >
            {copied ? <Check className="size-3 text-green-500" /> : <Copy className="size-3" />}
          </button>
          <button
            onClick={loadData}
            className="shrink-0 rounded p-0.5 text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            aria-label={t("workspace.refresh")}
          >
            <RefreshCw className="size-3" />
          </button>
        </div>
      )}

      {/* Git status summary */}
      {gitStatus.length > 0 && (
        <div className="flex items-center gap-1.5 px-1 text-[10px] text-[var(--color-fg-muted)]">
          <span className="inline-block size-2 rounded-full bg-yellow-500" />
          <span>{gitStatus.length} {t("workspace.filesChanged")}</span>
        </div>
      )}

      {/* File tree */}
      {loading && !files && (
        <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("common.loading")}</p>
      )}
      {error && (
        <p className="py-2 text-xs text-red-500">{t("workspace.loadError")}</p>
      )}
      {files && files.length === 0 && (
        <p className="py-2 text-xs text-[var(--color-fg-muted)]">{t("workspace.awaitingAgent")}</p>
      )}
      {files && files.length > 0 && (
        <div className="max-h-64 overflow-y-auto scrollbar-soft">
          {files.map((entry) => (
            <FileTreeItem
              key={entry.path}
              entry={entry}
              gitStatusMap={gitStatusMap}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
    </div>
  )
}
