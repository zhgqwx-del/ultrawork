// OpenCode REST credentials for the in-sidecar orchestrator Connector.
// Resolution order mirrors the Tauri host (lib.rs load_or_create_sidecar_credentials):
//   1. OPENCODE_SERVER_PASSWORD  — injected by the Tauri host (same as gateway)
//   2. ULTRAWORK_SIDECAR_PASSWORD — CI / scripted-test escape hatch
//   3. ~/.config/ultrawork/sidecar-auth.json — covers dev mode where the
//      sidecar runs via `bun run dev` outside the Tauri host.

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export function getOpencodePassword(): string | undefined {
  if (process.env.OPENCODE_SERVER_PASSWORD) return process.env.OPENCODE_SERVER_PASSWORD
  if (process.env.ULTRAWORK_SIDECAR_PASSWORD) return process.env.ULTRAWORK_SIDECAR_PASSWORD
  try {
    const configDir = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
    const raw = readFileSync(join(configDir, "ultrawork", "sidecar-auth.json"), "utf-8")
    const parsed = JSON.parse(raw) as { password?: string }
    return parsed.password || undefined
  } catch {
    return undefined
  }
}
