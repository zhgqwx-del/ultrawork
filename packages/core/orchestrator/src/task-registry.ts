import type { Connector } from "@agent/connector"
import type { TaskHandle } from "./types"

/**
 * Counting semaphore for the maxConcurrent guard (ADR-031 D-5). Excess
 * acquirers QUEUE (FIFO) instead of being rejected — Fan-out later batches
 * N>limit workers and expects them to drain, not fail.
 */
export class Semaphore {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.active++
  }

  release(): void {
    this.active--
    const next = this.waiters.shift()
    if (next) next()
  }

  get activeCount(): number {
    return this.active
  }
}

export interface TaskRecord {
  handle: TaskHandle
  abort: AbortController
  /** Kept for steer(): a follow-up turn reuses the task's connector/session. */
  connector: Connector
  workspace: string
  model?: string
}

/** Cap on retained task records. Settled records past this are evicted oldest
 * first (in-flight tasks are never dropped) so the Map can't grow unbounded —
 * every pipeline step / Fan-out worker / delegate registers one. Mirrors
 * DelegateManager's KEEP_TERMINAL prune. */
const MAX_RECORDS = 100

/** Background task tracking (ADR-031 D-6). Settled records are kept (so
 * awaitTask/steer on a finished task still works) but bounded by MAX_RECORDS. */
export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>()
  private settled = new Set<string>()

  register(record: TaskRecord): void {
    const id = record.handle.taskId
    this.tasks.set(id, record)
    // `done` never rejects; mark settled when it resolves, then prune so old
    // finished records (and their pinned AbortController/Connector refs) free.
    void record.handle.done.then(() => {
      this.settled.add(id)
      this.prune()
    })
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  require(taskId: string): TaskRecord {
    const record = this.tasks.get(taskId)
    if (!record) throw new Error(`Unknown task "${taskId}"`)
    return record
  }

  /** Evict oldest settled records once over the cap; never drop in-flight ones. */
  private prune(): void {
    if (this.tasks.size <= MAX_RECORDS) return
    for (const id of this.tasks.keys()) {
      if (this.tasks.size <= MAX_RECORDS) break
      if (this.settled.has(id)) {
        this.tasks.delete(id)
        this.settled.delete(id)
      }
    }
  }
}
