import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { OrchestrationRun, RunStoreLike } from "./types"

// Run persistence mirrors the ACP sidecar's session-store: one JSON file per
// run under xdgData. Persist-then-emit — every emitted event reflects a state
// already on disk. Resolved lazily so tests can point at a tmp dir after
// module load.
function defaultDataDir(): string {
  if (process.env.ORCHESTRATOR_DATA_DIR) return process.env.ORCHESTRATOR_DATA_DIR
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(xdgData, "ultrawork", "orchestrator-runs")
}

export class RunStore implements RunStoreLike {
  constructor(private readonly dir?: string) {}

  private dataDir(): string {
    return this.dir ?? defaultDataDir()
  }

  private runPath(runId: string): string {
    return join(this.dataDir(), `${encodeURIComponent(runId)}.json`)
  }

  load(): OrchestrationRun[] {
    const dir = this.dataDir()
    if (!existsSync(dir)) return []
    const runs: OrchestrationRun[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue
      try {
        const parsed = JSON.parse(readFileSync(join(dir, name), "utf-8")) as OrchestrationRun
        if (parsed.version === 1 && parsed.id && parsed.recipe && Array.isArray(parsed.steps)) {
          runs.push(parsed)
        }
      } catch (err) {
        console.error(`[orchestrator] skipping unreadable run file ${name}:`, err)
      }
    }
    return runs
  }

  save(run: OrchestrationRun): void {
    mkdirSync(this.dataDir(), { recursive: true })
    writeFileSync(this.runPath(run.id), JSON.stringify(run) + "\n")
  }

  delete(runId: string): void {
    rmSync(this.runPath(runId), { force: true })
  }
}
