import { useState, useEffect, useRef, useMemo } from "react"
import { X, FileText, FileDiff, FileImage, File, Copy, Check } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import CodeMirror from "@uiw/react-codemirror"
import { githubLight, githubDark } from "@uiw/codemirror-theme-github"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useTheme } from "@/lib/theme-context"
import { cn } from "@/lib/utils"
import { extractExtension, getLanguageExtension } from "@/lib/codemirror-lang"

export interface Artifact {
  type: "file" | "patch"
  path: string
  mime?: string
  sessionId?: string
}

interface ArtifactPreviewProps {
  artifact: Artifact
  onClose: () => void
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

function DiffView({ content }: { content: string }) {
  const lines = content.split("\n")
  return (
    <pre className="overflow-x-auto p-4 font-mono text-sm">
      {lines.map((line, i) => {
        let cls = "text-[var(--color-fg)]"
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-600 bg-green-500/10"
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-600 bg-red-500/10"
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
  if (isImage(artifact.mime, artifact.path)) return <FileImage className="size-4 shrink-0 text-purple-500" />
  if (artifact.path.endsWith(".md") || artifact.path.endsWith(".mdx")) return <FileText className="size-4 shrink-0 text-orange-500" />
  return <File className="size-4 shrink-0 text-[var(--color-fg-muted)]" />
}

function basename(path: string): string {
  return path.split("/").pop() || path
}

export function ArtifactPreview({ artifact, onClose }: ArtifactPreviewProps) {
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

  const cmExtensions = useMemo(() => {
    const ext = extractExtension(artifact.path)
    const lang = getLanguageExtension(ext)
    return lang ? [lang] : []
  }, [artifact.path])

  useEffect(() => {
    return () => { clearTimeout(copyTimerRef.current) }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)
    setResolvedMime(artifact.mime)

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
  }, [artifact.path, artifact.type, artifact.sessionId, api, t])

  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  // Escape key to close preview (skip if another handler already consumed the event)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [onClose])

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <ArtifactIcon artifact={artifact} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-fg)]" title={artifact.path}>
          {basename(artifact.path)}
        </span>
        {content && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)]"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
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
        artifact.type !== "patch" && !isImage(resolvedMime, artifact.path) && !isMarkdown(artifact.path) && !loading && !error && content
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
