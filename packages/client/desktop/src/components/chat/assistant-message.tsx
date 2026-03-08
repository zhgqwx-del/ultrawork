import ReactMarkdown from "react-markdown"
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

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none dark:prose-invert">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { className, children } = props
            const inline = 'inline' in props ? props.inline as boolean : false
            const content = String(children).replace(/\n$/, "")
            return (
              <CodeBlock inline={inline} className={className}>
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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function FileBlock({ part, onClick }: { part: FilePart; onClick?: () => void }) {
  const name = part.filename || part.url.split("/").pop() || "file"
  return (
    <div
      onClick={onClick}
      className={`my-1.5 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs ${
        onClick ? "cursor-pointer hover:border-[var(--color-primary)]/40" : ""
      }`}
    >
      <FileText className="size-4 text-[var(--color-fg-muted)]" />
      <span className="text-[var(--color-fg)]">{name}</span>
      <span className="text-[var(--color-fg-muted)]">{part.mime}</span>
    </div>
  )
}

function PatchBlock({ part, onClick }: { part: PatchPart; onClick?: () => void }) {
  const { t } = useI18n()
  return (
    <div
      onClick={onClick}
      className={`my-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2 text-xs ${
        onClick ? "cursor-pointer hover:border-[var(--color-primary)]/40" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <FileDiff className="size-4 text-blue-500" />
        <span className="font-medium text-[var(--color-fg)]">{part.files.length} {t("workspace.filesChanged")}</span>
      </div>
      {part.files.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-6">
          {part.files.map((f, i) => (
            <p key={i} className="truncate text-[var(--color-fg-muted)]" title={f}>{f}</p>
          ))}
        </div>
      )}
    </div>
  )
}

export function AssistantMessage({ parts, isStreaming = false, onArtifactClick }: AssistantMessageProps) {
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
            case "file": {
              const fp = part as FilePart
              return (
                <FileBlock
                  key={key}
                  part={fp}
                  onClick={onArtifactClick ? () => onArtifactClick({
                    type: "file",
                    path: fp.filename || fp.url || "unknown",
                    mime: fp.mime,
                  }) : undefined}
                />
              )
            }
            case "patch": {
              const pp = part as PatchPart
              return (
                <PatchBlock
                  key={key}
                  part={pp}
                  onClick={onArtifactClick && pp.files.length > 0 ? () => onArtifactClick({
                    type: "patch",
                    path: pp.files[0],
                  }) : undefined}
                />
              )
            }
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
}
