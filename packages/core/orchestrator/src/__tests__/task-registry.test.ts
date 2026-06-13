import { describe, it, expect } from "vitest"
import { Semaphore } from "../task-registry"

describe("Semaphore (maxConcurrent guard)", () => {
  it("queues excess acquirers instead of rejecting (Fan-out-ready)", async () => {
    const semaphore = new Semaphore(2)
    await semaphore.acquire()
    await semaphore.acquire()
    expect(semaphore.activeCount).toBe(2)

    let third = false
    const pending = semaphore.acquire().then(() => {
      third = true
    })
    await Promise.resolve()
    expect(third).toBe(false)

    semaphore.release()
    await pending
    expect(third).toBe(true)
    expect(semaphore.activeCount).toBe(2)
  })

  it("wakes waiters in FIFO order", async () => {
    const semaphore = new Semaphore(1)
    await semaphore.acquire()
    const order: number[] = []
    const a = semaphore.acquire().then(() => order.push(1))
    const b = semaphore.acquire().then(() => order.push(2))

    semaphore.release()
    await a
    semaphore.release()
    await b
    expect(order).toEqual([1, 2])
  })
})
