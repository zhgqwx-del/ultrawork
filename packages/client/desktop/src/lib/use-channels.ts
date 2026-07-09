import { useState, useEffect, useCallback } from "react"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n-context"
import { gatewayBaseUrl } from "@/lib/sidecar-ports"
import { sidecarAuthHeaders } from "@/lib/sidecar-auth"
import type {
  ChannelStatus,
  ChannelConfig,
  ChannelListResponse,
  ChannelQRStartResponse,
  ChannelQRStatusResponse,
} from "@agent/api-client"

async function gatewayFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${gatewayBaseUrl()}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...sidecarAuthHeaders(), ...options?.headers },
  })
  if (!resp.ok) {
    const body = await resp.text().catch(() => "")
    throw new Error(`Gateway ${resp.status}: ${body}`)
  }
  // Handle 204 No Content or empty body (same pattern as api-client request<T>)
  if (resp.status === 204) return undefined as T
  const text = await resp.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

export function useChannels() {
  const { t } = useI18n()
  const [channels, setChannels] = useState<ChannelStatus[]>([])
  const [configs, setConfigs] = useState<ChannelConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  const fetchChannels = useCallback(async () => {
    try {
      const data = await gatewayFetch<ChannelListResponse>("")
      setChannels(data.channels)
      setConfigs(data.configs)
      setError(false)
    } catch (err) {
      console.error("Failed to fetch channels:", err)
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchChannels()
  }, [fetchChannels])

  const handleAdd = useCallback(
    async (config: Omit<ChannelConfig, "id">) => {
      setActionLoading("__add__")
      try {
        await gatewayFetch<ChannelConfig>("", {
          method: "POST",
          body: JSON.stringify(config),
        })
        await fetchChannels()
      } catch (err) {
        console.error("Failed to add channel:", err)
        toast.error(t("channel.error.add"))
        throw err
      } finally {
        setActionLoading(null)
      }
    },
    [fetchChannels, t],
  )

  const handleRemove = useCallback(
    async (id: string) => {
      setActionLoading(id)
      try {
        await gatewayFetch<void>(`/${id}`, { method: "DELETE" })
        setChannels((prev) => prev.filter((c) => c.id !== id))
        setConfigs((prev) => prev.filter((c) => c.id !== id))
      } catch (err) {
        console.error("Failed to remove channel:", err)
        toast.error(t("channel.error.remove"))
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const handleConnect = useCallback(
    async (id: string) => {
      setActionLoading(id)
      try {
        const status = await gatewayFetch<ChannelStatus>(`/${id}/connect`, {
          method: "POST",
        })
        setChannels((prev) =>
          prev.map((c) => (c.id === id ? status : c)),
        )
        // WeChat connect is async (returns "connecting" immediately).
        // Poll for actual connected state after a short delay.
        if (status.state === "connecting") {
          const poll = async () => {
            for (let i = 0; i < 10; i++) {
              await new Promise((r) => setTimeout(r, 3000))
              try {
                const data = await gatewayFetch<ChannelListResponse>("")
                const updated = data.channels.find((c) => c.id === id)
                if (updated && updated.state !== "connecting") {
                  setChannels(data.channels)
                  setConfigs(data.configs)
                  break
                }
              } catch { break }
            }
          }
          poll()
        }
      } catch (err) {
        console.error("Failed to connect channel:", err)
        toast.error(t("channel.error.connect"))
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  const handleDisconnect = useCallback(
    async (id: string) => {
      setActionLoading(id)
      try {
        const status = await gatewayFetch<ChannelStatus>(`/${id}/disconnect`, {
          method: "POST",
        })
        setChannels((prev) =>
          prev.map((c) => (c.id === id ? status : c)),
        )
      } catch (err) {
        console.error("Failed to disconnect channel:", err)
        toast.error(t("channel.error.disconnect"))
      } finally {
        setActionLoading(null)
      }
    },
    [t],
  )

  // ---- QR Code Login (any provider type; gateway polls upstream and
  // caches state — these calls only start sessions / read the cache) ----

  const requestChannelQR = useCallback(
    async (type: string, name: string, workspaceDir: string, autoConnect = true) => {
      const data = await gatewayFetch<ChannelQRStartResponse>(`/${type}/qrcode`, {
        method: "POST",
        body: JSON.stringify({ name, workspaceDir, autoConnect }),
      })
      return data
    },
    [],
  )

  const pollChannelQRStatus = useCallback(
    async (type: string, token: string) => {
      const data = await gatewayFetch<ChannelQRStatusResponse>(
        `/${type}/qrcode-status?token=${encodeURIComponent(token)}`,
      )
      return data
    },
    [],
  )

  const cancelChannelQR = useCallback(
    async (type: string, token: string) => {
      // best-effort — the gateway session TTL cleans up regardless
      await gatewayFetch<{ ok: boolean }>(`/${type}/qrcode/${encodeURIComponent(token)}`, {
        method: "DELETE",
      }).catch(() => {})
    },
    [],
  )

  return {
    channels,
    configs,
    loading,
    error,
    actionLoading,
    handleAdd,
    handleRemove,
    handleConnect,
    handleDisconnect,
    refresh: fetchChannels,
    requestChannelQR,
    pollChannelQRStatus,
    cancelChannelQR,
  }
}
