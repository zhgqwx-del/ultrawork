import { describe, it, expect } from "vitest"
import { SessionQueue } from "../session-queue"
import { deferred } from "./helpers"

describe("SessionQueue (QueueOwner implementation)", () => {
  it("serializes tasks per session in FIFO order", async () => {
    const queue = new SessionQueue()
    const order: string[] = []
    const gate1 = deferred()

    const first = queue.enqueue("s1", async () => {
      order.push("first:start")
      await gate1.promise
      order.push("first:end")
    })
    const second = queue.enqueue("s1", async () => {
      order.push("second")
    })

    await Promise.resolve()
    expect(order).toEqual(["first:start"])
    gate1.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first:start", "first:end", "second"])
  })

  it("keeps sessions independent", async () => {
    const queue = new SessionQueue()
    const order: string[] = []
    const gate = deferred()

    const blocked = queue.enqueue("s1", async () => {
      await gate.promise
      order.push("s1")
    })
    await queue.enqueue("s2", async () => {
      order.push("s2")
    })

    expect(order).toEqual(["s2"])
    gate.resolve()
    await blocked
    expect(order).toEqual(["s2", "s1"])
  })

  it("propagates a task failure to its caller but not to the next task", async () => {
    const queue = new SessionQueue()
    const failing = queue.enqueue("s1", async () => {
      throw new Error("turn failed")
    })
    let ran = false
    const next = queue.enqueue("s1", async () => {
      ran = true
    })

    await expect(failing).rejects.toThrow("turn failed")
    await next
    expect(ran).toBe(true)
  })

  it("waitForCompletion awaits the chain tail and never rejects", async () => {
    const queue = new SessionQueue()
    const gate = deferred()
    void queue.enqueue("s1", () => gate.promise).catch(() => {})

    let completed = false
    const wait = queue.waitForCompletion("s1").then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    gate.reject(new Error("boom"))
    await wait
    expect(completed).toBe(true)
  })

  it("waitForCompletion on an unknown session resolves immediately", async () => {
    const queue = new SessionQueue()
    await expect(queue.waitForCompletion("nope")).resolves.toBeUndefined()
  })
})
