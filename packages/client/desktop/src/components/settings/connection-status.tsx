import { useState, useEffect, useRef } from "react"
import { useSSE } from "@/lib/use-sse"
import { Wifi, WifiOff } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function ConnectionStatus() {
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<Date | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const statusText = isConnected
    ? `Connected${lastEvent ? ` • Last event: ${lastEvent.toLocaleTimeString()}` : ""}`
    : "Disconnected"

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
            {isConnected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p>{statusText}</p>
      </TooltipContent>
    </Tooltip>
  )
}
