import { memo, useState, useRef, useEffect, useCallback } from "react"
import { Check, Copy } from "lucide-react"

interface CopyButtonProps {
  /** Text written to the clipboard on click. */
  text: string
  /** Optional label shown next to the icon (e.g. "Copy"). Icon-only when absent. */
  label?: string
  /** Label shown for the 2s success window when `label` is set (defaults to `label`). */
  copiedLabel?: string
  /** Classes for the <button> element. */
  className?: string
  /** Classes for the icon (size/color). Defaults to `size-3`. */
  iconClassName?: string
  /** Accessible label (defaults to "Copy"). */
  ariaLabel?: string
}

/**
 * Shared copy-to-clipboard control. Extracted from CodeBlock so the per-message
 * copy affordance (user bubble / assistant answer) and the code-block header all
 * share one implementation: navigator.clipboard + a 2s "copied" confirmation +
 * timer cleanup. WKWebView supports navigator.clipboard; failures fall back to
 * leaving the icon unchanged (the click silently no-ops).
 */
export const CopyButton = memo(function CopyButton({
  text,
  label,
  copiedLabel,
  className,
  iconClassName = "size-3",
  ariaLabel = "Copy",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    return () => { clearTimeout(copyTimerRef.current) }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(copyTimerRef.current)
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error("Failed to copy:", err)
      // Fallback: the icon doesn't change, signalling the copy didn't happen.
    }
  }, [text])

  return (
    <button onClick={handleCopy} className={className} aria-label={ariaLabel} type="button">
      {copied ? (
        <Check className={`${iconClassName} text-green-600 dark:text-green-400`} />
      ) : (
        <Copy className={iconClassName} />
      )}
      {label != null && <span>{copied ? (copiedLabel ?? label) : label}</span>}
    </button>
  )
})
