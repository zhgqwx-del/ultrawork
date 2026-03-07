import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { CodeBlock } from "./code-block"
import { ReasoningBlock } from "./reasoning-block"
import { ToolCallBlock } from "./tool-call-block"
import { StepIndicator } from "./step-indicator"
import { FileText, FileDiff } from "lucide-react"
import type { MessagePart, ToolPart, FilePart, PatchPart } from "@agent/api-client"

interface AssistantMessageProps {
  parts: MessagePart[]
  isStreaming?: boolean
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
          p: ({ children }) => <p className="mb-4 last:mb-0 text-[--color-fg]">{children}</p>,
          ul: ({ children }) => <ul className="mb-4 ml-4 list-disc text-[--color-fg]">{children}</ul>,
          ol: ({ children }) => <ol className="mb-4 ml-4 list-decimal text-[--color-fg]">{children}</ol>,
          li: ({ children }) => <li className="mb-1 text-[--color-fg]">{children}</li>,
          h1: ({ children }) => <h1 className="mb-4 text-2xl font-bold text-[--color-fg]">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 text-xl font-bold text-[--color-fg]">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 text-lg font-semibold text-[--color-fg]">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="border-l-4 border-[--color-border] pl-4 italic text-[--color-fg-muted]">
              {children}
            </blockquote>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-[--color-primary] underline hover:opacity-80"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="min-w-full border-collapse border border-[--color-border]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[--color-border] bg-[--color-accent] px-3 py-2 text-left font-semibold text-[--color-fg]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border border-[--color-border] px-3 py-2 text-[--color-fg]">{children}</td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function FileBlock({ part }: { part: FilePart }) {
  const name = part.filename || part.url.split("/").pop() || "file"
  return (
    <div className="my-1.5 flex items-center gap-2 rounded-lg border border-[--color-border] bg-[--color-bg-subtle] px-3 py-2 text-xs">
      <FileText className="size-4 text-[--color-fg-muted]" />
      <span className="text-[--color-fg]">{name}</span>
      <span className="text-[--color-fg-muted]">{part.mime}</span>
    </div>
  )
}

function PatchBlock({ part }: { part: PatchPart }) {
  return (
    <div className="my-1.5 rounded-lg border border-[--color-border] bg-[--color-bg-subtle] px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <FileDiff className="size-4 text-blue-500" />
        <span className="font-medium text-[--color-fg]">{part.files.length} file{part.files.length !== 1 ? "s" : ""} changed</span>
      </div>
      {part.files.length > 0 && (
        <div className="mt-1 space-y-0.5 pl-6">
          {part.files.map((f, i) => (
            <p key={i} className="truncate text-[--color-fg-muted]" title={f}>{f}</p>
          ))}
        </div>
      )}
    </div>
  )
}

export function AssistantMessage({ parts, isStreaming = false }: AssistantMessageProps) {
  return (
    <div className="py-3">
      <div className="space-y-0">
        {parts.map((part, i) => {
          switch (part.type) {
            case "text":
              return <MarkdownContent key={i} text={part.text || ""} />
            case "reasoning":
              return <ReasoningBlock key={i} text={part.text || ""} />
            case "tool":
              return (
                <ToolCallBlock
                  key={i}
                  tool={(part as ToolPart).tool}
                  state={(part as ToolPart).state}
                />
              )
            case "step-finish":
              return (
                <StepIndicator
                  key={i}
                  reason={part.reason}
                  tokens={part.tokens}
                  cost={part.cost}
                />
              )
            case "file":
              return <FileBlock key={i} part={part as FilePart} />
            case "patch":
              return <PatchBlock key={i} part={part as PatchPart} />
            case "step-start":
              return null
            default:
              return null
          }
        })}

        {isStreaming && (
          <div className="flex items-center gap-2 py-2">
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 animate-pulse rounded-full bg-[--color-primary]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[--color-primary] [animation-delay:0.2s]" />
              <span className="inline-block size-2 animate-pulse rounded-full bg-[--color-primary] [animation-delay:0.4s]" />
            </div>
            <span className="text-xs text-[--color-fg-muted]">AI is typing...</span>
          </div>
        )}
      </div>
    </div>
  )
}
