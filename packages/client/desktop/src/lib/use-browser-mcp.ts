import { useState, useEffect, useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useApi } from "@/lib/use-api"

interface NodeInfo {
  path: string
  version: string
}

export interface BrowserMCPState {
  nodeAvailable: boolean
  nodeVersion: string | null
  chromeAvailable: boolean
  installed: boolean
  installing: boolean
  error: string | null
  setup: () => Promise<void>
  checking: boolean
}

const BROWSER_MCP_NAME = "browser"

export function useBrowserMCP(): BrowserMCPState {
  const api = useApi()
  const [nodeInfo, setNodeInfo] = useState<NodeInfo | null>(null)
  const [chromeAvailable, setChromeAvailable] = useState(false)
  const [installed, setInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [mcpDir, setMcpDir] = useState("")

  // Detect environment on mount
  useEffect(() => {
    let cancelled = false
    async function detect() {
      try {
        const [node, chrome, dir, isInstalled] = await Promise.all([
          invoke<NodeInfo | null>("detect_node"),
          invoke<string | null>("detect_chrome"),
          invoke<string>("get_mcp_install_dir"),
          invoke<boolean>("check_browser_mcp_installed"),
        ])
        if (cancelled) return
        setNodeInfo(node)
        setChromeAvailable(!!chrome)
        setMcpDir(dir)
        setInstalled(isInstalled)
      } catch (err) {
        console.error("Browser MCP detection failed:", err)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    detect()
    return () => { cancelled = true }
  }, [])

  const setup = useCallback(async () => {
    if (!nodeInfo || !mcpDir) return

    setError(null)
    setInstalling(true)

    try {
      // Install chrome-devtools-mcp via Rust command (runs npm install)
      await invoke<string>("install_browser_mcp", { nodePath: nodeInfo.path })
      setInstalled(true)

      // Register MCP server with OpenCode
      const homeDir = mcpDir.replace(/\/\.ultrawork\/mcp$/, "")
      const entryPoint = `${mcpDir}/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js`
      await api.createMCP(BROWSER_MCP_NAME, {
        type: "local",
        command: [
          nodeInfo.path,
          entryPoint,
          "--user-data-dir", `${homeDir}/.ultrawork/chrome-profile`,
        ],
        enabled: true,
        timeout: 30000,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setInstalling(false)
    }
  }, [nodeInfo, mcpDir, api])

  return {
    nodeAvailable: !!nodeInfo,
    nodeVersion: nodeInfo?.version ?? null,
    chromeAvailable,
    installed,
    installing,
    error,
    setup,
    checking,
  }
}
