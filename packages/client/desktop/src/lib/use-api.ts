import { OPENCODE_BACKEND_KIND, type OpenCodeBackend } from "@agent/connector"
import { useConnector } from "./sse-context"

/**
 * The opencode backend-specific REST surface (providers/mcp/skills/file/
 * config...). Same ApiClient as ever — now owned by the Connector, so the
 * reference changes exactly when config/workspace change (legacy useMemo
 * semantics preserved for effect dependencies).
 *
 * Session-flow calls (prompt/cancel/history/permission reply) should go
 * through useConnector() instead, which dispatches by session binding.
 */
export function useApi() {
  const connector = useConnector()
  const opencode = connector.getBackend<OpenCodeBackend>(OPENCODE_BACKEND_KIND)
  if (!opencode) throw new Error("OpenCode backend is not registered")
  return opencode.api
}
