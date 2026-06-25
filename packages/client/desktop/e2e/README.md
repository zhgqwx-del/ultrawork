# Desktop e2e harnesses

Browser-driven walkthroughs that exercise the **real** desktop app (Vite + system
Chrome via `playwright-core`, with a Tauri `invoke` shim) against real sidecars —
catching integration bugs that vitest can't.

## `switchback-gap.e2e.ts` — switch-back streamed-text gap (ADR/discussions 022, Issue 1)

Verifies that switching away from a streaming opencode turn and back loses **no**
answer text. Uses [`mock-llm.ts`](./mock-llm.ts) (an OpenAI-compatible server that
streams marker tokens `M001 M002 …`) to drive a **real opencode** turn — opencode
has the incremental-persistence lag that causes the bug, so it's the only path
that can reproduce it (the ACP path folds history synchronously and is immune).

Flow: send a prompt → stream starts → SPA-navigate to Home for 3s (markers keep
streaming server-side) → navigate back → assert the answer's marker sequence is
**contiguous** (no gap) right after switch-back and again at completion.

```bash
cd packages/client/desktop
bun run --bun e2e:switchback        # exit 0 = PASS, 1 = FAIL
```

Requirements: system Chrome (used via `channel:"chrome"`, no chromium download);
built sidecar binaries in `src-tauri/binaries` (`bun run --bun scripts/build-opencode.ts`).
Isolated per run: temp `HOME`/`XDG`, temp workspace, random sidecar password;
standard ports 4096/1420 (kill stragglers first if a prior run crashed).

**Negative control** (proves the harness detects the bug — not run by default):
temporarily no-op the global message-cache listener in `src/lib/use-sessions.ts`
(`applyMessageEventToCache`); the harness then reports a gap (`firstGap != null`)
at switch-back, healed only at completion — exactly the original symptom.

## `meta-passthrough.e2e.ts` — opencode forwards sessionID via MCP `_meta` (ADR-035)

Guards the opencode vendor patch that tags delegates with their owner (leader)
session so two Teams in one workspace never cross-show. Real (patched) **opencode**
+ [`mock-llm-toolcall.ts`](./mock-llm-toolcall.ts) (emits one tool_call) +
[`stub-mcp.ts`](./stub-mcp.ts) (echoes the call's `_meta`). Asserts the tool
result's `_meta.ultrawork_session === ` the session id.

```bash
cd packages/client/desktop
bun run --bun e2e:meta              # exit 0 = PASS, 1 = FAIL
```

If an opencode bump silently drops the patch (`session/llm.ts`
`experimental_context` or `mcp/index.ts` `_meta` injection), this flips to FAIL —
that's why it's kept. Same isolation as above (temp `HOME`/`XDG`, port 4096).
