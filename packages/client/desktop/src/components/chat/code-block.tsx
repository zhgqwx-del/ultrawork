import { useState } from "react"
import { Check, Copy } from "lucide-react"

interface CodeBlockProps {
  children: string
  className?: string
  inline?: boolean
}

export function CodeBlock({ children, className, inline }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  // Extract language from className (format: "language-xxx")
  const language = className?.replace(/language-/, "") || "text"

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // Inline code
  if (inline) {
    return (
      <code className="rounded bg-[--color-accent] px-1.5 py-0.5 font-mono text-sm text-[--color-fg]">
        {children}
      </code>
    )
  }

  // Code block
  return (
    <div className="group relative my-4 overflow-hidden rounded-lg border border-[--color-border] bg-[--color-bg]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[--color-border] bg-[--color-accent] px-4 py-2">
        <span className="text-xs font-medium text-[--color-fg-muted]">{language}</span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[--color-fg-muted] transition-colors hover:bg-[--color-bg] hover:text-[--color-fg]"
          aria-label="Copy code"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              <span>Copied!</span>
            </>
          ) : (
            <>
              <Copy className="size-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code content */}
      <pre className="overflow-x-auto p-4">
        <code className="font-mono text-sm text-[--color-fg]">{children}</code>
      </pre>
    </div>
  )
}
