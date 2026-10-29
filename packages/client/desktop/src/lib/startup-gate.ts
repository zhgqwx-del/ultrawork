import { invoke } from "@tauri-apps/api/core"
import type { BrandIdentity } from "@agent/brand"
import { APP_BRAND } from "./brand"
import { loadSidecarPorts } from "./sidecar-ports"
import { loadSidecarCredentials } from "./sidecar-auth"

export interface StartupStatus {
  state: "ready" | "blocked"
  brand: BrandIdentity
  reason?: string
  paths?: Record<string, string>
}

/** Browser fixtures opt in explicitly; a broken native IPC is never a fallback. */
export function isNativeDesktop(): boolean {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return false
  const fixture = (window as Window & { __ULTRAWORK_BROWSER_TEST__?: boolean }).__ULTRAWORK_BROWSER_TEST__
  return !(import.meta.env.DEV && fixture === true)
}

function statusFrom(value: unknown): StartupStatus {
  if (!value || typeof value !== "object") throw new Error("Invalid startup status from the desktop host")
  const status = value as StartupStatus
  if (status.state !== "ready" && status.state !== "blocked") throw new Error("Invalid desktop startup state")
  if (status.brand?.brandId !== APP_BRAND.brandId || status.brand?.identifier !== APP_BRAND.identifier) {
    throw new Error("The desktop host and interface have different brand identities")
  }
  return status
}

export interface StartupGateDependencies {
  native: boolean
  status: () => Promise<unknown>
  ports: (strict?: boolean) => Promise<unknown>
  credentials: (strict?: boolean) => Promise<unknown>
}

/** No credentials, ports, workspace or business providers are touched on Blocked. */
export async function openStartupGate(deps: StartupGateDependencies = {
  native: isNativeDesktop(),
  status: () => invoke("get_startup_status"),
  ports: loadSidecarPorts,
  credentials: loadSidecarCredentials,
}): Promise<StartupStatus> {
  try {
    if (deps.native) {
      const status = statusFrom(await deps.status())
      if (status.state === "blocked") return status
      await Promise.all([deps.ports(true), deps.credentials(true)])
      return status
    }
    await Promise.all([deps.ports(false), deps.credentials(false)])
    return { state: "ready", brand: APP_BRAND }
  } catch (error) {
    return {
      state: "blocked", brand: APP_BRAND,
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
