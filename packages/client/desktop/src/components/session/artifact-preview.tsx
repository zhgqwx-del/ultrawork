import { useState, useEffect } from "react"
import { X, FileText, FileDiff, FileImage, File, Copy, Check } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { CodeBlock } from "@/components/chat/code-block"

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

function getLanguageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", go: "go", rs: "rust", rb: "ruby", java: "java",
    c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    html: "html", css: "css", scss: "scss", sql: "sql",
    sh: "bash", bash: "bash", zsh: "bash",
    md: "markdown", mdx: "markdown",
  }
  return map[ext] || "text"
}

function isImageMime(mime?: string): boolean {
  return !!mime?.startsWith("image/")
}

function isMarkdown(path: string): boolean {
  return /\.(md|mdx)$/i.test(path)
}

function DiffView({ content }: { content: string }) {
  const lines = content.split("\n")
  return (
    <pre className="overflow-x-auto p-4 font-mono text-sm">
      {lines.map((line, i) => {
        let cls = "text-[--color-fg]"
        if (line.startsWith("+") && !line.startsWith("+++")) cls = "text-green-600 bg-green-500/10"
        else if (line.startsWith("-") && !line.startsWith("---")) cls = "text-red-600 bg-red-500/10"
        else if (line.startsWith("@@")) cls = "text-blue-500 bg-blue-500/10"
        return (
          <div key={i} className={cls}>
            {line}
          </div>
        )
      })}
    </pre>
  )
}

function ArtifactIcon({ artifact }: { artifact: Artifact }) {
  if (artifact.type === "patch") return <FileDiff className="size-4 shrink-0 text-blue-500" />
  if (isImageMime(artifact.mime)) return <FileImage className="size-4 shrink-0 text-purple-500" />
  if (artifact.path.endsWith(".md") || artifact.path.endsWith(".mdx")) return <FileText className="size-4 shrink-0 text-orange-500" />
  return <File className="size-4 shrink-0 text-[--color-fg-muted]" />
}

function basename(path: string): string {
  return path.split("/").pop() || path
}

export function ArtifactPreview({ artifact, onClose }: ArtifactPreviewProps) {
  const api = useApi()
  const { t } = useI18n()
  const [content, setContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setContent(null)

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
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  const language = getLanguageFromPath(artifact.path)

  return (
    <div className="flex h-full flex-col overflow-hidden border-r border-[--color-border] bg-[--color-bg]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-[--color-border] px-4 py-3">
        <ArtifactIcon artifact={artifact} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-[--color-fg]" title={artifact.path}>
          {basename(artifact.path)}
        </span>
        {content && (
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-[--color-fg-muted] hover:bg-[--color-accent] hover:text-[--color-fg]"
          >
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </button>
        )}
        <button
          onClick={onClose}
          className="flex items-center justify-center rounded p-1 text-[--color-fg-muted] hover:bg-[--color-accent] hover:text-[--color-fg]"
          aria-label={t("artifact.close")}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Path breadcrumb */}
      <div className="border-b border-[--color-border] px-4 py-1.5 text-xs text-[--color-fg-muted]">
        {artifact.path}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto scrollbar-soft">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-sm text-[--color-fg-muted]">
            {t("artifact.loading")}
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-12 text-sm text-red-500">
            {error}
          </div>
        ) : content === null || content === "" ? (
          <div className="flex items-center justify-center py-12 text-sm text-[--color-fg-muted]">
            {t("artifact.noContent")}
          </div>
        ) : artifact.type === "patch" ? (
          <DiffView content={content} />
        ) : isImageMime(artifact.mime) ? (
          <div className="flex items-center justify-center p-8">
            <img
              src={`data:${artifact.mime || "image/png"};base64,${content}`}
              alt={basename(artifact.path)}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : isMarkdown(artifact.path) ? (
          <div className="prose prose-sm max-w-none p-4 dark:prose-invert">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        ) : (
          <CodeBlock className={`language-${language}`}>{content}</CodeBlock>
        )}
      </div>
    </div>
  )
}
