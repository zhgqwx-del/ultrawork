import { useState, useRef, useEffect, type KeyboardEvent, type ChangeEvent } from "react"
import { cn } from "@/lib/utils"
import { Loader2, Plus } from "lucide-react"

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  variant?: "home" | "reply"
  className?: string
  ctaLabel?: string
}

export function ChatInput({
  value,
  onChange,
  onSend,
  placeholder = "Ask anything...",
  disabled = false,
  loading = false,
  variant = "reply",
  className,
  ctaLabel = "Start Now",
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isComposing, setIsComposing] = useState(false)

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto"
    const newHeight = Math.min(textarea.scrollHeight, variant === "home" ? 200 : 120)
    textarea.style.height = `${newHeight}px`
  }, [value, variant])

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter without Shift and not composing → send
    if (e.key === "Enter" && !e.shiftKey && !isComposing) {
      e.preventDefault()
      if (value.trim() && !disabled && !loading) {
        onSend()
      }
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
  }

  const handleSendClick = () => {
    if (value.trim() && !disabled && !loading) {
      onSend()
    }
  }

  const canSend = value.trim() && !disabled && !loading

  return (
    <div
      className={cn(
        "relative rounded-2xl border border-[--color-border] bg-[--color-bg]",
        variant === "home" ? "shadow-lg p-4" : "shadow-sm py-2.5 pl-4 pr-3",
        className
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "w-full resize-none border-0 bg-transparent text-[--color-fg] placeholder:text-[--color-fg-muted] focus:outline-none disabled:opacity-50",
          variant === "home" ? "text-base" : "text-sm pr-10"
        )}
        rows={variant === "home" ? 2 : 1}
        style={{
          minHeight: variant === "home" ? "48px" : "20px",
          maxHeight: variant === "home" ? "200px" : "120px",
          overflow: "auto",
        }}
      />

      {variant === "home" ? (
        /* Home variant: toolbar below with send button flush bottom-right */
        <div className="mt-3 flex items-center">
          <button
            type="button"
            aria-label="Add attachment"
            disabled={disabled}
            className="flex size-7 items-center justify-center rounded-lg text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-[--color-fg] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Plus className="size-4" />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleSendClick}
            disabled={!canSend}
            className={cn(
              "rounded-lg px-5 py-2 text-sm font-medium transition-all",
              canSend
                ? "bg-[--color-brand] text-white hover:opacity-90"
                : "bg-[--color-brand]/60 text-white/80 cursor-default"
            )}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : ctaLabel}
          </button>
        </div>
      ) : (
        /* Reply variant: send button pinned bottom-right */
        <button
          type="button"
          onClick={handleSendClick}
          disabled={!canSend}
          aria-label={loading ? "Stop generating" : "Send message"}
          className={cn(
            "absolute bottom-2 right-2.5 flex size-7 items-center justify-center rounded-full transition-all",
            canSend
              ? "bg-[--color-fg] text-[--color-bg] hover:opacity-90"
              : "bg-[--color-fg-muted] text-[--color-bg] opacity-30"
          )}
        >
          {loading ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
            </svg>
          )}
        </button>
      )}
    </div>
  )
}
