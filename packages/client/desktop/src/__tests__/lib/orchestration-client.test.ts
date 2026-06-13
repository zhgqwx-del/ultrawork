import { describe, it, expect, vi, afterEach } from "vitest"
import {
  computeStepLevels,
  createRun,
  createTeamSession,
  deleteTeamSession,
  listDelegates,
  listRuns,
  listTeamSessions,
  cancelRun,
  getRun,
} from "@/lib/orchestration-client"

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

  it("listDelegates unwraps the payload", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ delegates: [{ id: "dlg_1", status: "running" }] }),
    )
    const delegates = await listDelegates()
    expect(delegates[0].id).toBe("dlg_1")
  })
})

describe("computeStepLevels", () => {
  it("chained pipeline = strictly increasing levels", () => {
    expect(
      computeStepLevels([
        { id: "a", inputs: [] },
        { id: "b", inputs: ["a"] },
        { id: "c", inputs: ["b"] },
      ]),
    ).toEqual([0, 1, 2])
  })

  it("fan-out: workers share a level, aggregator one deeper", () => {
    expect(
      computeStepLevels([
        { id: "plan", inputs: [] },
        { id: "w1", inputs: ["plan"] },
        { id: "w2", inputs: ["plan"] },
        { id: "agg", inputs: ["w1", "w2"] },
      ]),
    ).toEqual([0, 1, 1, 2])
  })

  it("independent roots all sit at level 0", () => {
    expect(
      computeStepLevels([
        { id: "a", inputs: [] },
        { id: "b" },
        { id: "c", inputs: ["a"] },
      ]),
    ).toEqual([0, 0, 1])
  })
})

describe("team sessions client (017)", () => {
  const ENTRY = {
    id: "ses_team_1",
    workspace: "/ws",
    leaderAgentId: "opencode:default",
    members: ["opencode:default", "acp:claude"],
    createdAt: 1,
  }

  it("createTeamSession posts the payload and unwraps session", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ session: ENTRY }, 201))
    const entry = await createTeamSession({
      workspace: "/ws",
      leaderAgentId: "opencode:default",
      members: ["opencode:default", "acp:claude"],
      systemPrompt: "LEADER RULES",
    })
    expect(entry.id).toBe("ses_team_1")
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain("/orchestration/team/sessions")
    expect(JSON.parse(String(init?.body)).systemPrompt).toBe("LEADER RULES")
  })

  it("listTeamSessions passes the workspace filter", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ sessions: [ENTRY] }))
    const sessions = await listTeamSessions("/ws")
    expect(sessions).toHaveLength(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain("?workspace=%2Fws")
  })

  it("deleteTeamSession surfaces server errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ error: "unknown team session" }, 404))
    await expect(deleteTeamSession("nope")).rejects.toThrow("unknown team session")
  })
})
