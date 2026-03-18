import { useState, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { toast } from "sonner"
import { useApi } from "@/lib/use-api"
import { useI18n } from "@/lib/i18n-context"
import { useWorkspace } from "@/lib/workspace-context"

export type BrowserMode = "playwright" | "devtools"

interface BrowserEnvInfo {
  node_path: string
  node_version: string
  node_embedded: boolean
  chrome_path: string | null
  playwright_installed: boolean
  devtools_installed: boolean
  mode: BrowserMode
  mcp_dir: string
}

export interface BrowserMCPState {
  /** Whether Node.js is available (embedded or system) */
  nodeAvailable: boolean
  nodeVersion: string | null
  nodeEmbedded: boolean
  chromeAvailable: boolean
  /** Whether the current mode's MCP is installed */
  installed: boolean
  installing: boolean
  error: string | null
  /** Install + register the current mode's MCP */
  setup: () => Promise<void>
  checking: boolean
  /** Current browser mode */
  mode: BrowserMode
  /** Switch browser mode (unregisters old, registers new) */
  switchMode: (mode: BrowserMode) => Promise<void>
  switchingMode: boolean
}

const BROWSER_MCP_NAME = "browser"

export function useBrowserMCP(): BrowserMCPState {
  const api = useApi()
  const { t } = useI18n()
  const { workspacePath, lastPath } = useWorkspace()
  const effectivePath = workspacePath ?? lastPath
  const [env, setEnv] = useState<BrowserEnvInfo | null>(null)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [switchingMode, setSwitchingMode] = useState(false)

  // Detect environment on mount
  useEffect(() => {
    let cancelled = false
    async function detect() {
      try {
        const info = await invoke<BrowserEnvInfo>("detect_browser_env")
        if (!cancelled) setEnv(info)
      } catch (err) {
        console.error("Browser MCP detection failed:", err)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  const mode = env?.mode ?? "playwright"

  const isInstalled = mode === "playwright"
    ? env?.playwright_installed ?? false
    : env?.devtools_installed ?? false

  const buildMcpCommand = useCallback((envInfo: BrowserEnvInfo, m: BrowserMode): string[] => {
    const homeDir = envInfo.mcp_dir.replace(/\/\.ultrawork\/mcp$/, "")
    if (m === "playwright") {
      const entry = `${envInfo.mcp_dir}/playwright/node_modules/@playwright/mcp/cli.js`
      const args = [envInfo.node_path, entry]
      // Use system Chrome if available to avoid downloading Chromium
      if (envInfo.chrome_path) {
        args.push("--browser", "chrome")
      }
      return args
    }
    // devtools mode
    const entry = `${envInfo.mcp_dir}/chrome-devtools/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`
    return [
      envInfo.node_path,
      entry,
      "--user-data-dir", `${homeDir}/.ultrawork/chrome-profile`,
    ]
  }, [])

  const registerMcp = useCallback(async (envInfo: BrowserEnvInfo, m: BrowserMode) => {
    const command = buildMcpCommand(envInfo, m)
    const config = { type: "local" as const, command, enabled: true, timeout: 30000 }
    // Persist to opencode.json so OpenCode auto-connects on restart
    if (effectivePath) {
      await invoke("write_mcp_config", {
        workspace: effectivePath,
        name: BROWSER_MCP_NAME,
        config,
      })
    }
    await api.createMCP(BROWSER_MCP_NAME, config)
    // Explicitly connect after registration
    await api.connectMCP(BROWSER_MCP_NAME)
  }, [api, buildMcpCommand, effectivePath])

  // Auto-restore: if MCP is installed but not connected in backend, re-register from config
  useEffect(() => {
    if (!env || !isInstalled || !effectivePath) return
    let cancelled = false
    ;(async () => {
      try {
        const mcpStatus = await api.getMCP()
        if (cancelled) return
        // Already connected — nothing to do
        if (mcpStatus[BROWSER_MCP_NAME]?.status === "connected") return
        // Check if config exists in opencode.json
        const savedConfigs = await invoke<Record<string, unknown>>("read_mcp_config", { workspace: effectivePath })
        if (cancelled) return
        if (savedConfigs[BROWSER_MCP_NAME]) {
          // Config exists but not connected — re-register
          const command = buildMcpCommand(env, mode)
          const config = { type: "local" as const, command, enabled: true, timeout: 30000 }
          await api.createMCP(BROWSER_MCP_NAME, config)
          await api.connectMCP(BROWSER_MCP_NAME)
        }
      } catch (err) {
        console.error("Browser MCP auto-restore failed:", err)
      }
    })()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env, isInstalled, effectivePath])

  const setup = useCallback(async () => {
    if (!env) return
    setError(null)
    setInstalling(true)

    const modeName = mode === "playwright"
      ? t("mcp.browser.modePlaywright")
      : t("mcp.browser.modeDevtools")

    let currentEnv = env
    const toastId = toast.loading(
      currentEnv.node_path
        ? t("mcp.browser.toastInstalling", { mode: modeName })
        : t("mcp.browser.toastDownloadingNode")
    )

    try {
      // Step 1: Download Node.js if not available
      if (!currentEnv.node_path) {
        const nodeInfo = await invoke<{ path: string; version: string }>("download_node")
        currentEnv = { ...currentEnv, node_path: nodeInfo.path, node_version: nodeInfo.version, node_embedded: true }
        setEnv(currentEnv)
        toast.loading(t("mcp.browser.toastInstalling", { mode: modeName }), { id: toastId })
      }

      // Step 2: Install MCP package
      if (mode === "playwright") {
        await invoke<string>("install_playwright_mcp")
        currentEnv = { ...currentEnv, playwright_installed: true }
        setEnv(currentEnv)
      } else {
        await invoke<string>("install_devtools_mcp")
        currentEnv = { ...currentEnv, devtools_installed: true }
        setEnv(currentEnv)
      }

      // Step 3: Register with OpenCode
      toast.loading(t("mcp.browser.toastRegistering"), { id: toastId })
      await registerMcp(currentEnv, mode)

      toast.success(t("mcp.browser.toastSuccess"), { id: toastId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(t("mcp.browser.toastFailed", { error: msg }), { id: toastId })
    } finally {
      setInstalling(false)
    }
  }, [env, mode, registerMcp, t])

  const switchMode = useCallback(async (newMode: BrowserMode) => {
    if (!env || newMode === mode) return
    setSwitchingMode(true)
    setError(null)

    const modeName = newMode === "playwright"
      ? t("mcp.browser.modePlaywright")
      : t("mcp.browser.modeDevtools")

    try {
      // Persist mode preference
      await invoke("set_browser_mode", { mode: newMode })

      // Kill browser child processes (Chrome) before disconnect to prevent "session locked"
      await invoke("kill_browser_mcp_processes")

      // Try to disconnect the old MCP (ignore errors if not registered)
      try {
        await api.disconnectMCP(BROWSER_MCP_NAME)
      } catch {
        // MCP may not have been registered yet, that's fine
      }

      // Update local state
      setEnv(prev => prev ? { ...prev, mode: newMode } : prev)

      // If the new mode's MCP is already installed, re-register it
      const newInstalled = newMode === "playwright"
        ? env.playwright_installed
        : env.devtools_installed
      if (newInstalled) {
        const updatedEnv = { ...env, mode: newMode }
        await registerMcp(updatedEnv, newMode)
      }

      toast.success(t("mcp.browser.toastSwitched", { mode: modeName }))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
      toast.error(msg)
    } finally {
      setSwitchingMode(false)
    }
  }, [env, mode, api, registerMcp, t])

  return {
    nodeAvailable: !!env?.node_path,
    nodeVersion: env?.node_version ?? null,
    nodeEmbedded: env?.node_embedded ?? false,
    chromeAvailable: !!env?.chrome_path,
    installed: isInstalled,
    installing,
    error,
    setup,
    checking,
    mode,
    switchMode,
    switchingMode,
  }
}
