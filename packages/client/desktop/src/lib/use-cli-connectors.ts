import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"
import { toast } from "sonner"
import { useI18n } from "@/lib/i18n-context"

/**
 * Office CLI connectors (discussions/027, Phase 1: Feishu/Lark).
 *
 * A CLI connector wraps an official vendor CLI (lark-cli) that the agent
 * drives via bash — NOT an MCP server; nothing here touches OpenCode `mcp`
 * config. This hook fronts four Tauri commands:
 *   check_cli_connectors      — probe install/config/auth state
 *   install_office_cli        — pinned-version download + sha256 verify
 *   start_office_cli_config   — `config init --new`, returns hosted setup URL
 *   start_office_cli_auth /   — OAuth device flow (`--no-wait --json`), then
 *   complete_office_cli_auth    blocking token-exchange poll
 */

export type CliConnectorState =
  | "not_installed"
  | "not_configured"
  | "not_authorized"
  | "connected"
  | "error"

export interface CliConnectorStatus {
  id: string
  state: CliConnectorState
  path?: string | null
  version?: string | null
  /** Identity name when connected; error hint otherwise. */
  detail?: string | null
}

interface CliDeviceLogin {
  device_code: string
  user_code?: string | null
  verification_uri?: string | null
  verification_uri_complete?: string | null
  expires_in?: number | null
  interval?: number | null
}

/** Transient UI phase layered over the probed state. */
export type CliConnectorPhase = "idle" | "installing" | "configuring" | "authorizing"

export interface CliConnectorsApi {
  statuses: Record<string, CliConnectorStatus>
  checking: boolean
  phases: Record<string, CliConnectorPhase>
  errors: Record<string, string | null>
  /** Last verification/setup URL per connector (surfaced for manual copy). */
  pendingUrls: Record<string, string | null>
  refresh: () => Promise<void>
  install: (id: string) => Promise<void>
  configure: (id: string) => Promise<void>
  authorize: (id: string) => Promise<void>
}

/** How long we keep polling for the hosted config flow before giving up. */
const CONFIG_POLL_TIMEOUT_MS = 10 * 60 * 1000
const CONFIG_POLL_INTERVAL_MS = 3000

export function useCliConnectors(): CliConnectorsApi {
  const { language, t } = useI18n()
  const [statuses, setStatuses] = useState<Record<string, CliConnectorStatus>>({})
  const [checking, setChecking] = useState(true)
  const [phases, setPhases] = useState<Record<string, CliConnectorPhase>>({})
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [pendingUrls, setPendingUrls] = useState<Record<string, string | null>>({})
  // Bumped on unmount and whenever a new flow starts, so a stale config poll
  // loop from a previous flow stops touching state.
  const generation = useRef(0)

  const setPhase = useCallback((id: string, phase: CliConnectorPhase) => {
    setPhases((p) => ({ ...p, [id]: phase }))
  }, [])
  const setError = useCallback((id: string, err: string | null) => {
    setErrors((e) => ({ ...e, [id]: err }))
  }, [])

  const fetchStatuses = useCallback(async (): Promise<Record<string, CliConnectorStatus>> => {
    const arr = await invoke<CliConnectorStatus[]>("check_cli_connectors")
    const map = Object.fromEntries(arr.map((s) => [s.id, s]))
    setStatuses(map)
    return map
  }, [])

  const refresh = useCallback(async () => {
    try {
      await fetchStatuses()
    } catch (err) {
      console.warn("check_cli_connectors unavailable:", err)
    }
  }, [fetchStatuses])

  useEffect(() => {
    let alive = true
    invoke<CliConnectorStatus[]>("check_cli_connectors")
      .then((arr) => {
        if (alive) setStatuses(Object.fromEntries(arr.map((s) => [s.id, s])))
      })
      .catch((err) => console.warn("check_cli_connectors unavailable:", err))
      .finally(() => {
        if (alive) setChecking(false)
      })
    return () => {
      alive = false
      generation.current++
    }
  }, [])

  const install = useCallback(
    async (id: string) => {
      setError(id, null)
      setPhase(id, "installing")
      try {
        const status = await invoke<CliConnectorStatus>("install_office_cli", { id })
        setStatuses((m) => ({ ...m, [id]: status }))
        toast.success(t("cliConnector.toastInstalled"))
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(id, msg)
        toast.error(t("cliConnector.toastFailed", { error: msg }))
      } finally {
        setPhase(id, "idle")
      }
    },
    [setError, setPhase, t],
  )

  const configure = useCallback(
    async (id: string) => {
      setError(id, null)
      setPhase(id, "configuring")
      const gen = ++generation.current
      try {
        const url = await invoke<string>("start_office_cli_config", { id, lang: language })
        setPendingUrls((m) => ({ ...m, [id]: url }))
        await openUrl(url)
        // The `config init` child completes only when the user finishes the
        // hosted flow in the browser — poll the probe until the state moves.
        const deadline = Date.now() + CONFIG_POLL_TIMEOUT_MS
        while (Date.now() < deadline && generation.current === gen) {
          await new Promise((r) => setTimeout(r, CONFIG_POLL_INTERVAL_MS))
          if (generation.current !== gen) return
          const map = await fetchStatuses()
          if (map[id] && map[id].state !== "not_configured") {
            setPendingUrls((m) => ({ ...m, [id]: null }))
            return
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        setError(id, msg)
        toast.error(t("cliConnector.toastFailed", { error: msg }))
      } finally {
        if (generation.current === gen) setPhase(id, "idle")
      }
    },
    [fetchStatuses, language, setError, setPhase, t],
  )

  const authorize = useCallback(
    async (id: string) => {
      setError(id, null)
      setPhase(id, "authorizing")
      const gen = ++generation.current
      try {
        const login = await invoke<CliDeviceLogin>("start_office_cli_auth", { id })
        const url = login.verification_uri_complete || login.verification_uri
        if (url) {
          setPendingUrls((m) => ({ ...m, [id]: url }))
          await openUrl(url)
        }
        // Blocks while the CLI polls the token endpoint (bounded by the device
        // code's expiry on the Rust side).
        const status = await invoke<CliConnectorStatus>("complete_office_cli_auth", {
          id,
          deviceCode: login.device_code,
          expiresIn: login.expires_in ?? null,
        })
        if (generation.current !== gen) return
        setStatuses((m) => ({ ...m, [id]: status }))
        setPendingUrls((m) => ({ ...m, [id]: null }))
        if (status.state === "connected") {
          toast.success(t("cliConnector.toastConnected"))
        } else if (status.detail) {
          setError(id, status.detail)
        }
      } catch (err) {
        if (generation.current !== gen) return
        const msg = err instanceof Error ? err.message : String(err)
        setError(id, msg)
        toast.error(t("cliConnector.toastFailed", { error: msg }))
      } finally {
        if (generation.current === gen) setPhase(id, "idle")
      }
    },
    [setError, setPhase, t],
  )

  return { statuses, checking, phases, errors, pendingUrls, refresh, install, configure, authorize }
}
