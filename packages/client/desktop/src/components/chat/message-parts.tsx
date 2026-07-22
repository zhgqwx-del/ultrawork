import { memo, useMemo } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { FileText, FileDiff } from "lucide-react"
import type { FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { useI18n } from "@/lib/i18n-context"
import { MarkdownLink } from "@/components/ui/markdown-link"
import { MarkdownImage, MarkdownImageContext } from "./markdown-image"
import { CodeBlock } from "./code-block"

// Shared part renderers used by both the per-turn answer area (AssistantTurn)
// and the legacy AssistantMessage. Extracted so the markdown component map is
// created once and not duplicated across files.

// Module-level constant: created once, never re-created on render.
// This prevents ReactMarkdown from re-parsing markdown on every parent render.
const MARKDOWN_COMPONENTS: Components = {
  pre({ children }) {
    const codeEl = children as React.ReactElement<{ className?: string; children?: React.ReactNode }>
    const className = codeEl?.props?.className
    const content = String(codeEl?.props?.children ?? "").replace(/\n$/, "")
    return (
      <CodeBlock inline={false} className={className}>
        {content}
      </CodeBlock>
    )
  },
  code({ className, children }) {
    const content = String(children).replace(/\n$/, "")
    return (
      <CodeBlock inline={true} className={className}>
        {content}
      </CodeBlock>
    )
  },
  p: ({ children }) => <p className="mb-2.5 last:mb-0 text-[var(--color-fg)]">{children}</p>,
  ul: ({ children }) => <ul className="mb-2.5 ml-5 list-disc text-[var(--color-fg)]">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-5 list-decimal text-[var(--color-fg)]">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5 text-[var(--color-fg)]">{children}</li>,
  h1: ({ children }) => <h1 className="mt-5 mb-2.5 first:mt-0 text-lg font-bold text-[var(--color-fg)]">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-5 mb-2 first:mt-0 text-base font-semibold text-[var(--color-fg)]">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-4 mb-1.5 first:mt-0 text-sm font-semibold text-[var(--color-fg)]">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-[var(--color-border)] pl-4 italic text-[var(--color-fg-muted)]">
      {children}
    </blockquote>
  ),
  a: MarkdownLink,
  img: ({ src, alt }) => <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="min-w-full border-collapse border border-[var(--color-border)]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-[var(--color-border)] bg-[var(--color-accent)] px-3 py-2 text-left font-semibold text-[var(--color-fg)]">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-[var(--color-border)] px-3 py-2 text-[var(--color-fg)]">{children}</td>
  ),
}

const REMARK_PLUGINS = [remarkGfm]

/**
 * react-markdown's `defaultUrlTransform` blanks any `data:` URI and any URL
 * whose scheme isn't http/https/mailto/… — which silently includes image
 * `data:` URIs AND Windows drive paths (`C:\…`, because `c:` reads as a scheme).
 * Both are legitimate image `src`s the model emits; blanking them here would
 * defeat MarkdownImage before it ever runs (verified: default transform returns
 * "" for both). Preserve exactly those two and defer everything else to the
 * default, so `javascript:`, `data:text/html`, … stay blocked. Links are
 * unaffected — MarkdownLink re-gates every href through isOpenableUrl
 * (http/https/mailto/tel only), so a passed-through `data:`/`C:\` href still
 * renders as inert text.
 */
function chatUrlTransform(url: string): string {
  if (/^data:image\//i.test(url)) return url
  if (/^[A-Za-z]:[\\/]/.test(url)) return url // Windows drive path
  return defaultUrlTransform(url)
}

export const MarkdownContent = memo(function MarkdownContent({
  text,
  workspaceDir,
  onArtifactClick,
}: {
  text: string
  /** Workspace root — lets inline `![](local-path)` images resolve. Omitted by
   *  non-chat callers (e.g. the legal-docs viewer), where local images stay inert. */
  workspaceDir?: string
  onArtifactClick?: (artifact: Artifact) => void
}) {
  // Stable object identity so the Provider doesn't re-render image consumers on
  // every parent render. `onArtifactClick` is a useCallback upstream (Session).
  const imgCtx = useMemo(() => ({ workspaceDir, onArtifactClick }), [workspaceDir, onArtifactClick])
  return (
    <MarkdownImageContext.Provider value={imgCtx}>
      <div className="chat-md prose prose-sm max-w-none dark:prose-invert">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} urlTransform={chatUrlTransform} components={MARKDOWN_COMPONENTS}>
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownImageContext.Provider>
  )
})

export const FileBlock = memo(function FileBlock({ part, onArtifactClick }: { part: FilePart; onArtifactClick?: (artifact: Artifact) => void }) {
  const name = part.filename || part.url.split("/").pop() || "file"
  const handleClick = onArtifactClick ? () => onArtifactClick({
    type: "file",
    path: part.filename || part.url || "unknown",
    mime: part.mime,
  }) : undefined
  return (
    <div
      onClick={handleClick}
      className={`my-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs ${
        onArtifactClick ? "cursor-pointer hover:border-[var(--color-primary)]/40" : ""
      }`}
    >
      <FileText className="size-4 text-[var(--color-fg-muted)]" />
      <span className="text-[var(--color-fg)]">{name}</span>
      <span className="text-[var(--color-fg-muted)]">{part.mime}</span>
    </div>
  )
})

export const PatchBlock = memo(function PatchBlock({ part, onArtifactClick }: { part: PatchPart; onArtifactClick?: (artifact: Artifact) => void }) {
  const { t } = useI18n()
  const handleClick = onArtifactClick && part.files.length > 0 ? () => onArtifactClick({
    type: "patch",
    path: part.files[0],
  }) : undefined
  return (
    <div
      onClick={handleClick}
      className={`my-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs ${
        onArtifactClick ? "cursor-pointer hover:border-[var(--color-primary)]/40" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <FileDiff className="size-4 text-blue-500" />
        <span className="font-medium text-[var(--color-fg)]">{part.files.length} {t("workspace.filesChanged")}</span>
      </div>
      {part.files.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-6">
          {part.files.map((f, i) => (
            <p key={`${f}-${i}`} className="truncate text-[var(--color-fg-muted)]" title={f}>{f}</p>
          ))}
        </div>
      )}
    </div>
  )
})
