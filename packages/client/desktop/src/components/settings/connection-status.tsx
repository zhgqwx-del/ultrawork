import { useState, useEffect, useRef } from "react"
import { useSSE } from "@/lib/use-sse"
import { Wifi, WifiOff } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n-context"

export function ConnectionStatus() {
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<Date | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { t } = useI18n()

  // Monitor SSE events to determine connection status
  useSSE(() => {
    setIsConnected(true)
    setLastEvent(new Date())

    // Clear any existing timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }

    // Reset connection status if no heartbeat for 30s
    timeoutRef.current = setTimeout(() => {
      setIsConnected(false)
    }, 30000)
  })

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
    }
  }, [])

  const connectedLabel = t("connectionStatus.connected")
  const disconnectedLabel = t("connectionStatus.disconnected")
  const statusText = isConnected
    ? `${connectedLabel}${lastEvent ? ` • ${lastEvent.toLocaleTimeString()}` : ""}`
    : disconnectedLabel

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs">
          {isConnected ? (
            <Wifi className="size-3.5 text-green-500" />
          ) : (
            <WifiOff className="size-3.5 text-[--color-fg-muted]" />
          )}
          <span className={isConnected ? "text-green-500" : "text-[--color-fg-muted]"}>
            {isConnected ? connectedLabel : disconnectedLabel}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{statusText}</p>
      </TooltipContent>
    </Tooltip>
  )
}
