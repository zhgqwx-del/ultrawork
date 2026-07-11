import { useState, useEffect, useRef, useMemo, useCallback } from "react"
import { X, FileDiff, Copy, Check, FolderOpen, ExternalLink, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react"
import { invoke } from "@tauri-apps/api/core"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import CodeMirror from "@uiw/react-codemirror"
import { githubLight, githubDark } from "@uiw/codemirror-theme-github"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useTheme } from "@/lib/theme-context"
import { cn } from "@/lib/utils"
import { pathBasename, isAbsolutePath } from "@/lib/path-utils"
import { extractExtension, getLanguageExtension } from "@/lib/codemirror-lang"
import { FileIcon, isBinaryFile, getFileTypeLabel } from "@/components/ui/file-icon"
import { PdfView } from "./pdf-view"

export interface Artifact {
  type: "file" | "patch"
  path: string
  mime?: string
  sessionId?: string
}

interface ArtifactPreviewProps {
  artifact: Artifact
  /** Workspace root directory — used to resolve relative paths to absolute for system operations */
  directory?: string
  onClose: () => void
  /**
   * Prev/next through the session's artifact list (ADR-048 D3). Opening a preview
   * collapses the right sidebar, which is where the artifact list lives — without
   * navigation here, browsing several artifacts would mean closing and reopening
   * the sidebar once per file. Omitted (→ controls hidden) when the previewed file
   * isn't in the list, e.g. one picked from the workspace file tree.
   */
  nav?: {
    /** 0-based position of this artifact within the list. */
    index: number
    total: number
    onPrev: () => void
    onNext: () => void
  }
  /** Half ⇄ full width toggle. Omitted → the control is hidden. */
  maximized?: boolean
  onToggleMaximized?: () => void
}

const IMAGE_EXTS = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i

function isImage(mime?: string, path?: string): boolean {
  if (mime?.startsWith("image/")) return true
  if (path && IMAGE_EXTS.test(path)) return true
  return false
}

function isMarkdown(path: string): boolean {
  return /\.(md|mdx)$/i.test(path)
}

function isHtml(path: string): boolean {
  return /\.(html?|xhtml)$/i.test(path)
}

function isPdf(path: string): boolean {
  return /\.pdf$/i.test(path)
}

function DiffView({ content }: { content: string }) {
  const lines = content.split("\n")
  return (
    <pre className="overflow-x-auto p-4 font-mono text-sm">
      {lines.map((line, i) => {
        let cls = "text-[var(--color-fg)]"
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-600 bg-green-500/10 dark:text-green-400"
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-600 bg-red-500/10 dark:text-red-400"
        else if (line.startsWith("@@")) cls = "text-blue-500 bg-blue-500/10"
        return (
          <div key={i} className={cn(cls, "flex")}>
            <span className="inline-block w-10 shrink-0 select-none pr-3 text-right text-[var(--color-fg-muted)] opacity-50">{i + 1}</span>
            <span className="flex-1">{line}</span>
          </div>
        )
      })}
    </pre>
  )
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-4 shrink-0 text-blue-500" />
  return <FileIcon filename={artifact.path} mime={artifact.mime} size={16} />
}

function basename(path: string): string {
  return pathBasename(path)
}

/** Resolve artifact path to absolute path for system operations */
function resolveAbsPath(artifactPath: string, directory?: string): string {
  if (isAbsolutePath(artifactPath)) return artifactPath
  // Forward slash join is accepted by Windows file APIs too — keep it simple.
  if (directory) return `${directory.replace(/[\\/]$/, "")}/${artifactPath}`
  return artifactPath
}

/** Binary file info card — shown for non-previewable files like pptx, docx, etc. */
function BinaryFileCard({
  artifact,
  directory,
  t,
}: {
  artifact: Artifact
  directory?: string
  t: (key: string) => string
}) {
  const absPath = resolveAbsPath(artifact.path, directory)
  const typeLabel = getFileTypeLabel(artifact.path)

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="flex flex-col items-center gap-4 text-center">
        <FileIcon filename={artifact.path} mime={artifact.mime} size={48} />
        <div>
          <p className="text-sm font-medium text-[var(--color-fg)]">{basename(artifact.path)}</p>
          <p className="mt-1 text-xs text-[var(--color-fg-muted)]">{typeLabel}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => {
              console.log("[BinaryFileCard] openPath:", absPath)
              invoke("open_file_with_system", { path: absPath }).catch((e) => console.error("[BinaryFileCard] openPath failed:", e))
            }}
            className="flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            <ExternalLink className="size-3.5" />
            {t("artifact.openWithApp")}
          </button>
          <button
            onClick={() => {
              console.log("[BinaryFileCard] revealItemInDir:", absPath)
              invoke("reveal_file_in_finder", { path: absPath }).catch((e) => console.error("[BinaryFileCard] revealItemInDir failed:", e))
            }}
            className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            <FolderOpen className="size-3.5" />
            {t("artifact.revealInFinder")}
          </button>
        </div>
      </div>
    </div>
  )
}

export function ArtifactPreview({ artifact, directory, onClose, nav, maximized, onToggleMaximized }: ArtifactPreviewProps) {
  const api = useApi()
  const { t } = useI18n()
  const { resolvedTheme } = useTheme()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  /** MIME type resolved from API response (fallback for file-tree clicks with no mime) */
  const [resolvedMime, setResolvedMime] = useState<string | undefined>(artifact.mime)

  const cmTheme = resolvedTheme === "dark" ? githubDark : githubLight
  const absPath = resolveAbsPath(artifact.path, directory)
  const binary = artifact.type === "file" && isBinaryFile(artifact.path)
  // PDFs render in-app via pdf.js (PdfView reads bytes itself), so skip the text
  // content fetch — the backend returns empty content for pdf, which would
  // otherwise fall through to a blank "no content" state.
  const pdf = artifact.type === "file" && isPdf(artifact.path)

  const cmExtensions = useMemo(() => {
    const ext = extractExtension(artifact.path)
    const lang = getLanguageExtension(ext)
    return lang ? [lang] : []
  }, [artifact.path])

  useEffect(() => {
    return () => { clearTimeout(copyTimerRef.current) }
  }, [])

  useEffect(() => {
    // Reset prior state up-front so a stale error/content from a previously
    // selected artifact never bleeds into a binary/pdf view (both skip loading,
    // and the render checks `error` before the pdf branch).
    setError(null)
    setContent(null)
    setResolvedMime(artifact.mime)

    // Skip loading for binary files (info card) and PDFs (pdf.js reads bytes).
    if (binary || pdf) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    async function load() {
      try {
        if (artifact.type === "patch" && artifact.sessionId) {
          const diffs = await api.getSessionDiff(artifact.sessionId)
          if (!cancelled) {
            setContent(diffs.length > 0 ? diffs.join("\n") : "")
            setLoading(false)
          }
        } else {
          const resp = await api.getFileContent(artifact.path)
          if (!cancelled) {
            setContent(resp.content)
            if (resp.mimeType) setResolvedMime(resp.mimeType)
            setLoading(false)
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(t("artifact.loadError"))
          setLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [artifact.path, artifact.type, artifact.sessionId, artifact.mime, api, t, binary, pdf])

  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const handleRevealInFinder = useCallback(() => {
    console.log("[ArtifactPreview] revealItemInDir:", absPath)
    invoke("reveal_file_in_finder", { path: absPath }).catch((e) => console.error("[ArtifactPreview] revealItemInDir failed:", e))
  }, [absPath])

  const handleOpenWithApp = useCallback(() => {
    console.log("[ArtifactPreview] openPath:", absPath)
    invoke("open_file_with_system", { path: absPath }).catch((e) => console.error("[ArtifactPreview] openPath failed:", e))
  }, [absPath])

  // Escape steps back one level rather than jumping straight out: maximized →
  // half → closed. (Skip if another handler already consumed the event.)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return
      if (maximized && onToggleMaximized) onToggleMaximized()
      else onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose, maximized, onToggleMaximized])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <ArtifactIcon artifact={artifact} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-fg)]" title={artifact.path}>
          {basename(artifact.path)}
        </span>

        {/* Prev/next through the session's artifacts — the sidebar list is
            collapsed while the preview is up, so this is the only way to browse. */}
        {nav && nav.total > 1 && (
          <div className="flex shrink-0 items-center gap-0.5 text-xs text-[var(--color-fg-muted)]">
            <button
              onClick={nav.onPrev}
              disabled={nav.index === 0}
              aria-label={t("artifact.prev")}
              title={t("artifact.prev")}
              className="flex items-center justify-center rounded p-1 hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronLeft className="size-4" />
            </button>
            <span className="tabular-nums" aria-live="polite">
              {nav.index + 1} / {nav.total}
            </span>
            <button
              onClick={nav.onNext}
              disabled={nav.index >= nav.total - 1}
              aria-label={t("artifact.next")}
              title={t("artifact.next")}
              className="flex items-center justify-center rounded p-1 hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:pointer-events-none disabled:opacity-30"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        )}

        {/* Open with system app — for PDFs (Preview.app, etc.) */}
        {pdf && (
          <button
            onClick={handleOpenWithApp}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            title={t("artifact.openWithApp")}
          >
            <ExternalLink className="size-3" />
          </button>
        )}

        {/* Open in browser — for HTML files */}
        {artifact.type === "file" && isHtml(artifact.path) && (
          <button
            onClick={handleOpenWithApp}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            title={t("artifact.openInBrowser")}
          >
            <ExternalLink className="size-3" />
          </button>
        )}

        {/* Reveal in Finder — for all non-patch artifacts */}
        {artifact.type === "file" && (
          <button
            onClick={handleRevealInFinder}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
            title={t("artifact.revealInFinder")}
          >
            <FolderOpen className="size-3" />
          </button>
        )}

        {/* Copy button — only for text content */}
        {content && !binary && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        )}
        {/* Half ⇄ full. Full hides the transcript but keeps the composer, so the
            user can keep talking while reading (ADR-048 D4). */}
        {onToggleMaximized && (
          <button
            onClick={onToggleMaximized}
            data-testid="preview-maximize"
            aria-label={maximized ? t("artifact.restore") : t("artifact.maximize")}
            title={maximized ? t("artifact.restore") : t("artifact.maximize")}
            className="flex items-center justify-center rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded p-1 text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          aria-label={t("artifact.close")}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Path breadcrumb */}
      <div className="border-b border-[var(--color-border)] px-4 py-1.5 text-xs text-[var(--color-fg-muted)]">
        {artifact.path}
      </div>

      {/* Content */}
      <div className={
        artifact.type !== "patch" && !isImage(resolvedMime, artifact.path) && !isMarkdown(artifact.path) && !binary && !loading && !error && content
          ? "flex-1 overflow-hidden"
          : "flex-1 overflow-auto scrollbar-soft"
      }>
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-fg-muted)]">
            {t("artifact.loading")}
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-12 text-sm text-red-500">
            {error}
          </div>
        ) : pdf ? (
          <PdfView absPath={absPath} t={t} />
        ) : binary ? (
          <BinaryFileCard artifact={artifact} directory={directory} t={t} />
        ) : content === null || content === "" ? (
          <div className="flex items-center justify-center py-12 text-sm text-[var(--color-fg-muted)]">
            {artifact.type === "patch" ? t("artifact.noChanges") : t("artifact.noContent")}
          </div>
        ) : artifact.type === "patch" ? (
          <DiffView content={content} />
        ) : isImage(resolvedMime, artifact.path) ? (
          <div className="flex items-center justify-center p-8">
            <img
              src={`data:${resolvedMime || "image/png"};base64,${content}`}
              alt={basename(artifact.path)}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : isMarkdown(artifact.path) ? (
          <div className="prose prose-sm max-w-none p-4 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <CodeMirror
            value={content}
            readOnly
            editable={false}
            theme={cmTheme}
            extensions={cmExtensions}
            basicSetup={{
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: false,
              bracketMatching: false,
              autocompletion: false,
              defaultKeymap: false,
              searchKeymap: false,
            }}
            style={{ height: "100%", overflow: "auto" }}
          />
        )}
      </div>
    </div>
  )
}
