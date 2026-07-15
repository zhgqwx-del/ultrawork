import { cn } from "@/lib/utils"

// Controlled on/off switch for immediate-effect boolean settings (ADR-058 D1).
// Rendered as role="switch" — the correct semantics for "toggle, applies now",
// unlike a checkbox ("select from a set / stage for submit"). Keyboard-reachable
// (native <button>) and screen-reader-labelable via `id` + an external <label>.
interface ToggleProps {
  checked: boolean
  onChange: (value: boolean) => void
  id?: string
  disabled?: boolean
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
}

export function Toggle({
  checked,
  onChange,
  id,
  disabled,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
}: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]",
        checked ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]",
        disabled && "cursor-not-allowed opacity-50",
        className
      )}
    >
      <span
        className={cn(
          "inline-block size-4 rounded-full bg-white shadow-sm transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  )
}
