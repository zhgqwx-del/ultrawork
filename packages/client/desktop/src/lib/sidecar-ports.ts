// Runtime sidecar port resolution (discussions/029).
//
// Ports are chosen by the Tauri host at startup, not at compile time, so the
// renderer must ask for them rather than hardcode them. `loadSidecarPorts()` is
// awaited once before the app renders (see main.tsx); every base-URL helper here
// is therefore a plain synchronous read, and callers stay non-async.
//
// Outside Tauri (vitest, e2e in a plain browser) `invoke` rejects and we keep
// the preferred ports — which is exactly what a hand-started sidecar binds.

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export interface SidecarPorts {
  opencode: number
  gateway: number
  knowledge: number
  acp: number
}

/** Mirrors the Rust `SidecarPorts::PREFERRED`. */
export const PREFERRED_PORTS: SidecarPorts = {
  opencode: 4096,
  gateway: 4097,
  knowledge: 4098,
  acp: 4099,
}

let ports: SidecarPorts = PREFERRED_PORTS

const PORT_KEYS = ["opencode", "gateway", "knowledge", "acp"] as const

/**
 * A rejected `invoke` is not the only way this can go wrong: a stub host (the
 * e2e Tauri shim, an older build without the command) resolves *null* instead of
 * throwing. Trusting that would put `undefined` into every base URL, so validate
 * the shape rather than the absence of an exception.
 */
function isSidecarPorts(value: unknown): value is SidecarPorts {
  if (typeof value !== "object" || value === null) return false
  return PORT_KEYS.every((k) => {
    const port = (value as Record<string, unknown>)[k]
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
  })
}

/**
 * Resolve the ports the sidecars actually bound. Idempotent and safe to call
 * outside Tauri — on any failure the preferred ports stay in effect, so the
 * startup gate in main.tsx can await this without ever wedging the boot.
 */
export async function loadSidecarPorts(): Promise<SidecarPorts> {
  try {
    const resolved = await invoke<unknown>("get_sidecar_ports")
    if (!isSidecarPorts(resolved)) {
      throw new Error(`malformed get_sidecar_ports response: ${JSON.stringify(resolved)}`)
    }
    ports = resolved
  } catch (err) {
    console.warn("Falling back to preferred sidecar ports:", err)
    ports = PREFERRED_PORTS
  }
  await watchSidecarPorts()
  return ports
}

/** Current ports. Meaningful only after `loadSidecarPorts()` has resolved. */
export function sidecarPorts(): SidecarPorts {
  return ports
}

// The three background sidecars normally settle before the window exists, but a
// lost bind race can move one afterwards. The host then emits the new set; without
// this the renderer would keep calling a port nobody is listening on.

const PORTS_CHANGED_EVENT = "sidecar-ports-changed"

const subscribers = new Set<() => void>()
let version = 0

/**
 * Subscribe to port changes. Returns an unsubscribe fn.
 *
 * Shaped for `useSyncExternalStore`: `sidecarPortsVersion()` is the snapshot, so a
 * consumer holding a long-lived client (an SSE connection built from a base URL)
 * can rebuild it when the port underneath moves.
 */
export function subscribeSidecarPorts(onChange: () => void): () => void {
  subscribers.add(onChange)
  return () => subscribers.delete(onChange)
}

export function sidecarPortsVersion(): number {
  return version
}

/** Wire the host event to the local store. Called once, from `loadSidecarPorts`. */
async function watchSidecarPorts(): Promise<void> {
  try {
    await listen<unknown>(PORTS_CHANGED_EVENT, (event) => {
      if (!isSidecarPorts(event.payload)) {
        console.warn("Ignoring malformed sidecar-ports-changed payload:", event.payload)
        return
      }
      if (PORT_KEYS.every((k) => ports[k] === (event.payload as SidecarPorts)[k])) return
      ports = event.payload
      version += 1
      subscribers.forEach((fn) => fn())
    })
  } catch (err) {
    // Not running under Tauri — ports can never change, so there is nothing to watch.
    console.warn("Not watching sidecar port changes:", err)
  }
}

// Base URLs. In dev the Vite proxy fronts opencode/gateway/knowledge, so those
// are relative and the port is irrelevant; :4099 has no proxy entry and is
// absolute in both modes (the ACP sidecar allows the dev origin via CORS).

export function opencodeBaseUrl(): string {
  return import.meta.env.DEV ? "" : `http://localhost:${ports.opencode}`
}

export function gatewayBaseUrl(): string {
  return import.meta.env.DEV ? "/channel" : `http://localhost:${ports.gateway}/channel`
}

export function knowledgeBaseUrl(): string {
  return import.meta.env.DEV ? "/kb" : `http://localhost:${ports.knowledge}/kb`
}

export function acpBaseUrl(): string {
  return `http://localhost:${ports.acp}`
}

/** Test seam: restore the module to its pre-`loadSidecarPorts` state. */
export function __resetSidecarPortsForTest(next: SidecarPorts = PREFERRED_PORTS): void {
  ports = next
  version = 0
  subscribers.clear()
}
