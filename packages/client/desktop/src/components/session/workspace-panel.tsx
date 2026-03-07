import { Folder } from "lucide-react"
import { useI18n } from "@/lib/i18n-context"

interface WorkspacePanelProps {
  directory?: string
}

export function WorkspacePanel({ directory }: WorkspacePanelProps) {
  const { t } = useI18n()

  if (!directory) {
    return <p className="py-2 text-xs text-[--color-fg-muted]">{t("placeholder.comingSoon")}</p>
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded bg-[--color-accent] px-2 py-1.5 text-xs">
        <Folder className="size-3.5 shrink-0 text-[--color-fg-muted]" />
        <div className="min-w-0 flex-1">
          <p className="text-[10px] text-[--color-fg-muted]">{t("message.workingDirectory")}</p>
          <p className="truncate text-[--color-fg]" title={directory}>{directory}</p>
        </div>
      </div>
    </div>
  )
}
