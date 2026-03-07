import { useState, useRef, useEffect, type KeyboardEvent, type ChangeEvent } from "react"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n-context"
import { Loader2, Plus } from "lucide-react"
import { CommandSelector } from "./command-selector"
import type { Command } from "@agent/api-client"

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
  leftSlot?: React.ReactNode
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
  leftSlot,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [isComposing, setIsComposing] = useState(false)
  const { t } = useI18n()
  // Only show command selector while typing the command name (no space yet)
  const showCommandSelector = value.startsWith("/") && !value.includes(" ") && !disabled && !loading

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto"
    const newHeight = Math.min(textarea.scrollHeight, variant === "home" ? 200 : 120)
    textarea.style.height = `${newHeight}px`
  }, [value, variant])

  const handleSelectCommand = (cmd: Command) => {
    // Replace input with /<command> and let user add arguments
    onChange(`/${cmd.name} `)
    textareaRef.current?.focus()
  }

  const handleCloseCommandSelector = () => {
    // Remove the "/" prefix to dismiss the selector, keep other text if any
    onChange(value.startsWith("/") ? value.slice(1) : value)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Let CommandSelector handle arrow/tab/enter/escape when visible
    if (showCommandSelector && ["ArrowDown", "ArrowUp", "Tab", "Escape"].includes(e.key)) {
      e.preventDefault() // Prevent cursor movement / focus change in textarea
      return // CommandSelector's document-level handler will capture this
    }
    // Enter without Shift and not composing → send (or let CommandSelector handle if it has matches)
    // Check both React state AND native isComposing — some browsers fire compositionEnd before keyDown
    if (e.key === "Enter" && !e.shiftKey && !isComposing && !e.nativeEvent.isComposing) {
      if (showCommandSelector) return // Let CommandSelector handle Enter when it has matches
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
        "relative rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg)]",
        variant === "home" ? "shadow-lg p-4" : "shadow-sm py-2.5 pl-4 pr-3",
        className
      )}
    >
      <CommandSelector
        input={value}
        onSelectCommand={handleSelectCommand}
        onClose={handleCloseCommandSelector}
        visible={showCommandSelector}
      />

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => {
          // Delay clearing composing state — some browsers fire compositionEnd before the
          // final keyDown (Enter), so we need isComposing to still be true during that keyDown
          setTimeout(() => setIsComposing(false), 0)
        }}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "w-full resize-none border-0 bg-transparent text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none disabled:opacity-50",
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
            aria-label={t("aria.attachment")}
            disabled={disabled}
            className="flex size-7 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <Plus className="size-4" />
          </button>
          {leftSlot}
          <div className="flex-1" />
          <button
            type="button"
            onClick={handleSendClick}
            disabled={!canSend}
            className={cn(
              "rounded-lg px-5 py-2 text-sm font-medium transition-all",
              canSend
                ? "bg-[var(--color-brand)] text-white hover:opacity-90"
                : "bg-[var(--color-brand)]/60 text-white/80 cursor-default"
            )}
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : ctaLabel}
          </button>
        </div>
      ) : (
        /* Reply variant: model selector + send button */
        <>
        {leftSlot && (
          <div className="mt-1 flex items-center">
            {leftSlot}
          </div>
        )}
        <button
          type="button"
          onClick={handleSendClick}
          disabled={!canSend}
          aria-label={t("aria.sendMessage")}
          className={cn(
            "absolute bottom-2 right-2.5 flex size-7 items-center justify-center rounded-full transition-all",
            canSend
              ? "bg-[var(--color-fg)] text-[var(--color-bg)] hover:opacity-90"
              : "bg-[var(--color-fg-muted)] text-[var(--color-bg)] opacity-30"
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
        </>
      )}
    </div>
  )
}
