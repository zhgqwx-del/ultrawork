// DelegateDock per-session scoping (discussions/022 Issue 2 root fix): the dock
// shows only delegates whose ownerSessionId matches THIS session, so two teams in
// one workspace never cross-show. Delegates without an ownerSessionId fall back to
// workspace scope.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, act } from "@testing-library/react"
import type { DelegateRecord } from "@/lib/orchestration-client"

vi.mock("@/lib/i18n-context", () => ({ useI18n: () => ({ t: (k: string) => k }) }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({}) }))
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

let captured: ((e: unknown) => void) | null = null
vi.mock("@/lib/orchestration-client", () => ({
  subscribeDelegateEvents: (h: (e: unknown) => void) => { captured = h; return () => {} },
  replyAcpPermission: vi.fn(),
}))

import { DelegateDock } from "@/components/chat/delegate-dock"

function rec(id: string, owner: string | undefined, task: string, workspace = "/ws"): DelegateRecord {
  return { id, agentId: "acp:claude", task, workspace, status: "running", ownerSessionId: owner, startedAt: 1 }
}
const snapshot = (delegates: DelegateRecord[]) => ({ type: "delegate.snapshot", properties: { delegates } })

beforeEach(() => { captured = null })

describe("DelegateDock — owner-session scoping (discussions/022)", () => {
  it("shows only delegates owned by THIS session; hides another team's in the same workspace", () => {
    const { container } = render(<DelegateDock workspacePath="/ws" sessionId="ses_A" />)
    act(() => captured!(snapshot([rec("d1", "ses_A", "MINE"), rec("d2", "ses_B", "THEIRS")])))
    const text = container.textContent ?? ""
    expect(text).toContain("MINE")
    expect(text).not.toContain("THEIRS") // team B's delegate must NOT cross-show
  })

  it("falls back to workspace scope for delegates without an ownerSessionId", () => {
    const { container } = render(<DelegateDock workspacePath="/ws" sessionId="ses_A" />)
    act(() => captured!(snapshot([rec("d3", undefined, "LEGACY", "/ws"), rec("d4", undefined, "OTHERWS", "/other")])))
    const text = container.textContent ?? ""
    expect(text).toContain("LEGACY")
    expect(text).not.toContain("OTHERWS")
  })
})
