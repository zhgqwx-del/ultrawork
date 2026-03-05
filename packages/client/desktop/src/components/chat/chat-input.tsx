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
        "rounded-2xl border border-[--color-border] bg-[--color-bg] p-4",
        variant === "home" ? "shadow-lg" : "shadow-sm",
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
          variant === "home" ? "text-base" : "text-sm px-1"
        )}
        rows={variant === "home" ? 2 : 1}
        style={{
          minHeight: variant === "home" ? "48px" : "20px",
          maxHeight: variant === "home" ? "200px" : "120px",
          overflow: "auto",
        }}
      />

      {/* Bottom Toolbar */}
      <div className={cn("flex items-center justify-between", variant === "home" ? "mt-3" : "mt-2")}>
        {/* Left: + button */}
        <button
          type="button"
          aria-label="Add attachment"
          disabled={disabled}
          className="flex size-7 items-center justify-center rounded-lg text-[--color-fg-muted] transition-colors hover:bg-[--color-accent] hover:text-[--color-fg] disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Plus className="size-4" />
        </button>

        {/* Right: Send/Stop button */}
        <button
          type="button"
          onClick={handleSendClick}
          disabled={!canSend}
          aria-label={loading ? "Stop generating" : "Send message"}
          className={cn(
            "flex items-center justify-center rounded-full transition-all",
            variant === "home" ? "size-8" : "size-7",
            canSend
              ? "bg-[--color-fg] text-[--color-bg] hover:opacity-90"
              : "bg-[--color-fg-muted] text-[--color-bg] opacity-30"
          )}
        >
          {loading ? (
            <Loader2 className={cn("animate-spin", variant === "home" ? "size-4" : "size-3")} />
          ) : (
            <svg
              viewBox="0 0 24 24"
              className={cn(variant === "home" ? "size-4" : "size-3")}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {variant === "home" ? (
                // Arrow up icon for home
                <path d="M12 19V5M5 12l7-7 7 7" />
              ) : (
                // Send icon for reply
                <path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z" />
              )}
            </svg>
          )}
        </button>
      </div>
    </div>
  )
}
