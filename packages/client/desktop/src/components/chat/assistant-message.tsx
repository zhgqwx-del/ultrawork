import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Bot } from "lucide-react"
import { CodeBlock } from "./code-block"

interface AssistantMessageProps {
  content: string
  isStreaming?: boolean
}

export function AssistantMessage({ content, isStreaming = false }: AssistantMessageProps) {
  return (
    <div className="flex gap-3 py-4">
      {/* Avatar */}
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[--color-accent] text-[--color-fg]">
        <Bot className="size-4" />
      </div>

      {/* Content */}
      <div className="flex-1 space-y-2 pt-1">
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // Custom code block renderer
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
              // Style other elements
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
            {content}
          </ReactMarkdown>
        </div>

        {/* Streaming indicator */}
        {isStreaming && (
          <div className="flex items-center gap-1 text-xs text-[--color-fg-muted]">
            <span className="inline-block size-1 animate-pulse rounded-full bg-[--color-fg-muted]" />
            <span className="inline-block size-1 animate-pulse rounded-full bg-[--color-fg-muted] [animation-delay:0.2s]" />
            <span className="inline-block size-1 animate-pulse rounded-full bg-[--color-fg-muted] [animation-delay:0.4s]" />
          </div>
        )}
      </div>
    </div>
  )
}
