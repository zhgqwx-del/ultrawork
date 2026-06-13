import type { QueueOwner } from "@agent/connector"

/**
 * QueueOwner implementation (interface reserved in connector since stage 2,
 * ADR-030 C2: "implementation lands with the orchestrator"). Per-session
 * promise chain: one agent connection, strictly serialized turns. Because the
 * enqueued unit is a FULL turn (prompt + terminal-state wait, see turn.ts),
 * waitForCompletion's "await the chain tail" semantics hold for both backend
 * prompt styles (opencode fire-and-forget, ACP blocking).
 */
export class SessionQueue implements QueueOwner {
  private tails = new Map<string, Promise<void>>()

  enqueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const tail = this.tails.get(sessionId) ?? Promise.resolve()
    // The chain must survive task failures (next turn still runs), but the
    // returned promise must propagate them to the caller.
    const result = tail.then(task)
    this.tails.set(
      sessionId,
      result.catch(() => {}),
    )
    return result
  }

  waitForCompletion(sessionId: string): Promise<void> {
    return this.tails.get(sessionId) ?? Promise.resolve()
  }
}
