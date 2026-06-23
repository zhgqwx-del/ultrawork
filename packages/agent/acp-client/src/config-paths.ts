// SSOT for the Ultrawork global config dir inside the acp-client sidecar.
//
// Mirrors the desktop's Rust `global_config_dir()` (lib.rs): honor a non-empty
// XDG_CONFIG_HOME, else ~/.config, then the fixed "ultrawork" app-name segment.
// Empty-string XDG_CONFIG_HOME is treated as unset (matches the Rust
// `Ok(val) if !val.is_empty()` guard and the XDG base-dir spec).
//
// Routing every config-file path (agents.json, gemini-acp-settings.json,
// sidecar-auth.json) through this one resolver keeps them in a single isolation
// namespace — under an XDG-isolated sidecar they all move together instead of
// some leaking back to the real ~/.config/ultrawork (gotchas §8/§11).

import { homedir } from "node:os"
import { join } from "node:path"

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, "ultrawork")
}

export function configFile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveConfigDir(env), name)
}
