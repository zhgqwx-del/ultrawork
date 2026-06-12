// Silent ensure of the orchestrator delegate MCP for opencode Leaders
// (017 拍板 #5: the former Settings「编排模式」toggle is gone — global MCP
// registration is now an internal detail of the Team page, same pattern as
// the knowledge-base MCP in use-knowledge-base.ts ensureMCPRegistered).
//
// Isolation note: registering globally is safe because every non-Leader
// opencode prompt carries tools:{"orchestrator_*":false} (connector default /
// gateway explicit) — only Team Leader turns ever see the delegate tools.

import { invoke } from "@tauri-apps/api/core"
import type { ApiClient } from "@agent/api-client"

const MCP_NAME = "orchestrator"
const ACP_PORT = "4099"
// Tool-call timeout for the delegate MCP entry. Doubles as the connect
// timeout in this vendor (mcp.timeout ?? CONNECT_TIMEOUT), so keep it
// moderate — the shim's progress notifications are the real long-task
// keepalive (resetTimeoutOnProgress).
const TOOL_TIMEOUT_MS = 600_000

/**
 * Idempotent: skips when the global config already has the entry (the running
 * server loaded it at boot). Runtime POST /mcp is per-directory-instance
 * (gotchas §3) — the desktop ApiClient carries the current workspace header,
 * which is exactly where the Leader session lives; other workspaces pick the
 * entry up from the global config on restart.
 */
export async function ensureOrchestratorMcp(api: ApiClient): Promise<void> {
  try {
    const configs = await invoke<Record<string, unknown>>("read_mcp_config")
    if (configs && configs[MCP_NAME]) return

    const sidecarPath = await invoke<string>("get_sidecar_path", { name: "acp-client" })
    const mcpConfig = {
      type: "local" as const,
      command: [sidecarPath, "delegate-mcp"],
      enabled: true,
      environment: { ACP_CLIENT_PORT: ACP_PORT },
      timeout: TOOL_TIMEOUT_MS,
    }
    await invoke("write_mcp_config", { name: MCP_NAME, config: mcpConfig })
    try {
      await api.createMCP(MCP_NAME, mcpConfig as never)
    } catch {
      // Will connect on next restart.
    }
  } catch (err) {
    console.error("Failed to ensure orchestrator MCP:", err)
  }
}
