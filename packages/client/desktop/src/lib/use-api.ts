import { useMemo } from "react"
import { ApiClient } from "@agent/api-client"

// MVP: hardcoded config, will be replaced by settings in 2.6
const API_BASE = "http://localhost:4096"
const PASSWORD = "test123"

export function useApi() {
  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl: API_BASE,
        username: "opencode",
        password: PASSWORD,
      }),
    []
  )

  return client
}
