import { useMemo } from "react"
import { ApiClient } from "@agent/api-client"
import { useConfig } from "./config-context"

export function useApi() {
  const { config } = useConfig()

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: config.apiBaseUrl,
        username: config.apiUsername,
        password: config.apiPassword,
      }),
    [config.apiBaseUrl, config.apiUsername, config.apiPassword]
  )

  return client
}
