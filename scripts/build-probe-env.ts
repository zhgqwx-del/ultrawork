/** Isolate application data touched by vendor build/version probes from a running app. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

export function createBuildProbeEnvironment(parent: NodeJS.ProcessEnv = process.env): {
  root: string
  env: NodeJS.ProcessEnv
  dispose(): void
} {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "ultrawork-build-probe-")))
  const home = path.join(root, "app-home")
  mkdirSync(home)
  let disposed = false
  return {
    root,
    // Keep HOME/USERPROFILE unchanged for Bun/toolchain caches. OpenCode's own
    // home and every XDG root are explicitly disposable, even for --version.
    env: {
      ...parent,
      OPENCODE_TEST_HOME: home,
      OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, "managed-config"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
    dispose() {
      if (disposed) return
      rmSync(root, { recursive: true, force: true })
      disposed = true
    },
  }
}
