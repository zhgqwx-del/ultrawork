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

## `mcp-status-dynamic.e2e.ts` — `MCP.status()` surfaces dynamically-added MCPs

Guards the vendor patch (`mcp/index.ts` `MCP.status()`) that includes runtime
`s.status` entries not yet in the persisted config, so a server registered via
`POST /mcp` is visible in `GET /mcp`. Pure-HTTP (no browser): real (patched)
**opencode** with an **empty** mcp config → `POST /mcp` registers `knowledge-base`
at the real knowledge-sidecar → asserts `GET /mcp` now shows it (only the patch
can surface it, since config is empty). Bonus: asserts `status==="connected"`,
re-confirming the knowledge-sidecar `mcp-stdio` stays alive under opencode's
held-open stdin (so no keep-alive hack is needed).

```bash
cd packages/client/desktop
bun run --bun e2e:mcp-status        # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4196 (avoids a running dev app).

## `kb-mcp-autoregister.e2e.ts` — IMA/remote-only KB auto-registers its MCP

Browser walkthrough of the `fix/knowledge-mcp-ima-autoregister` fix. Seeds an
`ima` source directly via `POST /kb/sources` (the add-source-dialog path — no
folder, no MCP registration), boots opencode with an **empty** mcp config, then
drives real Chrome → Settings → Knowledge Base so the real `useKnowledgeBase()`
auto-restore effect runs against real sidecars. Asserts opencode `GET /mcp` shows
`knowledge-base === connected`. The Tauri-invoke shim provides the real
knowledge-sidecar path for `get_sidecar_path`; `write_mcp_config` is a no-op (the
assertion is the runtime registration, not the persisted file).

```bash
cd packages/client/desktop
bun run --bun e2e:kb-autoregister   # exit 0 = PASS, 1 = FAIL
```

Negative control: revert the auto-restore effect in `use-knowledge-base.ts` and
the harness FAILs (knowledge-base never registered) — exactly the original bug.
Same isolation (temp `HOME`/`XDG`, ports 4096/4098/1420).

## `kb-mcp-restart-persist.e2e.ts` — persisted KB MCP survives an app restart

The persistence half of the fix. After `registerKnowledgeMCP` writes the entry to
the global `opencode.json` (what the Rust `write_mcp_config` command does), a FRESH
OpenCode process must auto-connect the knowledge-base MCP on boot from that config
— so the one-time auto-restore registration keeps working across restarts with no
UI involvement. Pure-HTTP: boot opencode (empty config) → mirror `write_mcp_config`
into `root.mcp` → kill opencode → restart on the same config → assert `GET /mcp`
shows `knowledge-base === connected` with no `POST /mcp`.

```bash
cd packages/client/desktop
bun run --bun e2e:kb-restart        # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4296.

## `builtin-skill-shadowing.e2e.ts` — builtin-vs-user same-name shadowing (ADR-040 阶段 2)

The opencode half of the deterministic-shadowing proof (the Rust half —
`reconcile_builtin_shadowing` prune/restore — is covered by cargo tests).
Against a real opencode: (A) both same-name copies on disk collapse to ONE
arbitrary winner (the race reconcile exists to prevent — logged, not asserted);
(B) after the prune state (builtin copy removed) + `POST /global/refresh` the
USER version is served immediately; (C) after the restore state (user removed,
builtin recopied) the builtin returns — all live, no restart (ADR-039).

```bash
cd packages/client/desktop
bun run --bun e2e:builtin-shadowing   # exit 0 = PASS, 1 = FAIL
```

Isolated: temp `HOME`/`XDG`, non-standard port 4302.

## `builtin-shadow-ui.e2e.ts` — shadow-state Settings UI + restore flow

Real React app (Chrome + Vite + real opencode). The two Tauri commands are
shimmed onto a local helper HTTP server (port 4977) that performs REAL fs
mutations mirroring the Rust reconcile, so the restore flow exercises a real
opencode rescan: shadow card (overridden badge + raw-upstream copy + restore
button) → custom tab shows the user copy → catalog Installed→Install round-trip
→ confirm dialog → fs truth asserted → builtin card back → install prompt
mandates `--method git`.

```bash
cd packages/client/desktop
bun run --bun e2e:builtin-shadow-ui   # exit 0 = PASS, 1 = FAIL
```

Standard ports 4096/1420 (kill a running dev instance first, like
builtin-ppt-ui).
