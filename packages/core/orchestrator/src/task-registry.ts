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

/** Background task tracking (ADR-031 D-6). Records are kept after settlement
 * so awaitTask on a finished task still returns its result. */
export class TaskRegistry {
  private tasks = new Map<string, TaskRecord>()

  register(record: TaskRecord): void {
    this.tasks.set(record.handle.taskId, record)
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  require(taskId: string): TaskRecord {
    const record = this.tasks.get(taskId)
    if (!record) throw new Error(`Unknown task "${taskId}"`)
    return record
  }
}
