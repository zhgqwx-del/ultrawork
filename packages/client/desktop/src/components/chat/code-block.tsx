import { memo } from "react"
import { CopyButton } from "./copy-button"

interface CodeBlockProps {
  children: string
  className?: string
  inline?: boolean
}

export const CodeBlock = memo(function CodeBlock({ children, className, inline }: CodeBlockProps) {
  // Extract language from className (format: "language-xxx")
  const language = className?.replace(/language-/, "") || "text"

  // Inline code
  if (inline) {
    return (
      <code className="rounded bg-[var(--color-accent)] px-1.5 py-0.5 font-mono text-sm text-[var(--color-fg)]">
        {children}
      </code>
    )
  }

  // Code block
  return (
    <div className="group relative my-4 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-accent)] px-4 py-2">
        <span className="text-xs font-medium text-[var(--color-fg-muted)]">{language}</span>
        <CopyButton
          text={children}
          label="Copy"
          copiedLabel="Copied!"
          ariaLabel="Copy code"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg)] hover:text-[var(--color-fg)]"
        />
      </div>

      {/* Code content */}
      <pre className="overflow-x-auto p-4">
        <code className="font-mono text-sm text-[var(--color-fg)]">{children}</code>
      </pre>
    </div>
  )
})
