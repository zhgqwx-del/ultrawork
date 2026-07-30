import { useState, useRef, useEffect, type KeyboardEvent, type ChangeEvent, type ClipboardEvent } from "react"
import { getCurrentWebview } from "@tauri-apps/api/webview"
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n-context"
import { AlertTriangle, Check, ChevronDown, Loader2, Plus, Scissors, Square, X } from "lucide-react"
import { CommandSelector } from "./command-selector"
import { FileIcon } from "@/components/ui/file-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Attachment } from "@/lib/attachments"
import type { ScreenshotControl } from "@/lib/use-screenshot"
import type { CommandMenuEntry } from "@/lib/command-menu"

/** The composer's attachment surface. Absent ⇒ this composer takes no attachments. */
export interface AttachmentSlot {
  items: Attachment[]
  /** Files that carry their own bytes (paste). */
  add: (files: File[]) => void
  /** Absolute paths (native drag-drop, native file dialog). */
  addPaths: (paths: string[]) => void
  remove: (id: string) => void
  /** Non-null ⇒ the selected model can't accept these; send is blocked. */
  blocker: string | null
  /** The capability gate hasn't finished computing — send must wait, not race it. */
  checking?: boolean
  /** e.g. an ACP/Team session, whose backend is text-only. */
  disabled?: boolean
  /** In-app screenshot capture. Absent ⇒ no screenshot button (e.g. non-Tauri host). */
  screenshot?: ScreenshotControl
}

interface ChatInputProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  attachments?: AttachmentSlot
  /** Turns the send button into a stop button while loading. Lives here (and
   *  not only in ExecutionStatus) because the input never moves: the in-flow
   *  stop button shifts on every streaming reflow, so fast streams can swallow
   *  the click between pointerdown and pointerup. */
  onStop?: () => void
  /** Required on purpose: an optional default here can only be an untranslated
   *  literal, which is exactly the string that shows up in a Chinese UI the day
   *  someone adds a third composer and forgets to pass one. */
  placeholder: string
  disabled?: boolean
  loading?: boolean
  variant?: "home" | "reply"
  className?: string
  ctaLabel?: string
  leftSlot?: React.ReactNode
  /** Home variant: a control row rendered above the textarea (e.g. the mode
   *  switch) — keeps the bottom toolbar uncrowded and the card height stable
   *  across modes. */
  topSlot?: React.ReactNode
  /**
   * Whether `/` opens the command menu. The list comes from the OpenCode
   * backend unconditionally, so on an ACP-bound session it would advertise
   * commands that never reach the agent receiving the message. Default true.
   */
  commandsEnabled?: boolean
}

function AttachButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-7 shrink-0 items-center justify-center rounded-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:cursor-default disabled:opacity-30"
    >
      <Plus className="size-4" />
    </button>
  )
}

const HIDE_WINDOW_KEY = "uw.screenshot.hideWindow"

function readHideWindowPref(): boolean {
  // Default ON — 飞书/微信 both hide the composer during capture (discussions/039
  // §4 P1). A malformed/absent value falls back to that default, never to a throw.
  try {
    return localStorage.getItem(HIDE_WINDOW_KEY) !== "false"
  } catch {
    return true
  }
}

/**
 * Screenshot control: a scissors button (capture) split with a caret that opens the
 * "hide window while capturing" toggle — the toggle 飞书/微信 both expose, kept out
 * of the ➕ menu because a screenshot is a peer of "attach a file", not a sub-kind of
 * it (discussions/039 §4 P1). When no tool is available (Linux), the button is
 * disabled with a hint to use the system shortcut, and the caret is hidden.
 */
function ScreenshotButton({ control, disabled, label }: { control: ScreenshotControl; disabled: boolean; label: string }) {
  const { t } = useI18n()
  const [hideWindow, setHideWindow] = useState(readHideWindowPref)

  const toggleHideWindow = () => {
    setHideWindow((prev) => {
      const next = !prev
      try {
        localStorage.setItem(HIDE_WINDOW_KEY, String(next))
      } catch {
        /* private mode / disabled storage: the in-memory value still applies this session */
      }
      return next
    })
  }

  // No tool on this platform: a disabled button that says why beats a hidden one —
  // the user looked for it, and the paste path is right there.
  const unavailable = !control.available
  const mainDisabled = disabled || unavailable || control.busy
  const title = unavailable ? t("screenshot.unavailable") : label

  return (
    <div className="flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => control.capture(hideWindow)}
        disabled={mainDisabled}
        aria-label={label}
        title={title}
        className={cn(
          "flex size-7 items-center justify-center text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:cursor-default disabled:opacity-30",
          unavailable ? "rounded-lg" : "rounded-l-lg",
        )}
      >
        {control.busy ? <Loader2 className="size-4 animate-spin" /> : <Scissors className="size-4" />}
      </button>
      {!unavailable && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={disabled}
              aria-label={t("screenshot.options")}
              title={t("screenshot.options")}
              className="flex h-7 w-4 items-center justify-center rounded-r-lg text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-fg)] disabled:cursor-default disabled:opacity-30"
            >
              <ChevronDown className="size-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={(e) => {
                // Keep the menu open so the checkmark change is visible — a toggle
                // that closes on click reads as "did nothing".
                e.preventDefault()
                toggleHideWindow()
              }}
            >
              <Check className={cn("size-4", hideWindow ? "opacity-100" : "opacity-0")} />
              {t("screenshot.hideWindow")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}

export function ChatInput({
  value,
  onChange,
  onSend,
  attachments,
  onStop,
  placeholder,
  disabled = false,
  loading = false,
  variant = "reply",
  className,
  ctaLabel = "Start Now",
  leftSlot,
  topSlot,
  commandsEnabled = true,
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const compositionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [isComposing, setIsComposing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [commandDismissed, setCommandDismissed] = useState(false)

  useEffect(() => {
    return () => { clearTimeout(compositionTimerRef.current) }
  }, [])
  const { t } = useI18n()

  const canAttach = Boolean(attachments) && !attachments!.disabled && !disabled
  // Latest-callback ref: onDragDropEvent is registered once, but `attachments.addPaths`
  // is a new closure on every render — without this the listener would keep calling a
  // stale one (and re-registering per render races the async unlisten).
  const addPathsRef = useRef(attachments?.addPaths)
  addPathsRef.current = attachments?.addPaths
  const canAttachRef = useRef(canAttach)
  canAttachRef.current = canAttach

  // Native drag-drop. `dragDropEnabled` defaults to true in Tauri v2, which means the OS
  // handler swallows the event before the WebView sees it — an HTML5 `onDrop` here would
  // never fire. The native event is also the only one that carries real file PATHS.
  //
  // Registered ONCE. The dep is a boolean, not `attachments`: the slot object is rebuilt
  // whenever the attachment list changes, so depending on it would tear down and re-register
  // the native listener on every add/remove — and since re-registration is async, a drop
  // landing inside that window would be lost. The refs above are what keep the single
  // long-lived listener pointed at the current callbacks.
  const attachable = Boolean(attachments)
  useEffect(() => {
    if (!attachable) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setDragOver(canAttachRef.current)
        } else if (event.payload.type === "drop") {
          setDragOver(false)
          if (canAttachRef.current) addPathsRef.current?.(event.payload.paths)
        } else {
          setDragOver(false)
        }
      })
      .then((fn) => {
        // The component may have unmounted while the listener was still being registered.
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      // An exception thrown from a cleanup function aborts React's unmount pass, so never
      // let a failing unlisten (a non-Tauri host, a torn-down webview) take the tree with it.
      try {
        unlisten?.()
      } catch {
        /* the webview is going away anyway */
      }
    }
  }, [attachable])

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return
    // Verified against WKWebView: a screenshot on the clipboard arrives here as a real
    // image/png File (discussions/039 §5). Text pastes carry no files — leave them alone so
    // normal copy-paste of text still lands in the textarea.
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length === 0) {
      // The clipboard says it holds an image, but the webview gave us no File for it —
      // WebKitGTK historically does this. Doing nothing here is the worst possible answer:
      // the user hits Ctrl+V on a screenshot and NOTHING happens, with no way to tell whether
      // the app is broken or they mis-copied. Say so.
      const types = Array.from(e.clipboardData?.types ?? [])
      if (types.some((ty) => ty.startsWith("image/"))) {
        e.preventDefault()
        toast.error(t("attachment.pasteUnsupported"))
      }
      return
    }
    e.preventDefault()
    attachments?.add(files)
  }

  const handlePickFiles = async () => {
    if (!canAttach) return
    // Native dialog (dialog:allow-open is already granted). One entry point, no submenu:
    // unlike Feishu we have exactly one source — the local disk.
    const picked = await openDialog({ multiple: true }).catch(() => null)
    if (!picked) return
    const paths = Array.isArray(picked) ? picked : [picked]
    attachments?.addPaths(paths)
  }
  // Only show command selector while typing the command name (no space yet)
  const showCommandSelector =
    commandsEnabled && value.startsWith("/") && !value.includes(" ") && !disabled && !loading && !commandDismissed

  // Esc dismisses for this token only; once the slash is gone the menu is armed
  // again. Previously "closing" meant deleting the user's "/" (`/deck` → `deck`).
  useEffect(() => {
    if (!value.startsWith("/")) setCommandDismissed(false)
  }, [value])

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = "auto"
    const newHeight = Math.min(textarea.scrollHeight, variant === "home" ? 200 : 120)
    textarea.style.height = `${newHeight}px`
  }, [value, variant])

  const handleSelectCommand = (cmd: CommandMenuEntry) => {
    // Replace input with /<command> and let user add arguments
    onChange(`/${cmd.name} `)
    textareaRef.current?.focus()
  }

  const handleCloseCommandSelector = () => {
    // Close the menu, never touch the text the user typed.
    setCommandDismissed(true)
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // No command-menu branches here on purpose: when the menu takes a key it
    // stops the event in the capture phase, so this handler never sees it.
    // Anything that reaches here is the composer's to act on — which is how a
    // `/word` that matches nothing still sends instead of dead-ending.
    // Enter without Shift and not composing → send.
    // Check both React state AND native isComposing — some browsers fire compositionEnd before keyDown
    if (e.key === "Enter" && !e.shiftKey && !isComposing && !e.nativeEvent.isComposing) {
      // preventDefault is UNCONDITIONAL, and must stay that way: the reply composer's
      // placeholder tells the user Shift+Enter is how you get a newline, so a bare Enter
      // that inserts one in the states where it can't send (an attachment `blocker`, the
      // async capability gate, whitespace-only text) would contradict what the UI just
      // promised. Those states aren't silent — `blocker` renders its own banner above and
      // the send button is visibly disabled. Guarded by the "bare Enter never inserts a
      // newline" test, which needs userEvent: fireEvent.keyDown performs no default
      // editing in jsdom, so the same assertion written with it passes even if this line
      // is deleted.
      e.preventDefault()
      if (canSend) {
        onSend()
      }
    }
  }

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    onChange(e.target.value)
  }

  const handleSendClick = () => {
    if (canSend) {
      onSend()
    }
  }

  const items = attachments?.items ?? []
  const blocker = attachments?.blocker ?? null
  // A composer whose slot is disabled (ACP/Team — a text-only backend) must never send while
  // attachments are still staged. Greying out the ➕ button is not enough: files attached
  // BEFORE the switch stay in the list, and the send path would drop them without a word —
  // the exact silent-drop failure this feature exists to stop. Pages also clear the list on
  // switch (that is the UX); this is the invariant that makes a missed clear un-shippable.
  const staleAttachments = Boolean(attachments?.disabled) && items.length > 0
  // The gate is async (it awaits a 4 MB GET /provider). Paste-then-Enter must not outrun it,
  // or the check exists and never runs for exactly the fastest users.
  const gatePending = Boolean(attachments?.checking)
  // An attachment with no text is a complete turn ("look at this"), so emptiness is judged
  // on text AND attachments. `blocker` (model can't see images) hard-blocks send: letting it
  // through would just make the model apologise for a file it was never shown.
  const canSend =
    Boolean(value.trim() || items.length > 0) &&
    !disabled &&
    !loading &&
    !blocker &&
    !staleAttachments &&
    !gatePending

  // The in-conversation composer advertises the newline shortcut; Home's does not —
  // its empty state is the app's front door and stays uncluttered. Keyed off `variant`
  // rather than a per-page prop for two reasons: `variant` already IS the
  // "front door vs in-conversation" split, and the Enter/Shift+Enter semantics this
  // sentence describes live in this component (handleKeyDown), so the promise and the
  // behaviour it promises can't drift apart. A future reply-style composer inherits it.
  const resolvedPlaceholder =
    variant === "reply" ? t("placeholder.withKeyHint", { base: placeholder }) : placeholder

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
        composing={isComposing}
      />

      {variant === "home" && topSlot && (
        <div className="mb-2.5 flex items-center">{topSlot}</div>
      )}

      {items.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {items.map((a) => (
            <div
              key={a.id}
              className="group/att relative flex items-center gap-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-accent)] py-1 pl-1.5 pr-6"
            >
              {a.previewUrl ? (
                <img src={a.previewUrl} alt={a.filename} className="size-8 rounded object-cover" />
              ) : (
                <FileIcon filename={a.filename} className="size-4" />
              )}
              <span className="max-w-[10rem] truncate text-xs text-[var(--color-fg)]">{a.filename}</span>
              <button
                type="button"
                onClick={() => attachments?.remove(a.id)}
                aria-label={t("attachment.remove")}
                className="absolute right-1 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full bg-[var(--color-fg-muted)] text-[var(--color-bg)] opacity-0 transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {blocker && (
        <div className="mb-2 flex items-start gap-1.5 rounded-lg bg-[var(--color-warning-bg,var(--color-accent))] px-2.5 py-1.5 text-xs text-[var(--color-fg-muted)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{blocker}</span>
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-[var(--color-brand)] bg-[var(--color-bg)]/80 text-sm text-[var(--color-fg)]">
          {t("attachment.dropHere")}
        </div>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => {
          // Delay clearing composing state — some browsers fire compositionEnd before the
          // final keyDown (Enter), so we need isComposing to still be true during that keyDown
          clearTimeout(compositionTimerRef.current)
          compositionTimerRef.current = setTimeout(() => setIsComposing(false), 0)
        }}
        placeholder={resolvedPlaceholder}
        disabled={disabled}
        className={cn(
          "w-full resize-none border-0 bg-transparent text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none disabled:opacity-50",
          variant === "home" ? "text-base" : "text-sm pr-10"
        )}
        rows={variant === "home" ? 2 : 1}
        style={{
          minHeight: variant === "home" ? "48px" : "44px",
          maxHeight: variant === "home" ? "200px" : "120px",
          overflow: "auto",
        }}
      />

      {variant === "home" ? (
        /* Home variant: toolbar below with send button flush bottom-right */
        <div className="mt-3 flex items-center gap-2">
          {attachments && <AttachButton onClick={handlePickFiles} disabled={!canAttach} label={t("aria.attachment")} />}
          {attachments?.screenshot && (
            <ScreenshotButton control={attachments.screenshot} disabled={!canAttach} label={t("screenshot.button")} />
          )}
          {/* Toolbar chips (leftSlot owns flex-1 + flex-wrap): they wrap to a
              second line on very narrow windows instead of clipping or
              scrolling — the CTA stays a fixed, single-line button. */}
          {leftSlot}
          <button
            type="button"
            onClick={handleSendClick}
            disabled={!canSend}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-lg px-5 py-2 text-sm font-medium transition-all",
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
        {(leftSlot || attachments) && (
          <div className="mt-1 flex items-center gap-1">
            {attachments && <AttachButton onClick={handlePickFiles} disabled={!canAttach} label={t("aria.attachment")} />}
            {attachments?.screenshot && (
              <ScreenshotButton control={attachments.screenshot} disabled={!canAttach} label={t("screenshot.button")} />
            )}
            {leftSlot}
          </div>
        )}
        {loading && onStop ? (
          <button
            type="button"
            onPointerDown={onStop}
            aria-label={t("message.stopExecution")}
            className="absolute bottom-2 right-2.5 flex size-7 items-center justify-center rounded-full bg-[var(--color-fg)] text-[var(--color-bg)] transition-all hover:opacity-90"
          >
            <Square className="size-3" fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSendClick}
            disabled={!canSend}
            aria-label={t("aria.sendMessage")}
            title={t("aria.sendMessageHint")}
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
        )}
        </>
      )}
    </div>
  )
}
