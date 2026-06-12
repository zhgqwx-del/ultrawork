import { describe, it, expect, vi, afterEach } from "vitest"
import { createRun, listRuns, cancelRun, getRun } from "@/lib/orchestration-client"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

const RUN = { version: 1, id: "run_1", status: "running" }

afterEach(() => {
  vi.restoreAllMocks()
})

describe("orchestration-client", () => {
  it("createRun posts the recipe and unwraps run", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ run: RUN }, 201))
    const recipe = { name: "n", workspace: "/ws", steps: [] }
    const run = await createRun(recipe as never)
    expect(run.id).toBe("run_1")
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("/orchestration/runs")
    expect(JSON.parse(String(init?.body))).toEqual({ recipe })
  })

  it("surfaces server error messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "recipe.workspace does not exist" }, 400))
    await expect(createRun({ name: "n", workspace: "/x", steps: [] } as never)).rejects.toThrow(
      "recipe.workspace does not exist",
    )
  })

  it("listRuns / getRun unwrap payloads", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ runs: [RUN] }))
      .mockResolvedValueOnce(jsonResponse({ run: RUN }))
    expect(await listRuns()).toHaveLength(1)
    expect((await getRun("run_1")).id).toBe("run_1")
  })

  it("cancelRun maps 409 to an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "Run is already terminal" }, 409))
    await expect(cancelRun("run_1")).rejects.toThrow("already terminal")
  })
})
