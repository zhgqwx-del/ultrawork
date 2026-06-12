// Global "编排模式" toggle for opencode main chats (ADR-031 ②, D-3 opt-in).
//
// opencode MCP injection is config-file-level (no per-session control), so
// this registers the delegate shim in the GLOBAL config
// (~/.config/ultrawork/opencode.json) — the same mechanism as the
// knowledge-base MCP (use-knowledge-base.ts ensureMCPRegistered):
//   on  → write_mcp_config + runtime POST /mcp (effective immediately)
//   off → remove_mcp_config; the live server keeps the tools until restart
//         (the vendor has no DELETE /mcp), so the caller shows a restart note.
//
// Child-session recursion is guarded separately: the orchestrator denies
// "orchestrator_*" via the prompt `tools` map on every opencode child turn.

import { useCallback, useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useApi } from "@/lib/use-api"

const MCP_NAME = "orchestrator"
const ACP_PORT = "4099"
// Tool-call timeout for the delegate MCP entry. Doubles as the connect
// timeout in this vendor (mcp.timeout ?? CONNECT_TIMEOUT), so keep it
// moderate — the shim's progress notifications are the real long-task
// keepalive (resetTimeoutOnProgress).
const TOOL_TIMEOUT_MS = 600_000

export function useOrchestrateMode() {
  const api = useApi()
  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    invoke<Record<string, { enabled?: boolean } | undefined>>("read_mcp_config")
      .then((configs) => {
        if (cancelled) return
        const entry = configs?.[MCP_NAME]
        setEnabled(!!entry && entry.enabled !== false)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** Returns true when the change needs an app restart to fully apply. */
  const setOrchestrateMode = useCallback(
    async (next: boolean): Promise<boolean> => {
      if (next) {
        const sidecarPath = await invoke<string>("get_sidecar_path", { name: "acp-client" })
        const mcpConfig = {
          type: "local" as const,
          command: [sidecarPath, "delegate-mcp"],
          enabled: true,
          environment: { ACP_CLIENT_PORT: ACP_PORT },
          timeout: TOOL_TIMEOUT_MS,
        }
        await invoke("write_mcp_config", { name: MCP_NAME, config: mcpConfig })
        // Runtime registration so the running server picks it up now.
        let needsRestart = false
        try {
          await api.createMCP(MCP_NAME, mcpConfig as any)
        } catch {
          needsRestart = true // will connect on next restart
        }
        setEnabled(true)
        return needsRestart
      }
      await invoke("remove_mcp_config", { name: MCP_NAME })
      setEnabled(false)
      return true // no runtime de-registration in this vendor
    },
    [api],
  )

  return { enabled, loading, setOrchestrateMode }
}
