import { memo } from "react"
import ReactMarkdown from "react-markdown"
import type { Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock } from "./code-block"
import { ReasoningBlock } from "./reasoning-block"
import { ToolCallBlock } from "./tool-call-block"
import { StepIndicator } from "./step-indicator"
import { FileText, FileDiff } from "lucide-react"
import type { MessagePart, ToolPart, FilePart, PatchPart } from "@agent/api-client"
import type { Artifact } from "@/components/session/artifact-preview"
import { useI18n } from "@/lib/i18n-context"

interface AssistantMessageProps {
  parts: MessagePart[]
  isStreaming?: boolean
  onArtifactClick?: (artifact: Artifact) => void
}

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
  p: ({ children }) => <p className="mb-4 last:mb-0 text-[var(--color-fg)]">{children}</p>,
  ul: ({ children }) => <ul className="mb-4 ml-4 list-disc text-[var(--color-fg)]">{children}</ul>,
  ol: ({ children }) => <ol className="mb-4 ml-4 list-decimal text-[var(--color-fg)]">{children}</ol>,
  li: ({ children }) => <li className="mb-1 text-[var(--color-fg)]">{children}</li>,
  h1: ({ children }) => <h1 className="mb-4 text-2xl font-bold text-[var(--color-fg)]">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 text-xl font-bold text-[var(--color-fg)]">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 text-lg font-semibold text-[var(--color-fg)]">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-[var(--color-border)] pl-4 italic text-[var(--color-fg-muted)]">
      {children}
    </blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-[var(--color-primary)] underline hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
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

const MarkdownContent = memo(function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

const FileBlock = memo(function FileBlock({ part, onArtifactClick }: { part: FilePart; onArtifactClick?: (artifact: Artifact) => void }) {
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

const PatchBlock = memo(function PatchBlock({ part, onArtifactClick }: { part: PatchPart; onArtifactClick?: (artifact: Artifact) => void }) {
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

export const AssistantMessage = memo(function AssistantMessage({ parts, isStreaming = false, onArtifactClick }: AssistantMessageProps) {
  const { t } = useI18n()
  return (
    <div className="py-3">
      <div className="space-y-0">
        {parts.map((part, i) => {
          const key = ('id' in part && part.id) ? part.id : `part-${i}`
          switch (part.type) {
            case "text":
              return <MarkdownContent key={key} text={part.text || ""} />
            case "reasoning":
              return <ReasoningBlock key={key} text={part.text || ""} />
            case "tool":
              return (
                <ToolCallBlock
                  key={key}
                  tool={(part as ToolPart).tool}
                  state={(part as ToolPart).state}
                />
              )
            case "step-finish":
              return (
                <StepIndicator
                  key={key}
                  reason={part.reason}
                  tokens={part.tokens}
                  cost={part.cost}
                />
              )
            case "file":
              return (
                <FileBlock
                  key={key}
                  part={part as FilePart}
                  onArtifactClick={onArtifactClick}
                />
              )
            case "patch":
              return (
                <PatchBlock
                  key={key}
                  part={part as PatchPart}
                  onArtifactClick={onArtifactClick}
                />
              )
            case "step-start":
              return null
            default:
              return null
          }
        })}

        {isStreaming && (
          <div className="flex items-center gap-2 py-2">
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.2s]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[var(--color-primary)] [animation-delay:0.4s]" />
            </div>
            <span className="text-xs text-[var(--color-fg-muted)]">{t("message.aiTyping")}</span>
          </div>
        )}
      </div>
    </div>
  )
})
