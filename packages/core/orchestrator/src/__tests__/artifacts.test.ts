import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { artifactNameOf, artifactPathFor, buildStepPrompt, runArtifactDir } from "../artifacts"
import type { RecipeStep } from "../types"

const step: RecipeStep = { id: "analyze", agentId: "opencode:default", taskPrompt: "分析代码质量" }

describe("artifacts", () => {
  it("derives the artifact path from workspace/run/step", () => {
    expect(runArtifactDir("/ws", "run_1")).toBe(join("/ws", ".ultrawork", "runs", "run_1"))
    expect(artifactNameOf(step)).toBe("analyze.md")
    expect(artifactNameOf({ ...step, artifactName: "out.json" })).toBe("out.json")
    expect(artifactPathFor("/ws", "run_1", step)).toBe(join("/ws", ".ultrawork", "runs", "run_1", "analyze.md"))
  })

  it("builds a prompt with task + inputs + deliverable contract", () => {
    const prompt = buildStepPrompt(step, "/ws/.ultrawork/runs/run_1/analyze.md", [
      { stepId: "plan", path: "/ws/.ultrawork/runs/run_1/plan.md" },
    ])
    expect(prompt).toContain("分析代码质量")
    expect(prompt).toContain("## 输入产物")
    expect(prompt).toContain("- plan: /ws/.ultrawork/runs/run_1/plan.md")
    expect(prompt).toContain("## 交付物要求")
    expect(prompt).toContain("（覆盖写）：/ws/.ultrawork/runs/run_1/analyze.md")
  })

  it("omits the inputs section for the first step", () => {
    const prompt = buildStepPrompt(step, "/x/analyze.md", [])
    expect(prompt).not.toContain("## 输入产物")
    expect(prompt).toContain("## 交付物要求")
  })
})
