// Orchestrator composition root (ADR-031): the ACP sidecar hosts the
// orchestrator + its own Connector — orchestration survives WebView reloads
// and the future delegate MCP shim can reach it over HTTP.

import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Connector, OpenCodeBackend, UNLIMITED_SSE_RETRY } from "@agent/connector"
import { DelegateManager, Orchestrator, RunStore } from "@agent/orchestrator"
import type { ACPManager } from "./acp-manager.js"
import { InProcACPBackend } from "./inproc-acp-backend.js"
import { getOpencodePassword } from "./opencode-credentials.js"

const OPENCODE_BASE_URL = process.env.OPENCODE_BASE_URL ?? "http://localhost:4096"

/**
 * Hidden opencode parent sessions live under a non-workspace directory so the
 * sidebar (which lists root sessions per workspace directory) never shows
 * them; their children are additionally excluded by parentID + roots:true.
 */
function hiddenParentDir(): string {
  if (process.env.ORCHESTRATOR_HIDDEN_DIR) return process.env.ORCHESTRATOR_HIDDEN_DIR
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdgData, "ultrawork", "orchestrator-hidden")
}

export interface OrchestrationHost {
  orchestrator: Orchestrator
  delegates: DelegateManager
}

export function createOrchestrator(manager: ACPManager): OrchestrationHost {
  // One ACP backend for every workspace (cwd is per session); one
  // OpenCodeBackend per workspace (its REST + /event stream are
  // directory-scoped — same per-workspace map as the gateway bridge).
  const acpBackend = new InProcACPBackend(manager)
  const connectors = new Map<string, Connector>()
  const connectorFor = (workspace: string): Connector => {
    let connector = connectors.get(workspace)
    if (!connector) {
      connector = new Connector()
      const opencode = new OpenCodeBackend({
        baseUrl: OPENCODE_BASE_URL,
        username: "opencode",
        password: getOpencodePassword(),
        workingDirectory: workspace,
        sse: { retry: UNLIMITED_SSE_RETRY },
      })
      connector.registerBackend(opencode)
      connector.registerBackend(acpBackend)
      // Subscriptions are passive — start the global /event stream now or
      // runTurn would wait on events that never flow. ready() never rejects.
      void opencode.ready()
      connectors.set(workspace, connector)
    }
    return connector
  }

  // Worktree dirs get their own per-workspace connector (opencode SSE is
  // directory-scoped); release them after the step or every fan-out run
  // would leak an SSE stream per worker.
  const releaseConnector = (workspace: string): void => {
    const connector = connectors.get(workspace)
    if (!connector) return
    connectors.delete(workspace)
    connector.dispose()
  }

  const hidden = hiddenParentDir()
  mkdirSync(hidden, { recursive: true })

  const orchestrator = new Orchestrator({
    connectorFor,
    releaseConnector,
    store: new RunStore(),
    hiddenParentWorkspace: hidden,
  })
  const delegates = new DelegateManager({
    orchestrator,
    connectorFor,
    hiddenParentWorkspace: hidden,
  })
  return { orchestrator, delegates }
}
