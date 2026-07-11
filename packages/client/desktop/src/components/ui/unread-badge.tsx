import { cn } from "@/lib/utils"

/**
 * Passive "there's something new here" count (ADR-048 D1). Deliberately a badge
 * and not an auto-opening panel: new artifacts don't require the user to act, so
 * they get an indicator, not an interruption.
 *
 * Renders nothing at zero, so callers can pass the raw count.
 */
export function UnreadBadge({
  count,
  className,
  ...rest
}: { count: number; className?: string } & React.HTMLAttributes<HTMLSpanElement>) {
  if (count <= 0) return null
  return (
    <span
      {...rest}
      className={cn(
        "flex min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-medium leading-4 text-white",
        className,
      )}
    >
      {count > 9 ? "9+" : count}
    </span>
  )
}
