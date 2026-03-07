import { useSSEConnected } from "@/lib/sse-context"
import { Wifi, WifiOff } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n-context"

export function ConnectionStatus() {
  const isConnected = useSSEConnected()
  const { t } = useI18n()

  const connectedLabel = t("connectionStatus.connected")
  const disconnectedLabel = t("connectionStatus.disconnected")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs">
          {isConnected ? (
            <Wifi className="size-3.5 text-green-500" />
          ) : (
            <WifiOff className="size-3.5 text-[var(--color-fg-muted)]" />
          )}
          <span className={isConnected ? "text-green-500" : "text-[var(--color-fg-muted)]"}>
            {isConnected ? connectedLabel : disconnectedLabel}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{isConnected ? connectedLabel : disconnectedLabel}</p>
      </TooltipContent>
    </Tooltip>
  )
}
