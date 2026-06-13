import { Shield } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"
import type { PermissionRequest } from "@agent/api-client"

interface PermissionDockProps {
  request: PermissionRequest
  onReply: (reply: "once" | "always" | "reject") => void
}

const permissionLabels: Record<string, string> = {
  bash: "Bash Command",
  edit: "File Edit",
  write: "File Write",
  read: "File Read",
  external_directory: "External Directory",
  webfetch: "Web Fetch",
  tool: "Tool Action",
}

export function PermissionDock({ request, onReply }: PermissionDockProps) {
  const { t } = useI18n()

  const label = permissionLabels[request.permission] || request.permission

  return (
    <div className="mx-auto w-full max-w-[800px] px-4 py-3">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        {/* Header */}
        <div className="mb-3 flex items-center gap-2">
          <Shield className="size-5 text-amber-500" />
          <span className="text-sm font-medium text-[var(--color-fg)]">
            {t("permission.title")} — {label}
          </span>
        </div>

        {/* Description */}
        <p className="mb-3 text-sm text-[var(--color-fg-muted)]">
          {t("permission.description")}
        </p>

        {/* Patterns */}
        {request.patterns.length > 0 && (
          <div className="mb-4 space-y-1">
            {request.patterns.map((pattern, i) => (
              <code
                key={`${pattern}-${i}`}
                className="block rounded bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs text-[var(--color-fg)]"
              >
                {pattern}
              </code>
            ))}
          </div>
        )}

        {/* Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => onReply("reject")}
            className="rounded-lg border border-[var(--color-border)] px-4 py-1.5 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-secondary)]"
          >
            {t("permission.reject")}
          </button>
          <div className="flex-1" />
          <button
            onClick={() => onReply("always")}
            className="rounded-lg border border-[var(--color-border)] px-4 py-1.5 text-sm text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-secondary)]"
          >
            {t("permission.allowAlways")}
          </button>
          <button
            onClick={() => onReply("once")}
            className="rounded-lg bg-amber-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-amber-600"
          >
            {t("permission.allowOnce")}
          </button>
        </div>
      </div>
    </div>
  )
}
