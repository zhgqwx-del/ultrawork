import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { RecipeStep } from "./types"

// Artifact handoff contract (ADR-031 D-2/D-4): a step's deliverable is a FILE
// at an agreed path inside the workspace — the next step receives the path,
// never the conversation history. Living inside the workspace means the child
// agent's cwd-sandboxed file tools can write it without extra grants.

export function runArtifactDir(workspace: string, runId: string): string {
  return join(workspace, ".ultrawork", "runs", runId)
}

export function artifactNameOf(step: RecipeStep): string {
  return step.artifactName ?? `${step.id}.md`
}

export function artifactPathFor(workspace: string, runId: string, step: RecipeStep): string {
  return join(runArtifactDir(workspace, runId), artifactNameOf(step))
}

export function ensureArtifactDir(workspace: string, runId: string): void {
  mkdirSync(runArtifactDir(workspace, runId), { recursive: true })
}

export function artifactExists(path: string): boolean {
  return existsSync(path)
}

export interface ArtifactInput {
  stepId: string
  path: string
}

/**
 * Compose the full child-turn prompt: the user-authored task plus the
 * deliverable contract. Kept deliberately plain — agents of every vendor must
 * parse it (it is the cross-vendor interface of the pipeline).
 */
export function buildStepPrompt(step: RecipeStep, artifactPath: string, inputs: ArtifactInput[]): string {
  const sections = [step.taskPrompt.trim()]
  if (inputs.length > 0) {
    sections.push(
      ["## 输入产物", ...inputs.map((i) => `- ${i.stepId}: ${i.path}`), "", "请先读取上述输入产物文件作为本任务的输入。"].join(
        "\n",
      ),
    )
  }
  sections.push(
    [
      "## 交付物要求",
      `任务完成后，必须把最终交付物完整写入这个文件（覆盖写）：${artifactPath}`,
      "交付物文件是本任务唯一的输出契约——没有写出该文件即视为任务失败。",
    ].join("\n"),
  )
  return sections.join("\n\n")
}
