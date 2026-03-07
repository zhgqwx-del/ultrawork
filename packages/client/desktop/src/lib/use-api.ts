import { useMemo } from "react"
import { ApiClient } from "@agent/api-client"
import { useConfig } from "./config-context"
import { useWorkspace } from "./workspace-context"

export function useApi() {
  const { config } = useConfig()
  const { workspacePath } = useWorkspace()

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: import.meta.env.DEV ? "" : config.apiBaseUrl,
        username: config.apiUsername,
        password: config.apiPassword,
        workingDirectory: workspacePath || undefined,
      }),
    [config.apiBaseUrl, config.apiUsername, config.apiPassword, workspacePath]
  )

  return client
}
