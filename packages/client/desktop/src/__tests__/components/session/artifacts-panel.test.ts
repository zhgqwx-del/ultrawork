import { describe, it, expect } from "vitest"
import { extractArtifacts } from "@/components/session/artifacts-panel"
import type { SendMessageResponse } from "@agent/api-client"

const WS = "/ws/project"

function assistant(parts: any[]): SendMessageResponse {
  return { info: { id: "m", sessionID: "s", role: "assistant", time: { created: 1 } }, parts } as SendMessageResponse
}

describe("extractArtifacts — delegate child artifacts (018)", () => {
  it("surfaces files from a delegate tool's D-2 artifacts JSON", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: {
            status: "completed",
            input: { agentId: "acp:claude", task: "build flappy bird" },
            output: JSON.stringify({
              status: "completed",
              sessionId: "child-1",
              deliverable: "做好了 Flappy Bird 游戏", // 交付物文本里没有路径
              artifacts: [`${WS}/flappy-bird.html`],
            }),
          },
        },
      ]),
    ]
    const arts = extractArtifacts(msgs, WS)
    expect(arts.map((a) => a.path)).toContain("flappy-bird.html")
  })

  it("ignores a delegate output that is not JSON / has no artifacts", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: { status: "completed", input: {}, output: "plain text, no path" },
        },
      ]),
    ]
    expect(extractArtifacts(msgs, WS)).toEqual([])
  })

  it("still catches an absolute path mentioned in delegate deliverable text (regex fallback)", () => {
    const msgs = [
      assistant([
        {
          type: "tool",
          tool: "orchestrator_delegate",
          state: { status: "completed", input: {}, output: JSON.stringify({ deliverable: `文件在 ${WS}/tank-battle.html` }) },
        },
      ]),
    ]
    expect(extractArtifacts(msgs, WS).map((a) => a.path)).toContain("tank-battle.html")
  })
})
